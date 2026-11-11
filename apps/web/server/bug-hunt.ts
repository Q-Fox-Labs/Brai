// ABOUTME: Передаёт операции bug-hunt в NATS с текущей сессией Auth.
// ABOUTME: Браузер не задаёт владельца; Origin и право разбора проверяются сервером.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../../../services/bug-hunt/schemas/messages.schema.json";
import v2Schema from "../../../services/bug-hunt/schemas/v2.schema.json";
import {checkOrigin,requireSession} from "./auth";
import {GatewayError,natsConnection} from "./gateway";
const ajv=new Ajv({strict:false});addFormats(ajv);
ajv.addSchema(schema);ajv.addSchema(v2Schema);
const v2Operations=["search","similar","enrichment","groups-list","groups-get","membership-update","proposal-resolve","classification-override"];
const v2Mutations=["membership-update","proposal-resolve","classification-override"];
const validators=Object.fromEntries(["report","get","list","review"].map(k=>[k,ajv.getSchema(schema.$id+"#/definitions/"+k)]));
const v2Validators=Object.fromEntries(v2Operations.map(k=>[k,ajv.getSchema(v2Schema.$id+"#/definitions/"+k)]));
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
const codes=new Set(["INVALID_ARGUMENT","REQUEST_TOO_LARGE","RESULT_TOO_LARGE","UNAUTHENTICATED","FORBIDDEN","NOT_FOUND","IDEMPOTENCY_CONFLICT","REVISION_CONFLICT","BUSY","DATABASE_UNAVAILABLE","DEPENDENCY_UNAVAILABLE","DEADLINE_EXCEEDED","INTERNAL","CURSOR_STALE","INDEX_NOT_READY","PROCESSING_PENDING","POLICY_BLOCKED","BUDGET_EXHAUSTED","MODEL_OUTCOME_UNKNOWN"]);
/** Выполняет один запрос; неизвестная мутация не получает новый ключ автоматически. */
export async function bugHuntRequest(request:Request):Promise<Response>{
 let mutation=false,sent=false;
 try{
  checkOrigin(request);
  const operation=new URL(request.url).searchParams.get("operation")??"";
  if(!["capabilities","list","operator-list","get","report","review",...v2Operations].includes(operation))throw new GatewayError(404,"NOT_FOUND");
  const session=await requireSession(request);
  if(request.headers.get("x-brai-user")!==session.user.id)throw new GatewayError(401,"ACCOUNT_CHANGED");
  if(session.user.status!=="active")throw new GatewayError(403,"FORBIDDEN");
  const reviewer=session.user.role==="admin";
  if((operation==="review"||operation==="operator-list"||v2Mutations.includes(operation))&&!reviewer)throw new GatewayError(403,"FORBIDDEN");
  if(operation==="capabilities")return Response.json({reviewer},{headers});
  mutation=operation==="report"||operation==="review"||v2Mutations.includes(operation);
  const chunks:Uint8Array[]=[];let size=0;
  const reader=request.body?.getReader();
  if(reader){try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new GatewayError(413,"REQUEST_TOO_LARGE");}chunks.push(value);}}finally{reader.releaseLock();}}
  let input;try{input=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new GatewayError(400,"INVALID_ARGUMENT");}
  if(!(v2Operations.includes(operation)?v2Validators[operation]:validators[operation==="operator-list"?"list":operation])?.(input))throw new GatewayError(400,"INVALID_ARGUMENT");
  const forwarded:Record<string,string>={};
  for(const name of ["cookie","origin","user-agent","sec-fetch-site"]){const value=request.headers.get(name);if(value)forwarded[name]=value;}
  const nc=await natsConnection();sent=true;
  const msg=await nc.request("brai.bug_hunt."+(v2Operations.includes(operation)?"v2.":"v1.")+operation,Buffer.from(JSON.stringify({context:{kind:"web",headers:forwarded},input})),{timeout:10000});
  if(msg.data.length>262144)throw new GatewayError(502,"BAD_REPLY",mutation?"unknown":"query");
  const value=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(msg.data));
  if(msg.headers?.has("Nats-Service-Error")||msg.headers?.has("Nats-Service-Error-Code")){
   const code=codes.has(value?.code)?value.code:"INTERNAL",status=Number(msg.headers.get("Nats-Service-Error-Code"));
   return Response.json({code,outcome:value?.outcome==="not_accepted"?"not_accepted":"unknown"},{status:[400,401,403,404,409,413,429,500,503,504].includes(status)?status:503,headers});
  }
  return Response.json(value,{headers});
 }catch(error){
  const e=error instanceof GatewayError?error:new GatewayError(503,"DEPENDENCY_UNAVAILABLE");
  return Response.json({code:e.code,outcome:mutation&&sent?"unknown":"not_accepted"},{status:e.status,headers});
 }
}
