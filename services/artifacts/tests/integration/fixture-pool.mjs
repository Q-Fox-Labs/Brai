// ABOUTME: Закрывает реальные PostgreSQL соединения fixture до удаления собственной БД.
// ABOUTME: Не скрывает неожиданные idle ошибки и не использует внутренние поля pg-pool.
import {Pool} from 'pg';
import assert from 'node:assert/strict';
const states=new WeakMap();
/** Создаёт тестовый pool и учитывает живые clients до публичного события end. */
export function fixturePool(options){
  const pool=new Pool(options),state={clients:new Set(),errors:[]};states.set(pool,state);
  pool.on('connect',client=>{state.clients.add(client);client.once('end',()=>state.clients.delete(client));});
  pool.on('error',error=>state.errors.push(error));
  return pool;
}
/** Ждёт physical disconnect и затем проверяет все неожиданные idle ошибки. */
export async function closeFixturePool(pool){
  if(!pool)return;
  const state=states.get(pool);assert.ok(state,'fixturePool must own this pool');
  const disconnected=Promise.all([...state.clients].map(client=>new Promise(resolve=>client.once('end',resolve))));
  let timer;
  try{await pool.end();await Promise.race([disconnected,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture PostgreSQL disconnect did not finish')),5000);})]);}
  finally{if(timer)clearTimeout(timer);}
  assert.deepEqual(state.errors.map(error=>error.code??error.name),[], 'unexpected PostgreSQL idle errors');
}
