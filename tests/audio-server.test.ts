import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import AdmZip from 'adm-zip';
import { openSession, closeSession } from '../src/miz/sessions.js';
import { asTable } from '../src/miz/lua.js';
const exec = promisify(execFile);

test('MCP converts audio and embeds it for unit, group, coalition, all and radio actions', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dcs-audio-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, DCS_MISSION_OUTPUT_DIR: dir, DCS_MCP_STATE_DIR: 'off' } as Record<string, string>, stderr: 'ignore' });
  const client = new Client({ name: 'audio-test', version: '0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, name + ': ' + JSON.stringify(r.content));
    return r.structuredContent as Record<string, any>;
  };
  try {
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'dcs_audio_convert'));
    const failed = await client.callTool({ name: 'dcs_audio_convert', arguments: { inputPath: join(dir, 'missing.mp3'), outputPath: join(dir, 'out.wav'), format: 'wav' } });
    assert.equal(failed.isError, true);
    const invalid = await client.callTool({ name: 'dcs_audio_convert', arguments: { inputPath: 'a.mp3', outputPath: 'b.wav', format: 'wav', channels: 6 } });
    assert.equal(invalid.isError, true);
    const ffmpeg = process.env.DCS_FFMPEG_PATH || 'ffmpeg';
    const available = await exec(ffmpeg, ['-version'], { windowsHide: true }).then(() => true, () => false);
    if (!available) { t.diagnostic('Real MCP conversion requires FFmpeg; registration and error contract verified'); return; }
    const inputPath = join(dir, 'speech.mp3');
    await exec(ffmpeg, ['-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', '-c:a', 'libmp3lame', inputPath], { windowsHide: true });
    const converted = await call('dcs_audio_convert', { inputPath, outputPath: join(dir, 'speech.ogg'), format: 'ogg' });
    assert.equal(converted.codec, 'vorbis'); assert.equal(converted.sampleRate, 44100); assert.equal(converted.channels, 1);
    const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
    await call('dcs_miz_add_aircraft_group', { sessionId, side: 'blue', country: 'USA', name: 'Colt', type: 'F-16C_50', count: 2, x: -280000, y: 680000 });
    await call('dcs_miz_add_trigger_zone', { sessionId, name: 'Tower', x: -280000, y: 680000, radius: 100 });
    for (const audience of [{ kind: 'sound_to_unit', unit: 'Colt-2' }, { kind: 'sound_to_group', group: 'Colt' },
      { kind: 'sound_to_coalition', coalition: 'blue' }, { kind: 'sound' },
      { kind: 'radio_transmission', zone: 'Tower', frequencyMHz: 251, name: 'clearance' }]) {
      await call('dcs_miz_add_trigger', { sessionId, type: 'once', conditions: [{ kind: 'time_after', seconds: 5 }], actions: [{ ...audience, file: converted.outputPath, delaySeconds: 2 }] });
    }
    const outPath = join(dir, 'audio.miz');
    const saved = await call('dcs_miz_save_as', { sessionId, outPath }); assert.equal(saved.saved, true);
    const embedded = new AdmZip(outPath).readFile('l10n/DEFAULT/speech.ogg');
    assert.deepEqual(embedded, await readFile(converted.outputPath));
    const reopened = await openSession(outPath);
    try {
      const compiled = asTable(asTable(reopened.mission.trig)!.actions)!;
      assert.ok(String(compiled[1]).startsWith('a_out_sound_u(')); assert.ok(String(compiled[2]).startsWith('a_out_sound_g('));
      assert.ok(String(compiled[3]).startsWith('a_out_sound_s(')); assert.ok(String(compiled[4]).startsWith('a_out_sound('));
      assert.ok(String(compiled[5]).startsWith('a_radio_transmission('));
      assert.equal(reopened.document.triggers[0].unitRefs.length, 1);
    } finally { closeSession(reopened.id); }
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
