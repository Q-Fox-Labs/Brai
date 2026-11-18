// ABOUTME: Исполняет настоящую собранную natsPrincipal на синтетическом ответе Auth.
// ABOUTME: Ожидание независимо закреплено в oracle; сеть, часы и идентичность заменены fixture.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const spec=JSON.parse(readFileSync('/spec.json','utf8'));
if(spec.fixture_ref!=='creator-reviewer')throw Error('FIXTURE_REF_INVALID');
const fixture=JSON.parse(readFileSync('/source/fixtures/creator-reviewer.json','utf8'));
if(process.env.BRAI_RECIPE_SOURCE_FILE!=='src/identity.ts')throw Error('SOURCE_BINDING_INVALID');
const {natsPrincipal}=await import(pathToFileURL('/source/build/identity.js').href);
const originalNow=Date.now;Date.now=()=>fixture.now;
try{
 const wire=async(subject,input)=>{
  if(subject!=='brai.auth.v1.session'||input.headers.cookie!=='synthetic'||Object.keys(input.body).length)throw Error('UNEXPECTED_AUTH_CALL');
  return {status:200,body:{user:{id:'synthetic',role:'creator',status:'active'},session:{userId:'synthetic',expiresAt:fixture.expiresAt}}};
 };
 const principal=await natsPrincipal(wire,{kind:'web',headers:{cookie:'synthetic'}});
 process.stdout.write(JSON.stringify({assertions:[{name:'creator reviewer capability',actual:principal.reviewer?'reviewer':'non-reviewer'}]}));
}finally{Date.now=originalNow;}
