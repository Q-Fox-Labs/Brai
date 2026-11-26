### Audio, subtitles, screenshots and clips

- First discover subtitle languages through `info`. `fetch 'URL' --kind subs` downloads subtitles; select language with `--languages 'ru.*,en.*'` (default `en.*,ru.*`), consulting `fetch --help` for exact options. Human subtitles and automatic captions are different sources; state which was used. Audio transcription is not identical to obtaining YouTube captions.
- For requested audio, `fetch 'URL' --kind audio` downloads the native stream (for example Opus/WebM or M4A). Verify its format before naming it. For speech recognition of downloaded or local media, run the existing Transcription client in the personal profile. Give it the original media file and a new `.txt` output path in the profile workspace. It uses the owner's Transcription model and handles decoding, segmentation and resumption. To resume a failed attempt, keep the original file and reuse the same output path. For long media, run the terminal command in the background and wait for a successful exit before reading the output. Publish the checked final transcript to Artifacts if the user requested a file. If the service is unavailable, report that state. Fetch and identify captions separately when requested.

  ```bash
  HERMES_HOME="${HERMES_HOME:-$HOME}" BRAI_IDENTITY_BROKER=/run/brai-profile/control.sock \
    PYTHONPATH=/opt/brai-profile/runtime/services/hermes \
    /opt/brai-profile/python/bin/python3 -s -P -B -m identity.transcribe \
    --input '/absolute/path/to/local-media' --output '/absolute/path/to/new-transcript.txt'
  ```
- Summaries, chapters, posts and quotations use the actual transcript, with timestamp provenance; the legacy helper below remains a fallback when prepared. With a bare link, its old default-summary rule does NOT apply.
- `screenshot 'LOCAL_VIDEO' --at 83 --out 'NEW_JOB/frame-83.jpg'` produces one frame. Ask which second if unspecified; a single screenshot does not justify analyzing the full video.
- `clip 'LOCAL_VIDEO' --start 80 --end 95 --out 'NEW_JOB/clip.mp4'` produces a short excerpt. Standard clip cap is 120 seconds; no full re-encode by default.
- `fetch 'URL' --kind thumbnail` obtains the cover, clearly labeled as a cover, not evidence of the video's contents.
- `terminal(command="yt-dlp --ignore-config --no-playlist -F 'URL'")` lists available formats on request. For non-YouTube supported sites, validate the hostname and consult yt-dlp's official supported-sites list before explicit CLI use; the safe helper is deliberately YouTube-only. Do not promise all websites will work.
- Deliver selected files with `MEDIA:/absolute/path`; do not expose secrets/cookies/signed media URLs/raw bulky metadata. Verify file existence and real format first.

- For full audio transcripts, preserve the raw speech-recognition output before any language-model editing. Verify that the beginning and ending were recognized, flag possible internal omissions and recognition errors, and call the transcript verbatim only after alignment with the audio.
