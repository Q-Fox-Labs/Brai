// ABOUTME: Проверяет дерево целей на синтетических связях и фильтрах.
// ABOUTME: Предки и повреждённые циклы не скрывают совпадения и не зацикливают обход.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoalTree, goalPath } from "../app/goals/tree.ts";
import type { GoalRow } from "../app/goals/tree.ts";
const rows: GoalRow[] = [
 {id:"a",title:"Корень",parent_goal_id:null,deleted:true},
 {id:"b",title:"Родитель",parent_goal_id:"a",archived:true},
 {id:"c",title:"Совпадение",parent_goal_id:"b"},
 {id:"d",title:"Другая",parent_goal_id:null},
];
test("совпадение сохраняет удалённого и архивного предков", () => {
 const result=buildGoalTree(rows,new Set(["c"]),new Set(["a","b"]),true);
 assert.deepEqual(result.map(item=>[item.row.id,item.depth,item.matches]),[["a",0,false],["b",1,false],["c",2,true]]);
});
test("свёрнутый узел скрывает потомков, но не другие корни", () => {
 const result=buildGoalTree(rows,new Set(["a","b","c","d"]),new Set(["a"]),false);
 assert.deepEqual(result.map(item=>item.row.id),["a","d"]);
});
test("нет родителя и повреждённый цикл не зацикливают или не теряют цели", () => {
 const broken=[{id:"x",parent_goal_id:"y"},{id:"y",parent_goal_id:"x"},{id:"z",parent_goal_id:"missing"}];
 const result=buildGoalTree(broken,new Set(["x","y","z"]),new Set(),false);
 assert.deepEqual(new Set(result.map(item=>item.row.id)),new Set(["x","y","z"]));
 assert.equal(result.length,3);
});

test("путь показывает предков даже при свёрнутой ветке", () => {
 assert.deepEqual(goalPath(rows,"c").map(item=>item.id),["a","b","c"]);
 assert.deepEqual(goalPath([{id:"x",parent_goal_id:"y"},{id:"y",parent_goal_id:"x"}],"x").map(item=>item.id),["y","x"]);
});
