import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
