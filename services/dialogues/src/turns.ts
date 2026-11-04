// ABOUTME: Управляемый ход, его результаты и атомарное закрытие.
// ABOUTME: Оригиналы сообщений неизменяемы, изменения результатов не запускают свёртку.
import type { Pool, PoolClient } from 'pg';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { bytes, canonical, fail, id, integer, limits, object, text, DialoguesFault } from './domain.js';
import { fieldId, message, mergeResult, requireCompletion, validateChanges, version } from './turn-domain.js';
import { enqueueDialogue } from './jobs.js';
import type { createContext } from './context.js';
type DB = Pick<Pool, 'connect'>;
type Mutation = (owner: string, request: string, op: string, input: unknown, fn: (db: PoolClient, seq: string) => Promise<any>) => Promise<any>;
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
async function insertMessage(db: PoolClient, owner: string, dialogue: string, turn: string, m: any, kind: 'input' | 'final', seq: string) {
    const prior = (await db.query('SELECT payload,content_hash,message_order FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3', [owner, dialogue, m.id])).rows[0];
    const { summary, ...base } = m;
    const payload = { ...base, turn_id: turn, role: kind === 'input' ? 'user' : 'assistant', kind };
    if (prior) {
        if (canonical(prior.payload) !== canonical(payload))
            fail('MESSAGE_CONFLICT');
        if (summary !== undefined) {
            const previous = (await db.query('SELECT text FROM dialogues_live.message_summaries WHERE owner_id=$1 AND dialogue_id=$2 AND message_id=$3 ORDER BY version DESC LIMIT 1', [owner, dialogue, m.id])).rows[0];
            if (!previous || previous.text !== summary)
                fail('SUMMARY_CONFLICT');
        }
        return { id: m.id, sha256: prior.content_hash, message_order: prior.message_order, replayed: true };
    }
    const order = (await db.query('SELECT COALESCE(MAX(message_order),-1)+1 AS n FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2', [owner, dialogue])).rows[0].n;
    const item = (await db.query('SELECT COALESCE(MAX(item_order),-1)+1 AS n FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3', [owner, dialogue, turn])).rows[0].n;
    const sha = hash(m.text);
    await db.query('INSERT INTO dialogues_live.messages(owner_id,dialogue_id,turn_id,id,role,kind,message_order,item_order,text,payload,content_hash,occurred_at,source,change_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [owner, dialogue, turn, m.id, payload.role, kind, order, item, m.text, payload, sha, m.occurred_at, m.source, seq]);
    if (summary !== undefined)
        await db.query('INSERT INTO dialogues_live.message_summaries(owner_id,dialogue_id,message_id,version,text,source_hash,change_seq) VALUES($1,$2,$3,1,$4,$5,$6)', [owner, dialogue, m.id, summary, sha, seq]);
    return { id: m.id, sha256: sha, message_order: String(order), replayed: false };
}
async function lookup(db: PoolClient, owner: string, dialogue: string, turn: string) {
    const t = (await db.query('SELECT * FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3 AND managed', [owner, dialogue, turn])).rows[0];
    if (!t)
        fail('NOT_FOUND');
    return t;
}
async function applyChanges(db: PoolClient, owner: string, dialogue: string, turn: string, a: any) {
    let changed = false;
    for (const kind of ['add','update'])
        for (const [index,row] of (a[kind] ?? []).entries())
            if (row.source_refs?.length) {
                const n = (await db.query("SELECT count(*)::int AS n FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND kind='input' AND id=ANY($4::text[])", [owner, dialogue, turn, row.source_refs])).rows[0].n;
                if (n !== row.source_refs.length)
                    throw new DialoguesFault('INVALID_SOURCE_REFS',{field:`changes.${kind}[${index}].source_refs`,expected:'ID входов этого хода и владельца'});
            }
    for (const [index, row] of (a.add ?? []).entries()) {
        const status = row.status ?? 'pending';
        requireCompletion(status, row.result, row.reason, `changes.add[${index}]`);
        await db.query('INSERT INTO dialogues_live.turn_results(owner_id,dialogue_id,turn_id,id,kind,formulation,source_refs,status,result,verification,reason,remainder) VALUES($1,$2,$3,$4,\'work\',$5,$6,$7,$8,$9,$10,$11)', [owner, dialogue, turn, row.id, row.formulation, row.source_refs ?? [], status, row.result ?? null, row.verification ?? null, row.reason ?? null, row.remainder ?? null]);
        changed = true;
    }
    for (const [index, row] of (a.update ?? []).entries()) {
        const previous = (await db.query("SELECT * FROM dialogues_live.turn_results WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND id=$4 AND kind='work'", [owner, dialogue, turn, row.id])).rows[0];
        if (!previous)
            fail('RESULT_NOT_FOUND');
        const { next, changed: resultChanged } = mergeResult(previous, row, `changes.update[${index}]`);
        if (resultChanged) {
            await db.query('UPDATE dialogues_live.turn_results SET formulation=$5,source_refs=$6,status=$7,result=$8,verification=$9,reason=$10,remainder=$11,updated_at=now() WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND id=$4', [owner, dialogue, turn, row.id, next.formulation, next.source_refs, next.status, next.result, next.verification, next.reason, next.remainder]);
            changed = true;
        }
    }
    if (a.purpose !== undefined || a.constraints !== undefined) {
        const t = await lookup(db, owner, dialogue, turn);
        const purpose = a.purpose === undefined ? t.purpose : a.purpose, constraints = a.constraints === undefined ? t.constraints_text : a.constraints;
        if (purpose !== t.purpose || constraints !== t.constraints_text) {
            await db.query('UPDATE dialogues_live.turns SET purpose=$4,constraints_text=$5 WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3', [owner, dialogue, turn, purpose, constraints]);
            changed = true;
        }
    }
    return changed;
}
async function requireNoPending(db: PoolClient, owner: string, dialogue: string, turn: string) {
    const rows = (await db.query("SELECT id,count(*) OVER()::integer AS total FROM dialogues_live.turn_results WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND kind='work' AND status='pending' ORDER BY created_at,id LIMIT 64", [owner, dialogue, turn])).rows;
    if (rows.length)
        throw new DialoguesFault('PENDING_RESULTS', { pending: rows.map((r: any) => ({ id: r.id })), pending_count: rows[0].total, pending_complete: rows.length === rows[0].total, read_tool: 'dialogues_exchange: snapshot' });
}
async function bump(db: PoolClient, owner: string, dialogue: string, turn: string, seq: string) { return (await db.query('UPDATE dialogues_live.turns SET version=version+1,updated_at=now(),change_seq=$4 WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3 RETURNING version::text', [owner, dialogue, turn, seq])).rows[0].version; }
function sign(key: string, value: any) { const p = Buffer.from(JSON.stringify(value)).toString('base64url'); return p + '.' + createHmac('sha256', key).update('dialogues-turn-v1:' + p).digest('base64url'); }
function unsign(key: string, value: unknown) { try {
    if (typeof value !== 'string' || value.length > 4096)
        fail('INVALID_CURSOR');
    const [p, s, x] = value.split('.');
    if (!p || !s || x)
        fail('INVALID_CURSOR');
    const a = createHmac('sha256', key).update('dialogues-turn-v1:' + p).digest(), b = Buffer.from(s, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b))
        fail('INVALID_CURSOR');
    return JSON.parse(Buffer.from(p, 'base64url').toString());
}
catch {
    return fail('INVALID_CURSOR');
} }
/** Создаёт операции хода; запись выполняется в сериализованной транзакции владельца. */
export function createTurns(pool: DB, key: string, mutation: Mutation, contextApi: ReturnType<typeof createContext>) {
    function optionalAck(raw: unknown, requestId: string) {
        if (raw === undefined) return undefined;
        const a = object(raw,['request_id','consumer_id','context_instance_id','delivery_id']);
        for (const field of ['request_id','consumer_id','context_instance_id','delivery_id']) fieldId(a[field],`ack.${field}`);
        if (a.request_id === requestId) throw new DialoguesFault('INVALID_ARGUMENT',{field:'ack.request_id',expected:'ID, отличный от ID основной операции'});
        return a;
    }
    async function input(owner: string, raw: unknown) {
        const a = object(raw, ['request_id', 'dialogue', 'messages', 'reconciled_no_final', 'context', 'ack']);
        if (a.reconciled_no_final !== undefined && typeof a.reconciled_no_final !== 'boolean')
            fail('INVALID_ARGUMENT');
        fieldId(a.request_id, 'request_id');
        const d = object(a.dialogue, ['id', 'channel', 'title']);
        fieldId(d.id, 'dialogue.id');
        fieldId(d.channel, 'dialogue.channel');
        if (d.title !== undefined)
            text(d.title, 1024);
        if (!Array.isArray(a.messages) || !a.messages.length || a.messages.length > 100)
            throw new DialoguesFault('INVALID_ARGUMENT', { field: 'messages', expected: 'массив из 1–100 входов' });
        if (bytes(raw) > limits.requestBytes)
            fail('REQUEST_TOO_LARGE');
        const ack = optionalAck(a.ack, a.request_id);
        let context: Record<string, any> | undefined;
        if (a.context !== undefined) {
            context=object(a.context,['consumer_id','context_instance_id','reset']);
            fieldId(context.consumer_id,'context.consumer_id');fieldId(context.context_instance_id,'context.context_instance_id');
            if (context.reset !== undefined && typeof context.reset !== 'boolean')
                throw new DialoguesFault('INVALID_ARGUMENT',{field:'context.reset',expected:'логическое значение'});
        }
        const messages = a.messages.map((m: unknown) => message(m, 'input'));
        if (new Set(messages.map((m: any) => m.id)).size !== messages.length)
            fail('DUPLICATE_MESSAGE_ID');
        const receipt = await mutation(owner, a.request_id, 'turn_input', a, async (db, seq) => {
            const ackReceipt = ack ? await contextApi.ackInTransaction(db,owner,ack) : undefined;
            const existing = (await db.query('SELECT channel FROM dialogues_live.dialogues WHERE owner_id=$1 AND id=$2', [owner, d.id])).rows[0];
            if (existing && existing.channel !== d.channel)
                fail('DIALOGUE_CONFLICT');
            await db.query('INSERT INTO dialogues_live.dialogues(owner_id,id,channel,title) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [owner, d.id, d.channel, d.title ?? d.id]);
            const prior = (await db.query("SELECT id,turn_id,payload,content_hash,message_order FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND id=ANY($3::text[])", [owner, d.id, messages.map((m: any) => m.id)])).rows;
            if (prior.length === messages.length) {
                const tid = prior[0].turn_id;
                if (prior.some((p: any) => p.turn_id !== tid))
                    fail('MESSAGE_CONFLICT');
                const previous = await lookup(db, owner, d.id, tid);
                if (previous.status === 'completed') {
                    const saved = [];
                    for (const m of messages)
                        saved.push(await insertMessage(db, owner, d.id, tid, m, 'input', seq));
                    return { request_id: a.request_id, dialogue_id: d.id, turn_id: tid, version: String(previous.version), created: false, messages: saved, ...(ackReceipt?{ack:ackReceipt}:{}) };
                }
            }
            if (prior.length) {
                const active = (await db.query("SELECT id FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 AND managed AND status<>'completed'", [owner, d.id])).rows[0];
                if (!active || prior.some((p: any) => p.turn_id !== active.id))
                    fail('MESSAGE_CONFLICT');
            }
            let t = (await db.query("SELECT * FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 AND managed AND status<>'completed'", [owner, d.id])).rows[0];
            let reconciled = false;
            if (t) {
                const candidate = (await db.query("SELECT MAX(message_order)::text AS n FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND kind='final' AND message_order>COALESCE($4::bigint,-1)", [owner, d.id, t.id, t.reconciled_through_order])).rows[0].n;
                if (candidate !== null) {
                    if (a.reconciled_no_final !== true)
                        fail('FINAL_RECONCILIATION_REQUIRED');
                    await db.query('UPDATE dialogues_live.turns SET reconciled_through_order=$4 WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3', [owner, d.id, t.id, candidate]);
                    reconciled = true;
                }
            }
            else if (a.reconciled_no_final === true)
                fail('NO_FINAL_TO_RECONCILE');
            const created = !t;
            if (!t) {
                const legacy = (await db.query('SELECT managed,status FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 ORDER BY turn_order DESC LIMIT 1', [owner, d.id])).rows[0];
                if (legacy && !legacy.managed && legacy.status !== 'completed')
                    fail('LEGACY_TURN_OPEN');
                const tid = randomUUID();
                const order = (await db.query('SELECT COALESCE(MAX(turn_order),-1)+1 AS n FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2', [owner, d.id])).rows[0].n;
                await db.query("INSERT INTO dialogues_live.turns(owner_id,dialogue_id,id,turn_order,status,change_seq,managed,version) VALUES($1,$2,$3,$4,'in_progress',$5,true,0)", [owner, d.id, tid, order, seq]);
                await db.query("INSERT INTO dialogues_live.turn_results(owner_id,dialogue_id,turn_id,id,kind,formulation,status) VALUES($1,$2,$3,'final','final','Финальный ответ','pending')", [owner, d.id, tid]);
                t = { id: tid, version: '0' };
            }
            const saved = [];
            for (const m of messages)
                saved.push(await insertMessage(db, owner, d.id, t.id, m, 'input', seq));
            const changed = reconciled || saved.some(m => !m.replayed);
            const v = changed ? await bump(db, owner, d.id, t.id, seq) : String(t.version);
            if (changed)
                await enqueueDialogue(db, owner, d.id, seq, false);
            return { request_id: a.request_id, dialogue_id: d.id, turn_id: t.id, version: v, created, messages: saved, ...(ackReceipt?{ack:ackReceipt}:{}) };
        });
        if (!context) return receipt;
        const contextRequestId = 'turn-context-' + hash(a.request_id);
        const contextRequest = {request_id:contextRequestId,dialogue_id:d.id,...context};
        try {
            const page = await contextApi.pull(owner,contextRequest);
            const combined = {...receipt,context_request_id:contextRequestId,context:page};
            if (bytes(combined) <= limits.responseBytes - 256) return combined;
            return {...receipt,input_saved:true,context_request_id:contextRequestId,context_error:{code:'CONTEXT_DEFERRED',next_action:'Получите страницы через dialogues_context_pull с указанными аргументами',arguments:contextRequest}};
        } catch(error) {
            return {...receipt,input_saved:true,context_request_id:contextRequestId,context_error:{code:error instanceof DialoguesFault?error.code:'CONTEXT_UNAVAILABLE',next_action:'Ввод сохранён; получите контекст отдельно с указанными аргументами',arguments:contextRequest}};
        }
    }
    async function update(owner: string, raw: unknown) {
        const a = object(raw, ['request_id', 'dialogue_id', 'turn_id', 'expected_version', 'changes', 'ack']);
        fieldId(a.request_id, 'request_id');
        fieldId(a.dialogue_id, 'dialogue_id');
        fieldId(a.turn_id, 'turn_id');
        version(a.expected_version);
        const changes = validateChanges(a.changes);
        const ack=optionalAck(a.ack,a.request_id);
        return mutation(owner, a.request_id, 'turn_update', a, async (db, seq) => {
            const ackReceipt=ack?await contextApi.ackInTransaction(db,owner,ack):undefined;
            const t=await lookup(db,owner,a.dialogue_id,a.turn_id);
            if(t.status==='completed')fail('TURN_CLOSED');
            if(String(t.version)!==a.expected_version)fail('VERSION_CONFLICT');
            const changed=await applyChanges(db,owner,a.dialogue_id,a.turn_id,changes);
            return {request_id:a.request_id,dialogue_id:a.dialogue_id,turn_id:a.turn_id,version:changed?await bump(db,owner,a.dialogue_id,a.turn_id,seq):String(t.version),changed,...(ackReceipt?{ack:ackReceipt}:{})};
        });
    }
    async function get(owner: string, raw: unknown) {
        const a = object(raw, ['dialogue_id', 'turn_id', 'cursor']);
        id(a.dialogue_id);
        if (a.turn_id !== undefined)
            id(a.turn_id);
        const c = a.cursor === undefined ? null : unsign(key, a.cursor);
        if (c && (c.owner !== owner || c.dialogue !== a.dialogue_id || (a.turn_id !== undefined && a.turn_id !== c.turn)))
            fail('INVALID_CURSOR');
        const db = await pool.connect();
        try {
            await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const turn = c?.turn ?? a.turn_id ?? (await db.query("SELECT id FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 AND managed AND status<>'completed'", [owner, a.dialogue_id])).rows[0]?.id;
            if (!turn)
                fail('NOT_FOUND');
            const t = await lookup(db, owner, a.dialogue_id, turn);
            if (c && String(t.version) !== c.version)
                fail('VERSION_CONFLICT');
            if(c && c.through===undefined)
                fail('INVALID_CURSOR');
            const through = c?.through ?? (await db.query('SELECT COALESCE(MAX(change_seq),0)::text AS seq FROM dialogues_live.requests WHERE owner_id=$1',[owner])).rows[0].seq;
            if(typeof through!=='string'||!/^[0-9]+$/.test(through))fail('INVALID_CURSOR');
            const messages = (await db.query(`SELECT m.id,m.role,m.kind,CASE WHEN char_length(m.text)<=100 THEN m.text ELSE s.text END AS text,
                m.source,m.occurred_at,m.recorded_at,m.message_order,m.item_order,m.content_hash AS sha256
                FROM dialogues_live.messages m LEFT JOIN LATERAL(
                    SELECT text FROM dialogues_live.message_summaries WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id AND change_seq<=$4 ORDER BY version DESC LIMIT 1
                )s ON true WHERE m.owner_id=$1 AND m.dialogue_id=$2 AND m.turn_id=$3 AND m.change_seq<=$4 AND m.kind IN ('input','final') ORDER BY m.message_order`, [owner, a.dialogue_id, turn, through])).rows;
            if(messages.some((m:any)=>m.text===null))fail('SUMMARY_REQUIRED');
            for (const m of messages)
                if (m.kind === 'final')
                    m.final_state = t.final_message_id === m.id ? 'recorded' : (t.reconciled_through_order !== null && BigInt(m.message_order) <= BigInt(t.reconciled_through_order) ? 'reconciled_absent' : 'awaiting_reconciliation');
            const results = (await db.query('SELECT id,kind,formulation,source_refs,status,result,verification,reason,remainder,created_at,updated_at FROM dialogues_live.turn_results WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 ORDER BY created_at,id', [owner, a.dialogue_id, turn])).rows;
            // Фрагменты передают полный снимок и не задают смысловой предел его размера.
            const snapshot = JSON.stringify({ dialogue_id: a.dialogue_id, turn_id: turn, version: String(t.version), status: t.status, purpose: t.purpose, constraints: t.constraints_text, messages, results, pending: results.filter((r: any) => r.kind === 'work' && r.status === 'pending') });
            const chars = Array.from(snapshot);
            const offset = c?.offset ?? 0;
            integer(offset);
            if (offset > chars.length)
                fail('INVALID_CURSOR');
            let end = Math.min(chars.length, offset + 8000);
            while (end > offset && bytes(chars.slice(offset, end).join('')) > 24000)
                end--;
            const next = end < chars.length ? sign(key, { owner, dialogue: a.dialogue_id, turn, version: String(t.version), through, offset: end }) : null;
            await db.query('COMMIT');
            return { dialogue_id: a.dialogue_id, turn_id: turn, version: String(t.version), representation: 'json_fragments', offset, text: chars.slice(offset, end).join(''), next_cursor: next, total_chars: chars.length, total_bytes: Buffer.byteLength(snapshot), sha256: hash(snapshot) };
        }
        catch (e) {
            await db.query('ROLLBACK').catch(() => { });
            throw e;
        }
        finally {
            db.release();
        }
    }
    async function finish(owner: string, raw: unknown) {
        const a = object(raw, ['request_id', 'dialogue_id', 'turn_id', 'expected_version', 'final', 'changes', 'ack']);
        fieldId(a.request_id, 'request_id');
        fieldId(a.dialogue_id, 'dialogue_id');
        fieldId(a.turn_id, 'turn_id');
        version(a.expected_version);
        const final = message(a.final, 'final'), changes = validateChanges(a.changes);
        const ack=optionalAck(a.ack,a.request_id);
        return mutation(owner, a.request_id, 'turn_finish', a, async (db, seq) => {
            const ackReceipt=ack?await contextApi.ackInTransaction(db,owner,ack):undefined;
            const t = await lookup(db, owner, a.dialogue_id, a.turn_id);
            if (t.status === 'completed')
                fail('TURN_CLOSED');
            if (String(t.version) !== a.expected_version)
                fail('VERSION_CONFLICT');
            await applyChanges(db, owner, a.dialogue_id, a.turn_id, changes);
            await requireNoPending(db, owner, a.dialogue_id, a.turn_id);
            if ((await db.query("SELECT 1 FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND kind='final' AND message_order>COALESCE($4::bigint,-1)", [owner, a.dialogue_id, a.turn_id, t.reconciled_through_order])).rowCount)
                fail('FINAL_RECONCILIATION_REQUIRED');
            if ((await db.query('SELECT 1 FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3', [owner,a.dialogue_id,final.id])).rowCount)
                fail('FINAL_ID_ALREADY_EXISTS');
            const saved = await insertMessage(db, owner, a.dialogue_id, a.turn_id, final, 'final', seq);
            await db.query("UPDATE dialogues_live.turn_results SET status='done',result=$4,updated_at=now() WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND kind='final'", [owner, a.dialogue_id, a.turn_id, final.text]);
            await db.query("UPDATE dialogues_live.turns SET status='completed',completion_seq=$4,final_message_id=$5 WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3", [owner, a.dialogue_id, a.turn_id, seq, final.id]);
            const v = await bump(db, owner, a.dialogue_id, a.turn_id, seq);
            await enqueueDialogue(db, owner, a.dialogue_id, seq, false);
            return { request_id: a.request_id, dialogue_id: a.dialogue_id, turn_id: a.turn_id, version: v, final: saved, status: 'completed', ...(ackReceipt?{ack:ackReceipt}:{}) };
        });
    }
    async function repair(owner: string, raw: unknown) {
        const a = object(raw, ['request_id', 'dialogue_id', 'turn_id', 'expected_version', 'final_message_id', 'evidence', 'changes']);
        for (const k of ['request_id', 'dialogue_id', 'turn_id', 'final_message_id'])
            fieldId(a[k], k);
        version(a.expected_version);
        const evidence = object(a.evidence, ['kind', 'native_thread_id', 'native_turn_id', 'phase', 'status']);
        if (evidence.kind !== 'native_client' || evidence.phase !== 'final_answer' || evidence.status !== 'completed')
            fail('FINAL_EVIDENCE_REQUIRED');
        id(evidence.native_thread_id);
        id(evidence.native_turn_id);
        const changes = validateChanges(a.changes);
        return mutation(owner, a.request_id, 'turn_repair', a, async (db, seq) => {
            const t = await lookup(db, owner, a.dialogue_id, a.turn_id);
            if (t.status === 'completed')
                fail('TURN_CLOSED');
            if (String(t.version) !== a.expected_version)
                fail('VERSION_CONFLICT');
            const final = (await db.query("SELECT id,text,source,message_order FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND id=$4 AND kind='final'", [owner, a.dialogue_id, a.turn_id, a.final_message_id])).rows[0];
            if (!final)
                fail('FINAL_NOT_FOUND');
            if (t.reconciled_through_order !== null && BigInt(final.message_order) <= BigInt(t.reconciled_through_order))
                fail('FINAL_ALREADY_RECONCILED');
            if (final.source?.native_thread_id !== evidence.native_thread_id || final.source?.native_turn_id !== evidence.native_turn_id || final.source?.phase !== 'final_answer' || final.source?.status !== 'completed')
                fail('FINAL_SOURCE_MISMATCH');
            await applyChanges(db, owner, a.dialogue_id, a.turn_id, changes);
            await requireNoPending(db, owner, a.dialogue_id, a.turn_id);
            await db.query("UPDATE dialogues_live.turn_results SET status='done',result=$4,verification=$5,updated_at=now() WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND kind='final'", [owner, a.dialogue_id, a.turn_id, final.text, JSON.stringify(evidence)]);
            await db.query("UPDATE dialogues_live.turns SET status='completed',completion_seq=$4,final_message_id=$5 WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3", [owner, a.dialogue_id, a.turn_id, seq, final.id]);
            await enqueueDialogue(db, owner, a.dialogue_id, seq, false);
            return { request_id: a.request_id, dialogue_id: a.dialogue_id, turn_id: a.turn_id, version: await bump(db, owner, a.dialogue_id, a.turn_id, seq), status: 'completed', final_message_id: final.id };
        });
    }
    return { turnInput: input, turnUpdate: update, turnGet: get, turnFinish: finish, turnRepair: repair };
}
