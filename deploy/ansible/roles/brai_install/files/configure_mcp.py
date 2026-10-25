#!/usr/bin/python3
# ABOUTME: Подключает только три продуктовых MCP из отдельного защищённого входа.
# ABOUTME: Сохраняет настройки остальных инструментов и не переносит личные инструкции.
import json
import os
from pathlib import Path
import pwd
import sys
import tomllib


def render(table, prefix):
    lines = ['['+'.'.join(json.dumps(k) for k in prefix)+']']
    for key,value in table.items():
        if isinstance(value,dict): continue
        if not isinstance(value,(str,bool,int,float,list)): raise ValueError('MCP_SETTING_INVALID')
        lines.append(json.dumps(key)+' = '+json.dumps(value,ensure_ascii=False))
    for key,value in table.items():
        if isinstance(value,dict): lines.extend(render(value,[*prefix,key]))
    return lines


def configure():
    servers=json.loads(Path('/var/lib/brai-install/inputs.json').read_text()).get('mcp_servers',{})
    if set(servers)-{'brai_results','brai_history','brai_supabase'}: raise ValueError('MCP_NAME_INVALID')
    begin,end='# BEGIN CLEAN INSTALL PRODUCT MCP','# END CLEAN INSTALL PRODUCT MCP'
    path=Path('/home/agent/.codex/config.toml')
    if path.is_symlink(): raise ValueError('MCP_CONFIG_SYMLINK')
    original=path.read_text() if path.exists() else ''
    block=begin+'\n'+'\n'.join(line for name,cfg in servers.items() for line in render(cfg,['mcp_servers',name]))+'\n'+end
    if begin in original:
        current=original[original.index(begin):original.index(end)+len(end)]
        if current!=block: raise ValueError('MCP_EXISTING_SETTING_CHANGED')
        return False
    parsed=tomllib.loads(original)
    if set(servers)&set(parsed.get('mcp_servers',{})): raise ValueError('MCP_EXISTING_SERVER_CONFLICT')
    updated=original.rstrip()+'\n\n'+block+'\n'
    tomllib.loads(updated)
    fd=os.open(path,os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW|os.O_CREAT,0o600)
    with os.fdopen(fd,'w') as stream: stream.write(updated)
    identity=pwd.getpwnam('agent'); os.chown(path,identity.pw_uid,identity.pw_gid);os.chmod(path,0o600)
    return True


if __name__=='__main__':
    try: print('INSTALL_PRODUCT_MCP_CHANGED' if configure() else 'INSTALL_PRODUCT_MCP_CHECKED')
    except Exception:
        print('INSTALL_PRODUCT_MCP_FAILED',file=sys.stderr)
        raise SystemExit(1)
