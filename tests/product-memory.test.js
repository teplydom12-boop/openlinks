import test from 'node:test';
import assert from 'node:assert/strict';
import {initialDialogs,saveProduct,approveProduct,productFingerprint,saveProductMemory,deleteProductMemory,loadProductMemory,productMemoryAssessment,workflowAssessment,conversationProductState,chatFreshnessAssessment,mergeDialogSnapshot,conversationKey,draftRequest,acceptDraft,buildDraftPrompt,normalizeDialogs,setDialogSettings,DIALOG_LIMITS,contactAssessment} from '../extension/lib/dialogs.js';

const now=Date.UTC(2026,9,19,12),key=conversationKey('1688','buyer/thread:wood');
const message=(id,text,direction,at=now-60000)=>({id,text,direction,at});
function stateWithMemory(){
  const state=initialDialogs();state.settings.workflow24h=true;state.settings.wechat='Buyer_Contact';
  saveProduct(state,{keyPoints:'Wood splitter 220 V, CE certificate required.',rules:'Ask for MOQ. Never agree payment.'},now-1000);approveProduct(state,productFingerprint(state),now-900);
  saveProductMemory(state,{name:'Дровоколы',aliases:['wood splitter','log splitter','劈木机','дровокол']},now-800);return state;
}
function observe(state,{id='buyer/thread:wood',first='Please quote your wood splitter',tail='Which voltage do you need?',firstProof=true,complete=true,latest=now-60000,latestReliable=true,messages=null,...extra}={},at=now){
  const buyer=message('buyer-first',first,'outbound',now-3600000),rows=messages||[buyer,message('seller-reply',tail,'inbound',latest)];
  return mergeDialogSnapshot(state,{platform:'1688',status:'ready',conversations:[{id,identityReliable:true,active:true,orderReliable:true,tailKnown:true,historyStartKnown:complete,historyComplete:complete,firstBuyerMessage:firstProof?buyer:null,firstBuyerMessageReliable:firstProof,latestMessageAt:latest,latestMessageAtReliable:latestReliable,messages:rows,...extra}]},at);
}

test('product memories are explicit snapshots, and current editor never selects the product',()=>{
  const state=stateWithMemory();observe(state);const match=productMemoryAssessment(state,key,now);
  assert.equal(match.allowed,true);assert.equal(match.memoryName,'Дровоколы');assert.match(match.context.keyPoints,/220 V/);
  saveProduct(state,{keyPoints:'Unrelated excavator, 24 tonnes.'},now);assert.equal(state.product.approval,null);
  assert.equal(workflowAssessment(state,key,now).status,'ready');assert.match(JSON.parse(buildDraftPrompt(state,draftRequest(state,key,now),now).user).approvedProduct.keyPoints,/220 V/);
  const blank=initialDialogs();blank.settings.workflow24h=true;saveProduct(blank,{keyPoints:'Wood splitter'},now);approveProduct(blank,productFingerprint(blank),now);observe(blank);
  assert.equal(workflowAssessment(blank,key,now).status,'no_product_memory');assert.throws(()=>draftRequest(blank,key,now),/память/);
});
test('only the actual first outgoing message chooses a unique exact product alias',()=>{
  const state=stateWithMemory();observe(state,{first:'Please quote your excavator',tail:'We also have a wood splitter'});
  assert.equal(productMemoryAssessment(state,key,now).status,'product_not_found');
  observe(state,{first:'Please quote your wood splitter',firstProof:false,complete:false});
  // A current correction cannot leave a previously learned wrong first message.
  assert.equal(productMemoryAssessment(state,key,now).status,'first_message_unknown');
  const partial=stateWithMemory();observe(partial,{firstProof:false,complete:false});assert.equal(productMemoryAssessment(partial,key,now).status,'first_message_unknown');
  const substring=stateWithMemory();observe(substring,{first:'A wood splitterhouse is not the requested product'});assert.equal(productMemoryAssessment(substring,key,now).status,'product_not_found');
  for(const first of ['Нужны дровоколы для склада','Could you quote a LOG SPLITTER?','我要采购这台劈木机，请报价']){const localized=stateWithMemory();observe(localized,{first});assert.equal(productMemoryAssessment(localized,key,now).allowed,true);}
  const ambiguous=stateWithMemory();saveProductMemory(ambiguous,{name:'Other machine',aliases:'wood splitter'},now);observe(ambiguous);assert.equal(productMemoryAssessment(ambiguous,key,now).status,'product_ambiguous');assert.throws(()=>draftRequest(ambiguous,key,now),/нескольким/);
});
test('24-hour freshness uses actual latest message, never observation or unread state',()=>{
  const state=stateWithMemory();observe(state,{latest:now-24*3600000});assert.equal(workflowAssessment(state,key,now).status,'ready');
  assert.equal(workflowAssessment(state,key,now+1).status,'expired');
  const unknown=stateWithMemory();observe(unknown,{latest:null,latestReliable:false});assert.equal(workflowAssessment(unknown,key,now).status,'date_unknown');
  assert.equal(chatFreshnessAssessment({lastObservedAt:now,updatedAt:now,unread:true,messages:[]},now).status,'date_unknown');
  const future=stateWithMemory();observe(future,{latest:now+6*60000});assert.equal(workflowAssessment(future,key,now).status,'future_date');
  const oldStart=stateWithMemory();observe(oldStart,{messages:[message('buyer-first','wood splitter','outbound',now-30*86400000),message('last','Yes','inbound',now-1000)]});assert.equal(workflowAssessment(oldStart,key,now).status,'ready');
});
test('recent first-message proof survives bounded tail and reload but a corrected author invalidates it',()=>{
  const state=stateWithMemory();observe(state);const first=state.conversations[key].firstBuyerMessage;
  const messages=Array.from({length:DIALOG_LIMITS.messages+5},(_,i)=>message('reply-'+i,'A detail '+i,'inbound',now-10000+i));
  observe(state,{messages,complete:false,firstProof:false});assert.equal(state.conversations[key].messages.length,DIALOG_LIMITS.messages);
  assert.deepEqual(state.conversations[key].firstBuyerMessage,first);assert.equal(workflowAssessment(state,key,now).status,'ready');
  const restored=normalizeDialogs(state,now);assert.equal(workflowAssessment(restored,key,now).status,'ready');
  observe(restored,{messages:[message('buyer-first','Please quote your wood splitter','inbound',now-3600000),...messages],complete:false,firstProof:false});
  // The supplied correction lies outside the bounded tail and cannot be used as
  // proof; the supported narrow correction below is actually observed.
  observe(restored,{messages:[message('buyer-first','Please quote your wood splitter','inbound',now-3600000),message('final','Yes','inbound')],complete:false,firstProof:false});
  assert.equal(restored.conversations[key].firstBuyerMessage,null);assert.equal(productMemoryAssessment(restored,key,now).status,'first_message_unknown');
});
test('WeChat in either participant message completes, while substrings, drafts and system UI do not',()=>{
  for(const direction of ['inbound','outbound']){const state=stateWithMemory();observe(state,{messages:[message('buyer-first','wood splitter','outbound'),message('contact','Contact Buyer_Contact please',direction)]});assert.equal(workflowAssessment(state,key,now).status,'completed');assert.throws(()=>draftRequest(state,key,now),/завершена/);}
  for(const [text,direction] of [['Buyer_Contact_extra','inbound'],['Buyer_Contact','system'],['Buyer_Contact','unknown']]){const state=stateWithMemory();observe(state,{messages:[message('buyer-first','wood splitter','outbound'),message('contact',text,direction),message('last','Price?','inbound')]});assert.notEqual(workflowAssessment(state,key,now).status,'completed');}
  const state=stateWithMemory();observe(state);acceptDraft(state,draftRequest(state,key,now),{text:'My WeChat Buyer_Contact'},now);assert.equal(workflowAssessment(state,key,now).status,'ready');
});
test('supplier WeChat completion survives transcript eviction and reload with no raw contact in ledger',()=>{
  const state=stateWithMemory();observe(state,{tail:'I will add Buyer_Contact'});assert.equal(workflowAssessment(state,key,now).status,'completed');
  for(let i=0;i<=DIALOG_LIMITS.conversations;i++)observe(state,{id:'other-'+i,first:'wood splitter',tail:'Hello'},now+i+1);
  assert.equal(state.conversations[key],undefined);assert.equal(JSON.stringify(state.contactLedger).includes('Buyer_Contact'),false);
  const restored=normalizeDialogs(state,now);observe(restored,{firstProof:false,complete:false,messages:[]},now+1000);assert.equal(workflowAssessment(restored,key,now).status,'completed');
  assert.equal(contactAssessment({...restored,settings:{...restored.settings,workflow24h:false}},key).status,'unavailable');
});
test('changed contact and corrected supplier mention invalidate completion evidence',()=>{
  const state=stateWithMemory();observe(state,{tail:'I will add Buyer_Contact'});assert.equal(workflowAssessment(state,key,now).status,'completed');
  observe(state,{tail:'I will add another contact'});assert.equal(workflowAssessment(state,key,now).status,'ready');
  observe(state,{tail:'I will add Buyer_Contact'});setDialogSettings(state,{wechat:'Buyer_New'},now);
  assert.equal(workflowAssessment(state,key,now).status,'ready');assert.equal(conversationProductState(state,key,now).context.wechat,'Buyer_New');
});
test('selected memory revisions and first-message corrections invalidate pending requests',()=>{
  const state=stateWithMemory();observe(state);const request=draftRequest(state,key,now);
  const memory=state.productMemories.entries[0];saveProductMemory(state,{id:memory.id,name:memory.name,aliases:['wood splitter','log splitter']},now+1);
  assert.throws(()=>acceptDraft(state,request,{text:'A reply'},now+1),/изменились/);
  const next=draftRequest(state,key,now);observe(state,{first:'Please quote your log splitter'});assert.throws(()=>buildDraftPrompt(state,next,now),/изменились/);
  const final=draftRequest(state,key,now);deleteProductMemory(state,memory.id,now);assert.throws(()=>acceptDraft(state,final,{text:'A reply'},now),/память/);
});
test('catalog survives storage order, rejects tampered approval, and loads editor without changing contact',()=>{
  const state=stateWithMemory();observe(state);const request=draftRequest(state,key,now);acceptDraft(state,request,{text:'We need 220 V'},now);
  const restored=normalizeDialogs(JSON.parse(JSON.stringify(state)),now);assert.equal(restored.productMemories.entries.length,1);assert.equal(restored.conversations[key].draft.text,'We need 220 V');
  restored.settings.wechat='New_Contact';loadProductMemory(restored,restored.productMemories.entries[0].id,now);assert.equal(restored.settings.wechat,'New_Contact');assert.equal(restored.product.approval,null);
  const tampered=structuredClone(state);tampered.productMemories.entries[0].product.approval.context.keyPoints='Tampered';assert.equal(normalizeDialogs(tampered,now).productMemories.entries.length,0);
});
test('old real drafts are archived visibly when the new workflow has no saved matching product',()=>{
  const state=stateWithMemory();state.settings.workflow24h=false;observe(state);acceptDraft(state,draftRequest(state,key,now),{text:'Keep this reviewed reply'},now);
  state.settings.workflow24h=true;state.productMemories={version:1,entries:[]};
  const restored=normalizeDialogs(state,now),item=restored.conversations[key];assert.equal(item.draft,null);assert.equal(item.previousDraft.text,'Keep this reviewed reply');assert.equal(item.previousDraft.status,'stale');
  assert.equal(normalizeDialogs(restored,now+1).conversations[key].previousDraft.text,'Keep this reviewed reply');
});
test('workflow activity, visits, history and list traversal persist with bounded trusted fields',()=>{
  const state=stateWithMemory();state.workflow={cursor:4,activity:{phase:'reading',platform:'1688',key,detail:'Reading first message',at:now},visits:{[key]:{at:now,preview:'a',status:'waiting_supplier',detail:'wait'}},history:{[key]:{phase:'start',attempts:4,startedAt:now,documentToken:'doc',frameId:0}},list:{'1688':{attempts:2,startedAt:now,nextAt:now+1000,atEnd:false}}};
  const restored=normalizeDialogs(state,now);assert.equal(restored.workflow.cursor,4);assert.equal(restored.workflow.activity.phase,'reading');assert.equal(restored.workflow.history[key].attempts,4);assert.equal(restored.workflow.list['1688'].nextAt,now+1000);
});
test('first-message native evidence outside the loaded tail can prove completion and a correction removes it',()=>{
  const state=stateWithMemory(),first='Please quote a wood splitter, WeChat Buyer_Contact';
  observe(state,{first,complete:false,messages:[message('seller','What size?','inbound')]});assert.equal(workflowAssessment(state,key,now).status,'completed');
  const restored=normalizeDialogs(state,now);assert.equal(workflowAssessment(restored,key,now).status,'completed');
  observe(restored,{first:'Please quote a wood splitter',complete:false,messages:[message('seller','What size?','inbound')]});assert.equal(workflowAssessment(restored,key,now).status,'ready');
});
test('cross-platform list floods preserve active and pending conversations and prioritize offscreen active rows',()=>{
  const state=stateWithMemory();observe(state);state.workflow.pinnedKeys=[key];
  const rows=Array.from({length:120},(_,i)=>({id:'list-'+i,identityReliable:true,active:false,preview:'hello',messages:[]}));
  const active={id:'active-last',identityReliable:true,active:true,orderReliable:true,tailKnown:true,messages:[message('buyer','wood splitter','outbound'),message('seller','What size?','inbound')]};
  mergeDialogSnapshot(state,{platform:'alibaba',status:'ready',conversations:[...rows,active]},now+1);
  assert.ok(state.conversations[key]);assert.ok(state.conversations[conversationKey('alibaba','active-last')]);assert.equal(Object.keys(state.conversations).length,100);
  const restored=normalizeDialogs(state,now);assert.deepEqual(restored.workflow.pinnedKeys,[key]);assert.ok(restored.conversations[key]);
});
test('showing the working tab is a persisted view preference without invalidating product or reply context',()=>{
  const state=stateWithMemory();observe(state);const request=draftRequest(state,key,now);acceptDraft(state,request,{text:'220 V'},now);
  setDialogSettings(state,{showWorkingTab:true},now);assert.equal(state.settings.showWorkingTab,true);assert.deepEqual(draftRequest(state,key,now),request);assert.equal(state.conversations[key].draft.text,'220 V');
  assert.equal(normalizeDialogs(state,now).settings.showWorkingTab,true);setDialogSettings(state,{showWorkingTab:false},now);assert.equal(normalizeDialogs(state,now).settings.showWorkingTab,false);
});
test('an exact saved product URL in the first request can identify the product without using seller text',()=>{
  const state=stateWithMemory(),memory=state.productMemories.entries[0];
  saveProduct(state,{sourceUrl:'https://detail.1688.com/offer/12345.html?spm=old'},now);approveProduct(state,productFingerprint(state),now);saveProductMemory(state,{id:memory.id,name:memory.name,aliases:memory.aliases},now);
  observe(state,{first:'Please quote https://detail.1688.com/offer/12345.html?spm=new.'});assert.equal(productMemoryAssessment(state,key,now).allowed,true);
  const other=stateWithMemory();observe(other,{first:'Please quote this item',tail:'https://detail.1688.com/offer/12345.html wood splitter'});assert.equal(productMemoryAssessment(other,key,now).status,'product_not_found');
});
test('validated memory snapshots are immutable, edits require a new approved snapshot',()=>{
  const state=stateWithMemory(),entry=state.productMemories.entries[0];assert.equal(Object.isFrozen(entry.product.approval.context),true);
  assert.throws(()=>{entry.product.approval.context.keyPoints='unapproved facts';},TypeError);
  loadProductMemory(state,entry.id,now);saveProduct(state,{keyPoints:'New reviewed requirements'},now);assert.notEqual(state.product.keyPoints,entry.product.keyPoints);
});
test('traversal visits cover more than the transcript cache and preserve the most recent 2000',()=>{
  const state=stateWithMemory();state.workflow.visits={};
  for(let i=0;i<2200;i++){const platform=i%2?'1688':'alibaba';state.workflow.visits[conversationKey(platform,'visited-'+i)]={at:now+i,preview:'preview '+i,status:'waiting_supplier',detail:'Wait'};}
  const restored=normalizeDialogs(state,now),visits=restored.workflow.visits;
  assert.equal(Object.keys(visits).length,2000);assert.equal(visits[conversationKey('alibaba','visited-0')],undefined);
  assert.equal(visits[conversationKey('1688','visited-2199')].preview,'preview 2199');
  assert.ok(visits[conversationKey('alibaba','visited-200')]);
  assert.equal(Object.keys(normalizeDialogs(restored,now).workflow.visits).length,2000);
});
