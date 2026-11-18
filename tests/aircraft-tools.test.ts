import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('aircraft MCP tools validate input, route structured commands and surface bridge failures', { timeout: 30000 }, async () => {
  const requests: any[] = [];
  const sockets = new Set<net.Socket>();
  const tcp = net.createServer(s => {
    sockets.add(s); s.on('close', () => sockets.delete(s));
    let line = ''; s.on('data', b => {
      line += b.toString(); if (!line.includes('\n')) return;
      const r = JSON.parse(line); requests.push(r);
      s.end(JSON.stringify(r.args.group === 'Missing' ? { ok: false, error: 'aircraft group unavailable' } : { ok: true, data: { scope: 'test', request: r.args } }) + '\n');
    });
  });
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const port = (tcp.address() as net.AddressInfo).port;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, DCS_MCP_STATE_DIR: 'off' } as Record<string, string>, stderr: 'ignore' });
  const client = new Client({ name: 'aircraft-contract', version: '0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const name of ['dcs_aircraft_detect', 'dcs_aircraft_inspect_options', 'dcs_aircraft_set_option', 'dcs_aircraft_task', 'dcs_support_flight_register', 'dcs_support_flight_inspect', 'dcs_transport_verify', 'dcs_support_flight_remove']) {
      assert.ok(tools.some(t => t.name === name), name);
    }
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { ...args, port } });
    const r = await call('dcs_aircraft_detect', { group: 'Flight', methods: ['RADAR'] });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(requests[0].cmd, 'aircraft_ai');
    assert.equal(requests[0].args.operation, 'detect');
    assert.deepEqual(requests[0].args.methods, ['RADAR']);
    await call('dcs_aircraft_task', { group: 'Flight', action: 'suspend', task: { kind: 'orbit', point: { x: 0, y: 0 }, altitudeMetres: 5000, speedMps: 160 } });
    assert.equal(requests[1].args.task.pattern, 'Circle');
    const before = requests.length;
    for (const [name, args] of [
      ['dcs_aircraft_detect', { group: 'Flight', methods: ['MAGIC'] }],
      ['dcs_aircraft_set_option', { group: 'Flight', option: 'roe', value: 5 }],
      ['dcs_aircraft_task', { group: 'Flight', action: 'set', task: { kind: 'script', code: 'destroy()' } }],
      ['dcs_aircraft_task', { group: 'Flight', action: 'suspend' }],
      ['dcs_aircraft_task', { group: 'Flight', action: 'push', task: { kind: 'orbit', pattern: 'Race-Track', point: { x: 0, y: 0 }, altitudeMetres: 1000, speedMps: 100 } }],
      ['dcs_support_flight_register', { name: 'Lift', group: 'Flight', role: 'transport' }],
    ] as const) {
      let rejected = false;
      try { rejected = (await call(name, args)).isError === true; } catch { rejected = true; }
      assert.ok(rejected, name);
    }
    assert.equal(requests.length, before, 'invalid requests reached the bridge');
    const missing = await call('dcs_aircraft_inspect_options', { group: 'Missing' });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /aircraft group unavailable/);
    for (const [name, args, operation] of [
      ['dcs_aircraft_set_option', { group: 'Flight', option: 'reaction', value: 5 }, 'set_option'],
      ['dcs_support_flight_register', { name: 'Lift', group: 'Flight', role: 'transport', pickup: { x: 0, y: 0, radiusMetres: 100 }, drop: { x: 1000, y: 0, radiusMetres: 100 } }, 'monitor_register'],
      ['dcs_support_flight_inspect', { name: 'Lift' }, 'monitor_inspect'],
      ['dcs_transport_verify', { name: 'Lift' }, 'transport'],
      ['dcs_support_flight_remove', { name: 'Lift' }, 'monitor_remove'],
    ] as const) {
      const result = await call(name, args); assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(requests.at(-1).args.operation, operation);
    }
  } finally {
    await client.close(); for (const s of sockets) s.destroy();
    await new Promise<void>(resolve => tcp.close(() => resolve()));
  }
});
