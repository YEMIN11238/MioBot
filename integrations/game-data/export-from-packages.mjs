// Regenerate with a temporary npm project containing the pinned upstream packages.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const sourceRoot=process.argv[2];
if(!sourceRoot)throw new Error('Pass the temporary npm project directory as the only argument.');
const require=createRequire(join(resolve(sourceRoot),'package.json'));
const version='1.21.8',data=require('minecraft-data')(version),Recipe=require('prismarine-recipe')(version).Recipe;
const expectedVersions={'minecraft-data':'3.119.0','prismarine-recipe':'1.5.0'};
for(const [name,expected] of Object.entries(expectedVersions))if(require(name+'/package.json').version!==expected)throw new Error('Unexpected upstream package version: '+name);
const output=dirname(fileURLToPath(import.meta.url));
const items=data.itemsArray.map(({id,name,displayName,stackSize,maxDurability})=>({id,name,displayName,stackSize,...(maxDurability?{maxDurability}:{})}));
const blocks=data.blocksArray.map(({id,name,displayName,hardness,resistance,diggable,material,stackSize})=>({id,name,displayName,hardness,resistance,diggable,material,stackSize}));
const recipes={};
for(const id of Object.keys(data.recipes)){
  const item=data.items[Number(id)];if(!item)continue;
  const variants=Recipe.find(item.id).map(recipe=>{
    const counts=new Map();
    const record=ingredient=>{if(!ingredient||ingredient.id<0)return;const known=data.items[ingredient.id];if(!known)throw new Error('Unknown upstream recipe ingredient: '+ingredient.id);counts.set(known.name,(counts.get(known.name)||0)+Math.abs(ingredient.count||1));};
    if(recipe.inShape)for(const row of recipe.inShape)for(const ingredient of row)record(ingredient);
    else for(const ingredient of recipe.ingredients||[])record(ingredient);
    const shape=recipe.inShape?.map(row=>row.map(ingredient=>ingredient&&ingredient.id>=0?data.items[ingredient.id].name:null))||null;
    return {outputCount:recipe.result.count,requiresTable:recipe.requiresTable,ingredients:[...counts].map(([name,count])=>({name,count})),shape};
  }).filter(recipe=>recipe.outputCount>0&&recipe.ingredients.length);
  if(variants.length)recipes[item.name]=variants;
}
const snapshot={edition:'Java Edition',version,protocolVersion:data.version.version,dataVersion:data.version.dataVersion,items,blocks,recipes};
const text=JSON.stringify(snapshot)+'\n';
writeFileSync(join(output,'minecraft-1.21.8.json'),text);
const lock=JSON.parse(readFileSync(join(sourceRoot,'package-lock.json'),'utf8'));
const packages=['minecraft-data','prismarine-recipe'].map(name=>{
  const upstream=JSON.parse(readFileSync(join(sourceRoot,'node_modules',name,'package.json'),'utf8'));
  mkdirSync(join(output,'upstream'),{recursive:true});
  for(const file of ['package.json','README.md'])writeFileSync(join(output,'upstream',name+'.'+file),readFileSync(join(sourceRoot,'node_modules',name,file)));
  const lockEntry=lock.packages['node_modules/'+name]||Object.entries(lock.packages).find(([key])=>key.endsWith('/node_modules/'+name))?.[1];
  return {name,version:upstream.version,license:upstream.license,author:upstream.author,repository:upstream.repository?.url,integrity:lockEntry?.integrity,packageMetadataSha256:createHash('sha256').update(readFileSync(join(sourceRoot,'node_modules',name,'package.json'))).digest('hex')};
});
const provenance={edition:snapshot.edition,version,generatedAt:new Date().toISOString(),dataSha256:createHash('sha256').update(text).digest('hex'),itemCount:items.length,blockCount:blocks.length,recipeItemCount:Object.keys(recipes).length,recipeVariantCount:Object.values(recipes).reduce((total,list)=>total+list.length,0),packages,transformation:'Item/block fields selected; Recipe.find computes shaped/shapeless ingredients and requiresTable. Complete variants retained. The application returns only bounded alternatives.',scope:'Offline version-pinned game facts. No running game, account, inventory, server or world is accessed.'};
writeFileSync(join(output,'PROVENANCE.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({version,items:items.length,blocks:blocks.length,recipeItems:provenance.recipeItemCount,variants:provenance.recipeVariantCount,dataSha256:provenance.dataSha256}));
