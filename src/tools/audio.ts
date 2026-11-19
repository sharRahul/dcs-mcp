import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { audioConversionSchema, convertAudio } from '../audio/convert.js';
import { buildResult, errorResult } from './format.js';

export function registerAudioTools(server: McpServer): void {
  server.registerTool('dcs_audio_convert', {
    title: 'Convert mission audio',
    description: 'Convert a local MP3, WAV or OGG file to PCM16 WAV or Vorbis OGG for DCS mission audio. ' +
      'Requires FFmpeg on PATH or DCS_FFMPEG_PATH set to its executable. Runs locally; no uploads. ' +
      'Defaults: 44100 Hz, mono. Input/output limit: 64 MiB; conversion timeout: 60 seconds. ' +
      'Never overwrites an existing file. The output directory must exist. ' +
      'Pass returned outputPath as file in dcs_miz_add_trigger actions: sound, sound_to_unit (unit name), ' +
      'sound_to_group (group name), sound_to_coalition (coalition), or radio_transmission. ' +
      'Conversion does not create a trigger or embed audio until the file is used by an authoring action.',
    inputSchema: audioConversionSchema,
    outputSchema: z.object({ outputPath: z.string(), format: z.enum(['wav', 'ogg']), codec: z.enum(['pcm_s16le', 'vorbis']),
      sampleRate: z.number(), channels: z.number(), bytes: z.number() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async args => {
    try {
      const result = await convertAudio(args);
      return buildResult('Converted audio: ' + result.outputPath + ' (' + result.codec + ', ' + result.sampleRate + ' Hz, ' + result.channels + ' channel(s), ' + result.bytes + ' bytes).', result);
    } catch (error) { return errorResult(error); }
  });
}
