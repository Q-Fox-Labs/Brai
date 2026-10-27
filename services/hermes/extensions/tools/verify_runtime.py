#!/usr/bin/env python3
# ABOUTME: Поддерживает надстройку hermescustom и её проверки.
# ABOUTME: Реализует поведение пакета для профиля Hermes.
"""Check native SOUL file-reading instructions without invoking a model."""
import argparse
import os
from pathlib import Path
import sys
from types import SimpleNamespace


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile-dir', required=True)
    parser.add_argument('--hermes-root', required=True)
    parser.add_argument('--instructions-root', type=Path, default=Path(__file__).resolve().parents[4] / 'docs/user-agent/instructions/hermes')
    args = parser.parse_args()
    home = Path(args.profile_dir).expanduser().resolve()
    instructions = args.instructions_root.expanduser().resolve()
    os.environ['HERMES_HOME'] = str(home)
    sys.path.insert(0, str(Path(args.hermes_root).expanduser().resolve()))
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from agent.system_prompt import _identity_parts, _frozen_plugin_prompt_sections

    token = set_hermes_home_override(home)
    try:
        agent = SimpleNamespace(load_soul_identity=True, skip_context_files=False,
                                _session_db=SimpleNamespace(db_path=home / 'state.db'),
                                session_id='hermescustom-readiness', model='', provider='', platform='cli')
        soul_parts, loaded = _identity_parts(agent, None)
        soul = '\n'.join(soul_parts)
        if not loaded:
            raise ValueError('SOUL.md не загружен')
        for path in (instructions / 'INDEX.md', instructions / 'BASE.md',
                     home / 'usercustom/userdata/instructions/ROUTING.md'):
            if str(path) not in soul:
                raise ValueError(f'SOUL.md не требует чтения {path}')
            content = path.read_text(encoding='utf-8')
            if path.name != 'ROUTING.md' and not content.strip():
                raise ValueError(f'Обязательная административная инструкция пуста: {path}')
        if 'до конца' not in soul or 'оставшиеся части' not in soul:
            raise ValueError('SOUL.md не требует полного чтения с дочитыванием обрезанного вывода')
        from agent.skill_utils import get_skill_create_dir, get_all_skills_dirs
        personal = home / 'usercustom/userdata/skills'
        if get_skill_create_dir() != personal or personal not in get_all_skills_dirs():
            raise ValueError('Личные навыки userdata/skills не подключены штатной настройкой')
        sections = _frozen_plugin_prompt_sections(agent)
        retired = {'docshermes.runtime-index', 'docshermes.base-policy', 'docshermes.user-instructions'}
        if any(section.id in retired for section in sections):
            raise ValueError('Автоматическая вставка инструкций всё ещё включена')
        print('Проверено: SOUL.md требует полностью прочитать INDEX.md, BASE.md и ROUTING.md; файлы доступны, автоматические секции отсутствуют.')
        print('Проверка не вызывает модель. Реальное чтение инструментами подтверждается отдельно в новой сессии.')
    finally:
        reset_hermes_home_override(token)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, ImportError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
