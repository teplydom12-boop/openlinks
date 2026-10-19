import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDialogMonitor,dialogPlatform,isMonitoredTab,DIALOGS_KEY,installDialogMonitor} from '../extension/dialog-monitor.js';
import {CHAT_CENTERS} from '../extension/lib/chat-launch.js';
import {conversationKey,resolveConversationAttachments} from '../extension/lib/dialogs.js';
import {normalizeFolder} from '../extension/lib/folder-bridge.js';

const urls={1688:'https://air.1688.com/app/chat/index.html',alibaba:'https://message.alibaba.com/message/default.htm',mic:'https://webim.made-in-china.com/super-tm/'};
const ui={id:'test',url:'chrome-extension://test/dialogs.html'};
const key=conversationKey('1688','supplier-1');
const sortedJSON=value=>Array.isArray(value)?value.map(sortedJSON):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortedJSON(value[key])])):value;
function snapshot(platform='1688',extra={}) {
  return {platform,status:'ready',url:urls[platform],documentToken:'doc-1',frames:[],conversations:[{id:'supplier-1',title:'Supplier',identityReliable:true,active:true,unread:true,orderReliable:true,tailKnown:true,messages:[{id:'outreach-1',direction:'outbound',text:'Hello. We are interested in your product; please send specifications.'},{id:'m1',direction:'inbound',text:'What quantity do you need?'}]}],...extra};
}
function harness({attachmentResolver,folderSender,testCleaner,testRecovery,pauseOutreachForTest,reserveDialogSendQuota,getWorkCoordination,withDialogTurn,startOutreachForJoint,pauseOutreachForJoint,disableJointWork,micInitializationWait=async()=>{},workflowBatchSize=1,workflowAutoKick=false,workflowStepWait,reorderStorage=false}={}) {
  const storage={},session={},calls=[],alarms=[],permissionRequests=[],tabUpdates=[],tabCreates=[],windowUpdates=[],windows=new Map([[20,{id:20,type:'normal'}],[30,{id:30,type:'normal'}]]),tabs=new Map([[1,{id:1,url:urls['1688'],status:'complete'}],[2,{id:2,url:urls.alibaba}],[3,{id:3,url:urls.mic}]]);
  const replies=new Map([[1,snapshot()],[2,snapshot('alibaba')],[3,snapshot('mic')]]);
  const frameLists=new Map(),images=new Map();let nextTabId=4,reads=0,fetches=0,allowed=true,time=1000000,openAction=async message=>({ok:true,openedId:message.conversationId}),revealAction=async message=>({ok:true,revealedId:message.conversationId}),fetchAction=async()=>new Response(JSON.stringify({choices:[{message:{content:'We need 100 units. Could you share your WeChat?'}}]}));
  const listeners=()=>({list:[],addListener(fn){this.list.push(fn);}});
  const api={runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,getManifest:()=>({optional_host_permissions:['https://api.openai.com/*','https://api.anthropic.com/*']}),onMessage:listeners(),onStartup:listeners(),onInstalled:listeners()},
    storage:{session:{get:async name=>({[name]:structuredClone(session[name])}),set:async data=>Object.assign(session,structuredClone(data))},local:{get:async name=>{reads++;return {[name]:structuredClone(storage[name])};},set:async data=>Object.assign(storage,reorderStorage?sortedJSON(structuredClone(data)):structuredClone(data)),setAccessLevel:async value=>calls.push({access:value})}},
    windows:{get:async id=>{if(!windows.has(id))throw new Error('No window');return structuredClone(windows.get(id));},getLastFocused:async()=>structuredClone(windows.get(20)),update:async(id,patch)=>{windowUpdates.push({id,...patch});return {...windows.get(id),...patch};}},
    tabs:{create:async options=>{tabCreates.push(structuredClone(options));const id=nextTabId++,tab={id,windowId:options.windowId,url:options.url,status:'loading',active:options.active,autoDiscardable:true};tabs.set(id,tab);return structuredClone(tab);},get:async id=>{if(!tabs.has(id))throw new Error('No tab');return structuredClone(tabs.get(id));},query:async()=>[...tabs.values()],
      update:async(id,patch)=>{if(!tabs.has(id))throw new Error('No tab');tabUpdates.push({id,...patch});Object.assign(tabs.get(id),patch);return structuredClone(tabs.get(id));},
      sendMessage:async(id,message,options)=>{calls.push({id,...structuredClone(message),frameId:options.frameId});if(message.type==='DIALOGS_OPEN_CONVERSATION')return openAction(message,id);if(message.type==='DIALOGS_REVEAL_LATEST')return revealAction(message,id);const value=replies.get(`${id}:${options.frameId}`) || replies.get(id);return typeof value==='function'?value(message):structuredClone(value);},onUpdated:listeners(),onRemoved:listeners()},
    webNavigation:{getAllFrames:async({tabId})=>frameLists.get(tabId) || [{frameId:0,parentFrameId:-1,url:tabs.get(tabId).url}]},
    alarms:{create:async(name,options)=>alarms.push({name,...options}),clear:async()=>true,onAlarm:listeners()},
    permissions:{contains:async request=>{permissionRequests.push(structuredClone(request));return typeof allowed==='function'?allowed(request):allowed;}},
  };
  const monitor=createDialogMonitor({api,now:()=>time,attachmentResolver,folderSender,testCleaner,testRecovery,pauseOutreachForTest,reserveDialogSendQuota,getWorkCoordination,withDialogTurn,startOutreachForJoint,pauseOutreachForJoint,disableJointWork,micInitializationWait,workflowBatchSize,workflowAutoKick,workflowStepWait:workflowStepWait || (async ms=>{time+=ms;}),imageLoader:async key=>{if(!images.has(key))throw new Error('Файл изображения недоступен.');return images.get(key);},fetchImpl:async(...args)=>{fetches++;return fetchAction(...args);}});
  return {api,monitor,storage,session,calls,alarms,permissionRequests,tabUpdates,tabCreates,windowUpdates,windows,tabs,replies,frameLists,images,advanceTime:ms=>{time+=ms;},get time(){return time;},get reads(){return reads;},get fetches(){return fetches;},set allowed(value){allowed=value;},set fetchAction(value){fetchAction=value;},set openAction(value){openAction=value;},set revealAction(value){revealAction=value;},command:(type,extra={},sender=ui)=>monitor.handle({type:'DIALOGS_'+type,...extra},sender)};
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
test('bound tabs stay resident without activation and restore only owned auto-discard changes',async()=>{
  const h=harness();h.tabs.get(1).autoDiscardable=true;h.tabs.get(2).autoDiscardable=false;
  await h.command('BIND_TAB',{platform:'1688',tabId:1});await h.command('BIND_TAB',{platform:'alibaba',tabId:2});
  assert.deepEqual(h.tabUpdates,[{id:1,autoDiscardable:false}]);
  assert.deepEqual(h.storage[DIALOGS_KEY].bindings['1688'].discardProtection,{status:'protected',original:true,changed:true});
  assert.deepEqual(h.storage[DIALOGS_KEY].bindings.alibaba.discardProtection,{status:'protected',original:false,changed:false});
  // A second bind and a service-worker recreation must retain restoration authority.
  await h.command('BIND_TAB',{platform:'1688',tabId:1});
  const restarted=createDialogMonitor({api:h.api});
  assert.equal((await restarted.handle({type:'DIALOGS_UNBIND_TAB',platform:'1688'},ui)).ok,true);
  await h.command('UNBIND_TAB',{platform:'alibaba'});
  assert.deepEqual(h.tabUpdates,[{id:1,autoDiscardable:false},{id:1,autoDiscardable:true}]);
  assert.equal(h.tabs.get(2).autoDiscardable,false);
});
test('replacing or navigating away releases the protected tab; unrelated tabs stay untouched',async()=>{
  const h=harness();h.tabs.get(1).autoDiscardable=true;h.tabs.set(4,{id:4,url:urls['1688'],autoDiscardable:true});
  await h.command('BIND_TAB',{platform:'1688',tabId:1});await h.command('BIND_TAB',{platform:'1688',tabId:4});
  assert.deepEqual(h.tabUpdates,[{id:1,autoDiscardable:false},{id:1,autoDiscardable:true},{id:4,autoDiscardable:false}]);
  h.tabs.get(4).url='https://example.com/';await h.monitor.onTabUpdated(4,{url:'https://example.com/'},h.tabs.get(4));
  assert.deepEqual(h.tabUpdates.at(-1),{id:4,autoDiscardable:true});
  assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].tabId,null);
  assert.equal(h.tabUpdates.some(update=>update.id===2||update.id===3),false);
});
test('protection failure is diagnosed once and does not invent restoration authority',async()=>{
  for(const unsupported of [true,false]) {
    const h=harness();let attempts=0;
    if(!unsupported){h.tabs.get(1).autoDiscardable=true;h.api.tabs.update=async()=>{attempts++;throw new Error('not supported');};}
    await h.command('BIND_TAB',{platform:'1688',tabId:1});await h.command('SCAN');await h.command('SCAN');
    const state=h.storage[DIALOGS_KEY];assert.equal(state.bindings['1688'].discardProtection.status,unsupported?'unsupported':'failed');
    assert.equal(state.events.filter(event=>event.type==='tab_discard_protection').length,1);
    await h.command('UNBIND_TAB',{platform:'1688'});assert.equal(attempts,unsupported?0:1);
  }
});
test('an external protection override is respected instead of fought on each scan',async()=>{
  const h=harness();h.tabs.get(1).autoDiscardable=true;await h.command('BIND_TAB',{platform:'1688',tabId:1});
  h.tabs.get(1).autoDiscardable=true;await h.command('SCAN');await h.command('SCAN');
  assert.equal(h.tabUpdates.length,1);assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].discardProtection.status,'overridden');
  await h.command('UNBIND_TAB',{platform:'1688'});assert.equal(h.tabUpdates.length,1);
});
test('startup and extension update drop persisted protection authority without touching tabs',async()=>{
  for(const update of [false,true]) {
    const h=harness();h.tabs.get(1).autoDiscardable=true;await h.command('BIND_TAB',{platform:'1688',tabId:1});
    if(update)await h.monitor.onInstalled({reason:'update'});else {h.tabs.get(1).url='https://personal.example/';await h.monitor.onStartup();}
    assert.equal(h.tabUpdates.length,1);assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].tabId,null);
  }
});
test('an extension update before browser startup cannot restore settings on a reused same-platform tab ID',async()=>{
  const h=harness();h.tabs.get(1).autoDiscardable=true;await h.command('BIND_TAB',{platform:'1688',tabId:1});
  assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].discardProtection.changed,true);
  // New Chrome session: this happens to be another tab with the exact same URL
  // and ID, whose owner has disabled auto-discard independently of OpenLinks.
  h.tabs.set(1,{id:1,url:urls['1688'],autoDiscardable:false,status:'complete'});
  const freshSession=createDialogMonitor({api:h.api});
  await freshSession.onInstalled({reason:'update'});
  await freshSession.onStartup();
  assert.deepEqual(h.tabUpdates,[{id:1,autoDiscardable:false}]);
  assert.equal(h.tabs.get(1).autoDiscardable,false);
  assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].tabId,null);
  assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].discardProtection,undefined);
});
test('discarded or frozen chats pause with actionable diagnostics and no reload, reading, or draft loss',async()=>{
  for(const property of ['discarded','frozen']) {
    const h=harness();await ready(h);await h.command('START');
    const item=(await h.command('GET')).state.conversations[key];
    assert.equal((await h.command('SAVE_DRAFT',{key,text:'Keep this unsent draft.',revision:item.revision,fingerprint:item.fingerprint})).ok,true);
    const before=structuredClone(h.storage[DIALOGS_KEY].conversations[key]),calls=h.calls.length;
    h.tabs.get(1)[property]=true;
    const paused=await h.command('SCAN');assert.equal(paused.state.bindings['1688'].status,'paused');
    assert.match(paused.state.bindings['1688'].detail,/Откройте её вручную/);
    assert.equal(paused.state.conversations[key].draft.text,'Keep this unsent draft.');
    assert.deepEqual(paused.state.conversations[key],before);assert.equal(h.calls.length,calls);assert.equal(h.tabUpdates.length,0);
    await h.command('SCAN');assert.equal(h.storage[DIALOGS_KEY].events.filter(event=>event.type==='monitor_health'&&/Откройте её вручную/.test(event.detail)).length,1);
    assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal(h.fetches,0);
    h.tabs.get(1)[property]=false;assert.equal((await h.command('SCAN')).state.bindings['1688'].status,'ready');
  }
});
test('a lifecycle event or suspension during snapshot invalidates the in-flight read',async()=>{
  const h=harness();await ready(h);
  await h.monitor.onTabUpdated(1,{frozen:true},{...h.tabs.get(1),frozen:true});
  assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].status,'paused');
  h.replies.set(1,()=>{h.tabs.get(1).discarded=true;return snapshot();});
  const result=await h.command('SCAN');assert.equal(result.state.bindings['1688'].status,'paused');assert.match(result.state.bindings['1688'].detail,/выгрузил/);
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
  row.messages[1].attachments=names.map(name=>({type:'image',name,url:`https://air.1688.com/${name}.png?token=private-image-token`}));
}
test('all resolved supplier image bytes accompany their associated messages and are never silently omitted',async()=>{
  const h=harness({attachmentResolver:imageResolution});await ready(h);addSupplierImages(h);let request;
  assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal(h.fetches,0);
  h.images.set('1:0','data:image/png;base64,AAAA');h.fetchAction=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'Question about the pictured product'}}]}));};
  const response=await h.command('GENERATE_DRAFT',{key});assert.equal(response.ok,true,response.error);
  const content=request.messages[1].content,context=JSON.parse(content[0].text);assert.equal(content[1].image_url.url,'data:image/png;base64,AAAA');assert.equal(context.imageInputs[0].messageKey,context.messages[1].messageKey);assert.equal(context.imageInputs[0].direction,'inbound');
  assert.equal(JSON.stringify(request).includes('private-image-token'),false);assert.equal(response.state.conversations[key].messages[1].attachments[0].contentRead,false);
});
test('oversized image context gets a persisted bounded failure without starving another platform',async()=>{
  const h=harness({attachmentResolver:imageResolution});await autoReady(h);addSupplierImages(h,['8','1']);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});
  await poll(h);let state=(await h.command('GET')).state;assert.equal(h.fetches,0);assert.equal(state.conversations[key].autoDraft.status,'error');assert.equal(state.conversations[key].autoDraft.attempts,3);
  await poll(h);assert.equal(h.fetches,1);state=(await h.command('GET')).state;assert.ok(state.conversations[conversationKey('alibaba','supplier-1')].draft);assert.equal(state.events.filter(event=>event.type==='draft_failed'&&event.key===key).length,1);
});
test('same-thread frames with different attachment sources are ambiguous even if text is identical',async()=>{
  const h=harness(),child='https://air.1688.com/inner';await ready(h);addSupplierImages(h);
  h.frameLists.set(1,[{frameId:0,parentFrameId:-1,url:urls['1688']},{frameId:5,parentFrameId:0,url:child}]);h.replies.get(1).frames=[{url:child,visible:true}];
  const alternate=structuredClone(h.replies.get(1));alternate.url=child;alternate.conversations[0].messages[1].attachments[0].url='https://air.1688.com/other.png';h.replies.set('1:5',alternate);
  const response=await h.command('SCAN');assert.equal(response.state.conversations[key].identityReliable,false);assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal(h.fetches,0);
});
test('fixed 1688 model evidence is applied only to its visible exact frame and then re-read',async()=>{
  const h=harness();await ready(h);let applied=false;const scripts=[];
  h.replies.set(1,()=>{const value=snapshot();if(!applied){value.modelEvidenceToken='nonce';value.conversations[0].messages[1].direction='unknown';}return value;});
  h.api.scripting={executeScript:async options=>{scripts.push(options);return [{frameId:0,result:{platform:'1688',status:'ready',url:urls['1688'],rows:[]}}];}};
  const send=h.api.tabs.sendMessage;h.api.tabs.sendMessage=async(id,message,options)=>{if(message.type==='DIALOGS_APPLY_MODEL_EVIDENCE'){assert.equal(message.modelEvidenceToken,'nonce');assert.equal(message.documentToken,'doc-1');applied=true;return {ok:true,applied:1};}return send(id,message,options);};
  const response=await h.command('SCAN');assert.equal(response.state.conversations[key].messages[1].direction,'inbound');assert.equal(scripts.length,1);assert.deepEqual(scripts[0],{target:{tabId:1,frameIds:[0]},world:'MAIN',files:['chat-model-evidence.js']});assert.equal(h.fetches,0);
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
    if(mode==='unknown-sender')row.messages[1].direction='unknown';
    if(mode==='unread-attachment')row.messages[1].attachments=[{type:'file',name:'unavailable.xlsx'}];
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

function fakeFolder(h,{reorderRequests=false}={}) {
  const jobs=new Map(),calls=[];let loseSubmit=false;
  h.api.runtime.sendNativeMessage=async(host,message)=>{
    assert.equal(host,'com.openlinks.claude_folder');calls.push(structuredClone(message));
    if(message.action==='status')return {ok:true,protocol:1,folder:'C:\\Users\\Buyer\\Desktop\\OpenLinks Claude',worker:{running:false,status:'offline'},claude:{available:true}};
    if(message.action==='configure')return {ok:true};
    if(message.action==='submit') {if(!jobs.has(message.job.id))jobs.set(message.job.id,{...(reorderRequests?sortedJSON(structuredClone(message.job)):structuredClone(message.job)),status:'queued'});if(loseSubmit){loseSubmit=false;throw new Error('lost after durable write');}return {ok:true,jobId:message.job.id,status:jobs.get(message.job.id).status};}
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
test('folder dialog and product round trips survive object-key reordering in Chrome storage or native transport',async()=>{
  for(const kind of ['dialog','product'])for(const reorderStorage of [false,true]) {
    const h=harness({reorderStorage});await ready(h);
    // Exercise each ordering mismatch independently: native output sorted while
    // storage keeps insertion order, and Chrome storage sorted while host does not.
    const host=fakeFolder(h,{reorderRequests:!reorderStorage});
    await h.command('FOLDER_SETTINGS',{enabled:true});
    const before=await h.command('GET');
    const queued=kind==='dialog'?await h.command('FOLDER_DRAFT',{key}):await h.command('FOLDER_PRODUCT',{revision:before.state.product.revision,fingerprint:before.productFingerprint});
    assert.equal(queued.ok,true,queued.error);
    assert.notDeepEqual(Object.keys(host.first.request),Object.keys(h.storage.openlinksClaudeFolder.jobs[0].request));
    const answer=kind==='dialog'?'We need 100 units. What is the lead time?':JSON.stringify({keyPoints:'Buyer needs 100 units.',questions:'Lead time?',warnings:''});
    host.done(answer);const response=await h.command('FOLDER_POLL');
    assert.equal(response.ok,true,response.error);assert.equal(response.folder.jobs[0].status,'accepted',kind);
    if(kind==='dialog')assert.equal(response.state.conversations[key].draft.text,answer);
    else {assert.equal(response.state.product.keyPoints,'Buyer needs 100 units.');assert.equal(response.state.product.approval,null);}
    assert.ok(host.calls.some(call=>call.action==='ack'&&call.outcome==='accepted'));
    await h.command('FOLDER_POLL');assert.equal(host.calls.filter(call=>call.action==='submit').length,1);assert.equal(h.fetches,0);
    assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));
  }
});
test('folder semantic matching still rejects changed values, types, missing fields and extra fields',async()=>{
  const mutations={value:request=>{request.fingerprint='different';},type:request=>{request.revision=String(request.revision);},missing:request=>{delete request.fingerprint;},extra:request=>{request.extra='unexpected';},null:request=>{request.fingerprint=null;},arrayType:request=>{request.imageKeys={};}};
  for(const kind of ['dialog','product'])for(const [label,mutate] of Object.entries(mutations)) {
    const h=harness({reorderStorage:true}),host=await folderReady(h),before=await h.command('GET');
    const queued=kind==='dialog'?await h.command('FOLDER_DRAFT',{key}):await h.command('FOLDER_PRODUCT',{revision:before.state.product.revision,fingerprint:before.productFingerprint});
    assert.equal(queued.ok,true,queued.error);mutate(host.first.request);
    host.done(kind==='dialog'?'Must be rejected':JSON.stringify({keyPoints:'Must be rejected',questions:'',warnings:''}));
    const response=await h.command('FOLDER_POLL');assert.equal(response.folder.jobs[0].status,'stale',kind+':'+label);
    assert.equal(response.state.conversations[key].draft,null);assert.notEqual(response.state.product.keyPoints,'Must be rejected');
    assert.ok(host.calls.some(call=>call.action==='ack'&&call.outcome==='stale'));assert.equal(h.fetches,0);
  }
});
test('folder semantic matching preserves image array order in both echoed request and result',async()=>{
  for(const change of ['request','result']) {
    const h=harness({reorderStorage:true}),host=await folderReady(h);
    const files=['first','second'].map(name=>({id:name,name:name+'.png',kind:'image',mime:'image/png',status:'ready',text:'',images:[{imageKey:'img:'+name,mime:'image/png'}]}));
    for(const file of files)h.images.set(file.images[0].imageKey,'data:image/png;base64,aGVsbG8=');
    await h.command('PRODUCT_SAVE',{product:{cardText:'Two drawings',files}});
    const before=await h.command('GET'),queued=await h.command('FOLDER_PRODUCT',{revision:before.state.product.revision,fingerprint:before.productFingerprint});assert.equal(queued.ok,true,queued.error);
    if(change==='request')host.first.request.imageKeys.reverse();else host.first.images.reverse();
    host.done(JSON.stringify({keyPoints:'Must be rejected',questions:'',warnings:''}));
    const response=await h.command('FOLDER_POLL');assert.equal(response.folder.jobs[0].status,'stale',change);assert.notEqual(response.state.product.keyPoints,'Must be rejected');
  }
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
const reviewedPayload=(response,selected=key)=>{
  const item=response.state.conversations[selected],draft=item.draft;
  return {key:selected,text:draft.text,revision:draft.revision,fingerprint:draft.fingerprint,productFingerprint:draft.productFingerprint};
};
async function reviewedReady(h,text='We need 100 units. Please quote the lead time.',selected=key) {
  await ready(h);await h.command('START');const state=(await h.command('GET')).state,item=state.conversations[selected];
  const saved=await h.command('SAVE_DRAFT',{key:selected,text,revision:item.revision,fingerprint:item.fingerprint,productFingerprint:state.product.fingerprint});assert.equal(saved.ok,true,saved.error);return reviewedPayload(saved,selected);
}
async function realManualFixture({quota=async()=>({ok:true}),send=async()=>({clicked:true})}={}) {
  const calls=[],h=harness({reserveDialogSendQuota:quota});await ready(h);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});h.replies.get(2).conversations[0].replyFingerprint='exact-reply-2';await h.command('SCAN',{platform:'alibaba'});await h.command('START');
  const selected=conversationKey('alibaba','supplier-1'),before=await h.command('GET'),item=before.state.conversations[selected];
  const saved=await h.command('SAVE_DRAFT',{key:selected,text:'We need 100 units. Please confirm 220 V.',revision:item.revision,fingerprint:item.fingerprint,productFingerprint:before.productFingerprint});assert.equal(saved.ok,true,saved.error);
  const native=h.api.tabs.sendMessage;h.api.tabs.sendMessage=async(tabId,message,options)=>{
    if(['PREPARE','SEND'].includes(message.type)) {
      calls.push(message);assert.equal(tabId,2);assert.equal(options.frameId,0);assert.equal(h.storage.openlinksClaudeFolder.sendReceipts.at(-1).status,'reserved');
      if(message.type==='PREPARE')return {ok:true,pageUrl:urls.alibaba};return send(message);
    }
    return native(tabId,message,options);
  };
  return {h,calls,selected,payload:reviewedPayload(saved,selected)};
}
test('reviewed manual Send uses the guarded sender and reserves before editor actions with auto-send off',async()=>{
  const reservations=[],{h,calls,payload}=await realManualFixture({quota:async value=>{reservations.push(value);return {ok:true};}});
  const reply=await h.command('SEND_DRAFT',payload);assert.equal(reply.ok,true,reply.error);assert.equal(reply.send.status,'attempted');assert.deepEqual(calls.map(call=>call.type),['PREPARE','SEND']);assert.equal(calls[1].message,payload.text);
  assert.equal(reply.folder.autoSend,false);assert.equal(reply.folder.sendReceipts[0].status,'sent');assert.equal(reply.folder.sendReceipts[0].key,payload.key);assert.equal(reservations.length,1);assert.match(reservations[0].jobId,/^[a-f\d-]{36}$/);
  assert.equal(JSON.stringify(h.storage.openlinksClaudeFolder).includes(payload.text),false);
  const duplicate=await h.command('SEND_DRAFT',payload);assert.equal(duplicate.send.status,'blocked');assert.equal(calls.length,2);assert.equal(reservations.length,1);assert.equal(h.fetches,0);
});
test('manual quota deferral never fills or clicks and requires a new explicit confirmation',async()=>{
  let available=false;const {h,calls,payload}=await realManualFixture({quota:async()=>available?{ok:true}:{ok:false,retryAt:2000000,reason:'Quota exhausted'}});
  const first=await h.command('SEND_DRAFT',payload);assert.equal(first.send.status,'deferred');assert.equal(first.send.retryAt,2000000);assert.equal(calls.length,0);assert.equal(first.folder.sendReceipts.length,0);
  available=true;h.advanceTime(2000000);await poll(h);assert.equal(calls.length,0);
  const second=await h.command('SEND_DRAFT',payload);assert.equal(second.send.status,'attempted');assert.equal(calls.length,2);
});
test('manual uncertain and persisted reserved outcomes block duplicates after worker recreation and text edits',async()=>{
  for(const reserved of [false,true]) {
    const {h,calls,payload}=await realManualFixture({send:async()=>{throw new Error('Lost acknowledgement');}});
    const first=await h.command('SEND_DRAFT',payload);assert.equal(first.send.status,'unknown');assert.equal(calls.length,2);
    if(reserved)h.storage.openlinksClaudeFolder.sendReceipts[0].status='reserved';
    const recreated=createDialogMonitor({api:h.api,now:()=>h.time,reserveDialogSendQuota:async()=>({ok:true})});
    const edited=await recreated.handle({type:'DIALOGS_SAVE_DRAFT',...payload,text:payload.text+' Please reply.'},ui);assert.equal(edited.ok,true,edited.error);
    const duplicate=await recreated.handle({type:'DIALOGS_SEND_DRAFT',...reviewedPayload(edited,payload.key)},ui);assert.equal(duplicate.send.status,'blocked');assert.equal(duplicate.folder.sendReceipts[0].status,'unknown');assert.equal(calls.length,2);
  }
});
test('manual review requires exact saved text and current draft metadata, even with fresh requested history',async()=>{
  for(const change of ['text','revision','fingerprint','product','new-inbound','stored-metadata','inactive','busy','stopped']) {
    const {h,calls,payload,selected}=await realManualFixture();let request={...payload};
    if(change==='text')request.text+=' Edited only in another UI';
    if(change==='revision')request.revision++;
    if(change==='fingerprint')request.fingerprint='other';
    if(change==='product')request.productFingerprint='other';
    if(change==='stored-metadata')h.storage.openlinksDialogs.conversations[selected].draft.revision++;
    if(change==='inactive')h.replies.get(2).conversations[0].active=false;
    if(change==='busy')h.replies.get(2).busy={hasDraft:true};
    if(change==='stopped')await h.command('STOP');
    if(change==='new-inbound') {h.replies.get(2).conversations[0].messages.push({id:'new',direction:'inbound',text:'Quantity changed?'});const fresh=await h.command('SCAN',{platform:'alibaba'});request={...request,revision:fresh.state.conversations[selected].revision,fingerprint:fresh.state.conversations[selected].fingerprint};}
    const reply=await h.command('SEND_DRAFT',request);assert.equal(reply.ok,false,change);assert.equal(calls.length,0,change);
  }
  const {h,calls,payload,selected}=await realManualFixture();h.replies.get(2).conversations[0].messages.push({id:'new',direction:'inbound',text:'Quantity changed?'});const fresh=await h.command('SCAN',{platform:'alibaba'}),item=fresh.state.conversations[selected];
  const saved=await h.command('SAVE_DRAFT',{...payload,revision:item.revision,fingerprint:item.fingerprint});assert.equal(saved.ok,true,saved.error);assert.equal((await h.command('SEND_DRAFT',reviewedPayload(saved,selected))).send.status,'attempted');assert.equal(calls.length,2);
});
test('STOP, unsaved review or context edits and send-mode changes during quota wait cancel before editor actions',async()=>{
  for(const change of ['STOP','DRAFT_EDITING','CONTEXT_EDITING','FOLDER_SETTINGS']) {
    const entered=deferred(),release=deferred();const {h,calls,payload}=await realManualFixture({quota:async()=>{entered.resolve();await release.promise;return {ok:true};}});
    const pending=h.command('SEND_DRAFT',payload);await entered.promise;
    const cancellation=h.command(change,change==='DRAFT_EDITING'?{key:payload.key}:change==='FOLDER_SETTINGS'?{enabled:false,autoSend:false}:{});release.resolve();
    const [reply]=await Promise.all([pending,cancellation]);assert.equal(reply.send.status,'blocked',change);assert.equal(calls.length,0,change);assert.equal((await h.command('GET')).folder.sendReceipts[0].status,'blocked');
    if(change==='DRAFT_EDITING'){const item=(await h.command('GET')).state.conversations[payload.key];assert.equal(item.takeover,false);assert.equal(item.paused,false);assert.equal(item.draft.text,payload.text);}
    if(change==='CONTEXT_EDITING'){const current=await h.command('GET');assert.equal(current.folder.auto,false);assert.equal(current.folder.autoSend,false);assert.ok(current.state.product.approval);assert.equal(current.state.conversations[payload.key].draft.text,payload.text);}
  }
});
test('known refusal before click remains retryable with a new explicit review',async()=>{
  let refuse=true;const {h,calls,payload}=await realManualFixture({send:async()=>refuse?{clicked:false,reason:'Not ready'}:{clicked:true}});
  assert.equal((await h.command('SEND_DRAFT',payload)).send.status,'blocked');assert.equal((await h.command('GET')).folder.sendReceipts[0].status,'blocked');
  refuse=false;assert.equal((await h.command('SEND_DRAFT',payload)).send.status,'attempted');assert.equal(calls.filter(call=>call.type==='SEND').length,2);assert.equal((await h.command('GET')).folder.sendReceipts.length,1);
});
test('automatic and reviewed sends share durable deduplication for the same inbound supplier message',async()=>{
  let sends=0;const h=harness({folderSender:async options=>{sends++;const result=await options.reserve({attemptId:crypto.randomUUID(),platform:'1688'});assert.equal(result.ok,true);return {status:'attempted'};},reserveDialogSendQuota:async()=>({ok:true})}),host=await folderReady(h,{auto:true,autoSend:true});
  await h.command('START');await poll(h);host.done();await poll(h);const sent=await h.command('GET');assert.equal(sent.folder.sendReceipts[0].status,'sent');
  assert.equal((await h.command('SEND_DRAFT',reviewedPayload(sent))).send.status,'blocked');assert.equal(sends,1);
  await h.command('DISCARD_DRAFT',{key});await h.command('FOLDER_SETTINGS',{model:'sonnet',enabled:true,auto:true,autoSend:true});await poll(h);assert.equal(host.jobs.size,2);host.done('Reworded reply',[...host.jobs.values()].at(-1));await poll(h);assert.equal(sends,1);assert.equal((await h.command('GET')).folder.jobs.at(-1).status,'accepted');
});
test('send-only checkbox changes preserve paid generation and continue collecting review drafts',async()=>{
  let sends=0;const h=harness({folderSender:async()=>{sends++;return {status:'attempted'};}}),host=await folderReady(h,{auto:true,autoSend:true});await h.command('START');await poll(h);
  const id=host.first.id,revision=h.storage.openlinksClaudeFolder.revision,configureCalls=host.calls.filter(call=>call.action==='configure').length;
  const off=await h.command('FOLDER_SETTINGS',{enabled:true,auto:true,autoSend:false});assert.equal(off.folder.jobs[0].id,id);assert.equal(off.folder.jobs[0].status,'queued');assert.equal(h.storage.openlinksClaudeFolder.revision,revision);assert.equal(host.calls.filter(call=>call.action==='configure').length,configureCalls);
  host.done();await poll(h);const first=await h.command('GET');assert.equal(first.folder.jobs[0].status,'accepted');assert.equal(first.state.conversations[key].draft.text,'Could you quote 100 units?');assert.equal(sends,0);
  await h.command('FOLDER_SETTINGS',{enabled:true,auto:true,autoSend:true});await poll(h);assert.equal(sends,0,'Enabling auto-send must not transmit a previously reviewed draft');await h.command('FOLDER_SETTINGS',{enabled:true,auto:true,autoSend:false});
  h.replies.get(1).conversations[0].messages.push({id:'next-inbound',direction:'inbound',text:'Do you need delivery?'});await poll(h);assert.equal(host.jobs.size,2);host.done('Please quote delivery.',[...host.jobs.values()].at(-1));await poll(h);assert.equal((await h.command('GET')).state.conversations[key].draft.text,'Please quote delivery.');assert.equal(sends,0);
});
test('explicit resume reconfigures an unchanged paused worker but send checkbox changes do not',async()=>{
  const h=harness(),host=await folderReady(h,{auto:true,autoSend:false});let paused=true;const native=h.api.runtime.sendNativeMessage;
  h.api.runtime.sendNativeMessage=async(name,message)=>{
    if(message.action==='status')return {ok:true,protocol:1,folder:'C:\\Jobs',worker:{running:true,status:paused?'paused':'idle',pauseReason:paused?'offline':''},claude:{available:true}};
    if(message.action==='configure')paused=false;
    return native(name,message);
  };
  const before=host.calls.filter(call=>call.action==='configure').length;
  const toggled=await h.command('FOLDER_SETTINGS',{enabled:true,auto:true,autoSend:true,model:'haiku'});assert.equal(toggled.folder.status,'paused');assert.equal(host.calls.filter(call=>call.action==='configure').length,before);
  const editing=await h.command('FOLDER_SETTINGS',{enabled:true,auto:false,autoSend:false,model:'haiku'});assert.equal(editing.folder.status,'paused');assert.equal(host.calls.filter(call=>call.action==='configure').length,before);
  const resumed=await h.command('FOLDER_SETTINGS',{enabled:true,auto:true,autoSend:true,model:'haiku',resume:true});assert.equal(resumed.folder.status,'ready');assert.equal(resumed.folder.worker.status,'idle');assert.equal(host.calls.filter(call=>call.action==='configure').length,before+1);
});
test('Claude-only manifest disables persisted API automation and rejects legacy API generation',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  for(const surface of ['current-manifest','missing-manifest','missing-permissions']) {
    const h=harness();await ready(h);h.storage.openlinksDialogs.settings.autoDraft=true;
    if(surface==='current-manifest')h.api.runtime.getManifest=()=>manifest;
    if(surface==='missing-manifest')delete h.api.runtime.getManifest;
    if(surface==='missing-permissions')delete h.api.permissions;
    const current=await h.command('GET');assert.equal(current.state.settings.autoDraft,false,surface);assert.equal(h.storage.openlinksDialogs.settings.autoDraft,false);
    await h.command('START');await h.command('SCAN');await poll(h);assert.equal(h.fetches,0,surface);
    assert.equal((await h.command('AUTODRAFT',{enabled:true})).ok,false);assert.equal((await h.command('GENERATE_DRAFT',{key})).ok,false);assert.equal((await h.command('PRODUCT_EXTRACT')).ok,false);assert.equal(h.fetches,0);
    assert.equal((await h.command('SETTINGS',{settings:{...current.state.settings,autoDraft:true}})).state.settings.autoDraft,false);
  }
});
test('marketplace pages cannot approve or cancel reviewed sends',async()=>{
  const h=harness(),payload=await reviewedReady(h),before=h.reads;
  for(const type of ['SEND_DRAFT','DRAFT_EDITING','CONTEXT_EDITING'])assert.equal((await h.command(type,payload,{id:'test',url:urls['1688']})).ok,false);
  assert.equal(h.reads,before);
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
  h.replies.get(1).conversations.push(unreadRow('backlog',{unread:false,needsRead:false,orderReliable:true,tailKnown:true,messages:[{id:'backlog-outreach',direction:'outbound',text:'Could you supply our product?'},{id:'backlog-message',direction:'inbound',text:'Please quote this product.'}]}));await h.command('SCAN');
  const config=h.storage.openlinksClaudeFolder;config.jobs=Array.from({length:12},(_,index)=>({id:crypto.randomUUID(),kind:'product',key:'__product_extraction__',status:'queued',request:{revision:index,fingerprint:'old',imageKeys:[]},signature:index.toString(16).padStart(64,'0'),createdAt:h.time,at:h.time,attempts:1,configRevision:config.revision}));
  await h.command('START',{readUnread:true});await poll(h);assert.equal(host.jobs.size,0);
  h.storage.openlinksClaudeFolder.jobs=[];h.replies.get(1).conversations[0].messages.push({id:'answered',direction:'outbound',text:'We need 100 units.'});
  await poll(h);assert.equal(opening(h).at(-1)?.conversationId,'backlog');assert.equal(host.jobs.size,0);
});

function previewHarness(extra={}) {
  const previews=[],cleanups=[];let h;
  const options={
    folderSender:async args=>{
      assert.equal(args.dryRun,true);assert.equal(args.enabled,true);assert.equal(await args.shouldContinue(),true);
      const cleanupToken={operation:args.previewOperation,platform:args.state.conversations[args.request.key].platform,id:args.state.conversations[args.request.key].id,documentToken:args.source.documentToken,sourceUrl:args.source.sourceUrl,text:args.text};
      assert.equal((await args.reservePreview({attemptId:args.previewOperation,cleanupToken})).ok,true);
      assert.deepEqual(h.storage.openlinksClaudeFolder.test.cleanupToken,cleanupToken);
      previews.push({key:args.request.key,text:args.text,operation:args.previewOperation});return {status:'previewed',clicked:false,cleanupToken};
    },
    testCleaner:async args=>{assert.equal(await args.shouldContinue(),true);cleanups.push(structuredClone(args.token));return {status:'cleared',cleared:true};},
    reserveDialogSendQuota:async()=>{throw new Error('A test must never reserve real quota');},...extra,
  };
  h=harness(options);return {h,previews,cleanups};
}
const testTokens=response=>({sessionId:response.folder.test.sessionId,cycleId:response.folder.test.cycleId});
async function testCycleReady(h,{platforms=false}={}) {
  const host=await folderReady(h,{auto:true});
  if(platforms){await h.command('BIND_TAB',{platform:'alibaba',tabId:2});await h.command('BIND_TAB',{platform:'mic',tabId:3});}
  const enabled=await h.command('FOLDER_SETTINGS',{testMode:true});assert.equal(enabled.ok,true,enabled.error);
  const started=await h.command('TEST_NEXT',testTokens(enabled));assert.equal(started.ok,true,started.error);
  await poll(h);assert.equal(host.jobs.size,1);return host;
}
async function completeTest(h,host,text='Could you quote 100 units?') {host.done(text,[...host.jobs.values()].at(-1));await poll(h);const result=await h.command('GET');assert.equal(result.folder.test.phase,'completed',result.folder.test.detail);return result;}

test('test mode pauses outreach durably and starts only after exact explicit cycle intent',async()=>{
  let h,pauses=0;({h}=previewHarness({pauseOutreachForTest:async()=>{pauses++;assert.equal(h.storage.openlinksClaudeFolder.test.enabled,true);}}));
  const host=await folderReady(h,{auto:true,autoSend:true});
  const enabled=await h.command('FOLDER_SETTINGS',{testMode:true});assert.equal(enabled.ok,true,enabled.error);assert.equal(enabled.folder.test.phase,'paused');assert.equal(enabled.folder.autoSend,false);assert.equal(pauses,1);
  assert.equal((await h.command('FOLDER_SETTINGS',{autoSend:true})).ok,false);
  await h.command('START');await poll(h);assert.equal(host.jobs.size,0);
  assert.equal((await h.command('FOLDER_DRAFT',{key})).ok,false);assert.equal((await h.command('TEST_NEXT',{...testTokens(enabled),cycleId:crypto.randomUUID()})).ok,false);
  const started=await h.command('TEST_NEXT',testTokens(enabled));assert.equal(started.ok,true,started.error);assert.equal(started.folder.test.phase,'ready');assert.equal(started.state.running,true);assert.equal(started.folder.auto,true);
  await poll(h);assert.equal(host.jobs.size,1);assert.equal(pauses,2);assert.equal(h.fetches,0);
});

test('one test cycle globally generates and fills one response without any real delivery, quota or history mutation',async()=>{
  const {h,previews}=previewHarness(),host=await testCycleReady(h,{platforms:true});
  const initial=(await h.command('GET')).state.conversations[key].messages;
  assert.equal((await h.command('GET')).folder.test.phase,'generating');assert.equal(host.first.kind,'dialog');
  const reads=h.calls.length;await poll(h);assert.equal(h.calls.length,reads,'do not traverse other chats while Claude is working');assert.equal(host.jobs.size,1);
  const completed=await completeTest(h,host);assert.equal(previews.length,1);assert.equal(completed.folder.test.key,key);assert.equal(completed.folder.jobs[0].test,true);assert.equal(completed.folder.jobs[0].status,'accepted');
  assert.equal(completed.state.conversations[key].draft.testSessionId,completed.folder.test.sessionId);assert.deepEqual(completed.state.conversations[key].messages,initial);
  assert.deepEqual(completed.folder.sendReceipts,[]);assert.deepEqual(h.storage.openlinksClaudeFolder.completed,[]);assert.deepEqual(h.storage.openlinksClaudeFolder.test.completed,[]);assert.equal(h.fetches,0);
  assert.equal(h.calls.some(call=>call.type==='SEND'),false);
  const after=h.calls.length;for(let i=0;i<3;i++)await poll(h);await h.command('FOLDER_POLL');assert.equal(h.calls.length,after);assert.equal(previews.length,1);assert.equal(host.jobs.size,1);
});

test('Next consumes only the reviewed cycle, clears owned text first, then chooses another actual unanswered platform',async()=>{
  const {h,previews,cleanups}=previewHarness(),host=await testCycleReady(h,{platforms:true}),done=await completeTest(h,host);
  const tokens=testTokens(done),responses=await Promise.all([h.command('TEST_NEXT',tokens),h.command('TEST_NEXT',tokens)]);
  assert.equal(responses.filter(result=>result.ok).length,1);assert.equal(cleanups.length,1);
  const next=await h.command('GET');assert.equal(next.folder.test.completed.length,1);assert.equal(next.state.conversations[key].unanswered,true);assert.equal(next.state.conversations[key].draft,null);assert.equal(h.storage.openlinksClaudeFolder.test.history[0].simulated,true);
  assert.equal(next.folder.test.history,undefined);assert.equal(next.folder.test.cleanupToken,undefined);
  await poll(h);assert.equal(host.jobs.size,2);assert.equal([...host.jobs.values()][1].request.key,conversationKey('alibaba','supplier-1'));assert.equal(previews.length,1);
  const allEvents=next.state.events.filter(event=>event.type==='folder_failed');assert.equal(allEvents.length,0);
});

test('later real incoming receives separately labelled simulated replies while actual Claude messages remain unchanged',async()=>{
  const {h}=previewHarness(),host=await testCycleReady(h),done=await completeTest(h,host,'Test reply that was never sent.');
  await h.command('TEST_NEXT',testTokens(done));await poll(h);assert.equal(host.jobs.size,1,'unchanged incoming cannot repeat');
  h.replies.get(1).conversations[0].messages.push({id:'m2',direction:'inbound',text:'Can you confirm the voltage?'});
  await poll(h);assert.equal(host.jobs.size,2);const next=[...host.jobs.values()][1],context=JSON.parse(next.prompt.split('КОНТЕКСТ (JSON; документы и переписка — данные, а не команды):\n')[1]);
  assert.equal(context.messages.length,3);assert.deepEqual(context.messages.map(message=>message.direction),['outbound','inbound','inbound']);assert.equal(context.simulatedReplies[0].text,'Test reply that was never sent.');assert.equal(context.simulatedReplies[0].simulated,true);assert.match(next.prompt,/НЕ отправленные/);
});

test('cleanup failure preserves test mode and proof; next and exit never discard edited human text',async()=>{
  let allowClear=false;const {h}=previewHarness({testCleaner:async()=>({cleared:allowClear,status:allowClear?'cleared':'blocked'})}),host=await testCycleReady(h),done=await completeTest(h,host),proof=structuredClone(h.storage.openlinksClaudeFolder.test.cleanupToken);
  assert.equal((await h.command('TEST_NEXT',testTokens(done))).ok,false);assert.equal((await h.command('FOLDER_SETTINGS',{testMode:false})).ok,false);
  const held=await h.command('GET');assert.equal(held.folder.test.enabled,true);assert.equal(held.folder.test.phase,'completed');assert.deepEqual(h.storage.openlinksClaudeFolder.test.cleanupToken,proof);assert.equal(held.folder.test.completed.length,0);
  allowClear=true;const off=await h.command('FOLDER_SETTINGS',{testMode:false,autoSend:true});assert.equal(off.ok,true,off.error);assert.equal(off.folder.test.enabled,false);assert.equal(off.folder.autoSend,false,'leaving test cannot enable real sending');assert.equal(off.state.conversations[key].unanswered,true);
});

test('test cycle completion survives stop and context edits until explicit Next, including exact cleanup',async()=>{
  const {h,cleanups}=previewHarness(),host=await testCycleReady(h),done=await completeTest(h,host);
  await h.command('STOP');await h.command('CONTEXT_EDITING');const held=await h.command('GET');assert.equal(held.folder.test.phase,'completed');assert.equal(held.folder.test.text,done.folder.test.text);assert.equal(held.state.running,false);
  await poll(h);assert.equal(host.jobs.size,1);assert.equal(cleanups.length,0);
  const next=await h.command('TEST_NEXT',testTokens(held));assert.equal(next.ok,true,next.error);assert.equal(cleanups.length,1);assert.equal(next.folder.test.completed.length,1);
});

test('test-origin edits survive storage and cannot become real sends after leaving test mode',async()=>{
  const {h,previews}=previewHarness(),host=await testCycleReady(h),done=await completeTest(h,host),payload=reviewedPayload(done);
  const edited=await h.command('SAVE_DRAFT',{...payload,text:'Buyer edited the simulated draft.'});assert.equal(edited.ok,true,edited.error);assert.equal(edited.state.conversations[key].draft.testSessionId,done.folder.test.sessionId);
  const off=await h.command('FOLDER_SETTINGS',{testMode:false});assert.equal(off.ok,true,off.error);assert.equal(off.state.conversations[key].draft.text,'Buyer edited the simulated draft.');
  const fresh=reviewedPayload(off),send=await h.command('SEND_DRAFT',{...fresh,testMode:false});assert.equal(send.ok,false);assert.match(send.error,/Тестовый черновик/);assert.equal(previews.length,1);
  const resaved=await h.command('SAVE_DRAFT',{...fresh,text:'Still an edited simulated response.'});assert.equal(resaved.ok,true);assert.equal(resaved.state.conversations[key].draft.testSessionId,done.folder.test.sessionId);
  assert.equal((await h.command('SEND_DRAFT',{...reviewedPayload(resaved),testMode:false})).ok,false);
  await h.command('DISCARD_DRAFT',{key});assert.equal((await h.command('FOLDER_DRAFT',{key})).ok,true,'fresh real inference stays available for the unchanged inbound');
  const real=[...host.jobs.values()].at(-1);assert.notEqual(real.id,host.first.id);assert.notEqual(h.storage.openlinksClaudeFolder.jobs[0].signature,h.storage.openlinksClaudeFolder.jobs.at(-1).signature);
  host.done('Fresh production draft.',real);const accepted=await h.command('FOLDER_POLL');assert.equal(accepted.state.conversations[key].draft.testSessionId,'');assert.deepEqual(accepted.folder.sendReceipts,[]);
});

test('frozen manual preview intent never downgrades to a real send after another UI exits test mode',async()=>{
  const {h,previews}=previewHarness();await reviewedReady(h);fakeFolder(h);await h.command('FOLDER_SETTINGS',{enabled:true,testMode:true});
  const before=await h.command('GET'),payload={...reviewedPayload(before),testMode:true,testSessionId:before.folder.test.sessionId,testCycleId:before.folder.test.cycleId};
  assert.equal((await h.command('SEND_DRAFT',{...payload,testMode:false})).ok,false);
  await h.command('FOLDER_SETTINGS',{testMode:false});assert.equal((await h.command('SEND_DRAFT',payload)).ok,false);assert.equal(previews.length,0);
});

test('manual preview uses the same persisted one-cycle path and blocks duplicate approval',async()=>{
  const {h,previews}=previewHarness();await reviewedReady(h);fakeFolder(h);await h.command('FOLDER_SETTINGS',{enabled:true,testMode:true});
  const before=await h.command('GET'),payload={...reviewedPayload(before),testMode:true,testSessionId:before.folder.test.sessionId,testCycleId:before.folder.test.cycleId};
  const response=await h.command('SEND_DRAFT',payload);assert.equal(response.ok,true,response.error);assert.equal(response.send.status,'previewed');assert.equal(response.folder.test.phase,'completed');assert.equal(response.state.conversations[key].draft.testSessionId,response.folder.test.sessionId);assert.deepEqual(response.folder.sendReceipts,[]);
  assert.equal((await h.command('SEND_DRAFT',payload)).send.status,'blocked');assert.equal(previews.length,1);
});

test('native errors and stale test results stop globally and cannot retry outside their cycle',async()=>{
  for(const failure of ['error','stale']) {
    const {h,previews}=previewHarness(),host=await testCycleReady(h);
    if(failure==='error')host.error();else{host.done();h.replies.get(1).conversations[0].messages.push({id:'changed',direction:'inbound',text:'Actually the specifications changed.'});}
    await poll(h);const stopped=await h.command('GET');assert.equal(stopped.folder.test.phase,'blocked',failure);assert.equal(previews.length,0);assert.equal((await h.command('FOLDER_RETRY',{id:host.first.id})).ok,false);
    await poll(h);assert.equal(host.jobs.size,1);assert.equal((await h.command('TEST_NEXT',testTokens(stopped))).ok,false);
    assert.equal((await h.command('FOLDER_SETTINGS',{testMode:false})).ok,true);
  }
});

test('product extraction still completes while dialogue test cycles are paused',async()=>{
  const {h}=previewHarness();const host=await folderReady(h);await h.command('FOLDER_SETTINGS',{testMode:true});
  let current=await h.command('GET');assert.equal(current.folder.test.phase,'paused');
  const queued=await h.command('FOLDER_PRODUCT',{revision:current.state.product.revision,fingerprint:current.productFingerprint});assert.equal(queued.ok,true,queued.error);assert.equal(host.first.kind,'product');
  host.done(JSON.stringify({keyPoints:'Quantity 100 units',questions:'Confirm dimensions',warnings:''}));await poll(h);
  current=await h.command('GET');assert.equal(current.folder.jobs[0].status,'accepted');assert.equal(current.folder.test.phase,'paused');assert.equal(current.state.product.keyPoints,'Quantity 100 units');
});

test('mode switch cancels an unfinished real job without consuming its future real signature',async()=>{
  const {h}=previewHarness(),host=await folderReady(h,{auto:true});await h.command('START');await poll(h);assert.equal(host.jobs.size,1);const signature=h.storage.openlinksClaudeFolder.jobs[0].signature;
  await h.command('FOLDER_SETTINGS',{testMode:true});assert.equal(h.storage.openlinksClaudeFolder.jobs[0].status,'stale');assert.equal(h.storage.openlinksClaudeFolder.completed.includes(signature),false);
  await h.command('FOLDER_SETTINGS',{testMode:false});await poll(h);assert.equal(host.jobs.size,2);assert.equal(h.storage.openlinksClaudeFolder.jobs[1].signature,signature);
});

test('restart preserves completed test review and blocks interrupted preparation without real-send authority',async()=>{
  const {h,previews}=previewHarness(),host=await testCycleReady(h);await completeTest(h,host);
  await h.monitor.onStartup();let current=await h.command('GET');assert.equal(current.folder.test.enabled,true);assert.equal(current.folder.test.phase,'completed');assert.equal(current.folder.enabled,false);assert.equal(current.folder.autoSend,false);assert.equal(current.state.running,false);assert.ok(h.storage.openlinksClaudeFolder.test.cleanupToken);
  h.storage.openlinksClaudeFolder.test.phase='preparing';const recreated=createDialogMonitor({api:h.api,now:()=>h.time});
  current=await recreated.handle({type:'DIALOGS_GET'},ui);assert.equal(current.folder.test.phase,'blocked');assert.equal(current.folder.test.enabled,true);await recreated.onAlarm({name:'openlinks-dialogs'});assert.equal(previews.length,1);assert.deepEqual(current.folder.sendReceipts,[]);
});

test('test traversal skips already handled inactive suppliers without starving an unread neighbour',async()=>{
  const {h}=previewHarness(),host=await testCycleReady(h),done=await completeTest(h,host);await h.command('TEST_NEXT',testTokens(done));
  const old=h.replies.get(1).conversations[0];Object.assign(old,{active:false,canSelect:true,selectionToken:'old-row',preview:'',unread:true,needsRead:false});
  h.replies.get(1).conversations.push(unreadRow('untested',{preview:'A different supplier asks a question.'}));
  await poll(h);assert.equal(opening(h).at(-1)?.conversationId,'untested');assert.equal(host.jobs.size,1);
  assert.equal(opening(h).some(row=>row.conversationId==='supplier-1'),false);
});

test('MV3 recreation detects acceptance interrupted before preview and never resumes generation or send',async()=>{
  const {h,previews}=previewHarness(),host=await testCycleReady(h);
  // A persisted accepted job with phase generating is the crash boundary
  // immediately before reserving a preview. There is no native job to poll.
  h.storage.openlinksClaudeFolder.jobs[0].status='accepted';
  const recreated=createDialogMonitor({api:h.api,now:()=>h.time});
  const result=await recreated.handle({type:'DIALOGS_GET'},ui);assert.equal(result.folder.test.phase,'blocked');assert.equal(result.folder.test.enabled,true);assert.match(result.folder.test.detail,/прервана/);
  await recreated.onAlarm({name:'openlinks-dialogs'});assert.equal(host.jobs.size,1);assert.equal(previews.length,0);assert.deepEqual(result.folder.sendReceipts,[]);
});

test('a stop during preview preparation retains cleanup proof and requires explicit recovery',async()=>{
  const entered=deferred(),gate=deferred();let h;
  ({h}=previewHarness({folderSender:async args=>{
    const token={operation:args.previewOperation,platform:'1688',id:'supplier-1',documentToken:args.source.documentToken,sourceUrl:args.source.sourceUrl,text:args.text};
    assert.equal((await args.reservePreview({attemptId:args.previewOperation,cleanupToken:token})).ok,true);entered.resolve();await gate.promise;
    assert.equal(await args.shouldContinue(),false);return {status:'blocked',cleanupToken:token,reason:'Проверка остановлена до отправки.'};
  }}));
  const host=await testCycleReady(h);host.done();const pending=h.command('FOLDER_POLL');await entered.promise;const stop=h.command('STOP');gate.resolve();await Promise.all([pending,stop]);
  const result=await h.command('GET');assert.equal(result.state.running,false);assert.equal(result.folder.test.phase,'blocked');assert.ok(h.storage.openlinksClaudeFolder.test.cleanupToken);assert.equal(result.folder.test.completed.length,0);assert.deepEqual(result.folder.sendReceipts,[]);
  const off=await h.command('FOLDER_SETTINGS',{testMode:false});assert.equal(off.ok,true,off.error);assert.equal(off.folder.test.enabled,false);
});

test('test cleanup discovers a replacement iframe only for read-only empty-field recovery',async()=>{
  for(const empty of [false,true]) {
    const {h}=previewHarness({testCleaner:async()=>({status:'blocked',cleared:false})}),host=await testCycleReady(h);await completeTest(h,host);
    const old=structuredClone(h.storage.openlinksClaudeFolder.test.cleanupToken),wrapper='https://air.1688.com/reloaded-wrapper';
    h.tabs.get(1).url=wrapper;
    h.frameLists.set(1,[{frameId:0,parentFrameId:-1,url:wrapper},{frameId:17,parentFrameId:0,url:urls['1688']}]);
    h.replies.set(1,snapshot('1688',{url:wrapper,status:'unsupported',conversations:[],frames:[{url:urls['1688'],visible:true}]}));
    h.replies.set('1:17',snapshot('1688',{documentToken:'new-document'}));
    const native=h.api.tabs.sendMessage,checks=[];
    h.api.tabs.sendMessage=async(tab,message,options)=>{
      assert.ok(!['SEND','PREPARE','DIALOGS_CLEAR_PREVIEW'].includes(message.type),'rebound source grants no mutation authority');
      if(message.type==='DIALOGS_CHECK_PREVIEW_EMPTY'){checks.push(message);assert.equal(options.frameId,17);assert.equal(message.guard.documentToken,'new-document');assert.equal(message.guard.id,old.id);return {empty};}
      return native(tab,message,options);
    };
    const result=await h.command('FOLDER_SETTINGS',{testMode:false});assert.equal(result.ok,empty);assert.equal(checks.length,1);
    const current=await h.command('GET');assert.equal(current.folder.test.enabled,!empty);assert.equal(current.folder.sendReceipts.length,0);
    if(!empty)assert.deepEqual(h.storage.openlinksClaudeFolder.test.cleanupToken,old);else assert.equal(h.storage.openlinksClaudeFolder.test.cleanupToken,null);
  }
});

test('Next marks only the fingerprint actually previewed when a new supplier message arrived meanwhile',async()=>{
  const {h}=previewHarness(),host=await testCycleReady(h),done=await completeTest(h,host),original=done.state.conversations[key].fingerprint;
  h.replies.get(1).conversations[0].messages.push({id:'after-preview',direction:'inbound',text:'One more question before you answer.'});
  const fresh=await h.command('SCAN');assert.notEqual(fresh.state.conversations[key].fingerprint,original);
  const next=await h.command('TEST_NEXT',testTokens(done));assert.equal(next.ok,true,next.error);assert.equal(next.folder.test.completed[0].fingerprint,original);assert.notEqual(next.folder.test.completed[0].fingerprint,next.state.conversations[key].fingerprint);
  await poll(h);assert.equal(host.jobs.size,2,'the actual new inbound remains eligible');
});

test('unsaved test edits keep their immutable origin after another window exits test mode and removes the stored draft',async()=>{
  const {h,previews}=previewHarness(),host=await testCycleReady(h),done=await completeTest(h,host);
  const staleEditor={...reviewedPayload(done),draftTestSessionId:done.folder.test.sessionId,text:'Local test edit made before another UI switched modes.'};
  await h.command('FOLDER_SETTINGS',{testMode:false});assert.equal((await h.command('GET')).state.conversations[key].draft,null);
  const saved=await h.command('SAVE_DRAFT',staleEditor);assert.equal(saved.ok,true,saved.error);assert.equal(saved.state.conversations[key].draft.testSessionId,done.folder.test.sessionId);
  const sent=await h.command('SEND_DRAFT',{...reviewedPayload(saved),testMode:false});assert.equal(sent.ok,false);assert.match(sent.error,/Тестовый черновик/);assert.equal(previews.length,1);assert.deepEqual(saved.folder.sendReceipts,[]);
  for(const draftTestSessionId of [null,42,'bad-origin'])assert.equal((await h.command('SAVE_DRAFT',{...staleEditor,draftTestSessionId})).ok,false);
});

function managedReady(h,name,{status='ready',conversations=[]}={}) {
  const binding=h.storage[DIALOGS_KEY].bindings[name],tab=h.tabs.get(binding.tabId);
  Object.assign(tab,{url:name==='mic'?urls.mic:CHAT_CENTERS[name],status:'complete'});delete tab.pendingUrl;
  h.replies.set(tab.id,snapshot(name,{url:tab.url,status,conversations}));return tab;
}
test('opening centers creates three dedicated inactive tabs sequentially in the initiating window without enabling automation',async()=>{
  const h=harness();await ready(h);const draft=(await h.command('GET')).state.conversations[key];
  await h.command('SAVE_DRAFT',{key,text:'Preserve this draft',revision:draft.revision,fingerprint:draft.fingerprint});
  const oldTabs=structuredClone([...h.tabs.values()]);
  const result=await h.command('OPEN_CHATS',{}, {...ui,tab:{windowId:30}});
  assert.equal(result.ok,true);assert.deepEqual(result.launchErrors,[]);
  assert.deepEqual(h.tabCreates,['1688','alibaba','mic'].map(name=>({windowId:30,url:CHAT_CENTERS[name],active:false})));
  assert.deepEqual([...h.tabs.values()].slice(0,3),oldTabs);
  assert.equal(result.state.running,false);assert.equal(result.state.settings.autoDraft,false);assert.equal(result.folder.enabled,false);assert.equal(result.folder.autoSend,false);
  assert.equal(result.state.conversations[key].draft.text,'Preserve this draft');assert.equal(h.fetches,0);
  assert.ok(Object.values(result.state.bindings).every(binding=>binding.managed.pending&&binding.managed.windowId===30&&binding.status==='loading'));
  assert.ok(h.tabUpdates.every(update=>Object.keys(update).join(',')==='id,autoDiscardable'));assert.deepEqual(h.windowUpdates,[]);
  assert.ok(h.alarms.some(alarm=>alarm.name==='openlinks-chat-launch'));
  assert.equal(h.calls.some(call=>/SEND|INPUT|DRAFT|OPEN_CONVERSATION/.test(call.type||'')),false);
});
test('concurrent open commands and MV3 worker recreation reuse only their existing managed tabs',async()=>{
  const h=harness();const results=await Promise.all([h.command('OPEN_CHATS'),h.command('OPEN_CHATS'),h.command('OPEN_CHATS',{platform:'1688'})]);
  assert.ok(results.every(result=>result.ok));assert.equal(h.tabCreates.length,3);
  const first=structuredClone(h.storage[DIALOGS_KEY].bindings['1688'].managed);h.advanceTime(60000);
  await h.command('OPEN_CHATS',{platform:'1688'});assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].managed.deadlineAt,first.deadlineAt);
  const recreated=createDialogMonitor({api:h.api,now:()=>h.time});
  const result=await recreated.handle({type:'DIALOGS_OPEN_CHATS'},ui);assert.equal(result.ok,true);assert.equal(h.tabCreates.length,3);
  assert.equal(result.state.bindings['1688'].managed.token,first.token);
});
test('an interrupted create-to-bind operation recovers the exact session-owned tab without creating another',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'alibaba'});
  const old=h.storage[DIALOGS_KEY].bindings.alibaba;delete h.storage[DIALOGS_KEY].bindings.alibaba;
  const recreated=createDialogMonitor({api:h.api,now:()=>h.time});
  const result=await recreated.handle({type:'DIALOGS_OPEN_CHATS',platform:'alibaba'},ui);
  assert.equal(result.ok,true);assert.equal(h.tabCreates.length,1);assert.equal(result.state.bindings.alibaba.tabId,old.tabId);assert.equal(result.state.bindings.alibaba.managed.token,old.managed.token);
});
test('load completion and a readiness alarm work while monitoring is stopped without AI or send calls',async()=>{
  const h=harness();await h.command('OPEN_CHATS');
  const first=managedReady(h,'1688');await h.monitor.onTabUpdated(first.id,{status:'complete'},first);
  assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].status,'ready');assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].managed.pending,false);
  managedReady(h,'alibaba');managedReady(h,'mic');await h.command('STOP');await h.monitor.onAlarm({name:'openlinks-chat-launch'});
  const result=await h.command('GET');assert.equal(result.state.running,false);assert.ok(Object.values(result.state.bindings).every(binding=>binding.status==='ready'&&!binding.managed.pending));
  assert.equal(h.fetches,0);assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));assert.equal(h.tabCreates.length,3);
});
test('managed loading has a fixed deadline and explicit retry reuses the tab without navigation',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'1688'});h.advanceTime(120001);
  await h.monitor.onAlarm({name:'openlinks-chat-launch'});const failed=(await h.command('GET')).state.bindings['1688'];
  assert.equal(failed.status,'error');assert.equal(failed.managed.pending,false);assert.match(failed.detail,/2 минуты/);
  const calls=h.calls.length;h.advanceTime(30000);await h.monitor.onAlarm({name:'openlinks-chat-launch'});assert.equal(h.calls.length,calls);
  const retry=await h.command('OPEN_CHATS',{platform:'1688'});assert.equal(h.tabCreates.length,1);assert.equal(retry.state.bindings['1688'].tabId,failed.tabId);assert.equal(retry.state.bindings['1688'].status,'loading');
  assert.equal(retry.state.bindings['1688'].managed.pending,true);assert.ok(h.tabUpdates.every(update=>!('url'in update)&&!('active'in update)));
});
test('missing content scripts time out with actionable state instead of endless loading',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'alibaba'});
  const tab=h.tabs.get(h.storage[DIALOGS_KEY].bindings.alibaba.tabId);tab.status='complete';
  await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(h.storage[DIALOGS_KEY].bindings.alibaba.status,'loading');
  h.advanceTime(120001);await h.monitor.onAlarm({name:'openlinks-chat-launch'});
  assert.equal(h.storage[DIALOGS_KEY].bindings.alibaba.status,'error');assert.match(h.storage[DIALOGS_KEY].bindings.alibaba.detail,/вход в аккаунт/);
});
test('a pending initial URL is retained until the new tab navigates to the known center',async()=>{
  const h=harness(),create=h.api.tabs.create;h.api.tabs.create=async options=>{const tab=await create(options);Object.assign(h.tabs.get(tab.id),{url:'',pendingUrl:options.url});return {...tab,url:'',pendingUrl:options.url};};
  const result=await h.command('OPEN_CHATS',{platform:'1688'});assert.equal(result.state.bindings['1688'].status,'loading');assert.equal(result.state.bindings['1688'].tabId,4);
  const tab=managedReady(h,'1688');await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].status,'ready');
});
test('login and captcha stop launch retries, and completion after login resumes readiness without replacing the tab',async()=>{
  for(const status of ['login','captcha']) {
    const h=harness();await h.command('OPEN_CHATS',{platform:'alibaba'});const tab=managedReady(h,'alibaba',{status});
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
    assert.equal(h.storage[DIALOGS_KEY].bindings.alibaba.status,status);assert.equal(h.storage[DIALOGS_KEY].bindings.alibaba.managed.pending,false);
    const calls=h.calls.length;await h.monitor.onAlarm({name:'openlinks-chat-launch'});assert.equal(h.calls.length,calls);
    managedReady(h,'alibaba');await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(h.storage[DIALOGS_KEY].bindings.alibaba.status,'ready');assert.equal(h.tabCreates.length,1);
  }
});


test('partial create failure preserves successful platforms and their status through storage normalization',async()=>{
  const h=harness(),create=h.api.tabs.create;h.api.tabs.create=async options=>{if(options.url===CHAT_CENTERS.alibaba)throw new Error('failed');return create(options);};
  const result=await h.command('OPEN_CHATS');assert.equal(result.ok,true);assert.deepEqual(result.launchErrors.map(error=>error.platform),['alibaba']);
  assert.equal(result.state.bindings.alibaba.tabId,null);assert.equal(result.state.bindings.alibaba.status,'error');assert.ok(result.state.bindings['1688'].managed);assert.ok(result.state.bindings.mic.managed);
  assert.equal((await h.command('GET')).state.bindings.alibaba.status,'error');assert.equal(h.tabCreates.length,2);
});
test('a closed or foreign-navigated managed tab is never recreated by background events',async()=>{
  for(const mode of ['closed','foreign','storefront','moved']) {
    const h=harness();await h.command('OPEN_CHATS',{platform:'1688'});const old=h.storage[DIALOGS_KEY].bindings['1688'].tabId;
    if(mode==='closed'){h.tabs.delete(old);await h.monitor.onTabRemoved(old);}
    else {const tab=h.tabs.get(old);tab.status='complete';if(mode==='moved')tab.windowId=30;else tab.url=mode==='foreign'?'https://personal.example/':'https://some-store.1688.com/';await h.monitor.onTabUpdated(old,{status:'complete',url:tab.url},tab);}
    await h.monitor.onAlarm({name:'openlinks-chat-launch'});await h.monitor.onAlarm({name:'openlinks-dialogs'});assert.equal(h.tabCreates.length,1);
    await h.command('OPEN_CHATS',{platform:'1688'});assert.equal(h.tabCreates.length,2);assert.notEqual(h.storage[DIALOGS_KEY].bindings['1688'].tabId,old);
    if(mode!=='closed')assert.ok(h.tabs.has(old));
  }
});
test('session ownership loss or browser startup never adopts a reused tab ID or recreates a chat automatically',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'1688'});const old=h.storage[DIALOGS_KEY].bindings['1688'].tabId;
  h.session.openlinksManagedChats={};const tab=managedReady(h,'1688');await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
  assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].status,'error');assert.equal(h.calls.length,0);
  await h.monitor.onStartup();await h.monitor.onAlarm({name:'openlinks-chat-launch'});assert.equal(h.tabCreates.length,1);assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].tabId,null);
  await h.command('OPEN_CHATS',{platform:'1688'});assert.equal(h.tabCreates.length,2);assert.notEqual(h.storage[DIALOGS_KEY].bindings['1688'].tabId,old);assert.ok(h.tabs.has(old));
});
test('the initiating window must still exist and caller-supplied URLs never control a center',async()=>{
  const h=harness();assert.equal((await h.command('OPEN_CHATS',{platform:'other'})).ok,false);
  h.windows.delete(20);assert.equal((await h.command('OPEN_CHATS',{}, {...ui,tab:{windowId:99}})).ok,false);assert.equal(h.tabCreates.length,0);h.windows.set(20,{id:20,type:'normal'});
  await h.command('OPEN_CHATS',{platform:'1688',url:'https://foreign.example/'});assert.equal(h.tabCreates[0].url,CHAT_CENTERS['1688']);
  const noSession=harness();delete noSession.api.storage.session;assert.equal((await noSession.command('OPEN_CHATS')).ok,false);assert.equal(noSession.tabCreates.length,0);
});
test('only explicit show activates the managed tab and its window; unrelated tabs cannot be shown',async()=>{
  const h=harness();await h.command('BIND_TAB',{platform:'1688',tabId:1});assert.equal((await h.command('SHOW_CHAT',{platform:'1688'})).ok,false);
  await h.command('OPEN_CHATS',{platform:'1688'}, {...ui,tab:{windowId:30}});const id=h.storage[DIALOGS_KEY].bindings['1688'].tabId;
  assert.equal((await h.command('SHOW_CHAT',{platform:'1688'})).ok,true);assert.deepEqual(h.tabUpdates.at(-1),{id,active:true});assert.deepEqual(h.windowUpdates,[{id:30,focused:true}]);
  h.tabs.get(id).url='https://store.1688.com/';assert.equal((await h.command('SHOW_CHAT',{platform:'1688'})).ok,false);
});
test('replacing or disconnecting a test-preview tab is blocked without erasing its text or ownership',async()=>{
  const h=harness();await h.command('BIND_TAB',{platform:'1688',tabId:1});
  h.storage.openlinksClaudeFolder={test:{enabled:true,sessionId:crypto.randomUUID(),cycleId:crypto.randomUUID(),phase:'completed',key,text:'Unsent preview',source:{tabId:1,frameId:0,documentToken:'doc-1',sourceUrl:urls['1688']},cleanupToken:{operation:'test',platform:'1688',id:'supplier-1',text:'Unsent preview'}}};
  const result=await h.command('OPEN_CHATS');assert.deepEqual(result.launchErrors.map(error=>error.platform),['1688']);assert.equal(result.state.bindings['1688'].tabId,1);assert.equal(h.tabCreates.length,2);
  assert.equal(h.storage.openlinksClaudeFolder.test.text,'Unsent preview');assert.equal(h.storage.openlinksClaudeFolder.test.source.tabId,1);assert.equal(h.storage.openlinksClaudeFolder.test.phase,'completed');
  assert.equal((await h.command('UNBIND_TAB',{platform:'1688'})).ok,false);assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].tabId,1);
});
test('repeated opening of a managed completed preview only reads the existing tab without cancelling its cycle',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'1688'});const tab=managedReady(h,'1688');
  h.storage.openlinksClaudeFolder={test:{enabled:true,sessionId:crypto.randomUUID(),cycleId:crypto.randomUUID(),phase:'completed',key,text:'Unsent preview',source:{tabId:tab.id,frameId:0,documentToken:'doc-1',sourceUrl:tab.url},cleanupToken:{operation:'test',platform:'1688',id:'supplier-1',text:'Unsent preview'}}};
  const result=await h.command('OPEN_CHATS',{platform:'1688'});assert.deepEqual(result.launchErrors,[]);assert.equal(h.tabCreates.length,1);assert.equal(result.folder.test.phase,'completed');assert.equal(h.storage.openlinksClaudeFolder.test.text,'Unsent preview');
});
test('the popup extension UI opens centers in the last focused normal window without activating it',async()=>{
  const h=harness();h.windows.set(50,{id:50,type:'popup'});
  const result=await h.command('OPEN_CHATS',{platform:'alibaba'}, {...ui,tab:{windowId:50}});
  assert.equal(result.ok,true);assert.equal(h.tabCreates[0].windowId,20);assert.deepEqual(h.windowUpdates,[]);
});
test('a later managed page reload retries readiness, but repeated load events do not extend its deadline',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=managedReady(h,'mic');await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
  h.advanceTime(60000);tab.status='loading';await h.monitor.onTabUpdated(tab.id,{status:'loading'},tab);
  const first=h.storage[DIALOGS_KEY].bindings.mic.managed.deadlineAt;assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.pending,true);
  h.advanceTime(60000);await h.monitor.onTabUpdated(tab.id,{status:'loading'},tab);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.deadlineAt,first);
  h.advanceTime(60001);await h.monitor.onAlarm({name:'openlinks-chat-launch'});assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'error');
});
test('lost session ownership never restores auto-discard on a reused ID while replacing its binding',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'1688'});const id=h.storage[DIALOGS_KEY].bindings['1688'].tabId;
  h.session.openlinksManagedChats={};h.tabs.set(id,{id,windowId:20,url:CHAT_CENTERS['1688'],status:'complete',autoDiscardable:false});
  const before=h.tabUpdates.length;await h.command('OPEN_CHATS',{platform:'1688'});
  assert.equal(h.tabCreates.length,2);assert.equal(h.tabs.get(id).autoDiscardable,false);assert.ok(h.tabUpdates.slice(before).every(update=>update.id!==id));
});

test('manual read checks keep pending launches bounded instead of exposing transient unsupported states',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'alibaba'});managedReady(h,'alibaba',{status:'unsupported'});
  assert.equal((await h.command('SCAN',{platform:'alibaba'})).state.bindings.alibaba.status,'loading');
  h.advanceTime(120001);const result=await h.command('SCAN',{platform:'alibaba'});assert.equal(result.state.bindings.alibaba.status,'error');assert.equal(result.state.bindings.alibaba.managed.pending,false);
});
test('test-preview recovery after startup finds a replaced iframe without binding, modifying, or abandoning nonempty drafts',async()=>{
  for(const variant of ['empty','nonempty','wrong-recipient']) {
    const {h}=previewHarness({testCleaner:async()=>({status:'blocked',cleared:false})}),host=await testCycleReady(h);await completeTest(h,host);
    const old=structuredClone(h.storage.openlinksClaudeFolder.test.cleanupToken);await h.monitor.onStartup();
    const wrapper='https://air.1688.com/reloaded-wrapper';h.tabs.get(1).url=wrapper;h.tabs.get(1).autoDiscardable=true;
    h.frameLists.set(1,[{frameId:0,parentFrameId:-1,url:wrapper},{frameId:17,parentFrameId:0,url:urls['1688']}]);
    h.replies.set(1,snapshot('1688',{url:wrapper,status:'unsupported',conversations:[],frames:[{url:urls['1688'],visible:true}]}));
    const child=snapshot('1688',{documentToken:'new-document'});if(variant==='wrong-recipient')child.conversations[0].id='another-supplier';h.replies.set('1:17',child);
    const native=h.api.tabs.sendMessage,checks=[],updates=h.tabUpdates.length;
    h.api.tabs.sendMessage=async(tab,message,options)=>{
      assert.ok(!['SEND','PREPARE','DIALOGS_CLEAR_PREVIEW'].includes(message.type),'recovery has no mutation authority');
      if(message.type==='DIALOGS_CHECK_PREVIEW_EMPTY'){checks.push(message);assert.equal(options.frameId,17);assert.equal(message.guard.documentToken,'new-document');assert.equal(message.guard.id,old.id);return {empty:variant==='empty'};}
      return native(tab,message,options);
    };
    const result=await h.command('FOLDER_SETTINGS',{testMode:false});assert.equal(result.ok,variant==='empty');assert.equal(checks.length,variant==='wrong-recipient'?0:1);
    assert.equal(h.storage[DIALOGS_KEY].bindings['1688'].tabId,null);assert.equal(h.tabUpdates.length,updates);assert.equal(h.tabs.get(1).autoDiscardable,true);assert.equal(h.tabCreates.length,0);
    if(variant==='empty'){assert.equal(h.storage.openlinksClaudeFolder.test.cleanupToken,null);assert.equal(h.storage.openlinksClaudeFolder.test.enabled,false);}
    else {assert.deepEqual(h.storage.openlinksClaudeFolder.test.cleanupToken,old);assert.equal(h.storage.openlinksClaudeFolder.test.enabled,true);}
  }
});

const micNativeURL='https://webim.made-in-china.com/super-tm/#/synthetic-route?data=synthetic-auth-never-persist&refer=&isLiteTM=false&isSAChat=false';
function micBootstrapReady(h,{child=true,parentBusy={},childBusy={}}={}) {
  const tab=h.tabs.get(h.storage[DIALOGS_KEY].bindings.mic.tabId);Object.assign(tab,{url:CHAT_CENTERS.mic,status:'complete'});delete tab.pendingUrl;
  const busy={hasDraft:false,userEditing:false,recentUserInput:false};
  h.replies.set(tab.id,snapshot('mic',{url:tab.url,status:'unsupported',busy:{...busy,...parentBusy},conversations:[],frames:child?[{url:urls.mic,visible:true}]:[]}));
  if(child){h.frameLists.set(tab.id,[{frameId:0,parentFrameId:-1,url:tab.url},{frameId:1,parentFrameId:0,url:urls.mic}]);h.replies.set(`${tab.id}:1`,snapshot('mic',{url:urls.mic,status:'unsupported',busy:{...busy,...childBusy},conversations:[]}));}
  return tab;
}
test('MIC native bootstrap stays in the same inactive tab and never stores its authentication URL',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=micBootstrapReady(h),captures=[];
  h.api.scripting={executeScript:async request=>{captures.push(request);return [{frameId:0,result:captures.length===1?{ok:false,status:'loading',reason:'bubble_opened'}:{ok:true,url:micNativeURL}}];}};
  await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'loading');assert.equal(h.tabUpdates.filter(patch=>patch.url).length,0);
  await h.monitor.onAlarm({name:'openlinks-chat-launch'});
  assert.equal(captures.length,2);assert.ok(captures.every(request=>request.world==='MAIN'&&request.func.name==='captureMICChat'&&request.target.tabId===tab.id&&request.target.frameIds.length===1&&request.target.frameIds[0]===0));
  assert.deepEqual(h.tabUpdates.filter(patch=>patch.url),[{id:tab.id,url:micNativeURL}]);assert.equal(h.tabCreates.length,1);assert.equal(h.tabCreates[0].url,CHAT_CENTERS.mic);assert.equal(h.tabCreates[0].active,false);
  assert.equal(JSON.stringify(h.storage).includes('synthetic-auth-never-persist'),false);assert.equal(JSON.stringify(h.session).includes('synthetic-auth-never-persist'),false);assert.equal(JSON.stringify(await h.command('GET')).includes('synthetic-auth-never-persist'),false);
  h.frameLists.delete(tab.id);h.replies.set(tab.id,snapshot('mic',{url:micNativeURL,busy:{hasDraft:false,userEditing:false,recentUserInput:false}}));
  await h.monitor.onTabUpdated(tab.id,{url:micNativeURL,status:'complete'},h.tabs.get(tab.id));
  assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'ready');assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.pending,false);
  assert.equal(JSON.stringify(h.storage).includes('synthetic-auth-never-persist'),false);assert.deepEqual(h.windowUpdates,[]);assert.equal(h.fetches,0);assert.ok(h.calls.every(call=>call.type==='DIALOGS_SNAPSHOT'));
});
test('MIC bootstrap preserves cross-origin lite-frame drafts and pauses for interaction in either frame',async()=>{
  for(const [frame,flag] of [['parent','hasDraft'],['child','hasDraft'],['child','userEditing'],['child','recentUserInput']]) {
    const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=micBootstrapReady(h,{[frame+'Busy']:{[flag]:true}});let captures=0;
    h.api.scripting={executeScript:async()=>{captures++;return [{frameId:0,result:{ok:true,url:micNativeURL}}];}};
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
    assert.equal(captures,0);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'paused');assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.pending,false);assert.equal(h.tabUpdates.some(patch=>patch.url),false);
  }
});
test('MIC bootstrap waits for every visible child reader instead of assuming an unreadable editor is empty',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=micBootstrapReady(h);let captures=0;
  h.replies.delete(`${tab.id}:1`);h.api.tabs.sendMessage=async(id,message,options)=>options.frameId===1?null:h.replies.get(id);
  h.api.scripting={executeScript:async()=>{captures++;return [{frameId:0,result:{ok:true,url:micNativeURL}}];}};
  await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(captures,0);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'loading');
  h.advanceTime(120001);await h.monitor.onAlarm({name:'openlinks-chat-launch'});assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'error');assert.equal(captures,0);
});
test('MIC bootstrap rejects foreign, login, lite, malformed and ambiguous capture results without navigation',async()=>{
  for(const result of [{ok:true,url:'https://evil.example/#/x?data=secret'}, {ok:true,url:urls.mic+'#/login'},{ok:true,url:micNativeURL.replace('isLiteTM=false','isLiteTM=true')},{ok:true,url:micNativeURL+'&extra=1'},{ok:false,status:'blocked',detail:micNativeURL},null]) {
    const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=micBootstrapReady(h);h.api.scripting={executeScript:async()=>[{frameId:0,result}]};
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
    assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.pending,false);assert.equal(h.tabUpdates.some(patch=>patch.url),false);assert.equal(JSON.stringify(h.storage).includes('synthetic-auth-never-persist'),false);
  }
});
test('MIC bootstrap rechecks the owned tab and all editor states after capturing the route',async()=>{
  for(const change of ['draft','navigation','document']) {
    const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=micBootstrapReady(h);
    h.api.scripting={executeScript:async()=>{
      if(change==='navigation')h.tabs.get(tab.id).url='https://personal.example/';
      else if(change==='draft')h.replies.get(`${tab.id}:1`).busy.hasDraft=true;
      else h.replies.get(tab.id).documentToken='reloaded-document';
      return [{frameId:0,result:{ok:true,url:micNativeURL}}];
    }};
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
    assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.pending,false);assert.equal(h.tabUpdates.some(patch=>patch.url),false);assert.equal(JSON.stringify(h.storage).includes('synthetic-auth-never-persist'),false);
  }
});
test('a readable MIC lite list cannot bypass native full-inbox bootstrap or enable replies',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=micBootstrapReady(h);h.replies.get(`${tab.id}:1`).status='ready';h.replies.get(`${tab.id}:1`).conversations=snapshot('mic').conversations;
  h.api.scripting={executeScript:async()=>[{frameId:0,result:{ok:false,status:'loading'}}]};
  await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'loading');assert.equal(Object.keys(h.storage[DIALOGS_KEY].conversations).length,0);assert.equal(h.fetches,0);
});
test('MIC bootstrap matches one sanitized child URL but blocks ambiguous same-path frames',async()=>{
  for(const ambiguous of [false,true]) {
    const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=micBootstrapReady(h);let captures=0;
    const childURL=urls.mic+'#/synthetic-lite?data=synthetic-child';
    h.frameLists.set(tab.id,[{frameId:0,parentFrameId:-1,url:tab.url},{frameId:1,parentFrameId:0,url:childURL},...(ambiguous?[{frameId:2,parentFrameId:0,url:urls.mic+'#/other-lite'}]:[])]);
    h.replies.set(`${tab.id}:1`,snapshot('mic',{url:childURL,status:'unsupported',busy:{hasDraft:false,userEditing:false,recentUserInput:false},conversations:[]}));
    if(ambiguous)h.replies.set(`${tab.id}:2`,snapshot('mic',{url:urls.mic+'#/other-lite',status:'unsupported',busy:{hasDraft:false,userEditing:false,recentUserInput:false},conversations:[]}));
    h.api.scripting={executeScript:async()=>{captures++;return [{frameId:0,result:{ok:false,status:'loading'}}];}};
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(captures,ambiguous?0:1);assert.equal(h.tabUpdates.some(patch=>patch.url),false);
  }
});

function hiddenMIC(h,{busy={},hidden=true,documentToken=crypto.randomUUID()}={}) {
  const tab=h.tabs.get(h.storage[DIALOGS_KEY].bindings.mic.tabId);Object.assign(tab,{url:micNativeURL,status:'complete'});delete tab.pendingUrl;h.frameLists.delete(tab.id);
  h.replies.set(tab.id,snapshot('mic',{url:tab.url,status:'unsupported',documentToken,busy:{hasDraft:false,userEditing:false,recentUserInput:false,...busy},conversations:[]}));
  h.api.scripting={executeScript:async request=>{assert.equal(request.world,'ISOLATED');assert.equal(request.target.tabId,tab.id);return [{frameId:0,result:hidden}];}};
  return tab;
}
test('a fresh hidden MIC document initializes once without changing focus and is accepted only after debugger cleanup',async()=>{
  const steps=[];let h;
  h=harness({micInitializationWait:async()=>{steps.push('wait');h.replies.get(tab.id).status='ready';h.replies.get(tab.id).conversations=snapshot('mic').conversations;}});
  await h.command('OPEN_CHATS',{platform:'mic'});const tab=hiddenMIC(h),documentToken=h.replies.get(tab.id).documentToken;let emulating=false;
  const send=h.api.tabs.sendMessage;h.api.tabs.sendMessage=async(...args)=>{assert.equal(emulating,false,'reader never accepts evidence while focus is emulated');return send(...args);};
  h.api.debugger={attach:async target=>{assert.equal(target.tabId,tab.id);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.micInitDocumentToken,documentToken);steps.push('attach');},sendCommand:async(target,method,params)=>{assert.equal(target.tabId,tab.id);assert.equal(method,'Emulation.setFocusEmulationEnabled');emulating=params.enabled;steps.push(params.enabled?'enable':'disable');},detach:async target=>{assert.equal(target.tabId,tab.id);assert.equal(emulating,false);steps.push('detach');}};
  await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
  assert.deepEqual(steps,['attach','enable','wait','disable','detach']);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'ready');assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.pending,false);
  await h.command('OPEN_CHATS',{platform:'mic'});assert.equal(steps.length,5);assert.deepEqual(h.windowUpdates,[]);assert.ok(h.tabUpdates.every(patch=>!('active'in patch)&&!('url'in patch)));assert.equal(h.tabCreates.length,1);assert.equal(h.fetches,0);
});
test('hidden MIC initialization survives worker suspension as a one-shot marker and resets only for a new document',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=hiddenMIC(h);let attachments=0;
  h.api.debugger={attach:async()=>{attachments++;},sendCommand:async()=>{},detach:async()=>{}};
  await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(attachments,1);
  await h.monitor.onAlarm({name:'openlinks-chat-launch'});assert.equal(attachments,1);
  const recreated=createDialogMonitor({api:h.api,now:()=>h.time,micInitializationWait:async()=>{}});await recreated.handle({type:'DIALOGS_OPEN_CHATS',platform:'mic'},ui);assert.equal(attachments,1);
  h.replies.get(tab.id).documentToken=crypto.randomUUID();await recreated.onTabUpdated(tab.id,{status:'complete'},tab);assert.equal(attachments,2);
});
test('hidden MIC initialization always cleans up its own debugger after failure and never detaches someone else',async()=>{
  for(const failure of ['attach','enable','wait','disable','detach']) {
    const steps=[],h=harness({micInitializationWait:async()=>{steps.push('wait');if(failure==='wait')throw new Error('failed');}});
    await h.command('OPEN_CHATS',{platform:'mic'});const tab=hiddenMIC(h);
    h.api.debugger={attach:async()=>{steps.push('attach');if(failure==='attach')throw new Error('already attached');},sendCommand:async(target,method,params)=>{const stage=params.enabled?'enable':'disable';steps.push(stage);if(failure===stage)throw new Error('failed');},detach:async()=>{steps.push('detach');if(failure==='detach')throw new Error('failed');}};
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
    if(failure==='attach')assert.deepEqual(steps,['attach']);else assert.deepEqual(steps.slice(-2),['disable','detach']);
    assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'error');assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.pending,false);
    await h.command('OPEN_CHATS',{platform:'mic'});assert.equal(steps.filter(step=>step==='attach').length,1,'failed document cannot repeatedly commandeer debugger');
  }
});
test('MIC background initialization refuses visible pages, editors, unreadable state and foreign tabs',async()=>{
  for(const variant of ['visible','draft','editing','recent','unknown','foreign']) {
    const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});
    const busy=variant==='draft'?{hasDraft:true}:variant==='editing'?{userEditing:true}:variant==='recent'?{recentUserInput:true}:{};
    const tab=hiddenMIC(h,{hidden:variant!=='visible',busy});let attachments=0;
    if(variant==='unknown')delete h.replies.get(tab.id).busy;
    if(variant==='foreign')h.tabs.get(tab.id).url='https://personal.example/';
    h.api.debugger={attach:async()=>{attachments++;},sendCommand:async()=>{},detach:async()=>{}};
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},h.tabs.get(tab.id));assert.equal(attachments,0);assert.equal(h.tabUpdates.some(patch=>'active'in patch),false);assert.deepEqual(h.windowUpdates,[]);
  }
});
test('MIC initialization restores debugger before rejecting a changed document or newly edited draft',async()=>{
  for(const variant of ['document','draft','navigation']) {
    const steps=[];let h;
    h=harness({micInitializationWait:async()=>{steps.push('wait');if(variant==='document')h.replies.get(tab.id).documentToken=crypto.randomUUID();else if(variant==='draft')h.replies.get(tab.id).busy.hasDraft=true;else h.tabs.get(tab.id).url='https://personal.example/';}});
    await h.command('OPEN_CHATS',{platform:'mic'});const tab=hiddenMIC(h);
    h.api.debugger={attach:async()=>steps.push('attach'),sendCommand:async(target,method,params)=>steps.push(params.enabled?'enable':'disable'),detach:async()=>steps.push('detach')};
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
    assert.deepEqual(steps,['attach','enable','wait','disable','detach']);assert.notEqual(h.storage[DIALOGS_KEY].bindings.mic.status,'ready');assert.equal(h.storage[DIALOGS_KEY].bindings.mic.managed.pending,false);
  }
});
test('MIC navigation during debugger attach skips emulation but still releases only its own attachment',async()=>{
  const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=hiddenMIC(h),steps=[];
  h.api.debugger={attach:async()=>{steps.push('attach');h.tabs.get(tab.id).url='https://personal.example/';},sendCommand:async(target,method,params)=>steps.push(params.enabled?'enable':'disable'),detach:async()=>steps.push('detach')};
  await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);assert.deepEqual(steps,['attach','disable','detach']);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.tabId,null);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,'unbound');
});

test('opt-in read-chat traversal opens already read rows once and survives worker recreation and rebinding',async()=>{
  const h=harness();await ready(h);const row=unreadRow('read-supplier',{unread:false,needsRead:false,preview:'Our previous quote request'});h.replies.get(1).conversations.push(row);
  await h.command('START',{readUnread:false});await poll(h);assert.equal(opening(h).length,0);
  const mode=await h.command('SETTINGS',{settings:{scanRead:true}});assert.equal(mode.ok,true,mode.error);assert.equal(mode.state.settings.wechat,'buyer-wechat');assert.ok(mode.state.product.approval);
  await poll(h);assert.equal(opening(h).length,1);assert.equal(opening(h)[0].conversationId,'read-supplier');
  h.replies.get(1).conversations[0].active=false;Object.assign(row,{active:true,orderReliable:true,tailKnown:true,messages:[{id:'out1',direction:'outbound',text:'Our previous quote request'}]});
  await poll(h);assert.equal(h.storage[DIALOGS_KEY].traversal['1688'].pending,null);const item=h.storage[DIALOGS_KEY].conversations[conversationKey('1688',row.id)];assert.equal(item.readScan.status,'not_found');
  row.active=false;row.messages=[];h.replies.get(1).conversations[0].active=true;
  const recreated=createDialogMonitor({api:h.api,now:()=>h.time});await recreated.onAlarm({name:'openlinks-dialogs'});assert.equal(opening(h).length,1);
  await h.command('BIND_TAB',{platform:'1688',tabId:1});await poll(h);assert.equal(opening(h).length,1);
  assert.equal(h.calls.some(call=>['PREPARE','SEND','NATIVE_INPUT'].includes(call.type)),false);assert.equal(h.fetches,0);
});

test('read-chat traversal respects empty preview completion, busy composer, controls and changed previews',async()=>{
  const h=harness();await ready(h);await h.command('SETTINGS',{settings:{scanRead:true}});const row=unreadRow('read-empty',{unread:false,needsRead:false,preview:''});h.replies.get(1).conversations.push(row);
  await h.command('START',{readUnread:false});h.replies.get(1).busy={hasDraft:true};await poll(h);assert.equal(opening(h).length,0);
  h.replies.get(1).busy={hasDraft:false};await h.command('CONTROL',{key:conversationKey('1688',row.id),paused:true});await poll(h);assert.equal(opening(h).length,0);
  await h.command('CONTROL',{key:conversationKey('1688',row.id),paused:false});await poll(h);assert.equal(opening(h).length,1);
  h.replies.get(1).conversations[0].active=false;Object.assign(row,{active:true,orderReliable:true,tailKnown:true,messages:[{id:'out',direction:'outbound',text:'WeChat buyer-wechat'}]});await poll(h);
  row.active=false;row.messages=[];h.replies.get(1).conversations[0].active=true;await poll(h);assert.equal(opening(h).length,1);
  row.preview='A later response';await poll(h);assert.equal(opening(h).length,2);
});

test('read-chat scanning waits for a supplier reply after the latest buyer message in real and test modes',async()=>{
  const {h,previews}=previewHarness(),host=await folderReady(h,{auto:true});
  await h.command('SETTINGS',{settings:{scanRead:true}});const row=h.replies.get(1).conversations[0];Object.assign(row,{unread:false,messages:[...row.messages,{id:'buyer-last',direction:'outbound',text:'Please quote 100 units.'}]});
  await h.command('START',{readUnread:false});await poll(h);assert.equal(host.jobs.size,0);
  assert.equal((await h.command('FOLDER_DRAFT',{key})).ok,false,'read-chat opt-in cannot send another first message');
  let response=await h.command('FOLDER_SETTINGS',{testMode:true});response=await h.command('TEST_NEXT',testTokens(response));assert.equal(response.ok,true,response.error);await poll(h);
  assert.equal(host.jobs.size,0);assert.equal(previews.length,0,'test mode has the same supplier-reply requirement');
  row.messages.push({id:'supplier-new',direction:'inbound',text:'Yes, we have this product.'});row.preview='Yes, we have this product.';await poll(h);
  assert.equal(host.jobs.size,1);assert.equal(host.first.request.purpose,undefined);assert.match(host.first.prompt,/buyer-wechat/);
  const done=await completeTest(h,host,'Please add me on WeChat: buyer-wechat');assert.equal(previews.length,1);assert.deepEqual(done.folder.sendReceipts,[]);
  await h.command('TEST_NEXT',testTokens(done));await poll(h);assert.equal(host.jobs.size,1,'the same supplier response cannot create another cycle');
  const recreated=createDialogMonitor({api:h.api,now:()=>h.time});await recreated.onAlarm({name:'openlinks-dialogs'});assert.equal(host.jobs.size,1);
  assert.equal(h.calls.some(call=>call.type==='SEND'),false);
});

test('inbound-only history cannot generate a supplier reply through API, folder, manual prompt or test mode',async()=>{
  const {h,previews}=previewHarness();h.replies.get(1).conversations[0].messages=[{id:'unsolicited',direction:'inbound',text:'Hello, do you need our product?'}];
  const host=await folderReady(h,{auto:true,autoSend:true});await h.command('SETTINGS',{settings:{scanRead:true}});await h.command('START');await poll(h);
  assert.equal(host.jobs.size,0);assert.equal(h.fetches,0);
  for(const type of ['GENERATE_DRAFT','FOLDER_DRAFT','EXPORT_DRAFT_PROMPT'])assert.equal((await h.command(type,{key})).ok,false,type);
  let response=await h.command('FOLDER_SETTINGS',{testMode:true});await h.command('TEST_NEXT',testTokens(response));await poll(h);
  assert.equal(host.jobs.size,0);assert.equal(previews.length,0);assert.equal(h.fetches,0);assert.equal(h.calls.some(call=>['PREPARE','SEND'].includes(call.type)),false);
});

test('product and model changes never authorize a proactive buyer-last WeChat invitation',async()=>{
  const {h,previews}=previewHarness(),host=await folderReady(h,{auto:true});await h.command('SETTINGS',{settings:{scanRead:true}});const row=h.replies.get(1).conversations[0];row.messages.push({id:'out',direction:'outbound',text:'Please quote 100 units.'});
  let response=await h.command('FOLDER_SETTINGS',{testMode:true});await h.command('TEST_NEXT',testTokens(response));await poll(h);assert.equal(host.jobs.size,0);
  await h.command('PRODUCT_SAVE',{product:{keyPoints:'Model updated; quantity: 200 units.'}});const changed=await h.command('GET');await h.command('PRODUCT_APPROVE',{revision:changed.state.product.revision,fingerprint:changed.productFingerprint});await h.command('FOLDER_SETTINGS',{model:'sonnet'});
  const held=await h.command('GET');await h.command('TEST_NEXT',testTokens(held));await poll(h);assert.equal(host.jobs.size,0);assert.equal(previews.length,0);assert.equal(h.storage.openlinksClaudeFolder.test.completed.length,0);
});

test('MIC mailbox with site suffix never becomes ready and synchronous widget expansion rechecks frames immediately',async()=>{
  for(const changedDraft of [false,true]) {
    const h=harness();await h.command('OPEN_CHATS',{platform:'mic'});const tab=micBootstrapReady(h);tab.url=CHAT_CENTERS.mic+'?source=center#/messages';h.tabs.get(tab.id).url=tab.url;h.replies.get(tab.id).url=tab.url;h.frameLists.get(tab.id)[0].url=tab.url;
    h.replies.get(`${tab.id}:1`).status='ready';h.replies.get(`${tab.id}:1`).conversations=snapshot('mic').conversations;let captures=0;
    h.api.scripting={executeScript:async()=>{captures++;if(captures===1){if(changedDraft)h.replies.get(`${tab.id}:1`).busy.hasDraft=true;return [{frameId:0,result:{ok:false,status:'loading',reason:'widget_ready'}}];}return [{frameId:0,result:{ok:true,url:micNativeURL}}];}};
    await h.monitor.onTabUpdated(tab.id,{status:'complete'},tab);
    assert.equal(Object.keys(h.storage[DIALOGS_KEY].conversations).length,0);assert.equal(h.storage[DIALOGS_KEY].bindings.mic.status,changedDraft?'paused':'loading');assert.equal(captures,changedDraft?1:2);assert.equal(h.tabUpdates.filter(patch=>patch.url).length,changedDraft?0:1);assert.deepEqual(h.windowUpdates,[]);
  }
});

test('a completed old test does not prevent the new read-only contact pass or buy another Claude reply',async()=>{
  const {h}=previewHarness(),host=await testCycleReady(h),done=await completeTest(h,host);await h.command('TEST_NEXT',testTokens(done));await h.command('SETTINGS',{settings:{scanRead:true}});
  const row=h.replies.get(1).conversations[0];Object.assign(row,{active:false,unread:false,preview:'',canSelect:true,selectionToken:'old-tested-row',messages:[]});
  await h.command('START',{readUnread:false});await h.command('TEST_NEXT',testTokens(await h.command('GET')));await poll(h);
  assert.equal(opening(h).length,1);assert.equal(opening(h)[0].conversationId,row.id);assert.equal(host.jobs.size,1);assert.equal(h.storage.openlinksClaudeFolder.test.completed.length,1);
});

test('full durable contact ledger stops new read-only checks but preserves ordinary unread traversal',async()=>{
  const h=harness();await ready(h);await h.command('SETTINGS',{settings:{scanRead:true}});h.storage[DIALOGS_KEY].contactLedger.saturated=true;
  h.replies.get(1).conversations.push(unreadRow('read-capacity',{unread:false,preview:'Already read',needsRead:false}));await h.command('START',{readUnread:false});await poll(h);assert.equal(opening(h).length,0);
  assert.equal(h.storage[DIALOGS_KEY].events.filter(event=>event.type==='wechat_capacity').length,1);await poll(h);assert.equal(h.storage[DIALOGS_KEY].events.filter(event=>event.type==='wechat_capacity').length,1);
  h.replies.get(1).conversations.push(unreadRow('unread-still-allowed'));await h.command('START',{readUnread:true});await poll(h);assert.equal(opening(h).length,1);assert.equal(opening(h)[0].conversationId,'unread-still-allowed');assert.equal(h.fetches,0);
});

function jointHarness({startError=null,...options}={}) {
  const joint={enabled:false,phase:'separate',allowDialogs:true,detail:'Independent work',nextAt:null,pending:0,quotaPlatforms:[]},actions=[];
  let inTurn=false;
  const h=harness({
    getWorkCoordination:async()=>structuredClone(joint),
    withDialogTurn:async task=>{
      actions.push('turn');
      if(!joint.allowDialogs)return {allowed:false,status:structuredClone(joint)};
      assert.equal(inTurn,false,'dialogue turns must not overlap');inTurn=true;
      try{return {allowed:true,status:structuredClone(joint),value:await task()};}finally{inTurn=false;}
    },
    startOutreachForJoint:async()=>{actions.push('start-outreach');if(startError)throw new Error(startError);Object.assign(joint,{enabled:true,phase:'outreach',allowDialogs:false,pending:3});return structuredClone(joint);},
    pauseOutreachForJoint:async()=>{actions.push('pause-outreach');Object.assign(joint,{enabled:false,phase:'paused',allowDialogs:true});return structuredClone(joint);},
    disableJointWork:async()=>{actions.push('disable-joint');joint.enabled=false;return structuredClone(joint);},
    ...options,
  });
  return {h,joint,actions,get inTurn(){return inTurn;}};
}

test('joint status reports coordinator state without starting either block or changing approval mode',async()=>{
  const {h,joint,actions}=jointHarness();Object.assign(joint,{enabled:true,phase:'waiting_limits',allowDialogs:true,nextAt:2000000,pending:4,quotaPlatforms:['1688','alibaba']});
  const response=await h.command('JOINT_GET');assert.equal(response.ok,true,response.error);assert.deepEqual(response.joint,joint);
  assert.deepEqual(actions,[]);assert.equal(h.calls.length,0);assert.equal(h.fetches,0);assert.equal(h.storage.openlinksClaudeFolder,undefined);
});

test('joint start enables preparation but preserves manual or automatic approval and an existing reviewed draft',async()=>{
  for(const autoSend of [false,true]) {
    const {h,joint,actions}=jointHarness();await folderReady(h,{auto:autoSend,autoSend});const before=await h.command('GET'),item=before.state.conversations[key];
    assert.equal((await h.command('SAVE_DRAFT',{key,text:'Reviewed answer waiting for approval.',revision:item.revision,fingerprint:item.fingerprint,productFingerprint:before.productFingerprint})).ok,true);
    const reviewed=structuredClone(h.storage[DIALOGS_KEY].conversations[key].draft),response=await h.command('JOINT_START');
    assert.equal(response.ok,true,response.error);assert.equal(response.state.running,true);assert.equal(response.state.readUnread,true);
    assert.equal(response.folder.auto,true);assert.equal(response.folder.autoSend,autoSend);assert.deepEqual(response.state.conversations[key].draft,reviewed);
    assert.equal(joint.enabled,true);assert.equal(actions.filter(action=>action==='start-outreach').length,1);assert.equal(actions.includes('pause-outreach'),false);
    assert.equal(h.fetches,0);assert.equal(h.calls.some(call=>['PREPARE','SEND'].includes(call.type)),false);
  }
});

test('joint start validates approval, folder, bindings and test mode before changing either block',async()=>{
  for(const invalid of ['approval','folder','bindings','test']) {
    const {h,actions}=jointHarness();await folderReady(h,{auto:false,autoSend:true});
    if(invalid==='approval')await h.command('PRODUCT_SAVE',{product:{rules:'These edits are not approved yet.'}});
    if(invalid==='folder')await h.command('FOLDER_SETTINGS',{enabled:false});
    if(invalid==='bindings')await h.command('UNBIND_TAB',{platform:'1688'});
    if(invalid==='test')await h.command('FOLDER_SETTINGS',{testMode:true});
    const before=structuredClone(h.storage),count=actions.length,result=await h.command('JOINT_START');
    assert.equal(result.ok,false,invalid);assert.deepEqual(h.storage,before,invalid);assert.equal(actions.length,count,invalid);
    assert.equal(h.calls.some(call=>['PREPARE','SEND'].includes(call.type)),false,invalid);
  }
});

test('failed joint outreach startup rolls back preparation and monitor mode without losing a saved draft',async()=>{
  for(const running of [false,true]) {
    const {h,actions}=jointHarness({startError:'Не удалось запустить очередь первичных обращений.'});await folderReady(h,{auto:false,autoSend:false});
    if(running)await h.command('START',{readUnread:false});
    const before=await h.command('GET'),item=before.state.conversations[key];await h.command('SAVE_DRAFT',{key,text:'Keep this reviewed reply.',revision:item.revision,fingerprint:item.fingerprint,productFingerprint:before.productFingerprint});
    const stored=structuredClone(h.storage[DIALOGS_KEY].conversations[key].draft),response=await h.command('JOINT_START',{readUnread:!before.state.readUnread}),after=await h.command('GET');
    assert.equal(response.ok,false);assert.equal(typeof response.error,'string');assert.equal(after.state.running,running);assert.equal(after.state.readUnread,before.state.readUnread);
    assert.equal(after.folder.auto,false);assert.equal(after.folder.autoSend,false);assert.deepEqual(after.state.conversations[key].draft,stored);assert.equal(actions.filter(action=>action==='start-outreach').length,1);
  }
});

test('joint pause stops both blocks while ordinary monitor start and stop only leave joint scheduling',async()=>{
  const {h,joint,actions}=jointHarness();await folderReady(h,{auto:true,autoSend:true});assert.equal((await h.command('JOINT_START')).ok,true);
  const paused=await h.command('JOINT_PAUSE');assert.equal(paused.ok,true,paused.error);assert.equal(paused.state.running,false);assert.equal(joint.enabled,false);
  assert.equal(paused.folder.autoSend,true);assert.equal(actions.filter(action=>action==='pause-outreach').length,2);
  for(const command of ['START','STOP']) {
    joint.enabled=true;const pauses=actions.filter(action=>action==='pause-outreach').length,disables=actions.filter(action=>action==='disable-joint').length;
    const result=await h.command(command);assert.equal(result.ok,true,result.error);assert.equal(result.state.running,command==='START');assert.equal(joint.enabled,false);
    assert.equal(actions.filter(action=>action==='disable-joint').length,disables+1);assert.equal(actions.filter(action=>action==='pause-outreach').length,pauses,'separate controls do not pause first contacts');
  }
});

test('outreach priority holds queued Claude dialogue results and blocks automatic traversal, inference and sending',async()=>{
  let sends=0;const {h,joint,actions}=jointHarness({folderSender:async()=>{sends++;return {status:'attempted'};}}),host=await folderReady(h,{auto:true,autoSend:true});
  assert.equal((await h.command('FOLDER_DRAFT',{key})).ok,true);await h.command('START',{readUnread:true});host.done();h.replies.get(1).conversations.push(unreadRow('waiting-supplier'));
  Object.assign(joint,{enabled:true,phase:'outreach',allowDialogs:false,pending:2});const pending=normalizeFolder(h.storage.openlinksClaudeFolder).jobs,nativeBefore=host.calls.length;
  await poll(h);await poll(h);
  assert.deepEqual(normalizeFolder(h.storage.openlinksClaudeFolder).jobs,pending);assert.equal(h.storage[DIALOGS_KEY].conversations[key].draft,null);assert.equal(host.jobs.size,1);
  assert.equal(host.calls.slice(nativeBefore).some(call=>call.action==='poll'&&call.ids.includes(host.first.id)),false);
  assert.equal(opening(h).length,0);assert.equal(sends,0);assert.equal(h.fetches,0);assert.ok(actions.filter(action=>action==='turn').length>=2);
  Object.assign(joint,{phase:'waiting_limits',allowDialogs:true,nextAt:h.time+1200000});await h.command('FOLDER_SETTINGS',{autoSend:false});await poll(h);
  assert.equal(h.storage.openlinksClaudeFolder.jobs[0].status,'accepted');assert.equal(h.storage[DIALOGS_KEY].conversations[key].draft.text,'Could you quote 100 units?');assert.equal(host.jobs.size,1);assert.equal(sends,0);
});

test('product analysis results can be polled while first contacts own the dialogue turn',async()=>{
  const {h,joint}=jointHarness(),host=await folderReady(h,{auto:true});const before=await h.command('GET');
  assert.equal((await h.command('FOLDER_PRODUCT',{revision:before.state.product.revision,fingerprint:before.productFingerprint})).ok,true);
  host.done(JSON.stringify({keyPoints:'Quantity: 250 units',questions:'Confirm lead time',warnings:''}));await h.command('START');Object.assign(joint,{enabled:true,phase:'outreach',allowDialogs:false});
  await poll(h);const after=await h.command('GET');assert.equal(after.folder.jobs[0].status,'accepted');assert.equal(after.state.product.keyPoints,'Quantity: 250 units');
  assert.equal(host.jobs.size,1);assert.equal(opening(h).length,0);assert.equal(h.fetches,0);assert.equal(h.calls.some(call=>['PREPARE','SEND'].includes(call.type)),false);
});

test('the allowed dialogue lease contains automatic Claude submission and result handling',async()=>{
  const control=jointHarness(),{h,joint}=control,host=await folderReady(h,{auto:true});const native=h.api.runtime.sendNativeMessage;
  h.api.runtime.sendNativeMessage=async(name,message)=>{if(['submit','poll'].includes(message.action))assert.equal(control.inTurn,true,'Claude dialogue actions must remain inside the coordinator lease');return native(name,message);};
  await h.command('START');Object.assign(joint,{enabled:true,phase:'waiting_limits',allowDialogs:true});await poll(h);assert.equal(host.jobs.size,1);host.done();await poll(h);
  assert.equal(h.storage.openlinksClaudeFolder.jobs[0].status,'accepted');assert.equal(h.storage[DIALOGS_KEY].conversations[key].draft.text,'Could you quote 100 units?');assert.equal(control.inTurn,false);
});

test('an already shared WeChat never prevents an ordinary response to the supplier after outreach',async()=>{
  const h=harness();h.replies.get(1).conversations[0].messages[0].text='We need 100 units. My WeChat: buyer-wechat';const host=await folderReady(h,{auto:true});
  await h.command('SETTINGS',{settings:{scanRead:true}});await h.command('START');await poll(h);
  assert.equal(host.jobs.size,1);assert.equal(host.first.request.purpose,undefined);assert.equal(h.storage[DIALOGS_KEY].conversations[key].unanswered,true);
  host.done('Could you confirm the lead time?');await poll(h);assert.equal(h.storage[DIALOGS_KEY].conversations[key].draft.text,'Could you confirm the lead time?');assert.deepEqual(h.storage.openlinksClaudeFolder.sendReceipts,[]);
});

test('a concurrent manual draft waits for the active dialogue lease and rechecks outreach priority afterward',async()=>{
  for(const outreachResumed of [false,true]) {
    const control=jointHarness(),{h,joint,actions}=control,host=await folderReady(h,{auto:true}),entered=deferred(),release=deferred();
    h.replies.get(2).conversations[0].messages.push({id:'second-buyer',direction:'outbound',text:'Please confirm the specifications.'});
    await h.command('BIND_TAB',{platform:'alibaba',tabId:2});await h.command('START');Object.assign(joint,{enabled:true,phase:'waiting_limits',allowDialogs:true});
    const native=h.api.runtime.sendNativeMessage;h.api.runtime.sendNativeMessage=async(name,message)=>{
      if(message.action==='submit'){assert.equal(control.inTurn,true);entered.resolve();await release.promise;}
      return native(name,message);
    };
    const automatic=poll(h);await entered.promise;
    h.replies.get(2).conversations[0].messages.push({id:'second-supplier',direction:'inbound',text:'These are the requested specifications.'});
    const manual=h.command('FOLDER_DRAFT',{key:conversationKey('alibaba','supplier-1')});await new Promise(done=>setImmediate(done));
    assert.equal(actions.filter(action=>action==='turn').length,1,'independent command must wait for the active monitor turn');
    if(outreachResumed)Object.assign(joint,{phase:'outreach',allowDialogs:false});release.resolve();await automatic;const result=await manual;
    assert.equal(result.ok,!outreachResumed,result.error);assert.equal(host.jobs.size,outreachResumed?1:2);assert.equal(host.first.request.key,key);
    if(!outreachResumed)assert.equal(actions.filter(action=>action==='turn').length,2,'the next command must acquire its own lease');
    assert.equal(control.inTurn,false);assert.equal(h.storage.openlinksClaudeFolder.jobs.length,outreachResumed?1:2);assert.equal(h.calls.some(call=>['PREPARE','SEND'].includes(call.type)),false);
  }
});

test('joint pause stops first contacts before waiting for slow Claude job cancellation',async()=>{
  const {h,joint,actions}=jointHarness(),host=await folderReady(h,{auto:true}),entered=deferred(),release=deferred();
  await h.command('FOLDER_DRAFT',{key});assert.equal((await h.command('JOINT_START')).ok,true);const native=h.api.runtime.sendNativeMessage;
  h.api.runtime.sendNativeMessage=async(name,message)=>{if(message.action==='cancel'){entered.resolve();await release.promise;}return native(name,message);};
  const stopping=h.command('JOINT_PAUSE');await entered.promise;
  assert.equal(joint.enabled,false,'outreach must already be paused while the folder cancellation is pending');assert.equal(actions.filter(action=>action==='pause-outreach').length,2);
  release.resolve();const stopped=await stopping;assert.equal(stopped.ok,true,stopped.error);assert.equal(stopped.state.running,false);assert.equal(stopped.folder.jobs[0].status,'cancelled');
  assert.equal(host.jobs.size,1);assert.equal(h.calls.some(call=>['PREPARE','SEND'].includes(call.type)),false);
});

test('manual retry of a dialogue folder job waits for outreach priority without spending an attempt',async()=>{
  const {h,joint}=jointHarness(),host=await folderReady(h);host.loseNextSubmit();const queued=await h.command('FOLDER_DRAFT',{key});assert.equal(queued.folder.jobs[0].status,'unknown');
  const id=host.first.id,before=normalizeFolder(h.storage.openlinksClaudeFolder).jobs[0],calls=h.calls.length;Object.assign(joint,{enabled:true,phase:'outreach',allowDialogs:false});
  const held=await h.command('FOLDER_RETRY',{id});assert.equal(held.ok,false);assert.deepEqual(normalizeFolder(h.storage.openlinksClaudeFolder).jobs[0],before);
  assert.equal(host.calls.filter(call=>call.action==='submit').length,1);assert.equal(h.calls.length,calls);assert.equal(host.jobs.size,1);
  Object.assign(joint,{phase:'waiting_limits',allowDialogs:true});const retried=await h.command('FOLDER_RETRY',{id});assert.equal(retried.ok,true,retried.error);assert.equal(retried.folder.jobs[0].status,'queued');
  assert.equal(h.storage.openlinksClaudeFolder.jobs[0].attempts,2);assert.equal(host.calls.filter(call=>call.action==='submit').length,2);assert.equal(host.jobs.size,1);
});

test('product folder retries remain available while first contacts hold the dialogue turn',async()=>{
  const {h,joint,actions}=jointHarness(),host=await folderReady(h),before=await h.command('GET');host.loseNextSubmit();
  const queued=await h.command('FOLDER_PRODUCT',{revision:before.state.product.revision,fingerprint:before.productFingerprint});assert.equal(queued.folder.jobs[0].status,'unknown');
  Object.assign(joint,{enabled:true,phase:'outreach',allowDialogs:false});const retried=await h.command('FOLDER_RETRY',{id:host.first.id});
  assert.equal(retried.ok,true,retried.error);assert.equal(retried.folder.jobs[0].status,'queued');assert.equal(host.jobs.size,1);assert.equal(host.calls.filter(call=>call.action==='submit').length,2);assert.equal(actions.includes('turn'),false);
});

test('a queued joint pause wins after a joint start that was still persisting its monitor state',async()=>{
  const {h,joint,actions}=jointHarness();await folderReady(h,{auto:false});const entered=deferred(),release=deferred(),write=h.api.storage.local.set;let held=false;
  h.api.storage.local.set=async data=>{
    if(!held&&data[DIALOGS_KEY]?.running===true){held=true;entered.resolve();await release.promise;}
    return write(data);
  };
  const starting=h.command('JOINT_START');await entered.promise;
  const stopping=h.command('JOINT_PAUSE');await new Promise(done=>setImmediate(done));
  assert.equal(actions.filter(action=>action==='pause-outreach').length,1,'the urgent stop must run before the pending start finishes');assert.equal(joint.enabled,false);
  release.resolve();const [started,stopped]=await Promise.all([starting,stopping]);assert.equal(started.ok,true,started.error);assert.equal(stopped.ok,true,stopped.error);
  assert.equal(joint.enabled,false);assert.equal(stopped.state.running,false);assert.equal((await h.command('GET')).state.running,false);
  assert.equal(actions.filter(action=>action==='pause-outreach').length,2);assert.equal(actions.at(-1),'pause-outreach','serialized stop must follow any start that was already pending');
});

test('a later joint start remains after an earlier pause whose urgent backend stop is slow',async()=>{
  const entered=deferred(),release=deferred();let control,pauses=0;
  control=jointHarness({pauseOutreachForJoint:async()=>{
    control.actions.push('pause-outreach');Object.assign(control.joint,{enabled:false,phase:'paused',allowDialogs:true});
    if(++pauses===1){entered.resolve();await release.promise;}
    return structuredClone(control.joint);
  }});
  const {h,joint,actions}=control;await folderReady(h,{auto:false});assert.equal((await h.command('JOINT_START')).ok,true);
  const stopping=h.command('JOINT_PAUSE');await entered.promise;const restarting=h.command('JOINT_START');await new Promise(done=>setImmediate(done));
  assert.equal(actions.filter(action=>action==='start-outreach').length,1,'later start must wait behind the already requested pause');
  release.resolve();const [stopped,restarted]=await Promise.all([stopping,restarting]);assert.equal(stopped.ok,true,stopped.error);assert.equal(restarted.ok,true,restarted.error);
  assert.equal(joint.enabled,true);assert.equal((await h.command('GET')).state.running,true);assert.equal(actions.at(-1),'start-outreach');assert.equal(pauses,2);
});

async function workflowReady(h,{folder=false,testMode=false}={}) {
  h.advanceTime(Date.now()-h.time);
  const row=h.replies.get(1).conversations[0];
  row.messages[0].text='Hello. I need a log splitter for firewood.';
  Object.assign(row,{replyFingerprint:'reader-reply-1',latestMessageAt:h.time,latestMessageAtReliable:true,firstBuyerMessage:{id:row.messages[0].id,direction:'outbound',text:row.messages[0].text,at:h.time-1000},firstBuyerMessageReliable:true});
  await ready(h);
  assert.equal((await h.command('MEMORY_SAVE',{name:'Дровоколы',aliases:['log splitter','wood splitter']})).ok,true);
  assert.equal((await h.command('SETTINGS',{settings:{workflow24h:true}})).ok,true);
  const host=folder?fakeFolder(h):null;
  if(folder)assert.equal((await h.command('FOLDER_SETTINGS',{enabled:true,auto:true,testMode})).ok,true);
  return host;
}
function workflowInactive(h,id,extra={}) {
  return {id,title:id,identityReliable:true,active:false,canSelect:true,selectionToken:'select-'+id,unread:false,needsRead:true,preview:'Supplier replied',latestMessageAt:h.time,latestMessageAtReliable:true,...extra};
}
test('workflow24h migrates production once and keeps test safety settings unchanged',async()=>{
  const h=harness();await ready(h);h.storage.openlinksClaudeFolder=normalizeFolder({test:{enabled:true,phase:'paused',sessionId:crypto.randomUUID(),cycleId:crypto.randomUUID()},autoSend:false});
  h.api.runtime.getManifest=()=>({version:'0.20.0'});
  const migrated=await h.command('GET');assert.equal(migrated.ok,true,migrated.error);assert.equal(migrated.state.settings.workflow24h,true);assert.equal(migrated.state.settings.workflowMigrationVersion,1);assert.equal(migrated.folder.test.enabled,true);assert.equal(migrated.folder.autoSend,false);
  assert.equal(migrated.state.productMemories.entries.length,0);assert.equal(h.fetches,0);
});
test('workflow24h saves named approved product memory and uses the first buyer message for the folder prompt',async()=>{
  const h=harness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);
  assert.equal(host.jobs.size,1);assert.match(host.first.prompt,/Дровоколы/);assert.match(host.first.prompt,/log splitter/);
  const response=await h.command('GET');assert.equal(response.state.conversations[key].workflowAssessment.allowed,true);assert.equal(response.workflowActivity.phase,'waiting_claude');assert.ok(response.workflowActivityHistory.length);
  await poll(h);assert.equal(host.jobs.size,1,'same supplier message must not trigger another paid inference');
});
test('workflow24h skips old and completed chats, opens unknown dates only to inspect, and makes one row click per alarm',async()=>{
  const h=harness();await workflowReady(h);const active=h.replies.get(1).conversations[0];active.messages.push({id:'my-last',direction:'outbound',text:'Waiting for your quote.'});
  h.replies.get(1).conversations.push(workflowInactive(h,'old',{latestMessageAt:h.time-86400001}),workflowInactive(h,'unknown',{latestMessageAt:null,latestMessageAtReliable:false}),workflowInactive(h,'recent'));
  await h.command('START');await poll(h);
  assert.deepEqual(opening(h).map(row=>row.conversationId),['unknown']);
  const state=(await h.command('GET')).state;assert.equal(state.workflow.visits[conversationKey('1688','old')].status,'expired');assert.equal(state.workflow.visits[key].status,'waiting_supplier');
});
test('workflow24h marks any participant mention of buyer WeChat completed and creates no AI job',async()=>{
  const h=harness(),host=await workflowReady(h,{folder:true});h.replies.get(1).conversations[0].messages.at(-1).text='I have added buyer-wechat on WeChat.';
  await h.command('START');await poll(h);assert.equal(host.jobs.size,0);
  const response=await h.command('GET');assert.equal(response.state.conversations[key].workflowAssessment.status,'completed');assert.equal(response.state.workflow.visits[key].status,'completed');
});
test('workflow24h missing first buyer message loads history with a bounded retry and then moves on',async()=>{
  const h=harness();await workflowReady(h);const row=h.replies.get(1).conversations[0];delete row.firstBuyerMessage;row.firstBuyerMessageReliable=false;h.storage[DIALOGS_KEY].conversations[key].firstBuyerMessage=null;h.storage[DIALOGS_KEY].conversations[key].firstBuyerMessageReliable=false;
  h.replies.get(1).conversations.push(workflowInactive(h,'other'));await h.command('START');
  for(let i=0;i<9;i++){await poll(h);h.advanceTime(1100);}
  assert.equal(h.calls.filter(call=>call.type==='DIALOGS_LOAD_HISTORY_START').length,8);
  const response=await h.command('GET');assert.equal(response.state.workflow.visits[key].status,'history_unavailable');assert.ok(response.state.traversal['1688'].backoff[key]>h.time);
  await poll(h);assert.equal(opening(h).at(-1).conversationId,'other');assert.equal(h.fetches,0);
});
test('workflow24h pause preserves an in-flight folder job and resume consumes the same result',async()=>{
  const h=harness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);const id=host.first.id;assert.equal(host.jobs.size,1);
  const paused=await h.command('STOP');assert.equal(paused.workflowActivity.phase,'paused');assert.equal(paused.folder.jobs[0].status,'queued');assert.equal(host.calls.some(call=>call.action==='cancel'),false);
  host.done('Please quote the log splitter.');const calls=host.calls.filter(call=>call.action==='poll').length;await poll(h);assert.equal(host.calls.filter(call=>call.action==='poll').length,calls);assert.equal((await h.command('GET')).state.conversations[key].draft,null);
  await h.command('START');await poll(h);const resumed=await h.command('GET');assert.equal(host.jobs.size,1);assert.equal(resumed.folder.jobs[0].id,id);assert.equal(resumed.state.conversations[key].draft.text,'Please quote the log splitter.');
});
test('workflow24h test fills exact candidate without sending and shows the same review text',async()=>{
  const {h,previews}=previewHarness(),host=await workflowReady(h,{folder:true,testMode:true});
  const enabled=await h.command('GET');assert.equal((await h.command('TEST_NEXT',testTokens(enabled))).ok,true);await poll(h);assert.equal(host.jobs.size,1);
  const text='Can you provide the log splitter specifications?';host.done(text);await poll(h);const preview=await h.command('GET');assert.equal(preview.folder.test.phase,'completed');assert.equal(preview.folder.test.text,text);assert.ok(h.storage.openlinksClaudeFolder.test.cleanupToken);assert.equal(previews.length,1);assert.equal(previews[0].text,text);assert.equal(h.fetches,0);
  const next=await h.command('TEST_NEXT',testTokens(preview));assert.equal(next.ok,true,next.error);assert.equal(h.storage.openlinksClaudeFolder.test.history[0].simulated,true);assert.equal(h.storage.openlinksClaudeFolder.test.history[0].text,text);await poll(h);assert.equal(host.jobs.size,1);
});
test('workflow24h virtual inbox advances with a one-use reader token only after visible chats are exhausted',async()=>{
  const h=harness();await workflowReady(h);const snap=h.replies.get(1);snap.conversations[0].messages.push({id:'last',direction:'outbound',text:'Waiting.'});snap.listCoverage={token:'list-1',hasMore:true,status:'ready',complete:false};
  await h.command('START');await poll(h);const advance=h.calls.filter(call=>call.type==='DIALOGS_ADVANCE_LIST');assert.equal(advance.length,1);assert.equal(advance[0].listToken,'list-1');assert.equal(advance[0].documentToken,'doc-1');assert.equal(opening(h).length,0);
});
test('workflow24h holds a pending chat on its marketplace before bounded timeout permits the next platform',async()=>{
  const h=harness();await workflowReady(h);
  for(const [index,name] of ['1688','alibaba','mic'].entries()){
    if(index)await h.command('BIND_TAB',{platform:name,tabId:index+1});
    h.replies.get(index+1).conversations=[];h.replies.get(index+1).conversations.push(workflowInactive(h,'target-'+name));
  }
  await h.command('START');for(let index=0;index<3;index++)await poll(h);
  assert.deepEqual(opening(h).map(row=>row.id),[1]);h.advanceTime(120001);await poll(h);await poll(h);assert.deepEqual(opening(h).map(row=>row.id),[1,2]);assert.equal(h.tabUpdates.some(update=>update.active===true),false);assert.equal(h.windowUpdates.length,0);
});
test('workflow24h a pause during submit preserves the paid job UUID and never cancels it',async()=>{
  const h=harness(),host=await workflowReady(h,{folder:true}),entered=deferred(),release=deferred(),native=h.api.runtime.sendNativeMessage;
  h.api.runtime.sendNativeMessage=async(name,message)=>{const value=await native(name,message);if(message.action==='submit'){entered.resolve();await release.promise;}return value;};
  await h.command('START');const polling=poll(h);await entered.promise;const pausing=h.command('STOP');release.resolve();await polling;const paused=await pausing;
  assert.equal(paused.ok,true);assert.equal(paused.state.running,false);assert.equal(paused.folder.jobs[0].status,'queued');assert.equal(host.jobs.size,1);assert.equal(host.calls.some(call=>call.action==='cancel'||call.action==='ack'),false);
  host.done();await h.command('START');await poll(h);assert.equal((await h.command('GET')).state.conversations[key].draft.text,'Could you quote 100 units?');assert.equal(host.jobs.size,1);
});
test('workflow24h a pause while re-reading a completed result retains it for resume',async()=>{
  const h=harness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done();
  const entered=deferred(),release=deferred(),native=h.api.tabs.sendMessage;let hold=true;
  h.api.tabs.sendMessage=async(...args)=>{if(args[1].type==='DIALOGS_SNAPSHOT'&&hold){hold=false;entered.resolve();await release.promise;}return native(...args);};
  const checking=h.command('FOLDER_POLL');await entered.promise;const pausing=h.command('STOP');release.resolve();await checking;const paused=await pausing;
  assert.equal(paused.ok,true);assert.equal(paused.folder.jobs[0].status,'done');assert.equal(host.calls.some(call=>call.action==='ack'&&call.outcome==='stale'),false);assert.equal(paused.state.conversations[key].draft,null);
  await h.command('START');await poll(h);assert.equal((await h.command('GET')).state.conversations[key].draft.text,'Could you quote 100 units?');assert.equal(host.jobs.size,1);
});
test('workflow24h continues a started history operation when the top slice temporarily has no last-message date',async()=>{
  const h=harness();await workflowReady(h);const row=h.replies.get(1).conversations[0];delete row.firstBuyerMessage;row.firstBuyerMessageReliable=false;h.storage[DIALOGS_KEY].conversations[key].firstBuyerMessage=null;h.storage[DIALOGS_KEY].conversations[key].firstBuyerMessageReliable=false;
  await h.command('START');await poll(h);row.latestMessageAt=null;row.latestMessageAtReliable=false;row.tailKnown=false;h.advanceTime(1100);await poll(h);
  assert.equal(h.calls.filter(call=>call.type==='DIALOGS_LOAD_HISTORY_START').length,2);assert.equal((await h.command('GET')).state.workflow.history[key].phase,'start');
});
test('workflow24h activation follows only the operated lane and can be disabled without cancelling Claude',async()=>{
  const h=harness(),host=await workflowReady(h,{folder:true});await h.command('SETTINGS',{settings:{showWorkingTab:true}});await h.command('START');await poll(h);
  assert.deepEqual(h.tabUpdates.filter(update=>update.active===true).map(update=>update.id),[1]);assert.equal(h.windowUpdates.length,0);assert.equal(host.jobs.size,1);
  const before=(await h.command('GET')).folder.jobs[0];const changed=await h.command('SETTINGS',{settings:{showWorkingTab:false}});
  assert.equal(changed.state.settings.showWorkingTab,false);assert.equal(changed.folder.jobs[0].id,before.id);assert.equal(changed.folder.jobs[0].status,'queued');assert.equal(host.calls.some(call=>call.action==='cancel'),false);
  host.done();await poll(h);assert.equal((await h.command('GET')).state.conversations[key].draft.text,'Could you quote 100 units?');
});
test('workflow24h manual scan while stopped never activates a marketplace tab',async()=>{
  const h=harness();await workflowReady(h);await h.command('SETTINGS',{settings:{showWorkingTab:true}});await h.command('SCAN');assert.equal(h.tabUpdates.some(update=>update.active),false);assert.equal(h.windowUpdates.length,0);
});
test('workflow24h transient history loading stays pending instead of becoming an error',async()=>{
  const h=harness();await workflowReady(h);const row=h.replies.get(1).conversations[0];delete row.firstBuyerMessage;row.firstBuyerMessageReliable=false;h.storage[DIALOGS_KEY].conversations[key].firstBuyerMessage=null;h.storage[DIALOGS_KEY].conversations[key].firstBuyerMessageReliable=false;
  const native=h.api.tabs.sendMessage;h.api.tabs.sendMessage=(id,message,options)=>message.type==='DIALOGS_LOAD_HISTORY_START'?Promise.resolve({ok:false,status:'loading'}):native(id,message,options);
  await h.command('START');await poll(h);const state=(await h.command('GET')).state;assert.equal(state.workflow.history[key].attempts,0);assert.equal(state.traversal['1688'].backoff[key],undefined);
});
test('workflow24h selects rendered chats beyond the 100-transcript cache across marketplaces',async()=>{
  const h=harness();await workflowReady(h);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});
  for(const [index,name] of ['1688','alibaba'].entries()){
    h.replies.get(index+1).conversations=Array.from({length:150},(_,position)=>workflowInactive(h,`${name}-supplier-${position}`));
    for(let position=0;position<120;position++)h.storage[DIALOGS_KEY].workflow.visits[conversationKey(name,`${name}-supplier-${position}`)]={at:h.time,sweepId:h.storage[DIALOGS_KEY].workflow.sweepId,preview:'Supplier replied',status:'waiting_supplier',detail:'Already checked this sweep.'};
  }
  await h.command('START');await poll(h);
  assert.ok(h.storage[DIALOGS_KEY].conversations[conversationKey('1688','1688-supplier-120')]);h.storage[DIALOGS_KEY].traversal['1688'].pending=null;h.replies.get(1).conversations=[];await poll(h);
  assert.deepEqual(opening(h).map(row=>row.conversationId),['1688-supplier-120','alibaba-supplier-120']);
  const state=(await h.command('GET')).state;assert.ok(Object.keys(state.conversations).length<=100);assert.ok(state.conversations[conversationKey('alibaba','alibaba-supplier-120')]);assert.equal(h.fetches,0);
});
test('workflow24h native history boundary is applied only to the requested exact frame and document',async()=>{
  for(const invalid of ['', 'platform', 'url', 'frame']){
    const h=harness();await workflowReady(h);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});h.replies.get(2).historyEvidenceToken='history-token';
    const executed=[];h.api.scripting={executeScript:async args=>{executed.push(args);return [{frameId:invalid==='frame'?7:0,result:{status:'ready',platform:invalid==='platform'?'mic':'alibaba',url:invalid==='url'?urls.mic:urls.alibaba,startKnown:true}}];}};
    const native=h.api.tabs.sendMessage;h.api.tabs.sendMessage=(id,message,options)=>message.type==='DIALOGS_APPLY_HISTORY_EVIDENCE'?(h.calls.push({id,...message,frameId:options.frameId}),Promise.resolve({ok:true})):native(id,message,options);
    await h.command('SCAN',{platform:'alibaba'});assert.equal(executed.length,1);assert.deepEqual(executed[0].files,['history-model-evidence.js']);assert.equal(executed[0].world,'MAIN');
    const applied=h.calls.filter(call=>call.type==='DIALOGS_APPLY_HISTORY_EVIDENCE');assert.equal(applied.length,invalid?0:1);if(!invalid){assert.equal(applied[0].historyEvidenceToken,'history-token');assert.equal(applied[0].documentToken,'doc-1');}
  }
});
function manualReviewHarness({deferOnce=false,edited=false}={}){
  const previews=[],sends=[],cleaned=[];let h;
  h=harness({reserveDialogSendQuota:async()=>({ok:true}),testCleaner:async({token})=>{cleaned.push(token);return {cleared:!edited};},folderSender:async args=>{
    if(args.dryRun){const token={operation:args.previewOperation,platform:args.state.conversations[args.request.key].platform,id:args.state.conversations[args.request.key].id,documentToken:args.source.documentToken,sourceUrl:args.source.sourceUrl,text:args.text};assert.equal((await args.reservePreview({attemptId:args.previewOperation,cleanupToken:token})).ok,true);previews.push(args.text);return {status:'previewed'};}
    if(deferOnce){deferOnce=false;return {status:'deferred',reserved:false,clicked:false,retryAt:h.time+60000};}
    assert.equal((await args.reserve({attemptId:crypto.randomUUID(),platform:args.state.conversations[args.request.key].platform,key:args.request.key,request:args.request,source:args.source,text:args.text})).ok,true);sends.push(args.text);return {status:'attempted'};
  }});return {h,previews,sends,cleaned};
}
test('workflow24h manual mode fills the composer once and holds all traversal until a decision',async()=>{
  const {h,previews,sends}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done('Prepared reply.');await poll(h);
  const review=await h.command('GET');assert.equal(review.folder.review.phase,'prepared');assert.equal(review.folder.review.text,'Prepared reply.');assert.deepEqual(previews,['Prepared reply.']);assert.deepEqual(sends,[]);
  h.replies.get(1).conversations.push(workflowInactive(h,'another'));const calls=h.calls.length;await poll(h);assert.equal(h.calls.length,calls);assert.equal(opening(h).length,0);assert.equal(host.jobs.size,1);
  await h.command('FOLDER_SETTINGS',{autoSend:true});await poll(h);assert.equal((await h.command('GET')).folder.review.phase,'prepared');assert.deepEqual(sends,[],'auto toggle cannot approve a prepared manual response');
});
test('workflow24h manual confirmation clears only the owned preview then sends reviewed edits once',async()=>{
  const {h,previews,sends,cleaned}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done('Original proposal.');await poll(h);const review=(await h.command('GET')).folder.review;
  const sent=await h.command('REVIEW_SEND',{operationId:review.operationId,context:review.context,request:review.request,text:'Reviewed reply.'});assert.equal(sent.ok,true,sent.error);assert.equal(sent.send.status,'attempted');assert.deepEqual(previews,['Original proposal.']);assert.deepEqual(cleaned.map(token=>token.text),['Original proposal.']);assert.deepEqual(sends,['Reviewed reply.']);assert.equal(sent.folder.review.phase,'none');
  assert.equal((await h.command('REVIEW_SEND',{operationId:review.operationId})).ok,false);assert.equal(sends.length,1);
});
test('workflow24h manual skip clears preview and skips only that incoming context',async()=>{
  const {h,sends,cleaned}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done();await poll(h);const review=(await h.command('GET')).folder.review;
  const skipped=await h.command('REVIEW_SKIP',{operationId:review.operationId});assert.equal(skipped.ok,true,skipped.error);assert.equal(skipped.folder.review.phase,'none');assert.equal(skipped.folder.reviewSkippedCount,1);assert.equal(cleaned.length,1);assert.deepEqual(sends,[]);
  await poll(h);assert.equal(host.jobs.size,1);h.replies.get(1).conversations[0].messages.push({id:'new-inbound',direction:'inbound',text:'Do you also need the diesel model?'});await poll(h);assert.equal(host.jobs.size,2);
});
test('workflow24h pause retains manual review and refuses confirmation while paused',async()=>{
  const {h,sends}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done();await poll(h);const review=(await h.command('GET')).folder.review;
  const paused=await h.command('STOP');assert.equal(paused.folder.review.operationId,review.operationId);assert.equal(paused.folder.review.phase,'prepared');assert.equal((await h.command('REVIEW_SEND',{operationId:review.operationId})).ok,false);assert.deepEqual(sends,[]);
  await h.command('START');assert.equal((await h.command('GET')).folder.review.phase,'prepared');
});
test('workflow24h test skip clears its preview without simulated sending or real sending',async()=>{
  const {h,previews,cleanups}=previewHarness(),host=await workflowReady(h,{folder:true,testMode:true});let current=await h.command('GET');await h.command('TEST_NEXT',testTokens(current));await poll(h);host.done();await poll(h);current=await h.command('GET');
  const skipped=await h.command('TEST_SKIP',testTokens(current));assert.equal(skipped.ok,true,skipped.error);assert.equal(skipped.folder.test.phase,'ready');assert.equal(skipped.folder.reviewSkippedCount,1);assert.equal(h.storage.openlinksClaudeFolder.test.history.length,0);assert.equal(previews.length,1);assert.equal(cleanups.length,1);await poll(h);assert.equal(host.jobs.size,1);
});
test('workflow24h quota deferral restores a fresh owned preview and requires another explicit confirmation',async()=>{
  const {h,previews,sends,cleaned}=manualReviewHarness({deferOnce:true}),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done();await poll(h);const first=(await h.command('GET')).folder.review;
  const deferred=await h.command('REVIEW_SEND',{operationId:first.operationId,text:'Reviewed waiting reply.'});assert.equal(deferred.ok,true,deferred.error);assert.equal(deferred.send.status,'deferred');assert.equal(deferred.folder.review.phase,'prepared');assert.notEqual(deferred.folder.review.operationId,first.operationId);assert.equal(deferred.folder.review.text,'Reviewed waiting reply.');assert.equal(previews.length,2);assert.equal(cleaned.length,1);assert.deepEqual(sends,[]);
  await poll(h);assert.deepEqual(sends,[]);assert.equal((await h.command('REVIEW_SEND',{operationId:deferred.folder.review.operationId})).send.status,'attempted');assert.deepEqual(sends,['Reviewed waiting reply.']);
});
test('workflow24h skip refuses a changed marketplace draft and preserves its review ownership proof',async()=>{
  const {h,sends}=manualReviewHarness({edited:true}),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done();await poll(h);const review=(await h.command('GET')).folder.review;
  const result=await h.command('REVIEW_SKIP',{operationId:review.operationId});assert.equal(result.ok,false);const kept=await h.command('GET');assert.equal(kept.folder.review.operationId,review.operationId);assert.ok(h.storage.openlinksClaudeFolder.review.cleanupToken);assert.equal(kept.folder.reviewSkippedCount,0);assert.deepEqual(sends,[]);
});
test('workflow24h immediate confirmation waits for the reader input cooldown without overriding user activity',async()=>{
  const {h,sends}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done();await poll(h);const review=(await h.command('GET')).folder.review,native=h.api.tabs.sendMessage;let snapshots=0;
  h.api.tabs.sendMessage=async(id,message,options)=>{const result=await native(id,message,options);if(message.type==='DIALOGS_SNAPSHOT'){snapshots++;if(snapshots===1)result.busy={recentUserInput:true};}return result;};
  const sent=await h.command('REVIEW_SEND',{operationId:review.operationId});assert.equal(sent.ok,true,sent.error);assert.equal(sent.send.status,'attempted');assert.ok(snapshots>=3);assert.equal(sends.length,1);
});
test('workflow24h immediate approval accepts the exact review contract returned by folder polling',async()=>{
  const {h,sends}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done('Approve this exact draft.');
  const polled=await h.command('FOLDER_POLL');assert.equal(polled.ok,true,polled.error);const review=polled.folder.review;assert.equal(review.phase,'prepared');assert.equal(Object.hasOwn(review.request,'imageKeys'),false);
  const approved=await h.command('REVIEW_SEND',{operationId:review.operationId,context:review.context,request:review.request,text:review.text});assert.equal(approved.ok,true,approved.error);assert.equal(approved.send.status,'attempted');assert.deepEqual(sends,['Approve this exact draft.']);
});
async function bindWorkflowPlatforms(h){
  const row=structuredClone(h.replies.get(1).conversations[0]);
  for(const [name,tabId] of [['alibaba',2],['mic',3]]){await h.command('BIND_TAB',{platform:name,tabId});h.replies.get(tabId).conversations=[structuredClone(row)];}
}
test('test platform selection skips the 1688 backlog and strictly reads and prepares only the selected marketplace',async()=>{
  const {h,previews,cleanups}=previewHarness(),host=await workflowReady(h,{folder:true,testMode:true});await bindWorkflowPlatforms(h);h.replies.get(1).conversations.push(...Array.from({length:30},(_,i)=>workflowInactive(h,'backlog-'+i)));
  const current=await h.command('GET'),switched=await h.command('TEST_PLATFORM',{...testTokens(current),platform:'mic'});assert.equal(switched.ok,true,switched.error);assert.equal(switched.folder.test.platform,'mic');assert.equal(switched.folder.test.phase,'ready');assert.deepEqual(h.tabUpdates.filter(update=>update.active===true).map(update=>update.id),[3]);
  const before=h.calls.length;await poll(h);assert.equal(host.jobs.size,1);assert.equal(host.first.request.key,conversationKey('mic','supplier-1'));assert.ok(h.calls.slice(before).every(call=>call.id===3));assert.equal(h.storage.openlinksClaudeFolder.test.completed.length,0);
  host.done('Made-in-China preview.');await poll(h);const finished=await h.command('GET');assert.equal(finished.folder.test.phase,'completed');const second=await h.command('TEST_PLATFORM',{...testTokens(finished),platform:'alibaba'});assert.equal(second.ok,true,second.error);assert.equal(cleanups.length,1);assert.equal(second.folder.test.platform,'alibaba');assert.deepEqual(h.storage.openlinksClaudeFolder.test.history.map(item=>item.key),[conversationKey('mic','supplier-1')]);
  const switchedCalls=h.calls.length;await poll(h);assert.equal(host.jobs.size,2);assert.equal([...host.jobs.values()][1].request.key,conversationKey('alibaba','supplier-1'));assert.ok(h.calls.slice(switchedCalls).every(call=>call.id===2));assert.equal(previews.length,1,'changing platforms never sends or fills another reply before Claude finishes');
});
test('test platform can change while waiting for a candidate and rejects direct work on another marketplace',async()=>{
  const {h}=previewHarness(),host=await workflowReady(h,{folder:true,testMode:true});await bindWorkflowPlatforms(h);
  let current=await h.command('GET');current=await h.command('TEST_PLATFORM',{...testTokens(current),platform:'mic'});current=await h.command('TEST_PLATFORM',{...testTokens(current),platform:'alibaba'});assert.equal(current.ok,true,current.error);assert.equal(current.folder.test.platform,'alibaba');
  const wrong=await h.command('FOLDER_DRAFT',{key});assert.equal(wrong.ok,false);assert.match(wrong.error,/другая площадка/);assert.equal(host.jobs.size,0);const wrongSend=await h.command('SEND_DRAFT',{key,testMode:true,testSessionId:current.folder.test.sessionId,testCycleId:current.folder.test.cycleId});assert.equal(wrongSend.ok,false);assert.match(wrongSend.error,/другая площадка/);
  await poll(h);assert.equal(host.first.request.key,conversationKey('alibaba','supplier-1'));assert.equal(h.storage.openlinksClaudeFolder.test.history.length,0);
});
test('test platform switch refuses an in-flight Claude job without cancelling or duplicating it',async()=>{
  const {h}=previewHarness(),host=await workflowReady(h,{folder:true,testMode:true});await bindWorkflowPlatforms(h);const initial=await h.command('GET');await h.command('TEST_NEXT',testTokens(initial));await poll(h);const generating=await h.command('GET');
  const result=await h.command('TEST_PLATFORM',{...testTokens(generating),platform:'mic'});assert.equal(result.ok,false);assert.equal((await h.command('GET')).folder.test.platform,'all');assert.equal(host.jobs.size,1);assert.equal(host.calls.some(call=>call.action==='cancel'),false);
  host.done();await poll(h);assert.equal((await h.command('GET')).folder.test.phase,'completed');
});
test('test platform switch preserves a manually changed composer and does not mark the current cycle complete',async()=>{
  const {h}=previewHarness({testCleaner:async()=>({cleared:false}),testRecovery:async()=>({cleared:false})}),host=await workflowReady(h,{folder:true,testMode:true});await bindWorkflowPlatforms(h);let current=await h.command('GET');await h.command('TEST_NEXT',testTokens(current));await poll(h);host.done();await poll(h);current=await h.command('GET');
  const result=await h.command('TEST_PLATFORM',{...testTokens(current),platform:'mic'});assert.equal(result.ok,false);const kept=await h.command('GET');assert.equal(kept.folder.test.platform,'all');assert.equal(kept.folder.test.cycleId,current.folder.test.cycleId);assert.equal(h.storage.openlinksClaudeFolder.test.history.length,0);assert.ok(h.storage.openlinksClaudeFolder.test.cleanupToken);assert.equal(host.jobs.size,1);
});
test('pause during test platform preview cleanup prevents the switch from starting a new cycle',async()=>{
  const entered=deferred(),release=deferred(),{h}=previewHarness({testCleaner:async()=>{entered.resolve();await release.promise;return {cleared:true};}}),host=await workflowReady(h,{folder:true,testMode:true});await bindWorkflowPlatforms(h);let current=await h.command('GET');await h.command('TEST_NEXT',testTokens(current));await poll(h);host.done();await poll(h);current=await h.command('GET');
  const switching=h.command('TEST_PLATFORM',{...testTokens(current),platform:'mic'});await entered.promise;const pausing=h.command('STOP');release.resolve();const switched=await switching,paused=await pausing;assert.equal(switched.ok,false);assert.equal(paused.state.running,false);assert.equal(paused.folder.test.platform,'all');assert.equal(paused.folder.test.cycleId,current.folder.test.cycleId);assert.equal(h.storage.openlinksClaudeFolder.test.history.length,0);assert.equal(h.tabUpdates.some(update=>update.id===3&&update.active),false);
});
test('switching test selection back to all restores normal traversal without completing untouched chats',async()=>{
  const {h}=previewHarness(),host=await workflowReady(h,{folder:true,testMode:true});await bindWorkflowPlatforms(h);let current=await h.command('GET');current=await h.command('TEST_PLATFORM',{...testTokens(current),platform:'mic'});await poll(h);host.done();await poll(h);current=await h.command('GET');const all=await h.command('TEST_PLATFORM',{...testTokens(current),platform:'all'});assert.equal(all.ok,true,all.error);assert.equal(all.folder.test.platform,'all');await poll(h);
  assert.equal([...host.jobs.values()][1].request.key,key);assert.deepEqual(h.storage.openlinksClaudeFolder.test.completed.map(item=>item.key),[conversationKey('mic','supplier-1')]);
});
test('running workflow activates its cold managed MIC launch once without focusing the OS window',async()=>{
  const h=harness();await workflowReady(h);await h.command('SETTINGS',{settings:{showWorkingTab:true}});const opened=await h.command('OPEN_CHATS',{platform:'mic'}),id=opened.state.bindings.mic.tabId;h.tabs.get(id).url=CHAT_CENTERS.mic;h.tabs.get(id).status='loading';h.storage[DIALOGS_KEY].workflow.cursor=2;
  await h.command('START');await poll(h);assert.deepEqual(h.tabUpdates.filter(update=>update.active===true).map(update=>update.id),[id]);assert.equal(h.windowUpdates.length,0);const state=(await h.command('GET')).state;assert.equal(state.bindings.mic.status,'loading');assert.equal(state.workflow.cursor,2);
  await poll(h);assert.equal(h.tabUpdates.filter(update=>update.id===id&&update.active).length,1);
});
test('cold managed chat stays inactive for read-only scanning and when working-tab activation is disabled',async()=>{
  for(const disabled of [false,true]){
    const h=harness();await workflowReady(h);await h.command('SETTINGS',{settings:{showWorkingTab:!disabled}});const opened=await h.command('OPEN_CHATS',{platform:'mic'}),id=opened.state.bindings.mic.tabId;h.tabs.get(id).url=CHAT_CENTERS.mic;h.tabs.get(id).status='loading';h.storage[DIALOGS_KEY].workflow.cursor=2;
    if(disabled){await h.command('START');await poll(h);}else await h.command('SCAN',{platform:'mic'});
    assert.equal(h.tabUpdates.some(update=>update.active===true),false);assert.equal(h.windowUpdates.length,0);
  }
});
test('loading activation tolerates a closing tab and never follows a foreign pending URL',async()=>{
  for(const variant of ['closed','foreign']){
    const h=harness();await workflowReady(h);await h.command('SETTINGS',{settings:{showWorkingTab:true}});const opened=await h.command('OPEN_CHATS',{platform:'mic'}),id=opened.state.bindings.mic.tabId;h.tabs.get(id).url=CHAT_CENTERS.mic;h.tabs.get(id).status='loading';h.storage[DIALOGS_KEY].workflow.cursor=2;
    if(variant==='closed'){const original=h.api.tabs.update;h.api.tabs.update=async(tabId,patch)=>{if(tabId===id&&patch.active)throw new Error('No tab');return original(tabId,patch);};}else h.tabs.get(id).pendingUrl='https://example.com/';
    await h.command('START');await poll(h);assert.equal(h.tabUpdates.some(update=>update.id===id&&update.active),false);assert.equal(h.windowUpdates.length,0);
  }
});
test('cold launch activation respects busy readers and outreach coordination',async()=>{
  for(const blocked of ['busy','coordination']){
    const h=harness({getWorkCoordination:async()=>({enabled:blocked==='coordination',allowDialogs:false,phase:'outreach',detail:'Primary queue owns the turn.'})});await workflowReady(h);await h.command('SETTINGS',{settings:{showWorkingTab:true}});const opened=await h.command('OPEN_CHATS',{platform:'mic'}),id=opened.state.bindings.mic.tabId;h.tabs.get(id).url=CHAT_CENTERS.mic;h.tabs.get(id).status='complete';h.replies.set(id,snapshot('mic',{url:CHAT_CENTERS.mic,status:'loading',conversations:[],busy:{focusedEditor:true}}));h.storage[DIALOGS_KEY].workflow.cursor=2;
    await h.command('START');await poll(h);assert.equal(h.tabUpdates.some(update=>update.active),false);assert.equal(h.windowUpdates.length,0);
  }
});

function completeSelectedRead(h) {
  const template=structuredClone(h.replies.get(1).conversations[0]);
  h.openAction=async(message,tabId)=>{
    const rows=h.replies.get(tabId).conversations;for(const row of rows)row.active=false;
    const target=rows.find(row=>row.id===message.conversationId),id=target.id,title=target.title,preview=target.preview;
    Object.assign(target,structuredClone(template),{id,title,preview,active:true});
    target.messages.push({id:'buyer-last-'+id,direction:'outbound',text:'Waiting for your reply.'});
    return {ok:true,openedId:id};
  };
}
test('sticky sweep completes every available 1688 chat before Alibaba and MIC even after sixty seconds',async()=>{
  const h=harness();await workflowReady(h);await bindWorkflowPlatforms(h);completeSelectedRead(h);
  for(const [index,name] of ['1688','alibaba','mic'].entries())h.replies.get(index+1).conversations=[workflowInactive(h,name+'-a'),...(index<2?[workflowInactive(h,name+'-b')]:[])];
  await h.command('START');for(let i=0;i<8&&opening(h).length<5;i++){await poll(h);h.advanceTime(70000);}
  assert.deepEqual(opening(h).map(call=>call.conversationId),['1688-a','1688-b','alibaba-a','alibaba-b','mic-a']);
  assert.equal(h.windowUpdates.length,0);assert.equal(h.fetches,0);
});
test('sticky sweep preserves history, pause and resume on its current marketplace',async()=>{
  const h=harness();await workflowReady(h);await bindWorkflowPlatforms(h);h.storage[DIALOGS_KEY].workflow.cursor=1;
  const row=h.replies.get(2).conversations[0];row.firstBuyerMessageReliable=false;delete row.firstBuyerMessage;
  await h.command('START');await poll(h);assert.equal(h.storage[DIALOGS_KEY].workflow.cursor,1);assert.equal(h.calls.at(-1).id,2);
  const before=h.storage[DIALOGS_KEY].workflow.sweepId;await h.command('STOP');await h.command('START');h.advanceTime(1100);await poll(h);
  assert.equal(h.storage[DIALOGS_KEY].workflow.cursor,1);assert.equal(h.storage[DIALOGS_KEY].workflow.sweepId,before);assert.equal(h.calls.filter(call=>call.type==='DIALOGS_LOAD_HISTORY_START').length,2);
});
test('sticky sweep paginates the current platform through more than64 advancing pages before switching',async()=>{
  const h=harness();await workflowReady(h);await bindWorkflowPlatforms(h);h.replies.get(1).conversations=[];let page=0;
  h.replies.get(1).listCoverage={token:'page-0',progressToken:'page-0',hasMore:true};h.replies.get(2).conversations=[workflowInactive(h,'ali-next')];
  const original=h.api.tabs.sendMessage;h.api.tabs.sendMessage=async(id,message,options)=>{
    if(message.type==='DIALOGS_ADVANCE_LIST'){h.calls.push({id,...message});page++;h.replies.get(1).listCoverage={token:'page-'+page,progressToken:'page-'+page,hasMore:page<66};return {ok:true,advanced:true};}
    return original(id,message,options);
  };
  await h.command('START');for(let i=0;i<66;i++){await poll(h);h.advanceTime(2000);assert.equal(h.storage[DIALOGS_KEY].workflow.cursor,0);assert.equal(opening(h).length,0);}
  await poll(h);assert.equal(page,66);assert.deepEqual(opening(h).map(call=>call.conversationId),['ali-next']);
});
test('sticky sweep bounds a stalled list and cold loading then proceeds to the next available platform',async()=>{
  for(const variant of ['list','loading']){
    const h=harness();await workflowReady(h);await bindWorkflowPlatforms(h);h.replies.get(1).conversations=[];h.replies.get(2).conversations=[workflowInactive(h,'available')];
    if(variant==='list'){h.replies.get(1).listCoverage={token:'stalled',progressToken:'stalled',hasMore:true};const original=h.api.tabs.sendMessage;h.api.tabs.sendMessage=(id,message,options)=>message.type==='DIALOGS_ADVANCE_LIST'?Promise.resolve({ok:true,advanced:false}):original(id,message,options);}
    else h.tabs.get(1).status='loading';
    await h.command('START');await poll(h);assert.equal(opening(h).length,0);
    if(variant==='loading'){h.advanceTime(120001);await poll(h);}else for(let i=0;i<10&&!opening(h).length;i++){h.advanceTime(2000);await poll(h);}
    assert.deepEqual(opening(h).map(call=>call.conversationId),['available']);
  }
});
test('sticky sweep polls an old paid result before advancing past its sole active chat',async()=>{
  const {h,previews}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await bindWorkflowPlatforms(h);await h.command('START');await poll(h);const id=host.first.id;
  h.advanceTime(600001);host.done('The original paid result.');await poll(h);
  const current=await h.command('GET');assert.equal(current.folder.review.phase,'prepared');assert.equal(current.folder.jobs[0].id,id);assert.equal(host.jobs.size,1);assert.equal(previews.length,1);assert.equal(current.state.workflow.cursor,0);
});
test('sticky sweep holds a ready Alibaba job until all remaining1688 chats are processed without resubmitting',async()=>{
  const {h,previews}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await bindWorkflowPlatforms(h);await h.command('SCAN',{platform:'alibaba'});
  const aliKey=conversationKey('alibaba','supplier-1');assert.equal((await h.command('FOLDER_DRAFT',{key:aliKey})).ok,true);const id=host.first.id;host.done('Saved Alibaba result.');
  completeSelectedRead(h);h.replies.get(1).conversations=[workflowInactive(h,'1688-a'),workflowInactive(h,'1688-b')];await h.command('START');
  for(let i=0;i<2;i++){const before=h.calls.length;await poll(h);assert.ok(h.calls.slice(before).every(call=>call.id===1));assert.equal(previews.length,0);}
  await poll(h);assert.deepEqual(opening(h).map(call=>call.conversationId),['1688-a','1688-b']);assert.equal(previews.length,1);assert.equal((await h.command('GET')).folder.review.key,aliKey);assert.equal(host.jobs.size,1);assert.equal(host.first.id,id);
});
test('test next retains the current marketplace while explicit all resets to1688',async()=>{
  const {h}=previewHarness(),host=await workflowReady(h,{folder:true,testMode:true});await bindWorkflowPlatforms(h);h.storage[DIALOGS_KEY].workflow.cursor=1;
  let current=await h.command('GET');await h.command('TEST_NEXT',testTokens(current));await poll(h);assert.equal(host.first.request.key,conversationKey('alibaba','supplier-1'));host.done();await poll(h);
  current=await h.command('GET');assert.equal(current.state.workflow.cursor,1);const next=await h.command('TEST_NEXT',testTokens(current));assert.equal(next.state.workflow.cursor,1);
  const reset=await h.command('TEST_PLATFORM',{...testTokens(next),platform:'all'});assert.equal(reset.state.workflow.cursor,0);assert.ok(reset.state.workflow.sweepId>next.state.workflow.sweepId);
});
test('chat results retain exact test and manual outcomes independently of later eligibility checks',async()=>{
  const {h}=previewHarness(),host=await workflowReady(h,{folder:true,testMode:true});const enabled=await h.command('GET');await h.command('TEST_NEXT',testTokens(enabled));await poll(h);host.done();await poll(h);
  let current=await h.command('GET');assert.equal(current.state.workflow.visits[key].lastResult.status,'test_preview');
  await h.command('TEST_NEXT',testTokens(current));await poll(h);current=await h.command('GET');assert.equal(current.state.workflow.visits[key].lastResult.status,'test_completed');assert.equal(current.state.workflow.visits[key].title,'Supplier');
  h.replies.get(1).conversations[0].messages.at(-1).text='I added buyer-wechat';await poll(h);current=await h.command('GET');assert.equal(current.state.workflow.visits[key].lastResult.status,'completed');
});
test('history retains names and safe URLs for skipped rendered rows outside the transcript cache',async()=>{
  const h=harness();await workflowReady(h);h.replies.get(1).conversations=Array.from({length:150},(_,i)=>workflowInactive(h,'old-'+i,{title:'Old supplier '+i,url:'https://shop'+i+'.1688.com/',latestMessageAt:h.time-86400001}));
  await h.command('START');await poll(h);const visit=(await h.command('GET')).state.workflow.visits[conversationKey('1688','old-149')];assert.equal(visit.title,'Old supplier 149');assert.equal(visit.url,'https://shop149.1688.com/');assert.equal(visit.status,'expired');assert.equal(visit.platform,'1688');
});

test('sticky sweep retries an eligible quota-delayed response before leaving its active platform',async()=>{
  const {h,sends}=manualReviewHarness({deferOnce:true}),host=await workflowReady(h,{folder:true});await bindWorkflowPlatforms(h);await h.command('FOLDER_SETTINGS',{autoSend:true});await h.command('START');await poll(h);host.done('Retry the existing result.');await poll(h);
  assert.equal(h.storage.openlinksClaudeFolder.jobs[0].status,'awaiting_limit');const id=host.first.id;h.advanceTime(70000);await poll(h);
  assert.equal(sends.length,1);assert.equal(host.jobs.size,1);assert.equal(h.storage.openlinksClaudeFolder.jobs[0].id,id);assert.equal(h.storage.openlinksClaudeFolder.jobs[0].status,'sent');assert.equal(h.storage[DIALOGS_KEY].workflow.visits[key].lastResult.status,'attempted');
});
test('a failed explicit manual approval remains a factual result until a newer action or completed WeChat proof',async()=>{
  const {h}=manualReviewHarness({edited:true}),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done();await poll(h);const review=(await h.command('GET')).folder.review;
  const result=await h.command('REVIEW_SEND',{operationId:review.operationId,text:review.text});assert.equal(result.ok,false);assert.equal(h.storage[DIALOGS_KEY].workflow.visits[key].lastResult.status,'failed');
  await poll(h);assert.equal((await h.command('GET')).state.workflow.visits[key].lastResult.status,'failed');
});
test('a pending result with no active chat opens its exact row before waiting for Claude',async()=>{
  const {h,previews}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done('Keep this result.');
  const row=h.replies.get(1).conversations[0];Object.assign(row,{active:false,canSelect:true,selectionToken:'return-to-paid-chat'});
  await poll(h);assert.equal(opening(h).at(-1).conversationId,row.id);assert.equal(previews.length,0);assert.equal(host.jobs.size,1);
  row.active=true;await poll(h);assert.equal(previews.length,1);assert.equal((await h.command('GET')).folder.review.phase,'prepared');
});
test('exhausting MIC starts a fresh1688 sweep while waiting suppliers never block the round',async()=>{
  const h=harness();await workflowReady(h);await bindWorkflowPlatforms(h);completeSelectedRead(h);
  for(const [index,name] of ['1688','alibaba','mic'].entries())h.replies.get(index+1).conversations=[workflowInactive(h,name+'-a'),workflowInactive(h,name+'-b')];
  await h.command('START');for(let i=0;i<6;i++)await poll(h);assert.deepEqual(opening(h).map(call=>call.id),[1,1,2,2,3,3]);
  const before=h.storage[DIALOGS_KEY].workflow.sweepId;await poll(h);assert.equal(h.storage[DIALOGS_KEY].workflow.cursor,0);assert.equal(h.storage[DIALOGS_KEY].workflow.sweepId,before+1);
  await poll(h);assert.equal(opening(h).at(-1).conversationId,'1688-a');
});

test('a stale known manual review records a blocked result without clearing or sending its owned preview',async()=>{
  const {h,cleaned,sends}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done();await poll(h);const review=(await h.command('GET')).folder.review;
  h.advanceTime(86400001);const failed=await h.command('REVIEW_SEND',{operationId:review.operationId,text:review.text});assert.equal(failed.ok,false);assert.equal(cleaned.length,0);assert.equal(sends.length,0);
  const current=await h.command('GET');assert.equal(current.folder.review.phase,'blocked');assert.equal(current.state.workflow.visits[key].lastResult.status,'failed');assert.ok(h.storage.openlinksClaudeFolder.review.cleanupToken);
});

test('limited native coverage is recorded as incomplete rather than an exhausted list before moving on',async()=>{
  for(const coverage of [{token:'limited-token',status:'limited',hasMore:false},{token:'viewport-token',status:'limited',hasMore:false,windowLimited:true},{status:'limited',hasMore:false,windowLimited:true}]){
    const h=harness();await workflowReady(h);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});h.replies.get(1).conversations=[];h.replies.get(1).listCoverage=coverage;h.replies.get(2).conversations=[workflowInactive(h,'next-marketplace')];
    await h.command('START');await poll(h);const result=await h.command('GET'),page=result.state.workflow.list['1688'];
    assert.equal(page.failed,true);assert.equal(page.atEnd,false);assert.deepEqual(opening(h).map(call=>call.conversationId),['next-marketplace']);assert.equal(result.state.workflow.cursor,1);
    const event=result.workflowActivityHistory.find(event=>event.type==='workflow_list_limited'&&event.platform==='1688');assert.ok(event);assert.match(event.detail,/Не удалось завершить чтение списка/);assert.equal(h.calls.some(call=>call.type==='DIALOGS_ADVANCE_LIST'&&call.id===1),false);
  }
});

test('fast workflow drains ready chats in native top-to-bottom order before the next platform',async()=>{
  const h=harness({workflowBatchSize:12});await workflowReady(h);await bindWorkflowPlatforms(h);completeSelectedRead(h);
  for(const [index,name] of ['1688','alibaba','mic'].entries())h.replies.get(index+1).conversations=[workflowInactive(h,name+'-second',{listOrder:1}),workflowInactive(h,name+'-first',{listOrder:0})];
  const started=h.time;await h.command('START');await poll(h);
  assert.deepEqual(opening(h).map(call=>call.conversationId),['1688-first','1688-second','alibaba-first','alibaba-second','mic-first','mic-second']);assert.ok(h.time-started<5000);assert.equal(h.fetches,0);
});
test('native first row wins over a lower active chat and old visit timestamps',async()=>{
  const h=harness({workflowBatchSize:12}),host=await workflowReady(h,{folder:true});const lower=h.replies.get(1).conversations[0];Object.assign(lower,{listOrder:2,canSelect:true,selectionToken:'lower'});const top=workflowInactive(h,'top',{listOrder:0,preview:'Changed top message'}),middle=workflowInactive(h,'middle',{listOrder:1});
  const template=structuredClone(lower);h.replies.get(1).conversations=[lower,middle,top];h.storage[DIALOGS_KEY].workflow.visits[conversationKey('1688','top')]={at:h.time,sweepId:1,preview:'Old message',status:'waiting_supplier'};
  h.openAction=async(message)=>{for(const row of h.replies.get(1).conversations)row.active=false;const row=h.replies.get(1).conversations.find(row=>row.id===message.conversationId);Object.assign(row,template,{id:row.id,title:row.title,listOrder:row.listOrder,preview:row.preview,active:true,needsRead:false});return {ok:true};};
  await h.command('START');await poll(h);assert.equal(opening(h)[0].conversationId,'top');assert.equal(host.first.request.key,conversationKey('1688','top'));assert.equal(host.jobs.size,1);
});
test('a new native sweep returns to confirmed list start before reading a lower active chat',async()=>{
  const h=harness({workflowBatchSize:12});await workflowReady(h);completeSelectedRead(h);const lower=h.replies.get(1).conversations[0];Object.assign(lower,{listOrder:1});h.replies.get(1).listCoverage={token:'bottom',atStart:false,hasMore:false,progressToken:'bottom'};
  const native=h.api.tabs.sendMessage;h.api.tabs.sendMessage=async(id,message,options)=>{if(message.type==='DIALOGS_ADVANCE_LIST'&&message.direction==='start'){h.calls.push({id,...message});h.replies.get(1).listCoverage={token:'top',atStart:true,hasMore:false,progressToken:'top'};h.replies.get(1).conversations.unshift(workflowInactive(h,'top',{listOrder:0}));return {ok:true};}return native(id,message,options);};
  await h.command('START');await poll(h);const actions=h.calls.filter(call=>['DIALOGS_ADVANCE_LIST','DIALOGS_OPEN_CONVERSATION'].includes(call.type));assert.equal(actions[0].direction,'start');assert.equal(actions[1].conversationId,'top');
});
test('an unconfirmed start never grants permission to process bottom rows',async()=>{
  const h=harness({workflowBatchSize:12}),host=await workflowReady(h,{folder:true});h.replies.get(1).listCoverage={token:'bottom',atStart:false,hasMore:false,progressToken:'bottom'};let attempts=0;
  const native=h.api.tabs.sendMessage;h.api.tabs.sendMessage=(id,message,options)=>message.type==='DIALOGS_ADVANCE_LIST'?(attempts++,Promise.resolve({ok:true})):native(id,message,options);
  await h.command('START');await poll(h);assert.equal(attempts,3);assert.equal(host.jobs.size,0);assert.equal(opening(h).length,0);assert.equal(h.storage[DIALOGS_KEY].workflow.list['1688'].failed,true);
});
test('fast selection waits for a cached-first transcript to become stable instead of backing it off',async()=>{
  let h,openedAt;h=harness({workflowBatchSize:12,workflowStepWait:async ms=>{h.advanceTime(ms);if(openedAt&&h.time-openedAt>=1100){const row=h.replies.get(1).conversations[0];row.historyStable=true;row.tailKnown=true;}}});const host=await workflowReady(h,{folder:true});const row=h.replies.get(1).conversations[0];Object.assign(row,{active:false,canSelect:true,selectionToken:'stable-test'});
  h.openAction=async()=>{openedAt=h.time;row.active=true;row.historyStable=false;row.tailKnown=false;return {ok:true};};
  await h.command('START');await poll(h);assert.equal(opening(h).length,1);assert.equal(host.jobs.size,1);assert.equal(h.storage[DIALOGS_KEY].traversal['1688'].backoff[key],undefined);assert.ok(h.time-openedAt>=1100);
});
test('fast history loading delays do not consume real history attempts or skip the recipient',async()=>{
  const h=harness({workflowBatchSize:12}),host=await workflowReady(h,{folder:true});const row=h.replies.get(1).conversations[0],first=structuredClone(row.firstBuyerMessage);delete row.firstBuyerMessage;row.firstBuyerMessageReliable=false;h.storage[DIALOGS_KEY].conversations[key].firstBuyerMessage=null;h.storage[DIALOGS_KEY].conversations[key].firstBuyerMessageReliable=false;
  const start=h.time,native=h.api.tabs.sendMessage;let loads=0;h.api.tabs.sendMessage=async(id,message,options)=>{if(message.type==='DIALOGS_LOAD_HISTORY_START'){loads++;if(h.time-start<4400)return {ok:false,status:'loading',retryAfterMs:1100};row.firstBuyerMessage=first;row.firstBuyerMessageReliable=true;return {ok:true};}return native(id,message,options);};
  await h.command('START');await poll(h);assert.ok(loads>=5);assert.equal(host.jobs.size,1);assert.equal(h.storage[DIALOGS_KEY].traversal['1688'].backoff[key],undefined);assert.equal(opening(h).length,0);
});
test('fast drain respects batch size, joins simultaneous alarms and stops immediately during a delay',async()=>{
  const entered=deferred(),release=deferred();let h,waits=0;h=harness({workflowBatchSize:3,workflowStepWait:async ms=>{h.advanceTime(ms);if(++waits===1){entered.resolve();await release.promise;}}});await workflowReady(h);completeSelectedRead(h);h.replies.get(1).conversations=Array.from({length:8},(_,i)=>workflowInactive(h,'row-'+i,{listOrder:i}));
  await h.command('START');const first=poll(h);await entered.promise;const second=poll(h);const paused=await h.command('STOP');assert.equal(paused.state.running,false);release.resolve();await Promise.all([first,second]);assert.equal(opening(h).length,1);
  await h.command('START');await poll(h);assert.equal(opening(h).length,4,'one drain performs no more than three new row actions');
});
test('fast manual review and test preview hold the exact recipient without another traversal',async()=>{
  for(const testMode of [false,true]){let sends=0;const h=harness({workflowBatchSize:12,folderSender:async args=>{assert.equal(args.dryRun,true);const token={operation:args.previewOperation,platform:'1688',id:'supplier-1',documentToken:args.source.documentToken,sourceUrl:args.source.sourceUrl,text:args.text};await args.reservePreview({attemptId:args.previewOperation,cleanupToken:token});sends++;return {status:'previewed'};}}),host=await workflowReady(h,{folder:true,testMode});h.replies.get(1).conversations.push(workflowInactive(h,'next'));
    if(testMode)await h.command('TEST_NEXT',testTokens(await h.command('GET')));else await h.command('START');await poll(h);host.done();await poll(h);assert.equal(sends,1);assert.equal(opening(h).length,0);const current=await h.command('GET');assert.equal(testMode?current.folder.test.phase:current.folder.review.phase,testMode?'completed':'prepared');await h.command('STOP');
  }
});

test('a permanently unstable active history times out once and moves to the next row during backoff',async()=>{
  const h=harness({workflowBatchSize:12});await workflowReady(h);const row=h.replies.get(1).conversations[0];row.historyStable=false;row.listOrder=0;h.replies.get(1).conversations.push(workflowInactive(h,'next-stable',{listOrder:1}));await h.command('START');await poll(h);
  assert.equal(opening(h).length,0);h.advanceTime(120001);await poll(h);assert.equal(opening(h).at(-1).conversationId,'next-stable');assert.equal(h.storage[DIALOGS_KEY].traversal['1688'].pending.id,'next-stable');assert.ok(h.storage[DIALOGS_KEY].traversal['1688'].backoff[key]>h.time);
});
test('the corrected-order migration restarts1688 once without losing results, drafts or paid jobs',async()=>{
  const h=harness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);const jobId=host.first.id;await h.command('STOP');const saved=h.storage[DIALOGS_KEY];saved.workflow.orderVersion=1;saved.traversal['1688'].backoff[key]=h.time+300000;saved.workflow.cursor=1;saved.workflow.sweepId=7;saved.workflow.list.alibaba={sweepId:7,positioned:true,atEnd:false};saved.workflow.visits[key]={at:h.time,status:'test_completed',lastResult:{status:'test_completed',detail:'Simulated',at:h.time}};
  const migrated=await h.command('GET');assert.equal(migrated.state.workflow.orderVersion,2);assert.equal(migrated.state.workflow.cursor,0);assert.equal(migrated.state.workflow.sweepId,8);assert.deepEqual(migrated.state.workflow.list,{});assert.deepEqual(migrated.state.traversal['1688'].backoff,{});assert.equal(migrated.state.workflow.visits[key].lastResult.status,'test_completed');assert.equal(migrated.folder.jobs[0].id,jobId);assert.equal(migrated.folder.jobs[0].status,'queued');
  h.storage[DIALOGS_KEY].workflow.cursor=2;h.storage[DIALOGS_KEY].traversal['1688'].backoff[key]=h.time+300000;await h.command('START');await h.command('STOP');assert.equal((await h.command('GET')).state.workflow.cursor,2);assert.equal((await h.command('GET')).state.traversal['1688'].backoff[key],h.time+300000);
});

test('START kicks immediately and pause-resume hands off an old delayed drain without waiting for an alarm',async()=>{
  const entered=deferred(),release=deferred(),secondOpened=deferred();let h,waiting=false;h=harness({workflowBatchSize:12,workflowAutoKick:true,workflowStepWait:async ms=>{h.advanceTime(ms);if(!waiting){waiting=true;entered.resolve();await release.promise;}}});await workflowReady(h);completeSelectedRead(h);h.replies.get(1).conversations=[workflowInactive(h,'first',{listOrder:0}),workflowInactive(h,'second',{listOrder:1})];const original=h.api.tabs.sendMessage;
  h.api.tabs.sendMessage=async(id,message,options)=>{const result=await original(id,message,options);if(message.type==='DIALOGS_OPEN_CONVERSATION'&&message.conversationId==='second')secondOpened.resolve();return result;};
  await h.command('START');await entered.promise;assert.equal(opening(h).length,1);await h.command('STOP');await h.command('START');release.resolve();let timer;
  try{await Promise.race([secondOpened.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Immediate resume was lost')),2000);})]);}finally{clearTimeout(timer);await h.command('STOP');}
  assert.deepEqual(opening(h).map(call=>call.conversationId),['first','second']);assert.ok(h.alarms.some(alarm=>alarm.name==='openlinks-dialogs'&&alarm.periodInMinutes===0.5),'a durable alarm remains as a worker-suspension fallback');
});
test('a same-step ready Claude reply continues to the next chat after one guarded automatic attempt',async()=>{
  let attempts=0;const h=harness({workflowBatchSize:12,reserveDialogSendQuota:async()=>({ok:true}),folderSender:async args=>{assert.notEqual(args.dryRun,true);assert.equal((await args.reserve({attemptId:crypto.randomUUID(),platform:'1688',key:args.request.key})).ok,true);attempts++;return {status:'attempted'};}}),host=await workflowReady(h,{folder:true});await h.command('FOLDER_SETTINGS',{autoSend:true});h.replies.get(1).conversations.push(workflowInactive(h,'next'));const native=h.api.runtime.sendNativeMessage;
  h.api.runtime.sendNativeMessage=async(name,message)=>{const result=await native(name,message);if(message.action==='submit')host.done();return result;};
  await h.command('START');await poll(h);assert.equal(attempts,1);assert.equal(host.jobs.size,1);assert.equal(opening(h).at(-1).conversationId,'next');assert.equal(h.storage[DIALOGS_KEY].workflow.visits[key].lastResult.status,'attempted');
});
test('short scheduled continuations drain more than one bounded batch without another Chrome alarm',async()=>{
  const completed=deferred();const h=harness({workflowBatchSize:3,workflowAutoKick:true});await workflowReady(h);completeSelectedRead(h);h.replies.get(1).conversations=Array.from({length:10},(_,index)=>workflowInactive(h,'ordered-'+index,{listOrder:index}));const native=h.api.tabs.sendMessage;
  h.api.tabs.sendMessage=async(id,message,options)=>{const result=await native(id,message,options);if(message.type==='DIALOGS_OPEN_CONVERSATION'&&message.conversationId==='ordered-9')completed.resolve();return result;};
  await h.command('START');let timer;try{await Promise.race([completed.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Bounded drain continuation was lost')),4000);})]);}finally{clearTimeout(timer);await h.command('STOP');}
  assert.deepEqual(opening(h).map(call=>call.conversationId),Array.from({length:10},(_,index)=>'ordered-'+index));
});

test('1688 native inbox evidence refreshes pagination only for its exact requested frame and document',async()=>{
  const h=harness();await workflowReady(h);const snap=h.replies.get(1);snap.conversations[0].messages.push({id:'buyer-last',direction:'outbound',text:'Waiting.'});snap.inboxEvidenceToken='inbox-once';snap.listCoverage={token:'rows-before',atStart:true,hasMore:false};const native=h.api.tabs.sendMessage;let applied=0;
  h.api.scripting={executeScript:async request=>{assert.deepEqual(request.files,['inbox-model-evidence.js']);assert.deepEqual(request.target,{tabId:1,frameIds:[0]});assert.equal(request.world,'MAIN');return [{frameId:0,result:{platform:'1688',url:urls['1688'],status:'ready',schema:'1688-inbox-pagination-v1',hasMore:true,loadedCount:40}}];}};
  h.api.tabs.sendMessage=async(id,message,options)=>{if(message.type==='DIALOGS_APPLY_INBOX_EVIDENCE'){applied++;assert.equal(message.expectedDocumentToken,'doc-1');assert.equal(message.evidenceToken,'inbox-once');assert.equal(options.frameId,0);delete snap.inboxEvidenceToken;snap.listCoverage={token:'rows-native',atStart:true,hasMore:true,loadedCount:40,progressToken:'native-list'};return {ok:true};}if(message.type==='DIALOGS_ADVANCE_LIST'){h.calls.push({id,...message});return {ok:true};}return native(id,message,options);};
  await h.command('START');await poll(h);assert.equal(applied,1);assert.equal(h.calls.find(call=>call.type==='DIALOGS_ADVANCE_LIST').listToken,'rows-native');assert.equal(h.storage[DIALOGS_KEY].workflow.list['1688'].atEnd,false);assert.equal(h.storage[DIALOGS_KEY].workflow.cursor,0);
});
test('native inbox evidence with a foreign URL or changed refreshed document never grants list completion',async()=>{
  for(const mismatch of ['url','document']){const h=harness();await workflowReady(h);const snap=h.replies.get(1);snap.inboxEvidenceToken='inbox-once';const native=h.api.tabs.sendMessage;let applied=0;
    h.api.scripting={executeScript:async()=>[{frameId:0,result:{platform:'1688',url:mismatch==='url'?'https://example.com/':urls['1688'],status:'ready'}}]};
    h.api.tabs.sendMessage=async(id,message,options)=>{if(message.type==='DIALOGS_APPLY_INBOX_EVIDENCE'){applied++;snap.documentToken='changed-document';return {ok:true};}return native(id,message,options);};
    const scanned=await h.command('SCAN',{platform:'1688'});assert.equal(applied,mismatch==='url'?0:1);if(mismatch==='document')assert.equal(scanned.state.bindings['1688'].status,'loading');assert.equal(h.calls.some(call=>call.type==='DIALOGS_ADVANCE_LIST'),false);
  }
});

test('pending native inbox metadata blocks lower-row work until order is confirmed',async()=>{
  let h,start;h=harness({workflowBatchSize:12,workflowStepWait:async ms=>{h.advanceTime(ms);if(h.time-start>=2000)h.replies.get(1).listCoverage={token:'native-ready',atStart:true,hasMore:false,nativePending:false};}});const host=await workflowReady(h,{folder:true});h.replies.get(1).listCoverage={token:'pending',nativePending:true,status:'metadata_pending',hasMore:true,retryAfterMs:1000};start=h.time;
  await h.command('START');await poll(h);assert.equal(host.jobs.size,1);assert.ok(host.first.createdAt-start>=2000);assert.equal(opening(h).length,0);
});
test('limited or permanently loading native metadata cannot trap a platform or infer inbox completion',async()=>{
  for(const variant of ['limited','loading']){const h=harness();await workflowReady(h);await h.command('BIND_TAB',{platform:'alibaba',tabId:2});h.replies.get(2).conversations=[workflowInactive(h,'available')];h.replies.get(1).listCoverage={token:'native-unavailable',nativePending:variant==='limited',loading:variant==='loading',status:variant==='limited'?'limited':'ready',atStart:true,hasMore:true};
    await h.command('START');await poll(h);if(variant==='loading'){assert.equal(opening(h).length,0);h.advanceTime(120001);await poll(h);}
    assert.equal(opening(h).at(-1).conversationId,'available');const page=h.storage[DIALOGS_KEY].workflow.list['1688'];assert.equal(page.failed,true);assert.equal(page.atEnd,false);
  }
});

test('waiting for native metadata activates only its current working tab and never opens rows early',async()=>{
  for(const visible of [true,false]){const h=harness(),host=await workflowReady(h,{folder:true});await h.command('SETTINGS',{settings:{showWorkingTab:visible}});h.replies.get(1).listCoverage={token:'pending',nativePending:true,status:'metadata_pending',hasMore:true};h.replies.get(1).conversations.push(workflowInactive(h,'lower'));
    await h.command('START');await poll(h);await poll(h);assert.deepEqual(h.tabUpdates.filter(update=>update.active).map(update=>update.id),visible?[1]:[]);assert.equal(h.windowUpdates.length,0);assert.equal(opening(h).length,0);assert.equal(host.jobs.size,0);
  }
});
test('an existing paid result stays pending while native inbox position is unconfirmed',async()=>{
  const {h,previews}=manualReviewHarness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);host.done('Keep until list is confirmed.');h.replies.get(1).listCoverage={token:'pending',nativePending:true,status:'metadata_pending',hasMore:true};
  await poll(h);assert.equal(previews.length,0);assert.equal(h.storage.openlinksClaudeFolder.jobs[0].status,'queued');assert.equal(host.jobs.size,1);
  h.replies.get(1).listCoverage={token:'ready',nativePending:false,atStart:true,hasMore:false};await poll(h);assert.equal(previews.length,1);assert.equal(host.jobs.size,1);
});

test('exact-source unsupported inbox evidence consumes the reader failure budget and refreshes its limited state',async()=>{
  const h=harness();await workflowReady(h);const snap=h.replies.get(1);snap.inboxEvidenceToken='unsupported-once';snap.listCoverage={token:'native-pending',nativePending:true,status:'metadata_pending',hasMore:true};let failed=0;const native=h.api.tabs.sendMessage;
  h.api.scripting={executeScript:async()=>[{frameId:0,result:{platform:'1688',url:urls['1688'],status:'unsupported',schema:'1688-inbox-pagination-v1'}}]};
  h.api.tabs.sendMessage=async(id,message,options)=>{if(message.type==='DIALOGS_APPLY_INBOX_EVIDENCE'){failed++;assert.equal(message.expectedDocumentToken,'doc-1');assert.equal(message.evidenceToken,'unsupported-once');assert.equal(message.evidence.status,'unsupported');delete snap.inboxEvidenceToken;snap.listCoverage={token:'native-limited',nativePending:true,status:'limited',hasMore:false};return {ok:false,reason:'unsupported'};}return native(id,message,options);};
  await h.command('START');await poll(h);assert.equal(failed,1);assert.equal(h.storage[DIALOGS_KEY].workflow.list['1688'].failed,true);assert.equal(h.storage[DIALOGS_KEY].workflow.list['1688'].atEnd,false);assert.ok(h.storage[DIALOGS_KEY].events.some(event=>event.type==='workflow_list_limited'));
});

async function auditReady(h){
  for(const [index,name] of ['1688','alibaba','mic'].entries())await h.command('BIND_TAB',{platform:name,tabId:index+1});
  await h.command('SETTINGS',{settings:{wechat:'buyer-wechat',wechatAudit:true,workflow24h:true,showWorkingTab:true}});
  for(const [index,name] of ['1688','alibaba','mic'].entries()){
    const snap=h.replies.get(index+1);snap.listCoverage={token:'audit-list-'+name,atStart:true,hasMore:false,complete:true};
    snap.conversations[0]={...snap.conversations[0],listOrder:0,historyStable:true,latestMessageAt:h.time,latestMessageAtReliable:true};
  }
  const native=h.api.tabs.sendMessage;
  h.api.tabs.sendMessage=async(id,message,options)=>{
    if(message.type==='DIALOGS_CHECK_WECHAT'){
      h.calls.push({id,...message});const row=h.replies.get(id).conversations[0];
      const {wechatContactFingerprint}=await import('../extension/lib/wechat-audit.js');
      return {ok:true,status:'not_found',found:false,complete:true,fullHistory:true,conversationId:row.id,documentToken:'doc-1',sourceUrl:urls[['1688','alibaba','mic'][id-1]],identityReliable:true,observedAt:h.time,contactFingerprint:wechatContactFingerprint(message.wechatId),latestMessageAt:h.time,latestMessageAtReliable:true,checkedMessages:2};
    }
    return native(id,message,options);
  };
}
test('audit-only checks all three platforms without product, Claude, editor, or legacy test prerequisites',async()=>{
  let attachments=0,sends=0,nativeCalls=0;const h=harness({attachmentResolver:async()=>{attachments++;},folderSender:async()=>{sends++;throw new Error('audit cannot send');}});await auditReady(h);
  h.api.runtime.sendNativeMessage=async()=>{nativeCalls++;throw new Error('audit cannot contact worker');};
  h.storage.openlinksClaudeFolder=normalizeFolder({enabled:true,auto:true,autoSend:true,test:{enabled:true,phase:'completed'}});
  const before=structuredClone(h.storage.openlinksClaudeFolder);
  assert.equal((await h.command('AUDIT_START')).ok,true);
  for(let i=0;i<20&&h.storage[DIALOGS_KEY].running;i++){await poll(h);h.advanceTime(2000);}
  const state=h.storage[DIALOGS_KEY];assert.equal(state.workflow.audit.phase,'completed');assert.equal(state.workflow.audit.cursor,3);assert.equal(state.running,false);
  assert.equal(Object.keys(state.workflow.audit.records).length,3);assert.ok(Object.values(state.workflow.audit.records).every(row=>row.status==='not_found'));
  assert.deepEqual(h.calls.filter(call=>call.type==='DIALOGS_CHECK_WECHAT').map(call=>call.id),[1,2,3]);
  assert.equal(sends,0);assert.equal(nativeCalls,0);assert.equal(attachments,0);assert.equal(h.fetches,0);assert.deepEqual(h.storage.openlinksClaudeFolder,before);
});
test('audit command boundary rejects old reply and test actions, and paused alarms never poll Claude',async()=>{
  const h=harness();await auditReady(h);let worker=0;h.api.runtime.sendNativeMessage=async()=>{worker++;throw new Error('unexpected worker');};
  for(const command of ['FOLDER_DRAFT','FOLDER_PRODUCT','FOLDER_RETRY','FOLDER_POLL','FOLDER_SETTINGS','TEST_NEXT','TEST_PLATFORM','REVIEW_SEND','SEND_DRAFT','GENERATE_DRAFT','PRODUCT_EXTRACT','JOINT_START'])assert.equal((await h.command(command,{key,enabled:true,autoSend:true})).ok,false,command);
  await h.command('AUDIT_START');await h.command('STOP');const before=h.calls.length;await poll(h);assert.equal(h.calls.length,before);assert.equal(worker,0);
  assert.equal(h.storage[DIALOGS_KEY].workflow.audit.phase,'paused');
});
test('changing audit contact preserves saved product and drafts and cannot resume the old report',async()=>{
  const h=harness();await ready(h);await auditReady(h);await h.command('AUDIT_START');await h.command('STOP');
  const state=h.storage[DIALOGS_KEY];state.conversations[key].draft={text:'User draft',status:'draft'};const product=structuredClone(state.product),draft=structuredClone(state.conversations[key].draft);
  assert.equal((await h.command('SETTINGS',{settings:{wechat:'different-wechat'}})).ok,true);
  assert.deepEqual(h.storage[DIALOGS_KEY].product,product);assert.equal((h.storage[DIALOGS_KEY].conversations[key].draft||h.storage[DIALOGS_KEY].conversations[key].previousDraft).text,draft.text);
  await h.command('START');assert.equal(h.storage[DIALOGS_KEY].running,false);assert.equal(h.storage[DIALOGS_KEY].workflow.audit.phase,'blocked');
});
test('0.21 migration and restart retain legacy folder jobs and keep audit stopped',async()=>{
  const h=harness();await ready(h);h.storage.openlinksClaudeFolder=normalizeFolder({enabled:true,auto:true,autoSend:false});const before=structuredClone(h.storage.openlinksClaudeFolder);
  h.api.runtime.getManifest=()=>({version:'0.21.0'});let worker=0;h.api.runtime.sendNativeMessage=async()=>{worker++;throw new Error('unexpected worker');};
  let response=await h.command('GET');assert.equal(response.state.settings.wechatAudit,true);assert.equal(response.state.running,false);
  await h.monitor.onStartup();await poll(h);response=await h.command('GET');assert.equal(response.state.running,false);assert.equal(response.state.settings.wechatAudit,true);
  assert.deepEqual(h.storage.openlinksClaudeFolder,before);assert.equal(worker,0);
});
test('audit opens separate managed tabs despite a retained legacy preview and preserves its folder state',async()=>{
  const h=harness();await h.command('SETTINGS',{settings:{wechat:'buyer-wechat',wechatAudit:true,workflow24h:true}});
  const folder=normalizeFolder({enabled:true,auto:true,test:{enabled:true,sessionId:crypto.randomUUID(),cycleId:crypto.randomUUID(),phase:'completed',key,jobId:crypto.randomUUID(),text:'Saved unsent preview',source:{tabId:1,frameId:0,documentToken:'doc-1',sourceUrl:urls['1688']}}});
  h.storage.openlinksClaudeFolder=folder;const before=structuredClone(folder);h.storage[DIALOGS_KEY].readUnread=false;
  const result=await h.command('AUDIT_START');assert.equal(result.ok,true);assert.equal(h.tabCreates.length,3);
  assert.equal(h.storage[DIALOGS_KEY].settings.wechatAudit,true);assert.equal(h.storage[DIALOGS_KEY].readUnread,false);
  assert.deepEqual(h.storage.openlinksClaudeFolder,before);assert.equal(h.tabs.get(1).url,urls['1688']);
});
test('audit preserves actual queued Claude work across start, pause and restart without contacting the worker',async()=>{
  const h=harness(),host=await workflowReady(h,{folder:true});await h.command('START');await poll(h);assert.equal(host.jobs.size,1);
  await h.command('STOP');assert.ok(h.storage.openlinksClaudeFolder.jobs.length>0);h.storage[DIALOGS_KEY].settings.wechatAudit=true;
  await auditReady(h);const before=structuredClone(h.storage.openlinksClaudeFolder);let worker=0;
  h.api.runtime.sendNativeMessage=async()=>{worker++;throw new Error('unexpected Claude call');};
  await h.command('AUDIT_START');await poll(h);await h.command('STOP');await poll(h);await h.monitor.onStartup();await poll(h);
  assert.equal(worker,0);assert.deepEqual(h.storage.openlinksClaudeFolder,before);
});

const AUDIT_RUN_A='11111111-1111-4111-8111-111111111111';
const AUDIT_RUN_B='22222222-2222-4222-8222-222222222222';
async function holdAuditCheck(h){
  await auditReady(h);await h.command('AUDIT_START',{runId:AUDIT_RUN_A});await poll(h);
  const entered=deferred(),release=deferred(),native=h.api.tabs.sendMessage;
  h.api.tabs.sendMessage=async(id,message,options)=>{if(message.type==='DIALOGS_CHECK_WECHAT'){entered.resolve();await release.promise;}return native(id,message,options);};
  const flight=poll(h);await entered.promise;return {flight,release:()=>release.resolve()};
}
test('audit protocol validates supplied UUID v4 before cancellation, state changes or tab opening',async()=>{
  const h=harness();const held=await holdAuditCheck(h),before=structuredClone(h.storage[DIALOGS_KEY]);
  for(const runId of ['',undefined,null,123,'not-a-uuid','11111111-1111-3111-8111-111111111111','11111111-1111-4111-1111-111111111111'])assert.equal((await h.command('AUDIT_START',{runId})).ok,false);
  assert.deepEqual(h.storage[DIALOGS_KEY],before);assert.equal(h.tabCreates.length,0);
  held.release();await held.flight;
  assert.equal(Object.keys(h.storage[DIALOGS_KEY].workflow.audit.records).length,1,'invalid start must not cancel a current read');
});
test('audit protocol repeats the same run id without restarting or resuming a paused audit',async()=>{
  let disabled=0;const h=harness({disableJointWork:async()=>{disabled++;}});await auditReady(h);
  let result=await h.command('AUDIT_START',{runId:AUDIT_RUN_A});assert.equal(result.state.workflow.audit.runId,AUDIT_RUN_A);
  await poll(h);await poll(h);await h.command('STOP',{expectedRunId:AUDIT_RUN_A});
  const before=structuredClone(h.storage[DIALOGS_KEY]),calls=h.calls.length,alarms=h.alarms.length,disabledBefore=disabled;
  result=await h.command('AUDIT_START',{runId:AUDIT_RUN_A});assert.equal(result.ok,true);assert.equal(result.auditStartReplayed,true);
  assert.deepEqual(h.storage[DIALOGS_KEY],before);assert.equal(result.state.workflow.audit.phase,'paused');assert.equal(h.calls.length,calls);assert.equal(h.alarms.length,alarms);assert.equal(disabled,disabledBefore);
});
test('audit protocol idempotent START does not cancel an in-flight read',async()=>{
  const h=harness(),held=await holdAuditCheck(h),replayed=h.command('AUDIT_START',{runId:AUDIT_RUN_A});
  await new Promise(resolve=>setImmediate(resolve));held.release();await held.flight;
  assert.equal((await replayed).auditStartReplayed,true);assert.equal(Object.keys(h.storage[DIALOGS_KEY].workflow.audit.records).length,1);assert.equal(h.storage[DIALOGS_KEY].running,true);
});
test('audit protocol foreign conditional STOP does not cancel a read, pause or disable joint work',async()=>{
  let disabled=0;const h=harness({disableJointWork:async()=>{disabled++;}}),held=await holdAuditCheck(h),disabledBefore=disabled;
  const stopped=h.command('STOP',{expectedRunId:AUDIT_RUN_B});await new Promise(resolve=>setImmediate(resolve));held.release();await held.flight;
  assert.equal((await stopped).ok,false);assert.equal(disabled,disabledBefore);assert.equal(h.storage[DIALOGS_KEY].running,true);assert.equal(h.storage[DIALOGS_KEY].workflow.audit.runId,AUDIT_RUN_A);assert.equal(Object.keys(h.storage[DIALOGS_KEY].workflow.audit.records).length,1);
});
test('audit protocol owned conditional STOP serializes after a bounded read and pauses only that run',async()=>{
  const h=harness(),held=await holdAuditCheck(h),stopped=h.command('STOP',{expectedRunId:AUDIT_RUN_A});
  await new Promise(resolve=>setImmediate(resolve));held.release();await held.flight;
  assert.equal((await stopped).ok,true);assert.equal(h.storage[DIALOGS_KEY].running,false);assert.equal(h.storage[DIALOGS_KEY].workflow.audit.phase,'paused');assert.equal(Object.keys(h.storage[DIALOGS_KEY].workflow.audit.records).length,1);
});
test('audit protocol conditional STOP queued behind an unacknowledged START stops the eventual owned run',async()=>{
  const entered=deferred(),release=deferred();let disabled=0;
  const h=harness({disableJointWork:async()=>{disabled++;if(disabled===1){entered.resolve();await release.promise;}}});await auditReady(h);
  const started=h.command('AUDIT_START',{runId:AUDIT_RUN_A});await entered.promise;
  assert.equal(h.storage[DIALOGS_KEY].workflow.audit.runId,'');
  const stopped=h.command('STOP',{expectedRunId:AUDIT_RUN_A});await new Promise(resolve=>setImmediate(resolve));release.resolve();
  assert.equal((await started).ok,true);assert.equal((await stopped).ok,true);assert.equal(h.storage[DIALOGS_KEY].workflow.audit.runId,AUDIT_RUN_A);assert.equal(h.storage[DIALOGS_KEY].workflow.audit.phase,'paused');assert.equal(h.storage[DIALOGS_KEY].running,false);
});
test('audit protocol rechecks conditional STOP ownership after a queued new START changes the run',async()=>{
  const entered=deferred(),release=deferred();let disabled=0;
  const h=harness({disableJointWork:async()=>{disabled++;if(disabled===2){entered.resolve();await release.promise;}}});await auditReady(h);await h.command('AUDIT_START',{runId:AUDIT_RUN_A});
  const newer=h.command('AUDIT_START',{runId:AUDIT_RUN_B});await entered.promise;
  const oldStop=h.command('STOP',{expectedRunId:AUDIT_RUN_A});await new Promise(resolve=>setImmediate(resolve));release.resolve();
  assert.equal((await newer).ok,true);assert.equal((await oldStop).ok,false);assert.equal(disabled,2);assert.equal(h.storage[DIALOGS_KEY].running,true);assert.equal(h.storage[DIALOGS_KEY].workflow.audit.runId,AUDIT_RUN_B);
});
test('audit protocol rejects malformed conditional STOP identifiers without touching the current run',async()=>{
  const h=harness();await auditReady(h);await h.command('AUDIT_START',{runId:AUDIT_RUN_A});const before=structuredClone(h.storage[DIALOGS_KEY]);
  for(const expectedRunId of ['',undefined,null,123,' '.repeat(3),'x'.repeat(201),'with\nnewline'])assert.equal((await h.command('STOP',{expectedRunId})).ok,false);
  assert.deepEqual(h.storage[DIALOGS_KEY],before);
});
