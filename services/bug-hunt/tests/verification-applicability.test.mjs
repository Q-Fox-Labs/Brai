// ABOUTME: Проверяет соответствие recipe всем observations snapshot.
// ABOUTME: Несвязанный report и смешанная группа не получают чужой oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {recipeApplies} from '../dist/verification-engine.js';
test('only exact observations receive a recipe',()=>{
 const observation={title:'claim',operation:'operation',expected:'expected',observed:'observed'};
 const single={cases:[{observation}]};
 assert.equal(recipeApplies(single,observation),true);
 for(const key of Object.keys(observation))assert.equal(recipeApplies({cases:[{observation:{...observation,[key]:'unrelated'}}]},observation),false);
 assert.equal(recipeApplies({cases:[{observation},{observation:{...observation,title:'different'}}]},observation),false);
 assert.equal(recipeApplies({cases:[]},observation),false);
 assert.equal(recipeApplies(single,{...observation,extra:'x'}),false);
});
