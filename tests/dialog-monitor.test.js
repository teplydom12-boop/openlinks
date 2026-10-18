import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDialogMonitor,dialogPlatform,isMonitoredTab,DIALOGS_KEY,installDialogMonitor} from '../extension/dialog-monitor.js';
import {conversationKey,resolveConversationAttachments} from '../extension/lib/dialogs.js';

const urls={1688:'https://air.1688.com/app/chat/index.html',alibaba:'https://message.alibaba.com/message/default.htm',mic:'https://webim.made-in-china.com/super-tm/'};
const ui={id:'test',url:'chrome-extension://test/dialogs.html'};
const key=conversationKey('1688','supplier-1');
function snapshot(platform='1688',extra={}) {
  return {platform,status:'ready',url:urls[platform],documentToken:'doc-1',frames:[],conversations:[{id:'supplier-1',title:'Supplier',identityReliable:true,active:true,unread:true,orderReliable:true,tailKnown:true,messages:[{id:'m1',direction:'inbound',text:'What quantity do you need?'}]}],...extra};
}
function harness({attachmentResolver,folderSender,reserveDialogSendQuota}={}) {
  const storage={},calls=[],alarms=[],permissionRequests=[],tabs=new Map([[1,{id:1,url:urls['1688'],status:'complete'}],[2,{id:2,url:urls.alibaba}],[3,{id:3,url:urls.mic}]]);
  const replies=new Map([[1,snapshot()],[2,snapshot('alibaba')],[3,snapshot('mic')]]);
  const frameLists=new Map(),images=new Map();let reads=0,fetches=0,allowed=true,time=1000000,openAction=async message=>({ok:true,openedId:message.conversationId}),revealAction=async message=>({ok:true,revealedId:message.conversationId}),fetchAction=async()=>new Response(JSON.stringify({choices:[{message:{content:'We need 100 units. Could you share your WeChat?'}}]}));
  const listeners=()=>({list:[],addListener(fn){this.list.push(fn);}});
  const api={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onMessage:listeners(),onStartup:listeners(),onInstalled:listeners()},
    storage:{local:{get:async name=>{reads++;return {[name]:structuredClone(storage[name])};},set:async data=>Object.assign(storage,structuredClone(data)),setAccessLevel:async value=>calls.push({access:value})}},
    tabs:{get:async id=>{if(!tabs.has(id))throw new Error('No tab');return structuredClone(tabs.get(id));},query:async()=>[...tabs.values()],
      sendMessage:async(id,message,options)=>{calls.push({id,...structuredClone(message),frameId:options.frameId});if(message.type==='DIALOGS_OPEN_CONVERSATION')return openAction(message,id);if(message.type==='DIALOGS_REVEAL_LATEST')return revealAction(message,id);const value=replies.get(`${id}:${options.frameId}`) || replies.get(id);return typeof value==='function'?value(message):structuredClone(value);},onUpdated:listeners(),onRemoved:listeners()},
    webNavigation:{getAllFrames:async({tabId})=>frameLists.get(tabId) || [{frameId:0,parentFrameId:-1,url:tabs.get(tabId).url}]},
    alarms:{create:async(name,options)=>alarms.push({name,...options}),clear:async()=>true,onAlarm:listeners()},
    permissions:{contains:async request=>{permissionRequests.push(structuredClone(request));return typeof allowed==='function'?allowed(request):allowed;}},
  };
  const monitor=createDialogMonitor({api,now:()=>time,attachmentResolver,folderSender,reserveDialogSendQuota,imageLoader:async key=>{if(!images.has(key))throw new Error('Файл изображения недоступен.');return images.get(key);},fetchImpl:async(...args)=>{fetches++;return fetchAction(...args);}});
  return {api,monitor,storage,calls,alarms,permissionRequests,tabs,replies,frameLists,images,advanceTime:ms=>{time+=ms;},get time(){return time;},get reads(){return reads;},get fetches(){return fetches;},set allowed(value){allowed=value;},set fetchAction(value){fetchAction=value;},set openAction(value){openAction=value;},set revealAction(value){revealAction=value;},command:(type,extra={},sender=ui)=>monitor.handle({type:'DIALOGS_'+type,...extra},sender)};
}
async function ready(h) {
  assert.equal((await h.command('BIND_TAB',{platform:'1688',tabId:1})).ok,true);
  assert.equal((await h.command('SCAN')).ok,true);
  assert.equal((await h.command('SETTINGS',{settings:{brief:'Need 100 units',wechat:'buyer-wechat',language:'English'},model:'gpt-4.1-mini',apiKey:'test-private-key'})).ok,true);
  assert.equal((await h.command('PRODUCT_SAVE',{product:{cardText:'We need 100 units of the described product.',keyPoints:'Quantity: 100 units. Ask for specifications and pricing.'}})).ok,true);
  const product=await h.command('GET');assert.equal((await h.command('PRODUCT_APPROVE',{revision:product.state.product.revision,fingerprint:product.productFingerprint})).ok,true);
}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}

test('classifies only exact HTTPS marketplace domains',()=>{
  assert.equal(dialogPlatform(urls.mic),'mic');assert.equal(dialogPlatform('https://1688.com'),'1688');
  for(const url of ['http://air.1688.com/','https://1688.com.evil.test/','https://user@1688.com/','https://1688.com:444/','chrome://settings'])assert.equal(dialogPlatform(url),null);
});
test('monitoring three bound tabs only reads snapshots; it never generates AI or mutates chats',async()=>{
  const h=harness();
  for(const [index,platform] of ['1688','alibaba','mic'].entries())await h.command('BIND_TAB',{platform,tabId:index+1});
  await h.command('START');await h.monitor.onAlarm({name:'openlinks-dialogs'});
  const {state}=await h.command('GET');assert.equal(state.running,true);assert.equal(Object.keys(state.conversations).length,3);
  assert.deepEqual(h.calls.map(call=>call.type),['DIALOGS_SNAPSHOT','DIALOGS_SNAPSHOT','DIALOGS_SNAPSHOT']);assert.equal(h.fetches,0);
  assert.equal(h.alarms[0].periodInMinutes,0.5);
  const revision=state.conversations[key].revision;
  await h.monitor.onAlarm({name:'openlinks-dialogs'});assert.equal((await h.command('GET')).state.conversations[key].revision,revision);
  await h.command('STOP');const before=h.calls.length;await h.monitor.onAlarm({name:'openlinks-dialogs'});assert.equal(h.calls.length,before);
  assert.equal(await isMonitoredTab(1,h.api),true);
});
test('content scripts, foreign extensions and unrelated extension pages cannot use private commands',async()=>{
  const h=harness();
  for(const sender of [{id:'test',url:'https://air.1688.com/',tab:{id:1}},{id:'foreign',url:ui.url},{id:'test',url:'https://1688.com/'},{id:'test',url:'chrome-extension://test/other.html'},{}]){
    assert.equal((await h.command('GET',{},sender)).ok,false);
    assert.equal((await h.command('SETTINGS',{apiKey:'injected'},sender)).ok,false);
  }
  assert.equal(h.reads,0);assert.deepEqual(h.storage,{});
  assert.equal((await h.command('SEND',{})).ok,false);
  assert.equal((await h.command('GET',{}, {...ui,tab:{id:1}})).ok,true);
});
test('key remains private and storage access is restricted to trusted extension contexts',async()=>{
  const h=harness();await ready(h);
  const response=await h.command('GET');assert.equal(response.ai.keyStored,true);assert.equal(response.ai.model,'gpt-4.1-mini');
  assert.equal(JSON.stringify(response).includes('test-private-key'),false);assert.equal(JSON.stringify(h.storage[DIALOGS_KEY]).includes('test-private-key'),false);
  installDialogMonitor(h.api);await Promise.resolve();assert.deepEqual(h.calls.at(-1).access,{accessLevel:'TRUSTED_CONTEXTS'});
  await h.command('SETTINGS',{clearApiKey:true});assert.equal((await h.command('GET')).ai.keyStored,false);
});
test('binding validates marketplace and rejects tabs still owned by outreach',async()=>{
  const h=harness();assert.equal((await h.command('BIND_TAB',{platform:'mic',tabId:1})).ok,false);
  h.storage.openlinksState={queue:[{status:'review',tabId:1}]};assert.equal((await h.command('BIND_TAB',{platform:'1688',tabId:1})).ok,false);
  h.storage.openlinksState.queue[0].status='sent';assert.equal((await h.command('BIND_TAB',{platform:'1688',tabId:1})).ok,true);
});
test('restart drops authority over reused IDs while preserving observed conversation history',async()=>{
  const h=harness();await ready(h);await h.command('START');await h.monitor.onStartup();
  const {state}=await h.command('GET');assert.equal(state.running,false);assert.equal(state.bindings['1688'].tabId,null);assert.ok(state.conversations[key]);assert.equal(await isMonitoredTab(1,h.api),false);
  const before=h.calls.length;await h.monitor.onAlarm({name:'openlinks-dialogs'});assert.equal(h.calls.length,before);
});
test('closed or foreign-navigated tabs are unbound; login and captcha remain health states only',async()=>{
  for(const reason of ['closed','foreign','login','captcha']) {
    const h=harness();await ready(h);
    if(reason==='closed')h.tabs.delete(1);
    else if(reason==='foreign')h.tabs.get(1).url='https://example.com/';
    else h.replies.set(1,snapshot('1688',{status:reason,conversations:[]}));
    const response=await h.command('SCAN');assert.equal(response.ok,true);
    if(['closed','foreign'].includes(reason))assert.equal(response.state.bindings['1688'].tabId,null);
    else assert.equal(response.state.bindings['1688'].status,reason);
    const generation=await h.command('GENERATE_DRAFT',{key});assert.equal(generation.ok,false);assert.equal(h.fetches,0);
    assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));
  }
});
test('only visible same-platform frames contribute messages; hidden and foreign frames are ignored',async()=>{
  const h=harness(),child='https://air.1688.com/inner';
  h.frameLists.set(1,[{frameId:0,parentFrameId:-1,url:urls['1688']},{frameId:5,parentFrameId:0,url:child},{frameId:9,parentFrameId:0,url:'https://evil.test/iframe'}]);
  h.replies.set(1,snapshot('1688',{status:'unsupported',conversations:[],frames:[{url:child,visible:false}]}));
  h.replies.set('1:5',snapshot('1688',{url:child}));await h.command('BIND_TAB',{platform:'1688',tabId:1});
  const hidden=await h.command('SCAN');assert.equal(Object.keys(hidden.state.conversations).length,0);assert.equal(h.calls.some(call=>call.frameId===9),false);
  h.replies.get(1).frames[0].visible=true;const visible=await h.command('SCAN');assert.equal(visible.state.conversations[key].frameId,5);assert.equal(visible.state.conversations[key].sourceUrl,child);
});
test('manual scan commands serialize rather than reading overlapping snapshots',async()=>{
  const h=harness(),gate=deferred();let entered=0;await h.command('BIND_TAB',{platform:'1688',tabId:1});
  h.replies.set(1,async()=>{entered++;await gate.promise;return snapshot();});
  const first=h.command('SCAN'),second=h.command('SCAN');await new Promise(done=>setImmediate(done));assert.equal(entered,1);
  gate.resolve();await Promise.all([first,second]);assert.equal(entered,2);
});
test('conflicting visible frame copies of a thread cannot supply an AI draft',async()=>{
  const h=harness(),child='https://air.1688.com/inner';await ready(h);
  h.frameLists.set(1,[{frameId:0,parentFrameId:-1,url:urls['1688']},{frameId:5,parentFrameId:0,url:child}]);
  h.replies.get(1).frames=[{url:child,visible:true}];
  const other=snapshot('1688',{url:child});other.conversations[0].messages[0].text='Different thread contents';h.replies.set('1:5',other);
  const scanned=await h.command('SCAN');assert.equal(scanned.state.conversations[key].identityReliable,false);assert.match(scanned.state.bindings['1688'].detail,/противоречивые/);
  assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal(h.fetches,0);
});
test('explicit generation requires both provider config and optional origin permission',async()=>{
  const h=harness();await h.command('BIND_TAB',{platform:'1688',tabId:1});await h.command('SCAN');
  const missing=await h.command('GENERATE_DRAFT',{key});assert.equal(missing.ok,false);assert.match(missing.error,/утвердите|API-ключ/);
  await ready(h);h.allowed=false;const denied=await h.command('GENERATE_DRAFT',{key});assert.equal(denied.ok,false);assert.match(denied.error,/Разрешите/);assert.equal(h.fetches,0);
});
test('explicit generation saves only a draft after fresh observations and never sends',async()=>{
  const h=harness();await ready(h);const result=await h.command('GENERATE_DRAFT',{key});assert.equal(result.ok,true,result.error);assert.match(result.state.conversations[key].draft.text,/100 units/);assert.equal(h.fetches,1);
  assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));assert.equal(JSON.stringify(result).includes('test-private-key'),false);
});
test('AI completion is discarded if a new inbound message arrives while it is pending',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await ready(h);
  h.fetchAction=async()=>{entered.resolve();await gate.promise;return new Response(JSON.stringify({choices:[{message:{content:'Old draft'}}]}));};
  const generation=h.command('GENERATE_DRAFT',{key});await entered.promise;
  h.replies.get(1).conversations[0].messages.push({id:'m2',direction:'inbound',text:'Actually the minimum order changed.'});
  await h.command('SCAN');gate.resolve();const result=await generation;assert.equal(result.ok,false);assert.equal((await h.command('GET')).state.conversations[key].draft,null);
});
test('provider latency does not block pause; paused request cannot overwrite a later manual draft',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await ready(h);
  h.fetchAction=async()=>{entered.resolve();await gate.promise;return new Response(JSON.stringify({choices:[{message:{content:'Late draft'}}]}));};
  const generation=h.command('GENERATE_DRAFT',{key});await entered.promise;
  const response=await h.command('STOP');assert.equal(response.ok,true);const item=response.state.conversations[key];
  assert.equal((await h.command('SAVE_DRAFT',{key,text:'Manual draft',revision:item.revision,fingerprint:item.fingerprint})).ok,true);
  gate.resolve();assert.equal((await generation).ok,false);assert.equal((await h.command('GET')).state.conversations[key].draft.text,'Manual draft');
});
test('same-URL reload with a different document token invalidates provider result',async()=>{
  const h=harness();await ready(h);h.fetchAction=async()=>{h.replies.get(1).documentToken='new-document';return new Response(JSON.stringify({choices:[{message:{content:'Draft'}}]}));};
  assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal((await h.command('GET')).state.conversations[key].draft,null);
});
test('manual editing rejects stale revision and changing pause does not reset takeover',async()=>{
  const h=harness();await ready(h);const before=(await h.command('GET')).state.conversations[key];
  h.replies.get(1).conversations[0].messages.push({id:'m2',direction:'inbound',text:'Please reply today'});await h.command('SCAN');
  assert.equal((await h.command('SAVE_DRAFT',{key,text:'Draft',revision:before.revision,fingerprint:before.fingerprint})).ok,false);
  await h.command('CONTROL',{key,takeover:true});await h.command('CONTROL',{key,paused:true});const item=(await h.command('GET')).state.conversations[key];assert.equal(item.takeover,true);assert.equal(item.paused,true);
});

function unreadRow(id,extra={}) {return {id,title:'Unread supplier',identityReliable:true,active:false,unread:true,needsRead:true,preview:'New supplier message',canSelect:true,selectionToken:'row-token-'+id,messages:[],...extra};}
const opening=h=>h.calls.filter(call=>call.type==='DIALOGS_OPEN_CONVERSATION');
const poll=h=>h.monitor.onAlarm({name:'openlinks-dialogs'});

test('read traversal is opt-in at START and manual scans never select inbox rows',async()=>{
  const h=harness();await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));
  assert.equal((await h.command('GET')).state.readUnread,true);
  await h.command('START');assert.equal((await h.command('GET')).state.readUnread,false);await poll(h);assert.equal(opening(h).length,0);
  await h.command('START',{readUnread:true});await h.command('SCAN');assert.equal(opening(h).length,0);
  await poll(h);assert.equal(opening(h).length,1);assert.deepEqual(opening(h)[0],{id:1,type:'DIALOGS_OPEN_CONVERSATION',conversationId:'next',selectionToken:'row-token-next',documentToken:'doc-1',frameId:0});
  assert.equal(h.fetches,0);assert.ok(h.calls.every(call=>['DIALOGS_SNAPSHOT','DIALOGS_OPEN_CONVERSATION'].includes(call.type)));
});
test('pending read survives alarm cycles after unread badge disappears until exact target history is available',async()=>{
  const h=harness();await ready(h);const next=unreadRow('next');h.replies.get(1).conversations.push(next,unreadRow('later'));await h.command('START',{readUnread:true});await poll(h);
  next.unread=false;await poll(h);assert.equal(opening(h).length,1);assert.equal((await h.command('GET')).state.traversal['1688'].pending.id,'next');
  Object.assign(next,{active:true,needsRead:false,orderReliable:true,tailKnown:true,messages:[{id:'next-message',direction:'inbound',text:'New supplier message'}]});h.replies.get(1).conversations[0].active=false;
  await poll(h);const state=(await h.command('GET')).state;assert.equal(state.traversal['1688'].pending,null);assert.equal(opening(h).length,1);assert.ok(state.events.some(event=>event.type==='read_completed'));
  await poll(h);assert.equal(opening(h).length,2);assert.equal(opening(h)[1].conversationId,'later');
});
test('read selection requires reliable identity and fresh opaque tokens and respects per-thread controls',async()=>{
  const h=harness();await ready(h);
  h.replies.get(1).conversations.push(unreadRow('no-token',{selectionToken:''}),unreadRow('no-id',{identityReliable:false}),unreadRow('paused'),unreadRow('takeover'),unreadRow('not-certified',{canSelect:false}),unreadRow('valid'));
  await h.command('SCAN');await h.command('CONTROL',{key:conversationKey('1688','paused'),paused:true});await h.command('CONTROL',{key:conversationKey('1688','takeover'),takeover:true});
  await h.command('START',{readUnread:true});await poll(h);assert.equal(opening(h).length,1);assert.equal(opening(h)[0].conversationId,'valid');
});
test('a draft or trusted user activity in any visible frame prevents traversal',async()=>{
  const h=harness();await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));h.replies.get(1).busy={hasDraft:true};await h.command('START',{readUnread:true});await poll(h);assert.equal(opening(h).length,0);
  assert.ok((await h.command('GET')).state.events.some(event=>event.type==='read_busy'));
  h.replies.get(1).busy=false;h.openAction=async()=>({ok:false,busy:true});await poll(h);assert.equal(opening(h).length,1);await poll(h);assert.equal(opening(h).length,1);assert.equal((await h.command('GET')).state.traversal['1688'].pending,null);
});
test('unloaded targets time out after 120 seconds without blocking another platform and back off five minutes',async()=>{
  const h=harness();await ready(h);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});h.replies.get(1).conversations.push(unreadRow('next'));h.replies.get(2).conversations.push(unreadRow('ali-next'));
  await h.command('START',{readUnread:true});await poll(h);assert.equal(opening(h).length,2);
  h.advanceTime(120001);await poll(h);assert.equal((await h.command('GET')).state.traversal['1688'].pending,null);assert.equal(opening(h).length,2);
  await poll(h);assert.equal(opening(h).length,2);h.advanceTime(300001);await poll(h);assert.equal(opening(h).length,4);
});
test('document changes invalidate pending reads; STOP clears pending state and prevents more selection',async()=>{
  const h=harness();await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));await h.command('START',{readUnread:true});await poll(h);h.replies.get(1).documentToken='reloaded';await poll(h);
  let state=(await h.command('GET')).state;assert.equal(state.traversal['1688'].pending,null);assert.ok(state.events.some(event=>event.type==='read_cancelled'));
  h.replies.get(1).conversations.push(unreadRow('other'));await poll(h);assert.equal(opening(h).length,2);await h.command('STOP');await poll(h);state=(await h.command('GET')).state;assert.equal(state.traversal['1688'].pending,null);assert.equal(opening(h).length,2);
});
test('explicit AI generation holds the current platform selection stable while other read-only polls continue',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));await h.command('START',{readUnread:true});
  h.fetchAction=async()=>{entered.resolve();await gate.promise;return new Response(JSON.stringify({choices:[{message:{content:'Draft'}}]}));};
  const generation=h.command('GENERATE_DRAFT',{key});await entered.promise;await poll(h);assert.equal(opening(h).length,0);gate.resolve();assert.equal((await generation).ok,true);await poll(h);assert.equal(opening(h).length,1);
});
test('preview-only follow-up rows are reopened only when their preview changes',async()=>{
  const h=harness();await ready(h);const next=unreadRow('next',{unread:false});h.replies.get(1).conversations.push(next);await h.command('START',{readUnread:true});await poll(h);assert.equal(opening(h).length,1);
  Object.assign(next,{active:true,needsRead:false,orderReliable:true,tailKnown:true,messages:[{id:'n1',direction:'inbound',text:'New supplier message'}]});await poll(h);
  Object.assign(next,{active:false,needsRead:true,messages:[]});await poll(h);assert.equal(opening(h).length,1);
  next.preview='Another new message';await poll(h);assert.equal(opening(h).length,2);
});
test('uncertain selection acknowledgement is observed without repeating the click',async()=>{
  const h=harness();await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));h.openAction=async()=>{throw new Error('Disconnected');};await h.command('START',{readUnread:true});await poll(h);await poll(h);
  assert.equal(opening(h).length,1);assert.equal((await h.command('GET')).state.traversal['1688'].pending.id,'next');
  await h.monitor.onStartup();const state=(await h.command('GET')).state;assert.equal(state.traversal['1688'].pending,null);assert.equal(state.bindings['1688'].tabId,null);
});
test('takeover of currently open chat prevents selecting another unread supplier',async()=>{
  const h=harness();await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));await h.command('CONTROL',{key,takeover:true});await h.command('START',{readUnread:true});await poll(h);assert.equal(opening(h).length,0);
});
test('persisted traversal URLs strip nonrecipient query credentials and state remains bounded after reload',async()=>{
  const h=harness();h.tabs.get(1).url=urls['1688']+'?passToken=SECRET&lang=en';h.replies.get(1).url=h.tabs.get(1).url;await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));await h.command('START',{readUnread:true});await poll(h);
  assert.equal(JSON.stringify(h.storage[DIALOGS_KEY]).includes('SECRET'),false);
  const traversal=h.storage[DIALOGS_KEY].traversal['1688'];for(let i=0;i<150;i++){traversal.backoff['1688:'+i]=1000010;traversal.seenPreviews['1688:'+i]='preview';}
  const state=(await h.command('GET')).state;assert.equal(Object.keys(state.traversal['1688'].backoff).length,100);assert.equal(Object.keys(state.traversal['1688'].seenPreviews).length,100);
});
test('health transitions are journaled once and failed generation journals no provider details or key',async()=>{
  const h=harness();await ready(h);h.replies.set(1,snapshot('1688',{status:'captcha',conversations:[]}));await h.command('SCAN');await h.command('SCAN');
  let state=(await h.command('GET')).state;assert.equal(state.events.filter(event=>event.type==='monitor_health' && event.detail.includes('Нужна проверка')).length,1);
  h.replies.set(1,snapshot());await h.command('SCAN');h.fetchAction=async()=>{throw new Error('private-key-and-chat-data');};await h.command('GENERATE_DRAFT',{key});state=(await h.command('GET')).state;
  assert.ok(state.events.some(event=>event.type==='draft_failed'));assert.equal(JSON.stringify(state.events).includes('private-key-and-chat-data'),false);assert.equal(JSON.stringify(state.events).includes('test-private-key'),false);
  await h.command('SETTINGS',{clearApiKey:true});await h.command('GENERATE_DRAFT',{key});state=(await h.command('GET')).state;assert.ok(state.events.some(event=>event.type==='draft_failed' && event.detail.includes('Не заданы')));
});
test('a new unread transition reopens a supplier even when its preview text is identical',async()=>{
  const h=harness();await ready(h);const next=unreadRow('next');h.replies.get(1).conversations.push(next);await h.command('START',{readUnread:true});await poll(h);
  Object.assign(next,{active:true,unread:false,needsRead:false,orderReliable:true,tailKnown:true,messages:[{id:'n1',direction:'inbound',text:'New supplier message'}]});await poll(h);
  Object.assign(next,{active:false,needsRead:true,messages:[]});await poll(h);assert.equal(opening(h).length,1);
  next.unread=true;next.selectionToken='renewed-row-token';await h.command('SCAN');assert.equal(opening(h).length,1);
  await poll(h);assert.equal(opening(h).length,2);assert.equal(opening(h)[1].selectionToken,'renewed-row-token');
});
test('fully loaded history with unsupported media completes traversal without allowing an AI draft',async()=>{
  const h=harness();await ready(h);const next=unreadRow('next');h.replies.get(1).conversations.push(next);await h.command('START',{readUnread:true});await poll(h);
  Object.assign(next,{active:true,unread:false,identityReliable:true,readComplete:true,needsRead:true,orderReliable:true,tailKnown:false,detail:'Вложение не прочитано.',messages:[{id:'m1',direction:'inbound',text:'See the attached specification.'}]});
  await poll(h);const state=(await h.command('GET')).state,item=state.conversations[conversationKey('1688','next')];assert.equal(state.traversal['1688'].pending,null);assert.equal(item.unanswered,false);assert.equal(item.needsRead,true);assert.equal(item.detail,'Вложение не прочитано.');
  assert.equal((await h.command('GENERATE_DRAFT',{key:item.key})).ok,false);assert.equal(h.fetches,0);assert.equal(opening(h).length,1);
});
test('readComplete cannot complete a pending visit with ambiguous identity or a different frame',async()=>{
  for(const mismatch of ['identity','frame']) {
    const h=harness();await ready(h);const next=unreadRow('next');h.replies.get(1).conversations.push(next);await h.command('START',{readUnread:true});await poll(h);
    Object.assign(next,{active:true,readComplete:true,identityReliable:mismatch!=='identity',needsRead:true,tailKnown:false,messages:[{id:'m1',direction:'inbound',text:'Attachment'}]});
    if(mismatch==='frame') {
      const child='https://air.1688.com/child';h.frameLists.set(1,[{frameId:0,parentFrameId:-1,url:urls['1688']},{frameId:5,parentFrameId:0,url:child}]);h.replies.get(1).frames=[{url:child,visible:true}];
      h.replies.get(1).conversations=h.replies.get(1).conversations.filter(row=>row.id!=='next');h.replies.set('1:5',snapshot('1688',{url:child,documentToken:'other-document',conversations:[next]}));
    }
    await poll(h);assert.equal((await h.command('GET')).state.traversal['1688'].pending.id,'next',mismatch);assert.equal(opening(h).length,1);
  }
});

const reveals=h=>h.calls.filter(call=>call.type==='DIALOGS_REVEAL_LATEST');
async function pendingAlibaba(h) {
  await ready(h);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});
  const row=unreadRow('ali-next');h.replies.get(2).conversations.push(row);await h.command('START',{readUnread:true});await poll(h);
  Object.assign(row,{active:true,unread:false,needsRead:true,historyStable:true,readComplete:false,orderReliable:true,tailKnown:false,messages:[{id:'ali-message',direction:'inbound',text:'Specification attached.'}]});
  h.replies.get(2).conversations[0].active=false;return row;
}
test('Alibaba reveal waits for stable history, consumes its intent before one request and immediately rereads',async()=>{
  const h=harness(),row=await pendingAlibaba(h);row.historyStable=false;h.advanceTime(30000);await poll(h);assert.equal(reveals(h).length,0);
  row.historyStable=true;h.advanceTime(30000);h.revealAction=async request=>{
    assert.equal(h.storage[DIALOGS_KEY].traversal.alibaba.pending.revealed,true);
    assert.deepEqual(request,{type:'DIALOGS_REVEAL_LATEST',conversationId:'ali-next',documentToken:'doc-1'});
    row.readComplete=true;return {ok:true,revealedId:'ali-next'};
  };
  await poll(h);const state=(await h.command('GET')).state,item=state.conversations[conversationKey('alibaba','ali-next')];
  assert.equal(state.traversal.alibaba.pending,null);assert.equal(reveals(h).length,1);assert.equal(item.unanswered,false);assert.equal(item.needsRead,true);
  assert.equal((await h.command('GENERATE_DRAFT',{key:item.key})).ok,false);assert.equal(h.fetches,0);await poll(h);assert.equal(reveals(h).length,1);
  assert.ok(h.calls.every(call=>['DIALOGS_SNAPSHOT','DIALOGS_OPEN_CONVERSATION','DIALOGS_REVEAL_LATEST'].includes(call.type)));
});
test('lost reveal acknowledgement never causes another scroll, including after state normalization',async()=>{
  const h=harness();await pendingAlibaba(h);h.revealAction=async()=>{throw new Error('Lost reply');};await poll(h);
  let state=(await h.command('GET')).state;assert.equal(state.traversal.alibaba.pending.revealed,true);assert.equal(reveals(h).length,1);
  h.storage[DIALOGS_KEY]=state;await poll(h);state=(await h.command('GET')).state;assert.equal(state.traversal.alibaba.pending.revealed,true);assert.equal(reveals(h).length,1);
});
test('reveal is unavailable to UI commands, manual scans, busy pages, wrong documents and paused conversations',async()=>{
  for(const reason of ['manual','busy','document','paused','takeover','identity']) {
    const h=harness(),row=await pendingAlibaba(h);
    if(reason==='busy')h.replies.get(2).busy={hasDraft:true};
    if(reason==='document')h.replies.get(2).documentToken='different-document';
    if(['paused','takeover'].includes(reason))await h.command('CONTROL',{key:conversationKey('alibaba','ali-next'),[reason]:true});
    if(reason==='identity')row.identityReliable=false;
    if(reason==='manual')await h.command('SCAN');else await poll(h);
    assert.equal(reveals(h).length,0,reason);assert.equal((await h.command('REVEAL_LATEST',{platform:'alibaba',conversationId:'ali-next',documentToken:'doc-1'})).ok,false);
  }
});
test('1688 receives one guarded reveal during its own pending visit and immediately reads the result',async()=>{
  const h=harness();await ready(h);const row=unreadRow('next');h.replies.get(1).conversations.push(row);await h.command('START',{readUnread:true});await poll(h);
  Object.assign(row,{active:true,historyStable:true,readComplete:false,needsRead:true,tailKnown:false,messages:[{id:'m1',direction:'inbound',text:'Hello'}]});
  h.revealAction=async request=>{assert.equal(h.storage[DIALOGS_KEY].traversal['1688'].pending.revealed,true);assert.equal(request.conversationId,'next');assert.equal(request.documentToken,'doc-1');row.readComplete=true;return {ok:true,revealedId:'next'};};
  await poll(h);assert.equal(reveals(h).length,1);assert.equal(reveals(h)[0].id,1);assert.equal((await h.command('GET')).state.traversal['1688'].pending,null);await poll(h);assert.equal(reveals(h).length,1);
});
test('Made-in-China never receives a reveal command',async()=>{
  const h=harness();await ready(h);await h.command('BIND_TAB',{platform:'mic',tabId:3});
  const row=unreadRow('next');h.replies.get(3).conversations.push(row);await h.command('START',{readUnread:true});await poll(h);
  Object.assign(row,{active:true,historyStable:true,readComplete:false,needsRead:true,tailKnown:false,messages:[{id:'m1',direction:'inbound',text:'Hello'}]});await poll(h);assert.equal(reveals(h).length,0);
});
test('a delayed poll accepts completed history before timeout but never reveals an expired visit',async()=>{
  for(const complete of [true,false]) {
    const h=harness(),row=await pendingAlibaba(h);row.readComplete=complete;h.advanceTime(120001);await poll(h);const state=(await h.command('GET')).state;
    assert.equal(state.traversal.alibaba.pending,null);assert.equal(reveals(h).length,0);
    assert.equal(state.events.some(event=>event.platform==='alibaba' && event.type==='read_timeout'),!complete);
  }
});

async function autoReady(h) {await ready(h);assert.equal((await h.command('AUTODRAFT',{enabled:true})).ok,true);await h.command('START',{readUnread:true});}
test('automatic drafts require approval and explicit enabling, run only on alarms and reserve the current thread',async()=>{
  const h=harness();await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));await h.command('START',{readUnread:true});await h.command('SCAN');assert.equal(h.fetches,0);
  await h.command('AUTODRAFT',{enabled:true});await h.command('SCAN');assert.equal(h.fetches,0);await poll(h);
  const state=(await h.command('GET')).state;assert.equal(h.fetches,1);assert.equal(state.conversations[key].autoDraft.status,'done');assert.ok(state.conversations[key].draft);assert.equal(opening(h).length,0);
  await h.command('PRODUCT_SAVE',{product:{rules:'Ask about warranty first'}});assert.equal((await h.command('AUTODRAFT',{enabled:true})).ok,false);assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);await poll(h);assert.equal(h.fetches,1);
});
test('completed automatic attempt is not regenerated after polling, discard or mode toggles; a new inbound is eligible',async()=>{
  const h=harness();await autoReady(h);await poll(h);await poll(h);assert.equal(h.fetches,1);
  await h.command('DISCARD_DRAFT',{key});await poll(h);assert.equal(h.fetches,1);
  await h.command('AUTODRAFT',{enabled:false});await h.command('AUTODRAFT',{enabled:true});await poll(h);assert.equal(h.fetches,1);
  h.replies.get(1).conversations[0].messages.push({id:'m2',direction:'inbound',text:'We can supply 100 units.'});await poll(h);assert.equal(h.fetches,2);
});
test('automatic failures use persisted bounded backoff and stop after three attempts for identical input',async()=>{
  const h=harness();await autoReady(h);h.fetchAction=async()=>new Response('private-provider-error',{status:503});
  await poll(h);let item=(await h.command('GET')).state.conversations[key];assert.equal(item.autoDraft.status,'error');assert.equal(item.autoDraft.attempts,1);assert.ok(item.autoDraft.retryAt>h.time);assert.equal(h.fetches,1);
  await poll(h);assert.equal(h.fetches,1);h.advanceTime(300001);await poll(h);assert.equal(h.fetches,2);h.advanceTime(600001);await poll(h);assert.equal(h.fetches,3);h.advanceTime(1800001);await poll(h);assert.equal(h.fetches,3);
  assert.equal(JSON.stringify((await h.command('GET')).state.events).includes('private-provider-error'),false);
});
test('manual, automatic and extraction requests share one provider slot and STOP rejects late output',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await autoReady(h);
  h.fetchAction=async()=>{entered.resolve();await gate.promise;return new Response(JSON.stringify({choices:[{message:{content:'Late draft'}}]}));};
  const automatic=poll(h);await entered.promise;assert.equal(h.fetches,1);
  assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal((await h.command('PRODUCT_EXTRACT')).ok,false);await poll(h);assert.equal(h.fetches,1);
  const stopped=await h.command('STOP');assert.equal(stopped.ok,true);assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal(h.fetches,1);
  gate.resolve();await automatic;assert.equal((await h.command('GET')).state.conversations[key].draft,null);
});
test('restarted worker respects pending attempt lease before bounded recovery',async()=>{
  const h=harness();await autoReady(h);await poll(h);const stored=h.storage[DIALOGS_KEY].conversations[key];stored.draft=null;stored.autoDraft.status='pending';stored.autoDraft.at=h.time;
  let recovered=0;const worker=createDialogMonitor({api:h.api,now:()=>h.time,fetchImpl:async()=>{recovered++;return new Response(JSON.stringify({choices:[{message:{content:'Recovered draft'}}]}));}});
  await worker.onAlarm({name:'openlinks-dialogs'});assert.equal(recovered,0);h.advanceTime(300001);await worker.onAlarm({name:'openlinks-dialogs'});assert.equal(recovered,1);assert.equal(h.storage[DIALOGS_KEY].conversations[key].autoDraft.attempts,2);
});
test('editing product requirements cancels an automatic request and disables further generation until approval',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await autoReady(h);h.fetchAction=async()=>{entered.resolve();await gate.promise;return new Response(JSON.stringify({choices:[{message:{content:'Old product reply'}}]}));};
  const running=poll(h);await entered.promise;const state=await h.command('GET');await h.command('PRODUCT_SAVE',{revision:state.state.product.revision,product:{characteristics:'Quantity changed to 200'}});
  gate.resolve();await running;const result=await h.command('GET');assert.equal(result.state.product.approval,null);assert.equal(result.state.settings.autoDraft,false);assert.equal(result.state.conversations[key].draft,null);await poll(h);assert.equal(h.fetches,1);
});
test('product extraction is explicit, structured and never approves its own result',async()=>{
  const h=harness();await ready(h);let body;
  h.fetchAction=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({keyPoints:'Confirmed buyer requirement: 100 units.',questions:'What is the MOQ?',warnings:'No exact model was supplied.'})}}]}));};
  const before=await h.command('GET');const extracted=await h.command('PRODUCT_EXTRACT',{revision:before.state.product.revision,fingerprint:before.productFingerprint});assert.equal(extracted.ok,true,extracted.error);assert.equal(extracted.state.product.approval,null);assert.match(extracted.state.product.keyPoints,/100/);assert.equal(body.response_format.type,'json_object');
  assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal((await h.command('PRODUCT_APPROVE',{revision:before.state.product.revision,fingerprint:before.productFingerprint})).ok,false);
  const current=await h.command('GET');assert.equal((await h.command('PRODUCT_APPROVE',{revision:current.state.product.revision,fingerprint:current.productFingerprint})).ok,true);
});
test('late extraction cannot overwrite edited user key points',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await ready(h);h.fetchAction=async()=>{entered.resolve();await gate.promise;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({keyPoints:'Late model text',questions:'',warnings:''})}}]}));};
  const extraction=h.command('PRODUCT_EXTRACT');await entered.promise;const current=await h.command('GET');await h.command('PRODUCT_SAVE',{revision:current.state.product.revision,product:{keyPoints:'Manually reviewed requirements'}});gate.resolve();assert.equal((await extraction).ok,false);assert.equal((await h.command('GET')).state.product.keyPoints,'Manually reviewed requirements');
});
test('included product images must all be available locally; excluded images are never loaded or sent',async()=>{
  const h=harness();await ready(h);const image={id:'photo',name:'product.png',mime:'image/png',status:'ready',contentHash:'filehash',images:[{imageKey:'photo:1',mime:'image/png'}],text:''};
  await h.command('PRODUCT_SAVE',{product:{files:[image]}});assert.equal((await h.command('PRODUCT_EXTRACT')).ok,false);assert.equal(h.fetches,0);
  h.images.set('photo:1','data:image/png;base64,AAAA');let body;
  h.fetchAction=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({keyPoints:'Visible product features',questions:'Confirm model',warnings:''})}}]}));};
  assert.equal((await h.command('PRODUCT_EXTRACT')).ok,true);assert.equal(body.messages[1].content.filter(part=>part.type==='image_url').length,1);
  await h.command('PRODUCT_SAVE',{product:{files:[{...image,excluded:true}]}});h.images.clear();assert.equal((await h.command('PRODUCT_EXTRACT')).ok,true);assert.equal(typeof body.messages[1].content,'string');
});

test('STOP during preparation prevents even the first provider request',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await ready(h);
  h.replies.set(1,async()=>{entered.resolve();await gate.promise;return snapshot();});
  const generation=h.command('GENERATE_DRAFT',{key});await entered.promise;const stopped=h.command('STOP');gate.resolve();
  assert.equal((await generation).ok,false);await stopped;assert.equal(h.fetches,0);assert.equal((await h.command('GET')).state.conversations[key].draft,null);
});
test('immediate cancellation during final scan rejects output before acceptance',async()=>{
  for(const [type,payload] of [['STOP',{}],['AUTODRAFT',{enabled:false}],['CONTROL',{key,takeover:true}],['PRODUCT_SAVE',{product:{rules:'Changed during final scan'}}]]) {
    const h=harness(),entered=deferred(),gate=deferred();await ready(h);let scans=0;
    h.replies.set(1,async()=>{if(++scans===2){entered.resolve();await gate.promise;}return snapshot();});
    const generation=h.command('GENERATE_DRAFT',{key});await entered.promise;const cancelled=h.command(type,payload);gate.resolve();
    assert.equal((await generation).ok,false,type);await cancelled;assert.equal(h.fetches,1);assert.equal((await h.command('GET')).state.conversations[key].draft,null,type);
  }
});
test('all ready platforms retain their current supplier while one AI slot is occupied',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await autoReady(h);
  for(const [name,id] of [['alibaba',2],['mic',3]])await h.command('BIND_TAB',{platform:name,tabId:id});
  for(const id of [1,2,3])h.replies.get(id).conversations.push(unreadRow('next'));
  h.fetchAction=async()=>{entered.resolve();await gate.promise;return new Response(JSON.stringify({choices:[{message:{content:'Draft for this supplier'}}]}));};
  const first=poll(h);await entered.promise;await poll(h);assert.equal(h.fetches,1);assert.equal(opening(h).length,0);
  gate.resolve();await first;await poll(h);assert.equal(h.fetches,2);assert.ok((await h.command('GET')).state.conversations[conversationKey('alibaba','supplier-1')].draft);
  assert.equal(opening(h).some(call=>call.id===3),false);await poll(h);assert.equal(h.fetches,3);assert.ok((await h.command('GET')).state.conversations[conversationKey('mic','supplier-1')].draft);
});
test('readiness fluctuations do not regenerate the same paid automatic draft',async()=>{
  const h=harness();await autoReady(h);await poll(h);await h.command('DISCARD_DRAFT',{key});const row=h.replies.get(1).conversations[0];
  row.tailKnown=false;row.needsRead=true;await poll(h);row.tailKnown=true;row.needsRead=false;await poll(h);
  assert.equal(h.fetches,1);assert.equal((await h.command('GET')).state.conversations[key].draft,null);
});
test('a failed automatic attempt can revisit an unchanged inactive conversation after backoff',async()=>{
  const h=harness();await autoReady(h);h.fetchAction=async()=>new Response('',{status:503});await poll(h);assert.equal(h.fetches,1);
  const row=h.replies.get(1).conversations[0],history=structuredClone(row.messages);
  Object.assign(row,{active:false,unread:false,needsRead:true,canSelect:true,selectionToken:'again',preview:'',messages:[]});
  const other={...snapshot().conversations[0],id:'other',unread:false,messages:[{id:'o1',direction:'outbound',text:'Thanks'}]};h.replies.get(1).conversations.push(other);
  await poll(h);assert.equal(opening(h).length,0);
  h.openAction=async message=>{Object.assign(row,{active:true,needsRead:false,orderReliable:true,tailKnown:true,messages:history});other.active=false;return {ok:true,openedId:message.conversationId};};
  h.advanceTime(300001);await poll(h);assert.equal(opening(h).length,1);assert.equal(opening(h)[0].conversationId,'supplier-1');
  await poll(h);await poll(h);assert.equal(h.fetches,2);assert.equal((await h.command('GET')).state.conversations[key].autoDraft.attempts,2);
});

const imageResolution=async({state,key,now})=>{
  const item=state.conversations[key],results=[];
  for(const message of item.messages)for(const file of message.attachments || [])if(!file.resolution)results.push({messageKey:message.key,sourceFingerprint:file.sourceFingerprint,status:'ready',text:'',images:Array.from({length:Number(file.name) || 1},(_,index)=>({imageKey:`${file.name}:${index}`,mime:'image/png'})),attemptedAt:now});
  return resolveConversationAttachments(state,key,results,now);
};
function addSupplierImages(h,names=['1']) {
  const row=h.replies.get(1).conversations[0];Object.assign(row,{historyTailKnown:true,historyOrderReliable:true,orderReliable:false,tailKnown:false,needsRead:true});
  row.messages[0].attachments=names.map(name=>({type:'image',name,url:`https://air.1688.com/${name}.png?token=private-image-token`}));
}
test('all resolved supplier image bytes accompany their associated messages and are never silently omitted',async()=>{
  const h=harness({attachmentResolver:imageResolution});await ready(h);addSupplierImages(h);let request;
  assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal(h.fetches,0);
  h.images.set('1:0','data:image/png;base64,AAAA');h.fetchAction=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'Question about the pictured product'}}]}));};
  const response=await h.command('GENERATE_DRAFT',{key});assert.equal(response.ok,true,response.error);
  const content=request.messages[1].content,context=JSON.parse(content[0].text);assert.equal(content[1].image_url.url,'data:image/png;base64,AAAA');assert.equal(context.imageInputs[0].messageKey,context.messages[0].messageKey);assert.equal(context.imageInputs[0].direction,'inbound');
  assert.equal(JSON.stringify(request).includes('private-image-token'),false);assert.equal(response.state.conversations[key].messages[0].attachments[0].contentRead,false);
});
test('oversized image context gets a persisted bounded failure without starving another platform',async()=>{
  const h=harness({attachmentResolver:imageResolution});await autoReady(h);addSupplierImages(h,['8','1']);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});
  await poll(h);let state=(await h.command('GET')).state;assert.equal(h.fetches,0);assert.equal(state.conversations[key].autoDraft.status,'error');assert.equal(state.conversations[key].autoDraft.attempts,3);
  await poll(h);assert.equal(h.fetches,1);state=(await h.command('GET')).state;assert.ok(state.conversations[conversationKey('alibaba','supplier-1')].draft);assert.equal(state.events.filter(event=>event.type==='draft_failed'&&event.key===key).length,1);
});
test('same-thread frames with different attachment sources are ambiguous even if text is identical',async()=>{
  const h=harness(),child='https://air.1688.com/inner';await ready(h);addSupplierImages(h);
  h.frameLists.set(1,[{frameId:0,parentFrameId:-1,url:urls['1688']},{frameId:5,parentFrameId:0,url:child}]);h.replies.get(1).frames=[{url:child,visible:true}];
  const alternate=structuredClone(h.replies.get(1));alternate.url=child;alternate.conversations[0].messages[0].attachments[0].url='https://air.1688.com/other.png';h.replies.set('1:5',alternate);
  const response=await h.command('SCAN');assert.equal(response.state.conversations[key].identityReliable,false);assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal(h.fetches,0);
});
test('fixed 1688 model evidence is applied only to its visible exact frame and then re-read',async()=>{
  const h=harness();await ready(h);let applied=false;const scripts=[];
  h.replies.set(1,()=>{const value=snapshot();if(!applied){value.modelEvidenceToken='nonce';value.conversations[0].messages[0].direction='unknown';}return value;});
  h.api.scripting={executeScript:async options=>{scripts.push(options);return [{frameId:0,result:{platform:'1688',status:'ready',url:urls['1688'],rows:[]}}];}};
  const send=h.api.tabs.sendMessage;h.api.tabs.sendMessage=async(id,message,options)=>{if(message.type==='DIALOGS_APPLY_MODEL_EVIDENCE'){assert.equal(message.modelEvidenceToken,'nonce');assert.equal(message.documentToken,'doc-1');applied=true;return {ok:true,applied:1};}return send(id,message,options);};
  const response=await h.command('SCAN');assert.equal(response.state.conversations[key].messages[0].direction,'inbound');assert.equal(scripts.length,1);assert.deepEqual(scripts[0],{target:{tabId:1,frameIds:[0]},world:'MAIN',files:['chat-model-evidence.js']});assert.equal(h.fetches,0);
});

test('STOP or takeover while traversal intent is saving prevents a later inbox click',async()=>{
  for(const [type,payload] of [['STOP',{}],['CONTROL',{key:conversationKey('1688','next'),takeover:true}]]) {
    const h=harness(),entered=deferred(),gate=deferred();await ready(h);h.replies.get(1).conversations.push(unreadRow('next'));await h.command('START',{readUnread:true});
    const save=h.api.storage.local.set;let blocked=false;h.api.storage.local.set=async data=>{if(!blocked&&data[DIALOGS_KEY]?.traversal['1688'].pending){blocked=true;entered.resolve();await gate.promise;}return save(data);};
    const polling=poll(h);await entered.promise;const stopped=h.command(type,payload);gate.resolve();await polling;await stopped;assert.equal(opening(h).length,0,type);
  }
});
test('STOP while reveal intent is saving prevents a later history scroll',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await pendingAlibaba(h);const save=h.api.storage.local.set;let blocked=false;
  h.api.storage.local.set=async data=>{if(!blocked&&data[DIALOGS_KEY]?.traversal.alibaba.pending?.revealed){blocked=true;entered.resolve();await gate.promise;}return save(data);};
  const polling=poll(h);await entered.promise;const stopped=h.command('STOP');gate.resolve();await polling;await stopped;assert.equal(reveals(h).length,0);
});

// Chrome extension service workers reject dynamic import(), even though Node
// accepts it. PDF parsing may lazily import its worker only in the offscreen page.
test('MV3 background orchestration uses static imports on the service-worker path',async()=>{
  for(const file of ['background.js','dialog-monitor.js','lib/chat-attachments.js']) {
    const source=await readFile(new URL('../extension/'+file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\bimport\s*\(/,`${file} must not use dynamic import in the MV3 service worker`);
  }
});

const providerStorageKey='openlinksDialogsProvider';
const claudeResult=text=>new Response(JSON.stringify({type:'message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text}]}));
const extractedProduct={keyPoints:'Buyer requires 100 units.',questions:'What is the MOQ?',warnings:'Confirm the exact model.'};
async function useClaude(h){
  const response=await h.command('SETTINGS',{provider:'anthropic',model:'claude-sonnet-4-6',apiKey:'private-anthropic-key'});
  assert.equal(response.ok,true,response.error);return response;
}
async function manualReady(h){await ready(h);await h.command('SETTINGS',{clearApiKey:true});h.allowed=false;}
async function exportProduct(h){
  const current=await h.command('GET'),response=await h.command('EXPORT_PRODUCT_PROMPT',{revision:current.state.product.revision,fingerprint:current.productFingerprint});
  assert.equal(response.ok,true,response.error);return response.promptExport;
}
async function exportDialog(h){const response=await h.command('EXPORT_DRAFT_PROMPT',{key});assert.equal(response.ok,true,response.error);return response.promptExport;}
const saveExternalDraft=(h,request,text='We need 100 units. What is your MOQ?')=>h.command('SAVE_DRAFT',{key,request,revision:request.revision,fingerprint:request.fingerprint,text});

test('legacy OpenAI settings migrate without copying credentials or models into Claude',async()=>{
  const h=harness();h.storage[providerStorageKey]={model:'legacy-openai-model',apiKey:'private-legacy-key',revision:7};
  const legacy=await h.command('GET');assert.equal(legacy.ai.provider,'openai');assert.equal(legacy.ai.model,'legacy-openai-model');assert.equal(legacy.ai.keyStored,true);assert.deepEqual(legacy.ai.providers.anthropic,{model:'',keyStored:false});
  const selected=await h.command('SETTINGS',{provider:'anthropic'});assert.equal(selected.ok,true,selected.error);assert.equal(selected.ai.model,'');assert.equal(selected.ai.keyStored,false);
  assert.deepEqual(h.storage[providerStorageKey],{provider:'anthropic',profiles:{openai:{model:'legacy-openai-model',apiKey:'private-legacy-key'},anthropic:{model:'',apiKey:''}},revision:8});
  await useClaude(h);const restored=await h.command('SETTINGS',{provider:'openai'});assert.equal(restored.ai.model,'legacy-openai-model');assert.equal(restored.ai.keyStored,true);assert.equal(restored.ai.providers.anthropic.keyStored,true);
  await h.command('SETTINGS',{provider:'anthropic',clearApiKey:true});const result=await h.command('GET');assert.equal(result.ai.providers.anthropic.keyStored,false);assert.equal(result.ai.providers.openai.keyStored,true);assert.equal(h.storage[providerStorageKey].profiles.openai.apiKey,'private-legacy-key');
  assert.doesNotMatch(JSON.stringify([legacy,selected,restored,result]),/private-legacy-key|private-anthropic-key/);
});

test('Claude requires its own optional origin permission for drafts, extraction and automatic mode',async()=>{
  const h=harness();await ready(h);await useClaude(h);h.allowed=request=>request.origins.every(origin=>origin==='https://api.openai.com/*');
  for(const [type,payload] of [['GENERATE_DRAFT',{key}],['PRODUCT_EXTRACT',{}],['AUTODRAFT',{enabled:true}]]){
    const result=await h.command(type,payload);assert.equal(result.ok,false,type);assert.match(result.error,/Разрешите.*Claude/);
  }
  assert.equal(h.fetches,0);assert.ok(h.permissionRequests.length>=3);assert.ok(h.permissionRequests.every(request=>JSON.stringify(request)==='{"origins":["https://api.anthropic.com/*"]}'));
  const previous=structuredClone(h.storage[providerStorageKey]);assert.equal((await h.command('SETTINGS',{provider:'https://untrusted.example',apiKey:'other-key'})).ok,false);assert.deepEqual(h.storage[providerStorageKey],previous);
});

test('Claude generation and product extraction use Anthropic transport and remain drafts requiring approval',async()=>{
  const h=harness();await ready(h);await useClaude(h);const requests=[];
  h.fetchAction=async(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return claudeResult(requests.length===1?'We need 100 units. What is the MOQ?':JSON.stringify(extractedProduct));};
  const generated=await h.command('GENERATE_DRAFT',{key});assert.equal(generated.ok,true,generated.error);assert.equal(generated.state.conversations[key].draft.status,'draft');assert.match(generated.state.conversations[key].draft.text,/100 units/);
  const extracted=await h.command('PRODUCT_EXTRACT');assert.equal(extracted.ok,true,extracted.error);assert.equal(extracted.state.product.keyPoints,extractedProduct.keyPoints);assert.equal(extracted.state.product.approval,null);
  assert.equal(requests.length,2);for(const {url,options,body} of requests){assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(options.headers['x-api-key'],'private-anthropic-key');assert.equal(options.headers.Authorization,undefined);assert.equal(body.model,'claude-sonnet-4-6');assert.equal(typeof body.system,'string');assert.equal(body.messages[0].role,'user');assert.equal(body.response_format,undefined);assert.equal(JSON.stringify(body).includes('test-private-key'),false);}
  assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));assert.doesNotMatch(JSON.stringify([generated,extracted]),/private-anthropic-key|test-private-key/);
});

test('switching provider cancels a pending completion and requires explicit re-enabling of automatic drafts',async()=>{
  const h=harness(),entered=deferred(),gate=deferred();await autoReady(h);
  h.fetchAction=async()=>{entered.resolve();await gate.promise;return new Response(JSON.stringify({choices:[{message:{content:'Late OpenAI reply'}}]}));};
  const pending=h.command('GENERATE_DRAFT',{key});await entered.promise;const switched=await useClaude(h);assert.equal(switched.state.settings.autoDraft,false);gate.resolve();assert.equal((await pending).ok,false);
  const current=await h.command('GET');assert.equal(current.state.conversations[key].draft,null);assert.equal(current.ai.provider,'anthropic');await poll(h);assert.equal(h.fetches,1);
});

test('neither provider credential appears in public state, diagnostic events or manual prompt exports',async()=>{
  const h=harness();await ready(h);await useClaude(h);
  h.fetchAction=async()=>{throw new Error('private-anthropic-key test-private-key secret-provider-detail');};
  const failed=await h.command('GENERATE_DRAFT',{key});assert.equal(failed.ok,false);
  const results=[failed,await h.command('GET'),await exportProduct(h),await exportDialog(h),h.storage[DIALOGS_KEY]];
  assert.doesNotMatch(JSON.stringify(results),/private-anthropic-key|test-private-key|secret-provider-detail/);
  assert.equal(h.storage[providerStorageKey].profiles.openai.apiKey,'test-private-key');assert.equal(h.storage[providerStorageKey].profiles.anthropic.apiKey,'private-anthropic-key');
});

test('manual product and dialogue TXT exports need no API permission or key and re-read the selected conversation',async()=>{
  const h=harness();await manualReady(h);const before=await h.command('GET');
  const product=await exportProduct(h);assert.match(product.filename,/\.txt$/);assert.match(product.text,/100 units/);assert.deepEqual(product.request,{revision:before.state.product.revision,fingerprint:before.productFingerprint});
  h.replies.get(1).conversations[0].messages.push({id:'m2',direction:'inbound',text:'The current MOQ is 75 units.'});
  const callCount=h.calls.length,dialog=await exportDialog(h);assert.ok(h.calls.length>callCount);assert.match(dialog.text,/current MOQ is 75 units/);assert.match(dialog.filename,/\.txt$/);assert.equal(dialog.request.key,key);assert.ok(dialog.request.settingsFingerprint);assert.ok(dialog.request.productFingerprint);
  const current=await h.command('GET');assert.deepEqual(current.state.product.approval,before.state.product.approval);assert.equal(current.state.conversations[key].draft,null);assert.equal(h.fetches,0);assert.equal(h.permissionRequests.length,0);assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));
});

test('manual product result is parsed and saved without an API call, but never approves itself',async()=>{
  const h=harness();await manualReady(h);const exported=await exportProduct(h);
  const imported=await h.command('IMPORT_PRODUCT_RESULT',{request:exported.request,text:'```json\n'+JSON.stringify(extractedProduct)+'\n```'});
  assert.equal(imported.ok,true,imported.error);assert.equal(imported.state.product.keyPoints,extractedProduct.keyPoints);assert.equal(imported.state.product.questions,extractedProduct.questions);assert.equal(imported.state.product.approval,null);assert.equal(imported.state.settings.autoDraft,false);
  assert.equal((await h.command('EXPORT_DRAFT_PROMPT',{key})).ok,false);assert.equal((await h.command('PRODUCT_APPROVE',exported.request)).ok,false);
  const approved=await h.command('PRODUCT_APPROVE',{revision:imported.state.product.revision,fingerprint:imported.productFingerprint});assert.equal(approved.ok,true,approved.error);assert.ok((await exportDialog(h)).text);assert.equal(h.fetches,0);assert.equal(h.permissionRequests.length,0);
});

test('manual product result refuses stale, missing and malformed request contexts without replacing current edits',async()=>{
  const h=harness();await manualReady(h);const exported=await exportProduct(h);
  await h.command('PRODUCT_SAVE',{product:{keyPoints:'Manually checked newer requirements'}});
  for(const request of [exported.request,undefined,{revision:'1',fingerprint:'bad'}]){
    const response=await h.command('IMPORT_PRODUCT_RESULT',{request,text:JSON.stringify(extractedProduct)});assert.equal(response.ok,false);assert.equal((await h.command('GET')).state.product.keyPoints,'Manually checked newer requirements');
  }
  const current=await exportProduct(h),invalid=await h.command('IMPORT_PRODUCT_RESULT',{request:current.request,text:'Explanation without valid JSON'});assert.equal(invalid.ok,false);assert.match(invalid.error,/JSON.*keyPoints.*questions.*warnings/);assert.equal((await h.command('GET')).state.product.keyPoints,'Manually checked newer requirements');assert.equal(h.fetches,0);
});

test('manual product image analysis requires confirmation of attachments and still needs user approval',async()=>{
  const h=harness();await manualReady(h);await h.command('PRODUCT_SAVE',{product:{files:[{id:'photo',name:'product.png',mime:'image/png',status:'ready',contentHash:'photo-hash',images:[{imageKey:'photo:1',mime:'image/png'}],text:''}]}});
  const exported=await exportProduct(h);assert.equal(exported.requiredImages.length,1);assert.equal(exported.requiredImages[0].imageKey,'photo:1');assert.match(exported.warnings.join('\n'),/не включены в TXT/);
  const payload={request:exported.request,text:JSON.stringify(extractedProduct)};
  for(const imagesAttached of [undefined,false]){const response=await h.command('IMPORT_PRODUCT_RESULT',{...payload,imagesAttached});assert.equal(response.ok,false);assert.match(response.error,/изображения/);assert.equal((await h.command('GET')).state.product.extraction,null);}
  const imported=await h.command('IMPORT_PRODUCT_RESULT',{...payload,imagesAttached:true});assert.equal(imported.ok,true,imported.error);assert.equal(imported.state.product.approval,null);assert.deepEqual(imported.state.product.extraction.processedImageKeys,['photo:1']);
  assert.equal((await h.command('PRODUCT_APPROVE',{revision:imported.state.product.revision,fingerprint:imported.productFingerprint})).ok,true);assert.equal(h.fetches,0);
});

test('manual dialogue export refuses unread, inactive or ambiguous current conversations without API or chat mutations',async()=>{
  for(const mode of ['unread-history','inactive','unknown-sender','unread-attachment','unapproved-product']){
    const h=harness();await manualReady(h);const row=h.replies.get(1).conversations[0];
    if(mode==='unread-history')Object.assign(row,{tailKnown:false,needsRead:true});
    if(mode==='inactive')Object.assign(row,{active:false,needsRead:true,messages:[]});
    if(mode==='unknown-sender')row.messages[0].direction='unknown';
    if(mode==='unread-attachment')row.messages[0].attachments=[{type:'file',name:'unavailable.xlsx'}];
    if(mode==='unapproved-product')await h.command('PRODUCT_SAVE',{product:{rules:'New requirements need review'}});
    const response=await h.command('EXPORT_DRAFT_PROMPT',{key});assert.equal(response.ok,false,mode);assert.equal(response.promptExport,undefined);assert.equal(h.fetches,0);assert.equal(h.permissionRequests.length,0);assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));
  }
});

test('manual Claude answer is stored only as a draft tied to its exported context',async()=>{
  const h=harness();await manualReady(h);const exported=await exportDialog(h),saved=await saveExternalDraft(h,exported.request);
  assert.equal(saved.ok,true,saved.error);assert.equal(saved.state.conversations[key].draft.text,'We need 100 units. What is your MOQ?');assert.equal(saved.state.conversations[key].draft.status,'draft');assert.equal(h.fetches,0);assert.equal(h.permissionRequests.length,0);assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));
});

test('manual answer from an older export cannot overwrite a conversation after product, rules or history change',async()=>{
  for(const change of ['product','settings','history','conversation']){
    const h=harness();await manualReady(h);const exported=await exportDialog(h);
    if(change==='product')await h.command('PRODUCT_SAVE',{product:{characteristics:'Need 200 units now'}});
    if(change==='settings')await h.command('SETTINGS',{settings:{brief:'Need 100 units',wechat:'different-contact',language:'Chinese'}});
    if(change==='history'){h.replies.get(1).conversations[0].messages.push({id:'m2',direction:'inbound',text:'We no longer have that product.'});await h.command('SCAN');}
    if(change==='conversation')exported.request.key=conversationKey('1688','different-supplier');
    const response=await saveExternalDraft(h,exported.request);assert.equal(response.ok,false,change);assert.equal((await h.command('GET')).state.conversations[key].draft,null);assert.equal(h.fetches,0);
  }
});

test('importing a manual answer re-reads the selected thread before accepting a previously exported history',async()=>{
  const h=harness();await manualReady(h);const exported=await exportDialog(h);
  h.replies.get(1).conversations[0].messages.push({id:'m2',direction:'inbound',text:'Please wait; the price changed.'});
  const response=await saveExternalDraft(h,exported.request);assert.equal(response.ok,false);assert.equal((await h.command('GET')).state.conversations[key].draft,null);assert.equal(h.fetches,0);assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));
});

test('marketplace pages cannot export prompts or import Claude answers',async()=>{
  const h=harness();await manualReady(h);const exported=await exportProduct(h),before=h.reads,sender={id:'test',url:urls['1688'],tab:{id:1}};
  for(const [type,payload] of [['EXPORT_PRODUCT_PROMPT',{}],['EXPORT_DRAFT_PROMPT',{key}],['IMPORT_PRODUCT_RESULT',{request:exported.request,text:JSON.stringify(extractedProduct)}]])assert.equal((await h.command(type,payload,sender)).ok,false,type);
  assert.equal(h.reads,before);assert.equal(h.fetches,0);
});

function fakeFolder(h) {
  const jobs=new Map(),calls=[];let loseSubmit=false;
  h.api.runtime.sendNativeMessage=async(host,message)=>{
    assert.equal(host,'com.openlinks.claude_folder');calls.push(structuredClone(message));
    if(message.action==='status')return {ok:true,protocol:1,folder:'C:\\Users\\Buyer\\Desktop\\OpenLinks Claude',worker:{running:false,status:'offline'},claude:{available:true}};
    if(message.action==='configure')return {ok:true};
    if(message.action==='submit') {if(!jobs.has(message.job.id))jobs.set(message.job.id,{...structuredClone(message.job),status:'queued'});if(loseSubmit){loseSubmit=false;throw new Error('lost after durable write');}return {ok:true,jobId:message.job.id,status:jobs.get(message.job.id).status};}
    if(message.action==='poll')return {ok:true,results:message.ids.flatMap(id=>jobs.has(id)?[{id,status:jobs.get(id).status,request:jobs.get(id).request,imageKeys:(jobs.get(id).images||[]).map(image=>image.imageKey),text:jobs.get(id).text}]:[])};
    if(message.action==='cancel') {if(jobs.has(message.id))jobs.get(message.id).status='cancelled';return {ok:true};}
    if(message.action==='ack')return {ok:true};
    throw new Error('Unexpected native action');
  };
  return {jobs,calls,get first(){return [...jobs.values()][0];},loseNextSubmit(){loseSubmit=true;},done(text='Could you quote 100 units?',job=[...jobs.values()][0]){job.status='done';job.text=text;},error(job=[...jobs.values()][0]){job.status='error';}};
}
async function folderReady(h,options={}) {await ready(h);const host=fakeFolder(h);const reply=await h.command('FOLDER_SETTINGS',{enabled:true,...options});assert.equal(reply.ok,true,reply.error);return host;}

test('folder job round trip requires explicit enable, native permission and current recipient; no API call or supplier send',async()=>{
  const h=harness();await ready(h);const host=fakeFolder(h);
  assert.equal((await h.command('GET')).folder.enabled,false);assert.equal((await h.command('FOLDER_DRAFT',{key})).ok,false);
  h.allowed=request=>!request.permissions;assert.equal((await h.command('FOLDER_SETTINGS',{enabled:true})).ok,false);assert.equal(host.calls.length,0);
  h.allowed=true;await h.command('FOLDER_SETTINGS',{enabled:true});const queued=await h.command('FOLDER_DRAFT',{key});assert.equal(queued.ok,true,queued.error);assert.equal(queued.folder.jobs[0].status,'queued');
  assert.equal(host.first.request.key,key);assert.match(host.first.prompt,/What quantity/);assert.equal(JSON.stringify(h.storage.openlinksClaudeFolder).includes('What quantity'),false);
  host.done();const accepted=await h.command('FOLDER_POLL');assert.equal(accepted.ok,true);assert.equal(accepted.state.conversations[key].draft.text,'Could you quote 100 units?');assert.equal(accepted.folder.jobs[0].status,'accepted');
  assert.equal(h.fetches,0);assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));assert.ok(host.calls.some(call=>call.action==='ack'&&call.outcome==='accepted'));
  await h.command('DISCARD_DRAFT',{key});assert.equal((await h.command('FOLDER_DRAFT',{key})).ok,false);
});
test('folder output for changed history, document, recipient or edited draft cannot overwrite current context',async()=>{
  for(const change of ['history','document','recipient','draft','product']) {
    const h=harness(),host=await folderReady(h);await h.command('FOLDER_DRAFT',{key});host.done('Late answer');
    if(change==='history')h.replies.get(1).conversations[0].messages.push({id:'m2',direction:'inbound',text:'New question'});
    if(change==='document')h.replies.get(1).documentToken='another-document';
    if(change==='recipient')host.first.request={...host.first.request,key:'1688:wrong'};
    if(change==='draft'){const item=(await h.command('GET')).state.conversations[key];await h.command('SAVE_DRAFT',{key,text:'Human draft',revision:item.revision,fingerprint:item.fingerprint});}
    if(change==='product')await h.command('PRODUCT_SAVE',{product:{cardText:'Different product',keyPoints:'Different product'}});
    const response=await h.command('FOLDER_POLL');assert.notEqual(response.state.conversations[key].draft?.text,'Late answer',change);assert.ok(['stale','cancelled'].includes(response.folder.jobs[0].status),change);
    assert.equal(h.fetches,0);
  }
});
test('folder submit with lost acknowledgment is polled or retried with exactly the same UUID',async()=>{
  const h=harness(),host=await folderReady(h);host.loseNextSubmit();const first=await h.command('FOLDER_DRAFT',{key}),id=first.folder.jobs[0].id;
  assert.equal(first.folder.jobs[0].status,'unknown');assert.equal(host.jobs.size,1);
  const retried=await h.command('FOLDER_RETRY',{id});assert.equal(retried.ok,true,retried.error);assert.equal(host.jobs.size,1);assert.equal(host.calls.filter(call=>call.action==='submit').every(call=>call.job.id===id),true);
  host.done();assert.equal((await h.command('FOLDER_POLL')).folder.jobs[0].status,'accepted');
});
test('confirmed failed folder jobs retry explicitly with bounded new IDs and cannot fork from an old record',async()=>{
  const h=harness(),host=await folderReady(h);await h.command('FOLDER_DRAFT',{key});const first=host.first.id;
  host.error();await h.command('FOLDER_POLL');assert.equal((await h.command('FOLDER_RETRY',{id:first})).ok,true);assert.equal(host.jobs.size,2);
  assert.equal((await h.command('FOLDER_RETRY',{id:first})).ok,false);
  const second=[...host.jobs.values()].at(-1);host.error(second);await h.command('FOLDER_POLL');assert.equal((await h.command('FOLDER_RETRY',{id:second.id})).ok,true);
  const third=[...host.jobs.values()].at(-1);host.error(third);await h.command('FOLDER_POLL');assert.equal((await h.command('FOLDER_RETRY',{id:third.id})).ok,false);assert.equal((await h.command('FOLDER_RETRY',{id:first})).ok,false);assert.equal(host.jobs.size,3);
});
test('automatic folder mode queues each platform once, holds pending target and respects product approval',async()=>{
  const h=harness(),host=await folderReady(h,{auto:true});await h.command('BIND_TAB',{platform:'alibaba',tabId:2});
  // Binding change cancels prior tasks but leaves the chosen mode; no job exists yet.
  h.replies.get(1).conversations.push(unreadRow('later'));await h.command('START',{readUnread:true});await poll(h);
  assert.equal(host.jobs.size,2);assert.equal(opening(h).length,0);await poll(h);assert.equal(host.jobs.size,2);assert.equal(opening(h).length,0);
  host.done();await poll(h);assert.equal((await h.command('GET')).state.conversations[key].draft.text,'Could you quote 100 units?');
  await h.command('PRODUCT_SAVE',{product:{keyPoints:'Changed approved points'}});await poll(h);assert.equal(host.jobs.size,2);
});
test('folder product extraction imports structured result but requires new user approval',async()=>{
  const h=harness(),host=await folderReady(h);const before=await h.command('GET');const queued=await h.command('FOLDER_PRODUCT',{revision:before.state.product.revision,fingerprint:before.productFingerprint});assert.equal(queued.ok,true,queued.error);
  host.done(JSON.stringify({keyPoints:'Quantity: 100 units',questions:'Price?',warnings:''}));const result=await h.command('FOLDER_POLL');assert.equal(result.state.product.keyPoints,'Quantity: 100 units');assert.equal(result.state.product.approval,null);assert.equal(result.folder.jobs[0].status,'accepted');assert.equal(h.fetches,0);
});
test('folder busy UI defers a ready answer and pause cancels it without replacing manual work',async()=>{
  const h=harness(),host=await folderReady(h);await h.command('FOLDER_DRAFT',{key});host.done();h.replies.get(1).busy={hasDraft:true};const deferred=await h.command('FOLDER_POLL');assert.equal(deferred.folder.jobs[0].status,'done');assert.equal(deferred.state.conversations[key].draft,null);
  await h.command('CONTROL',{key,takeover:true});assert.equal((await h.command('FOLDER_POLL')).folder.jobs[0].status,'cancelled');
});
test('folder send requires separate opt-in and durable quota reservation; uncertain sends never retry',async()=>{
  const sends=[],quotas=[];const h=harness({folderSender:async options=>{sends.push(options);assert.equal(options.enabled,true);assert.equal(options.shouldContinue(),true);const result=await options.reserve({attemptId:'attempt-1',platform:'1688',at:100});assert.equal(result.ok,true);assert.equal(h.storage.openlinksClaudeFolder.jobs[0].status,'sending');return {status:'unknown'};},reserveDialogSendQuota:async request=>{quotas.push(request);return {ok:true};}}),host=await folderReady(h,{auto:true,autoSend:true});
  await h.command('START');await poll(h);host.done();await poll(h);const response=await h.command('GET');assert.equal(response.folder.jobs[0].status,'send_unknown');assert.equal(sends.length,1);assert.equal(quotas[0].jobId,host.first.id);
  await poll(h);await h.command('FOLDER_POLL');assert.equal(sends.length,1);assert.equal((await h.command('FOLDER_RETRY',{id:host.first.id})).ok,false);
});
test('folder sends stay off in draft mode even when the worker returns a ready answer',async()=>{
  let sends=0;const h=harness({folderSender:async()=>{sends++;return {status:'attempted'};}}),host=await folderReady(h,{auto:true});await h.command('START');await poll(h);host.done();await poll(h);assert.equal(sends,0);assert.equal((await h.command('GET')).folder.jobs[0].status,'accepted');
});
test('folder jobs persist across service-worker recreation and startup revokes automatic sending authority',async()=>{
  const h=harness(),host=await folderReady(h,{auto:true,autoSend:true});await h.command('FOLDER_DRAFT',{key});host.done();
  const recreated=createDialogMonitor({api:h.api,now:()=>h.time});assert.equal((await recreated.handle({type:'DIALOGS_FOLDER_POLL'},ui)).folder.jobs[0].status,'accepted');
  await recreated.onStartup();const state=await recreated.handle({type:'DIALOGS_GET'},ui);assert.equal(state.folder.enabled,false);assert.equal(state.folder.autoSend,false);
});
test('marketplace scripts cannot submit, inspect, cancel or consume native folder jobs',async()=>{
  const h=harness(),host=fakeFolder(h);for(const type of ['FOLDER_STATUS','FOLDER_SETTINGS','FOLDER_DRAFT','FOLDER_PRODUCT','FOLDER_POLL','FOLDER_RETRY','FOLDER_CANCEL'])assert.equal((await h.command(type,{enabled:true,key},{id:'test',url:urls['1688']})).ok,false);assert.equal(host.calls.length,0);assert.equal(h.reads,0);
});

test('folder status reports offline pause and resume keeps queued identifiers',async()=>{
  const h=harness(),host=await folderReady(h);await h.command('FOLDER_DRAFT',{key});const native=h.api.runtime.sendNativeMessage;
  h.api.runtime.sendNativeMessage=(name,message)=>message.action==='status'?Promise.resolve({ok:true,protocol:1,folder:'C:\\Jobs',worker:{running:true,status:'paused',pauseReason:'offline'},claude:{available:true}}):native(name,message);
  const state=await h.command('FOLDER_POLL');assert.equal(state.folder.status,'paused');assert.equal(state.folder.worker.pauseReason,'offline');assert.match(state.folder.detail,/без интернета/);
  await h.command('FOLDER_SETTINGS',{enabled:true});assert.equal(host.jobs.size,1);assert.equal((await h.command('GET')).folder.jobs[0].status,'queued');
});
test('STOP or folder cancellation while native polling waits prevents subsequent acceptance and send',async()=>{
  for(const action of ['STOP','FOLDER_CANCEL']) {
    let sends=0;const h=harness({folderSender:async()=>{sends++;return {status:'attempted'};}}),host=await folderReady(h,{auto:true,autoSend:true});await h.command('START');await poll(h);host.done();
    const native=h.api.runtime.sendNativeMessage,entered=deferred(),gate=deferred();h.api.runtime.sendNativeMessage=async(name,message)=>{if(message.action==='poll'){entered.resolve();await gate.promise;}return native(name,message);};
    const pending=h.command('FOLDER_POLL');await entered.promise;const stopped=h.command(action,{id:host.first.id});gate.resolve();await Promise.all([pending,stopped]);
    const state=await h.command('GET');assert.equal(sends,0);assert.equal(state.state.conversations[key].draft,null);assert.equal(state.folder.jobs[0].status,'cancelled');
  }
});
test('folder reply lists every processed product image and cannot mark missing pixels as analysed',async()=>{
  const h=harness(),host=await folderReady(h);
  const file={id:'photo',name:'product.png',kind:'image',mime:'image/png',status:'ready',text:'',contentHash:'a'.repeat(64),images:[{imageKey:'img:photo',mime:'image/png'}]};
  await h.command('PRODUCT_SAVE',{product:{cardText:'Product drawing',files:[file]}});h.images.set('img:photo','data:image/png;base64,aGVsbG8=');
  const before=await h.command('GET');const queued=await h.command('FOLDER_PRODUCT',{revision:before.state.product.revision,fingerprint:before.productFingerprint});assert.equal(queued.ok,true,queued.error);
  assert.equal(host.first.images[0].data,'aGVsbG8=');assert.deepEqual(host.first.request.imageKeys,['img:photo']);host.done(JSON.stringify({keyPoints:'Drawing supplied',questions:'Confirm dimensions',warnings:''}));
  const result=await h.command('FOLDER_POLL');assert.deepEqual(result.state.product.extraction.processedImageKeys,['img:photo']);assert.equal(result.state.product.approval,null);
});

test('quota deferred replies resume without new Claude inference and do not block another platform',async()=>{
  const attempts=[];let h;
  h=harness({folderSender:async options=>{attempts.push(options.request.key);if(options.request.key===key&&attempts.filter(value=>value===key).length===1)return {status:'deferred',retryAt:h.time+1200000};assert.equal((await options.reserve({attemptId:crypto.randomUUID(),platform:options.state.conversations[options.request.key].platform,at:h.time})).ok,true);return {status:'attempted'};},reserveDialogSendQuota:async()=>({ok:true})});
  const host=await folderReady(h,{auto:true,autoSend:true});await h.command('BIND_TAB',{platform:'alibaba',tabId:2});await h.command('START');await poll(h);
  for(const job of host.jobs.values())host.done('Thank you. Please quote 100 units.',job);
  await poll(h);let response=await h.command('GET');assert.equal(response.folder.jobs.find(job=>job.key===key).status,'awaiting_limit');assert.equal(response.folder.jobs.find(job=>job.key!==key).status,'sent');assert.equal(JSON.stringify(h.storage.openlinksClaudeFolder).includes('Thank you. Please quote 100 units.'),false);
  const total=host.calls.filter(call=>call.action==='submit').length;
  h.advanceTime(1199000);await poll(h);assert.equal(attempts.filter(value=>value===key).length,1);
  h.advanceTime(2000);await poll(h);response=await h.command('GET');assert.equal(response.folder.jobs.find(job=>job.key===key).status,'sent');assert.equal(attempts.filter(value=>value===key).length,2);assert.equal(host.calls.filter(call=>call.action==='submit').length,total);
  await poll(h);assert.equal(attempts.filter(value=>value===key).length,2);
});
test('quota waiting response is discarded when its incoming context changes',async()=>{
  let attempts=0;const h=harness({folderSender:async()=>{attempts++;return {status:'deferred',retryAt:h.time+60000};}}),host=await folderReady(h,{auto:true,autoSend:true});await h.command('START');await poll(h);host.done();await poll(h);
  assert.equal((await h.command('GET')).folder.jobs[0].status,'awaiting_limit');h.advanceTime(61000);h.replies.get(1).conversations[0].messages.push({id:'new-message',direction:'inbound',text:'The quantity has changed.'});
  await h.command('FOLDER_POLL');const result=await h.command('GET');assert.equal(result.folder.jobs[0].status,'stale');assert.equal(result.state.conversations[key].draft,null);assert.equal(attempts,1);
});

test('a missing folder image can be retried after its cached bytes become available',async()=>{
  const h=harness(),host=await folderReady(h);
  const file={id:'photo',name:'drawing.png',kind:'image',mime:'image/png',status:'ready',text:'',contentHash:'a'.repeat(64),images:[{imageKey:'img:retry',mime:'image/png'}]};
  await h.command('PRODUCT_SAVE',{product:{cardText:'Drawing',files:[file]}});let before=await h.command('GET');assert.equal((await h.command('FOLDER_PRODUCT',{revision:before.state.product.revision,fingerprint:before.productFingerprint})).ok,false);
  before=await h.command('GET');assert.equal(before.folder.jobs[0].status,'error');assert.equal(host.jobs.size,0);
  h.images.set('img:retry','data:image/png;base64,aGVsbG8=');const retry=await h.command('FOLDER_RETRY',{id:before.folder.jobs[0].id});assert.equal(retry.ok,true,retry.error);assert.equal(host.jobs.size,1);assert.deepEqual(host.first.request.imageKeys,['img:retry']);
});

test('monitor start journal describes the actual folder sending mode',async()=>{
  const h=harness();await folderReady(h,{auto:true,autoSend:true});const started=await h.command('START');const detail=started.state.events.filter(event=>event.type==='monitor_started').at(-1).detail;assert.match(detail,/Автоматическая отправка разрешена/);assert.doesNotMatch(detail,/Ввод и отправка сообщений отключены/);
  await h.command('FOLDER_SETTINGS',{enabled:false});const paused=await h.command('START');assert.match(paused.state.events.filter(event=>event.type==='monitor_started').at(-1).detail,/Ввод и отправка сообщений отключены/);
});

test('a full folder queue does not pin traversal and previously read unanswered chats resume when capacity returns',async()=>{
  const h=harness(),host=await folderReady(h,{auto:true});
  h.replies.get(1).conversations.push(unreadRow('backlog',{unread:false,needsRead:false,orderReliable:true,tailKnown:true,messages:[{id:'backlog-message',direction:'inbound',text:'Please quote this product.'}]}));await h.command('SCAN');
  const config=h.storage.openlinksClaudeFolder;config.jobs=Array.from({length:12},(_,index)=>({id:crypto.randomUUID(),kind:'product',key:'__product_extraction__',status:'queued',request:{revision:index,fingerprint:'old',imageKeys:[]},signature:index.toString(16).padStart(64,'0'),createdAt:h.time,at:h.time,attempts:1,configRevision:config.revision}));
  await h.command('START',{readUnread:true});await poll(h);assert.equal(host.jobs.size,0);
  h.storage.openlinksClaudeFolder.jobs=[];h.replies.get(1).conversations[0].messages.push({id:'answered',direction:'outbound',text:'We need 100 units.'});
  await poll(h);assert.equal(opening(h).at(-1)?.conversationId,'backlog');assert.equal(host.jobs.size,0);
});
