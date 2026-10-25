#!/usr/bin/python3
# ABOUTME: Передаёт отдельный read-only доступ Git только штатному запросу Git.
# ABOUTME: Не сохраняет credentials в URL, Git-config или журналах.
import json
import os
from pathlib import Path
import sys

value=json.loads((Path(os.environ['BRAI_INSTALL_ROOT'])/'inputs.json').read_text())
access=value.get('git',value.get('registry',{}))
key='username' if 'username' in sys.argv[1].lower() else 'token'
if key not in access:raise SystemExit(1)
print(access[key])
