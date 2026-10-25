# Local synthesis recipes

## Installed adapter and provider
Read `${HERMES_HOME}/LOCAL_VOICE.md` first; it records the local installation and active voice. The tested adapter is `${HERMES_HOME}/scripts/silero_voice.py`. It invokes the local Silero CLI, rejects unprepared non-Cyrillic text, produces WAV, and converts to mono OGG/Opus for Telegram. Model files live under `${MODELS_ROOT}`; do not download a replacement model for routine synthesis.

The named command provider is configured as:

```yaml
tts:
  provider: silero
  providers:
    silero:
      type: command
      command: python3 ${HERMES_HOME}/scripts/silero_voice.py --input {input_path} --output {output_path} --voice {voice}
      voice: eugene
      output_format: ogg
      voice_compatible: true
      timeout: 180
      max_text_length: 900
```

This is a configuration recipe, not an instruction to overwrite an existing YAML file. Inspect existing settings and preserve unrelated fields. The voice shown is an example; read the configured voice before each selection-sensitive action. Configure settings with `hermes config set`, using `--force` for supported named-provider keys if required by the installed validator.

## Sample without changing the default
Create a UTF-8 text file using the file-writing tool in `${HERMES_HOME}/cache/scratch`, then run:

```bash
python3 ${HERMES_HOME}/scripts/silero_voice.py \
  --input ${HERMES_HOME}/cache/scratch/voice_sample.txt \
  --output ${HERMES_HOME}/audio_cache/voice_sample.ogg \
  --voice eugene
```

Pass the requested speaker ID explicitly. Do not temporarily modify the global default merely to generate a sample; the adapter permits per-call selection.

## Verification and delivery
Use the installed FFmpeg to check decoding:

```bash
ffmpeg \
  -hide_banner -v error \
  -i ${HERMES_HOME}/audio_cache/voice_sample.ogg -f null -
```

Check existence and nonzero file size with a filesystem tool. A successful decode checks file integrity, not subjective pronunciation or timbre; do not claim to have listened unless playback was actually reviewed.

Deliver the verified file:

```text
[[audio_as_voice]]
MEDIA:${HERMES_HOME}/audio_cache/voice_sample.ogg
```

For a permanent voice switch, read the setting back after writing and perform a fresh synthesis using the selected provider. Update the state file's active-voice display without changing the dialogue's voice/text mode.
