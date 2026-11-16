/**
 * Drive the real server over stdio with the MCP SDK client: tools, resources
 * and prompts are registered, and an authoring run that uses the new surface
 * (lat/lon placement, airfield start, site template, static, removal) saves a
 * .miz that reopens cleanly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Structured = Record<string, any>;

test("server exposes tools, resources and prompts, and authors a mission end to end", { timeout: 60000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    env: { ...process.env, DCS_MCP_STATE_DIR: "off" } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions() ?? "", /x = NORTH/);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "dcs_miz_remove_group", "dcs_miz_move_group", "dcs_miz_add_static", "dcs_miz_set_mission_options",
      "dcs_list_unit_types", "dcs_list_airfields", "dcs_geo_convert", "dcs_install_hook", "dcs_miz_restore_session",
      "dcs_miz_add_farp", "dcs_miz_populate_airfield", "dcs_miz_add_target_area", "dcs_miz_add_naval_group",
      "dcs_list_scene_templates", "dcs_country_inventory", "dcs_list_installed_mods",
    ]) {
      assert.ok(tools.includes(name), `missing tool ${name}`);
    }
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    assert.ok(resources.includes("dcs://guide/conventions"));
    assert.ok(resources.includes("dcs://reference/unit-types/vehicle"));
    const guide = await client.readResource({ uri: "dcs://guide/conventions" });
    assert.match(String((guide.contents[0] as { text: string }).text), /x is NORTH/);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    assert.deepEqual(prompts.sort(), ["build_mission", "diagnose_mission", "fly_mission"]);

    const call = async (name: string, args: Record<string, unknown>): Promise<Structured> => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, `${name} failed: ${JSON.stringify(r.content)}`);
      return r.structuredContent as Structured;
    };

    const { sessionId } = await call("dcs_miz_new", { theatre: "Caucasus" });
    await call("dcs_miz_add_ground_group", {
      sessionId, side: "red", country: "Russia", name: "SAM-Kilo", site: "SA-6", lat: 42.2, lon: 42.6, heading: 270,
    });
    await call("dcs_miz_add_aircraft_group", {
      sessionId, side: "blue", country: "USA", name: "Viper", type: "F-16C_50", count: 2, skill: "Client",
      start: { kind: "parking_cold", airfield: "Kutaisi" },
    });
    await call("dcs_miz_add_static", {
      sessionId, side: "blue", country: "USA", name: "HQ", type: ".Command Center", lat: 42.17, lon: 42.48,
    });
    await call("dcs_miz_populate_airfield", {
      sessionId, side: "blue", country: "USA", airfield: "Kutaisi", types: ["F-16C_50"], count: 3, namePrefix: "Ramp",
    });
    await call("dcs_miz_add_target_area", {
      sessionId, side: "red", country: "Russia", name: "Depot", template: "fuel-depot", lat: 42.3, lon: 42.9, zone: true,
    });
    await call("dcs_miz_add_ground_group", {
      sessionId, side: "blue", country: "USA", name: "Spare", type: "M-1 Abrams", x: -280000, y: 680000,
    });
    await call("dcs_miz_remove_group", { sessionId, name: "Spare" });
    await call("dcs_miz_set_mission_options", {
      sessionId, date: { year: 2025, month: 6, day: 1 }, forcedOptions: { externalViews: false },
    });
    const bad = await client.callTool({ name: "dcs_miz_add_ground_group", arguments: {
      sessionId, side: "blue", country: "Narnia", name: "X", type: "M-1 Abrams", x: 0, y: 0,
    } });
    assert.ok(bad.isError);

    const out = join(mkdtempSync(join(tmpdir(), "dcs-srv-")), "out.miz");
    const saved = await call("dcs_miz_save_as", { sessionId, outPath: out });
    assert.equal(saved.saved, true, JSON.stringify(saved.validation));
    const reopened = await call("dcs_miz_open", { path: out });
    const groups = await call("dcs_miz_list_groups", { sessionId: reopened.sessionId, response_format: "json" });
    const names = (groups.groups as { name: string }[]).map((g) => g.name).sort();
    assert.ok(names.includes("HQ") && names.includes("SAM-Kilo") && names.includes("Viper") && names.includes("Ramp-3"));
    assert.ok(names.includes("Depot-1") && !names.includes("Spare"));

    const conv = await call("dcs_geo_convert", { theatre: "caucasus", lat: 41.6103, lon: 41.5997 });
    assert.ok(Math.abs(conv.x - -355737.036) < 0.01);
  } finally {
    await client.close();
  }
});
