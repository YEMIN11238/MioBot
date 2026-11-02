import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gameTool,GAME_VERSION} from '../server/game-tools.mjs';

test('Minecraft facts use a checked version-pinned upstream snapshot',()=>{
  const raw=readFileSync(new URL('../integrations/game-data/minecraft-1.21.8.json',import.meta.url),'utf8');
  const snapshot=JSON.parse(raw);
  const result=gameTool('item_lookup',{query:'钻石镐'});
  assert.equal(GAME_VERSION,'1.21.8');assert.equal(result.version,'1.21.8');assert.equal(result.edition,'Java Edition');
  assert.equal(result.source.dataSha256,createHash('sha256').update(raw).digest('hex'));
  assert.equal(snapshot.items.length,1416);assert.equal(snapshot.blocks.length,1105);
  assert.equal(result.source.packages.find(p=>p.name==='minecraft-data').version,'3.119.0');
  assert.equal(result.source.packages.find(p=>p.name==='prismarine-recipe').version,'1.5.0');
});

test('Chinese aliases and namespaced English IDs resolve real item facts',()=>{
  const chinese=gameTool('item_lookup',{query:'钻石镐'}),english=gameTool('item_lookup',{query:'minecraft:diamond_pickaxe'});
  assert.equal(chinese.ok,true);assert.deepEqual(chinese.item,english.item);assert.equal(chinese.item.maxDurability,1561);
  assert.equal(gameTool('item_lookup',{query:' Crafting Table '}).item.name,'crafting_table');
  const water=gameTool('item_lookup',{query:'水'});assert.equal(water.ok,true);assert.equal(water.item,null);assert.equal(water.block.name,'water');
});

test('three chests need 24 planks in a 3x3 ring, with mutually exclusive wood alternatives',()=>{
  const result=gameTool('recipe_lookup',{query:'箱子',quantity:3});
  assert.equal(result.ok,true);assert.ok(result.totalVariantCount>1);assert.equal(result.recipes.length,3);assert.equal(result.hasMore,true);
  const first=result.recipes[0];assert.equal(first.batches,3);assert.equal(first.producedQuantity,3);assert.equal(first.requiresTable,true);
  assert.equal(first.ingredients[0].name,'oak_planks');assert.equal(first.ingredients[0].countPerBatch,8);assert.equal(first.ingredients[0].totalCount,24);
  assert.equal(first.shape.length,3);assert.equal(first.shape[1][1],null);
});

test('batch rounding and 2x2 crafting are calculated from the recipe, not requested count',()=>{
  const sticks=gameTool('recipe_lookup',{query:'木棍',quantity:5}).recipes[0];
  assert.equal(sticks.outputCount,4);assert.equal(sticks.batches,2);assert.equal(sticks.producedQuantity,8);assert.equal(sticks.ingredients[0].totalCount,4);assert.equal(sticks.requiresTable,false);
  const table=gameTool('recipe_lookup',{query:'工作台'}).recipes[0];assert.equal(table.ingredients[0].totalCount,4);assert.equal(table.requiresTable,false);
  const planks=gameTool('recipe_lookup',{query:'橡木板',quantity:5}).recipes[0];assert.equal(planks.ingredients[0].name,'oak_log');assert.equal(planks.ingredients[0].totalCount,2);assert.equal(planks.producedQuantity,8);assert.equal(planks.shape,null);
  const torch=gameTool('recipe_lookup',{query:'火把'}).recipes[0];assert.equal(torch.producedQuantity,4);assert.equal(torch.ingredients.find(i=>i.name==='coal').totalCount,1);
});

test('diamond pickaxe combines distinct ingredient amounts and requires a crafting table',()=>{
  const recipe=gameTool('recipe_lookup',{query:'diamond_pickaxe',quantity:2}).recipes[0];
  assert.equal(recipe.ingredients.find(i=>i.name==='diamond').totalCount,6);assert.equal(recipe.ingredients.find(i=>i.name==='stick').totalCount,4);
  assert.equal(recipe.requiresTable,true);assert.equal(recipe.shape[2][1],'stick');
});

test('unknown and ambiguous items are refused without guessing game facts',()=>{
  const unknown=gameTool('recipe_lookup',{query:'神奇太空镐'});assert.equal(unknown.ok,false);assert.equal(unknown.error.code,'NOT_FOUND');
  const ambiguous=gameTool('recipe_lookup',{query:'木板'});assert.equal(ambiguous.ok,false);assert.equal(ambiguous.error.code,'AMBIGUOUS_ITEM');assert.ok(ambiguous.error.choices.length>1);
  const unavailable=gameTool('recipe_lookup',{query:'基岩'});assert.equal(unavailable.error.code,'NO_CRAFTING_RECIPE');assert.match(unavailable.error.message,/不代表游戏中无法获得/);
});

test('tool contract rejects alternate versions, arbitrary endpoints, invalid counts and malformed args',()=>{
  assert.equal(gameTool('execute_command',{query:'chest'}).error.code,'UNKNOWN_TOOL');
  assert.equal(gameTool('item_lookup',{query:'chest',url:'https://example.com'}).error.code,'INVALID_ARGUMENT');
  assert.equal(gameTool('item_lookup',{query:'chest',version:'1.20'}).error.code,'VERSION_UNSUPPORTED');
  for(const quantity of [null,0,-1,0.5,4097,'5',NaN,Infinity])assert.equal(gameTool('recipe_lookup',{query:'chest',quantity}).error.code,'INVALID_QUANTITY');
  for(const args of [null,[],{},{query:{}},{query:'x'.repeat(101)}])assert.equal(gameTool('item_lookup',args).error.code,'INVALID_ARGUMENT');
  assert.equal(gameTool('recipe_lookup',{query:'chest',quantity:4096}).recipes[0].ingredients[0].totalCount,32768);
});

test('callers cannot mutate the shared snapshot or future source evidence',()=>{
  const first=gameTool('recipe_lookup',{query:'chest'});first.recipes[0].shape[0][0]='invented';first.source.packages[0].version='invented';
  const second=gameTool('recipe_lookup',{query:'chest'});assert.equal(second.recipes[0].shape[0][0],'oak_planks');assert.equal(second.source.packages[0].version,'3.119.0');
});
