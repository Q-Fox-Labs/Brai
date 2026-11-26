// ABOUTME: Извлекает точные признаки задачи из текста Диалогов.
// ABOUTME: Номер PR становится точным признаком только вместе с репозиторием.

const escapePattern=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** Возвращает квалифицированные PR и полные имена файлов. Номера без репозитория неоднозначны. */
export function topicReferences(text:string){
 const pullRequests=new Set<string>();
 const files=new Set<string>();
 const number=(value:string)=>value.replace(/^0+(?=\d)/u,'');
 const mark=(repo:string,id:string)=>pullRequests.add(repo.toLowerCase()+'#'+number(id));
 for(const [,repo,id] of text.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?![\p{L}\p{N}_])/giu))
  mark(repo,id);
 for(const [,repo,id] of text.matchAll(/\bPR\s+([\w.-]+\/[\w.-]+)#(\d+)(?![\p{L}\p{N}_])/giu))
  mark(repo,id);
 for(const [,file] of text.matchAll(/(?:^|[^\w./@-])((?:[\w.@-]+\/)*(?:[\w@-][\w.@-]*\.(?:tsx?|jsx?|mjs|cjs|py|sql|sh|ya?ml|jsonc?|toml|ini|env|conf|lock|mdx?|css|html|go|rs|rb|java|kt|swift|xml|csv)|Dockerfile|Makefile|Gemfile|README|LICENSE))(?![\w/@-]|\.[\w./@-])/giu))
  files.add(file);
 const bareNumbers=new Set(Array.from(text.matchAll(/\bPR[\s#№]*(\d+)(?![\p{L}\p{N}_])/giu),match=>number(match[1])));
 return {pullRequests,files,bareNumbers};
}

/** Проверяет равенство целых признаков. Указанный репозиторий и номер важнее названия или файла. */
export function matchesTopicReference(input:string,title:string,summary:string){
 const source=topicReferences(input);
 const candidate=topicReferences(title+'\n'+summary);
 if(source.pullRequests.size)return [...source.pullRequests].some(key=>candidate.pullRequests.has(key));
 if(source.bareNumbers.size)return false;
 if(source.files.size)return [...source.files].some(key=>candidate.files.has(key));
 if(title.trim().split(/\s+/u).length<2)return false;
 const escaped=escapePattern(title);
 return new RegExp('(?:^|[^\\p{L}\\p{N}_])'+escaped+'(?![\\p{L}\\p{N}_])','iu').test(input);
}

/**
 * Поиск кандидатов с идентификатором должен работать, даже если русский FTS
 * воспринимает весь URL как один терм. Голый номер расширяет список для модели.
 */
export function topicReferencePattern(text:string){
 const {pullRequests,bareNumbers,files}=topicReferences(text);
 const end='(?:[^[:alnum:]_]|$)';
 const patterns:string[]=[];
 for(const ref of pullRequests){
  const [repo,id]=ref.split('#');
  const path=escapePattern(repo);
  patterns.push('(?:https?://github[.]com/'+path+'/pull/|\\mPR[[:space:]]+'+path+'#)0*'+id+end);
 }
 if(!pullRequests.size)for(const id of bareNumbers){
  patterns.push('(?:\\mPR[[:space:]#№]*|https?://github[.]com/[[:alnum:]_.-]+/[[:alnum:]_.-]+/pull/)0*'+id+end);
 }
 for(const file of files)patterns.push('(?:^|[^[:alnum:]_./@-])'+escapePattern(file)+'(?=$|[^[:alnum:]_./@-]|[.](?:[^[:alnum:]_./@-]|$))');
 return patterns.length?patterns.join('|'):null;
}

/** Сопоставляет явные ссылки с форматами ID, которые сохраняют клиенты Диалогов. */
export function linkedDialogueIds(text:string){
 const ids=new Set<string>();
 for(const [,id] of text.matchAll(/codex:\/\/threads\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?![\w-])/gi)){
  for(const prefix of ['', 'codex-', 'codex:'])ids.add(prefix+id.toLowerCase());
 }
 for(const [,id] of text.matchAll(/@thread:(thr_[a-z0-9]+)(?![\w-])/g)){
  ids.add(id);
  ids.add('bb:'+id);
 }
 return [...ids];
}

/** Ограничивает прозу для модели, сохраняя точные ссылки даже за пределами отрывка. */
export function groupingText(first:string,updates:string[],budget=6000){
 const distinct=[...new Set([first,...updates])];
 const allowance=Math.floor(budget/distinct.length);
 return distinct.map(text=>{
  if(text.length<=allowance)return text;
  const excerpt=text.slice(0,allowance);
  const {pullRequests,files,bareNumbers}=topicReferences(text);
  const refs:string[]=[];
  for(const [id] of text.matchAll(/(?:codex:\/\/threads\/[a-f0-9-]{36}|@thread:thr_[a-z0-9]+)/gi))
   refs.push(id);
  refs.push(...[...pullRequests].map(ref=>'PR '+ref),...[...bareNumbers].map(id=>'PR '+id),...files);
  return [excerpt,...refs.filter(ref=>ref.length<=512&&!excerpt.includes(ref)).slice(0,24)].join('\n');
 }).join('\n\n');
}
