# ABOUTME: Проверяет общие навыки, обязательный контекст и native TTS личного профиля.
# ABOUTME: Использует только временные данные и подставной broker без генерации или Telegram.
import hashlib
import json
import os
import shutil
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import instructions, images
from identity.skills import catalog_files
from identity import skills as system_skills
from identity.synthesize import synthesize_file
from identity.media import command as media_command
from identity.profiles import native_profile
from files import native
from files.tests.test_files import Backend


class SystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_system_policy_ignores_personal_path_and_disabled_overrides(self):
        aliases = {'common', 'creative/common'}
        utils = NS(get_disabled_skill_names=lambda platform=None: {'common', 'creative/common', 'private'},
                   is_disabled_entry=lambda entry, disabled: entry['name'] in disabled,
                   ESSENTIAL_SKILLS=frozenset({'hermes-agent'}))
        package = ModuleType('agent')
        package.skill_utils = utils
        with patch.dict(sys.modules, agent=package), patch.dict(os.environ, HERMES_HOME=str(self.root)), \
             patch.object(system_skills, 'protected_root'), patch.object(system_skills, 'install_personal_policy'), \
             patch.object(system_skills, 'system_aliases', side_effect=lambda value: set(aliases)):
            system_skills.install_policy()
            roots = utils.get_skill_search_roots(self.root / 'malicious')
            self.assertEqual(roots[0], (-2, system_skills.SYSTEM_SKILLS))
            self.assertEqual(roots[-1][1], self.root / 'usercustom/userdata/skills')
            self.assertNotIn(self.root / 'malicious', [path for _, path in roots])
            self.assertEqual(utils.get_skill_create_dir(), self.root / 'usercustom/userdata/skills')
            self.assertEqual(utils.get_disabled_skill_names(), {'private'})
            self.assertFalse(utils.is_disabled_entry({'root': system_skills.SYSTEM_SKILLS, 'name': 'common'}, {'common'}))
            self.assertTrue(utils.is_disabled_entry({'root': roots[-1][1], 'name': 'private'}, {'private'}))
            aliases.add('private')
            self.assertEqual(utils.get_disabled_skill_names(), set())

    def test_unprotected_system_root_is_rejected(self):
        self.root.chmod(0o777)
        with self.assertRaises(PermissionError):
            system_skills.protected_root(self.root)

    def test_shared_instruction_is_read_fresh_without_changing_base_instructions(self):
        base = self.root / 'base'
        shared = self.root / 'system-skills'
        for name in instructions.FILES:
            path = base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Base ' + name)
        skill = shared / instructions.SKILL
        skill.parent.mkdir(parents=True)
        skill.write_text('---\nname: context-gifs\n---\nFirst system text')
        self.assertIn('First system text', instructions.read_context(base, shared))
        skill.write_text('---\nname: context-gifs\n---\nUpdated system text')
        self.assertIn('Updated system text', instructions.read_context(base, shared))
        skill.unlink()
        with self.assertRaises(FileNotFoundError):
            instructions.read_context(base, shared)

    def test_same_process_reads_switched_generation_and_personal_files(self):
        root = self.root / 'stable'
        generations = root / '.generations'
        home = self.root / 'home'
        home.mkdir()
        (home / 'USER.md').write_text('личное')
        (home / 'SOUL.md').write_text('стиль')
        for ident, text in [('a' * 64, 'первое'),
                            ('b' * 64, 'второе')]:
            generation = generations / ident
            for name in instructions.FILES:
                path = generation / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text + name)
            skill = generation / 'skills' / instructions.SKILL
            skill.parent.mkdir(parents=True)
            skill.write_text('---\nname: context-gifs\n---\n' + text)
        current = root / 'current'
        current.symlink_to('.generations/' + 'a' * 64)
        original = Path.lstat
        def trusted(path):
            info = original(path)
            return NS(st_uid=0, st_mode=info.st_mode & ~0o022)
        with patch.object(instructions, 'ROOT', root), patch.object(Path, 'lstat', trusted), \
             patch.dict(os.environ, HERMES_HOME=str(home)):
            first = instructions.system_context()
            replacement = root / '.next'
            replacement.symlink_to('.generations/' + 'b' * 64)
            os.replace(replacement, current)
            second = instructions.system_context()
        self.assertIn('первоеcontext.md', first)
        self.assertIn('второеcontext.md', second)
        self.assertNotIn('первоеcontext.md', second)
        self.assertIn('личное', first)
        self.assertIn('личное', second)
        self.assertEqual((home / 'USER.md').read_text(), 'личное')
        self.assertEqual((home / 'SOUL.md').read_text(), 'стиль')

    def test_system_catalog_retains_bundled_assets_and_product_routes(self):
        bundled, product = self.root / 'bundled', self.root / 'instructions/skills'
        for root, relative, raw in [
            (bundled, 'creative/context-gifs/SKILL.md', b'---\nname: context-gifs\n---\nOld skill'),
            (bundled, 'research/arxiv/scripts/search.py', b'print("shared")'),
            (product, 'creative/context-gifs/SKILL.md', b'---\nname: context-gifs\n---\nCanonical skill'),
            (product, 'brai-task-workflows/SKILL.md', b'---\nname: brai-task-workflows\n---\nWorkflow'),
            (product, 'brai-task-workflows/references/work.md', b'Canonical reference'),
            (product, 'media/youtube-content/scripts/video_workflow.py', b'private downloads')]:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        files = catalog_files(bundled, product)
        self.assertEqual(files['research/arxiv/scripts/search.py'], b'print("shared")')
        self.assertIn(b'/opt/brai-profile/system-instructions/current/skills/creative/context-gifs/SKILL.md',
                      files['creative/context-gifs/SKILL.md'])
        self.assertNotIn(b'Old skill', files['creative/context-gifs/SKILL.md'])
        self.assertIn('brai-task-workflows/SKILL.md', files)
        self.assertEqual(files['brai-task-workflows/references/work.md'], b'Canonical reference')
        self.assertEqual(files['media/youtube-content/scripts/video_workflow.py'], b'private downloads')
        self.assertFalse(any('personal' in key for key in files))

    def test_catalog_rejects_links_to_personal_files(self):
        bundled, product = self.root / 'bundled', self.root / 'instructions'
        bundled.mkdir()
        product.mkdir()
        private = self.root / 'private'
        private.write_text('personal')
        (bundled / 'SKILL.md').symlink_to(private)
        with self.assertRaisesRegex(ValueError, 'SYSTEM_SKILL_LINK'):
            catalog_files(bundled, product)

    def test_mandatory_context_survives_deleted_personal_prompts(self):
        shared = self.root / 'shared'
        for relative in instructions.FILES:
            path = shared / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Required ' + relative)
        user = self.root / 'user'
        user.mkdir()
        for name in ['USER.md', 'SOUL.md']:
            path = user / name
            path.write_text('personal override')
            path.unlink()
        backend = Backend(self.root / 'cache')
        native.configure({'ownerId': 'owner', 'account': 'test',
            'stateRoot': str(self.root / 'state'), 'resultRoot': str(self.root / 'cache'),
            'readRoots': [str(user)]}, backend)
        agent = NS(session_id='personal', ephemeral_system_prompt='Personal preference')
        for _ in range(2):
            with patch.dict(os.environ, BRAI_IDENTITY_MODE='worker'), patch.object(
                    instructions, 'system_context', side_effect=lambda: instructions.read_context(shared)):
                with native.conversation(agent, 'hello'):
                    self.assertIn('Required context.md', agent.ephemeral_system_prompt)
                    self.assertIn('Required BASE.md', agent.ephemeral_system_prompt)
                    self.assertIn('Required BUG_HUNT.md', agent.ephemeral_system_prompt)
                    self.assertIn('Required INDEX.md', agent.ephemeral_system_prompt)
                    self.assertIn('Personal preference', agent.ephemeral_system_prompt)
            self.assertEqual(agent.ephemeral_system_prompt, 'Personal preference')
        (shared / 'context.md').unlink()
        with patch.dict(os.environ, BRAI_IDENTITY_MODE='worker'), patch.object(
                instructions, 'system_context', side_effect=lambda: instructions.read_context(shared)):
            with self.assertRaises(FileNotFoundError):
                with native.conversation(agent, 'hello'):
                    self.fail('Missing mandatory context must stop the turn')
        self.assertEqual(agent.ephemeral_system_prompt, 'Personal preference')

    def test_short_bug_hunt_reminder_is_loaded_without_the_detailed_guide(self):
        repository = Path(__file__).resolve().parents[4]
        source = repository / 'docs/user-agent/instructions'
        installed = self.root / 'installed'
        shutil.copytree(source / 'hermes', installed)
        shutil.copyfile(source / 'context.md', installed / 'context.md')
        protocol = (installed / 'BUG_HUNT.md').read_text()
        context = instructions.read_context(installed)
        self.assertEqual(context.count(protocol), 1)
        guide = json.loads((repository / 'services/bug-hunt/contracts/agent-guide.json').read_text())
        self.assertEqual(protocol.strip(), guide['reminder'])
        self.assertNotIn(guide['help'], context)
        self.assertLess(len(protocol), 150)
        self.assertIn('bug_hunt_help', context)
        self.assertNotIn('Пример входа', context)
        self.assertNotIn('evidence_artifact_ids', context)
        (installed / 'BUG_HUNT.md').unlink()
        with self.assertRaises(FileNotFoundError):
            instructions.read_context(installed)

    def test_personal_prompts_are_read_fresh_and_deletion_is_optional(self):
        first, second = self.root / 'first', self.root / 'second'
        first.mkdir()
        second.mkdir()
        (first / 'USER.md').write_text('Первый пользователь')
        (first / 'SOUL.md').write_text('Спокойный стиль')
        (second / 'USER.md').write_text('Второй пользователь')
        context = instructions.personal_context(first)
        self.assertIn('Первый пользователь', context)
        self.assertIn('Спокойный стиль', context)
        self.assertNotIn('Второй пользователь', context)
        (first / 'USER.md').write_text('Новые предпочтения')
        self.assertIn('Новые предпочтения', instructions.personal_context(first))
        self.assertNotIn('Первый пользователь', instructions.personal_context(first))
        (first / 'USER.md').unlink()
        (first / 'SOUL.md').write_text('')
        self.assertEqual(instructions.personal_context(first), '')

    def test_personal_prompts_reject_links_large_files_and_special_files(self):
        home = self.root / 'home'
        home.mkdir()
        source = self.root / 'other'
        source.write_text('Другой профиль')
        target = home / 'USER.md'
        target.symlink_to(source)
        with self.assertRaises(OSError):
            instructions.personal_context(home)
        target.unlink()
        os.link(source, target)
        with self.assertRaisesRegex(PermissionError, 'PERSONAL_PROMPT_UNTRUSTED'):
            instructions.personal_context(home)
        target.unlink()
        target.write_bytes(b'x' * 65537)
        with self.assertRaisesRegex(PermissionError, 'PERSONAL_PROMPT_UNTRUSTED'):
            instructions.personal_context(home)
        target.unlink()
        os.mkfifo(target)
        with self.assertRaisesRegex(PermissionError, 'PERSONAL_PROMPT_UNTRUSTED'):
            instructions.personal_context(home)
        with self.assertRaisesRegex(ValueError, 'PERSONAL_HOME_REQUIRED'):
            instructions.personal_context('relative')

    def test_media_launchers_use_sdk_and_only_personal_download_paths(self):
        argv = media_command('yt-dlp', ['-o', '/downloads/%(id)s.mp4', '--', 'https://youtu.be/x'],
                             home='/profiles/one', python='/sdk/python')
        self.assertEqual(argv[:6], ['/sdk/python', '-s', '-P', '-B', '-m', 'yt_dlp'])
        self.assertIn('--ignore-config', argv)
        self.assertIn('/profiles/one/workspace/downloads/%(id)s.mp4', argv)
        self.assertNotIn('/downloads/%(id)s.mp4', argv)
        self.assertEqual(media_command('instaloader', ['--help'], home='/profiles/two', python='/sdk/python'),
                         ['/sdk/python', '-s', '-P', '-B', '-m', 'instaloader', '--help'])
        with self.assertRaises(ValueError):
            media_command('other', [], home='/profiles/one', python='/sdk/python')

    def test_native_tts_uses_one_owner_bound_call_and_verifies_bytes(self):
        source, output, audio = self.root / 'text.txt', self.root / 'out.ogg', self.root / 'generated.ogg'
        source.write_text('Привет')
        raw = b'OggS voice bytes'
        audio.write_bytes(raw)
        calls = []
        def broker(method, params, **kwargs):
            calls.append((method, params))
            if method == 'tools.call':
                self.assertEqual(params, {'name': 'local_ai_invoke_synthesize', 'args': {'text': 'Привет'}})
                return {'audioArtifactId': 'owned'}
            return {'artifactId': 'owned', 'localPath': str(audio), 'mimeType': 'audio/ogg',
                    'sizeBytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        synthesize_file(str(source), str(output), call=broker)
        self.assertEqual(output.read_bytes(), raw)
        self.assertEqual([method for method, _ in calls], ['tools.call', 'files.fetch'])
        with self.assertRaisesRegex(ValueError, 'OUTPUT_EXISTS'):
            synthesize_file(str(source), str(output), call=broker)
        self.assertEqual(len(calls), 2)

    def test_native_tts_rejects_foreign_or_corrupt_artifact_without_output(self):
        source, output = self.root / 'text.txt', self.root / 'out.ogg'
        source.write_text('Привет')
        def broker(method, params, **kwargs):
            if method == 'tools.call':
                return {'audioArtifactId': 'owned'}
            return {'artifactId': 'foreign', 'mimeType': 'audio/ogg'}
        with self.assertRaisesRegex(ValueError, 'INVALID_AUDIO_ARTIFACT'):
            synthesize_file(str(source), str(output), call=broker)
        self.assertFalse(output.exists())

    def test_native_image_provider_receives_only_public_relay_binding(self):
        tool = ModuleType('tools.image_generation_tool')
        tool._get_plugin_provider = lambda name: NS()
        provider_module = NS(_read_codex_credential=lambda: self.fail('Shared credential read in worker'))
        with patch.dict(sys.modules, {'tools.image_generation_tool': tool}), patch.object(
                images.importlib, 'import_module', return_value=provider_module):
            images.install_shared_provider()
        token, endpoint = provider_module._read_codex_credential()
        self.assertEqual(token, 'profile-image-proxy-not-a-secret')
        self.assertEqual(endpoint, 'http://127.0.0.1:18080/image')

    def test_native_profile_separates_system_and_personal_skills_and_routes_tts(self):
        profile = {'home': '/profiles/one'}
        config = native_profile(profile, instructions_root='/opt/brai-profile/runtime', model='model')
        self.assertTrue(config['streaming']['enabled'])
        self.assertTrue(config['display']['platforms']['telegram']['streaming'])
        self.assertTrue(config['display']['platforms']['telegram']['interim_assistant_messages'])
        self.assertEqual(config['skills']['external_dirs'], ['/opt/brai-profile/system-skills/skills', '/opt/brai-profile/skills'])
        self.assertEqual(config['skills']['create_dir'], '/profiles/one/usercustom/userdata/skills')
        provider = config['tts']['providers']['silero']
        self.assertIn('-m identity.synthesize', provider['command'])
        self.assertNotIn('key', provider)
        self.assertIs(provider['voice_compatible'], True)
