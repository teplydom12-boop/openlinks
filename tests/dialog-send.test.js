import test from 'node:test';
import assert from 'node:assert/strict';
import {sendDialogReply} from '../extension/dialog-send.js';
import {initialDialogs,saveProduct,approveProduct,productFingerprint,mergeDialogSnapshot,bindDialogTab,conversationKey,draftRequest} from '../extension/lib/dialogs.js';
import {withTabOwnership} from '../extension/lib/tab-ownership.js';

function harness(platform='alibaba') {
  const url={alibaba:'https://message.alibaba.com/message/messenger.htm','1688':'https://air.1688.com/chat',mic:'https://webim.made-in-china.com/super-tm/'}[platform];
  const state=initialDialogs(),id='account:buyer/thread:supplier',key=conversationKey(platform,id),calls=[],reservations=[],events=[];
  saveProduct(state,{keyPoints:'Ask for price and lead time.'},1);approveProduct(state,productFingerprint(state),2);state.running=true;
  bindDialogTab(state,platform,4,url,3);
  const snapshot={platform,status:'ready',url,documentToken:'document-1',busy:{hasDraft:false,userEditing:false,recentUserInput:false},conversations:[{id,active:true,identityReliable:true,orderReliable:true,tailKnown:true,replyFingerprint:'reply-1',messages:[{id:'message-1',text:'Which quantity do you need?',direction:'inbound'}]}]};
  mergeDialogSnapshot(state,snapshot,4);const request=draftRequest(state,key);
  const source={tabId:4,frameId:2,sourceUrl:url,documentToken:snapshot.documentToken,replyFingerprint:'reply-1'};
  let action=async message=>message.type==='DIALOGS_SNAPSHOT'?structuredClone(snapshot):message.type==='SEND'?{clicked:true,accepted:true}:{ok:true,pageUrl:url};
  const api={tabs:{get:async()=>({id:4,url,status:'complete'}),sendMessage:async(tabId,message,options)=>{assert.equal(tabId,4);assert.equal(options.frameId,2);calls.push(structuredClone(message));events.push(message.type);return action(message);}},debugger:{}};
  const reserve=async value=>{reservations.push(value);events.push('RESERVE');return {ok:true};};
  const options={api,state,request,source,text:'We need 100 units.',enabled:true,reserve,now:()=>1000,wait:async()=>{}};
  return {snapshot,state,key,request,source,api,calls,reservations,events,options,get action(){return action;},set action(value){action=value;},send:extra=>sendDialogReply({...options,...extra})};
}

test('reply sender is off by default and requires durable reservation',async()=>{
  const h=harness();assert.equal((await h.send({enabled:undefined})).status,'blocked');assert.equal((await h.send({reserve:undefined})).status,'blocked');assert.deepEqual(h.calls,[]);
});
test('reply checks exact context twice and reserves before a single guarded send',async()=>{
  const h=harness(),result=await h.send();assert.equal(result.status,'attempted');assert.equal(result.clicked,true);assert.equal(h.reservations.length,1);
  assert.deepEqual(h.events,['RESERVE','DIALOGS_SNAPSHOT','PREPARE','DIALOGS_SNAPSHOT','SEND']);
  const prepared=h.calls.find(item=>item.type==='PREPARE'),sent=h.calls.at(-1);
  assert.deepEqual(sent.dialogGuard,prepared.dialogGuard);assert.equal(sent.dialogGuard.id,'account:buyer/thread:supplier');assert.equal(sent.dialogGuard.replyFingerprint,'reply-1');assert.equal(sent.attemptId,h.reservations[0].attemptId);assert.equal(sent.expectedUrl,h.source.sourceUrl);
  assert.ok(h.calls.every(item=>!['OPEN_CHAT','CONTACT','DISMISS_CHALLENGE','DIALOGS_OPEN_CONVERSATION'].includes(item.type)));
});
test('manual drafts or active user editing prevent even inserting reply text',async()=>{
  for(const flag of ['hasDraft','userEditing','recentUserInput']){const h=harness();h.snapshot.busy[flag]=true;assert.equal((await h.send()).status,'blocked');assert.deepEqual(h.events,['RESERVE','DIALOGS_SNAPSHOT']);assert.equal(h.reservations.length,1);}
});
test('changed recipient, document, fingerprint, captcha and unsupported histories block preparation',async()=>{
  for(const change of [h=>h.snapshot.conversations[0].id='other',h=>h.snapshot.documentToken='new',h=>h.snapshot.conversations[0].replyFingerprint='new',h=>h.snapshot.status='captcha',h=>h.snapshot.conversations[0].orderReliable=false,h=>h.snapshot.conversations[0].tailKnown=false,h=>h.snapshot.conversations[0].messages[0].direction='outbound',h=>h.snapshot.conversations.push({...h.snapshot.conversations[0]})]){
    const h=harness();change(h);assert.equal((await h.send()).status,'blocked');assert.ok(!h.calls.some(item=>item.type==='PREPARE'));assert.equal(h.reservations.length,1);
  }
});
test('changed approved product, stopped monitor, binding or conversation prevents observation and editing',async()=>{
  for(const change of [h=>saveProduct(h.state,{keyPoints:'A changed product'}),h=>h.state.running=false,h=>h.state.bindings.alibaba.tabId=8,h=>h.state.conversations[h.key].takeover=true,h=>h.source.replyFingerprint='',h=>h.source.sourceUrl='https://alibaba.com.evil.test/']){
    const h=harness();change(h);assert.equal((await h.send()).status,'blocked');assert.deepEqual(h.calls,[]);
  }
});
test('new supplier message during preparation prevents click and retains the conservative reservation',async()=>{
  const h=harness(),base=h.action;h.action=async message=>{const result=await base(message);if(message.type==='PREPARE')h.snapshot.conversations[0].replyFingerprint='new-message';return result;};
  assert.equal((await h.send()).status,'blocked');assert.equal(h.reservations.length,1);assert.ok(!h.calls.some(item=>item.type==='SEND'));
});
test('quota deferral or failure to persist attempt prevents send',async()=>{
  const h=harness();const result=await h.send({reserve:async()=>({ok:false,retryAt:12345,reason:'Лимит'})});assert.equal(result.status,'deferred');assert.equal(result.retryAt,12345);assert.ok(!h.calls.some(item=>['PREPARE','NATIVE_INPUT','SEND'].includes(item.type)));
  for(const reserve of [async()=>{throw new Error('disk failure')},async()=>undefined]){const h=harness();assert.equal((await h.send({reserve})).status,'blocked');assert.ok(!h.calls.some(item=>['PREPARE','NATIVE_INPUT','SEND'].includes(item.type)));}
});
test('stop received while reservation awaited prevents send despite saved attempt',async()=>{
  const h=harness();let continuing=true;
  const result=await h.send({shouldContinue:()=>continuing,reserve:async value=>{await h.options.reserve(value);continuing=false;return {ok:true};}});
  assert.equal(result.status,'blocked');assert.equal(result.reserved,true);assert.ok(!h.calls.some(item=>item.type==='SEND'));
});
test('transport loss, malformed reply and timeout after SEND are unknown with no retry',async()=>{
  for(const behavior of ['disconnect','malformed','timeout']){
    const h=harness(),base=h.action;h.action=message=>message.type!=='SEND'?base(message):behavior==='disconnect'?Promise.reject(new Error('transport')):behavior==='timeout'?new Promise(()=>{}):Promise.resolve({ok:false});
    const result=await h.send({timeoutMs:5});assert.equal(result.status,'unknown');assert.equal(result.reserved,true);assert.equal(h.calls.filter(item=>item.type==='SEND').length,1);
  }
});
test('known refusal before click is blocked rather than reported sent',async()=>{
  const h=harness(),base=h.action;h.action=message=>message.type==='SEND'?{clicked:false,reason:'Получатель изменился'}:base(message);
  const result=await h.send();assert.equal(result.status,'blocked');assert.equal(result.clicked,false);assert.equal(result.reserved,true);
});
test('1688 waits before fill then uses native activation with the same exact guard',async()=>{
  const h=harness('1688'),base=h.action;let readiness=0,preparations=0,native=false;
  h.action=message=>message.type==='CHAT_READY'&&++readiness<3?{ok:false,waiting:true,waitMs:100}:message.type==='PREPARE'&&++preparations===1?{ok:false,needsNativeInput:true,pageUrl:h.source.sourceUrl}:base(message);
  const result=await h.send({activate:async(job,call,debuggerApi)=>{native=true;assert.equal(job.inputUrl,h.source.sourceUrl);assert.equal(debuggerApi,h.api.debugger);await call(job,job.frameId,'NATIVE_INPUT',{stage:'done'});}});
  assert.equal(result.status,'attempted');assert.equal(readiness,3);assert.equal(native,true);assert.equal(h.calls.find(item=>item.type==='NATIVE_INPUT').dialogGuard.operation,result.attemptId);
});
test('1688 inactive composer fails before click and no acceptance after click is unknown',async()=>{
  const h=harness('1688'),base=h.action;h.action=message=>message.type==='PREPARE'?{ok:false,reason:'Кнопка недоступна'}:base(message);assert.equal((await h.send()).status,'blocked');assert.equal(h.reservations.length,1);
  const other=harness('1688'),normal=other.action;other.action=message=>message.type==='SEND'?{clicked:true,accepted:false}:normal(message);assert.equal((await other.send()).status,'unknown');
});
test('tab ownership holds reply until competing tab operation has completed',async()=>{
  const h=harness();let release,entered;const started=new Promise(resolve=>entered=resolve),locked=withTabOwnership(4,async()=>{entered();await new Promise(resolve=>release=resolve);});
  await started;const sending=h.send();await Promise.resolve();assert.deepEqual(h.calls,[]);release();await locked;assert.equal((await sending).status,'attempted');
});
test('quota callback can acquire the same tab without inverting the outreach lock order',{timeout:1000},async()=>{
  const h=harness();let quotaInsideTab=false;
  const result=await h.send({reserve:value=>withTabOwnership(4,async()=>{quotaInsideTab=true;assert.deepEqual(h.calls,[]);return h.options.reserve(value);})});
  assert.equal(result.status,'attempted');assert.equal(quotaInsideTab,true);
});
