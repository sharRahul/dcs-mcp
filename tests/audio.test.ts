import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm, link, truncate, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { convertAudio } from '../src/audio/convert.js';

const exec = promisify(execFile);
const ffmpeg = process.env.DCS_FFMPEG_PATH || 'ffmpeg';
const available = await exec(ffmpeg, ['-version'], { windowsHide: true }).then(() => true, () => false);
async function scratch(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dcs-audio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function pcmWav() {
  const data = Buffer.alloc(44 + 4410 * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(44100, 24); data.writeUInt32LE(88200, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < 4410; i++) data.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 44100)), 44 + i * 2);
  return data;
}

test('conversion refuses existing output, source aliases, directories and unsupported formats before invoking a codec', async t => {
  const dir = await scratch(t), inputPath = join(dir, 'source.wav'), outputPath = join(dir, 'existing.wav');
  const source = pcmWav(); await writeFile(inputPath, source); await writeFile(outputPath, 'keep me');
  await assert.rejects(convertAudio({ inputPath, outputPath, format: 'wav' }), /existing|overwrite/i);
  await assert.rejects(convertAudio({ inputPath, outputPath: inputPath, format: 'wav' }), /source|overwrite/i);
  const alias = join(dir, 'alias.wav'); await link(inputPath, alias);
  await assert.rejects(convertAudio({ inputPath, outputPath: alias, format: 'wav' }), /source|existing|overwrite/i);
  await assert.rejects(convertAudio({ inputPath: dir, outputPath: join(dir, 'out.wav'), format: 'wav' }), /regular file/i);
  await assert.rejects(convertAudio({ inputPath, outputPath: join(dir, 'out.mp3'), format: 'wav' }), /extension|.wav/i);
  await writeFile(join(dir, 'playlist.m3u'), 'https://example.com/audio.mp3');
  await assert.rejects(convertAudio({ inputPath: join(dir, 'playlist.m3u'), outputPath: join(dir, 'out.wav'), format: 'wav' }), /input.*format|mp3.*wav.*ogg/i);
  assert.deepEqual(await readFile(inputPath), source);
  assert.equal((await readFile(outputPath)).toString(), 'keep me');
  assert.ok(!(await readdir(dir)).some(p => p.startsWith('.dcs-audio-')));
});

test('missing FFmpeg produces setup guidance and removes staging files', async t => {
  const dir = await scratch(t), inputPath = join(dir, 'source.wav'); await writeFile(inputPath, pcmWav());
  const previous = process.env.DCS_FFMPEG_PATH;
  process.env.DCS_FFMPEG_PATH = join(dir, 'missing-ffmpeg.exe');
  try {
    await assert.rejects(convertAudio({ inputPath, outputPath: join(dir, 'out.wav'), format: 'wav' }), /FFmpeg.*DCS_FFMPEG_PATH/i);
  } finally { if (previous === undefined) delete process.env.DCS_FFMPEG_PATH; else process.env.DCS_FFMPEG_PATH = previous; }
  assert.deepEqual(await readdir(dir), ['source.wav']);
});

test('actual MP3 converts to PCM16 WAV and Vorbis OGG, preserving the source and literal paths', { skip: !available }, async t => {
  const dir = await scratch(t), inputPath = join(dir, 'voice & clearance.mp3');
  const wav = join(dir, 'tone.wav'); await writeFile(wav, pcmWav());
  await exec(ffmpeg, ['-nostdin', '-i', wav, '-c:a', 'libmp3lame', inputPath], { windowsHide: true });
  const source = await readFile(inputPath);
  for (const format of ['wav', 'ogg'] as const) {
    const outputPath = join(dir, 'clearance & reply.' + format);
    const result = await convertAudio({ inputPath, outputPath, format, sampleRate: 22050, channels: 2 });
    const bytes = await readFile(outputPath);
    assert.equal(result.outputPath, await realpath(outputPath)); assert.equal(result.bytes, bytes.length);
    assert.equal(result.sampleRate, 22050); assert.equal(result.channels, 2);
    if (format === 'wav') {
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
      const fmt = bytes.indexOf(Buffer.from('fmt '));
      assert.equal(bytes.readUInt16LE(fmt + 8), 1); assert.equal(bytes.readUInt16LE(fmt + 10), 2);
      assert.equal(bytes.readUInt32LE(fmt + 12), 22050); assert.equal(bytes.readUInt16LE(fmt + 22), 16);
    } else { assert.equal(bytes.toString('ascii', 0, 4), 'OggS'); assert.ok(bytes.includes(Buffer.from('vorbis'))); }
    const decoded = await exec(ffmpeg, ['-nostdin', '-i', outputPath, '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { encoding: 'buffer', windowsHide: true });
    const duration = decoded.stdout.length / (22050 * 2 * 2);
    assert.ok(duration > 0.07 && duration < 0.2, 'unexpected duration ' + duration);
    assert.ok(decoded.stdout.some(byte => byte !== 0), 'audio is silent');
  }
  assert.deepEqual(await readFile(inputPath), source);
  assert.ok(!(await readdir(dir)).some(p => p.startsWith('.dcs-audio-')));
});

test('bad MP3 decoding publishes no file and leaves no staging directory', { skip: !available }, async t => {
  const dir = await scratch(t), inputPath = join(dir, 'bad.mp3'); await writeFile(inputPath, 'not audio');
  await assert.rejects(convertAudio({ inputPath, outputPath: join(dir, 'out.wav'), format: 'wav' }), /conversion failed/i);
  assert.deepEqual(await readdir(dir), ['bad.mp3']);
});

test('empty and oversized input is refused before staging', async t => {
  const dir = await scratch(t), inputPath = join(dir, 'large.mp3');
  await writeFile(inputPath, '');
  await assert.rejects(convertAudio({ inputPath, outputPath: join(dir, 'out.wav'), format: 'wav' }), /nonempty/);
  await truncate(inputPath, 64 * 1024 * 1024 + 1);
  await assert.rejects(convertAudio({ inputPath, outputPath: join(dir, 'out.wav'), format: 'wav' }), /64 MiB/);
  assert.deepEqual(await readdir(dir), ['large.mp3']);
});

test('output limit refuses truncated audio even when FFmpeg exits successfully', { skip: !available }, async t => {
  const dir = await scratch(t), inputPath = join(dir, 'long.mp3');
  await exec(ffmpeg, ['-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '400', '-c:a', 'libmp3lame', '-b:a', '32k', inputPath], { windowsHide: true });
  await assert.rejects(convertAudio({ inputPath, outputPath: join(dir, 'out.wav'), format: 'wav', sampleRate: 48000, channels: 2 }), /64 MiB/);
  assert.deepEqual(await readdir(dir), ['long.mp3']);
});
