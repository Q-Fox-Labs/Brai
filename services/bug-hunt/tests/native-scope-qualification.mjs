// ABOUTME: Читает authoritative MCP inventory только собственного ограниченного native thread.
// ABOUTME: Не вызывает inference, ресурсы MCP, login или новые профили; архивирует свой thread.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {nativeRpc,nativeThreadConfig} from "../dist/verification-models.js";
const root=new URL("../../../tmp/",import.meta.url).pathname;
test("existing Codex request-local MCP inventory",{timeout:60000},async()=>{
 await mkdir(root,{recursive:true});
 const rpc=nativeRpc({socketUrl:"ws+unix:///home/agent/.codex/app-server-control/app-server-control.sock:/"},error=>console.log(JSON.stringify({qualification_rpc_error:error})));let threadId;
 try{
  await rpc.connect();await rpc.call("initialize",{clientInfo:{name:"brai_bug_hunt_scope_qualification",version:"3.0.0"},capabilities:{experimentalApi:true}});rpc.send({method:"initialized",params:{}});
  const cfg=await rpc.call("config/read",{cwd:root,includeLayers:false});
  const names=Object.keys(cfg.config?.mcp_servers??{});
  const pluginNames=Object.keys(cfg.config?.plugins??{});console.log(JSON.stringify({pluginNames}));
  const config={...nativeThreadConfig(names),"orchestrator.mcp.enabled":false,"features.code_mode_only":false,...Object.fromEntries(pluginNames.map(name=>["plugins."+JSON.stringify(name)+".enabled",false]))};
  await writeFile(root+"native-scope-intent.json",JSON.stringify({stage:"dispatching",disabled_servers:names}),{mode:0o600});
  const own=await rpc.call("thread/start",{model:"gpt-6.1-sol",allowProviderModelFallback:false,cwd:root,ephemeral:false,sandbox:"read-only",approvalPolicy:"never",baseInstructions:"Synthetic metadata qualification. No inference or external actions are requested.",developerInstructions:"",selectedCapabilityRoots:[],environments:[],dynamicTools:[],config});
  threadId=own.thread.id;await writeFile(root+"native-scope-intent.json",JSON.stringify({stage:"ack",threadId,disabled_servers:names}),{mode:0o600});
  const status=await rpc.call("mcpServerStatus/list",{threadId,limit:100,detail:"full"},40000);
  const inventory=status.data.map(s=>({name:s.name,keys:Object.keys(s),runtimeStatus:s.runtimeStatus,pluginId:s.pluginId,tools:Object.keys(s.tools??{}).length,resources:(s.resources??[]).length}));
  const models=await rpc.call("model/list",{limit:10});const model=models.data.find(m=>m.id==="gpt-6.1-sol");
  console.log(JSON.stringify({threadId,sandbox:own.sandbox,inventory,selected_model_keys:Object.keys(model??{}),tool_mode:model?.tool_mode??model?.toolMode??null}));
  await writeFile(root+"native-scope-inventory.json",JSON.stringify({threadId,sandbox:own.sandbox,inventory}),{mode:0o600});
  assert.equal(own.sandbox.type,"readOnly");
 }finally{if(threadId)await rpc.call("thread/archive",{threadId}).catch(()=>{});rpc.close();}
});
