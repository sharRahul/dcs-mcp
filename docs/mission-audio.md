# Mission audio

Convert local speech recordings, including an MP3 downloaded from ElevenLabs, into DCS mission audio with dcs_audio_convert. Conversion and trigger authoring run with DCS closed. No ElevenLabs API key or network service is involved in this tool.

## Setup

Install FFmpeg with its MP3 decoder and Vorbis encoder. Put its executable on PATH, or add DCS_FFMPEG_PATH to the MCP server environment, for example C:/Tools/ffmpeg/bin/ffmpeg.exe. Restart the MCP server after changing its environment. FFmpeg is an optional external dependency and is not bundled or automatically downloaded by the server.

## Convert

Call dcs_audio_convert with:

~~~json
{
  "inputPath": "F:/mission-audio/clearance.mp3",
  "outputPath": "F:/mission-audio/clearance.ogg",
  "format": "ogg",
  "sampleRate": 44100,
  "channels": 1
}
~~~

For WAV, use format wav and an outputPath ending in .wav. WAV is signed 16-bit little-endian PCM; OGG is Vorbis at quality 4. Defaults are 44100 Hz and mono. Supported sample rates: 16000, 22050, 24000, 44100 and 48000 Hz; channels: 1 or 2. The result contains outputPath, format, codec, sampleRate, channels and bytes. Local MP3, WAV and OGG inputs are accepted, including uppercase extensions. The tool uses the first audio stream.

The output directory must exist. Existing files, source aliases and symlink/directory inputs are refused. Input and output are limited to 64 MiB each, with a 60-second conversion timeout. Failed conversion removes its staging files and publishes no output. Audio is processed locally and source bytes are preserved.

## Add to a trigger

Pass the returned outputPath as file in dcs_miz_add_trigger:

~~~json
{
  "sessionId": "YOUR_SESSION_ID",
  "type": "once",
  "comment": "Clearance for Colt two",
  "conditions": [{ "kind": "time_after", "seconds": 10 }],
  "actions": [{
    "kind": "sound_to_unit",
    "unit": "Colt-2",
    "file": "F:/mission-audio/clearance.ogg",
    "delaySeconds": 0
  }]
}
~~~

The unit must already exist. Names resolve to numeric DCS IDs, and missing names are errors. To change audience, use one of:

| Audience | Action fields |
|---|---|
| Everyone | kind: sound, file |
| One unit | kind: sound_to_unit, unit, file |
| One group | kind: sound_to_group, group, file |
| Coalition | kind: sound_to_coalition, coalition: blue/red/neutrals, file |

All accept optional delaySeconds. radio_transmission also takes file and its existing zone, frequency, modulation, power and other transmission settings. Conversion does not create or schedule a trigger by itself.

Validate and save using dcs_miz_save_as to a new .miz. Audio is embedded under l10n/DEFAULT and registered in mapResource. One clip can be reused by multiple actions. Two different clips with the same bare filename must be renamed before embedding. Mission playback needs the embedded audio, not the original MP3, FFmpeg or an ElevenLabs connection.

## Evidence and limits

SOUND TO UNIT was verified in installed DCS 2.9.31.29434: MissionEditor/modules/me_trigrules.lua declares a_out_sound_u with UNIT_SELECTOR, FILE_SELECT and START_DELAY. An independently ME-saved mission, RS - Germany/RS - F16-Operation_Iron_Thunder.miz, supplied the oracle spec and compiled call captured in tests/fixtures/trig-oracle.json. Its native call is a_out_sound_u(unitId, getValueResourceByKey(resourceKey), delay). The oracle builder now includes this predicate.

Automated tests check MP3 decoding, WAV PCM format, Vorbis identification, duration, non-silent samples, source preservation, failure cleanup, resource byte preservation, native compiler output and the actual MCP conversion-to-trigger-to-save workflow. These do not establish audible playback or current multiplayer delivery in DCS; those still require a flight check.

## How the reference converters work

[AlexIII/web-wav-converter](https://github.com/AlexIII/web-wav-converter/blob/master/wav-conv.ts) decodes with AudioContext.decodeAudioData, resamples with OfflineAudioContext, reduces channels, normalizes, quantizes PCM and writes a RIFF/WAVE header. [DisabledAbel/mp3-to-wav-convert](https://github.com/DisabledAbel/mp3-to-wav-convert/blob/main/src/lib/audioConverter.ts) also uses browser decoding, interleaves PCM16 samples and writes the WAV header; lamejs serves its reverse MP3 encoding path. Renaming an MP3 is insufficient because decoding must happen first.

Those browser APIs are unavailable in the Node stdio server. This implementation uses FFmpeg to perform decoding, resampling and encoding for both WAV and OGG. It does not copy either project's implementation.
