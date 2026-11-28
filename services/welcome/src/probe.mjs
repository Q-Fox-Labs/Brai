// ABOUTME: Проверяет живую Luna из закрытой конфигурации развёрнутого Welcome.
// ABOUTME: Синтетический вопрос проверяет разрешённый ответ без запуска действий.
import {readFile} from 'node:fs/promises';
import {decision} from './domain.mjs';
import {welcomeModel} from './model.mjs';

try {
 const config=JSON.parse(await readFile(process.env.WELCOME_CONFIG,'utf8'));
 const model=await welcomeModel(config.codex);
 const catalog=await model.catalog();
 const luna=catalog.find(item=>item.id==='gpt-6-luna');
 if(!luna?.reasoning.includes('low'))throw Error('LUNA_CATALOG');
 const result=decision(await model.respond({
  text:'Где можно узнать, как устроен Брай?',context:[],question:null,
  settings:{model:luna.id,reasoning:'low'}
 }),null);
 if(result.action!=='answer'||!result.text.trim())throw Error('LUNA_RESPONSE');
 process.stdout.write(JSON.stringify({state:'verified',model:luna.id})+'\n');
}catch{
 process.stderr.write('WELCOME_MODEL_PROBE_FAILED\n');
 process.exitCode=1;
}
