import test from 'node:test';
import assert from 'node:assert/strict';
import {createDialogMonitor,dialogPlatform,isMonitoredTab,DIALOGS_KEY,installDialogMonitor} from '../extension/dialog-monitor.js';
import {conversationKey} from '../extension/lib/dialogs.js';

const urls={1688:'https://air.1688.com/app/chat/index.html',alibaba:'https://message.alibaba.com/message/default.htm',mic:'https://webim.made-in-china.com/super-tm/'};
const ui={id:'test',url:'chrome-extension://test/dialogs.html'};
const key=conversationKey('1688','supplier-1');
function snapshot(platform='1688',extra={}) {
  return {platform,status:'ready',url:urls[platform],documentToken:'doc-1',frames:[],conversations:[{id:'supplier-1',title:'Supplier',identityReliable:true,active:true,unread:true,orderReliable:true,tailKnown:true,messages:[{id:'m1',direction:'inbound',text:'What quantity do you need?'}]}],...extra};
}
function harness() {
  const storage={},calls=[],alarms=[],tabs=new Map([[1,{id:1,url:urls['1688'],status:'complete'}],[2,{id:2,url:urls.alibaba}],[3,{id:3,url:urls.mic}]]);
  const replies=new Map([[1,snapshot()],[2,snapshot('alibaba')],[3,snapshot('mic')]]);
  const frameLists=new Map();let reads=0,fetches=0,allowed=true,time=1000000,openAction=async message=>({ok:true,openedId:message.conversationId}),revealAction=async message=>({ok:true,revealedId:message.conversationId}),fetchAction=async()=>new Response(JSON.stringify({choices:[{message:{content:'We need 100 units. Could you share your WeChat?'}}]}));
  const listeners=()=>({list:[],addListener(fn){this.list.push(fn);}});
  const api={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onMessage:listeners(),onStartup:listeners(),onInstalled:listeners()},
    storage:{local:{get:async name=>{reads++;return {[name]:structuredClone(storage[name])};},set:async data=>Object.assign(storage,structuredClone(data)),setAccessLevel:async value=>calls.push({access:value})}},
    tabs:{get:async id=>{if(!tabs.has(id))throw new Error('No tab');return structuredClone(tabs.get(id));},query:async()=>[...tabs.values()],
      sendMessage:async(id,message,options)=>{calls.push({id,...structuredClone(message),frameId:options.frameId});if(message.type==='DIALOGS_OPEN_CONVERSATION')return openAction(message,id);if(message.type==='DIALOGS_REVEAL_LATEST')return revealAction(message,id);const value=replies.get(`${id}:${options.frameId}`) || replies.get(id);return typeof value==='function'?value(message):structuredClone(value);},onUpdated:listeners(),onRemoved:listeners()},
    webNavigation:{getAllFrames:async({tabId})=>frameLists.get(tabId) || [{frameId:0,parentFrameId:-1,url:tabs.get(tabId).url}]},
    alarms:{create:async(name,options)=>alarms.push({name,...options}),clear:async()=>true,onAlarm:listeners()},
    permissions:{contains:async()=>allowed},
  };
  const monitor=createDialogMonitor({api,now:()=>time,fetchImpl:async(...args)=>{fetches++;return fetchAction(...args);}});
  return {api,monitor,storage,calls,alarms,tabs,replies,frameLists,advanceTime:ms=>{time+=ms;},get reads(){return reads;},get fetches(){return fetches;},set allowed(value){allowed=value;},set fetchAction(value){fetchAction=value;},set openAction(value){openAction=value;},set revealAction(value){revealAction=value;},command:(type,extra={},sender=ui)=>monitor.handle({type:'DIALOGS_'+type,...extra},sender)};
}
async function ready(h) {
  assert.equal((await h.command('BIND_TAB',{platform:'1688',tabId:1})).ok,true);
  assert.equal((await h.command('SCAN')).ok,true);
  assert.equal((await h.command('SETTINGS',{settings:{brief:'Need 100 units',wechat:'buyer-wechat',language:'English'},model:'gpt-4.1-mini',apiKey:'test-private-key'})).ok,true);
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
  const missing=await h.command('GENERATE_DRAFT',{key});assert.equal(missing.ok,false);assert.match(missing.error,/API-ключ/);
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
