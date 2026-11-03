// ABOUTME: Разбирает один литеральный git apply с патчем на stdin.
// ABOUTME: Не исполняет команды; разрешает только относительные цели без переименований и ссылок.
import path from 'node:path';

/** Узнаёт попытку git apply для отказа до записи, даже когда сам патч не поддержан. */
export function gitApplyDirectory(command,cwd) {
  if(typeof command!=='string')return null;
  const match=/^(?:RTK_DISABLED=1 )?git(?: -C ('[^'\n]+'|\/[A-Za-z0-9_./-]+))?(?: -c codeworks.kind=(?:feature|hotfix))? apply(?:\s|$)/.exec(command);
  if(!match)return null;
  const directory=match[1]?.startsWith("'")?match[1].slice(1,-1):match[1];
  return directory??cwd;
}

/** Возвращает проверенные цели и замену только каталога; остальные байты сохраняются. */
export function gitPatch(command) {
  if (typeof command !== 'string') return null;
  const match = /^(?:RTK_DISABLED=1 )?git -C ('[^'\n]+'|\/[A-Za-z0-9_./-]+)(?: -c codeworks.kind=(feature|hotfix))? apply --whitespace=nowarn <<'([A-Z][A-Z0-9_]{0,63})'\n([\s\S]*)\n\3\n?$/.exec(command);
  if (!match) return null;
  const directory = match[1].startsWith("'") ? match[1].slice(1,-1) : match[1];
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes('..')) return null;
  const patch = match[4], targets = [];
  const lines = patch.split('\n');
  for (let i=0;i<lines.length;i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const header = /^diff --git a\/([A-Za-z0-9_./-]+) b\/\1$/.exec(line);
      if (!header) return null;
      const name = header[1];
      if (name.startsWith('/') || name.split('/').some(p=>!p || p==='.' || p==='..' || p==='.git')) return null;
      targets.push(name);
    } else if (/^(?:old mode|new mode|new file mode|deleted file mode) /.test(line)) {
      if (!/^(?:new file mode|deleted file mode) 100644$/.test(line)) return null;
    } else if (/^(?:rename |copy |GIT binary patch|Binary files|similarity |dissimilarity )/.test(line)) return null;
    else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const name = line.slice(4);
      if (name !== '/dev/null' && !["a/"+targets.at(-1),"b/"+targets.at(-1)].includes(name)) return null;
    } else if (!/^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: 100644)?|@@ .*@@.*|[ +\-\\].*|)$/.test(line)) return null;
  }
  if (!targets.length || new Set(targets).size !== targets.length) return null;
  return {directory,kind:match[2], targets:targets.map(p=>path.join(directory,p)), rewrite:root=>command.replace(match[1],"'"+root.replaceAll("'","'\\''")+"'")};
}
