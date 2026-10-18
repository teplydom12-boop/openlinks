import test from 'node:test';
import assert from 'node:assert/strict';
import {sendDialogReply,clearDialogTestDraft,recoverDialogTestDraftEmpty} from '../extension/dialog-send.js';
import {initialDialogs,saveProduct,approveProduct,productFingerprint,mergeDialogSnapshot,bindDialogTab,conversationKey,draftRequest,setDialogSettings} from '../extension/lib/dialogs.js';
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

test('dry-run persists its cleanup token before filling and never reserves quota or sends',async()=>{
  for(const platform of ['alibaba','mic','1688']) {
    const h=harness(platform),base=h.action,saved=[];
    h.action=async message=>({...await base(message),...(message.type==='PREPARE'?{preview:true}:{})});
    const result=await h.send({dryRun:true,previewOperation:'test-cycle-1',reserve:async()=>assert.fail('dry run used quota'),reservePreview:async value=>{saved.push(value);h.events.push('PERSIST_PREVIEW');return {ok:true};}});
    assert.equal(result.status,'previewed',platform);assert.equal(result.clicked,false);assert.equal(result.reserved,false);
    assert.equal(h.events[0],'PERSIST_PREVIEW');assert.equal(saved.length,1);assert.deepEqual(result.cleanupToken,saved[0].cleanupToken);
    assert.equal(result.cleanupToken.operation,'test-cycle-1');assert.equal(result.cleanupToken.text,h.options.text);
    assert.ok(h.calls.filter(call=>call.type!=='DIALOGS_SNAPSHOT').every(call=>call.dialogPreview===true));
    assert.ok(!h.calls.some(call=>call.type==='SEND'));assert.equal(h.reservations.length,0);
  }
});
test('dry-run without durable preview intent, or failed persistence, never touches the editor',async()=>{
  for(const extra of [{},{reservePreview:async()=>({ok:false})},{reservePreview:async()=>{throw Error('disk failed');}}]) {
    const h=harness(),result=await h.send({dryRun:true,previewOperation:'test-cycle',...extra});assert.equal(result.status,'blocked');assert.deepEqual(h.calls,[]);assert.deepEqual(h.reservations,[]);
  }
});
test('dry-run retains cleanup evidence after failed preparation or a new inbound message',async()=>{
  for(const failure of ['disabled-send','changed-history','transport']) {
    const h=harness(),base=h.action;let stored;
    h.action=async message=>{
      if(message.type==='PREPARE') {
        if(failure==='transport')throw Error('lost preparation acknowledgement');
        if(failure==='disabled-send')return {ok:false,preview:true,reason:'Кнопка недоступна'};
        h.snapshot.conversations[0].replyFingerprint='new-inbound';return {ok:true,preview:true,pageUrl:h.source.sourceUrl};
      }
      return base(message);
    };
    const result=await h.send({dryRun:true,previewOperation:'test-cycle',reservePreview:async value=>{stored=value.cleanupToken;return {ok:true};}});
    assert.equal(result.status,'blocked');assert.deepEqual(result.cleanupToken,stored);assert.equal(result.clicked,false);assert.ok(!h.calls.some(call=>call.type==='SEND'));assert.deepEqual(h.reservations,[]);
  }
});
test('1688 dry-run keeps native activation guarded but never falls through to SEND',async()=>{
  const h=harness('1688'),base=h.action;let preparations=0;
  h.action=message=>message.type==='PREPARE'?++preparations===1?{ok:false,preview:true,needsNativeInput:true,pageUrl:h.source.sourceUrl}:{ok:true,preview:true,pageUrl:h.source.sourceUrl}:base(message);
  const result=await h.send({dryRun:true,previewOperation:'test-1688',reservePreview:async()=>({ok:true}),activate:async(job,call)=>{for(const stage of ['locate','focus','space','done','release'])await call(job,job.frameId,'NATIVE_INPUT',{stage});}});
  assert.equal(result.status,'previewed');assert.equal(h.calls.filter(call=>call.type==='NATIVE_INPUT').length,5);assert.ok(h.calls.filter(call=>call.type==='NATIVE_INPUT').every(call=>call.dialogPreview===true&&call.dialogGuard.operation==='test-1688'));assert.ok(!h.calls.some(call=>call.type==='SEND'));
});
test('dry-run stop while intent is persisted prevents preparation',async()=>{
  const h=harness();let continued=true;
  const result=await h.send({dryRun:true,previewOperation:'test-cycle',shouldContinue:()=>continued,reservePreview:async()=>{continued=false;return {ok:true};}});
  assert.equal(result.status,'blocked');assert.ok(result.cleanupToken);assert.deepEqual(h.calls,[]);assert.deepEqual(h.reservations,[]);
});
function wechatHarness() {
  const h=harness();
  setDialogSettings(h.state,{...h.state.settings,wechat:'buyer-wx-123',scanRead:true},5);
  approveProduct(h.state,productFingerprint(h.state),6);
  h.snapshot.conversations[0].unread=false;
  h.snapshot.conversations[0].messages.push({id:'buyer-last',text:'Thank you for the quotation.',direction:'outbound'});
  mergeDialogSnapshot(h.state,h.snapshot,7);
  h.options.request=draftRequest(h.state,h.key);
  const base=h.action;h.action=async message=>({...await base(message),...(message.type==='PREPARE'?{preview:true}:{})});
  return h;
}
test('a read chat ending in buyer text permits only a guarded WeChat preview',async()=>{
  const h=wechatHarness();assert.equal(h.options.request.purpose,'wechat');
  const result=await h.send({dryRun:true,previewOperation:'wechat-test',reservePreview:async()=>({ok:true})});
  assert.equal(result.status,'previewed');assert.equal(result.clicked,false);
  assert.equal(h.calls.find(call=>call.type==='PREPARE').dialogGuard.purpose,'wechat');
  assert.ok(!h.calls.some(call=>call.type==='SEND'));assert.deepEqual(h.reservations,[]);
});
test('WeChat invitation cannot reserve or send outside test mode',async()=>{
  const h=wechatHarness();const result=await h.send();assert.equal(result.status,'blocked');
  assert.match(result.reason,/тестовом режиме/);assert.deepEqual(h.calls,[]);assert.deepEqual(h.reservations,[]);
});
test('fresh outbound contact, lost history or changed purpose blocks WeChat insertion',async()=>{
  for(const change of [h=>h.snapshot.conversations[0].messages.at(-1).text='My WeChat is buyer-wx-123',h=>h.snapshot.conversations[0].tailKnown=false,h=>h.snapshot.conversations[0].messages[0].direction='unknown',h=>h.options.request={...h.options.request,purpose:undefined}]) {
    const h=wechatHarness();change(h);
    const result=await h.send({dryRun:true,previewOperation:'wechat-test',reservePreview:async()=>({ok:true})});
    assert.equal(result.status,'blocked');assert.ok(!h.calls.some(call=>['PREPARE','SEND'].includes(call.type)));assert.deepEqual(h.reservations,[]);
  }
});
function cleanupFixture() {
  const h=harness(),token={operation:'test-cycle',platform:'alibaba',id:h.snapshot.conversations[0].id,documentToken:h.source.documentToken,sourceUrl:h.source.sourceUrl,text:h.options.text};
  return {h,token,clear:extra=>clearDialogTestDraft({api:h.api,source:h.source,token,...extra})};
}
test('cleanup sends only its owned-token command and does not require unchanged history',async()=>{
  const {h,token,clear}=cleanupFixture();h.snapshot.conversations[0].replyFingerprint='new-history';h.action=async message=>{assert.equal(message.type,'DIALOGS_CLEAR_PREVIEW');assert.deepEqual(message.token,token);return {cleared:true};};
  assert.equal((await clear()).status,'cleared');assert.equal(h.calls.length,1);assert.deepEqual(h.reservations,[]);
});
test('cleanup refuses invalid document/source/cancellation and preserves uncertain outcomes',async()=>{
  for(const extra of [{shouldContinue:()=>false},{token:{...cleanupFixture().token,documentToken:'changed'}},{token:{...cleanupFixture().token,sourceUrl:'https://evil.test/'}}]) {
    const {h,clear}=cleanupFixture();assert.equal((await clear(extra)).status,'blocked');assert.deepEqual(h.calls,[]);
  }
  for(const response of ['edited','lost','malformed']) {
    const {h,clear}=cleanupFixture();h.action=async()=>{if(response==='lost')throw Error('lost');return response==='edited'?{cleared:false,reason:'Изменён вручную'}:{};};
    assert.equal((await clear()).status,response==='edited'?'blocked':'unknown');assert.deepEqual(h.calls.map(call=>call.type),['DIALOGS_CLEAR_PREVIEW','DIALOGS_SNAPSHOT']);
  }
});
test('cleanup recovers a reloaded same-recipient document by proving it empty without deleting',async()=>{
  for(const original of ['stale-document','lost-response']) {
    const {h,clear}=cleanupFixture();h.snapshot.documentToken='new-document';
    const base=h.action;
    h.action=async message=>{
      if(message.type==='DIALOGS_CLEAR_PREVIEW'){if(original==='lost-response')throw Error('lost');return {cleared:false,reason:'Документ изменился'};}
      if(message.type==='DIALOGS_CHECK_PREVIEW_EMPTY'){assert.deepEqual(message.guard,{platform:'alibaba',id:h.snapshot.conversations[0].id,sourceUrl:h.source.sourceUrl,documentToken:'new-document'});return {empty:true};}
      return base(message);
    };
    const result=await clear();assert.equal(result.status,'cleared');assert.equal(result.recovered,true);
    assert.deepEqual(h.calls.map(call=>call.type),['DIALOGS_CLEAR_PREVIEW','DIALOGS_SNAPSHOT','DIALOGS_CHECK_PREVIEW_EMPTY']);assert.deepEqual(h.reservations,[]);
  }
});
test('empty recovery never grants deletion authority for nonempty or changed documents',async()=>{
  for(const reason of ['Ручной текст','Вложение','Получатель изменился','Документ изменился']) {
    const {h,clear}=cleanupFixture(),base=h.action;h.snapshot.documentToken='new-document';
    h.action=message=>message.type==='DIALOGS_CLEAR_PREVIEW'?{cleared:false}:message.type==='DIALOGS_CHECK_PREVIEW_EMPTY'?{empty:false,reason}:base(message);
    const result=await clear();assert.equal(result.status,'blocked');assert.equal(result.cleared,false);assert.equal(result.reason,reason);
    assert.equal(h.calls.filter(call=>call.type==='DIALOGS_CLEAR_PREVIEW').length,1);assert.ok(!h.calls.some(call=>['PREPARE','SEND'].includes(call.type)));
  }
});
test('empty recovery requires one reliable active recipient on the exact original URL and platform',async()=>{
  const changes=[snapshot=>snapshot.platform='mic',snapshot=>snapshot.url+='?different-account',snapshot=>snapshot.documentToken='',snapshot=>snapshot.status='unsupported',snapshot=>snapshot.conversations[0].id='another-supplier',snapshot=>snapshot.conversations[0].identityReliable=false,snapshot=>snapshot.conversations.push({...snapshot.conversations[0]}),snapshot=>snapshot.conversations=[]];
  for(const change of changes) {
    const {h,token}=cleanupFixture();change(h.snapshot);
    const result=await recoverDialogTestDraftEmpty({api:h.api,source:h.source,token});
    assert.equal(result.status,'blocked');assert.deepEqual(h.calls.map(call=>call.type),['DIALOGS_SNAPSHOT']);
  }
});
test('read-only recovery supports a rebound tab and frame without ever issuing cleanup',async()=>{
  const {h,token}=cleanupFixture(),calls=[];
  h.snapshot.documentToken='new-document';
  const api={tabs:{get:async tabId=>{assert.equal(tabId,40);return {id:40,url:h.source.sourceUrl,status:'complete'};},sendMessage:async(tabId,message,{frameId})=>{assert.equal(tabId,40);assert.equal(frameId,20);calls.push(message.type);if(message.type==='DIALOGS_SNAPSHOT')return h.snapshot;assert.equal(message.type,'DIALOGS_CHECK_PREVIEW_EMPTY');return {empty:true};}}};
  const result=await recoverDialogTestDraftEmpty({api,source:{...h.source,tabId:40,frameId:20,documentToken:'new-document'},token});
  assert.equal(result.status,'cleared');assert.equal(result.recovered,true);assert.deepEqual(calls,['DIALOGS_SNAPSHOT','DIALOGS_CHECK_PREVIEW_EMPTY']);
});
test('read-only recovery observes cancellation after a snapshot and after the final check',async()=>{
  for(const stopAt of ['DIALOGS_SNAPSHOT','DIALOGS_CHECK_PREVIEW_EMPTY']) {
    const {h,token}=cleanupFixture(),base=h.action;let continued=true;
    h.action=message=>{if(message.type===stopAt)continued=false;return message.type==='DIALOGS_CHECK_PREVIEW_EMPTY'?{empty:true}:base(message);};
    const result=await recoverDialogTestDraftEmpty({api:h.api,source:h.source,token,shouldContinue:()=>continued});
    assert.equal(result.status,'blocked');assert.equal(result.cleared,false);assert.deepEqual(h.calls.map(call=>call.type),stopAt==='DIALOGS_SNAPSHOT'?['DIALOGS_SNAPSHOT']:['DIALOGS_SNAPSHOT','DIALOGS_CHECK_PREVIEW_EMPTY']);
  }
});
test('closed-tab recovery requires a successful full query proving the original tab absent',async()=>{
  const outcomes=[{tabs:[],cleared:true},{tabs:[{id:8}],cleared:true},{tabs:[{id:4}],cleared:false},{tabs:[{}],cleared:false},{tabs:null,cleared:false},{error:true,cleared:false}];
  for(const outcome of outcomes) {
    const {h,clear}=cleanupFixture();let queries=0;
    h.api.tabs.get=async()=>{throw Error('tab unavailable');};
    h.api.tabs.query=async query=>{queries++;assert.deepEqual(query,{});if(outcome.error)throw Error('worker unavailable');return outcome.tabs;};
    const result=await clear();assert.equal(result.cleared,outcome.cleared);assert.equal(queries,1);assert.deepEqual(h.calls,[]);
    if(outcome.cleared){assert.equal(result.closed,true);assert.equal(result.recovered,true);}else assert.equal(result.status,'unknown');
  }
});
test('closed-tab recovery does not accept closure after cancellation or from a rebound read-only source',async()=>{
  const {h,token,clear}=cleanupFixture();let continued=true;
  h.api.tabs.get=async()=>{throw Error('tab unavailable');};h.api.tabs.query=async()=>{continued=false;return [];};
  assert.equal((await clear({shouldContinue:()=>continued})).status,'blocked');
  h.api.tabs.query=async()=>{throw Error('must not query closure for a rebound source');};
  assert.equal((await recoverDialogTestDraftEmpty({api:h.api,source:{...h.source,tabId:40},token})).status,'unknown');assert.deepEqual(h.calls,[]);
});
