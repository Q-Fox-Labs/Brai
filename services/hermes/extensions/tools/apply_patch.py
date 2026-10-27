"""Apply a local source change once; refuse incompatible source trees."""
import json
from pathlib import Path
import subprocess
import sys

root, patch = map(Path, sys.argv[1:])
def git(*args, check=False):
    return subprocess.run(['git', 'apply', *args, str(patch)], cwd=root,
                          capture_output=True, text=True, check=check)
if git('--reverse', '--check').returncode == 0:
    print(json.dumps({'changed': False}))
else:
    git('--check', check=True)
    git(check=True)
    print(json.dumps({'changed': True}))
