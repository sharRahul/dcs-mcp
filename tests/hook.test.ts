import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import luaparse from "luaparse";

/**
 * The hook and Export scripts only ever run inside DCS, and the snippets the
 * hook ships into the mission/export states are built as strings, so a syntax
 * error in them is invisible until someone flies. Parse them here instead.
 */
const HOOK = "scripts/Hooks/dcs-mcp-hook.lua";
const EXPORT = "scripts/Export.lua";

function parseLua(source: string, label: string): void {
  assert.doesNotThrow(
    () => luaparse.parse(source, { luaVersion: "5.1", comments: false, scope: false }),
    `Lua syntax error in ${label}`
  );
}

for (const file of [HOOK, EXPORT]) {
  test(`${file} is syntactically valid Lua`, () => {
    parseLua(readFileSync(file, "utf8"), file);
  });
}

/**
 * Parsing is not enough. DCS runs Lua 5.1, and 5.2+ constructs that parse fine
 * blow up only when the hook actually runs — at which point DCS logs one line to
 * dcs.log and the bridge silently never listens. So load the hook for real under
 * DCS's own interpreter with the DCS globals stubbed, and drive its callbacks.
 *
 * Skipped unless DCS_LUA points at `<DCS>/bin-mt/luae.exe`.
 */
const DEFAULT_LUA_PATHS = [
  "C:/Program Files/Eagle Dynamics/DCS World/bin-mt/luae.exe",
  "C:/Program Files/Eagle Dynamics/DCS World/bin/luae.exe",
];
const lua = (() => {
  const configured = process.env.DCS_LUA;
  if (configured) return existsSync(configured) ? configured : undefined;
  return DEFAULT_LUA_PATHS.find((p) => existsSync(p));
})();

test(
  "the hook loads and serves requests under the Lua 5.1 that DCS actually runs",
  { skip: lua ? false : "no DCS Lua interpreter found; set DCS_LUA to <DCS>/bin-mt/luae.exe" },
  () => {
    const harness = fileURLToPath(new URL("./fixtures/hook-load.lua", import.meta.url));
    const run = spawnSync(lua!, [harness, HOOK], { encoding: "utf8" });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.equal(run.status, 0, `hook failed under DCS Lua:\n${output}`);

    // It must get past module scope, register callbacks, and bind its listener.
    assert.match(output, /HOOK_LOADED/, output);
    assert.match(output, /LISTENING/, output);

    const replies = output
      .split(/\r?\n/)
      .filter((l) => l.startsWith("REPLY "))
      .map((l) => l.replace(/^REPLY \d+ /, ""));

    // The listener must come up at LOAD time, not on mission start, so the
    // bridge answers in the menu and the Mission Editor.
    assert.match(output, /hook server listening/, "the hook did not bind at load time");
    // The read-only state probe runs once per mission from each tick source.
    for (const source of ["sim", "gui"]) {
      for (const state of ["mission", "server", "export", "config"]) {
        assert.match(output, new RegExp(`state probe source=${source} state=${state} -> `), `${source}/${state} probe missing`);
      }
    }

    assert.equal(replies.length, 14, `expected 14 replies, got:\n${output}`);
    assert.match(replies[0], /^\{"ok":true,"data":\{"pong":true/, "ping did not answer");
    assert.match(replies[1], /^\{"ok":true,/, "mission query did not answer");
    // Mission-env commands go to the state that actually holds `timer`
    // ("server" on DCS 2.9.31), not to a hardcoded "mission".
    assert.match(output, /DOSTRING_STATE server/, "mission query did not reach the scripting state");
    assert.doesNotMatch(output, /DOSTRING_STATE mission/, "a snippet was sent to the trigger state");
    assert.match(output, /mission scripting environment is net\.dostring_in state 'server'/);
    assert.match(replies[2], /"ok":false.*Unknown command/, "unknown command not rejected");
    // Raw Lua execution stays gated even when it is asked for directly.
    assert.match(replies[3], /"ok":false.*Raw exec is disabled/, "exec was not gated");
    // `status` must report what the bridge can currently do, so a client can
    // tell "no mission running" apart from "the bridge is down".
    assert.match(replies[4], /"listening":true/, "status did not report the listener");
    assert.match(replies[4], /"phase":"/, "status did not report the DCS phase");

    // Mission-environment commands must be routed to the simulation thread.
    // Answering them from the GUI updater runs the snippet somewhere that has no
    // `coalition`/`timer`/`land`, so every such command fails on a nil global
    // while the mission is demonstrably running.
    assert.match(output, /GUI_HELD true/, `a mission-env command was answered from the GUI tick:\n${output}`);
    assert.match(output, /SIM_ANSWERED true/, `the held command was not answered on the sim frame:\n${output}`);
    // `net.load_mission` is a no-op unless it runs on the simulation thread, so
    // `loadmission` must be held for a sim frame like the mission-env commands.
    assert.match(output, /GUI_LOADMISSION_HELD true/, `loadmission was answered from the GUI tick:\n${output}`);
    assert.match(output, /SIM_LOADMISSION_ANSWERED true/, `loadmission was not held for the sim frame:\n${output}`);
    // Over a running mission the swap reaches net.load_mission on the sim thread.
    assert.match(output, /LOADMISSION_SWAPPED true/, `loadmission did not call net.load_mission when running:\n${output}`);
    // From the menu net.load_mission silently no-ops, so loadmission must refuse
    // with a clear error and must NOT call net.load_mission.
    assert.match(output, /COLD_MENU_REFUSED true/, `cold-menu loadmission did not refuse clearly:\n${output}`);
    assert.match(output, /COLD_MENU_NO_LOAD true/, `cold-menu loadmission still called net.load_mission:\n${output}`);
    // ...but the bridge must still answer non-mission commands in the menus.
    assert.match(output, /GUI_PING_ANSWERED true/, `ping did not answer from the GUI tick:\n${output}`);

    // The structured mission-environment commands build Lua as strings and ship
    // it into the mission state, so the harness compiles and RUNS each snippet
    // against stubs of the DCS API. A typo or a wrong call there is otherwise
    // invisible until someone flies.
    assert.match(output, /SNIPPET_FAILURES 0/, `a snippet failed to compile or ran into an error:\n${output}`);
    for (const cmd of ["land", "airbases", "roads", "los", "clearspot"]) {
      assert.match(output, new RegExp(`STRUCTURED ${cmd} true`), `${cmd} did not answer ok:\n${output}`);
    }
    // An airbase sample must carry everything an offline airbase pack needs for
    // a theatre the bundled catalogue does not have (ids, position, parking).
    assert.match(output, /AIRBASES_FIELDS true/, `the airbase sample is missing pack fields:\n${output}`);
    assert.match(output, /ROADS_SNAPPED true/, `roads did not snap to the road graph:\n${output}`);
    assert.match(output, /LOS_BLOCKED true/, `line of sight did not report the blocking point:\n${output}`);
    assert.match(output, /CLEARSPOT_FOUND true/, `clearspot found no open ground on flat stub terrain:\n${output}`);
  }
);

/** Long strings in the hook, minus the `--[[ ... ]]` block comments. */
function embeddedSnippets(source: string): string[] {
  const withoutComments = source.replace(/--\[\[[\s\S]*?\]\]/g, "");
  return [...withoutComments.matchAll(/\[\[([\s\S]*?)\]\]/g)]
    .map((m) => m[1])
    .filter((body) => /\S/.test(body));
}

test("every Lua snippet the hook injects into DCS is syntactically valid", () => {
  const snippets = embeddedSnippets(readFileSync(HOOK, "utf8"));
  assert.ok(snippets.length >= 8, `expected the hook's injected snippets, found ${snippets.length}`);

  for (const [i, body] of snippets.entries()) {
    // Fill in the string.format placeholders with representative literals,
    // including width/precision forms such as %.3f and %-10s.
    const filled = body
      .replace(/%[-+ #0-9.]*q/g, '"sample"')
      .replace(/%[-+ #0-9.]*[di]/g, "1")
      .replace(/%[-+ #0-9.]*[fge]/g, "1.0")
      .replace(/%[-+ #0-9.]*s/g, "sample");
    parseLua(filled, `${HOOK} snippet #${i}`);
  }
});

test("the hook never blocks the simulation frame on a socket read", () => {
  const source = readFileSync(HOOK, "utf8");
  // A non-zero settimeout on an accepted client stalls the DCS frame.
  const timeouts = [...source.matchAll(/settimeout\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(timeouts.length > 0, "expected settimeout calls in the hook");
  assert.deepEqual(
    timeouts.filter((t) => t !== "0"),
    [],
    `all sockets must be non-blocking, found settimeout(${timeouts.filter((t) => t !== "0").join(", ")})`
  );
});

test("the hook keeps raw Lua execution disabled by default", () => {
  const source = readFileSync(HOOK, "utf8");
  assert.match(source, /^local ALLOW_EXEC = false/m, "ALLOW_EXEC must ship as false");
});

test("the hook binds only to localhost", () => {
  const source = readFileSync(HOOK, "utf8");
  assert.match(source, /^local HOST = "127\.0\.0\.1"/m, "the hook must not listen on a public interface");
});

test(
  "telemetry logs a missing framework as ERROR only when the mission loads it",
  { skip: lua ? false : "no DCS Lua interpreter found; set DCS_LUA to <DCS>/bin-mt/luae.exe" },
  () => {
    const harness = fileURLToPath(new URL("./fixtures/telemetry-frameworks.lua", import.meta.url));
    const run = (c: string) => {
      const r = spawnSync(lua!, [harness, "scripts/dcs-mcp-telemetry.lua", c], { encoding: "utf8" });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      return r.stdout.replace(/\r\n/g, "\n");
    };
    // The mission's DO SCRIPT FILE loads mist_*.lua, so a missing MIST is a fault;
    // MOOSE and Skynet were never loaded, so their absence must not dirty the log.
    const known = run("mist-missing");
    assert.match(known, /^ERROR \[DCSMCP\] FRAMEWORK name=MIST loaded=0 expected=1$/m);
    assert.match(known, /^INFO \[DCSMCP\] FRAMEWORK name=MOOSE loaded=0 expected=0$/m);
    assert.match(known, /^INFO \[DCSMCP\] FRAMEWORK name=SKYNET loaded=0 expected=0$/m);
    assert.match(known, /READY telemetry=1/);
    // Expectation unreadable (as on DCS 2.9.31) and no framework at all: a
    // framework-free mission, logged at INFO so LOG_CLEAN can pass.
    const unknown = run("unknown");
    for (const name of ["MIST", "MOOSE", "SKYNET"]) assert.match(unknown, new RegExp(`^INFO \\[DCSMCP\\] FRAMEWORK name=${name} loaded=0 expected=unknown$`, "m"));
    assert.doesNotMatch(unknown, /^ERROR/m);
    // Unreadable but partially loaded: the load-order failure stays an ERROR.
    const partial = run("partial");
    assert.match(partial, /^INFO \[DCSMCP\] FRAMEWORK name=MIST loaded=1/m);
    for (const name of ["MOOSE", "SKYNET"]) assert.match(partial, new RegExp(`^ERROR \\[DCSMCP\\] FRAMEWORK name=${name} loaded=0$`, "m"));
  }
);
