// ABOUTME: Формирует пакет текущей Операции и вызывает принятый сборщик без переписывания правил.
// ABOUTME: Не сохраняет ресурсы и не подтверждает постановку; owner транзакция применяет его результат.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GameCoreFault } from './domain.js';

type Value = Record<string, any>;
type PlanningPhase = 'input' | 'bind' | 'build' | 'review' | 'expand';
// AIDEV-NOTE: Только константные сообщения принятого сборщика; динамические ошибки могут содержать входы или пути.
const planningReasons = new Set([
 'Путь вне прогона', 'Нужны ровно 12 полей Элемента', 'Неизвестный тип результата',
 'Неполный контракт итога', 'Гипотеза не угадывает неизвестный итог',
 'Несколько производителей результата', 'Нужна цепочка результатов', 'Неверный узел результата',
 'Нет производителя узла результата или повтор узла',
 'Два самостоятельных результата склеены в одном Ходе или ребёнке',
 'Цикл, повтор или неизвестный предшествующий результат',
 'Зависимость результата не передана входным ресурсом', 'В цепочке пропущена ресурсная зависимость',
 'Повторение требует входного перечня и шаблона Хода', 'Цепочка не покрывает все Ходы или детей',
 'Порядок карточек отличается от цепочки результатов', 'Неверный состав предметного плана',
 'Неизвестный уровень', 'Граница относится к другому Элементу', 'Неверный владелец границ',
 'Нужны списки детей и работы', 'Минимальный уровень или число детей нарушены',
 'Повтор ресурса в пакете', 'Неизвестная доступность ресурса', 'Повтор или пустая локальная ссылка',
 'Неверное определение ресурса', 'Неизвестная ресурсная ссылка', 'Ссылка не на ресурс или повтор ссылки',
 'Входы изменены без источника', 'Изменён контракт результата ребёнка',
 'Собственный итог потребован на входе', 'Вход отсутствует в пакете',
 'Ресурс имеет несколько производителей или уже существует', 'Нельзя переопределить переданный ресурс',
 'Неверные вопросы', 'Неясный итог требует вопросов, а не выдуманного плана',
 'Неверный тип ребёнка', 'Ребёнок ждёт ресурс без предшествующего производителя',
 'Неверное отложенное продолжение', 'Нет основания отложенной части',
 'Нет результата раскрытия или повтор раскрытия', 'Перечень раскрывается повторением, а не неизвестной постановкой',
 'Неверные поля предметного Хода', 'Неизвестный исполнитель', 'Пустой предметный Ход',
 'Нет проверяемого результата', 'Нет выхода либо вход получен после использования',
 'Нет основания конечного ресурса', 'Итог ребёнка не участвует в общем результате',
 'Итог приёмки создан до приёмки', 'Объявлен ресурс без производителя',
 'Нет нераскрытого повторения', 'Перечень относится к другому ресурсу', 'Нужен фактический перечень объектов',
 'Объекту нужны устойчивый ID и название', 'Повтор объекта в перечне',
 'Проверяющий получил другой пакет', 'Нет независимых требований или повтор ID',
 'Нет основания требования', 'Требование не разделено на результат или условие',
 'Неверная граница результата', 'Условие не задаёт этап или повторение',
 'Результату Хода нужно одно наблюдаемое свойство объекта', 'Критерии Операции уже зафиксированы',
 'До сборки зафиксируй независимые критерии командой bind', 'Изменены зафиксированные критерии или входы',
 'Цикл квитанций', 'Версия уже существует', 'Подменены критерии между версиями',
 'Изменено независимое основание проверки', 'Проверена другая версия', 'Не все требования проверены',
 'Сборка не соответствует предметному плану', 'Проверка не выделила самостоятельных результатов',
 'Пустое покрытие или повтор ссылки', 'Результат должен ссылаться на один явный узел цепочки',
 'Два независимых результата проверки склеены в одном узле', 'Потеряно или выдумано повторение по объектам',
 'Требование ссылается на отсутствующую работу', 'Цикл независимых результатов',
 'Нарушен порядок независимых результатов', 'Ребёнок не найден',
]);
/** Передаёт этап и безопасную причину отказа; исходный код ошибки остаётся совместимым. */
export class PlanningFault extends GameCoreFault {
 readonly diagnostic: { phase: PlanningPhase; reason: string };
 constructor(phase: unknown, reason: unknown) {
  super('INVALID_ARGUMENT');
  this.diagnostic = {
   phase: ['input', 'bind', 'build', 'review', 'expand'].includes(phase as string) ? phase as PlanningPhase : 'input',
   reason: typeof reason === 'string' && planningReasons.has(reason) ? reason : 'Неверная структура данных планирования',
  };
 }
}
const root = new URL('../planning/', import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL('baseline.json', root), 'utf8'));
/** Стабильный UUID адаптера; не заменяет собственные UUID нормативного сборщика. */
export function planningId(seed: string): string {
 const h=createHash('sha256').update(seed).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** Хеширует канонически отсортированный JSON, включая содержимое входов и ревизию. */
export function digest(value: any): string {
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const serialize=(v:any)=>JSON.stringify(v,null,2)+'\n';
/** Загружает только закреплённые правила, проверяя точные принятые байты. */
export function planningRules(): Record<string,string> {
 const files:Record<string,string>={};
 for(const [name, info] of Object.entries(baseline.files) as [string,Value][]) {
  const content=readFileSync(new URL(name,root),'utf8');
  if(createHash('sha256').update(content).digest('hex')!==info.sha256)throw new GameCoreFault('INTERNAL');
  if(name.endsWith('.md'))files[`rules/${name}`]=content;
 }
 return files;
}
/** Собирает из выбранных реальных входов пакет, одинаковый для автора и проверяющего. */
export function planningFiles(element:Value, revision:Value, move:Value, resources:Value[], finish:Value|null):Record<string,string> {
 const fields:Value={};
 for(const key of 'title summary inputs context scope constraints preferences unknowns hypothesis expected_result result_types outputs'.split(' '))fields[key]=['inputs','outputs','result_types'].includes(key)?[]:'';
 Object.assign(fields,revision.fields?.draft??(element.parent_id?Object.fromEntries(Object.keys(fields).filter(key=>revision.fields?.[key]!==undefined).map(key=>[key,revision.fields[key]])):{}));
 fields.inputs=resources.map(r=>r.id);
 const rules=planningRules();
 const operation={id:move.id,owner:move.element_id,target:element.id,title:move.title,actor:'agent',purpose:'plan',previous:move.previous_move_id,pending_confirmation_id:move.fields?.pending_confirmation_id??null};
 const packet={element:{id:element.id,kind:({task:'Задача',goal:'Цель',quest:'Квест'} as Value)[element.kind??'task'],parent:element.parent_id,classification:element.provenance?.classification??null},operation,
  finish:{id:finish?.id??planningId(`${move.id}:finish`),owner:finish?.element_id??move.element_id,target:element.id},draft:fields,
  resources:[...resources.map(r=>({id:r.id,name:r.title,content:r.content,state:'given',producer:null})),...(revision.fields?.planning_context?.outputs??[]).filter((r:Value)=>!resources.some(x=>x.id===r.id))],
  context_files:[...new Set([...resources.map(r=>`inputs/${r.id}.md`),...Object.keys(revision.fields?.planning_context?.files??{})])],rules:Object.keys(rules)};
 return {'packet.json':serialize(packet),...Object.fromEntries(resources.map(r=>[`inputs/${r.id}.md`,r.content])),...(revision.fields?.planning_context?.files??{}),...rules};
}
/** Отдельная постановка получает новые UUID Ходов/будущих выходов; границы и реальные входы сохраняются. */
function operationIds(result:Value,files:Record<string,string>):Value {
 if(!result.stage)return result;
 const stage=result.stage,packet=JSON.parse(files['packet.json']),operation=packet.operation.id;
 const mapped=new Map<string,string>();
 for(const record of stage.records)if(record.id!==stage.finish.id)mapped.set(record.id,planningId(`${operation}:${record.id}`));
 if(packet.operation.pending_confirmation_id){const confirmation=stage.records.find((r:Value)=>r.purpose==='confirm');if(confirmation)mapped.set(confirmation.id,packet.operation.pending_confirmation_id);}
 for(const child of stage.children??[]){mapped.set(child.element.id,planningId(`${operation}:${child.element.id}`));mapped.set(child.operation.id,planningId(`${operation}:${child.operation.id}`));mapped.set(child.finish.id,planningId(`${operation}:${child.finish.id}`));}
 const inherited=new Set(JSON.parse(files['packet.json']).resources.filter((r:Value)=>r.state==='expected').map((r:Value)=>r.id));
 for(const resource of stage.resources)if(resource.state==='expected'&&!inherited.has(resource.id))mapped.set(resource.id,planningId(`${operation}:${resource.id}`));
 const remap=(v:any):any=>typeof v==='string'?(mapped.get(v)??v):Array.isArray(v)?v.map(remap):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,value])=>[k,remap(value)])):v;
 result.stage=remap(stage);
 if(result.markdown)result.markdown=result.markdown.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,(id:string)=>mapped.get(id)??id);
 return result;
}
/** Выполняет bounded Python-процесс; недоступный runtime/таймаут не считается принятием. */
export function assemble(value:Value):Promise<Value> {
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/python3',[fileURLToPath(new URL('runner.py',root))],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});
  let output='',size=0,done=false;
  const finish=(error?:Error,result?:Value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result!);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new GameCoreFault('DEADLINE_EXCEEDED'));},4000);
  child.on('error',()=>finish(new GameCoreFault('INTERNAL')));
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>524288){child.kill('SIGKILL');finish(new GameCoreFault('INVALID_ARGUMENT'));}else output+=chunk;});
  child.stderr.resume();
  child.on('close',code=>{
   try {
    const result=JSON.parse(output);
    if(result.error)finish(new PlanningFault(result.phase,result.error));
    else if(code)finish(new GameCoreFault('INTERNAL'));
    else finish(undefined,value.expand_stage?result:operationIds(result,value.files));
   } catch {finish(new GameCoreFault('INTERNAL'));}
  });
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(value));
 });
}
