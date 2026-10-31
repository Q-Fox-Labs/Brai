// ABOUTME: Подписывает курсор, связанный с caller, владельцем и фильтрами.
// ABOUTME: Ключ находится в защищённом файле и не является частью пользовательского ответа.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {canonical} from './contracts.js';
import {Fault,type Data} from './types.js';
/** Кодирует последний стабильный ключ страницы и scope. */
export function encodeCursor(key:Buffer,scope:Data,after:string):string {
 const body=Buffer.from(canonical({version:1,scope,after})).toString('base64url');
 return body+'.'+createHmac('sha256',key).update(body).digest('base64url');
}
/** Проверяет подпись и полную область; чужой cursor не выдаёт разрешений. */
export function decodeCursor(key:Buffer,scope:Data,cursor:string|null):string|null {
 if(cursor===null)return null;
 try{
  const [body,signature,...rest]=cursor.split('.'),actual=Buffer.from(signature,'base64url'),expected=createHmac('sha256',key).update(body).digest();
  if(rest.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();
  const parsed=JSON.parse(Buffer.from(body,'base64url').toString());
  if(parsed.version!==1||typeof parsed.after!=='string'||canonical(parsed.scope)!==canonical(scope))throw Error();
  return parsed.after;
 }catch{throw new Fault('INVALID_ARGUMENT');}
}
