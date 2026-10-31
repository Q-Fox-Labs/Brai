// ABOUTME: Создаёт только отсутствующие streams/consumer Приёма по owner-конфигурации.
// ABOUTME: Не меняет существующие несовместимые настройки и не удаляет события.
import {readFile} from 'node:fs/promises';
import {connect} from 'nats';
const path=process.env.INTAKE_NATS_ADMIN_OPTIONS_FILE;
if(!path)throw Error('MISSING_ADMIN_OPTIONS');
const definitions=JSON.parse(await readFile(new URL('./broker.json',import.meta.url),'utf8'));
const nc=await connect(JSON.parse(await readFile(path,'utf8')));
function same(actual,expected){return Object.entries(expected).every(([key,value])=>JSON.stringify(actual[key])===JSON.stringify(value));}
function absent(e){return e?.api_error?.code===404 || e?.code==='404';}
try {
 const m=await nc.jetstreamManager();
 for(const expected of definitions.streams) {
  let actual;
  try{actual=(await m.streams.info(expected.name)).config;}catch(e){if(!absent(e))throw e;}
  if(actual){if(!same(actual,expected))throw Error('INTAKE_STREAM_CONFIG_MISMATCH');}
  else await m.streams.add(expected);
 }
 let actual;const stream=definitions.streams[0].name,expected=definitions.consumer;
 try{actual=(await m.consumers.info(stream,expected.durable_name)).config;}catch(e){if(!absent(e))throw e;}
 if(actual){if(!same(actual,expected)||actual.deliver_subject||actual.headers_only||(actual.inactive_threshold??0)!==0)throw Error('INTAKE_CONSUMER_CONFIG_MISMATCH');}
 else await m.consumers.add(stream,expected);
 console.log('INTAKE_BROKER_READY');
}finally{await nc.close();}
