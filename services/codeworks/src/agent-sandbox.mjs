// ABOUTME: Строит Linux namespace для чтения или одной управляемой области записи.
// ABOUTME: Все host mounts readonly; полномочия не зависят от текста shell или hook.
import path from 'node:path';
import {realpathSync} from 'node:fs';

/** Аргументы bubblewrap; writable задаёт только уже проверенные канонические mounts. */
export function sandboxArgs({cwd, writable=[], aliases=[], local=[], hidden=[], masked=[], env={}, bridge, socket, profile}) {
  const args=['--ro-bind','/','/','--unshare-user','--disable-userns','--assert-userns-disabled','--unshare-pid','--unshare-ipc','--unshare-uts','--cap-drop','ALL','--die-with-parent','--new-session','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/run','--clearenv'];
  // /etc/resolv.conf can point into /run; retain only that file, never host sockets.
  args.push('--ro-bind','/etc/resolv.conf',realpathSync('/etc/resolv.conf'));
  for(const target of hidden)args.push('--tmpfs',target);
  if(profile)args.push('--bind',profile.source,profile.target);
  for(const [source,target] of writable)args.push('--bind',source,target);
  for(const [source,target] of aliases)args.push('--ro-bind',source,target);
  for(const [source,target] of local)args.push('--bind',source,target);
  for(const {target,directory} of masked) {
    if(directory)args.push('--tmpfs',target,'--remount-ro',target);
    else args.push('--ro-bind','/dev/null',target);
  }
  if(bridge)args.push('--ro-bind',bridge,'/run/codeworks-bridge');
  if(socket)args.push('--ro-bind',socket,'/run/codeworks.sock');
  for(const target of hidden)args.push('--remount-ro',target);
  const environment={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',LANG:'C.UTF-8',...env};
  for(const [name,value] of Object.entries(environment))args.push('--setenv',name,String(value));
  return [...args,'--chdir',cwd,'--'];
}

/** Не позволяет изменить Git-указатель или общие зависимости через writable worktree. */
export function workspaceMounts(project,root,write) {
  const writable=write?[[root,root]]:[];
  const aliases=write?[]:[[root,root]];
  if(root!==project.repo_path) {
    if(write)writable.push([root,project.repo_path]);
    else aliases.push([root,project.repo_path]);
    // Prepared third-party links target the source node_modules. Re-expose that
    // readonly directory below the base alias so links do not resolve to themselves.
    aliases.push([path.join(project.repo_path,'node_modules'),path.join(project.repo_path,'node_modules')]);
  }
  // AIDEV-NOTE: .git — mount point: rename/unlink также не могут заменить указатель.
  aliases.push([path.join(root,'.git'),path.join(root,'.git')]);
  if(root!==project.repo_path)aliases.push([path.join(root,'.git'),path.join(project.repo_path,'.git')]);
  return {writable,aliases};
}
