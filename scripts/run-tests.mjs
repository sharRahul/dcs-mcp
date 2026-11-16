#!/usr/bin/env node
/**
 * Run the test suite on every platform. `node --test tests/*.test.ts` relies on
 * the shell to expand the glob, which Windows shells do not, and node's own
 * glob support only arrived in Node 22.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not import.meta.dirname: the latter is Node 20.11+.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tests");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => path.join("tests", f));
const result = spawnSync(process.execPath, ["--test", "--import", "tsx", ...process.argv.slice(2), ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
