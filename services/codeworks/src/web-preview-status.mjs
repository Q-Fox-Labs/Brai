// ABOUTME: Возвращает публичное состояние веб-превью без proof и секретов адаптера.
// ABOUTME: Чтение статуса не продлевает аренду и не запускает публикацию.

/** Проверяет уникальные HTTPS origins слотов после проверки структуры JSON Schema. */
export function validPreviewPolicy(project) {
  const policy=project.web_preview;
  if(!policy)return true;
  if(policy.enabled&&!project.github?.ci)return false;
  if(!policy.slots)return !policy.enabled;
  const ids=new Set(),origins=new Set();
  return policy.slots.every(slot=>{
    let url;try{url=new URL(slot.url);}catch{return false;}
    if(url.protocol!=='https:'||url.origin!==slot.url||url.username||url.password||url.hostname.includes('*')||ids.has(slot.id)||origins.has(url.origin))return false;
    ids.add(slot.id);origins.add(url.origin);return true;
  });
}

/** Разделяет ожидаемый HEAD и реально опубликованный SHA; наружу не передаёт исполняемый intent. */
export function publicWebPreview(row,policy) {
  if(!row)return null;
  const slot=policy.slots?.find(item=>item.id===row.slot_id);
  const error=row.error?( /^[A-Z][A-Z0-9_]{0,95}$/.test(row.error)?row.error:'PREVIEW_UNAVAILABLE'):null;
  return {
    state:row.state,
    desired_sha:row.pending_sha??row.desired_sha??null,
    deployed_sha:row.deployed_sha??null,
    url:slot?.url??null,
    queue_position:row.state==='queued'?Number(row.queue_position):null,
    published_at:row.published_at??null,
    expires_at:row.expires_at??null,
    backend_changed:row.backend_changed===true,
    shared_backend:true,
    error,
  };
}
