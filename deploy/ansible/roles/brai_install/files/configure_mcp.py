#!/usr/bin/python3
# ABOUTME: Подключает три продуктовых MCP через общий переносимый lifecycle launcher.
# ABOUTME: Сохраняет чужие настройки и принимает семантически тот же блок при повторе.
import json
import os
from pathlib import Path
import pwd
import sys
import tempfile
import tomllib
from mcp_config import normalize


def render(table,prefix):
    """Сериализовать продуктовую MCP-таблицу в TOML без интерполяции строк."""
    lines=['['+'.'.join(json.dumps(k) for k in prefix)+']']
    for key,value in table.items():
        if isinstance(value,dict):continue
        if not isinstance(value,(str,bool,int,float,list)):raise ValueError('MCP_SETTING_INVALID')
        lines.append(json.dumps(key)+' = '+json.dumps(value,ensure_ascii=False))
    for key,value in table.items():
        if isinstance(value,dict):lines.extend(render(value,[*prefix,key]))
    return lines


def configure(inputs_path=Path('/var/lib/brai-install/inputs.json'),path=Path('/home/agent/.codex/config.toml'),identity=None):
    """Атомарно добавить свой блок или проверить его семантику; чужие серверы не заменять."""
    servers=normalize(json.loads(inputs_path.read_text()).get('mcp_servers',{}))
    begin,end='# BEGIN CLEAN INSTALL PRODUCT MCP','# END CLEAN INSTALL PRODUCT MCP'
    if any(p.is_symlink() for p in [path,*path.parents]):raise ValueError('MCP_CONFIG_SYMLINK')
    original=path.read_text() if path.exists() else ''
    block=begin+'\n'+'\n'.join(line for name,cfg in servers.items() for line in render(cfg,['mcp_servers',name]))+'\n'+end
    if begin in original:
        if original.count(begin)!=1 or original.count(end)!=1:raise ValueError('MCP_EXISTING_SETTING_CHANGED')
        current=original[original.index(begin):original.index(end)+len(end)]
        if normalize(tomllib.loads(current).get('mcp_servers',{}))!=servers:raise ValueError('MCP_EXISTING_SETTING_CHANGED')
        return False
    parsed=tomllib.loads(original)
    if set(servers)&set(parsed.get('mcp_servers',{})):raise ValueError('MCP_EXISTING_SERVER_CONFLICT')
    updated=original.rstrip()+'\n\n'+block+'\n'
    tomllib.loads(updated)
    identity=identity or pwd.getpwnam('agent')
    fd,name=tempfile.mkstemp(prefix='.brai-mcp-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as stream:
            stream.write(updated);stream.flush();os.fsync(stream.fileno());os.fchmod(stream.fileno(),0o600)
            os.fchown(stream.fileno(),identity.pw_uid,identity.pw_gid)
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
    return True


if __name__=='__main__':
    try:print('INSTALL_PRODUCT_MCP_CHANGED' if configure() else 'INSTALL_PRODUCT_MCP_CHECKED')
    except Exception:
        print('INSTALL_PRODUCT_MCP_FAILED',file=sys.stderr);raise SystemExit(1)
