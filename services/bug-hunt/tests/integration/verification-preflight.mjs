// ABOUTME: Проверяет установленный протокол Codex и физическую границу runner до подключения моделей.
// ABOUTME: Использует только собственный tmp; не читает auth и не создаёт thread или turn.
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
const root=fileURLToPath(new URL("../../../../",import.meta.url));
test("v3 source compiles with the prepared dependency set",()=>{
 execFileSync(process.execPath,[path.join(root,"node_modules/typescript/bin/tsc"),"-p",path.join(root,"services/bug-hunt/tsconfig.json"),"--noEmit"],{cwd:root,stdio:"inherit"});
});
test("installed app-server exports dynamic tool and recovery schemas",()=>{
 mkdirSync(path.join(root,"tmp"),{recursive:true});
 const temporary=mkdtempSync(path.join(root,"tmp/bug-hunt-native-"));
 try{
  const home=path.join(temporary,"home");mkdirSync(home);
  const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:home};
  execFileSync("codex",["app-server","generate-json-schema","--experimental","--out",path.join(temporary,"schema")],{cwd:temporary,env,timeout:30000,stdio:"pipe"});
  const names=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".json"))names.push(p);}}walk(path.join(temporary,"schema"));
  const all=names.map(p=>readFileSync(p,"utf8")).join("\n");
  for(const fragment of ["dynamicTools","thread/start","thread/read","turn/start","turn/interrupt","item/tool/call"])assert.ok(all.includes(fragment),fragment);
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
test("runner can create its own network and mount namespace",()=>{
 execFileSync("/usr/bin/bwrap",["--unshare-all","--die-with-parent","--new-session","--clearenv","--ro-bind","/usr","/usr","--ro-bind","/lib","/lib","--ro-bind","/lib64","/lib64","--proc","/proc","--dev","/dev","--tmpfs","/tmp","/usr/bin/true"],{timeout:5000,stdio:"pipe"});
});
