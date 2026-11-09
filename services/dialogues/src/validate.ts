// ABOUTME: Проверяет публичный запрос по схеме выбранной операции MCP.
// ABOUTME: Возвращает путь ошибки без значений запроса; не выполняет запись.
import {bytes, DialoguesFault, limits, summaryText, timestamp} from './domain.js';

/** Проверяет используемое реестром подмножество JSON Schema до вызова хранилища. */
export function validate(value: unknown, schema: Record<string,any>, path: string): void {
 const child=(key:string)=>path?path+'.'+key:key;
 const fault=(expected:string,extra:Record<string,unknown>={}):never=>{
  throw new DialoguesFault('INVALID_ARGUMENT',{field:path||'$',expected,...extra});
 };
 const types=Array.isArray(schema.type)?schema.type:[schema.type];
 const actual=value===null?'null':Array.isArray(value)?'array':typeof value;
 if(schema.type!==undefined&&!types.includes(actual)&&!(types.includes('integer')&&Number.isSafeInteger(value)))fault('тип: '+types.join(' или '));
 if(schema.enum&&!schema.enum.includes(value))fault('одно из допустимых значений',{allowed:schema.enum});
 if(actual==='object'){
  const row=value as Record<string,unknown>,properties=schema.properties??{};
  for(const key of schema.required??[])if(row[key]===undefined)
   throw new DialoguesFault('INVALID_ARGUMENT',{field:child(key),expected:'обязательное поле'});
  if(schema.additionalProperties===false){
   const unknown=Object.keys(row).find(key=>!Object.hasOwn(properties,key));
   if(unknown!==undefined){
    // AIDEV-NOTE: Имя нужно агенту для исправления; произвольные ключи скрываем только в журнале.
    const known=/^(role|kind|turn_id|external_id|origin|attachments|ack|context)$/.test(unknown);
    throw new DialoguesFault('INVALID_ARGUMENT',{field:child(unknown.slice(0,128)),field_truncated:unknown.length>128,expected:'удалите неизвестное поле; используйте allowed',allowed:Object.keys(properties),...(!known?{unknown_property:true,parent_field:path}: {})});
   }
  }
  for(const key of Object.keys(properties))if(row[key]!==undefined)validate(row[key],properties[key],child(key));
 }
 if(actual==='array'){
  const rows=value as unknown[];
  if((schema.minItems!==undefined&&rows.length<schema.minItems)||(schema.maxItems!==undefined&&rows.length>schema.maxItems))fault('число элементов вне допустимого диапазона',{minimum:schema.minItems,maximum:schema.maxItems});
  if(schema.uniqueItems&&new Set(rows.map(row=>JSON.stringify(row))).size!==rows.length)fault('массив без повторов');
  if(schema.items)rows.forEach((row,i)=>validate(row,schema.items,path+'['+i+']'));
 }
 if(actual==='string'){
  const s=value as string;
  if(schema.pattern&&!new RegExp(schema.pattern).test(s))fault('строка по шаблону '+schema.pattern);
  if(schema.format==='date-time')try{timestamp(s);}catch{fault('дата ISO 8601 с часовым поясом');}
  if(s.includes('\u0000'))fault('строка без NUL');
  if(path==='arguments.dialogue.title'&&(!s.trim()||bytes(s)>1024))fault('непустая строка не более 1024 UTF-8 байт');
 }
 if(actual==='number'){
  const n=value as number;
  if((schema.minimum!==undefined&&n<schema.minimum)||(schema.maximum!==undefined&&n>schema.maximum))fault('число вне допустимого диапазона',{minimum:schema.minimum,maximum:schema.maximum});
 }
}

/** Проверяет ограничения текста и саммари с путями конкретных сообщений. */
export function validateMessage(row: Record<string,any>, path:string):void {
 if(bytes(row.text)>limits.messageBytes)throw new DialoguesFault('INVALID_ARGUMENT',{field:path+'.text',expected:'не более '+limits.messageBytes+' UTF-8 байт'});
 if(Array.from(row.text).length>100&&row.summary===undefined)throw new DialoguesFault('INVALID_ARGUMENT',{field:path+'.summary',expected:'отдельное непустое саммари обязательно для текста длиннее 100 Unicode-символов'});
 if(row.summary!==undefined)try{summaryText(row.summary);}catch{throw new DialoguesFault('INVALID_ARGUMENT',{field:path+'.summary',expected:'непустое саммари без NUL'});}
 if(row.source!==undefined&&bytes(row.source)>limits.metadataBytes)throw new DialoguesFault('INVALID_ARGUMENT',{field:path+'.source',expected:'объект не более '+limits.metadataBytes+' UTF-8 байт'});
 if(row.role!==undefined&&((row.role==='user')!==(row.kind==='input')))throw new DialoguesFault('INVALID_ARGUMENT',{field:path+'.kind',expected:'input для user; commentary или final для assistant'});
}
