// ABOUTME: Синтетические входы интеграционных проверок планировщика.
// ABOUTME: Не выполняет тесты и не обращается к пользовательским данным.
import {createHash,randomUUID} from 'node:crypto';
import {planningFiles} from '../dist/planning.js';
export function fixture(){
 const element={id:randomUUID(),parent_id:null},revision={id:randomUUID(),fields:{}},move={id:randomUUID(),element_id:element.id,title:'Поставить TEST-Задачу',previous_move_id:null};
 const resource={id:randomUUID(),title:'TEST поручение',content:'Сначала выпиши слово «маяк» прописными буквами. Затем составь строку «Сигнал: МАЯК» из полученного слова. Итог — эта строка.'};
 const files=planningFiles(element,revision,move,[resource],null);
 const criteria={inputs:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')])),requirements:[
  {id:'word',kind:'result',text:'Слово прописными буквами',state:{object:'Слово',property:'Регистр',value:'Прописной'},after:[],each:false,source_file:`inputs/${resource.id}.md`,quote:'Сначала выпиши слово «маяк» прописными буквами.'},
  {id:'signal',kind:'result',text:'Строка с полученным словом',state:{object:'Строка',property:'Содержание',value:'Сигнал: МАЯК'},after:['word'],each:false,source_file:`inputs/${resource.id}.md`,quote:'Затем составь строку «Сигнал: МАЯК» из полученного слова.'}
 ]};
 const candidate={fields:{title:'TEST Сигнал из прописного слова',summary:'Получить строку сигнала.',inputs:[resource.id],context:'Слово задано в поручении.',scope:'Одно слово и строка.',constraints:'Текст без внешних действий.',preferences:'',unknowns:'',hypothesis:'Если слово «маяк» преобразовано в прописной регистр, то из него можно собрать заданную строку сигнала.',expected_result:'Строка в точности «Сигнал: МАЯК».',result_types:['Выбор','Артефакт'],outputs:['final']},resources:[{key:'upper',name:'TEST Прописное слово',content:'Слово МАЯК, полученное из исходного слова.'},{key:'signal',name:'TEST Строка сигнала',content:'Строка, составленная из полученного слова: Сигнал: МАЯК.'},{key:'final',name:'TEST Принятый сигнал',content:'Принятая строка Сигнал: МАЯК.'}],chain:[{result:'upper',after:[]},{result:'signal',after:['upper']}],children:[],work:[{key:'uppercase',title:'Преобразовать слово',actor:'agent',description:'Получить прописное слово.',instruction:'Из входа выпиши слово «маяк» и преобразуй его в прописной регистр.',inputs:[resource.id],outputs:['upper'],criteria:['Выход равен МАЯК.']},{key:'compose',title:'Составить строку сигнала',actor:'agent',description:'Использовать полученное слово.',instruction:'Соедини префикс «Сигнал: » с полученным словом.',inputs:['upper'],outputs:['signal'],criteria:['Строка равна Сигнал: МАЯК.']}],completion:['signal'],questions:[],deferred:[]};
 return {element,revision,move,resource,files,criteria,candidate};
}
