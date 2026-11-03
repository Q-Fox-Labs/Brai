// ABOUTME: Рассчитывает безопасные переходы долговечного состояния веб-превью.
// ABOUTME: Внешние эффекты и атомарное сохранение выполняются координатором под блокировкой проекта.

const validSha = sha => /^[0-9a-f]{40}$/.test(sha ?? '');

/** Учитывает наблюдённый HEAD; незаконченный внешний шаг остаётся закреплённым. */
export function observePreview(row, sha) {
  if (!validSha(sha)) throw Error('PREVIEW_SHA_INVALID');
  if (row.action) return row.pending_sha === sha ? row : {...row, pending_sha:sha};
  if (row.desired_sha === sha) return row;
  return {...row, desired_sha:sha, pending_sha:null, generation:Number(row.generation)+1,
    state:'waiting_ci', image_reference:null, ci_proof:null, error:null};
}

/** Продлевает ready-превью ровно один раз для каждого успешно завершённого sync. */
export function renewPreview(row, syncId, sha, now, ttlSeconds) {
  if (!syncId || !validSha(sha)) throw Error('PREVIEW_SYNC_INVALID');
  if (row.last_sync_operation_id === syncId || row.action) return row;
  const next = {...row, last_sync_operation_id:syncId};
  if (row.desired_sha!==sha) return next;
  if (row.state==='expired') return {...next, state:'waiting_ci', generation:Number(row.generation)+1};
  if (row.state!=='ready' || row.deployed_sha!==sha || !row.slot_id) return next;
  return {...next, published_at:now, expires_at:new Date(new Date(now).getTime()+ttlSeconds*1000).toISOString()};
}

/** Принимает CI proof только для текущего поколения, закреплённого за точным HEAD. */
export function acceptPreviewProof(row, generation, proof, imageReference, ticket) {
  if (row.action || Number(row.generation)!==Number(generation) || row.state!=='waiting_ci') return row;
  if (proof?.head_sha!==row.desired_sha || !proof.run_id || !proof.attempt ||
      !/^[0-9a-f]{64}$/.test(proof.policy_sha256??'') || !/^sha256:[0-9a-f]{64}$/.test(proof.composition_digest??'') ||
      !/@sha256:[0-9a-f]{64}$/.test(imageReference??'')) throw Error('PREVIEW_PROOF_INVALID');
  return {...row, ci_proof:proof, image_reference:imageReference, queue_ticket:row.queue_ticket??ticket, state:'queued', error:null};
}

/** Фиксирует один внешний шаг до его вызова и сохраняет занятие слота. */
export function beginPreviewAction(row, action, slotId = row.slot_id) {
  if (row.action || !['publish','remove'].includes(action) || !slotId) throw Error('PREVIEW_ACTION_INVALID');
  if (action==='publish' && (row.state!=='queued' || !row.ci_proof || !row.image_reference)) throw Error('PREVIEW_PROOF_REQUIRED');
  return {...row, slot_id:slotId, action, action_generation:Number(row.generation), state:action==='publish'?'publishing':'removing'};
}

/** Применяет только подтверждённый результат закреплённого действия; unknown сохраняет слот. */
export function reconcilePreviewAction(row, result, now, ttlSeconds) {
  if (!row.action || result?.preview_id!==row.id || Number(row.action_generation)!==Number(result.generation)) return row;
  let next;
  if (row.action==='remove') {
    if (result.status!=='absent') return row;
    next={...row, slot_id:null, deployed_sha:null, deployed_image_reference:null,
      deployed_generation:null, action:null, action_generation:null, state:'expired', expires_at:null, pending_cancel:false,pending_sha:null};
  } else if (result.status==='failed') {
    // Старую версию подтверждает только точное совпадение независимого inspect.
    if (row.deployed_sha && (result.deployed_sha!==row.deployed_sha || result.image_reference!==row.deployed_image_reference)) return row;
    const code=['PREVIEW_PROTOCOL_UNSUPPORTED','PREVIEW_START_FAILED','PREVIEW_SUPERSEDED'].includes(result.error_code)?result.error_code:'PREVIEW_PUBLICATION_FAILED';
    next={...row, action:null, action_generation:null, state:code==='PREVIEW_PROTOCOL_UNSUPPORTED'?'unsupported':'failed', error:code, ...(!row.deployed_sha ? {slot_id:null} : {})};
  } else if (result.status==='ready' && result.deployed_sha===row.desired_sha && result.image_reference===row.image_reference) {
    next={...row, action:null, action_generation:null, state:'ready', deployed_sha:row.desired_sha,
      deployed_image_reference:row.image_reference, deployed_generation:Number(row.generation), published_at:now,
      expires_at:new Date(new Date(now).getTime()+ttlSeconds*1000).toISOString(), queue_ticket:null, error:null};
  } else return row;
  if(next.pending_cancel && row.action==='publish')return next.slot_id?beginPreviewAction({...next,pending_sha:null},'remove'):{...next,state:'expired',pending_cancel:false,pending_sha:null};
  return next.pending_sha && next.pending_sha!==next.desired_sha ? observePreview(next,next.pending_sha) : {...next,pending_sha:null};
}
