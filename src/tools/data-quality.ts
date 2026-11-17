/** Fuel limits, dataset provenance and warehouse donors. Offline only. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fuelInfo, fuelReport, listFuel } from '../miz/fuel.js';
import { provenanceReport } from '../data/provenance.js';
import { coverageReport, installInfo } from '../dcs/install-info.js';
import { installAirfieldData } from '../dcs/terrain-files.js';
import { addStockFromDonor, importDonor, listDonors, loadDonor } from '../miz/warehouse-donor.js';
import { errorResult } from './format.js';
import { inspect, mutate, read, result, sessionId } from './miz-extended.js';

export function registerDataQualityTools(server: McpServer) {
  server.registerTool('dcs_aircraft_fuel', {
    description: "Internal fuel maximum (kg) of an aircraft type, or every type, from pydcs's fuel_max (exported from DCS). dcs_miz_set_payload accepts fuelPercent of this maximum, as the editor's INTERNAL FUEL slider does. Default starting fuel per airframe is not in the bundled data.",
    inputSchema: z.object({ type: z.string().min(1).optional() }).strict(), annotations: read,
  }, async a => { try { return result(a.type ? fuelInfo(a.type) : { types: listFuel() }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_fuel_report', {
    description: 'Every aircraft unit in the session: internal fuel in kg and as % of its type maximum, flagging non-numeric, negative or over-maximum values.',
    inputSchema: z.object({ sessionId }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => { const units = fuelReport(s.mission); return { count: units.length, issues: units.filter(u => u.issue).length, units }; }));
  server.registerTool('dcs_data_provenance', {
    description: 'Where every bundled dataset comes from: generator script, upstream source and licence, how its inputs are pinned (sha256 / wiki revision ids), the file sha256, the regeneration command and what it has and has not been verified against.',
    inputSchema: z.object({}).strict(), annotations: read,
  }, async () => { try { return result(provenanceReport()); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_install_report', {
    description: "The DCS install on this machine, read from its own files (never executed): root folder and how it was found (DCS_INSTALL_DIR, the path DCS logged at startup, or a default location), build string and install date from autoupdate.cfg, the module list, the installed terrains, and where the install disagrees with this server's bundled catalogue — terrains with no bundled airfield/projection data (e.g. Iraq, Marianas WWII) and unit type ids the install declares that the catalogue has no entry for. The bundled data is pinned to pydcs, which states no DCS build, so this reports coverage drift, not a version comparison.",
    inputSchema: z.object({}).strict(), annotations: read,
  }, async () => {
    try {
      const info = installInfo(process.env, true);
      return result({ install: info, coverage: coverageReport() });
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_theatre_data', {
    description: "Airfield ATC radios and navigation beacons for ONE installed terrain, read from ED's own Mods/terrains/<theatre>/radio.lua and beacons.lua as text (never executed): per airfield the HF/VHF-low/VHF-high/UHF frequencies in MHz with modulation and callsign, and every beacon (TACAN channel, ILS/VOR/NDB MHz, position in DCS x/y metres plus lat/lon, bearing as ED states it). This is first-party data current to the installed build and the only source for a terrain pydcs never had (Iraq, Marianas WWII); each file's sha256 is reported. Airfields are keyed by ED's airfield<N> index, which is NOT the mission-file airdromeId — for a terrain with no bundled data, ids, coordinates and parking still need a live airbase sample.",
    inputSchema: z.object({ theatre: z.string().min(1) }).strict(), annotations: read,
  }, async a => { try { return result(installAirfieldData(a.theatre)); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_import_warehouse_donor', {
    description: "Harvest wsType-bearing aircraft and weapon stock entries from a mission YOU supply (ideally saved by the Mission Editor) into a named donor, stored with the file's sha256. The file is only read. Donors let dcs_miz_add_warehouse_stock add NEW stock by copying real entries; nothing is fabricated.",
    inputSchema: z.object({ file: z.string().min(1), id: z.string().min(1).max(48), overwrite: z.boolean().default(false) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async a => { try { return result(importDonor(a.file, a.id, undefined, a.overwrite)); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_list_warehouse_donors', {
    description: 'Imported warehouse donors: source file and sha256, and the aircraft types and weapon wsTypes each can supply.',
    inputSchema: z.object({}).strict(), annotations: read,
  }, async () => { const donors = listDonors(); return result({ count: donors.length, donors }); });
  server.registerTool('dcs_miz_add_warehouse_stock', {
    description: 'Add NEW aircraft or weapon stock to an airfield/unit warehouse by copying entries from an imported donor (wsType and every other field kept, quantity set, unlimited flag cleared). Types or wsTypes the donor lacks are refused; already-stocked items are refused (edit their quantity with dcs_miz_edit_warehouse). DCS runtime behaviour is unverified.',
    inputSchema: z.object({ sessionId, kind: z.enum(['airports', 'warehouses']), id: z.number().int().positive(), donor: z.string().min(1),
      aircraft: z.array(z.object({ category: z.enum(['planes', 'helicopters']), type: z.string().min(1), quantity: z.number().int().nonnegative() }).strict()).max(200).optional(),
      weapons: z.array(z.object({ wsType: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/), quantity: z.number().int().nonnegative() }).strict()).max(1000).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async a => mutate(a.sessionId, s => {
    const donor = loadDonor(a.donor);
    s.warehouses = addStockFromDonor(s, a.kind, a.id, donor, { aircraft: a.aircraft, weapons: a.weapons });
    return { kind: a.kind, id: a.id, donor: a.donor, donorSha256: donor.source.sha256, added: { aircraft: a.aircraft?.length ?? 0, weapons: a.weapons?.length ?? 0 } };
  }));
}
