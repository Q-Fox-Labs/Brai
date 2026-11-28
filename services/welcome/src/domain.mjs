// ABOUTME: Определяет поведение справочной для текста, анкеты и квот.
// ABOUTME: Модель может предложить только действие из закрытого словаря; эффекты выполняет сервис.
export const GREETING = 'Привет! Я Брай. Здесь можно узнать, как работает Брай, и подать заявку на гостевой доступ. Переписка сохраняется, её могут просматривать уполномоченные администраторы.';
export const DISABLED = 'Приветственный режим Брая сейчас выключен.';
export const REJECT_FILE = 'В приветственном режиме Брай не принимает файлы. Отправьте текст или аудио до 10 минут.';
export const REJECT_AUDIO = 'В приветственном режиме можно отправлять аудио длительностью до 10 минут.';
export const APPLY_INTRO = 'Ваши ответы помогут сделать персонального агента полезнее.';
export const QUESTIONS = {
 occupation: 'Чем вы занимаетесь?',
 purpose: 'Для чего вам нужен персональный ИИ-агент?'
};

export const ACTIONS = ['answer', 'voice-on', 'voice-off', 'referral', 'apply', 'question', 'image'];
const NO_DIRECT_REQUEST = new Set(['voice-on','voice-off','referral','apply','question']);

export const OUTPUT_SCHEMA = {
 type:'object', additionalProperties:false, required:['action','text','valid'],
 properties:{action:{type:'string',enum:ACTIONS},text:{type:'string'},valid:{type:'boolean'}}
};

/** Возвращает проверенный текст и допустимое действие для текущего хода. */
export function decision(value, question) {
 if (!value || typeof value !== 'object' || !ACTIONS.includes(value.action)
     || typeof value.text !== 'string' || typeof value.valid !== 'boolean') throw Error('WELCOME_MODEL_RESPONSE_INVALID');
 if (value.action === 'question' && !question) return {...value, action:'answer'};
 return value;
}

/** Состояние анкеты хранится у пользователя; подтверждение возможно после обоих ответов. */
export function nextQuestion(draft) {
 if (!draft) return null;
 if (!draft.occupation) return 'occupation';
 if (!draft.purpose) return 'purpose';
 return null;
}

/** Учитываются только прямые запросы и фактические запросы на генерацию. */
export function charges(action) {
 return {request:!NO_DIRECT_REQUEST.has(action), image:action==='image'};
}

/** Возвращает время, когда освободится место, включая случай уменьшения настройки лимита. */
export function nextSlot(timestamps, limit, now) {
 const day = 24 * 60 * 60 * 1000;
 if (limit === 0) return {denied:true, at:null};
 const active = timestamps.map(Number).filter(at => at > now - day).sort((a,b) => a-b);
 if (active.length < limit) return {denied:false, at:null};
 return {denied:true, at:new Date(active[active.length-limit]+day).toISOString()};
}

export function quotaNotice(label, at) {
 return at ? `Лимит ${label} исчерпан. Следующая попытка доступна ${at.replace('T',' ').slice(0,19)} UTC.`
  : `Лимит ${label} исчерпан. Генерация отключена настройками.`;
}

/** Telegram start-аргумент реферала отделён от приглашений Hermes. */
export function referralCode(text) {
 return /^\/start(?:@[\w]+)?\s+ref_([A-Za-z0-9_-]+)$/.exec(text?.trim() ?? '')?.[1] ?? null;
}
