// ABOUTME: Использует изолированный Codex-процесс без инструментов для одного ответа.
// ABOUTME: Авторизация остаётся в закрытом помощнике, модель возвращает только JSON.
import {readFile} from 'node:fs/promises';
import {createSubscriptionLuna} from '../../dialogues/dist/subscription-luna.js';
import {prepareSubscriptionCatalog} from '../../dialogues/dist/subscription-catalog.js';
import {GREETING, OUTPUT_SCHEMA} from './domain.mjs';

const read = name => readFile(new URL(name,import.meta.url),'utf8');

/** Строит один промпт из системного текста и поставляемой Markdown-справки. */
export async function welcomeModel(config) {
 const [prompt,help]=await Promise.all([read('./prompt.md'),read('./help.md')]);
 const instructions=prompt+'\nПриветствие, которое сервер отправляет на /start:\n'+GREETING+'\n\nСправка:\n'+help;
 return {
  async catalog(){
   await prepareSubscriptionCatalog(config);
   const raw=JSON.parse(await readFile(config.catalogPath,'utf8'));
   return raw.models.map(item=>({id:item.slug,name:item.display_name??item.slug,
    reasoning:(item.supported_reasoning_levels??[]).map(level=>level.effort).filter(Boolean)}));
  },
  async respond({text,context,question,settings}){
   const generator=createSubscriptionLuna(config,{model:settings.model,reasoning:settings.reasoning});
   try {
    return JSON.parse(await generator.structured(JSON.stringify({text,context,question}),{instructions,schema:OUTPUT_SCHEMA}));
   }finally{await generator.close();}
  }
 };
}
