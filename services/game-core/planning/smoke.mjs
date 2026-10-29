// ABOUTME: Проверяет сохранение синтетических требований в готовом образе Game Core.
// ABOUTME: Не использует базу, сеть или пользовательские данные.
import {createHash,randomUUID} from 'node:crypto';
import {assemble,planningFiles} from '../dist/planning.js';

const element={id:randomUUID(),parent_id:null};
const revision={id:randomUUID(),fields:{}};
const move={id:randomUUID(),element_id:element.id,title:'Поставить TEST-Задачу',previous_move_id:null};
const resource={id:randomUUID(),title:'TEST поручение',content:'Сначала выпиши слово «маяк» прописными буквами. Затем составь строку «Сигнал: МАЯК» из полученного слова. Итог — эта строка.'};
const files=planningFiles(element,revision,move,[resource],null);
const baseline={inputs:Object.fromEntries(Object.entries(files).map(([name,value])=>[name,createHash('sha256').update(value).digest('hex')])),requirements:[
 {id:'word',kind:'result',text:'Слово прописными буквами',state:{object:'Слово',property:'Регистр',value:'Прописной'},after:[],each:false,source_file:`inputs/${resource.id}.md`,quote:'Сначала выпиши слово «маяк» прописными буквами.'},
 {id:'signal',kind:'result',text:'Строка с полученным словом',state:{object:'Строка',property:'Содержание',value:'Сигнал: МАЯК'},after:['word'],each:false,source_file:`inputs/${resource.id}.md`,quote:'Затем составь строку «Сигнал: МАЯК» из полученного слова.'}
]};
const result=await assemble({files,baseline});
if(!/^[0-9a-f]{64}$/.test(result.baseline_sha256))throw Error('PLANNING_SMOKE_FAILED');
