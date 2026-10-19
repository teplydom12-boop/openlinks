// Named, approved product snapshots. Matching uses only the proven first buyer
// message; supplier claims and the currently open editor cannot choose a product.
import {normalizeProduct,requireProductApproval} from './product-brief.js';

export const PRODUCT_MEMORY_LIMITS=Object.freeze({entries:20,aliases:30,aliasLength:120,name:120,bytes:2*1024*1024});
const obj=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const clean=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max):'';
const stamp=value=>Number.isFinite(value)&&value>=0&&value<=8640000000000000?value:null;
const validatedCatalogs=new WeakSet();
function freezeSnapshot(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeSnapshot(child);Object.freeze(value);}return value;}
function trustedCatalog(value){freezeSnapshot(value);validatedCatalogs.add(value);return value;}
const hash=text=>{let a=2166136261,b=2246822507;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),3266489909);}return `${(a>>>0).toString(16)}${(b>>>0).toString(16)}:${text.length}`;};
const normalized=value=>value.normalize('NFKC').toLowerCase().replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim();
const settingsCopy=value=>Object.fromEntries([['brief',12000],['wechat',256],['language',100]].map(([key,max])=>[key,typeof value?.[key]==='string'?value[key].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max):'']));
const invalidate=(state,now=Date.now())=>{for(const item of Object.values(state.conversations||{})){
  if(typeof item.draft?.text==='string'&&item.draft.text.trim())item.previousDraft={...item.draft,status:'stale',archivedAt:stamp(now)??Date.now(),detail:'Память товаров обновлена. Прежний черновик сохранён для просмотра; подготовьте ответ по актуальным сведениям.'};
  item.draft=null;item.autoDraft=null;
}};
function aliasesFrom(value,name){
  const source=Array.isArray(value)?value:typeof value==='string'?value.split(/[\n,;，；]/):[];
  return [...new Set([name,...source].filter(value=>typeof value==='string').map(value=>normalized(clean(value,PRODUCT_MEMORY_LIMITS.aliasLength))).filter(value=>value.length>=2&&/[\p{L}]/u.test(value)))].slice(0,PRODUCT_MEMORY_LIMITS.aliases);
}
function validEntry(raw){
  const input=obj(raw),id=clean(input.id,120),name=clean(input.name,PRODUCT_MEMORY_LIMITS.name),settings=settingsCopy(input.settings),product=normalizeProduct(input.product,settings);
  if(!/^memory-[a-z0-9-]+$/.test(id)||!name||!product.approval)return null;
  const aliases=aliasesFrom(input.aliases,name);if(!aliases.length)return null;
  return {id,name,aliases,revision:Number.isSafeInteger(input.revision)&&input.revision>=1?input.revision:1,product,settings,createdAt:stamp(input.createdAt)??0,updatedAt:stamp(input.updatedAt)??0};
}
export function normalizeProductMemories(value){
  if(value&&typeof value==='object'&&validatedCatalogs.has(value))return value;
  const result={version:1,entries:[]},seen=new Set();let bytes=0;
  for(const raw of (Array.isArray(value?.entries)?value.entries:[]).slice(0,PRODUCT_MEMORY_LIMITS.entries)){
    const entry=validEntry(raw);if(!entry||seen.has(entry.id))continue;
    const cost=new TextEncoder().encode(JSON.stringify(entry)).length;if(bytes+cost>PRODUCT_MEMORY_LIMITS.bytes)continue;
    seen.add(entry.id);bytes+=cost;result.entries.push(entry);
  }
  return trustedCatalog(result);
}
export function saveProductMemoryState(state,patch,now=Date.now()){
  const input=obj(patch),name=clean(input.name,PRODUCT_MEMORY_LIMITS.name);
  if(!name||input.name.length>PRODUCT_MEMORY_LIMITS.name)throw new Error('Укажите название товара: от 1 до 120 символов.');
  const source=Array.isArray(input.aliases)?input.aliases:typeof input.aliases==='string'?input.aliases.split(/[\n,;，；]/):[];
  if(source.length>PRODUCT_MEMORY_LIMITS.aliases||source.some(value=>typeof value!=='string'||value.length>PRODUCT_MEMORY_LIMITS.aliasLength))throw new Error('Не более 30 названий и фраз для распознавания товара, до 120 символов каждое.');
  const aliases=aliasesFrom(source,name);if(!aliases.length)throw new Error('Добавьте название или фразу для распознавания товара, минимум две буквы.');
  requireProductApproval(state);
  const catalog=normalizeProductMemories(state.productMemories),existing=input.id?catalog.entries.find(entry=>entry.id===input.id):null;
  if(input.id&&!existing)throw new Error('Сохранённый товар не найден.');
  if(!existing&&catalog.entries.length>=PRODUCT_MEMORY_LIMITS.entries)throw new Error('В памяти уже 20 товаров. Удалите ненужный товар перед добавлением.');
  let id=existing?.id||`memory-${hash(`${now}:${name}`).replace(':','-')}`;
  while(!existing&&catalog.entries.some(entry=>entry.id===id))id+='-1';
  const settings=settingsCopy(state.settings),product=normalizeProduct(state.product,settings);
  const entry={id,name:clean(name,PRODUCT_MEMORY_LIMITS.name),aliases,revision:(existing?.revision||0)+1,product,settings,createdAt:existing?.createdAt??stamp(now)??Date.now(),updatedAt:stamp(now)??Date.now()};
  const entries=existing?catalog.entries.map(item=>item.id===id?entry:item):[...catalog.entries,entry];
  if(new TextEncoder().encode(JSON.stringify(entries)).length>PRODUCT_MEMORY_LIMITS.bytes)throw new Error('Память товаров превышает 2 МБ. Сократите материалы или удалите ненужный товар.');
  state.productMemories=trustedCatalog({version:1,entries});invalidate(state,now);return entry;
}
export function deleteProductMemoryState(state,id,now=Date.now()){
  const catalog=normalizeProductMemories(state.productMemories);if(!catalog.entries.some(entry=>entry.id===id))throw new Error('Сохранённый товар не найден.');
  state.productMemories=trustedCatalog({version:1,entries:catalog.entries.filter(entry=>entry.id!==id)});invalidate(state,now);return true;
}
export function loadProductMemoryState(state,id){
  const entry=normalizeProductMemories(state.productMemories).entries.find(entry=>entry.id===id);if(!entry)throw new Error('Сохранённый товар не найден.');
  // Global contact and instructions remain current. A changed setting requires
  // reapproval in the editor; it never silently rewrites an archived snapshot.
  state.product=normalizeProduct(entry.product,state.settings);return state.product;
}
export function normalizeFirstBuyerMessage(value,reliable){
  if(reliable!==true||value?.direction!=='outbound'||typeof value.text!=='string'||!value.text.trim()||value.text.length>6000)return null;
  return {id:clean(value.id,512),text:clean(value.text,6000),direction:'outbound',at:stamp(value.at)};
}
export function provenFirstBuyerMessage(item){
  const evidence=normalizeFirstBuyerMessage(item?.firstBuyerMessage,item?.firstBuyerMessageReliable);
  if(evidence)return evidence;
  if(item?.historyComplete===true&&item.historyStartKnown===true&&item.identityReliable&&item.orderReliable){
    const first=(item.messages||[]).find(message=>message.direction==='outbound');return normalizeFirstBuyerMessage(first,true);
  }
  return null;
}
export function chatFreshnessAssessment(item,now=Date.now()){
  const latest=stamp(item?.latestMessageAt),tail=item?.messages?.filter(message=>message.direction!=='system').at(-1);
  const at=item?.latestMessageAtReliable===true&&latest!==null?latest:item?.tailKnown&&item.orderReliable?stamp(tail?.at):null;
  if(at===null)return {allowed:false,status:'date_unknown',detail:'Дата последнего сообщения не прочитана. Диалог нужно открыть и проверить.',latestMessageAt:null};
  if(at>now+5*60*1000)return {allowed:false,status:'future_date',detail:'Дата последнего сообщения находится в будущем. Требуется проверить дату площадки.',latestMessageAt:at};
  if(now-at>24*60*60*1000)return {allowed:false,status:'expired',detail:'Последнее сообщение старше 24 часов; диалог пропущен.',latestMessageAt:at};
  return {allowed:true,status:'recent',detail:'Последнее сообщение поступило за последние 24 часа.',latestMessageAt:at};
}
function containsAlias(text,alias){
  let index=text.indexOf(alias);const cjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(alias);
  while(index!==-1){
    const before=text[index-1]||'',after=text[index+alias.length]||'';
    if(cjk||!/[\p{L}\p{N}_]/u.test(before)&&!/[\p{L}\p{N}_]/u.test(after))return true;
    index=text.indexOf(alias,index+1);
  }
  return false;
}
function canonicalProductURL(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.pathname==='/'&&!url.search)return '';
    url.hash='';for(const key of [...url.searchParams.keys()])if(/^(?:utm_.+|spm|spmid|tracelog|scm|scm_id)$/i.test(key))url.searchParams.delete(key);
    url.searchParams.sort();return url.href;
  }catch{return '';}
}
function containsProductURL(text,sourceURL){
  const expected=canonicalProductURL(sourceURL);if(!expected)return false;
  return (text.match(/https:\/\/[^\s<>"'）)\]】]+/g)||[]).some(value=>canonicalProductURL(value.replace(/[.,;，。；]+$/,''))===expected);
}
export function assessProductMemory(state,itemOrKey){
  const item=typeof itemOrKey==='string'?state.conversations?.[itemOrKey]:itemOrKey;
  if(!item||!item.identityReliable)return {allowed:false,status:'unavailable',detail:'Нужно подтвердить адресата и прочитать диалог.'};
  const first=provenFirstBuyerMessage(item);
  if(!first)return {allowed:false,status:'first_message_unknown',detail:'Начало переписки не подтверждено. Нужно загрузить первое ваше сообщение.'};
  // Storage and UI responses are validated once. Immutable snapshots prevent
  // stale cache approvals while avoiding a full multi-megabyte scan per chat.
  state.productMemories=normalizeProductMemories(state.productMemories);
  const memories=state.productMemories.entries;
  if(!memories.length)return {allowed:false,status:'no_product_memory',detail:'Сохраните утверждённый товар в память с названием и фразами для распознавания.'};
  const text=normalized(first.text),matches=memories.filter(entry=>entry.aliases.some(alias=>containsAlias(text,alias))||containsProductURL(first.text,entry.product.sourceUrl));
  if(!matches.length)return {allowed:false,status:'product_not_found',detail:'Товар из первого вашего сообщения не найден в памяти. Добавьте его название или фразы для распознавания.'};
  if(matches.length!==1)return {allowed:false,status:'product_ambiguous',detail:'Первое сообщение подходит нескольким товарам. Уточните фразы для распознавания.',candidates:matches.map(entry=>({id:entry.id,name:entry.name}))};
  const memory=matches[0],firstMessageFingerprint=hash(JSON.stringify(first));
  const context={...memory.product.approval.context,wechat:clean(state.settings?.wechat,256),language:clean(state.settings?.language,100),globalRules:clean(state.settings?.brief,12000)};
  const productFingerprint=hash(JSON.stringify([memory.id,memory.revision,memory.product.fingerprint,context,firstMessageFingerprint]));
  return {allowed:true,status:'matched',detail:`Товар определён по первому вашему сообщению: ${memory.name}.`,memoryId:memory.id,memoryName:memory.name,context,productFingerprint,firstMessageFingerprint};
}
