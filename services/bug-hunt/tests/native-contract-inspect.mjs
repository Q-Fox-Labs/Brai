// ABOUTME: Извлекает публичные sandbox/permission типы установленного Codex для проверки совместимости.
// ABOUTME: Использует пустой временный HOME; auth, модель и пользовательские чаты не читаются.
import test from "node:test";
import {execFileSync} from "node:child_process";
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {createHash} from "node:crypto";
const root=fileURLToPath(new URL("../../../",import.meta.url));
test("inspect installed permission contract without inference",()=>{
 mkdirSync(path.join(root,"tmp"),{recursive:true});const temp=mkdtempSync(path.join(root,"tmp/native-contract-"));mkdirSync(path.join(temp,"home"));
 try{
  execFileSync("codex",["app-server","generate-json-schema","--experimental","--out",path.join(temp,"schema")],{env:{PATH:process.env.PATH,HOME:path.join(temp,"home"),CODEX_HOME:path.join(temp,"home")},timeout:30000,stdio:"pipe"});
  const files=[];function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isDirectory())walk(p);else if(p.endsWith(".json"))files.push(p);}}walk(path.join(temp,"schema"));
  const defs={};for(const file of files){const data=JSON.parse(readFileSync(file,"utf8"));Object.assign(defs,data.definitions??{},data.$defs??{});if(data.title)defs[data.title]=data;}
  const selected=Object.fromEntries(Object.entries(defs).filter(([key])=>/^(ThreadStartParams|TurnStartParams|SandboxPolicy|ReadOnlyAccess|PermissionProfile|FileSystemSandbox|FileSystemAccess|FileSystemPermissions|FileSystemPath|FileSystemSpecialPath|FileSystemSandboxPolicy|PermissionProfileDetails)/.test(key)));
  const raw=JSON.stringify(selected,null,2);writeFileSync(path.join(root,"tmp/bug-hunt-native-permissions.json"),raw);
  console.log(JSON.stringify({sha256:createHash("sha256").update(raw).digest("hex"),types:Object.keys(selected),threadStartProperties:Object.keys(defs.ThreadStartParams?.properties??{}),turnStartProperties:Object.keys(defs.TurnStartParams?.properties??{})}));
 }finally{rmSync(temp,{recursive:true,force:true});}
});
