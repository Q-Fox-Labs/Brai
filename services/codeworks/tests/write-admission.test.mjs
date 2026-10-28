// ABOUTME: Проверяет переходы допуска вызова записи и активацию области.
// ABOUTME: Подменяет SQL и Git; интеграционные транзакции проверяются отдельно.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWriteAdmission} from '../src/write-admission.mjs';
const w={id:'w',base_sha:'base',preparation_state:'ready'};
const call={id:'c',workspace_id:'w',state:'in_flight',tool_result:null};
function fixture(changed){const queries=[];let row={...call};const query=async(sql,args=[])=>{queries.push({sql,args});if(sql.startsWith('SELECT * FROM codeworks.write_calls'))return {rows:[row],rowCount:1};if(sql.startsWith('SELECT * FROM codeworks.workspaces'))return {rows:[w],rowCount:1};if(sql.startsWith('UPDATE codeworks.write_calls SET state=\'finished\'')){row={...row,state:'finished',tool_result:JSON.parse(args[1])};return {rows:[],rowCount:1};}if(sql.includes('UPDATE codeworks.write_calls SET state=CASE'))return {rows:[{state:'uncertain'}],rowCount:1};return {rows:[],rowCount:0};};const pool={query,connect:async()=>({query,release(){}})};const api=createWriteAdmission(pool,{prepare:async()=>{},workspace:async()=>({project:{},workspace:w}),inspect:async()=>({dirty:changed,head:'base'})});return {api,queries};}
test('finished write activates only after an observed tree change, including error',async()=>{for(const changed of [false,true]){const f=fixture(changed);const result=await f.api.finish({project_id:'p',session_id:'s',turn_id:'t',tool_use_id:'u',outcome:'error'},'e');assert.equal(result.changed,changed);assert.equal(f.queries.some(q=>q.sql.includes("activation_state='active'")),changed);}});
test('stop leaves in-flight write uncertain',async()=>{const f=fixture(false);assert.deepEqual(await f.api.stop({project_id:'p',session_id:'s',turn_id:'t',event:'Stop'},'e'),{closed:0,uncertain:1});assert.match(f.queries.find(q=>q.sql.includes('UPDATE codeworks.write_calls SET state=CASE')).sql,/uncertain/);});
