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
    () => luaparse.parse(source, { luaVersion: "5.3", comments: false, scope: false }),
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

    assert.equal(replies.length, 5, `expected 5 replies, got:\n${output}`);
    assert.match(replies[0], /^\{"ok":true,"data":\{"pong":true/, "ping did not answer");
    assert.match(replies[1], /^\{"ok":true,/, "mission query did not answer");
    assert.match(replies[2], /"ok":false.*Unknown command/, "unknown command not rejected");
    // Raw Lua execution stays gated even when it is asked for directly.
    assert.match(replies[3], /"ok":false.*Raw exec is disabled/, "exec was not gated");
    // `status` must report what the bridge can currently do, so a client can
    // tell "no mission running" apart from "the bridge is down".
    assert.match(replies[4], /"listening":true/, "status did not report the listener");
    assert.match(replies[4], /"phase":"/, "status did not report the DCS phase");
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
    // Fill in the string.format placeholders with representative literals.
    const filled = body
      .replace(/%q/g, '"sample"')
      .replace(/%d/g, "1")
      .replace(/%f/g, "1.0")
      .replace(/%s/g, "sample");
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
