// ABOUTME: Передаёт подлинное hook событие из изолированного Codex в родительский стенд.
// ABOUTME: Только тестовый loopback transport; не поставляется и не исполняет исходный инструмент.
let body='';for await(const chunk of process.stdin)body+=chunk;
const url=new URL(process.argv[2]);
if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw Error('FIXTURE_LOOPBACK_REQUIRED');
const response=await fetch(url,{method:'POST',body,headers:{'content-type':'application/json'}});
if(!response.ok)throw Error('FIXTURE_HOOK_FAILED');
process.stdout.write(await response.text());
