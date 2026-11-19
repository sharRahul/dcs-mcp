import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTerrainSites } from '../src/data/terrain-sites.js';

test('terrain candidates filter by theatre and expose source uncertainty instead of pretending pad compatibility', () => {
  const sites = listTerrainSites('GermanyColdWar', 'Rostock');
  assert.equal(sites.length, 1);
  assert.ok(Math.abs(sites[0].lat - 54.1694) < .00001);
  assert.ok(Math.abs(sites[0].lon - 11.9849833333) < .00001);
  assert.equal(sites[0].equipmentFit, 'unverified');
  assert.ok(sites[0].source.url.startsWith('https://forum.dcs.world/'));
  assert.ok(sites[0].uncertaintyMetres > 0);
  assert.deepEqual(listTerrainSites('Caucasus'), []);
});
