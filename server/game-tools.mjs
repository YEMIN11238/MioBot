import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const raw=readFileSync(new URL('../integrations/game-data/minecraft-1.21.8.json',import.meta.url),'utf8');
const data=JSON.parse(raw);
const provenance=JSON.parse(readFileSync(new URL('../integrations/game-data/PROVENANCE.json',import.meta.url),'utf8'));
if(createHash('sha256').update(raw).digest('hex')!==provenance.dataSha256)throw new Error('Minecraft bundled data integrity check failed.');
export const GAME_VERSION=data.version;
const items=new Map(data.items.map(item=>[item.name,item]));
const blocks=new Map(data.blocks.map(block=>[block.name,block]));
const aliases={
  '箱子':'chest','木箱':'chest','工作台':'crafting_table','木棍':'stick','橡木板':'oak_planks','橡木木板':'oak_planks','橡木原木':'oak_log','橡木':'oak_log',
  '熔炉':'furnace','火把':'torch','煤炭':'coal','木炭':'charcoal','钻石':'diamond','钻石镐':'diamond_pickaxe','铁镐':'iron_pickaxe','石镐':'stone_pickaxe','木镐':'wooden_pickaxe',
  '铁锭':'iron_ingot','金锭':'gold_ingot','铁粒':'iron_nugget','石头':'stone','圆石':'cobblestone','深板岩圆石':'cobbled_deepslate','石斧':'stone_axe','橡木门':'oak_door',
  '白色床':'white_bed','红色床':'red_bed','红石':'redstone','红石粉':'redstone','红石火把':'redstone_torch','钻石矿石':'diamond_ore','基岩':'bedrock',
  '玻璃':'glass','沙子':'sand','泥土':'dirt','小麦':'wheat','面包':'bread','水桶':'water_bucket','桶':'bucket','水':'water','盾牌':'shield','弓':'bow','箭':'arrow',
  '钻石剑':'diamond_sword','铁剑':'iron_sword','金苹果':'golden_apple','附魔台':'enchanting_table','书':'book','纸':'paper','书架':'bookshelf','梯子':'ladder',
  '云杉木板':'spruce_planks','白桦木板':'birch_planks','樱花木板':'cherry_planks','燧石':'flint','打火石':'flint_and_steel','下界合金锭':'netherite_ingot',
};
const ambiguous={
  '木板':['oak_planks','spruce_planks','birch_planks','cherry_planks'],
  '木头':['oak_log','spruce_log','birch_log','cherry_log'],
  '床':['white_bed','red_bed','blue_bed'],
  '镐':['wooden_pickaxe','stone_pickaxe','iron_pickaxe','diamond_pickaxe'],
};
const chineseNames=new Map(Object.entries(aliases).reverse().map(([label,name])=>[name,label]));
const source=Object.freeze({
  kind:'bundled_versioned_data',edition:data.edition,version:data.version,
  url:'https://github.com/PrismarineJS/node-minecraft-data',
  recipeUrl:'https://github.com/PrismarineJS/prismarine-recipe',
  dataSha256:provenance.dataSha256,
  packages:provenance.packages.map(({name,version,license})=>({name,version,license})),
});
const copy=value=>structuredClone(value);
const base=()=>({edition:data.edition,version:data.version,source:copy(source)});
const failure=(code,message,extra={})=>({ok:false,...base(),error:{code,message,...extra}});
const label=name=>({name,displayName:items.get(name)?.displayName||blocks.get(name)?.displayName||name,...(chineseNames.has(name)?{chineseName:chineseNames.get(name)}:{})});
function resolveQuery(query){
  const normalized=query.normalize('NFKC').trim().toLowerCase().replace(/^minecraft:/,'').replace(/[\s-]+/g,'_');
  if(Object.hasOwn(ambiguous,normalized))return {error:failure('AMBIGUOUS_ITEM','这个称呼对应多种物品，请指定一种。',{choices:ambiguous[normalized].map(label)})};
  const name=Object.hasOwn(aliases,normalized)?aliases[normalized]:normalized;
  if(items.has(name)||blocks.has(name))return {name};
  const suggestions=[...new Set([...items.keys(),...blocks.keys()])].filter(candidate=>candidate.startsWith(name)).slice(0,6).map(label);
  return {error:failure('NOT_FOUND','固定版本资料中没有找到该物品或方块，请使用具体中文名或 Minecraft 英文 ID。',{suggestions})};
}
function preference(recipe){
  return recipe.ingredients.reduce((score,ingredient)=>score+(ingredient.name==='oak_planks'||ingredient.name==='oak_log'||ingredient.name==='cobblestone'||ingredient.name==='coal'?100:0),0);
}

/** Only local, immutable game facts are available. No network, shell or world access. */
export function gameTool(name,args={}){
  if(!['item_lookup','recipe_lookup'].includes(name))return failure('UNKNOWN_TOOL','未提供该游戏工具。');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['query','version',...(name==='recipe_lookup'?['quantity']:[])].includes(key)))return failure('INVALID_ARGUMENT','参数只接受 query、可选 version，以及配方查询的 quantity。');
  if(args.version!==undefined&&args.version!==GAME_VERSION)return failure('VERSION_UNSUPPORTED',`目前仅提供 Minecraft Java ${GAME_VERSION} 的资料。`);
  if(typeof args.query!=='string'||!args.query.trim()||args.query.length>100)return failure('INVALID_ARGUMENT','query 应为 1～100 字符的具体物品或方块名称。');
  const quantity=args.quantity===undefined?1:args.quantity;
  if(name==='recipe_lookup'&&(!Number.isSafeInteger(quantity)||quantity<1||quantity>4096))return failure('INVALID_QUANTITY','quantity 应为 1～4096 的整数，表示希望获得的成品数量。');
  const resolved=resolveQuery(args.query);if(resolved.error)return resolved.error;
  const itemName=resolved.name,item=items.get(itemName),block=blocks.get(itemName);
  if(name==='item_lookup')return {ok:true,...base(),query:args.query,item:item?{...copy(item),...label(itemName)}:null,block:block?{...copy(block),...label(itemName)}:null,recipeAvailable:!!data.recipes[itemName],scope:'静态物品/方块资料，不代表玩家当前拥有或已解锁。'};
  const variants=data.recipes[itemName];
  if(!variants?.length)return failure('NO_CRAFTING_RECIPE','此快照未提供该物品的工作台/背包合成配方；不代表游戏中无法获得，熔炼、掉落和交易等获取方式未接入。',{item:label(itemName)});
  const recipes=[...variants].sort((a,b)=>preference(b)-preference(a)).slice(0,3).map(recipe=>{
    const batches=Math.ceil(quantity/recipe.outputCount);
    return {outputCount:recipe.outputCount,batches,producedQuantity:batches*recipe.outputCount,
      requiresTable:recipe.requiresTable,station:recipe.requiresTable?'工作台（3×3）':'背包 2×2 合成区即可，也可使用工作台',
      ingredients:recipe.ingredients.map(({name,count})=>({...label(name),countPerBatch:count,totalCount:count*batches})),
      shape:copy(recipe.shape),shapeLegend:'每行从左到右；null 为空格。shapeless（shape=null）表示不要求固定摆放。'};
  });
  return {ok:true,...base(),item:{...label(itemName)},requestedQuantity:quantity,recipes,totalVariantCount:variants.length,hasMore:variants.length>recipes.length,scope:'仅计算一层直接合成材料，不递归展开原材料，不读取背包，不执行游戏内操作。',note:variants.length>1?'返回最多三种可用配方，按各配方分别选择材料；不要把不同配方的材料相加。':'数量按完整合成批次向上取整。'};
}
