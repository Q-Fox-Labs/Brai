# Verification and helper contract

Проверяй текущую установленную версию помощника и его зависимости. Unit-проверки URL, ограничений и команд не подтверждают доступность внешнего сайта. Для проверки интеграции используй разрешённое публичное тестовое видео и новые временные файлы. Извлечение аудио или кадров не означает распознавание речи или изображений. История замеров конкретного экземпляра хранится отдельно.

## Exact CLI

Invoke through the Hermes `terminal` tool with `python SKILL_DIR/scripts/video_workflow.py` followed by:

- `info URL`
- `links FILE`
- `fetch URL --kind audio|video|subs|thumbnail [--languages 'ru.*,en.*']`
- `plan LOCAL_VIDEO --interval SECONDS [--start SECONDS] [--end SECONDS]`
- `frames LOCAL_VIDEO --interval SECONDS [--start SECONDS] [--end SECONDS] --consent [--max-frames 60] --out NEW_DIRECTORY`
- `screenshot LOCAL_VIDEO --at SECONDS --out NEW_FILE.jpg`
- `clip LOCAL_VIDEO --start SECONDS --end SECONDS --out NEW_FILE.mp4 [--max-duration 120]`
- `audio LOCAL_MEDIA --out NEW_FILE.wav`

stdout is JSON; nonzero status means failure. No new Python packages are needed. Output files/directories must be new; never overwrite user data to retry. Native audio fetch does NOT force MP3. Sample timestamps are requested seek times, not decoder-measured PTS. Frames manifest is `OUT/manifest.json`; `frames[].file` is relative to OUT. Plan count is for [start,end). Frame extraction starts a decoder per selected frame, so long/dense scans may be CPU-expensive even before vision; prefer a short range and sparse initial cadence. Maximum plan size is 100000 timestamps, not permission to recognize that many; default approved extraction budget remains 60.

## Recognition automation contract

The helper automates retrieval and extraction; the installed skill orchestrates `vision_analyze` over selected frames only after chat consent. Each result must be persisted with timestamp, source path, success/error and actual observation. The vision tool remains the active configured Hermes tool; no API key or billing provider is hardcoded. Unknown, unreadable and unsampled intervals remain explicitly unknown. No detached daemon or automatic watch-all-links job was installed.
