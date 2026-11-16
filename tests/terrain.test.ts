import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { gridProvider, liveProvider, type ElevationGrid } from '../src/terrain/providers.js';
import { distanceBearing, lineOfSight, profile, routeFeasibility, slope, suitability, TerrainUnavailable, viewshed, type TerrainProvider } from '../src/terrain/analysis.js';
const options = { stepMetres: 10, observerHeightMetres: 10, targetHeightMetres: 10, earthRadiusFactor: 1 };
function grid(fn = (x: number, y: number) => 0): ElevationGrid {
  return { theatre: 'Caucasus', source: 'SYNTHETIC TEST DATA; not real DCS terrain', origin: { x: -100, y: -100 }, spacingMetres: 10, rows: 21, columns: 21,
    heights: Array.from({ length: 441 }, (_, i) => fn(-100 + Math.floor(i / 21) * 10, -100 + (i % 21) * 10)), surfaces: Array(441).fill(1) };
}
const center = { x: 0, y: 0 };
test('distance and bearing use DCS north/east axes and handle coincident points', () => {
  assert.equal(distanceBearing(center, { x: 100, y: 0 }).bearingDegrees, 0);
  assert.equal(distanceBearing(center, { x: 0, y: 100 }).bearingDegrees, 90);
  assert.equal(distanceBearing(center, { x: -100, y: 0 }).bearingDegrees, 180);
  assert.equal(distanceBearing(center, { x: 0, y: -100 }).bearingDegrees, 270);
  assert.equal(distanceBearing(center, { x: 3, y: 4 }).distanceMetres, 5);
  assert.equal(distanceBearing(center, center).bearingDegrees, null);
  assert.throws(() => distanceBearing(center, { x: NaN, y: 0 }), /finite/);
});
test('offline grid bilinear elevations, nearest surfaces, boundaries and no-data semantics', async () => {
  const data = grid((x, y) => 100 + x + 2 * y);
  const provider = gridProvider(data, 'Caucasus');
  assert.ok(Math.abs((await provider.sample([{ x: 2, y: 3 }]))[0].height! - 108) < 1e-10);
  assert.equal((await provider.sample([{ x: 100, y: 100 }]))[0].height, 400);
  assert.equal((await provider.sample([{ x: 101, y: 0 }]))[0].height, null);
  data.heights[0] = null;
  assert.equal((await provider.sample([{ x: -95, y: -95 }]))[0].height, null);
  // A null neighbour with zero weight does not invalidate an exact known grid node.
  assert.equal((await provider.sample([{ x: -90, y: -90 }]))[0].height, -170);
  assert.throws(() => gridProvider(data, 'Syria'), TerrainUnavailable);
  assert.throws(() => gridProvider({ ...data, heights: [] }, 'Caucasus'), /dimensions/);
  assert.throws(() => gridProvider({ ...data, source: '' }, 'Caucasus'), /source/);
});
test('slope is independently checked against an analytical plane', async () => {
  const p = gridProvider(grid((x, y) => 500 + .2 * x + .1 * y), 'Caucasus');
  const result = await slope(p, center, 10);
  assert.ok(Math.abs(result.slopeDegrees - Math.atan(Math.hypot(.2, .1)) * 180 / Math.PI) < 1e-10);
  assert.ok(Math.abs(result.northGradient - .2) < 1e-10);
  assert.ok(Math.abs(result.eastGradient - .1) < 1e-10);
});
test('suitability rejects water/steep footprints and reports unknown surface', async () => {
  const data = grid();
  assert.equal((await suitability(gridProvider(data, 'Caucasus'), center, 20, 10, 10)).suitable, true);
  data.surfaces![10 * 21 + 10] = 3;
  assert.equal((await suitability(gridProvider(data, 'Caucasus'), center, 20, 10, 10)).suitable, false);
  assert.equal((await suitability(gridProvider({ ...grid(), surfaces: undefined }, 'Caucasus'), center, 20, 10, 10)).suitable, null);
  assert.equal((await suitability(gridProvider(grid(x => x), 'Caucasus'), center, 20, 10, 10)).suitable, false);
});
test('ridge masks LOS; altitude clears it, range alone never claims radar detection', async () => {
  const p = gridProvider(grid(x => x === 0 ? 100 : 0), 'Caucasus');
  const a = { x: -80, y: 0 }, b = { x: 80, y: 0 };
  const blocked = await lineOfSight(p, a, b, options);
  assert.equal(blocked.terrainMasked, true); assert.equal(blocked.visible, false); assert.equal(blocked.obstruction!.x, 0);
  const clear = await lineOfSight(p, a, b, { ...options, observerHeightMetres: 150, targetHeightMetres: 150 });
  assert.equal(clear.visible, true);
  const outOfRange = await lineOfSight(p, a, b, { ...options, observerHeightMetres: 150, targetHeightMetres: 150, maxRangeMetres: 100 });
  assert.equal(outOfRange.visible, false); assert.equal(outOfRange.withinRange, false);
  assert.match(outOfRange.limitation, /not radar detection/);
});
test('Earth curvature blocks a long bare-earth path independently of ridge geometry', async () => {
  const flat: TerrainProvider = { source: 'synthetic', theatre: 'test', resolutionMetres: 1000, async sample(ps) { return ps.map(p => ({ ...p, height: 0, surface: 1 })); } };
  const result = await lineOfSight(flat, center, { x: 100000, y: 0 }, { ...options, stepMetres: 1000 });
  assert.equal(result.terrainMasked, true); assert.ok(result.minimumClearanceMetres < -180);
});
test('profiles include endpoints, viewshed includes inner cells and route feasibility detects water and grade', async () => {
  const data = grid(x => Math.max(0, x / 2));
  const p = gridProvider(data, 'Caucasus');
  const path = await profile(p, { x: -80, y: 0 }, { x: 80, y: 0 }, 30);
  assert.equal(path.samples[0].x, -80); assert.equal(path.samples.at(-1)!.x, 80);
  const view = await viewshed(p, center, 50, 8, options);
  assert.equal(view.cells.length, 40); assert.ok(view.cells.some(c => c.distanceMetres < 50));
  assert.equal((await routeFeasibility(p, [{ x: -80, y: 0 }, { x: 80, y: 0 }], 10, 10)).feasible, false);
  data.surfaces![10 * 21 + 10] = 2;
  const route = await routeFeasibility(gridProvider(data, 'Caucasus'), [{ x: -80, y: 0 }, { x: 0, y: 0 }], 10, 30);
  assert.equal(route.legs[0].water, true); assert.equal(route.feasible, false);
});
test('missing samples, unknown coverage, excessive budgets and invalid heights never produce plausible answers', async () => {
  const p = gridProvider(grid(), 'Caucasus');
  await assert.rejects(() => slope(p, { x: 100, y: 100 }, 10), TerrainUnavailable);
  await assert.rejects(() => lineOfSight(p, center, { x: 100000, y: 0 }, { ...options, stepMetres: 1 }), /exceeds/);
  await assert.rejects(() => lineOfSight(p, center, center, { ...options, observerHeightMetres: -1 }), /non-negative/);
  await assert.rejects(() => viewshed(p, center, 100000, 180, options), /exceeds/);
  await assert.rejects(() => slope({ ...p, async sample() { return []; } }, center, 10), TerrainUnavailable);
});

test('live provider checks theatre, batches at 500, validates replies and never sends raw exec', async () => {
  const commands: string[] = [], sizes: number[] = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const req = JSON.parse(buffer); commands.push(req.cmd);
      if (req.cmd === 'mission') socket.end(JSON.stringify({ ok: true, data: { theatre: 'Caucasus' } }) + '\n');
      else { sizes.push(req.args.points.length); socket.end(JSON.stringify({ ok: true, data: { points: req.args.points.map((p: { x: number; y: number }) => ({ ...p, height: 42, surface: 1 })) } }) + '\n'); }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const opts = { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, timeoutMs: 1000 };
    const provider = await liveProvider('Caucasus', opts);
    const samples = await provider.sample(Array.from({ length: 501 }, (_, i) => ({ x: i, y: .123456 })));
    assert.equal(samples.length, 501); assert.equal(samples[500].height, 42); assert.deepEqual(sizes, [500, 1]);
    await assert.rejects(() => liveProvider('Syria', opts), /does not match/);
    assert.deepEqual(commands, ['mission', 'land', 'land', 'mission']);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
