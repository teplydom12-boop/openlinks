import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialState,WINDOW_MS} from '../extension/lib/core.js';
import {initialDialogs,bindDialogTab} from '../extension/lib/dialogs.js';
import {domReply} from './debugger-harness.js';
import {folderDigest} from '../extension/lib/folder-bridge.js';
const listener=()=>{const list=[];return {list,addListener(fn){list.push(fn);}};};
let stored,clicks,contactClicks,commands,requests,beforeClick,probeKind,sendResult,frameUrl,tabCount,opened,missing,obstacle,prepareOk,lookupPages,fetches,probeRoute,updated,probeKey,listedTabs,frameList,tabReplies,frameProbes,deliveries;
let scheduled,removed,canClose,nativeRequired,debuggerFailure,debuggerCalls,nativeFailure,chatReady;
let afterPrepare,querySendGuard,createdTabs,windowReplies,lastNormalWindow,windowUpdates;
let scriptCalls,scriptReply,preloadCalls,preloadAttach,preloadSession,allTabUpdates;
let nativeContactResult,nativeContactThrow,afterContactMark,contactGestures;
const documentedFrames=()=> (frameList || [{frameId:0,url:frameUrl}]).map(frame=>({...frame,documentId:Object.hasOwn(frame,'documentId')?frame.documentId:'document-'+frame.frameId+'-'+frame.url}));
let extraStorage={};
const metadataFixture=readFileSync(new URL('./fixtures/1688-metadata.html',import.meta.url),'utf8');
globalThis.fetch=async(url,options)=>{fetches.push({url,credentials:options.credentials});const html=lookupPages.get(url);if(html===undefined)throw new Error('No local metadata fixture');return new Response(html,{headers:{'content-type':'text/html'}});};
const runtime={id:'test',onMessage:listener(),onStartup:listener(),onInstalled:listener(),getURL:path=>'chrome-extension://test/'+path};
const alarms={onAlarm:listener(),create:async(name,options)=>{scheduled.push({name,...options});}};
globalThis.chrome={runtime,alarms,storage:{local:{get:async keys=>{
 const all={...extraStorage,openlinksState:stored};
 return structuredClone(keys==null?all:Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,all[key]])));
},set:async data=>{if(Object.hasOwn(data,'openlinksState'))stored=structuredClone(data.openlinksState);for(const [key,value] of Object.entries(data))if(key!=='openlinksState')extraStorage[key]=structuredClone(value);},setAccessLevel:async()=>{}}},
 tabs:{onUpdated:listener(),onCreated:listener(),create:async data=>{opened.push(data.url);createdTabs.push(structuredClone(data));const tab={id:++tabCount,windowId:data.windowId,active:data.active};tabReplies.set(tab.id,tab);return tab;},update:async(id,data)=>{allTabUpdates.push({id,...data});if(data.url)updated.push({id,...data});const tab={id,windowId:10,...tabReplies.get(id),...(Object.hasOwn(data,'active')?{active:data.active}:{})};tabReplies.set(id,tab);return {...tab,url:data.url};},query:async()=>structuredClone(listedTabs.map(tab=>({windowId:10,...tab}))),get:async id=>({id,url:frameUrl,windowId:10,status:'complete',...tabReplies.get(id)}),
 remove:async id=>{removed.push(id);},
 sendMessage:async(tab,data,options)=>{
  if(options.documentId)options={...options,frameId:documentedFrames().find(frame=>frame.documentId===options.documentId)?.frameId};
  deliveries.push({tabId:tab,frameId:options.frameId,documentId:options.documentId,type:data.type,active:tabReplies.get(tab)?.active===true,focused:windowReplies.get(tabReplies.get(tab)?.windowId??10)?.focused===true});
  commands.push(data.type);
  requests.push(structuredClone(data));
  if(data.type==='CHAT_READY')return {ok:chatReady,waiting:!chatReady,reason:'Loading chat'};
  if(data.type==='PROBE')return {engine:frameUrl.includes('1688.com')?undefined:'supplier-chat-v2',kind:probeKind,key:probeKey,chatRoute:probeRoute,obstacle:obstacle?.text,canDismiss:obstacle?.dismiss,dismissKey:obstacle?.key,reason:probeKind==='inquiry'?'Форма запроса, нужен чат':undefined,...frameProbes.get(options.frameId)};
  if(data.type==='PREPARE'){afterPrepare?.();return {ok:prepareOk && !nativeRequired,needsNativeInput:nativeRequired,pageUrl:frameList?.find(frame=>frame.frameId===options.frameId)?.url || frameUrl,reason:prepareOk?undefined:'Редактор изменился'};}
  if(data.type==='NATIVE_INPUT' && nativeFailure?.stage===data.stage)return {ok:false,reason:nativeFailure.reason};
  if(data.type==='NATIVE_INPUT' && data.stage==='done')nativeRequired=false;
  if(data.type==='CAN_CLOSE')return {ok:canClose};
  if(data.type==='SEND'){if(querySendGuard){const guard=await message('OPENLINKS_TEST_SEND_GUARD',{
   scope:'outreach',jobId:data.jobId,attemptId:data.attemptId,expectedUrl:data.expectedUrl,message:data.message
  },{id:'test',tab:{id:tab},frameId:options.frameId,documentId:documentedFrames().find(frame=>frame.frameId===options.frameId)?.documentId,url:(documentedFrames().find(frame=>frame.frameId===options.frameId)?.url || frameUrl).split('#')[0]});if(!guard?.canSend)return {clicked:false,notAttempted:true,reason:'Нет разрешённой попытки отправки'};}beforeClick=structuredClone(stored);if(sendResult&&typeof sendResult==='object'){if(sendResult.clicked===true)clicks++;return structuredClone(sendResult);}clicks++;if(sendResult==='disconnect')throw new Error('Disconnected');if(sendResult==='malformed')return {ok:false};return {clicked:sendResult!==false,accepted:sendResult===true,reason:'Кнопка изменилась'};}
  if(data.type==='CONTACT'){contactClicks++;afterContactMark?.();return {ok:true,key:probeKey,contactToken:'01234567-0123-4567-8901-012345678901',pageUrl:frameList?.find(frame=>frame.frameId===options.frameId)?.url || frameUrl};}
  if(data.type==='DISMISS_CHALLENGE'){if(obstacle?.stuck)return {clicked:true,closed:false};obstacle=null;return {clicked:true,closed:true};}
  return {ok:true};
 }},webNavigation:{onCreatedNavigationTarget:listener(),getAllFrames:async()=>{if(missing)throw new Error('No tab');return documentedFrames();}},scripting:{executeScript:async request=>{scriptCalls.push(request);const frame=documentedFrames().find(frame=>request.target.documentIds.includes(frame.documentId));return [{documentId:frame?.documentId,frameId:frame?.frameId,result:scriptReply?scriptReply(request):{ok:true,urls:[]}}];}},action:{onClicked:listener()},windows:{get:async id=>{if(!windowReplies.has(id))throw new Error('Window closed');return structuredClone(windowReplies.get(id));},getLastFocused:async()=>structuredClone(lastNormalWindow),update:async(id,data)=>{windowUpdates.push({id,...data});windowReplies.set(id,{...windowReplies.get(id),...data});},create:async data=>{windowUpdates.push(data);}}};
await import('../extension/background.js');
chrome.debugger={
 attach:async target=>{preloadSession=preloadAttach;preloadAttach=false;(preloadSession?preloadCalls:debuggerCalls).push({type:'attach',target});if(debuggerFailure&&!preloadSession)throw new Error(debuggerFailure);},
 detach:async target=>{(preloadSession?preloadCalls:debuggerCalls).push({type:'detach',target});preloadSession=false;},
 sendCommand:async(target,method,params)=>{(preloadSession?preloadCalls:debuggerCalls).push({target,method,params});if(method==='DOM.resolveNode')return {object:{objectId:'contact-node'}};if(method==='Runtime.callFunctionOn'){contactGestures.push(params);if(nativeContactThrow)throw new Error('Native contact transport interrupted');return {result:{value:nativeContactResult}};}return method==='Page.addScriptToEvaluateOnNewDocument'?{identifier:'preload'}:domReply(method);},
};
const ui={id:'test',url:'chrome-extension://test/dashboard.html'};
const message=(type,extra={},sender=ui)=>new Promise(resolve=>{
 for(const listen of runtime.onMessage.list)listen({type,...extra},sender,resolve);
});
function assertPermission(reply,expected) {
 const {reasonCode,...status}=reply;assert.deepEqual(status,expected);
 if(!expected.canSend)assert.ok(typeof reasonCode==='string'&&reasonCode.length>0,'Permission refusal must identify its reason');
}
async function tick(){alarms.onAlarm.list[0]({name:'openlinks-tick'});await message('GET');}
function reset(){nativeContactResult={ok:true};nativeContactThrow=false;afterContactMark=null;contactGestures=[];scriptCalls=[];scriptReply=null;preloadCalls=[];preloadAttach=false;preloadSession=false;allTabUpdates=[];createdTabs=[];windowReplies=new Map([[10,{id:10,type:'normal'}]]);lastNormalWindow={id:10,type:'normal'};windowUpdates=[];afterPrepare=null;querySendGuard=false;stored=initialState();extraStorage={};stored.settings.message='Hello';clicks=0;contactClicks=0;commands=[];requests=[];beforeClick=null;probeKind='chat';sendResult=true;frameUrl='https://a.en.alibaba.com/chat';tabCount=0;opened=[];missing=false;obstacle=null;prepareOk=true;lookupPages=new Map();fetches=[];probeRoute=null;updated=[];probeKey='#contact';listedTabs=[];frameList=null;tabReplies=new Map();frameProbes=new Map();deliveries=[];scheduled=[];removed=[];canClose=true;nativeRequired=false;debuggerFailure=null;debuggerCalls=[];nativeFailure=null;chatReady=true;}
async function review(url='https://a.en.alibaba.com/'){await message('IMPORT',{text:url});await message('START');await tick();await tick();}
async function openingTimedOut(){stored.queue[0].chatOpening.at=Date.now()-21000;await tick();}

async function retryDue(){stored.queue.find(j=>j.id===stored.activeId).retryAt=Date.now()-1;await tick();}
// Compatibility fixture for already-persisted manual/automatic interventions.
function legacyUncertain(){stored.queue[0].status='uncertain';stored.activeId=stored.queue[0].id;stored.running=false;}
async function fireClose(token){alarms.onAlarm.list[0]({name:'openlinks-close:'+token});await message('GET');}
test('automatic outreach activates supplier tabs in the window bound at Start, even after focus changes',async()=>{
 reset();windowReplies.set(22,{id:22,type:'normal'});
 await message('IMPORT',{text:'https://a.en.alibaba.com/\nhttps://b.en.made-in-china.com/'});
 await message('START',{}, {...ui,tab:{id:100,windowId:22}});
 assert.equal(stored.queueWindowId,22);
 lastNormalWindow={id:33,type:'normal'};windowReplies.set(33,lastNormalWindow);
 await tick();
 assert.deepEqual(createdTabs,[{url:'https://a.en.alibaba.com/',active:true,windowId:22}]);
 assert.deepEqual(windowUpdates,[{id:22,focused:true}]);
 await message('SKIP',{id:stored.activeId});await tick();
 assert.equal(createdTabs.length,2);
 assert.ok(createdTabs.every(tab=>tab.active===true && tab.windowId===22));
 assert.ok(windowUpdates.every(window=>window.id===22 && window.focused));assert.deepEqual(preloadCalls,[]);
});
test('popup dashboard binds a normal browser window and never creates outreach tabs in its popup',async()=>{
 reset();windowReplies.set(20,{id:20,type:'popup'});
 await message('IMPORT',{text:'https://a.en.alibaba.com/'});
 assert.equal((await message('START',{}, {...ui,tab:{id:100,windowId:20}})).ok,true);
 await tick();assert.equal(createdTabs[0].windowId,10);assert.equal(createdTabs[0].active,true);
 assert.deepEqual(windowUpdates,[{id:10,focused:true}]);
});
test('closing the queue window pauses before spending a visit and never falls back to another window',async()=>{
 reset();await message('IMPORT',{text:'https://a.en.alibaba.com/'});await message('START');
 windowReplies.delete(10);lastNormalWindow={id:33,type:'normal'};windowReplies.set(33,lastNormalWindow);
 await tick();
 assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'pending');
 assert.equal(stored.slots.length,0);assert.equal(createdTabs.length,0);assert.equal(stored.activeId,null);
 assert.match(stored.activity.detail,/Окно очереди закрыто/);
 assert.equal((await message('START')).ok,true);await tick();
 assert.equal(createdTabs[0].windowId,33);assert.equal(createdTabs[0].active,true);
});
test('Start without an available normal browser window does not start or create a window itself',async()=>{
 reset();windowReplies.clear();lastNormalWindow=null;
 await message('IMPORT',{text:'https://a.en.alibaba.com/'});
 const result=await message('START');
 assert.equal(result.ok,false);assert.match(result.error,/обычное окно браузера/);
 assert.equal(stored.running,false);assert.deepEqual(createdTabs,[]);assert.deepEqual(windowUpdates,[]);
});
test('browser restart clears remembered window IDs before a future explicit Start',async()=>{
 reset();stored.queueWindowId=10;
 runtime.onStartup.list[0]();await message('GET');assert.equal(stored.queueWindowId,undefined);
});
test('explicit toolbar opening still focuses the existing interface window',async()=>{
 reset();listedTabs=[{id:101,windowId:77,url:'chrome-extension://test/dashboard.html'}];
 await chrome.action.onClicked.list[0]();
 assert.deepEqual(allTabUpdates,[{id:101,active:true}]);assert.deepEqual(windowUpdates,[{id:77,focused:true}]);
});

test('completed send schedules closure for 10 seconds later without delaying another platform',async t=>{
 reset();await review();await message('IMPORT',{text:'https://b.1688.com/'});await message('APPROVE');await tick();
 const closing=stored.pendingClosures[0],job=stored.queue[0];
 assert.equal(closing.at-job.finishedAt,10000);assert.equal(removed.length,0);
 assert.ok(scheduled.some(alarm=>alarm.name==='openlinks-close:'+closing.token && alarm.when===closing.at));
 await fireClose(closing.token);assert.equal(removed.length,0);
 await tick();assert.equal(stored.activeId,stored.queue[1].id);assert.equal(opened.length,2);
 t.mock.method(Date,'now',()=>closing.at);
 await fireClose(closing.token);assert.deepEqual(removed,[job.tabId]);assert.equal(stored.activeId,stored.queue[1].id);
 await fireClose(closing.token);assert.equal(removed.length,1);assert.equal(clicks,1);
});
test('document timer wakes worker while paused; wrong frame or token cannot close a tab',async t=>{
 reset();await review();await message('APPROVE');await tick();await message('PAUSE');
 const closing=stored.pendingClosures[0],sender={tab:{id:closing.tabId},frameId:closing.frameId,url:closing.pageUrl};
 t.mock.method(Date,'now',()=>closing.at);
 assert.equal((await message('CHAT_CLOSE_DUE',{token:closing.token},{...sender,frameId:99})).ok,false);
 assert.equal((await message('CHAT_CLOSE_DUE',{token:'wrong'},sender)).ok,false);
 assert.equal(removed.length,0);
 await message('CHAT_CLOSE_DUE',{token:closing.token},sender);assert.deepEqual(removed,[closing.tabId]);
});
test('navigation, user edits and reuse by an unfinished task all cancel closure',async t=>{
 for(const reason of ['navigation','user','reuse']) {
  reset();await review();await message('APPROVE');await tick();const closing=stored.pendingClosures[0];
  if(reason==='navigation')tabReplies.set(closing.tabId,{id:closing.tabId,url:'https://a.en.alibaba.com/another'});
  if(reason==='user')canClose=false;
  if(reason==='reuse')stored.queue.push({id:'another',tabId:closing.tabId,status:'review'});
  const mock=t.mock.method(Date,'now',()=>closing.at);
  await fireClose(closing.token);assert.equal(removed.length,0,reason);assert.equal(stored.pendingClosures.length,0);
  assert.ok(stored.events.some(e=>e.type==='chat_close_cancelled'));mock.mock.restore();
 }
});
test('browser restart drops close authority; queue deletion alone preserves scheduled closure',async t=>{
 reset();await review();await message('APPROVE');await tick();let closing=stored.pendingClosures[0];
 await message('REMOVE_JOB',{id:closing.jobId});assert.equal(stored.queue.length,0);
 const mock=t.mock.method(Date,'now',()=>closing.at);await fireClose(closing.token);assert.deepEqual(removed,[closing.tabId]);mock.mock.restore();
 reset();await review();await message('APPROVE');await tick();closing=stored.pendingClosures[0];
 runtime.onStartup.list[0]();await message('GET');assert.equal(stored.pendingClosures.length,0);
 t.mock.method(Date,'now',()=>closing.at);await fireClose(closing.token);assert.equal(removed.length,0);
});
test('draft stays open until explicitly skipped; unknown 1688 click does not auto-close',async()=>{
 reset();await review();assert.equal(stored.pendingClosures?.length || 0,0);
 await message('SKIP',{id:stored.activeId});assert.equal(stored.pendingClosures?.length || 0,0);assert.deepEqual(removed,[1]);
 reset();frameUrl='https://a.1688.com/chat';sendResult='unaccepted';await review('https://a.1688.com/');await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(stored.pendingClosures?.length || 0,0);assert.equal(removed.length,0);
 legacyUncertain();await message('MARK_SENT');assert.equal(stored.pendingClosures.length,1);
});
test('1688 activates the selected frame before reserving send quota and does not repeat keyboard input after approval',async()=>{
 reset();frameUrl='https://a.1688.com/chat';nativeRequired=true;await review('https://a.1688.com/');
 assert.equal(stored.queue[0].status,'review');assert.equal(clicks,0);assert.equal(stored.slots.filter(s=>s.kind==='send').length,0);
 assert.equal(debuggerCalls[0].type,'attach');assert.equal(debuggerCalls.at(-1).type,'detach');
 const inputCalls=debuggerCalls.length;
 assert.deepEqual(requests.filter(r=>r.type==='NATIVE_INPUT').map(r=>r.stage),['locate','focus','space','done','release']);
 await message('APPROVE');await tick();assert.equal(clicks,1);assert.equal(debuggerCalls.length,inputCalls);
});
test('debugger attach failure schedules recovery without clicking, reserving quota or teaching the wrong button',async()=>{
 reset();frameUrl='https://a.1688.com/chat';nativeRequired=true;debuggerFailure='Another debugger is already attached';await review('https://a.1688.com/');
 assert.equal(stored.running,true);assert.equal(stored.queue[0].status,'retry_wait');assert.match(stored.queue[0].reason,/DevTools/);
 assert.equal(clicks,0);assert.equal(stored.learning,null);assert.equal(stored.slots.filter(s=>s.kind==='send').length,0);
 assert.equal(debuggerCalls.length,1);
});
test('changed draft reports the keyboard stage without misleading DevTools advice or a send attempt',async()=>{
 reset();frameUrl='https://a.1688.com/chat';nativeRequired=true;nativeFailure={stage:'space',reason:'Текст изменился при вводе клавиш'};
 await review('https://a.1688.com/');
 assert.equal(stored.running,true);assert.equal(stored.queue[0].status,'retry_wait');
 assert.match(stored.queue[0].reason,/после пробела/);assert.doesNotMatch(stored.queue[0].reason,/DevTools|разрешение debugger/);
 assert.equal(clicks,0);assert.equal(stored.learning,null);assert.equal(stored.slots.filter(s=>s.kind==='send').length,0);
 assert.equal(debuggerCalls.at(-1).type,'detach');assert.ok(!debuggerCalls.some(c=>c.params?.key==='Backspace'));
});
test('embedded chat closure guards both the frame and its containing document',async t=>{
 reset();frameList=[{frameId:0,url:frameUrl},{frameId:6,parentFrameId:0,url:'https://message.alibaba.com/chat'}];
 frameProbes.set(0,{kind:'waiting',opened:true,frames:[{url:frameList[1].url,visible:true}]});
 await review();await message('APPROVE');await tick();const closing=stored.pendingClosures[0];
 assert.equal(closing.frameId,6);
 assert.deepEqual(deliveries.filter(d=>d.type==='ARM_CLOSE').map(d=>d.frameId),[0,6]);
 t.mock.method(Date,'now',()=>closing.at);await fireClose(closing.token);
 assert.deepEqual(deliveries.filter(d=>d.type==='CAN_CLOSE').map(d=>d.frameId),[6,0]);assert.deepEqual(removed,[closing.tabId]);
});
test('manual confirmation after restart cannot authorize closing an unverified old tab ID',async()=>{
 reset();frameUrl='https://a.1688.com/chat';sendResult='unaccepted';await review('https://a.1688.com/');await message('APPROVE');await tick();
 legacyUncertain();runtime.onStartup.list[0]();await message('GET');assert.equal(stored.queue[0].needsTabCheck,true);
 await message('MARK_SENT');assert.equal(stored.queue[0].status,'sent');assert.equal(stored.pendingClosures?.length || 0,0);
});

test('click is persisted before side effect; completion does not wait for success or read receipt',async()=>{
 reset();await review();assert.equal(clicks,0);await message('APPROVE');await tick();
 assert.equal(clicks,1);assert.equal(beforeClick.queue[0].status,'sending');assert.equal(beforeClick.slots.filter(s=>s.kind==='send').length,1);
 assert.equal(stored.queue[0].status,'attempted');assert.equal(stored.activeId,null);assert.equal(stored.running,true);
 assert.ok(!commands.includes('CHECK_SENT'));await tick();assert.equal(clicks,1);
});
test('disconnect completes as unknown attempt and continues next supplier without retrying',async()=>{
 reset();sendResult='disconnect';await review();await message('IMPORT',{text:'https://b.1688.com/'});await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(stored.running,true);await tick();assert.equal(opened.at(-1),'https://b.1688.com/');assert.equal(clicks,1);
});
test('worker recovery after persisted sending never clicks again or checks result',async()=>{
 reset();stored.running=true;stored.activeId='x';stored.queue=[{id:'x',platform:'alibaba',url:frameUrl,status:'sending'}];
 await tick();assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(clicks,0);assert.equal(commands.length,0);
});
test('automatic mode uses built-ins/learned rules and rejects website UI commands',async()=>{
 reset();stored.settings.review=false;await review();assert.equal(stored.queue[0].status,'attempted');assert.equal(clicks,1);
 assert.equal((await message('START',{}, {url:frameUrl,tab:{id:1}})).ok,false);
});
test('pause prevents pending tab opening',async()=>{
 reset();await message('IMPORT',{text:'https://a.en.alibaba.com/'});await message('START');await message('PAUSE');await tick();assert.equal(opened.length,0);
});
test('when no other platform is available the interval wait is logged only once',async()=>{
 reset();stored.slots.push({platform:'alibaba',kind:'visit',at:Date.now()});await message('IMPORT',{text:'https://a.en.alibaba.com/\nhttps://b.en.alibaba.com/'});await message('START');await tick();await tick();
 assert.equal(opened.length,0);assert.equal(stored.waiting.jobId,stored.queue[0].id);assert.equal(stored.events.filter(e=>e.type==='wait').length,1);
});
test('a platform interval yields to another platform, keeps one active supplier and returns in platform order',async t=>{
 const now=2000000;let clock=now;t.mock.method(Date,'now',()=>clock);
 for(const [waiting,first,second,other] of [
   ['1688','https://first.1688.com/','https://second.1688.com/','https://ready.en.alibaba.com/'],
   ['alibaba','https://first.en.alibaba.com/','https://second.en.alibaba.com/','https://ready.1688.com/'],
   ['alibaba','https://first.en.alibaba.com/','https://second.en.alibaba.com/','https://ready.en.made-in-china.com/'],
 ]) {
   reset();clock=now;frameUrl=other;stored.slots=[{platform:waiting,kind:'visit',at:now}];
   await message('IMPORT',{text:[first,second,other].join('\n')});await message('START');await tick();
   assert.deepEqual(opened,[other]);assert.equal(stored.activeId,stored.queue[2].id);
   assert.equal(stored.queue[0].status,'pending');assert.equal(stored.queue[1].status,'pending');assert.equal(stored.waiting,null);
   assert.ok(stored.events.some(event=>event.type==='quota_deferred'&&event.jobId===stored.queue[0].id));
   await tick();await tick();
   assert.equal(stored.queue[2].status,'review');assert.deepEqual(opened,[other]);assert.equal(clicks,0);
   assert.equal(stored.slots.filter(slot=>slot.kind==='visit').length,2);
   await message('SKIP',{id:stored.activeId});frameUrl=first;await tick();
   assert.deepEqual(opened,[other]);assert.equal(stored.waiting.until,now+stored.settings.intervals[waiting]*1000);
   clock=stored.waiting.until;await tick();
   assert.deepEqual(opened,[other,first]);assert.equal(stored.activeId,stored.queue[0].id);
   assert.equal(stored.queue[1].status,'pending');assert.equal(clicks,0);
 }
});
test('a prepared chat waiting on its send interval yields to another platform and later reuses its reservation',async t=>{
 reset();const now=3000000;let clock=now;t.mock.method(Date,'now',()=>clock);
 await review();const first=stored.queue[0];await message('APPROVE');
 stored.slots.push({platform:'alibaba',kind:'send',at:now,jobId:'earlier-supplier'});
 await message('IMPORT',{text:'https://ready.en.made-in-china.com/'});
 await tick();assert.equal(stored.queue[0].status,'deferred_send');assert.equal(stored.queue[0].approved,true);
 assert.equal(stored.activeId,null);assert.equal(stored.waiting,null);assert.equal(clicks,0);
 frameUrl='https://ready.en.made-in-china.com/';await tick();
 assert.equal(stored.activeId,stored.queue[1].id);assert.equal(createdTabs.length,2);
 await message('SKIP',{id:stored.activeId});await tick();assert.equal(stored.waiting.until,now+420000);
 clock=now+420000;frameUrl=first.reviewUrl;await tick();
 assert.equal(stored.activeId,first.id);assert.equal(stored.queue[0].status,'review');assert.equal(stored.queue[0].tabId,first.tabId);
 await tick();assert.equal(clicks,1);assert.equal(stored.queue[0].status,'attempted');assert.equal(createdTabs.length,2);
 assert.equal(stored.slots.filter(slot=>slot.kind==='visit'&&slot.jobId===first.id).length,1);
});
test('importing a ready platform during an interval wait wakes the queue in one second',async t=>{
 reset();const now=2000000;t.mock.method(Date,'now',()=>now);
 stored.slots=[{platform:'alibaba',kind:'visit',at:now}];
 await message('IMPORT',{text:'https://waiting.en.alibaba.com/'});await message('START');await tick();
 assert.equal(stored.waiting.until,now+420000);assert.equal(scheduled.at(-1).when,now+420000);
 const result=await message('IMPORT',{text:'https://ready.en.made-in-china.com/'});
 assert.equal(result.added,1);assert.equal(stored.waiting,null);assert.equal(scheduled.at(-1).name,'openlinks-tick');assert.equal(scheduled.at(-1).when,now+1000);
 await tick();assert.deepEqual(opened,['https://ready.en.made-in-china.com/']);assert.equal(stored.queue[0].status,'pending');assert.equal(clicks,0);
});
test('changing intervals during a wait replaces the old wake time without resetting reservations',async t=>{
 reset();const now=2000000;t.mock.method(Date,'now',()=>now);
 stored.slots=[{platform:'alibaba',kind:'visit',at:now-31000}];
 await message('IMPORT',{text:'https://ready.en.alibaba.com/'});await message('START');await tick();
 assert.equal(stored.waiting.until,now+389000);const reservations=structuredClone(stored.slots);
 const settings=structuredClone(stored.settings);settings.intervals.alibaba=30;
 assert.equal((await message('SETTINGS',{settings})).ok,true);
 assert.equal(stored.waiting,null);assert.deepEqual(stored.slots,reservations);assert.equal(scheduled.at(-1).when,now+1000);
 await tick();assert.deepEqual(opened,['https://ready.en.alibaba.com/']);assert.equal(stored.slots.length,2);assert.equal(clicks,0);
});
test('no chat within the opening deadline schedules a bounded retry without sending',async()=>{
 reset();probeKind='inquiry';await review();await openingTimedOut();assert.equal(stored.running,true);assert.equal(stored.queue[0].status,'retry_wait');assert.equal(stored.queue[0].helpField,'contact');assert.equal(clicks,0);assert.equal(stored.learning,null);
});
test('learning is scoped and persisted before the new opener uses the chosen contact',async()=>{
 reset();probeKind='inquiry';await review();await openingTimedOut();await message('TEACH',{field:'contact'});const token=stored.learning.token;
 const sender={id:'test',url:frameUrl,tab:{id:stored.queue[0].tabId},frameId:0};
 assert.equal((await message('LEARN_PICK',{token:'wrong',field:'contact',selector:'#contact'},sender)).ok,false);
 const reply=await message('LEARN_PICK',{token,field:'contact',selector:'#contact',tag:'button',label:'Chat'},sender);
 assert.equal(reply.ok,true);assert.equal(stored.rules.length,1);assert.equal(stored.learning,null);assert.equal(contactClicks,0);assert.equal(stored.rules[0].engine,'supplier-chat-v2');await tick();assert.ok(commands.includes('OPEN_CHAT'));
 assert.equal((await message('LEARN_PICK',{token,field:'contact',selector:'#contact'},sender)).ok,false);assert.equal(contactClicks,0);
});
test('teaching send reserves quota before the replay and counts it as user approval',async()=>{
 reset();await review();await message('TEACH',{field:'send'});const token=stored.learning.token;
 await message('LEARN_PICK',{token,field:'send',selector:'#send',tag:'button',label:'Send',chatSelector:'#conversation'}, {id:'test',url:frameUrl,tab:{id:stored.queue[0].tabId},frameId:0});
 await tick();assert.equal(stored.rules.length,2);assert.equal(clicks,1);assert.equal(stored.queue[0].status,'attempted');assert.equal(beforeClick.slots.filter(s=>s.kind==='send').length,1);
});
test('refused click schedules a retry without waiting for a server result',async()=>{
 reset();sendResult=false;await review();await message('APPROVE');await tick();assert.equal(stored.queue[0].status,'retry_wait');assert.equal(stored.queue[0].helpField,'send');assert.equal(stored.learning,null);assert.ok(!commands.includes('CHECK_SENT'));
});
test('proven pre-click guard refusal releases only its new reservation and retry does not wait its own 420-second interval',async t=>{
 reset();let now=2000000;t.mock.method(Date,'now',()=>now);await review();
 const jobId=stored.queue[0].id;
 stored.slots.push(
  {platform:'alibaba',kind:'send',at:now-420000,jobId},
  {platform:'alibaba',kind:'send',at:now-500000,jobId:'another-supplier'},
  {platform:'mic',kind:'send',at:now,jobId:'another-platform'},
  {platform:'1688',kind:'visit',at:now,jobId:'preserved-visit'});
 const previousSlots=structuredClone(stored.slots);
 sendResult={clicked:false,notAttempted:true,reason:'Не подтверждена текущая разрешённая попытка отправки'};
 await message('APPROVE');await tick();
 assert.equal(clicks,0);assert.deepEqual(stored.slots,previousSlots);
 assert.equal(stored.queue[0].status,'retry_wait');assert.equal(stored.queue[0].errorCount,1);
 assert.equal(stored.queue[0].attemptId,undefined);assert.equal(stored.queue[0].sendAt,undefined);assert.equal(stored.queue[0].sendDocumentId,undefined);
 const proof=stored.events.find(event=>event.type==='send_not_clicked');
 assert.equal(proof.attemptId,beforeClick.queue[0].attemptId);assert.equal(proof.sendAt,beforeClick.queue[0].sendAt);
 assert.equal(proof.reservationReleased,true);assert.equal(stored.pendingClosures?.length||0,0);
 sendResult=true;now+=10001;await retryDue();
 assert.equal(clicks,1);assert.equal(stored.queue[0].status,'attempted');
 assert.equal(stored.slots.length,previousSlots.length+1);
 assert.deepEqual(stored.slots.slice(0,-1),previousSlots);
 assert.equal(stored.slots.at(-1).at,now);
 assert.ok(!stored.events.some(event=>event.type==='quota_deferred'));
});
test('ambiguous, duplicate, legacy and clicked send results keep their reserved quota',async()=>{
 for(const response of [false,{clicked:false},{clicked:false,notAttempted:false},'malformed','disconnect',{clicked:true,accepted:true,notAttempted:true}]) {
  reset();await review();sendResult=response;await message('APPROVE');await tick();
  const reserved=beforeClick.slots.filter(slot=>slot.kind==='send');
  assert.equal(reserved.length,1,JSON.stringify(response));
  assert.deepEqual(stored.slots.filter(slot=>slot.kind==='send'),reserved,JSON.stringify(response));
  assert.equal(stored.queue[0].attemptId,beforeClick.queue[0].attemptId);
  assert.equal(stored.queue[0].sendAt,beforeClick.queue[0].sendAt);
  assert.ok(!stored.events.some(event=>event.type==='send_not_clicked'));
 }
});
test('composer changing after approval schedules recovery without reserving a send',async()=>{
 reset();await review();prepareOk=false;await message('APPROVE');await tick();assert.equal(clicks,0);assert.equal(stored.queue[0].status,'retry_wait');assert.equal(stored.slots.filter(s=>s.kind==='send').length,0);
});
test('new same-platform iframe receives the active lesson but an unrelated frame does not',async()=>{
 reset();probeKind='inquiry';await review();await openingTimedOut();
 const tabId=stored.queue[0].tabId;await message('TEACH',{field:'editor'});
 await message('PAGE_READY',{}, {id:'test',url:frameUrl,tab:{id:tabId},frameId:3});assert.ok(stored.learning.frameIds.includes(3));
 await message('PAGE_READY',{}, {id:'test',url:'https://other.test/',tab:{id:tabId},frameId:4});assert.ok(!stored.learning.frameIds.includes(4));
});
test('automatic recheck after obstacle resumes storefront contact discovery',async()=>{
 reset();probeKind='contact';obstacle={text:'CAPTCHA',dismiss:false};await review();assert.equal(stored.queue[0].status,'retry_wait');
 obstacle=null;await retryDue();assert.ok(commands.includes('OPEN_CHAT'));assert.equal(contactClicks,0);
});
test('each reappearance of the known 1688 overlay is dismissed, including at review',async()=>{
 reset();frameUrl='https://13153773601.1688.com/';probeKind='contact';obstacle={text:'CAPTCHA',dismiss:true};await review(frameUrl);
 assert.ok(commands.includes('DISMISS_CHALLENGE'));await tick();assert.equal(contactClicks,1);
 obstacle={text:'CAPTCHA',dismiss:true,key:'second'};await tick();assert.equal(commands.filter(c=>c==='DISMISS_CHALLENGE').length,2);
 probeKind='chat';await tick();assert.equal(stored.queue[0].status,'review');
 obstacle={text:'CAPTCHA',dismiss:true,key:'third'};await message('APPROVE');await tick();assert.equal(clicks,0);
 assert.equal(commands.filter(c=>c==='DISMISS_CHALLENGE').length,3);await tick();assert.equal(clicks,1);
});
test('a close control that does not dismiss its overlay schedules bounded recovery without looping clicks',async()=>{
 reset();frameUrl='https://named.1688.com/';obstacle={text:'CAPTCHA',dismiss:true,key:'stuck',stuck:true};
 await review(frameUrl);await tick();await tick();assert.equal(commands.filter(c=>c==='DISMISS_CHALLENGE').length,2);
 assert.equal(stored.running,true);assert.equal(stored.queue[0].status,'retry_wait');assert.equal(clicks,0);
});
test('quota bypass opens one eligible supplier and later resumes the first deferred row',async()=>{
 reset();const now=Date.now();stored.settings.review=false;
 stored.slots=[0,1,2].map(i=>({platform:'alibaba',kind:'visit',at:now-1000+i}));
 await message('IMPORT',{text:'https://a.en.alibaba.com/\nhttps://b.en.alibaba.com/\nhttps://next.1688.com/\nhttps://shop.en.made-in-china.com/'});await message('START');
 await tick();assert.deepEqual(opened,['https://next.1688.com/']);assert.ok(stored.queue[0].quotaDeferredUntil);assert.equal(stored.queue[1].status,'pending');
 frameUrl=opened[0];await tick();assert.equal(clicks,1);await tick();assert.equal(opened[1],'https://shop.en.made-in-china.com/');
 frameUrl=opened[1];await tick();await tick();assert.equal(opened.length,2);assert.equal(stored.waiting.jobId,stored.queue[0].id);
 for(const slot of stored.slots)if(slot.platform==='alibaba')slot.at-=21*60*1000;
 await tick();assert.equal(opened[2],'https://a.en.alibaba.com/');assert.equal(stored.queue[1].status,'pending');
 assert.ok(stored.events.some(e=>e.type==='quota_deferred'));assert.ok(stored.events.some(e=>e.type==='quota_resume'));
});
test('send quota releases active job, processes another platform and resumes existing chat without revisit',async()=>{
 reset();await review();const originalTab=stored.queue[0].tabId,now=Date.now();
 stored.slots.push(...[0,1,2].map(i=>({platform:'alibaba',kind:'send',at:now-1000+i})));
 await message('IMPORT',{text:'https://next.1688.com/'});await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'deferred_send');assert.equal(stored.activeId,null);assert.equal(clicks,0);
 await tick();assert.equal(opened.length,2);assert.equal(opened[1],'https://next.1688.com/');
 await message('SKIP',{id:stored.activeId});
 for(const slot of stored.slots)if(slot.platform==='alibaba')slot.at-=21*60*1000;
 await tick();assert.equal(stored.activeId,stored.queue[0].id);assert.equal(stored.queue[0].tabId,originalTab);assert.equal(opened.length,2);
 await tick();assert.equal(clicks,1);assert.equal(stored.queue[0].status,'attempted');
 assert.equal(stored.slots.filter(s=>s.platform==='alibaba' && s.kind==='visit').length,1);
});
test('restart invalidates the approval and tab binding of a deferred conversation',async()=>{
 reset();await review();stored.queue[0].status='deferred_send';stored.activeId=null;stored.queue[0].approved=true;
 runtime.onStartup.list[0]();await message('GET');
 assert.equal(stored.running,false);assert.equal(stored.queue[0].approved,false);assert.equal(stored.queue[0].needsTabCheck,true);
 await message('START');await tick();assert.equal(stored.queue[0].status,'blocked');assert.equal(clicks,0);
 assert.equal((await message('RECHECK')).ok,false);await message('BIND_TAB',{tabId:1});
 assert.equal(stored.queue[0].needsTabCheck,undefined);await tick();assert.equal(stored.queue[0].status,'review');assert.equal(clicks,0);
});
test('serialized learned variants survive reload and are passed to another named 1688 shop',async()=>{
 reset();frameUrl='https://named.1688.com/';await review(frameUrl);
 for(const selector of ['.send-one','.send-two']) {
   await message('TEACH',{field:'send'});
   const reply=await message('LEARN_PICK',{token:stored.learning.token,field:'send',selector,tag:'button',label:'Send'}, {id:'test',url:frameUrl,tab:{id:stored.queue[0].tabId},frameId:0});assert.equal(reply.ok,true);
 }
 assert.equal(stored.rules.length,2);const saved=JSON.parse(JSON.stringify(stored));
 await message('SKIP',{id:stored.activeId});const history=stored.queue;stored=saved;stored.queue=history;stored.activeId=null;
 await message('IMPORT',{text:'https://another.1688.com/'});stored.slots=[];await message('START');await tick();
 frameUrl='https://another.1688.com/';await tick();
 const rules=requests.findLast(r=>r.type==='PROBE').profile.rules;
 assert.deepEqual(rules.map(rule=>rule.selector),['.send-one','.send-two']);assert.ok(rules.every(rule=>rule.scope.host==='*.shop.1688.com'));
});
test('new lessons never silently trim earlier variants at the old 100-rule threshold',async()=>{
 reset();stored.rules=Array.from({length:105},(_,i)=>globalThis.OpenLinksRules.makeRule({field:'contact',selector:'.template-'+i},frameUrl,'alibaba'));
 const firstId=stored.rules[0].id;await review();await message('TEACH',{field:'contact'});
 const reply=await message('LEARN_PICK',{token:stored.learning.token,field:'contact',selector:'.new-template',tag:'button',label:'Chat'}, {id:'test',url:frameUrl,tab:{id:stored.queue[0].tabId},frameId:0});
 assert.equal(reply.ok,true);assert.equal(stored.rules.length,106);assert.equal(stored.rules[0].id,firstId);
});
test('about:blank popup is adopted after navigation; unrelated tabs are not adopted',async()=>{
 reset();frameUrl='https://13153773601.1688.com/';probeKind='contact';await review(frameUrl);
 chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,pendingUrl:'about:blank'});await message('GET');assert.equal(stored.queue[0].tabId,1);
 frameUrl='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=supplier-a&siteid=cnalichn';
 chrome.tabs.onUpdated.list[0](20,{url:frameUrl},{id:20,url:frameUrl});await message('GET');assert.equal(stored.queue[0].tabId,20);assert.ok(stored.chatRoutes[stored.queue[0].url]);
 chrome.tabs.onUpdated.list[0](21,{url:frameUrl},{id:21,url:frameUrl});await message('GET');assert.equal(stored.queue[0].tabId,20);
});
test('a recommendation storefront popup cannot teach a chat for the active 1688 supplier',async()=>{
 reset();frameUrl='https://first-shop.1688.com/';probeKind='contact';await review(frameUrl);
 chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:'https://different-shop.1688.com/'});await message('GET');
 assert.equal(stored.queue[0].tabId,1);assert.equal(Object.keys(stored.chatRoutes).length,0);
 const chat='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=cnalichnfirst';
 chrome.tabs.onUpdated.list[0](20,{url:chat},{id:20,openerTabId:1,url:chat});await message('GET');assert.equal(stored.queue[0].tabId,1);assert.equal(Object.keys(stored.chatRoutes).length,0);
 chrome.tabs.onCreated.list[0]({id:21,openerTabId:1,url:chat});await message('GET');assert.equal(stored.queue[0].tabId,21);assert.ok(stored.chatRoutes[frameUrl]);
});
test('direct chat cache is keyed to the supplier origin and never another supplier',async()=>{
 reset();const store='https://13153773601.1688.com/';const chat='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=supplier-a';
 stored.chatRoutes[store]={url:chat};await message('IMPORT',{text:store+'page/offer.htm?view=1'});await message('START');await tick();assert.equal(new URL(opened[0]).searchParams.get('touid'),'supplier-a');assert.equal(fetches.length,0);
 reset();stored.chatRoutes[store]={url:chat};await message('IMPORT',{text:'https://999999.1688.com/'});await message('START');await tick();assert.equal(opened[0],'https://999999.1688.com/');
});
test('any unknown store is resolved from metadata and later opens directly without a storefront request',async()=>{
 reset();const store='https://brand-new.1688.com/';lookupPages.set(store,metadataFixture.replaceAll('example-shop.1688.com','brand-new.1688.com'));
 await message('IMPORT',{text:store});await message('START');await tick();
 const chat=new URL(opened[0]);assert.equal(chat.hostname,'air.1688.com');assert.equal(chat.searchParams.get('touid'),'cnalichn示例供应商甲');assert.equal(chat.hash,'#/');
 assert.equal(stored.queue[0].status,'contacting');assert.equal(contactClicks,0);
 assert.equal(fetches.length,1);assert.equal(stored.slots.filter(slot=>slot.kind==='visit').length,1);
 assert.ok(stored.chatRoutes[store]);await message('SKIP',{id:stored.activeId});
 stored=JSON.parse(JSON.stringify(stored));stored.slots[0].at-=181000;
 await message('IMPORT',{text:store+'page/contact.htm?ref=other'});await message('START');await tick();
 assert.equal(opened[1],opened[0]);assert.equal(fetches.length,1);assert.equal(contactClicks,0);
});
test('example store has no special mapping when no observed identity is available',async()=>{
 reset();await message('IMPORT',{text:'https://keyangjixie.1688.com/'});await message('START');await tick();
 assert.equal(opened[0],'https://keyangjixie.1688.com/');assert.ok(stored.events.some(e=>e.type==='chat_lookup_fallback'));
});
test('metadata appearing after storefront load opens and remembers chat without a contact click',async()=>{
 reset();frameUrl='https://example-shop.1688.com/';probeKind='waiting';await message('IMPORT',{text:frameUrl});await message('START');await tick();
 probeRoute=globalThis.OpenLinks1688.fromPage(metadataFixture,frameUrl).url;await tick();
 assert.equal(updated.length,1);assert.equal(updated[0].url,probeRoute);assert.equal(contactClicks,0);assert.ok(stored.chatRoutes[frameUrl]);
});
test('same-tab chat navigation and inner iframe URL both teach general store associations',async()=>{
 reset();const store='https://first.1688.com/';frameUrl=store;probeKind='contact';await review(store);
 const chat='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=cnalichnfirst';
 chrome.tabs.onUpdated.list[0](1,{url:chat},{id:1,url:chat});await message('GET');assert.equal(new URL(stored.chatRoutes[store].url).searchParams.get('touid'),'cnalichnfirst');
 reset();const second='https://second.1688.com/';frameUrl=second;await review(second);
 frameUrl=chat.replace('def_cbu_web_im/','def_cbu_web_im_core/').replace('cnalichnfirst','cnalichnsecond');await tick();
 assert.equal(new URL(stored.chatRoutes[second].url).searchParams.get('touid'),'cnalichnsecond');assert.ok(stored.chatRoutes[second].url.includes('/def_cbu_web_im/'));
});
test('public metadata observed on a manually opened storefront is available to future queue work',async()=>{
 reset();const store='https://example-shop.1688.com/',chat=globalThis.OpenLinks1688.fromPage(metadataFixture,store).url;
 await message('PAGE_READY',{chatRoute:chat},{id:'test',url:store+'page/offer.htm',tab:{id:40},frameId:0});assert.ok(stored.chatRoutes[store]);
 await message('IMPORT',{text:store});await message('START');await tick();assert.equal(opened[0],chat);assert.equal(fetches.length,0);
 await message('FORGET_CHAT_ROUTE',{store});assert.equal(stored.chatRoutes[store],undefined);
});
test('quota wait performs no background supplier lookup or tab opening',async()=>{
 reset();const now=Date.now();stored.slots=Array.from({length:7},(_,i)=>({platform:'1688',kind:'visit',at:now-1000+i}));
 await message('IMPORT',{text:'https://example-shop.1688.com/'});await message('START');await tick();assert.equal(fetches.length,0);assert.equal(opened.length,0);assert.ok(stored.waiting);
});
test('update during sending finalizes an unknown attempt and preserves quota',async()=>{
 reset();stored.running=true;stored.activeId='x';stored.queue=[{id:'x',platform:'alibaba',url:frameUrl,status:'sending'}];stored.slots=[{platform:'alibaba',kind:'send',at:Date.now()}];
 runtime.onInstalled.list[0]({reason:'update'});await message('GET');assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(stored.slots.length,1);assert.equal(stored.activeId,null);assert.equal(stored.running,false);
});

test('1688 ignored click becomes an unknown result and continues without repeating the send',async()=>{
 reset();frameUrl='https://air.1688.com/chat';sendResult='unchanged';await review('https://shop.1688.com/');
 await message('IMPORT',{text:'https://next.en.made-in-china.com/'});await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(stored.activeId,null);assert.equal(stored.running,true);
 for(const type of ['RECHECK','RETRY_SEND'])assert.equal((await message(type)).ok,false);
 await tick();assert.equal(clicks,1);assert.equal(opened.at(-1),'https://next.en.made-in-china.com/');
 assert.equal(stored.slots.filter(s=>s.kind==='send').length,1);
});
test('legacy uncertain send remains manually resolvable and cannot retry an unbound tab after restart',async()=>{
 reset();frameUrl='https://air.1688.com/chat';sendResult='disconnect';await review('https://shop.1688.com/');await message('APPROVE');await tick();legacyUncertain();
 runtime.onStartup.list[0]();await message('GET');assert.equal(stored.queue[0].status,'uncertain');assert.ok(stored.queue[0].needsTabCheck);
 assert.equal((await message('RETRY_SEND')).ok,false);assert.equal((await message('MARK_SENT')).ok,true);
 assert.equal(stored.queue[0].status,'sent');assert.equal(stored.activeId,null);assert.equal(stored.running,true);assert.equal(clicks,1);
});
test('1688 worker recovery records an unknown result without repeating the click',async()=>{
 reset();stored.running=true;stored.activeId='x';stored.queue=[{id:'x',platform:'1688',url:'https://shop.1688.com/',status:'sending'}];
 await tick();assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(stored.activeId,null);assert.equal(stored.running,true);assert.equal(clicks,0);
});
test('Alibaba and MIC start the reference opener without direct URL navigation or a legacy contact click',async()=>{
 for(const url of ['https://a.trustpass.alibaba.com/','https://a.en.made-in-china.com/']) {
  reset();frameUrl=url;probeKind='contact';await review(url);
  assert.ok(commands.includes('OPEN_CHAT'));assert.equal(contactClicks,0);assert.equal(updated.length,0);
  assert.equal(stored.queue[0].chatOpening.attempts,0);assert.equal(stored.queue[0].status,'contacting');
 }
});
test('single-row removal preserves history, quotas and rules and allows reimport of a completed URL',async()=>{
 reset();await review();await message('APPROVE');await tick();
 const old=structuredClone(stored.queue[0]),slots=structuredClone(stored.slots),events=structuredClone(stored.events);
 stored.rules=[{id:'keep'}];assert.equal((await message('REMOVE_JOB',{id:old.id})).ok,true);
 assert.equal(stored.queue.length,0);assert.deepEqual(stored.slots,slots);assert.deepEqual(stored.events.slice(0,-1),events);assert.deepEqual(stored.rules,[{id:'keep'}]);
 const result=await message('IMPORT',{text:old.url});assert.equal(result.added,1);assert.equal(stored.queue[0].status,'pending');assert.notEqual(stored.queue[0].id,old.id);
 await tick();assert.equal(opened.length,1);assert.ok(stored.waiting);
});
test('removing a blocked active row cancels its lesson but not other rows or quota reservations',async()=>{
 reset();probeKind='inquiry';await review();await openingTimedOut();await message('TEACH',{field:'contact'});await message('IMPORT',{text:'https://next.en.made-in-china.com/'});
 const target=stored.activeId,slots=structuredClone(stored.slots);
 assert.equal((await message('REMOVE_JOB',{id:target})).ok,true);assert.equal(stored.activeId,null);assert.equal(stored.learning,null);
 assert.equal(stored.queue.length,1);assert.equal(stored.queue[0].status,'pending');assert.deepEqual(stored.slots,slots);assert.ok(commands.includes('PICK_STOP'));
});
test('sending row cannot be deleted, and deleting an awaited pending row clears its timer display',async()=>{
 reset();stored.queue=[{id:'sending',url:frameUrl,platform:'alibaba',status:'sending'}];stored.activeId='sending';
 assert.equal((await message('REMOVE_JOB',{id:'sending'})).ok,false);assert.equal(stored.queue.length,1);
 reset();stored.slots=[{platform:'alibaba',kind:'visit',at:Date.now()}];await message('IMPORT',{text:'https://a.en.alibaba.com/'});await message('START');await tick();
 assert.ok(stored.waiting);await message('REMOVE_JOB',{id:stored.queue[0].id});assert.equal(stored.waiting,null);assert.equal(stored.queue.length,0);assert.equal(stored.slots.length,1);
});

test('1688 unexpected reply after SEND is unknown and never starts send teaching',async()=>{
 reset();frameUrl='https://air.1688.com/chat';sendResult='malformed';await review('https://shop.1688.com/');await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(stored.running,true);assert.equal(stored.learning,null);assert.equal(clicks,1);
});

const messenger1688='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=cnalichncurrent&siteid=cnalichn';
async function waitingFor1688Contact() {
 reset();frameUrl='https://current.1688.com/';probeKind='waiting';await review(frameUrl);
 stored.queue[0].stepAt=Date.now()-16000;await tick();
 // Simulate an automatic lesson saved by the previous extension version.
 await message('TEACH',{field:'contact'});stored.learning.automatic=true;
 assert.equal(stored.learning.field,'contact');assert.equal(stored.learning.automatic,true);assert.equal(stored.running,false);
}
test('1688 popup automatically ends stale contact teaching and advances to the editor without a contact click',async()=>{
 await waitingFor1688Contact();const token=stored.learning.token;
 chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:messenger1688});await message('GET');
 assert.equal(stored.learning,null);assert.equal(stored.running,true);assert.equal(stored.queue[0].status,'contacting');assert.equal(stored.queue[0].tabId,20);
 assert.ok(deliveries.some(item=>item.type==='PICK_STOP' && item.tabId===1));
 assert.equal((await message('LEARN_PICK',{token,field:'contact',selector:'.go-shop'},{id:'test',url:frameUrl,tab:{id:1},frameId:0})).ok,false);
 frameUrl=messenger1688;probeKind='chat';await tick();
 assert.equal(stored.queue[0].status,'review');assert.equal(stored.learning,null);assert.equal(contactClicks,0);assert.equal(clicks,0);
 assert.equal(stored.slots.filter(slot=>slot.kind==='visit').length,1);assert.equal(stored.slots.filter(slot=>slot.kind==='send').length,0);
});
test('1688 about:blank popup can finish navigation after automatic teaching has started',async()=>{
 await waitingFor1688Contact();
 chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:'about:blank'});await message('GET');assert.equal(stored.learning.field,'contact');
 chrome.tabs.onUpdated.list[0](20,{url:messenger1688},{id:20,url:messenger1688});await message('GET');
 assert.equal(stored.queue[0].tabId,20);assert.equal(stored.queue[0].status,'contacting');assert.equal(stored.learning,null);assert.equal(stored.running,true);
});
test('1688 same-tab messenger and PAGE_READY remove contact teaching without propagating it into the inner frame',async()=>{
 await waitingFor1688Contact();frameUrl=messenger1688;probeKind='waiting';
 chrome.tabs.onUpdated.list[0](1,{url:frameUrl},{id:1,url:frameUrl});await message('GET');
 assert.equal(stored.learning,null);assert.equal(stored.running,true);assert.ok(stored.queue[0].chatOpened);
 await waitingFor1688Contact();
 const core=messenger1688.replace('def_cbu_web_im/','def_cbu_web_im_core/');
 frameList=[{frameId:0,url:frameUrl},{frameId:4,url:core}];frameProbes.set(4,{kind:'chat'});
 const picks=commands.filter(type=>type==='PICK_START').length;
 await message('PAGE_READY',{}, {id:'test',url:core,tab:{id:1},frameId:4});
 assert.equal(stored.learning,null);assert.equal(stored.queue[0].status,'review');assert.equal(stored.queue[0].frameId,4);
 assert.equal(commands.filter(type=>type==='PICK_START').length,picks);assert.equal(contactClicks,0);
});
test('1688 direct chat waits for its editor and never asks for the open-chat button',async()=>{
 reset();const store='https://current.1688.com/';stored.chatRoutes[store]={url:messenger1688};frameUrl=messenger1688;probeKind='waiting';
 await review(store);assert.ok(stored.queue[0].chatOpened);
 stored.queue[0].stepAt=Date.now()-16000;await tick();assert.equal(stored.learning,null);assert.equal(stored.running,true);
 stored.queue[0].stepAt=Date.now()-31000;await tick();assert.equal(stored.queue[0].status,'retry_wait');assert.equal(stored.queue[0].helpField,'editor');
 probeKind='chat';await retryDue();
 assert.equal(stored.learning,null);assert.equal(stored.queue[0].status,'review');assert.equal(contactClicks,0);
});
test('1688 delayed editor can recover on an alarm without another page-load event',async()=>{
 reset();const store='https://current.1688.com/';stored.chatRoutes[store]={url:messenger1688};frameUrl=messenger1688;probeKind='waiting';
 await review(store);stored.queue[0].stepAt=Date.now()-31000;await tick();assert.equal(stored.queue[0].status,'retry_wait');
 probeKind='chat';await retryDue();assert.equal(stored.queue[0].status,'review');assert.equal(stored.learning,null);assert.equal(clicks,0);
});
test('a pre-opened 1688 chat is found before asking for contact teaching even if popup events were missed',async()=>{
 reset();frameUrl='https://current.1688.com/';probeKind='waiting';await review(frameUrl);
 tabReplies.set(1,{id:1,url:frameUrl});listedTabs=[{id:30,openerTabId:1,url:messenger1688}];
 stored.queue[0].stepAt=Date.now()-16000;frameUrl=messenger1688;probeKind='chat';await tick();
 assert.equal(stored.queue[0].tabId,30);assert.equal(stored.queue[0].status,'review');assert.equal(stored.learning,null);assert.ok(!commands.includes('PICK_START'));
});
test('a reused 1688 chat without opener is adopted only with a matching known recipient',async()=>{
 await waitingFor1688Contact();const store=stored.queue[0].url;stored.chatRoutes[store]={url:messenger1688};
 tabReplies.set(1,{id:1,url:store});listedTabs=[{id:30,url:messenger1688},{id:31,url:messenger1688.replace('cnalichncurrent','cnalichnother')}];
 frameUrl=messenger1688;probeKind='chat';await tick();
 assert.equal(stored.queue[0].tabId,30);assert.equal(stored.queue[0].status,'review');assert.equal(stored.learning,null);
});
test('a matching 1688 chat in another browser window is not silently borrowed by the queue',async()=>{
 await waitingFor1688Contact();const store=stored.queue[0].url;stored.chatRoutes[store]={url:messenger1688};
 tabReplies.set(1,{id:1,url:store,windowId:10});listedTabs=[{id:30,windowId:33,url:messenger1688}];
 await tick();assert.equal(stored.queue[0].tabId,1);assert.equal(stored.learning.field,'contact');
 listedTabs.push({id:31,windowId:10,url:messenger1688});frameUrl=messenger1688;probeKind='chat';await tick();
 assert.equal(stored.queue[0].tabId,31);assert.equal(stored.queue[0].status,'review');
 assert.ok(allTabUpdates.some(tab=>tab.id===31&&tab.active));assert.ok(windowUpdates.some(window=>window.id===10&&window.focused));
});
test('an identified marketplace popup becomes active in its own browser window',async()=>{
 await waitingFor1688Contact();windowReplies.set(33,{id:33,type:'popup'});tabReplies.set(30,{id:30,windowId:33,active:false});
 chrome.tabs.onCreated.list[0]({id:30,windowId:33,openerTabId:1,url:messenger1688,active:true});await message('GET');
 assert.equal(stored.queue[0].tabId,30);assert.equal(stored.queue[0].windowId,33);assert.equal(stored.queueWindowId,10);
 assert.ok(windowUpdates.some(window=>window.id===33&&window.focused));assert.ok(allTabUpdates.some(tab=>tab.id===30&&tab.active));
});

test('ambiguous or unrelated 1688 tabs never pick another supplier, including older tasks without supplierTabId',async()=>{
 await waitingFor1688Contact();delete stored.queue[0].supplierTabId;
 listedTabs=[{id:30,url:messenger1688}];await tick();assert.equal(stored.queue[0].tabId,1);assert.equal(stored.learning.field,'contact');
 listedTabs=[{id:30,openerTabId:1,url:messenger1688},{id:31,openerTabId:1,url:messenger1688.replace('cnalichncurrent','cnalichnother')}];
 await tick();assert.equal(stored.queue[0].tabId,1);assert.equal(stored.learning.field,'contact');
 assert.equal(Object.keys(stored.chatRoutes).length,0);assert.equal(contactClicks,0);assert.equal(clicks,0);
});
test('navigation target source identifies a 1688 popup whose tabs event lacks openerTabId',async()=>{
 await waitingFor1688Contact();
 chrome.tabs.onCreated.list[0]({id:30,url:messenger1688});await message('GET');assert.equal(stored.queue[0].tabId,1);
 chrome.webNavigation.onCreatedNavigationTarget.list[0]({tabId:30,sourceTabId:1,url:messenger1688});await message('GET');
 assert.equal(stored.queue[0].tabId,30);assert.equal(stored.running,true);assert.equal(stored.learning,null);
});
test('chat discovery respects a user pause, cancelled lesson, explicit editor lesson and required tab rebinding',async()=>{
 for(const mode of ['pause','cancel','manual-editor','restart']) {
  await waitingFor1688Contact();
  if(mode==='pause')await message('PAUSE');
  if(mode==='cancel')await message('CANCEL_TEACH');
  if(mode==='manual-editor')await message('TEACH',{field:'editor'});
  if(mode==='restart')stored.queue[0].needsTabCheck=true;
  const previous=stored.learning?.token;
  chrome.tabs.onCreated.list[0]({id:30,openerTabId:1,url:messenger1688});await message('GET');
  await tick();assert.equal(stored.running,false);assert.equal(stored.queue[0].tabId,1);assert.equal(stored.learning?.token,previous);assert.equal(clicks,0);
 }
});
test('CAPTCHA blocking and uncertain sends cannot be resumed by a new 1688 chat tab',async()=>{
 for(const status of ['blocked','uncertain','sending']) {
  reset();frameUrl='https://current.1688.com/';probeKind='waiting';await review(frameUrl);
  stored.queue[0].status=status;stored.queue[0].reason='Preserve intervention';stored.running=false;
  chrome.tabs.onCreated.list[0]({id:30,openerTabId:1,url:messenger1688});await message('GET');
  assert.equal(stored.queue[0].status,status);assert.equal(stored.running,false);assert.equal(stored.queue[0].tabId,1);assert.equal(clicks,0);
 }
});

test('an already opened 1688 chat never clicks the learned go-shop action or asks to reopen chat',async()=>{
 reset();const store='https://current.1688.com/';stored.chatRoutes[store]={url:messenger1688};frameUrl=messenger1688;probeKind='contact';probeKey='div.go-shop';
 frameProbes.set(0,{diagnostics:{editors:1,sends:0,chatRoots:0,contacts:1,inquiriesIgnored:0}});
 await review(store);stored.queue[0].stepAt=Date.now()-31000;await tick();
 assert.equal(contactClicks,0);assert.equal(stored.queue[0].helpField,'send');assert.equal(stored.queue[0].status,'retry_wait');assert.ok(stored.queue[0].chatOpened);
});

async function beginSupplierOpening(url='https://shop.en.alibaba.com/') {
 reset();frameUrl=url;probeKind='contact';await review(url);
 assert.ok(stored.queue[0].chatOpening);
}
async function openingEvent(phase,extra={},senderOverride) {
 const job=stored.queue.find(item=>item.id===stored.activeId),opening=job.chatOpening;
 return message('CHAT_OPEN_EVENT',{jobId:job.id,token:opening.token,phase,...extra},senderOverride || {id:'test',url:frameUrl,tab:{id:opening.tabId},frameId:opening.frameId});
}
test('new opener authorizes and persists at most three clicks, five seconds apart, without a send reservation',async()=>{
 for(const url of ['https://shop.en.alibaba.com/','https://shop.en.made-in-china.com/']) {
  await beginSupplierOpening(url);
  assert.equal((await openingEvent('attempt',{attempt:1,selector:'a.chat'})).ok,true);
  assert.equal(stored.queue[0].chatOpening.attempts,1);
  assert.equal((await openingEvent('attempt',{attempt:2})).ok,false);
  for(const attempt of [2,3]) {
   stored.queue[0].chatOpening.lastClick-=5100;
   assert.equal((await openingEvent('attempt',{attempt})).ok,true);
  }
  stored.queue[0].chatOpening.lastClick-=5100;
  assert.equal((await openingEvent('attempt',{attempt:4})).ok,false);
  assert.equal(stored.events.filter(event=>event.type==='chat_open_attempt').length,3);
  assert.equal(stored.slots.filter(slot=>slot.kind==='send').length,0);assert.equal(clicks,0);
 }
});
test('native MIC contact click keeps normal popup handling and adopts the related messenger',async()=>{
 await beginSupplierOpening('https://shop.en.made-in-china.com/');
 assert.equal((await openingEvent('attempt',{attempt:1})).ok,true);
 const contact=requests.find(request=>request.type==='CONTACT');assert.equal(contact.foreground,undefined);assert.equal(contactGestures.length,1);assert.equal(contactGestures[0].userGesture,true);assert.equal(debuggerCalls.at(-1).type,'detach');
 assert.equal(scriptCalls.length,0);assert.equal(preloadCalls.length,0);assert.equal(contactClicks,1);
 const target='https://webim.made-in-china.com/super-tm/#/chat/Fixture_123?data=private-fixture-token&refer='+encodeURIComponent(frameUrl)+'&isLiteTM=true&isSAChat=false';
 chrome.tabs.onCreated.list[0]({id:30,windowId:10,openerTabId:1,url:target});await message('GET');
 assert.equal(stored.queue[0].tabId,30);assert.equal(stored.queue[0].chatOpened,true);
 assert.ok(allTabUpdates.some(tab=>tab.id===30&&tab.active));assert.equal(clicks,0);
});
test('native Alibaba messenger popup is adopted from the storefront instead of rejecting its generic route',async()=>{
 await beginSupplierOpening();assert.equal((await openingEvent('attempt',{attempt:1})).ok,true);
 const target='https://onetalk.alibaba.com/message/weblite.htm';
 chrome.tabs.onCreated.list[0]({id:30,windowId:10,openerTabId:1,url:target});await message('GET');
 assert.equal(stored.queue[0].tabId,30);assert.equal(stored.queue[0].chatOpened,true);
 assert.ok(allTabUpdates.some(tab=>tab.id===30&&tab.active));assert.equal(scriptCalls.length,0);assert.equal(clicks,0);
});
test('inline chat continues in the visible storefront without intercepted popup navigation',async()=>{
 await beginSupplierOpening();assert.equal((await openingEvent('attempt',{attempt:1})).ok,true);probeKind='chat';
 await tick();assert.equal(stored.queue[0].status,'review');assert.equal(stored.queue[0].tabId,1);
 assert.deepEqual(updated,[]);assert.equal(scriptCalls.length,0);assert.equal(clicks,0);
});
test('a delayed native1688 startup popup is adopted without demanding a contact click',async()=>{
 reset();frameUrl='https://shop.1688.com/';probeKind='waiting';await review(frameUrl);
 assert.equal(contactClicks,0);assert.equal(preloadCalls.length,0);
 chrome.tabs.onCreated.list[0]({id:30,windowId:10,openerTabId:1,url:messenger1688});await message('GET');
 assert.equal(stored.queue[0].tabId,30);assert.equal(stored.queue[0].chatOpened,true);
 assert.ok(allTabUpdates.some(tab=>tab.id===30&&tab.active));assert.equal(contactClicks,0);assert.equal(clicks,0);
});
test('pause leaves native page loading intact and resumes the same visible tab without another visit',async()=>{
 reset();await message('IMPORT',{text:frameUrl});await message('START');await tick();
 tabReplies.set(1,{id:1,url:frameUrl,status:'loading',active:true});const slots=structuredClone(stored.slots);
 await message('PAUSE');assert.equal(preloadCalls.length,0);assert.equal(stored.queue[0].resumeBackgroundPage,undefined);
 tabReplies.set(1,{id:1,url:frameUrl,status:'complete',active:false});
 await message('START');await tick();assert.equal(createdTabs.length,1);assert.equal(stored.queue[0].status,'review');
 assert.deepEqual(stored.slots,slots);assert.ok(allTabUpdates.some(tab=>tab.id===1&&tab.active));assert.equal(clicks,0);
});
test('persisted interrupted background navigation resumes visibly in the existing reserved tab',async()=>{
 reset();await message('IMPORT',{text:frameUrl});await message('START');await tick();
 stored.queue[0].resumeBackgroundPage=true;stored.queue[0].contactCaptures=[{tabId:1,documentId:'old'}];
 tabReplies.set(1,{id:1,url:'about:blank',status:'complete',active:false});const slots=structuredClone(stored.slots);
 await tick();assert.deepEqual(updated.at(-1),{id:1,url:frameUrl,active:true});
 assert.deepEqual(stored.slots,slots);assert.equal(createdTabs.length,1);assert.equal(stored.queue[0].resumeBackgroundPage,undefined);
 assert.equal(stored.queue[0].contactCaptures,undefined);assert.equal(preloadCalls.length,0);
 tabReplies.set(1,{id:1,url:frameUrl,status:'complete',active:true});await tick();assert.equal(stored.queue[0].status,'review');assert.equal(clicks,0);
});
test('an old page guard pauses with a reload instruction and never consumes automatic error retries',async()=>{
 await beginSupplierOpening();nativeContactResult={ok:false,reason:'reload_required',reloadRequired:true};
 assert.equal((await openingEvent('attempt',{attempt:1})).ok,false);
 assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'blocked');
 assert.match(stored.queue[0].reason,/Обновите вкладку/);assert.equal(stored.queue[0].errorCount||0,0);
 const count=contactGestures.length;await tick();await tick();assert.equal(contactGestures.length,count);
 assert.ok(!stored.events.some(event=>event.type==='retry_scheduled'));assert.equal(clicks,0);assert.equal(debuggerCalls.at(-1).type,'detach');
});
test('an uncertain contact invocation stops without a blind second click or supplier send',async()=>{
 await beginSupplierOpening();nativeContactThrow=true;
 assert.equal((await openingEvent('attempt',{attempt:1})).ok,false);
 assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'blocked');
 assert.match(stored.queue[0].reason,/Нажатие могло выполниться/);assert.equal(stored.queue[0].errorCount||0,0);
 await tick();assert.equal(contactGestures.length,1);assert.equal(clicks,0);assert.equal(debuggerCalls.at(-1).type,'detach');
});
test('a document replacement after contact marking prevents native contact activation',async()=>{
 await beginSupplierOpening();afterContactMark=()=>{frameList=[{frameId:0,url:frameUrl,documentId:'replacement-document'}];};
 assert.equal((await openingEvent('attempt',{attempt:1})).ok,false);
 assert.equal(contactGestures.length,0);assert.equal(debuggerCalls.length,0);assert.equal(clicks,0);
 assert.equal(stored.queue[0].status,'retry_wait');assert.match(stored.queue[0].reason,/Страница изменилась/);
});
test('opener events require the current job, tab, frame, platform and token',async()=>{
 await beginSupplierOpening();const opening=stored.queue[0].chatOpening;
 for(const sender of [{id:'test',url:frameUrl,tab:{id:99},frameId:0},{id:'test',url:frameUrl,tab:{id:opening.tabId},frameId:4},{id:'test',url:'https://shop.1688.com/',tab:{id:opening.tabId},frameId:0}]) {
  assert.equal((await openingEvent('attempt',{attempt:1},sender)).ok,false);
 }
 assert.equal((await openingEvent('attempt',{attempt:1,token:'expired'})).ok,false);
 assert.equal(stored.queue[0].chatOpening.attempts,0);assert.equal(clicks,0);
});
test('visible opened event stops clicking and prepares a real chat, while loaded hidden frames are ignored',async()=>{
 await beginSupplierOpening();
 const chat='https://onetalk.alibaba.com/message/weblite.htm';
 frameList=[{frameId:0,url:frameUrl},{frameId:4,parentFrameId:0,url:chat}];
 frameProbes.set(0,{kind:'contact',frames:[{url:chat,visible:false}]});frameProbes.set(4,{kind:'chat',opened:true});
 await tick();assert.equal(stored.queue[0].status,'contacting');assert.ok(!commands.includes('PREPARE'));assert.equal(stored.queue[0].chatOpened,undefined);
 frameProbes.set(0,{kind:'waiting',opened:true,frames:[{url:chat,visible:true}]});
 assert.equal((await openingEvent('opened')).ok,true);
 assert.equal(stored.queue[0].status,'review');assert.equal(stored.queue[0].frameId,4);assert.ok(commands.includes('STOP_OPEN_CHAT'));assert.equal(clicks,0);
});
test('nested messenger under a hidden parent cannot prepare or send',async()=>{
 await beginSupplierOpening();const outer='https://onetalk.alibaba.com/message/weblite.htm',inner='https://onetalk.alibaba.com/message/editor.htm';
 frameList=[{frameId:0,url:frameUrl},{frameId:4,parentFrameId:0,url:outer},{frameId:5,parentFrameId:4,url:inner}];
 frameProbes.set(0,{kind:'contact',frames:[{url:outer,visible:false}]});frameProbes.set(4,{kind:'waiting',frames:[{url:inner,visible:true}]});frameProbes.set(5,{kind:'chat',opened:true});
 await tick();assert.ok(!commands.includes('PREPARE'));assert.equal(clicks,0);
});
test('pause, removal and teaching stop the browser opener and reject subsequent clicks',async()=>{
 for(const type of ['PAUSE','REMOVE_JOB','TEACH']) {
  await beginSupplierOpening();const job=structuredClone(stored.queue[0]);
  await message(type,{id:job.id,field:'contact'});assert.ok(commands.includes('STOP_OPEN_CHAT'));
  const reply=await message('CHAT_OPEN_EVENT',{jobId:job.id,token:job.chatOpening.token,phase:'attempt',attempt:1},{id:'test',url:frameUrl,tab:{id:job.tabId},frameId:0});
  assert.equal(reply.ok,false);assert.equal(clicks,0);
 }
});
test('new opener login/captcha schedules recovery and never asks to train the login button',async()=>{
 await beginSupplierOpening();await openingEvent('blocked',{reason:'Нужен вход в аккаунт'});
 assert.equal(stored.running,true);assert.equal(stored.learning,null);assert.equal(stored.queue[0].status,'retry_wait');assert.ok(commands.includes('STOP_OPEN_CHAT'));
});
test('opening deadline schedules retry and a late editor is discovered automatically',async()=>{
 await beginSupplierOpening();await openingTimedOut();assert.equal(stored.queue[0].status,'retry_wait');assert.equal(stored.running,true);
 probeKind='chat';await retryDue();assert.equal(stored.queue[0].status,'review');assert.equal(stored.learning,null);assert.equal(contactClicks,0);
});
test('worker reload preserves an opening cycle attempt budget rather than restarting at zero',async()=>{
 await beginSupplierOpening();await openingEvent('attempt',{attempt:1});
 stored=JSON.parse(JSON.stringify(stored));await tick();const resume=requests.findLast(request=>request.type==='OPEN_CHAT');
 assert.equal(resume.attempts,1);assert.equal(resume.token,stored.queue[0].chatOpening.token);assert.ok(resume.lastClick);
});
test('new popup handling accepts a related messenger and rejects another storefront or a user pause',async()=>{
 for(const url of ['https://shop.en.alibaba.com/','https://shop.en.made-in-china.com/']) {
  await beginSupplierOpening(url);const chat=url.includes('alibaba')?'https://onetalk.alibaba.com/message/weblite.htm':'https://webim.made-in-china.com/super-tm/';
  chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:url.replace('shop.','other.')});await message('GET');assert.equal(stored.queue[0].tabId,1);
  chrome.tabs.onCreated.list[0]({id:21,openerTabId:1,url:chat});await message('GET');assert.equal(stored.queue[0].tabId,21);assert.ok(stored.queue[0].chatOpened);assert.ok(commands.includes('STOP_OPEN_CHAT'));
  await message('PAUSE');chrome.tabs.onCreated.list[0]({id:22,openerTabId:21,url:chat});await message('GET');assert.equal(stored.running,false);assert.equal(stored.queue[0].tabId,21);
 }
});
test('an unrecognized editor loaded after explicit teaching receives the lesson in its new visible frame',async()=>{
 await beginSupplierOpening();frameProbes.set(0,{kind:'waiting',opened:true,frames:[]});await tick();
 stored.queue[0].stepAt=Date.now()-31000;await tick();await message('TEACH',{field:'editor'});assert.equal(stored.learning.field,'editor');
 const chat='https://onetalk.alibaba.com/message/weblite.htm';
 frameList=[{frameId:0,url:frameUrl},{frameId:4,parentFrameId:0,url:chat}];
 frameProbes.set(0,{kind:'waiting',opened:true,frames:[{url:chat,visible:true}]});frameProbes.set(4,{kind:'waiting',opened:true});
 await message('PAGE_READY',{}, {id:'test',url:chat,tab:{id:1},frameId:4});
 assert.equal(stored.learning.field,'editor');assert.ok(stored.learning.frameIds.includes(4));
 assert.ok(deliveries.some(item=>item.type==='PICK_START' && item.frameId===4));assert.equal(stored.running,false);
});

test('1688 waits for complete main-tab and chat readiness before native input, without counting loading as an error',async()=>{
 reset();frameUrl='https://air.1688.com/chat';nativeRequired=true;chatReady=false;
 tabReplies.set(1,{id:1,url:frameUrl,status:'loading'});await review('https://shop.1688.com/');
 assert.equal(debuggerCalls.length,0);assert.ok(!commands.includes('PREPARE'));assert.equal(stored.queue[0].errorCount,undefined);
 tabReplies.set(1,{id:1,url:frameUrl,status:'complete'});await tick();assert.equal(debuggerCalls.length,0);assert.ok(!commands.includes('PREPARE'));
 chatReady=true;await tick();assert.equal(stored.queue[0].status,'review');assert.equal(debuggerCalls[0].type,'attach');assert.equal(clicks,0);
});
test('inactive 1688 button automatically retries after 10 seconds, reactivates and preserves prior approval',async t=>{
 reset();frameUrl='https://air.1688.com/chat';await review('https://shop.1688.com/');
 prepareOk=false;await message('APPROVE');const now=Date.now();t.mock.method(Date,'now',()=>now);await tick();
 const job=stored.queue[0];assert.equal(job.status,'retry_wait');assert.equal(job.retryAt,now+10000);assert.equal(job.errorCount,1);
 assert.equal(clicks,0);const preparations=commands.filter(c=>c==='PREPARE').length;
 await tick();assert.equal(commands.filter(c=>c==='PREPARE').length,preparations);
 t.mock.method(Date,'now',()=>now+9999);await tick();assert.equal(clicks,0);
 prepareOk=true;nativeRequired=true;t.mock.method(Date,'now',()=>now+10000);await tick();
 assert.ok(requests.some(r=>r.type==='PREPARE' && r.reactivate));assert.equal(debuggerCalls[0].type,'attach');
 assert.equal(stored.queue[0].status,'attempted');assert.equal(clicks,1);assert.equal(opened.length,1);
 assert.equal(stored.slots.filter(s=>s.kind==='visit').length,1);assert.equal(stored.slots.filter(s=>s.kind==='send').length,1);
});
test('three preparation failures skip the link, keep error history and continue to the next platform',async()=>{
 reset();stored.settings.review=false;prepareOk=false;await review();await message('IMPORT',{text:'https://next.1688.com/'});
 assert.equal(stored.queue[0].errorCount,1);await retryDue();assert.equal(stored.queue[0].errorCount,2);
 await retryDue();assert.equal(stored.queue[0].status,'failed');assert.equal(stored.queue[0].autoSkipped,true);
 assert.equal(stored.queue[0].failures.length,3);assert.equal(stored.activeId,null);assert.equal(stored.running,true);
 assert.equal(stored.events.filter(e=>e.type==='job_error').length,3);assert.equal(clicks,0);assert.equal(stored.slots.filter(s=>s.kind==='send').length,0);
 await tick();assert.equal(opened.length,2);assert.equal(stored.activeId,stored.queue[1].id);
});
test('loading timeout consumes one failure per 60 seconds, then a bounded retry',async t=>{
 reset();frameUrl='https://air.1688.com/chat';chatReady=false;await review('https://shop.1688.com/');
 const since=stored.queue[0].readyWaitAt;t.mock.method(Date,'now',()=>since+59999);await tick();assert.equal(stored.queue[0].errorCount,undefined);
 t.mock.method(Date,'now',()=>since+60000);await tick();assert.equal(stored.queue[0].errorCount,1);assert.equal(stored.queue[0].status,'retry_wait');
 t.mock.method(Date,'now',()=>since+70000);await tick();assert.equal(stored.queue[0].errorCount,1);assert.equal(stored.queue[0].readyWaitAt,since+70000);
});
test('explicit pause or teaching stops automatic retry and a manual recheck requests native reactivation',async()=>{
 for(const mode of ['PAUSE','TEACH']) {
  reset();prepareOk=false;await review();await message(mode,{field:'send'});
  stored.queue[0].retryAt=Date.now()-1;const count=commands.filter(c=>c==='PREPARE').length;await tick();
  assert.equal(commands.filter(c=>c==='PREPARE').length,count);assert.equal(stored.running,false);
  if(mode==='TEACH'){prepareOk=true;await message('RECHECK');await tick();assert.ok(requests.findLast(r=>r.type==='PREPARE').reactivate);}
 }
});
test('retry state survives worker reload, and delayed 1688 popup is adopted during the countdown',async()=>{
 reset();frameUrl='https://current.1688.com/';probeKind='waiting';await review(frameUrl);stored.queue[0].stepAt=Date.now()-16000;await tick();
 stored=JSON.parse(JSON.stringify(stored));const retryAt=stored.queue[0].retryAt;
 chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:messenger1688});await message('GET');
 assert.equal(stored.queue[0].tabId,20);assert.equal(stored.queue[0].retryAt,retryAt);assert.equal(stored.queue[0].status,'retry_wait');
 frameUrl=messenger1688;probeKind='chat';await retryDue();assert.equal(stored.queue[0].status,'review');assert.equal(contactClicks,0);assert.equal(opened.length,1);
});
test('a failed opener cycle never resets its authorized three-click budget during recovery',async t=>{
 await beginSupplierOpening();const started=Date.now();
 for(let attempt=1;attempt<=3;attempt++){t.mock.method(Date,'now',()=>started+attempt*5000);assert.equal((await openingEvent('attempt',{attempt})).ok,true);}
 await openingTimedOut();const count=commands.filter(c=>c==='OPEN_CHAT').length;await retryDue();await retryDue();
 assert.equal(stored.queue[0].status,'failed');assert.equal(commands.filter(c=>c==='OPEN_CHAT').length,count);assert.equal(clicks,0);
});
test('browser restart discards remembered approval from a retry even after binding the same chat URL',async()=>{
 reset();await review();prepareOk=false;await message('APPROVE');await tick();assert.equal(stored.queue[0].retryApprovedUrl,frameUrl);
 runtime.onStartup.list[0]();await message('GET');assert.equal(stored.queue[0].retryApprovedUrl,undefined);
 prepareOk=true;await message('BIND_TAB',{tabId:1});await tick();assert.equal(stored.queue[0].status,'review');assert.equal(stored.queue[0].approved,false);assert.equal(clicks,0);
});

test('manual skip closes an opened supplier immediately once, preserves quotas and continues the queue',async()=>{
 reset();await review();await message('IMPORT',{text:'https://next.1688.com/'});
 const id=stored.activeId,slots=structuredClone(stored.slots);
 assert.equal((await message('SKIP',{id})).ok,true);assert.deepEqual(removed,[1]);assert.equal(clicks,0);
 assert.equal(stored.queue[0].status,'skipped');assert.equal(stored.activeId,null);assert.deepEqual(stored.slots,slots);
 assert.ok(stored.events.some(e=>e.type==='skip_tab_closed' && e.jobId===id));
 assert.equal((await message('SKIP',{id})).ok,false);assert.deepEqual(removed,[1]);
 await tick();assert.equal(opened.at(-1),'https://next.1688.com/');
});
test('skipping a pending unvisited link opens and closes nothing, clearing its quota wait',async()=>{
 reset();await message('IMPORT',{text:'https://a.en.alibaba.com/'});
 const id=stored.queue[0].id;stored.waiting={jobId:id,until:Date.now()+60000};
 assert.equal((await message('SKIP',{id})).ok,true);assert.deepEqual(removed,[]);assert.deepEqual(opened,[]);
 assert.equal(stored.waiting,null);assert.equal(stored.queue[0].status,'skipped');assert.ok(stored.queue[0].finishedAt);
});
test('manual skip closes both the original storefront and its separately adopted messenger for every platform',async()=>{
 for(const [store,chat] of [
  ['https://current.1688.com/',messenger1688],
  ['https://shop.en.alibaba.com/','https://onetalk.alibaba.com/message/weblite.htm?shop=one'],
  ['https://shop.en.made-in-china.com/','https://webim.made-in-china.com/super-tm/?shop=one'],
 ]) {
  reset();frameUrl=store;probeKind='waiting';await review(store);
  chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:chat});await message('GET');
  assert.equal(stored.queue[0].tabId,20);assert.equal(stored.queue[0].chatTabUrl,chat);
  tabReplies.set(1,{id:1,url:store});tabReplies.set(20,{id:20,url:chat});
  const id=stored.activeId;await message('SKIP',{id});assert.deepEqual(removed,[20,1]);assert.equal(clicks,0);
  assert.equal(stored.events.filter(e=>e.type==='skip_tab_closed' && e.jobId===id).length,2);
 }
});
test('manual skip closes a cached direct 1688 chat without requiring a storefront visit',async()=>{
 reset();const store='https://current.1688.com/';stored.chatRoutes[store]={url:messenger1688};frameUrl=messenger1688;
 await review(store);await message('SKIP',{id:stored.activeId});assert.deepEqual(removed,[1]);assert.deepEqual(opened,[globalThis.OpenLinks1688.route(messenger1688)]);
});
test('skipping a quota-deferred chat closes only that job and leaves the active supplier running',async()=>{
 reset();await review();const old=stored.queue[0];old.status='deferred_send';stored.activeId=null;
 stored.slots.push(...[0,1,2].map(i=>({platform:'alibaba',kind:'send',at:Date.now()-1000+i})));
 await message('IMPORT',{text:'https://next.1688.com/'});await tick();const currentId=stored.activeId;
 tabReplies.set(old.tabId,{id:old.tabId,url:'https://a.en.alibaba.com/chat'});
 assert.equal((await message('SKIP',{id:old.id})).ok,true);assert.deepEqual(removed,[old.tabId]);
 assert.equal(stored.activeId,currentId);assert.equal(stored.running,true);assert.equal(stored.queue[1].status,'visiting');
});
test('skip does not close a navigated, reused or unverified tab, but still records the skipped job',async()=>{
 for(const mode of ['navigation','pending-navigation','reused','restart']) {
  reset();await review();const id=stored.activeId;
  if(mode==='navigation')tabReplies.set(1,{id:1,url:'https://other.en.alibaba.com/'});
  if(mode==='pending-navigation')tabReplies.set(1,{id:1,url:frameUrl,pendingUrl:'https://example.org/'});
  if(mode==='reused')stored.queue.push({id:'other',url:'https://other.en.alibaba.com/',platform:'alibaba',status:'deferred_send',supplierTabId:1});
  if(mode==='restart'){runtime.onStartup.list[0]();await message('GET');}
  assert.equal((await message('SKIP',{id})).ok,true);assert.deepEqual(removed,[],mode);assert.equal(stored.queue[0].status,'skipped');
  assert.ok(stored.events.some(e=>e.type==='skip_tab_kept' && e.jobId===id),mode);
 }
});
test('rebinding after restart only authorizes closure of the newly selected tab, not the stale source tab',async()=>{
 reset();await review();runtime.onStartup.list[0]();await message('GET');
 tabReplies.set(7,{id:7,url:frameUrl});await message('BIND_TAB',{tabId:7});
 assert.equal(stored.queue[0].supplierTabId,undefined);await message('SKIP',{id:stored.activeId});assert.deepEqual(removed,[7]);
});
test('a loading storefront can be skipped before its first document commits',async()=>{
 reset();await message('IMPORT',{text:'https://a.en.alibaba.com/'});await message('START');await tick();
 tabReplies.set(1,{id:1,url:'about:blank',pendingUrl:'https://a.en.alibaba.com/'});
 await message('SKIP',{id:stored.activeId});assert.deepEqual(removed,[1]);
});
test('a missing tab or close failure cannot block skip or continuation',async t=>{
 for(const stage of ['get','remove']) {
  reset();await review();await message('IMPORT',{text:'https://next.1688.com/'});
  const id=stored.activeId,mock=t.mock.method(chrome.tabs,stage,async()=>{throw new Error('Tab already closed')});
  assert.equal((await message('SKIP',{id})).ok,true);assert.equal(stored.queue[0].status,'skipped');assert.equal(stored.running,true);
  assert.ok(stored.events.some(e=>e.type==='skip_tab_kept'));mock.mock.restore();
  await tick();assert.equal(opened.at(-1),'https://next.1688.com/');
 }
});
test('skip cannot interrupt a started send or change automatic error-skip tab behavior',async()=>{
 reset();await review();stored.queue[0].status='sending';assert.equal((await message('SKIP',{id:stored.activeId})).ok,false);assert.deepEqual(removed,[]);
 reset();prepareOk=false;await review();await retryDue();await retryDue();assert.equal(stored.queue[0].status,'failed');assert.deepEqual(removed,[]);
});

test('draft replacement is logged before native activation without storing the old draft',async t=>{
 reset();frameUrl='https://air.1688.com/chat';nativeRequired=true;
 const original=chrome.tabs.sendMessage;let first=true;
 t.mock.method(chrome.tabs,'sendMessage',async(tab,data,options)=>{
  const reply=await original(tab,data,options);
  if(data.type==='PREPARE' && first){first=false;return {...reply,draftReplaced:true};}return reply;
 });
 await review('https://shop.1688.com/');
 assert.equal(stored.queue[0].status,'review');assert.equal(clicks,0);
 const replacement=stored.events.filter(e=>e.type==='draft_replaced');assert.equal(replacement.length,1);
 assert.match(replacement[0].detail,/очищен/);assert.equal(replacement[0].jobId,stored.activeId);
 assert.ok(stored.events.findIndex(e=>e.type==='draft_replaced')<stored.events.findIndex(e=>e.type==='editor_input'));
});

function reserveMonitorTab(tabId,platform='alibaba',url='https://onetalk.alibaba.com/message/weblite.htm') {
 const state=extraStorage.openlinksDialogs || initialDialogs();
 bindDialogTab(state,platform,tabId,url);extraStorage.openlinksDialogs=state;
}
test('dialog commands have a single runtime responder and do not overwrite outreach state',async()=>{
 reset();await message('IMPORT',{text:'https://shop.en.alibaba.com/'});const queue=structuredClone(stored);
 let responded=false;
 assert.equal(runtime.onMessage.list[0]({type:'DIALOGS_GET'},ui,()=>{responded=true;}),undefined);
 const reply=await message('DIALOGS_GET');assert.equal(reply.ok,true);assert.equal(reply.state.mode,'observe');
 assert.equal(responded,false);assert.deepEqual(stored,queue);
});
test('bound inboxes stay protected while paused and independent outreach still runs in its own tab',async()=>{
 reset();reserveMonitorTab(99);assert.equal(extraStorage.openlinksDialogs.running,false);
 await review();await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'attempted');assert.equal(clicks,1);
 assert.ok(!deliveries.some(command=>command.tabId===99));assert.deepEqual(removed,[]);
 assert.equal(extraStorage.openlinksDialogs.bindings.alibaba.tabId,99);
});
test('outreach and dialog binding reject an inbox already owned by the other module',async()=>{
 reset();reserveMonitorTab(99);tabReplies.set(99,{id:99,url:'https://onetalk.alibaba.com/message/weblite.htm'});
 await review();const job=stored.queue[0];
 assert.equal((await message('BIND_TAB',{tabId:99})).ok,false);assert.equal(stored.queue[0].tabId,job.tabId);
 assert.equal((await message('DIALOGS_BIND_TAB',{platform:'alibaba',tabId:job.tabId})).ok,false);
 assert.equal(extraStorage.openlinksDialogs.bindings.alibaba.tabId,99);
});
test('legacy conflicting tab ownership cannot prepare, type or send in a monitored inbox',async()=>{
 for(const [platform,url] of [['1688','https://air.1688.com/chat'],['alibaba','https://onetalk.alibaba.com/message/weblite.htm'],['mic','https://webim.made-in-china.com/super-tm/']]) {
  reset();frameUrl=url;nativeRequired=platform==='1688';
  await message('IMPORT',{text:url});await message('START');await tick();
  reserveMonitorTab(1,platform,url);await tick();
  assert.equal(stored.queue[0].status,'retry_wait',platform);
  assert.ok(!commands.some(type=>['PREPARE','SEND','NATIVE_INPUT','CONTACT','OPEN_CHAT','DISMISS_CHALLENGE'].includes(type)),platform);
  assert.equal(clicks,0);assert.equal(contactClicks,0);assert.deepEqual(debuggerCalls,[]);assert.deepEqual(updated,[]);
  assert.equal(stored.slots.filter(slot=>slot.kind==='send').length,0);
 }
});
test('manual skip preserves monitored source and messenger tabs independently',async()=>{
 for(const reserved of [1,20]) {
  reset();const store='https://shop.en.alibaba.com/',chat='https://onetalk.alibaba.com/message/weblite.htm';frameUrl=store;probeKind='waiting';
  await review(store);chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:chat});await message('GET');
  tabReplies.set(1,{id:1,url:store});tabReplies.set(20,{id:20,url:chat});reserveMonitorTab(reserved,'alibaba',reserved===1?store:chat);
  await message('SKIP',{id:stored.activeId});assert.deepEqual(removed,reserved===1?[20]:[1]);
  assert.ok(stored.events.some(event=>event.type==='skip_tab_kept' && /мониторинг/.test(event.detail)));
 }
});
test('a finished chat subsequently bound for monitoring cannot be closed by its old timer',async t=>{
 reset();await review();await message('APPROVE');await tick();const closing=stored.pendingClosures[0];
 assert.equal((await message('DIALOGS_BIND_TAB',{platform:'alibaba',tabId:closing.tabId})).ok,true);
 t.mock.method(Date,'now',()=>closing.at);await fireClose(closing.token);
 assert.deepEqual(removed,[]);assert.equal(stored.pendingClosures.length,0);
 assert.ok(stored.events.some(event=>event.type==='chat_close_cancelled' && /мониторинг/.test(event.detail)));
});
test('1688 recipient reconciliation excludes monitored inboxes and may choose an unreserved matching tab',async()=>{
 reset();const store='https://current.1688.com/';frameUrl=store;probeKind='waiting';await review(store);
 stored.chatRoutes[store]={url:messenger1688};tabReplies.set(1,{id:1,url:store});reserveMonitorTab(30,'1688',messenger1688);
 listedTabs=[{id:30,url:messenger1688}];await tick();assert.equal(stored.queue[0].tabId,1);
 listedTabs.push({id:31,url:messenger1688});await tick();assert.equal(stored.queue[0].tabId,31);
 assert.ok(!deliveries.some(command=>command.tabId===30));
});
test('popup and same-tab discovery never adopts or resumes a reserved monitor tab',async()=>{
 for(const [platform,store,chat] of [['1688','https://current.1688.com/',messenger1688],['alibaba','https://shop.en.alibaba.com/','https://onetalk.alibaba.com/message/weblite.htm'],['mic','https://shop.en.made-in-china.com/','https://webim.made-in-china.com/super-tm/']]) {
  reset();frameUrl=store;probeKind='waiting';await review(store);reserveMonitorTab(20,platform,chat);
  chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:chat});await message('GET');
  chrome.webNavigation.onCreatedNavigationTarget.list[0]({tabId:20,sourceTabId:1,url:chat});await message('GET');
  assert.equal(stored.queue[0].tabId,1,platform);
  reserveMonitorTab(1,platform,chat);const before=structuredClone(stored);
  chrome.tabs.onUpdated.list[0](1,{url:chat},{id:1,url:chat});await message('GET');
  await message('PAGE_READY',{}, {id:'test',url:chat,tab:{id:1},frameId:0});
  assert.deepEqual(stored,before,platform);assert.equal(clicks,0);
 }
});
test('binding a finished chat while its close check is in flight prevents removal',async t=>{
 reset();await review();await message('APPROVE');await tick();const closing=stored.pendingClosures[0];
 const original=chrome.tabs.sendMessage;
 t.mock.method(chrome.tabs,'sendMessage',async(tab,data,options)=>{
  const reply=await original(tab,data,options);if(data.type==='CAN_CLOSE')reserveMonitorTab(tab);return reply;
 });
 t.mock.method(Date,'now',()=>closing.at);await fireClose(closing.token);
 assert.deepEqual(removed,[]);assert.equal(extraStorage.openlinksDialogs.bindings.alibaba.tabId,closing.tabId);
 assert.ok(stored.events.some(event=>event.type==='chat_close_cancelled' && /мониторинг/.test(event.detail)));
});
test('concurrent inbox and outreach binding grant ownership to exactly one module',async()=>{
 for(const monitorFirst of [false,true]) {
  reset();await review();tabReplies.set(99,{id:99,url:'https://onetalk.alibaba.com/message/weblite.htm'});
  const bindQueue=()=>message('BIND_TAB',{tabId:99}),bindMonitor=()=>message('DIALOGS_BIND_TAB',{platform:'alibaba',tabId:99});
  const replies=await Promise.all(monitorFirst?[bindMonitor(),bindQueue()]:[bindQueue(),bindMonitor()]);
  assert.equal(replies.filter(reply=>reply.ok).length,1);
  assert.notEqual(stored.queue[0].tabId===99,extraStorage.openlinksDialogs?.bindings.alibaba.tabId===99);
 }
});
test('concurrent popup adoption cannot take an inbox being reserved for monitoring',async()=>{
 for(const [platform,store,chat] of [['1688','https://current.1688.com/',messenger1688],['alibaba','https://shop.en.alibaba.com/','https://onetalk.alibaba.com/message/weblite.htm'],['mic','https://shop.en.made-in-china.com/','https://webim.made-in-china.com/super-tm/']]) {
  reset();frameUrl=store;probeKind='waiting';await review(store);tabReplies.set(20,{id:20,url:chat});
  chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,url:chat});
  await message('DIALOGS_BIND_TAB',{platform,tabId:20});await message('GET');
  assert.notEqual(stored.queue[0].tabId===20,extraStorage.openlinksDialogs?.bindings[platform].tabId===20,platform);
 }
});
test('binding and closing a finished chat cannot leave a successful binding to a removed tab',async t=>{
 reset();await review();await message('APPROVE');await tick();const closing=stored.pendingClosures[0],originalGet=chrome.tabs.get;
 t.mock.method(chrome.tabs,'get',async id=>{if(removed.includes(id))throw new Error('Tab closed');return originalGet(id);});
 t.mock.method(Date,'now',()=>closing.at);
 alarms.onAlarm.list[0]({name:'openlinks-close:'+closing.token});
 const result=await message('DIALOGS_BIND_TAB',{platform:'alibaba',tabId:closing.tabId});await message('GET');
 assert.equal(result.ok && removed.includes(closing.tabId),false);
 if(result.ok)assert.equal(extraStorage.openlinksDialogs.bindings.alibaba.tabId,closing.tabId);
 else assert.deepEqual(removed,[closing.tabId]);
});
test('tab ownership validation is serialized even while Chrome lookup is delayed',async t=>{
 for(const monitorFirst of [false,true]) {
  reset();await review();tabReplies.set(99,{id:99,url:'https://onetalk.alibaba.com/message/weblite.htm'});
  let release,lookups=0;const gate=new Promise(resolve=>{release=resolve;}),original=chrome.tabs.get;
  const mock=t.mock.method(chrome.tabs,'get',async id=>{if(id===99 && ++lookups===1)await gate;return original(id);});
  const bindQueue=()=>message('BIND_TAB',{tabId:99}),bindMonitor=()=>message('DIALOGS_BIND_TAB',{platform:'alibaba',tabId:99});
  const first=(monitorFirst?bindMonitor:bindQueue)();await new Promise(resolve=>setImmediate(resolve));
  const second=(monitorFirst?bindQueue:bindMonitor)();await new Promise(resolve=>setImmediate(resolve));
  const observed=lookups;release();const replies=await Promise.all([first,second]);mock.mock.restore();
  assert.equal(observed,1,'The other module must not validate the same tab while ownership is being claimed');
  assert.equal(replies.filter(reply=>reply.ok).length,1);
 }
});

test('dialogue replies reserve outreach quota atomically, respect send intervals and never authorize a duplicate attempt',async t=>{
 reset();const {reserveDialogSendQuota}=await import('../extension/background.js');
 const jobId=crypto.randomUUID(),attemptId=crypto.randomUUID();
 const first=await reserveDialogSendQuota({platform:'alibaba',jobId,attemptId});assert.equal(first.ok,true);
 const replay=await reserveDialogSendQuota({platform:'alibaba',jobId,attemptId});assert.equal(replay.ok,false);assert.equal(replay.unknown,true);assert.equal(stored.slots.length,1);
 const rest=await Promise.all(Array.from({length:4},()=>reserveDialogSendQuota({platform:'alibaba',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()})));
 assert.equal(rest.filter(r=>r.ok).length,0);assert.equal(stored.slots.length,1);assert.ok(rest.every(r=>r.retryAt>=first.at+stored.settings.intervals.alibaba*1000));
 t.mock.method(Date,'now',()=>first.at+stored.settings.intervals.alibaba*1000);
 assert.equal((await reserveDialogSendQuota({platform:'alibaba',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()})).ok,true);assert.equal(stored.slots.length,2);assert.equal(clicks,0);
});
test('dialogue quota includes prior outreach sends and protects future reservations after clock rollback',async()=>{
 reset();const {reserveDialogSendQuota}=await import('../extension/background.js');
 stored.slots=Array.from({length:7},()=>({platform:'1688',kind:'send',at:Date.now(),jobId:crypto.randomUUID()}));
 assert.equal((await reserveDialogSendQuota({platform:'1688',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()})).ok,false);
 stored.slots=[{platform:'mic',kind:'send',at:Date.now()+100000,jobId:'future'}];
 assert.equal((await reserveDialogSendQuota({platform:'mic',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()})).ok,false);
 await assert.rejects(reserveDialogSendQuota({platform:'foreign',jobId:'invalid',attemptId:'invalid'}));assert.equal(clicks,0);
});


test('legacy dialogue test flag cannot block independent primary start, approval or send',async()=>{
 reset();querySendGuard=true;extraStorage.openlinksClaudeFolder={test:{enabled:true,sessionId:'old-preview',history:[{id:'old-preview'}]}};
 const preview=structuredClone(extraStorage.openlinksClaudeFolder);
 await review();assert.equal(stored.queue[0].status,'review');assert.equal(stored.running,true);
 assert.equal((await message('APPROVE')).ok,true);
 const {pauseOutreachForTest,reserveDialogSendQuota}=await import('../extension/background.js');
 await pauseOutreachForTest();assert.equal(stored.running,true);assert.equal(stored.queue[0].approved,true);
 await tick();assert.equal(clicks,1);assert.equal(stored.queue[0].status,'attempted');
 assert.equal(stored.slots.filter(s=>s.kind==='send').length,1);
 assert.deepEqual(extraStorage.openlinksClaudeFolder,preview);
 assert.ok(createdTabs.every(tab=>tab.active===true));assert.ok(windowUpdates.some(window=>window.focused));assert.deepEqual(preloadCalls,[]);
 const quota=await reserveDialogSendQuota({platform:'mic',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()});
 assert.equal(quota.ok,false);assert.match(quota.reason,/тестовый режим/);assert.equal(clicks,1);
});
test('legacy dialogue test flag appearing during primary preparation does not cancel the approved send',async()=>{
 reset();querySendGuard=true;await review();await message('APPROVE');afterPrepare=()=>{extraStorage.openlinksClaudeFolder={test:{enabled:true}};};
 await tick();assert.equal(clicks,1);assert.equal(stored.queue[0].status,'attempted');
 assert.equal(stored.slots.filter(s=>s.kind==='send').length,1);assert.equal(commands.includes('SEND'),true);
});
test('1688 primary native activation and automatic send work visibly despite a stale dialogue preview',async()=>{
 reset();frameUrl='https://air.1688.com/chat';nativeRequired=true;querySendGuard=true;stored.settings.review=false;
 extraStorage.openlinksClaudeFolder={test:{enabled:true,sessionId:'old-preview'}};
 await review('https://a.1688.com/');assert.equal(stored.queue[0].approved,true);
 assert.equal(debuggerCalls[0].type,'attach');assert.equal(debuggerCalls.at(-1).type,'detach');
 await tick();assert.equal(clicks,1);assert.equal(stored.queue[0].status,'attempted');
 assert.equal(stored.slots.filter(slot=>slot.kind==='send').length,1);
 assert.ok(createdTabs.every(tab=>tab.active===true));assert.ok(windowUpdates.some(window=>window.focused));assert.deepEqual(preloadCalls,[]);
});
test('visible outreach restores its minimized window and refocuses before native input and send',async()=>{
 for(const [platform,url] of [['1688','https://a.1688.com/chat'],['alibaba','https://a.en.alibaba.com/chat'],['mic','https://a.en.made-in-china.com/chat']]) {
  reset();frameUrl=url;querySendGuard=true;stored.settings.review=false;nativeRequired=platform==='1688';
  windowReplies.set(10,{id:10,type:'normal',state:'minimized',focused:false});
  afterPrepare=()=>{const tab=tabReplies.get(1);tabReplies.set(1,{...tab,active:false});windowReplies.set(10,{id:10,type:'normal',state:'normal',focused:false});};
  await review(url);
  assert.equal(clicks,1,platform);assert.equal(stored.queue[0].status,'attempted',platform);
  assert.ok(windowUpdates.some(window=>window.id===10&&window.state==='normal'&&window.focused),platform);
  const mutations=deliveries.filter(item=>['PREPARE','NATIVE_INPUT','SEND'].includes(item.type));
  assert.ok(mutations.length>=3,platform);assert.ok(mutations.every(item=>item.active&&item.focused),platform);
  assert.equal(preloadCalls.length,0,platform);
 }
});
test('a window focus failure before SEND consumes no send quota and is not reported as an unknown click',async t=>{
 reset();await review();await message('APPROVE');
 afterPrepare=()=>{windowReplies.set(10,{id:10,type:'normal',focused:false});};
 t.mock.method(chrome.windows,'update',async()=>{throw new Error('Window disappeared');});
 await tick();assert.equal(clicks,0);assert.equal(stored.slots.filter(slot=>slot.kind==='send').length,0);
 assert.equal(stored.queue[0].status,'retry_wait');assert.ok(!commands.includes('SEND'));
 assert.ok(!stored.events.some(event=>event.type==='send_attempt'||event.type==='send_disconnect'));
});
test('outreach persists the current document before sending and targets that document instead of a reusable frame ID',async()=>{
 reset();await review();await message('APPROVE');await tick();
 const job=beforeClick.queue[0],delivery=deliveries.find(item=>item.type==='SEND');
 assert.equal(job.sendDocumentId,documentedFrames()[0].documentId);
 assert.equal(delivery.documentId,job.sendDocumentId);assert.equal(delivery.frameId,job.frameId);
 assert.equal(job.status,'sending');assert.equal(clicks,1);
});
test('Alibaba iframe sends through the runtime guard when Chrome strips its sender URL fragment',async()=>{
 reset();querySendGuard=true;
 const chatUrl='https://onetalk.alibaba.com/message/weblite.htm#/';
 frameList=[{frameId:0,url:frameUrl},{frameId:13,parentFrameId:0,url:chatUrl,documentId:'alibaba-chat-document'}];
 frameProbes.set(0,{kind:'waiting',opened:true,frames:[{url:chatUrl,visible:true}]});
 await review();await message('APPROVE');await tick();
 assert.equal(clicks,1);assert.equal(stored.queue[0].status,'attempted');
 assert.equal(beforeClick.queue[0].reviewUrl,chatUrl);assert.equal(beforeClick.queue[0].sendDocumentId,'alibaba-chat-document');
 assert.equal(deliveries.find(item=>item.type==='SEND').documentId,'alibaba-chat-document');
 assert.ok(!stored.events.some(event=>event.type==='send_not_clicked'||event.type==='retry_scheduled'));
});
test('a missing current document or frame stops before the send quota is reserved',async()=>{
 for(const frame of [{frameId:0,url:'https://a.en.alibaba.com/chat',documentId:null},{frameId:99,url:'https://a.en.alibaba.com/chat',documentId:'another-frame'}]) {
  reset();await review();await message('APPROVE');frameList=[frame];await tick();
  assert.equal(clicks,0);assert.equal(stored.slots.filter(slot=>slot.kind==='send').length,0);
  assert.equal(stored.queue[0].status,'retry_wait');assert.ok(!commands.includes('SEND'));
  assert.ok(!stored.events.some(event=>event.type==='send_attempt'||event.type==='send_disconnect'));
 }
});
test('primary permission requires the exact approved sending operation and reserved quota',async()=>{
 reset();await review();await message('APPROVE');await tick();
 const sending=structuredClone(beforeClick),job=sending.queue[0];
 stored=structuredClone(sending);extraStorage.openlinksClaudeFolder={test:{enabled:true}};
 const source={id:'test',tab:{id:job.tabId},frameId:job.frameId,documentId:job.sendDocumentId,url:job.reviewUrl};
 const request={scope:'outreach',jobId:job.id,attemptId:job.attemptId,expectedUrl:job.reviewUrl,message:job.message};
 const allowed=()=>message('OPENLINKS_TEST_SEND_GUARD',request,source);
 assertPermission(await allowed(),{ok:true,canSend:true});
 assert.deepEqual(stored,sending,'The permission check must remain read-only');
 for(const patch of [{scope:'dialog'},{scope:undefined},{jobId:'old-preview'},{attemptId:'old-preview'},{expectedUrl:'https://b.en.alibaba.com/chat'},{message:'Different message'}]) {
  assertPermission(await message('OPENLINKS_TEST_SEND_GUARD',{...request,...patch},source),{ok:true,canSend:false});
 }
 for(const patch of [{tab:{id:job.tabId+1}},{frameId:99},{url:'https://b.en.alibaba.com/chat'}]) {
  assertPermission(await message('OPENLINKS_TEST_SEND_GUARD',request,{...source,...patch}),{ok:true,canSend:false});
 }
 for(const mutate of [
  state=>{state.running=false;},state=>{state.activeId=null;},state=>{state.queue[0].status='review';},
  state=>{state.queue[0].approved=false;},state=>{state.queue[0].attemptId='new-attempt';},
  state=>{state.slots=[];},state=>{state.slots.find(slot=>slot.kind==='send').jobId='other';},
  state=>{state.slots.find(slot=>slot.kind==='send').at++;}
 ]) {
  stored=structuredClone(sending);mutate(stored);assertPermission(await allowed(),{ok:true,canSend:false});
 }
 stored=structuredClone(sending);extraStorage.openlinksDialogs={bindings:{alibaba:{tabId:job.tabId}}};
 assertPermission(await allowed(),{ok:true,canSend:false});
});
test('content send permission is authenticated and independent of the outreach lock',async()=>{
 reset();const source={id:'test',tab:{id:7},frameId:0,documentId:documentedFrames()[0].documentId,url:frameUrl};
 assertPermission(await message('OPENLINKS_TEST_SEND_GUARD',{},source),{ok:true,canSend:false});
 for(const invalid of [{...source,id:'foreign'},{...source,url:'https://example.com/'},{id:'test',url:frameUrl}])assertPermission(await message('OPENLINKS_TEST_SEND_GUARD',{},invalid),{ok:false,canSend:false});
 await review();await message('APPROVE');querySendGuard=true;extraStorage.openlinksClaudeFolder={test:{enabled:true}};
 let timer;try{await Promise.race([tick(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Send guard deadlocked behind outreach command')),1000);})]);}finally{clearTimeout(timer);}
 assert.equal(clicks,1);
});
test('legacy reply permission retains preview denial and matches its own bound receipt and message',async()=>{
 reset();const {reserveDialogSendQuota}=await import('../extension/background.js');
 const jobId=crypto.randomUUID(),attemptId=crypto.randomUUID(),dialogId='seller-chat';
 const request={scope:'dialog',jobId:attemptId,attemptId,dialogOperation:attemptId,dialogId,expectedUrl:frameUrl,message:'Reply'};
 const source={id:'test',tab:{id:7},frameId:0,documentId:documentedFrames()[0].documentId,url:frameUrl};
 const folder={test:{enabled:false},sendReceipts:[{id:attemptId,jobId,key:'alibaba:'+dialogId,status:'reserved',textHash:await folderDigest(request.message)}]};
 extraStorage.openlinksDialogs={running:true,settings:{wechatAudit:false},bindings:{alibaba:{tabId:7}}};
 extraStorage.openlinksClaudeFolder=structuredClone(folder);
 assert.equal((await reserveDialogSendQuota({platform:'alibaba',jobId,attemptId})).ok,true);
 const allowed=()=>message('OPENLINKS_TEST_SEND_GUARD',request,source);
 assertPermission(await allowed(),{ok:true,canSend:true});
 for(const mutate of [value=>{value.test.enabled=true;},value=>{value.sendReceipts[0].status='sent';},value=>{value.sendReceipts[0].jobId=crypto.randomUUID();},value=>{value.sendReceipts[0].textHash='wrong';}]) {
  extraStorage.openlinksClaudeFolder=structuredClone(folder);mutate(extraStorage.openlinksClaudeFolder);
  assertPermission(await allowed(),{ok:true,canSend:false});
 }
 extraStorage.openlinksClaudeFolder=structuredClone(folder);
 assertPermission(await message('OPENLINKS_TEST_SEND_GUARD',{...request,scope:'outreach'},source),{ok:true,canSend:false});
 assertPermission(await message('OPENLINKS_TEST_SEND_GUARD',{...request,message:'Other reply'},source),{ok:true,canSend:false});
 extraStorage.openlinksDialogs.settings.wechatAudit=true;assertPermission(await allowed(),{ok:true,canSend:false});
});
test('content send-mode guard fails closed when trusted storage is unavailable',async t=>{
 reset();t.mock.method(chrome.storage.local,'get',async()=>{throw new Error('Storage unavailable');});
 assertPermission(await message('OPENLINKS_TEST_SEND_GUARD',{}, {id:'test',tab:{id:7},url:frameUrl}),{ok:false,canSend:false});assert.equal(clicks,0);
});

const coordination=await import('../extension/background.js');
function exhaustPrimary(platform,kind='send',at=Date.now()) {
  stored.slots.push(...Array.from({length:platform==='1688'?7:3},()=>({platform,kind,at,jobId:crypto.randomUUID()})));
}
async function jointQueue(urls='https://a.en.alibaba.com/') {
  await message('IMPORT',{text:urls});
  const dialogs=initialDialogs();dialogs.running=true;extraStorage.openlinksDialogs=dialogs;
  return coordination.startOutreachForJoint(ui);
}
test('joint start preserves approval and Claude settings and gives ready outreach priority',async()=>{
  reset();extraStorage.openlinksClaudeFolder={enabled:true,auto:false,autoSend:false,test:{enabled:false}};
  const folder=structuredClone(extraStorage.openlinksClaudeFolder),status=await jointQueue();
  assert.equal(status.phase,'outreach');assert.equal(status.allowDialogs,false);assert.equal(stored.running,true);
  assert.equal(stored.settings.review,true);assert.equal(extraStorage.openlinksWorkCoordinator.enabled,true);
  assert.deepEqual(extraStorage.openlinksClaudeFolder,folder);
  let ran=false;const turn=await coordination.withDialogTurn(()=>{ran=true;});assert.equal(turn.allowed,false);assert.equal(ran,false);
  const reserved=await coordination.reserveDialogSendQuota({platform:'mic',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()});
  assert.equal(reserved.ok,false);assert.equal(reserved.coordination,true);assert.equal(stored.slots.length,0);
  await tick();assert.equal(createdTabs.length,1);assert.equal(createdTabs[0].active,true);assert.equal(clicks,0);
});
test('joint start ignores the dormant dialogue test flag and preserves its preview evidence',async()=>{
  reset();extraStorage.openlinksClaudeFolder={test:{enabled:true,sessionId:'old-preview',history:[{id:'old-preview'}]}};
  const folder=structuredClone(extraStorage.openlinksClaudeFolder),status=await jointQueue();
  assert.equal(status.phase,'outreach');assert.equal(status.testMode,false);assert.equal(status.allowDialogs,false);
  assert.equal(stored.running,true);assert.equal(extraStorage.openlinksWorkCoordinator.enabled,true);
  assert.deepEqual(extraStorage.openlinksClaudeFolder,folder);assert.equal(createdTabs.length,0);assert.equal(clicks,0);
});
test('joint start tolerates a dormant test flag written during Chrome window validation',async t=>{
  reset();await message('IMPORT',{text:'https://a.en.alibaba.com/'});extraStorage.openlinksDialogs={running:true};
  t.mock.method(chrome.windows,'getLastFocused',async()=>{extraStorage.openlinksClaudeFolder={test:{enabled:true}};return {id:10,type:'normal'};});
  const status=await coordination.startOutreachForJoint(ui);
  assert.equal(status.phase,'outreach');assert.equal(stored.running,true);assert.equal(extraStorage.openlinksWorkCoordinator.enabled,true);
  assert.equal(extraStorage.openlinksClaudeFolder.test.enabled,true);assert.equal(createdTabs.length,0);
});
test('joint start restores previous outreach and coordinator if scheduling fails after commit',async t=>{
  reset();await message('IMPORT',{text:'https://a.en.alibaba.com/'});
  stored.running=true;extraStorage.openlinksDialogs={running:true};
  extraStorage.openlinksWorkCoordinator={version:1,enabled:false,startedAt:17};
  const before=structuredClone(stored),mode=structuredClone(extraStorage.openlinksWorkCoordinator);
  t.mock.method(chrome.alarms,'create',async()=>{assert.equal(extraStorage.openlinksWorkCoordinator.enabled,true);throw new Error('Alarm storage failed');});
  await assert.rejects(coordination.startOutreachForJoint(ui),/Alarm storage failed/);
  assert.deepEqual(stored,before);assert.deepEqual(extraStorage.openlinksWorkCoordinator,mode);
  assert.equal(createdTabs.length,0);assert.equal(clicks,0);
});
test('joint start rolls back a failed final status read before a queued tick may run',async t=>{
  reset();await message('IMPORT',{text:'https://a.en.alibaba.com/'});extraStorage.openlinksDialogs={running:true};
  extraStorage.openlinksWorkCoordinator={version:1,enabled:false,startedAt:null};
  const before=structuredClone(stored),mode=structuredClone(extraStorage.openlinksWorkCoordinator),originalGet=chrome.storage.local.get;
  let failOnce=true;
  t.mock.method(chrome.storage.local,'get',async keys=>{
    if(failOnce&&Array.isArray(keys)&&keys.includes('openlinksWorkCoordinator')&&extraStorage.openlinksWorkCoordinator.enabled) {
      failOnce=false;alarms.onAlarm.list[0]({name:'openlinks-tick'});throw new Error('Status storage failed');
    }
    return originalGet(keys);
  });
  await assert.rejects(coordination.startOutreachForJoint(ui),/Status storage failed/);await message('GET');
  assert.deepEqual(stored,before);assert.deepEqual(extraStorage.openlinksWorkCoordinator,mode);
  assert.equal(createdTabs.length,0);assert.equal(clicks,0);
});
test('quota handoff uses the shared send limit without deadlocking its serializer',async()=>{
  reset();await jointQueue();exhaustPrimary('alibaba');
  assert.equal((await coordination.getWorkCoordination()).phase,'dialogs_quota_wait');
  let timer;
  try {
    const turn=await Promise.race([
      coordination.withDialogTurn(async()=>({
        denied:await coordination.reserveDialogSendQuota({platform:'alibaba',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()}),
        allowed:await coordination.reserveDialogSendQuota({platform:'mic',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()})
      })),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Joint lease deadlocked with shared reservation')),1000);})
    ]);
    assert.equal(turn.allowed,true);assert.equal(turn.value.denied.ok,false);assert.ok(turn.value.denied.retryAt>Date.now());
    assert.equal(turn.value.allowed.ok,true);
  } finally {clearTimeout(timer);}
  assert.equal(stored.slots.filter(slot=>slot.dialogAttemptId).length,1);assert.equal(clicks,0);
});
test('quota recovery waits for the current dialogue action then resumes outreach without overlap',async t=>{
  reset();await jointQueue();const now=Date.now();exhaustPrimary('alibaba','send',now-WINDOW_MS+500);
  let release,entered;const holding=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  const turn=coordination.withDialogTurn(async()=>{entered();await holding;return 'finished';});
  await ready;
  try {
    const overlap=await coordination.withDialogTurn(()=>assert.fail('Overlapping dialogue action'));
    assert.equal(overlap.allowed,false);
    t.mock.method(Date,'now',()=>now+2000);
    await tick();assert.equal(createdTabs.length,0);
    const quota=await coordination.reserveDialogSendQuota({platform:'mic',jobId:crypto.randomUUID(),attemptId:crypto.randomUUID()});
    assert.equal(quota.ok,false);assert.equal(quota.coordination,true);
  } finally {release();}
  assert.equal((await turn).value,'finished');await tick();assert.equal(createdTabs.length,1);assert.equal(clicks,0);
});
test('failed dialogue action releases its turn so primary work can continue',async()=>{
  reset();await jointQueue();exhaustPrimary('alibaba');
  await assert.rejects(coordination.withDialogTurn(()=>{throw new Error('Reader failure');}),/Reader failure/);
  stored.slots=[];await tick();assert.equal(createdTabs.length,1);
});
test('independent start or pause exits joint mode without changing the other block',async()=>{
  reset();await jointQueue();
  assert.equal((await message('PAUSE')).ok,true);assert.equal(extraStorage.openlinksWorkCoordinator.enabled,false);
  assert.equal(extraStorage.openlinksDialogs.running,true);assert.equal(stored.running,false);
  await coordination.startOutreachForJoint(ui);
  assert.equal((await message('START')).ok,true);assert.equal(extraStorage.openlinksWorkCoordinator.enabled,false);
  assert.equal(extraStorage.openlinksDialogs.running,true);assert.equal(stored.running,true);
  await coordination.startOutreachForJoint(ui);await coordination.disableJointWork();
  assert.equal(stored.running,true);assert.equal(extraStorage.openlinksDialogs.running,true);
});
test('joint pause does not erase current work or approved dialogue settings',async()=>{
  reset();await jointQueue();await tick();
  const active=structuredClone(stored.queue[0]);await coordination.pauseOutreachForJoint();
  assert.equal(stored.running,false);assert.equal(stored.waiting,null);assert.equal(extraStorage.openlinksWorkCoordinator.enabled,false);
  assert.deepEqual(stored.queue[0],active);assert.equal(stored.activeId,active.id);assert.equal(clicks,0);
});
test('worker reconstruction respects both saved running flags and browser restart disables joint mode',async()=>{
  reset();await jointQueue();exhaustPrimary('alibaba');
  assert.equal((await coordination.getWorkCoordination()).phase,'dialogs_quota_wait');
  extraStorage.openlinksDialogs.running=false;
  assert.equal((await coordination.getWorkCoordination()).phase,'needs_attention');
  stored.slots=[];await tick();assert.equal(createdTabs.length,0);exhaustPrimary('alibaba');
  extraStorage.openlinksDialogs.running=true;
  assert.equal((await coordination.getWorkCoordination()).phase,'dialogs_quota_wait');
  runtime.onStartup.list[0]();await message('GET');
  assert.equal(extraStorage.openlinksWorkCoordinator.enabled,false);assert.equal(stored.running,false);
});
test('retired preview callback cannot stop joint primary work',async()=>{
  reset();await jointQueue();extraStorage.openlinksClaudeFolder={test:{enabled:true}};
  await coordination.pauseOutreachForTest();
  assert.equal(extraStorage.openlinksWorkCoordinator.enabled,true);assert.equal(stored.running,true);
  await tick();assert.equal(createdTabs.length,1);assert.equal(createdTabs[0].active,true);
  assert.equal(clicks,0);assert.equal(stored.slots.filter(slot=>slot.kind==='visit').length,1);
});
