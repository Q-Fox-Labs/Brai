# ABOUTME: Запускает только synthetic Root UDS fixture и проверяет непустой результат.
# ABOUTME: Skip или другое количество тестов не принимается как доказательство.
import os
from pathlib import Path
import re
import subprocess
import sys


def require_one(returncode, stderr):
    if (returncode != 0 or not isinstance(stderr,str) or 'skipped' in stderr.lower()
            or len(re.findall(r'^Ran 1 test in [^\n]+$',stderr,re.MULTILINE)) != 1
            or len(re.findall(r'^OK$',stderr,re.MULTILINE)) != 1):
        raise RuntimeError('ROOT_UDS_PROOF_UNCONFIRMED')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('ROOT_UDS_PROOF_REQUIRES_ROOT')
    result=subprocess.run([sys.executable,'-B','-m','unittest','discover','-v',
                           '-s',str(Path(__file__).resolve().parent),'-p','test_ordinary_uds_root.py'],
                          text=True,capture_output=True)
    try:
        require_one(result.returncode,result.stderr)
    except RuntimeError:
        sys.stderr.write(result.stderr)
        raise
    sys.stdout.write('ROOT_UDS_PROOF_OK\n')


if __name__ == '__main__':
    main()
