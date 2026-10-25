# Machine-specific yt-dlp workflow and official references

Verified 2026-10-08 on the active default profile. Do not copy to another machine without rediscovery.

## Runtime

- `/usr/local/bin/yt-dlp` contains `exec docker exec -i yt-dlp yt-dlp "$@"`; host CLI options execute inside container `yt-dlp`.
- Container image `local/yt-dlp:installed`; running/healthy at discovery; reported yt-dlp version `2026.09.27.232945` (not claimed latest).
- Bind `${YTDLP_DOWNLOAD_ROOT}` on host maps to `/downloads` inside container. Host `/root/...` output arguments cannot be passed to this wrapper as though they were container paths. Helper uses unique subdirectories and translates paths.
- `${SECRETS_ROOT}/yt-dlp` maps read-only to `/secrets`. Never enumerate/read/print secret contents; authorization-required media requires explicit user direction.
- Host `ffmpeg` and `ffprobe` resolve on PATH; container has `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`. Prefer host tools for local extraction.
- `PIL` and `faster_whisper` were not importable in the terminal interpreter at discovery. This does not prove no Hermes STT backend exists; inspect the actual Hermes runtime/provider before claiming availability.
- Helper is standard-library Python, no installation or subscription/API credentials required for extraction. Vision is a separate Hermes tool step after consent.

## Official documentation consulted

- yt-dlp README/options: https://github.com/yt-dlp/yt-dlp#usage-and-options
- Source README: https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/README.md
- Supported sites: https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md
- FFmpeg CLI: https://ffmpeg.org/ffmpeg.html
- FFmpeg filters (`fps`, `select`, `scale`, `showinfo`, `thumbnail`): https://ffmpeg.org/ffmpeg-filters.html
- ffprobe: https://ffmpeg.org/ffprobe.html
- Hermes skills: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- Hermes voice/STT: https://hermes-agent.nousresearch.com/docs/user-guide/features/tts

Raw documentation snapshots for this authoring run are in the scratch directory `youtube-docs`; these are temporary, not a dependency. Re-fetch upstream docs before assuming options are unchanged.

## Option semantics and capabilities

- `--dump-single-json` / `--simulate` retrieve metadata without media; `--skip-download` skips media but may still write requested related files. Do not mistake the two.
- Metadata includes title, description, duration, uploader, chapters and subtitle availability; do not dump signed formats/URLs or a whole playlist into model context.
- `-F` lists formats; `-f` selects them. Quality filters and audio/video merging are available; download only task-required resolution/streams.
- `-x --audio-format mp3` extracts and converts audio using FFmpeg. Speech-to-text requires another backend.
- `--write-subs`, `--write-auto-subs`, `--sub-langs`, `--sub-format` select human/automatic captions; `--convert-subs srt` converts them. Use an explicit language/fallback; no `all` language or live-chat download by default.
- `--write-thumbnail`, `--write-description`, `--write-info-json` can save sidecar data. Keep raw JSON on disk, not in replies. Thumbnail is a cover only.
- `--download-sections '*START-END'` downloads a bounded range using FFmpeg; time cuts/keyframes may not be frame-perfect. This is optional CLI functionality, not a claim the helper implements partial remote downloads.
- Playlists, archives, resumable downloads, chapters and many other site extractors exist. Batch/live/archive behavior requires its own explicit scope, not triggered by a bare link.
- `--ignore-config` prevents unrelated config from injecting defaults; `--no-exec` clears exec actions; `--no-playlist` avoids accidental playlist expansion. `--no-live-from-start` by itself DOES NOT forbid live recording: check live status and reject active live streams separately.

## Recognition accounting

For selected interval Δ and range [start,end), list sample timestamps using code and count the list. Frame extraction resolves a time to the decoder's nearby actual frame, so nominal sampling time is not a guarantee of sub-frame accuracy. Preserve timestamp precision and provenance. Full per-frame analysis is not required for a useful sampled visual overview.

Do not invent dollar estimates. Vision cost depends on model/provider, image size/detail, count and text output; subscription quota may be measured differently from API billing. Extraction CPU/disk and network traffic are distinct from model-recognition costs. Consent for 60 frames does not authorize additional batches, full audio upload, a different provider, or indefinite scanning.

## Tests and use

Run helper `--help` and per-command `--help` for exact flags. Test fixture is generated locally by FFmpeg for deterministic checks, never represented as real YouTube content. Real YouTube smoke testing must retrieve actual metadata/downloads and report network failures honestly.
