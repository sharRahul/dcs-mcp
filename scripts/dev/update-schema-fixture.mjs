#!/usr/bin/env node
/**
 * Regenerate tests/fixtures/mcp-schema-sha256.json after a DELIBERATE public schema
 * change. Hashes are computed exactly as tests/acceptance.test.ts checks them, through a
 * real stdio client. Review the printed diff before committing.
 *   node scripts/dev/update-schema-fixture.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fixture = new URL("../../tests/fixtures/mcp-schema-sha256.json", import.meta.url);
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
  return v;
}
const client = new Client({ name: "schema-fixture", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"],
  env: { ...process.env, DCS_MCP_STATE_DIR: "off" }, stderr: "ignore" }));
try {
  const tools = (await client.listTools()).tools;
  const next = Object.fromEntries(tools.map((t) => [t.name, createHash("sha256")
    .update(JSON.stringify(sorted({ input: t.inputSchema, output: t.outputSchema ?? null }))).digest("hex")]));
  const prev = JSON.parse(readFileSync(fixture, "utf8"));
  // Keep the existing order (registration order) so the diff shows only real changes.
  const ordered = Object.fromEntries([...Object.keys(prev).filter((k) => k in next), ...Object.keys(next).filter((k) => !(k in prev))].map((k) => [k, next[k]]));
  for (const k of Object.keys(next)) if (!(k in prev)) console.log(`+ ${k}`); else if (prev[k] !== next[k]) console.log(`~ ${k}`);
  for (const k of Object.keys(prev)) if (!(k in next)) console.log(`- ${k}`);
  writeFileSync(fixture, JSON.stringify(ordered, null, 2) + "\n");
  console.log(`${tools.length} tools written`);
} finally { await client.close(); }
