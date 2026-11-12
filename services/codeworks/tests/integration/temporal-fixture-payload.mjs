// ABOUTME: Копирует дерево isolated payload с точными ссылками и режимами файлов.
// ABOUTME: Не использует hardlinks и не изменяет источник; caller проверяет принадлежность корней fixture.
import {execFileSync} from 'node:child_process';
import {lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
/** Требует canonical исходный каталог и отсутствующий destination; reflink допускает обычное копирование. */
export function copyFixtureTree(source,destination){
  if(!path.isAbsolute(source)||path.normalize(source)!==source||realpathSync(source)!==source||!lstatSync(source).isDirectory()||!path.isAbsolute(destination)||path.normalize(destination)!==destination||lstatSync(destination,{throwIfNoEntry:false}))throw Error('FIXTURE_COPY_PATH_INVALID');
  // AIDEV-NOTE: GNU cp сохраняет относительные symlink bytes и избегает дорогого JS обхода npm closure.
  execFileSync('/bin/cp',['-aT','--reflink=auto','--',source,destination],{stdio:['ignore','ignore','pipe'],timeout:30000});
}
