// ABOUTME: Связывает Telegram, личную переписку, справочную и заявки через узкие порты.
// ABOUTME: Сторона модели возвращает только предложение. Сервис проверяет и применяет операции.
import {APPLY_INTRO, charges, decision, DISABLED, GREETING, nextQuestion, nextSlot,
 QUESTIONS, quotaNotice, referralCode, REJECT_AUDIO, REJECT_FILE} from './domain.mjs';
import {capture, saveDraft, submitApplication, usage, withVisitor} from './storage.mjs';

const initial = /^\/start(?:@[\w]+)?(?:\s|$)/;

/** Стабильный ключ одной темы Telegram, общий для Welcome и гостевого MCP. */
export const dialogueId = event => `telegram:${event.botId}:${event.telegramId}:${event.threadId??0}`;
const origin = (event, phase) => `tg-welcome:${event.botId}:${event.updateId}:${phase}`;
const summary = text => Array.from(text).length>100 ? {summary:Array.from(text).slice(0,100).join('')} : {};
const answer = (text, voice, extras = {}) => ({text,voice,...extras});

/** Создаёт обработчик Welcome. Auth, MCP, модель, ASR и изображения передаются как порты. */
export function createWelcome(ports) {
 const {pool, auth, dialogues, model, transcribe, image, synthesize, botName} = ports;

 async function apply(db, visitor, event, parsed, input, settings, turn, now) {
  const question=nextQuestion(visitor.questionnaire);
  const voice=visitor.voice_enabled;
  switch (parsed.action) {
   case 'voice-on':
   case 'voice-off': {
    const enabled=parsed.action==='voice-on';
    await db.query('UPDATE welcome.visitors SET voice_enabled=$2 WHERE user_id=$1',[visitor.user_id,enabled]);
    return answer(enabled?'Голосовые ответы включены.':'Буду отвечать только текстом.',enabled);
   }
   case 'referral':
    return answer(`Ваша реферальная ссылка: https://t.me/${botName}?start=ref_${visitor.referral_code}`,voice);
   case 'apply': {
    const {rows:[record]}=await db.query("SELECT status FROM welcome.applications WHERE user_id=$1 AND status IN ('pending','approving','approved') LIMIT 1",[visitor.user_id]);
    if(record) return answer('У вас уже есть заявка на доступ.',voice);
    if(!visitor.questionnaire) await saveDraft(db,visitor,{});
    const field=nextQuestion(visitor.questionnaire);
    return field ? answer(APPLY_INTRO+'\n\n'+QUESTIONS[field],voice)
     : answer('Проверьте ответы и подтвердите отправку.',voice,{button:'submit'});
   }
   case 'question': {
    if(!question) return answer('Проверьте ответы и подтвердите отправку.',voice,{button:'submit'});
    if(!parsed.valid || !input.trim()) return answer(parsed.text ? parsed.text+'\n\n'+QUESTIONS[question] : QUESTIONS[question],voice);
    await saveDraft(db,visitor,{...visitor.questionnaire,[question]:input});
    const field=nextQuestion(visitor.questionnaire);
    if(field) return answer(QUESTIONS[field],voice);
    return answer('Анкета заполнена. Подтвердите отправку заявки.',voice,{button:'submit'});
   }
   case 'image': {
    if(!settings.image_enabled) return answer('Генерация изображений в приветственном режиме сейчас выключена.',voice);
    const request=turn.image_request??{prompt:parsed.text||input,deadlineAt:new Date(+now+180_000).toISOString()};
    if(!turn.image_request)await db.query('UPDATE welcome.turns SET image_request=$3 WHERE bot_id=$1 AND update_id=$2',
     [event.botId,event.updateId,request]);
    try{
     const artifact=await image({owner:visitor.user_id,operationId:origin(event,'image'),...request});
     return answer('Изображение готово.',voice,{image:artifact});
    }catch{
     return answer('Генератор не подтвердил, что изображение готово. Попробуйте позже.',voice);
    }
   }
   default:
    return answer(parsed.text.trim() || 'Задайте вопрос о работе Брая или попросите оформить гостевой доступ.',voice);
  }
 }

 async function runTurn(db, visitor, event, settings, input) {
  const id=dialogueId(event);
  const args=[event.botId,event.updateId];
  const turn=await capture(db,visitor,event,id,input);
  const endpoint=await dialogues(visitor);
  try {
   let receipt=turn.input_receipt;
   if(!receipt){
    receipt=await endpoint.exchange('input',{
     request_id:origin(event,'input'),dialogue:{id,channel:'telegram'},
     messages:[{id:origin(event,'message'),text:turn.input_text,...summary(turn.input_text)}]
    });
    await db.query('UPDATE welcome.turns SET input_receipt=$3 WHERE bot_id=$1 AND update_id=$2',[...args,receipt]);
   }
   let result=turn.result;
   if(!result){
    if(event.action==='submit'){
     const application=await submitApplication(db,visitor);
     result=answer(application?'Заявка отправлена.':'Сначала заполните анкету.',visitor.voice_enabled);
    }else if(initial.test(turn.input_text)){
     result=answer(GREETING,false);
    }else{
     const question=nextQuestion(visitor.questionnaire);
     const {rows}=await db.query(`SELECT input_text AS input,result->>'text' AS answer FROM welcome.turns
      WHERE user_id=$1 AND dialogue_id=$2 AND result IS NOT NULL
      ORDER BY created_at DESC,update_id DESC LIMIT 12`,[visitor.user_id,id]);
     const context=rows.reverse().map(row=>({input:Array.from(row.input).slice(0,1000).join(''),
      answer:Array.from(row.answer).slice(0,1000).join('')}));
     const parsed=turn.image_request?{action:'image',text:turn.image_request.prompt}:
      decision(await model.respond({text:turn.input_text,context,question:question&&QUESTIONS[question],settings}),question);
     const charge=charges(parsed.action);
     const meter=await usage(db,visitor.user_id);
     const general=charge.request && !turn.request_at && nextSlot(meter.requests,settings.request_limit,+meter.now);
     const pictures=charge.image && settings.image_enabled && !turn.image_at && nextSlot(meter.images,settings.image_limit,+meter.now);
     if(general?.denied) result=answer(quotaNotice('запросов',general.at),visitor.voice_enabled);
     else if(pictures?.denied) result=answer(quotaNotice('изображений',pictures.at),visitor.voice_enabled);
     else{
      await db.query(`UPDATE welcome.turns SET request_at=CASE WHEN $3 THEN COALESCE(request_at,$5) ELSE request_at END,
       image_at=CASE WHEN $4 THEN COALESCE(image_at,$5) ELSE image_at END WHERE bot_id=$1 AND update_id=$2`,
       [...args,charge.request,charge.image && settings.image_enabled,meter.now]);
      result=await apply(db,visitor,event,parsed,turn.input_text,settings,turn,meter.now);
     }
    }
    if(result.voice&&synthesize){
     const spoken=result.text.replace(/https?:\/\/\S+/gu,'').replace(/[^А-Яа-яЁё\s.,!?;:—–\-…«»"'()]/gu,' ').trim();
     if(spoken) {
      try{
       const segments=Array.from(spoken);
       result.audio=[];
       for(let offset=0;offset<segments.length;offset+=900){
        const text=segments.slice(offset,offset+900).join('').trim();
        if(text)result.audio.push(await synthesize(visitor.user_id,text,origin(event,'voice-'+offset)));
       }
      }
      catch{/* AIDEV-NOTE: Текст остаётся доставляемым при отказе Local AI. */}
     }
    }
    await db.query('UPDATE welcome.turns SET result=$3 WHERE bot_id=$1 AND update_id=$2',[...args,result]);
   }
   await endpoint.exchange('finish',{request_id:origin(event,'finish'),dialogue_id:id,turn_id:receipt.turn_id,
    expected_version:receipt.version,final:{id:origin(event,'answer'),text:result.text,...summary(result.text)}});
   return result;
  }finally{await endpoint.close();}
 }

 return {
  /** Обрабатывает подтверждённый приватный update. Данные владельца поступают только из Auth. */
  async handle(event){
   const settings=(await pool.query('SELECT * FROM welcome.settings WHERE singleton')).rows[0];
   if(!settings.enabled) return answer(DISABLED,false);
   if(event.kind==='file') return answer(REJECT_FILE,false);
   if(event.kind==='audio' && (!Number.isFinite(event.duration)||event.duration<=0||event.duration>600)) return answer(REJECT_AUDIO,false);
   const existing=await auth.resolve(event.telegramId);
   if(existing?.role==='guest'&&existing.status==='provisioning'){
    const application=await pool.query(`SELECT 1 FROM welcome.applications WHERE user_id=$1 AND status='approving'`,[existing.id]);
    if(application.rowCount) return answer('Гостевой профиль ещё готовится. Напишите чуть позже.',false);
   }
   if(existing && (existing.role!=='welcome'||existing.status!=='provisioning')) return {pass:true};
   const identity=existing??await auth.register({requestId:origin(event,'register'),telegramId:event.telegramId,name:event.name});
   if(identity.role!=='welcome'||identity.status!=='provisioning') return {pass:true};
   return withVisitor(pool,identity,{id:event.telegramId,name:event.name,username:event.username??null,avatarFileId:event.avatarFileId??null},referralCode(event.text),async (db,visitor)=>{
    const remembered=(await db.query('SELECT input_text FROM welcome.turns WHERE bot_id=$1 AND update_id=$2',[event.botId,event.updateId])).rows[0];
    const input=remembered?.input_text??(event.kind==='audio'?await transcribe(event,identity):event.action==='submit'?'Подтверждаю отправку заявки':event.text);
    if(input===null&&event.kind==='audio') return answer(REJECT_AUDIO,false);
    if(typeof input!=='string'||!input.trim()) return answer('Не удалось получить текст сообщения. Попробуйте написать его.',false);
    return runTurn(db,visitor,event,settings,input);
   });
  }
 };
}
