"""Stdlib CLI tests; real local FFmpeg fixture, no network by default."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('video_workflow.py')

class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        cls.root = Path(cls.temp.name)
        cls.video = cls.root / 'fixture.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                        'testsrc=size=1280x720:rate=10', '-f', 'lavfi', '-i',
                        'sine=frequency=440:sample_rate=48000', '-t', '3',
                        '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
                        str(cls.video)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def cli(self, *args, ok=True):
        p = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                           capture_output=True, text=True)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)
        self.assertNotEqual(p.returncode, 0)
        return p

    def module(self):
        spec = importlib.util.spec_from_file_location('workflow', SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_links_deduplicate_youtube_only(self):
        source = self.root / 'links.md'
        source.write_text('[a](https://youtu.be/abcdefghijk) https://youtu.be/abcdefghijk\n'
                          '<a href="https://www.youtube.com/watch?v=ABCDEFGHIJK&amp;t=4">x</a> '
                          'https://evil.example/a https://youtube.com.evil/watch?v=abc')
        result = self.cli('links', source)
        self.assertEqual(result['links'], ['https://youtu.be/abcdefghijk',
                         'https://www.youtube.com/watch?v=ABCDEFGHIJK&t=4'])

    def test_plan_exact_timestamps_and_finite_bounds(self):
        result = self.cli('plan', self.video, '--interval', '0.7', '--start', '0.2', '--end', '2.4')
        self.assertEqual(result['timestamps'], [0.2, 0.9, 1.6, 2.3])
        self.assertEqual(result['count'], 4)
        for flags in [('--interval', '0'), ('--interval', 'nan'), ('--end', '4'),
                      ('--start', '-1'), ('--start', '2', '--end', '1')]:
            p = self.cli('plan', self.video, *flags, ok=False)
            self.assertNotIn('Traceback', p.stderr)

    def test_frames_consent_limit_manifest_and_dimensions(self):
        out = self.root / 'frames'
        p = self.cli('frames', self.video, '--interval', '1', '--out', out, ok=False)
        self.assertIn('consent', p.stderr.lower())
        self.assertFalse(out.exists())
        p = self.cli('frames', self.video, '--interval', '0.01', '--consent', '--out', out, ok=False)
        self.assertIn('limit', p.stderr.lower())
        self.assertFalse(out.exists())
        result = self.cli('frames', self.video, '--interval', '1', '--start', '0.2',
                          '--end', '2.5', '--consent', '--out', out)
        manifest = json.loads((out / 'manifest.json').read_text())
        self.assertEqual(manifest['timestamps'], [0.2, 1.2, 2.2])
        self.assertEqual(result['count'], len(list(out.glob('*.jpg'))))
        for frame in manifest['frames']:
            self.assertTrue((out / frame['file']).is_file())
            data = self.module().probe(out / frame['file'])
            self.assertLessEqual(data['streams'][0]['width'], 960)
        p = self.cli('frames', self.video, '--interval', '1', '--consent', '--out', out, ok=False)
        self.assertNotIn('Traceback', p.stderr)

    def test_screenshot_single_jpeg_nonoverwrite_and_bounds(self):
        out = self.root / 'screenshot.jpg'
        result = self.cli('screenshot', self.video, '--at', '1.1', '--out', out)
        self.assertEqual(result['timestamp'], 1.1)
        stream = self.module().probe(out)['streams'][0]
        self.assertEqual(stream['codec_name'], 'mjpeg')
        self.assertLessEqual(stream['width'], 960)
        for at in ('3', '-1', 'inf'):
            self.cli('screenshot', self.video, '--at', at, '--out', self.root / 'bad.jpg', ok=False)
        self.cli('screenshot', self.video, '--at', '1', '--out', out, ok=False)

    def test_clip_reencodes_exact_window_and_enforces_limit(self):
        out = self.root / 'clip.mp4'
        result = self.cli('clip', self.video, '--start', '0.5', '--end', '1.7', '--out', out)
        data = self.module().probe(out)
        self.assertAlmostEqual(float(data['format']['duration']), 1.2, delta=0.15)
        self.assertEqual(result['start'], 0.5)
        self.cli('clip', self.video, '--start', '0', '--end', '3',
                 '--max-duration', '1', '--out', self.root / 'too-long.mp4', ok=False)
        self.assertFalse((self.root / 'too-long.mp4').exists())
        self.cli('clip', self.video, '--start', '1', '--end', '1', '--out', out, ok=False)
        self.cli('clip', self.video, '--start', '0', '--end', '1', '--out', out, ok=False)

    def test_audio_wav_is_mono_16k_and_nonoverwriting(self):
        import wave
        out = self.root / 'audio.wav'
        self.cli('audio', self.video, '--out', out)
        with wave.open(str(out)) as wav:
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getframerate(), 16000)
            self.assertAlmostEqual(wav.getnframes() / 16000, 3, delta=0.1)
        self.cli('audio', self.video, '--out', out, ok=False)

    def test_info_compact_metadata_safe_url_and_no_download(self):
        mod = self.module()
        self.assertTrue(hasattr(mod, 'info'), 'Metadata info behavior missing')
        raw = {'id': 'abcdefghijk', 'title': 't'*700, 'description': 'd'*30000,
               'duration': 12, 'uploader': 'Alice', 'chapters': [
                   {'start_time': 0, 'end_time': 12, 'title': 'Intro'}],
               'subtitles': {'en': [{'url': 'secret-format-url'}]},
               'automatic_captions': {'ru': [{'url': 'secret-format-url'}]},
               'formats': [{'url': 'secret-format-url'}], 'live_status': 'not_live'}
        calls = []
        def fake(argv, timeout=120):
            calls.append(argv)
            return json.dumps(raw)
        with patch.object(mod, 'run_command', fake):
            result = mod.info('https://youtu.be/abcdefghijk')
            self.assertEqual(result['subtitle_languages'], ['en'])
            self.assertEqual(result['automatic_caption_languages'], ['ru'])
            self.assertEqual(result['chapters'][0]['title'], 'Intro')
            self.assertLess(len(json.dumps(result)), 20000)
            self.assertNotIn('secret-format-url', json.dumps(result))
            argv = calls[0]
            for flag in ('--ignore-config', '--no-playlist', '--no-exec', '--no-live-from-start', '--skip-download'):
                self.assertIn(flag, argv)
            before = len(calls)
            for url in ('file:///etc/passwd', 'http://youtu.be/abcdefghijk',
                        'https://youtube.com.evil/watch?v=abc', 'https://user@youtube.com/watch?v=abc',
                        'https://127.0.0.1/video'):
                with self.assertRaises(ValueError):
                    mod.info(url)
            self.assertEqual(len(calls), before)

    def test_fetch_unique_container_paths_and_bounded_formats(self):
        mod = self.module()
        self.assertTrue(hasattr(mod, 'fetch'), 'Fetch behavior missing')
        root = self.root / 'downloads'
        calls = []
        def fake(argv, timeout=120):
            calls.append(argv)
            template = argv[argv.index('-o')+1]
            relative = Path(template).relative_to('/downloads')
            host = root / relative
            host = Path(str(host).replace('%(id)s', 'abcdefghijk').replace('%(ext)s', 'm4a'))
            host.parent.mkdir(parents=True, exist_ok=True)
            host.write_bytes(b'test mocked transport only')
            return ''
        with patch.object(mod, 'DOWNLOAD_ROOT', root), patch.object(mod, 'info', return_value={'live_status': 'not_live'}), patch.object(mod, 'run_command', fake):
            audio = mod.fetch('https://youtu.be/abcdefghijk', 'audio')
            video = mod.fetch('https://youtu.be/abcdefghijk', 'video')
            self.assertNotEqual(audio['job_dir'], video['job_dir'])
            self.assertTrue(all(Path(p).is_file() for p in audio['files']))
            for argv in calls:
                self.assertIn('--no-exec', argv)
                self.assertIn('--ignore-config', argv)
                self.assertNotIn(str(root), ' '.join(argv))
            self.assertIn('height<=720', calls[1][calls[1].index('-f')+1])
            mod.fetch('https://youtu.be/abcdefghijk', 'subs')
            self.assertIn('--skip-download', calls[-1])
            self.assertIn('--write-auto-subs', calls[-1])
            mod.fetch('https://youtu.be/abcdefghijk', 'thumbnail')
            self.assertIn('--write-thumbnail', calls[-1])
        with patch.object(mod, 'DOWNLOAD_ROOT', root), patch.object(mod, 'info', return_value={'live_status': 'is_live'}):
            before = len(list(root.iterdir()))
            with self.assertRaises(ValueError):
                mod.fetch('https://youtu.be/abcdefghijk', 'video')
            self.assertEqual(len(list(root.iterdir())), before)
        with self.assertRaises(ValueError):
            mod.fetch('file:///etc/passwd', 'audio')

    def test_single_jpeg_rejects_misleading_output_suffix(self):
        p = self.cli('screenshot', self.video, '--at', '1', '--out', self.root / 'not-jpeg.png', ok=False)
        self.assertIn('jpg', p.stderr.lower())

    def test_audio_rejects_misleading_output_suffix(self):
        p = self.cli('audio', self.video, '--out', self.root / 'not-wav.mp3', ok=False)
        self.assertIn('wav', p.stderr.lower())

    def test_links_trim_plain_text_punctuation_and_csv(self):
        source = self.root / 'punctuation.csv'
        source.write_text('url,notes\nhttps://youtu.be/abcdefghijk,first\n'
                          'See https://www.youtube.com/watch?v=ABCDEFGHIJK.\n')
        result = self.cli('links', source)
        self.assertEqual(result['links'], ['https://youtu.be/abcdefghijk',
                         'https://www.youtube.com/watch?v=ABCDEFGHIJK'])

if __name__ == '__main__':
    unittest.main()
