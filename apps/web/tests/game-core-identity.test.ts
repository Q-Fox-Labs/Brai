// ABOUTME: Проверяет закрытие legacy GameCore API в Telegram identity и понятное состояние экрана.
// ABOUTME: Реальные server/route функции используют подставной NATS; приватные данные не читаются.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const root=resolve(import.meta.dirname,"../../..");
const base=createRequire(pathToFileURL(resolve(root,"apps/web/server/game-core.ts")));
function load(path:string,overrides:Record<string,unknown>={}){
 const code=ts.transpileModule(readFileSync(resolve(root,path),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const mod={exports:{} as Record<string,unknown>};
 new Function("require","module","exports",code)((name:string)=>Object.hasOwn(overrides,name)?overrides[name]:base(name),mod,mod.exports);
 return mod.exports as Record<string,Function>;
}
class GatewayError extends Error { status:number;code:string;constructor(status:number,code:string){super(code);this.status=status;this.code=code;} }
test("every direct GameCore route denies ordinary admin and member before NATS, including file/workflow paths",async()=>{
 const prior=process.env.WEB_IDENTITY_MODE;process.env.WEB_IDENTITY_MODE="telegram";
 try{
  let connections=0;
  const gateway={GatewayError,natsConnection:async()=>{connections++;throw Error("must not connect");}};
  const game=load("apps/web/server/game-core.ts",{"./gateway":gateway});
  const fail={failure:(error:GatewayError)=>Response.json({code:error.code},{status:error.status})};
  const id="00000000-0000-4000-8000-000000000001";
  for(const role of ["admin","user"]){
   const auth={checkOrigin:()=>{},requireSession:async()=>({user:{id:"old-owner",profileId:"p1",role,status:"active"},session:{id:"s"}})};
   const overrides={"@/server/auth":auth,"@/server/game-core":game,"@/server/gateway":gateway,"@/server/http":fail,
    "@/server/request-body":{readBoundedJson:(r:Request)=>r.json(),RequestBodyFailure:class extends Error{}}};
   const route=(path:string)=>load("apps/web/app/api/game-core/"+path+"route.ts",overrides);
   const request=(body?:object)=>new Request("https://fixture.test/api/game-core",{method:body?"POST":"GET",headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
   assert.equal((await route("").GET(request())).status,503);
   assert.equal((await route("artifacts/[id]/").GET(request(),{params:Promise.resolve({id})})).status,503);
   assert.equal((await route("workflow/").POST(request({title:"Новая задача",request:"Текст",request_id:id}))).status,503);
   assert.equal((await route("workflow/").PUT(request({operation:"start",move_id:id,revision_id:id,request_id:id}))).status,503);
   assert.equal((await route("status/").PUT(request({kind:"element",id,request_id:id,status:"active"}))).status,403);
  }
  assert.equal(connections,0);
 }finally{if(prior===undefined)delete process.env.WEB_IDENTITY_MODE;else process.env.WEB_IDENTITY_MODE=prior;}
});
test("disabled GameCore screen renders a clear unavailable state without a retry or creation control",()=>{
 const React=base("react"),{renderToStaticMarkup}=base("react-dom/server");
 const mod=load("apps/web/app/game-core/screen.tsx",{"./model":{},"./presentation":{},"./workflow":{},"./game-core.css":{}});
 const html=renderToStaticMarkup(React.createElement(mod.default,{userId:"owner",disabled:true}));
 assert.match(html,/Элементы пока недоступны/);assert.doesNotMatch(html,/Повторить|Новая задача|Загружаем/);
});
