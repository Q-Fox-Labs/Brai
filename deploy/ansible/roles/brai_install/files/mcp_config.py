# ABOUTME: Приводит продуктовые MCP к переносимым штатным launcher-командам.
# ABOUTME: Не запускает процессы, не читает файлы и не меняет credentials.
import copy
import re

PROXY='/usr/local/libexec/mcp-idle-proxy'
PUBLISHER='/opt/brai-codeworks/prod-agent/services/agent/dist/publisher-mcp.js'
PREFIX=['--policy','stateless','--idle-seconds','60','--','/usr/local/bin/node']


def normalize(servers):
    """Вернуть настройки трёх продуктовых MCP, сохранив env, URL и полномочия."""
    if set(servers)-{'brai_results','brai_history','brai_supabase'}:raise ValueError('MCP_NAME_INVALID')
    result=copy.deepcopy(servers)
    cfg=result.get('brai_results')
    if not cfg or cfg.get('enabled') is False:return result
    command,args=cfg.get('command'),cfg.get('args',[])
    if command==PROXY:
        if args[:6]!=PREFIX:raise ValueError('MCP_LAUNCHER_INVALID')
        command,args=args[5],args[6:]
    if command!='/usr/local/bin/node' or len(args)!=1:raise ValueError('MCP_BACKEND_INVALID')
    if args[0]!=PUBLISHER and not re.fullmatch(r'/opt/brai-agent/releases/[0-9a-f]{40}/services/agent/dist/publisher-mcp\.js',args[0]):raise ValueError('MCP_BACKEND_INVALID')
    cfg['command']=PROXY;cfg['args']=[*PREFIX,PUBLISHER]
    return result
