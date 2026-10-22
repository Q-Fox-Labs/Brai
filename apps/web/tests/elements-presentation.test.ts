// ABOUTME: Проверяет сохранение смысла исторических ссылок в пользовательском тексте.
// ABOUTME: Проекция не изменяет исходный набор и не выводит служебные ID.
import test from "node:test";
import assert from "node:assert/strict";
import { presentBoard } from "../app/elements/presentation.ts";
import type { BoardData } from "../app/elements/model.ts";
test("names replace aliases before resource and condition cleanup", () => {
 const data: BoardData = { elements: [{ id:"goal",kind:"goal",parentId:null,status:"active",revision:"rev",title:"Готовый аккаунт",description:"Цель G1",input:[],output:[],fields:{source_alias:"VG1-1"} }, {id:"task",kind:"task",parentId:"goal",status:"draft",revision:"r2",title:"Выбрать способ",description:"",input:[],output:[],fields:{source_alias:"VT1-2"}}],moves:[{id:"move",ownerId:"goal",targetId:"goal",previousId:null,kind:"operation",title:"Проверить",status:"planned",attemptId:"",executor:"agent",input:[],output:[],conditions:{prerequisite:"Есть решение по T1",stage:"planning"}}],resources:[{id:"r",attemptId:null,title:"Постановка G1",content:"Версия VG1-1, задача T1. Основание R01.",metadata:{source_alias:"R01"}}] };
 const before=JSON.stringify(data),view=presentBoard(data);
 assert.equal(JSON.stringify(data),before);
 assert.equal(view.resources[0].title,"Постановка Готовый аккаунт");
 assert.equal(view.resources[0].content,"Версия постановка «Готовый аккаунт», задача Выбрать способ. Основание Постановка Готовый аккаунт.");
 assert.equal(view.moves[0].conditions,"Есть решение по Выбрать способ");
 assert.doesNotMatch(JSON.stringify(view.resources),/Версия ,|Основание \./);
});

test("resource presentation preserves plan rows and leaves stored bytes intact", () => {
 const content = "# План\n\n| Поле | Значение |\n| --- | --- |\n| Вход | Поручение |\n| Критерий | Сигнал: МАЯК |";
 const data: BoardData = {elements:[], moves:[], resources:[{id:"plan", attemptId:null, title:"План", content}]};
 assert.equal(presentBoard(data).resources[0].content,content);
 assert.equal(data.resources[0].content,content);
});
