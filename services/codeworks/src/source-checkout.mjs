// ABOUTME: Проверяет обновление основной копии и зависимостей до точного DEV commit.
// ABOUTME: Вызывает только зарегистрированный подготовщик под общим Git lock; команды агента не исполняет.
import path from 'node:path';
import {command} from './git.mjs';
import {Fault} from './errors.mjs';

/** Возвращает ready с проверяемыми digests либо конкретную причину безопасного ожидания. */
export async function synchronizeSource(project,workspace,sha,{run=command}={}) {
  if(!/^[0-9a-f]{40}$/.test(sha)||!path.isAbsolute(project.preparer_path))throw new Fault('INVALID_ARGUMENT');
  const helper=path.join(path.dirname(project.preparer_path),'synchronize-brai-source');
  const result=await run(helper,[project.repo_path,sha,'--closing-worktree',workspace.path],{timeout:1800000});
  let receipt;try{receipt=JSON.parse(result.stdout);}catch{throw new Fault('GIT_FAILED','Checkout synchronization returned no valid receipt.');}
  if(receipt?.state==='waiting'&&/^[A-Z_]{1,100}$/.test(receipt.reason??''))return receipt;
  if(receipt?.state!=='ready'||receipt.commit_sha!==sha||!['lock_sha256','dependency_graph_sha256'].every(key=>/^[0-9a-f]{64}$/.test(receipt[key]??'')))throw new Fault('GIT_FAILED','Checkout synchronization receipt differs from the pinned release.');
  return receipt;
}
