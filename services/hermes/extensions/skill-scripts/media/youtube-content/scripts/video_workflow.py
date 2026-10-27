#!/usr/bin/env python3
"""Small explicit YouTube/local-media workflow. JSON stdout; errors on stderr."""
import argparse
import html
import json
import math
import subprocess
from decimal import Decimal
from pathlib import Path
import re
import sys
import uuid
from urllib.parse import urlsplit


def youtube_url(value):
    u = urlsplit(value)
    if (u.scheme != 'https' or u.hostname not in
        {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'} or
        u.username or u.password or u.port not in (None, 443)):
        raise ValueError('Expected an HTTPS YouTube URL')
    return value


def links(path):
    text = html.unescape(Path(path).read_text(encoding='utf-8'))
    result = []
    for value in re.findall(r'https://[^\s<>\"\'\)\],]+', text):
        value = value.rstrip('.,;:!?')
        try:
            youtube_url(value)
        except ValueError:
            continue
        if value not in result:
            result.append(value)
    return {'links': result, 'count': len(result)}


def run_command(argv, timeout=120):
    return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=timeout).stdout


def probe(path):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError('Expected a local media file')
    return json.loads(run_command(['ffprobe', '-v', 'error', '-show_format',
                                  '-show_streams', '-of', 'json', str(path)]))


def number(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('Times must be finite')
    return value


def window(path, start=0, end=None):
    duration = number(probe(path)['format']['duration'])
    start = number(start)
    end = duration if end is None else number(end)
    if not 0 <= start < end <= duration:
        raise ValueError('Require 0 <= start < end <= media duration')
    return start, end, duration


def plan(path, interval, start=0, end=None):
    start, end, duration = window(path, start, end)
    interval = number(interval)
    if interval <= 0:
        raise ValueError('Interval must be positive')
    a, b, step = map(lambda v: Decimal(str(v)), (start, end, interval))
    count = int(((b-a)/step).to_integral_value(rounding='ROUND_CEILING'))
    if count > 100000:
        raise ValueError('Plan exceeds 100000 timestamps; increase interval')
    timestamps = [float(a+i*step) for i in range(count)]
    return {'source': str(Path(path).resolve()), 'duration': duration,
            'start': start, 'end': end, 'interval': interval,
            'count': count, 'timestamps': timestamps}


def jpeg(path, at, out):
    out = Path(out).absolute()
    if out.suffix.lower() not in {'.jpg', '.jpeg'}:
        raise ValueError('JPEG output must use .jpg or .jpeg')
    if out.exists():
        raise ValueError('Output already exists')
    out.parent.mkdir(parents=True, exist_ok=True)
    run_command(['ffmpeg', '-v', 'error', '-nostdin', '-n', '-i', str(Path(path).resolve()),
                 '-ss', str(at), '-frames:v', '1', '-vf',
                 r'scale=min(960\,iw):-2', '-q:v', '2', str(out)])
    if not out.is_file() or out.stat().st_size == 0:
        raise ValueError('No video frame at requested timestamp')
    return str(out)


def frames(path, interval, start, end, max_frames, consent, out):
    if not consent:
        raise ValueError('Explicit --consent required for frame sampling; no vision API is called')
    selected = plan(path, interval, start, end)
    if max_frames < 1 or selected['count'] > max_frames:
        raise ValueError('Frame limit exceeded; increase interval or explicitly raise --max-frames')
    out = Path(out).absolute()
    out.mkdir(parents=True, exist_ok=False)
    selected['frames'] = []
    selected['timestamp_semantics'] = 'Requested seek times, not measured decoded-frame PTS'
    for i, at in enumerate(selected['timestamps']):
        name = f'frame_{i:05d}.jpg'
        jpeg(path, at, out / name)
        selected['frames'].append({'file': name, 'timestamp': at})
    (out / 'manifest.json').write_text(json.dumps(selected, indent=2), encoding='utf-8')
    return {**selected, 'out': str(out)}


def screenshot(path, at, out):
    at = number(at)
    window(path, at)
    return {'out': jpeg(path, at, out), 'timestamp': at,
            'timestamp_semantics': 'Requested seek time, not decoded-frame PTS'}


def clip(path, start, end, out, max_duration=120):
    start, end, _ = window(path, start, end)
    max_duration = number(max_duration)
    if max_duration <= 0 or end-start > max_duration:
        raise ValueError('Clip duration exceeds limit')
    out = Path(out).absolute()
    if out.exists():
        raise ValueError('Output already exists')
    out.parent.mkdir(parents=True, exist_ok=True)
    run_command(['ffmpeg', '-v', 'error', '-nostdin', '-n', '-i', str(Path(path).resolve()),
                 '-ss', str(start), '-t', str(end-start), '-map', '0:v:0', '-map', '0:a?',
                 '-vf', r'scale=min(1280\,iw):-2', '-c:v', 'libx264', '-preset', 'fast',
                 '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', str(out)],
                timeout=max(120, max_duration*5))
    return {'out': str(out), 'start': start, 'end': end,
            'duration': float(probe(out)['format']['duration'])}


def audio(path, out):
    probe(path)
    out = Path(out).absolute()
    if out.suffix.lower() != '.wav':
        raise ValueError('Audio output must use .wav')
    if out.exists():
        raise ValueError('Output already exists')
    out.parent.mkdir(parents=True, exist_ok=True)
    run_command(['ffmpeg', '-v', 'error', '-nostdin', '-n', '-i', str(Path(path).resolve()),
                 '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', str(out)],
                timeout=1800)
    return {'out': str(out), 'channels': 1, 'sample_rate': 16000,
            'duration': float(probe(out)['format']['duration'])}


YTDLP = '/usr/local/bin/yt-dlp'
YTDLP_BASE = [YTDLP, '--ignore-config', '--no-playlist', '--no-exec', '--no-live-from-start']


def info(url):
    url = youtube_url(url)
    raw = json.loads(run_command(YTDLP_BASE + ['--skip-download', '--dump-single-json', '--', url],
                                 timeout=180))
    chapters = raw.get('chapters') or []
    return {'id': str(raw.get('id') or '')[:100],
            'title': str(raw.get('title') or '')[:500],
            'description': str(raw.get('description') or '')[:10000],
            'description_truncated': len(str(raw.get('description') or '')) > 10000,
            'duration': raw.get('duration'),
            'uploader': str(raw.get('uploader') or '')[:500],
            'live_status': raw.get('live_status'), 'is_live': bool(raw.get('is_live')),
            'chapters': [{'start_time': c.get('start_time'), 'end_time': c.get('end_time'),
                          'title': str(c.get('title') or '')[:300]} for c in chapters[:200]],
            'chapters_truncated': len(chapters) > 200,
            'subtitle_languages': sorted(raw.get('subtitles') or {})[:200],
            'automatic_caption_languages': sorted(raw.get('automatic_captions') or {})[:200]}


DOWNLOAD_ROOT = Path('/opt/yt-dlp/downloads')


def fetch(url, kind, languages='en.*,ru.*'):
    url = youtube_url(url)
    if kind not in {'audio', 'video', 'subs', 'thumbnail'}:
        raise ValueError('Unknown fetch kind')
    metadata = info(url)
    if metadata.get('is_live') or metadata.get('live_status') in {'is_live', 'is_upcoming', 'post_live'}:
        raise ValueError('Active/upcoming/processing live streams are not downloaded')
    job = DOWNLOAD_ROOT / ('workflow-' + uuid.uuid4().hex)
    job.mkdir(parents=True, exist_ok=False)
    container_job = Path('/downloads') / job.name
    argv = YTDLP_BASE + ['--no-overwrites', '-o', str(container_job / 'media-%(id)s.%(ext)s')]
    if kind == 'audio':
        argv += ['-f', 'bestaudio/best[height<=720]']
    elif kind == 'video':
        argv += ['-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]',
                 '--merge-output-format', 'mp4']
    elif kind == 'subs':
        argv += ['--skip-download', '--write-subs', '--write-auto-subs',
                 '--sub-langs', languages, '--sub-format', 'vtt']
    else:
        argv += ['--skip-download', '--write-thumbnail']
    run_command(argv + ['--', url], timeout=1800)
    files = sorted(str(p) for p in job.iterdir() if p.is_file() and
                   not p.name.endswith(('.part', '.ytdl', '.temp')))
    if not files:
        raise ValueError(f'No {kind} files produced (possibly unavailable); job: {job}')
    return {'kind': kind, 'job_dir': str(job), 'files': files, 'count': len(files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('links')
    p.add_argument('path')
    for command in ('plan', 'frames'):
        p = sub.add_parser(command)
        p.add_argument('path')
        p.add_argument('--interval', required=True, type=float)
        p.add_argument('--start', default=0, type=float)
        p.add_argument('--end', type=float)
        if command == 'frames':
            p.add_argument('--max-frames', default=60, type=int)
            p.add_argument('--consent', action='store_true')
            p.add_argument('--out', required=True)
    p = sub.add_parser('screenshot')
    p.add_argument('path')
    p.add_argument('--at', required=True, type=float)
    p.add_argument('--out', required=True)
    p = sub.add_parser('clip')
    p.add_argument('path')
    p.add_argument('--start', required=True, type=float)
    p.add_argument('--end', required=True, type=float)
    p.add_argument('--max-duration', default=120, type=float)
    p.add_argument('--out', required=True)
    p = sub.add_parser('audio')
    p.add_argument('path')
    p.add_argument('--out', required=True)
    p = sub.add_parser('info')
    p.add_argument('url')
    p = sub.add_parser('fetch')
    p.add_argument('url')
    p.add_argument('--kind', required=True, choices=('audio', 'video', 'subs', 'thumbnail'))
    p.add_argument('--languages', default='en.*,ru.*', help='yt-dlp subtitle language patterns')
    args = parser.parse_args()
    try:
        if args.command == 'fetch':
            result = fetch(args.url, args.kind, args.languages)
        elif args.command == 'info':
            result = info(args.url)
        elif args.command == 'links':
            result = links(args.path)
        elif args.command == 'audio':
            result = audio(args.path, args.out)
        elif args.command == 'clip':
            result = clip(args.path, args.start, args.end, args.out, args.max_duration)
        elif args.command == 'screenshot':
            result = screenshot(args.path, args.at, args.out)
        elif args.command == 'frames':
            result = frames(args.path, args.interval, args.start, args.end,
                            args.max_frames, args.consent, args.out)
        else:
            result = plan(args.path, args.interval, args.start, args.end)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
