// ABOUTME: Читает безопасную metadata существующего серверного Codex без нового профиля.
// ABOUTME: Не создаёт thread/turn, не читает credentials и не меняет конфигурацию.
import test from "node:test";
import {nativeRpc} from "../dist/verification-models.js";
test("inspect existing native daemon metadata only",{timeout:15000},async()=>{
 const rpc=nativeRpc({socketUrl:"ws+unix:///home/agent/.codex/app-server-control/app-server-control.sock:/"});
 try{
  await rpc.connect();const initialized=await rpc.call("initialize",{clientInfo:{name:"brai_bug_hunt_inspect",version:"3.0.0"},capabilities:{experimentalApi:true}});rpc.send({method:"initialized",params:{}});
  const account=await rpc.call("account/read",{refreshToken:false});
  const config=await rpc.call("config/read",{cwd:"/srv/projects/brai-dev",includeLayers:false});
  const profiles=await rpc.call("permissionProfile/list",{cwd:"/srv/projects/brai-dev",limit:100});
  const servers=await rpc.call("mcpServerStatus/list",{limit:100});
  console.log(JSON.stringify({config_keys:Object.keys(config.config),configured_mcp_servers:Object.keys(config.config?.mcp_servers??{}),servers:servers.data.map(s=>({name:s.name,tools:Object.keys(s.tools??{})})),userAgent:initialized.userAgent,authenticated:!!account.account,default_permissions:config.config?.default_permissions,sandbox_mode:config.config?.sandbox_mode,permissions:config.config?.permissions,permissionProfiles:profiles.data}));
 }finally{rpc.close();}
});
