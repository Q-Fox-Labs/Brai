# ABOUTME: Принимает первую установку и безопасное административное дополнение.
# ABOUTME: Сохраняет прежние inputs и отказывает при изменении уже принятого продукта.
import hashlib
import base64
import json
import os
from pathlib import Path
import stat
import sys


def compatible_file(path, previous, current):
    """Разрешить только добавление административных проектов и корней чтения."""
    if previous == current:return True
    field={'/etc/brai-agent/config.json':'projects','/etc/brai-agent/publisher.json':'allowedReadRoots'}.get(path)
    if not field or {k:v for k,v in previous.items() if k!='content'}!={k:v for k,v in current.items() if k!='content'}:return False
    old=json.loads(base64.b64decode(previous['content']));new=json.loads(base64.b64decode(current['content']))
    old_items=old.pop(field);new_items=new.pop(field)
    return old==new and all(item in new_items for item in old_items)


def has_unowned_runtime():
    """Обнаружить существующий runtime, который первая установка не вправе присвоить."""
    return any(Path(p).exists() for p in ['/opt/supabase/deployment/volumes/db/data/PG_VERSION','/etc/brai-dev/codeworks/normal-enabled'])


def prepare(root, manifest, inputs, administrative=False):
    """Записать входы после сверки владельца; несовместимый повтор не меняет файлы."""
    from partition import encoded, product
    digest=hashlib.sha256(encoded(manifest)).hexdigest()
    if inputs.get('manifest_sha256') != digest:raise ValueError('INPUT_MANIFEST_MISMATCH')
    if any(p.is_symlink() for p in [root,*root.parents]):raise ValueError('UNSAFE_CONTROL_DIRECTORY')
    if any((root/name).is_symlink() for name in ['owner.json','baseline.json','inputs.json']):raise ValueError('UNSAFE_CONTROL_FILE')
    marker=root/'owner.json'
    if marker.exists():
        old_bytes=(root/'baseline.json').read_bytes()
        old=json.loads(old_bytes);previous=json.loads((root/'inputs.json').read_text())
        if json.loads(marker.read_text())!={'format':'brai-clean-install-owner-v1','manifest':hashlib.sha256(old_bytes).hexdigest()}:raise ValueError('OWNER_MISMATCH')
        if old != manifest:
            if not administrative or old.get('scope')!='product' or product(manifest)!=old:raise ValueError('INSTALLED_PRODUCT_MISMATCH')
            for path, value in previous.get('files',{}).items():
                if not compatible_file(path,value,inputs.get('files',{}).get(path,{})):raise ValueError('INSTALLED_PRODUCT_INPUT_CHANGED')
            for section in ['environments','program_environment']:
                if any(inputs.get(section,{}).get(k)!=v for k,v in previous.get(section,{}).items()):raise ValueError('INSTALLED_PRODUCT_INPUT_CHANGED')
            for section in ['provision','registry','git','hf_token','mcp_servers']:
                if section in previous and inputs.get(section)!=previous[section]:raise ValueError('INSTALLED_PRODUCT_INPUT_CHANGED')
            if any(role not in inputs.get('roles',[]) for role in previous.get('roles',[])):raise ValueError('INSTALLED_PRODUCT_INPUT_CHANGED')
        elif previous!=inputs:raise ValueError('RESUMED_INPUT_CHANGED')
    else:
        if has_unowned_runtime():raise ValueError('UNOWNED_SERVER')
        if root.exists() and any(root.iterdir()):raise ValueError('UNOWNED_CONTROL_DIRECTORY')
    root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
    for name,value in [('baseline.json',manifest),('inputs.json',inputs),('owner.json',{'format':'brai-clean-install-owner-v1','manifest':digest})]:
        path=root/name
        data=encoded(value)
        if path.exists() and path.read_bytes()==data and stat.S_IMODE(path.stat().st_mode)==0o600:continue
        temp=root/(name+'.new')
        fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.replace(temp,path)


if __name__=='__main__':
    try:
        value=json.load(sys.stdin)
        prepare(Path(value['root']),value['manifest'],value['inputs'],value.get('administrative',False))
        print('INSTALL_INPUTS_ACCEPTED')
    except Exception:
        print('INSTALL_INPUTS_REJECTED',file=sys.stderr);raise SystemExit(1)
