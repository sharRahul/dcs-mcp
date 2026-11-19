/** Local mission audio conversion. No browser, network service, or mission Lua involved. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, realpath, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../security/files.js';
import { ARCHIVE_LIMITS } from '../constants.js';

export const audioConversionSchema = z.object({
  inputPath: z.string().min(1).describe('Local MP3, WAV or OGG file to convert'),
  outputPath: z.string().min(1).describe('New local .wav or .ogg file; existing files are never overwritten'),
  format: z.enum(['wav', 'ogg']),
  sampleRate: z.union([z.literal(16000), z.literal(22050), z.literal(24000), z.literal(44100), z.literal(48000)]).default(44100),
  channels: z.union([z.literal(1), z.literal(2)]).default(1),
}).strict();
export type AudioConversionInput = z.input<typeof audioConversionSchema>;
const exec = promisify(execFile);
const MAX_BYTES = ARCHIVE_LIMITS.maxEntryUncompressed;

export async function convertAudio(input: AudioConversionInput) {
  const options = audioConversionSchema.parse(input);
  const inputPath = path.resolve(options.inputPath), requestedOutput = path.resolve(options.outputPath);
  if (inputPath === requestedOutput) throw new Error('Refusing to overwrite the source audio');
  if (path.extname(requestedOutput).toLowerCase() !== '.' + options.format) {
    throw new Error('Output extension must be .' + options.format);
  }
  const inputInfo = await lstat(inputPath);
  if (!inputInfo.isFile()) throw new Error('Input must be a regular file, not a symlink or directory');
  const inputFormat = path.extname(inputPath).slice(1).toLowerCase();
  if (!['mp3', 'wav', 'ogg'].includes(inputFormat)) throw new Error('Input format must be MP3, WAV or OGG');
  if (inputInfo.size === 0 || inputInfo.size > MAX_BYTES) throw new Error('Input audio must be nonempty and at most 64 MiB');
  const parent = await realpath(path.dirname(requestedOutput));
  const outputPath = path.join(parent, path.basename(requestedOutput));
  try {
    await lstat(outputPath);
    throw new Error('Refusing to overwrite an existing output file: ' + outputPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  // Snapshot a bounded regular file before decoding. Force the demuxer and restrict
  // protocols so a disguised playlist cannot make FFmpeg fetch external resources.
  const handle = await open(inputPath, 'r');
  let source: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) throw new Error('Input audio must be a nonempty regular file of at most 64 MiB');
    source = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < source.length) {
      const { bytesRead } = await handle.read(source, offset, source.length - offset, offset);
      if (!bytesRead) throw new Error('Input audio changed while reading');
      offset += bytesRead;
    }
  } finally { await handle.close(); }

  const staging = await mkdtemp(path.join(parent, '.dcs-audio-'));
  try {
    const stagedInput = path.join(staging, 'input.' + inputFormat);
    const stagedOutput = path.join(staging, 'output.' + options.format);
    await writeFile(stagedInput, source, { flag: 'wx' });
    const codec = options.format === 'wav' ? 'pcm_s16le' : 'libvorbis';
    try {
      await exec(process.env.DCS_FFMPEG_PATH || 'ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
        '-protocol_whitelist', 'file,pipe', '-f', inputFormat, '-i', stagedInput,
        '-map', '0:a:0', '-vn', '-map_metadata', '-1',
        '-ac', String(options.channels), '-ar', String(options.sampleRate),
        '-c:a', codec, ...(options.format === 'ogg' ? ['-q:a', '4'] : []),
        '-fs', String(MAX_BYTES), '-f', options.format, stagedOutput,
      ], { timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('FFmpeg was not found. Install FFmpeg on PATH or set DCS_FFMPEG_PATH to its executable.');
      }
      const failure = error as Error & { stderr?: string; killed?: boolean };
      throw new Error('Audio conversion failed' + (failure.killed ? ' (60-second timeout or process output limit)' : '') + ': ' + (failure.stderr || failure.message).slice(-2000));
    }
    const info = await stat(stagedOutput);
    // -fs may produce a truncated file with exit status zero. Never publish it.
    if (info.size === 0 || info.size >= MAX_BYTES) throw new Error('Converted audio is empty or exceeds the 64 MiB resource limit');
    const bytes = await readFile(stagedOutput);
    await atomicWrite(outputPath, bytes, { sourcePath: inputPath });
    return { outputPath, format: options.format, codec: options.format === 'wav' ? 'pcm_s16le' : 'vorbis', sampleRate: options.sampleRate, channels: options.channels, bytes: bytes.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
