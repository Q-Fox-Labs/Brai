// ABOUTME: Подключает принятые host Node dependencies и текущий Providers client к immutable payload.
// ABOUTME: Не ищет пользовательские пакеты, не скачивает их и не меняет разрешение относительных imports.
import {registerHooks} from 'node:module';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dependencies=process.env.BRAI_BUG_HUNT_NODE_MODULES,payload=process.env.BRAI_BUG_HUNT_PAYLOAD;
if(!dependencies||!isAbsolute(dependencies)||!dependencies.endsWith('/node_modules')||!payload||!isAbsolute(payload))throw Error('BUG_HUNT_HOST_MODULES_UNPREPARED');
const parentURL=pathToFileURL(join(dependencies,'..','.brai-host-entry.mjs')).href;
registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='@brai/providers')return nextResolve(pathToFileURL(join(payload,'services/providers/dist/index.js')).href,context);
 if(specifier.startsWith('.')||specifier.startsWith('/')||specifier.includes(':'))return nextResolve(specifier,context);
 return nextResolve(specifier,{...context,parentURL});
}});
