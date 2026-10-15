import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialState} from '../extension/lib/core.js';
import {domReply} from './debugger-harness.js';
const listener=()=>{const list=[];return {list,addListener(fn){list.push(fn);}};};
let stored,clicks,contactClicks,commands,requests,beforeClick,probeKind,sendResult,frameUrl,tabCount,opened,missing,obstacle,prepareOk,lookupPages,fetches,probeRoute,updated,probeKey,listedTabs,frameList,tabReplies,frameProbes,deliveries;
let scheduled,removed,canClose,nativeRequired,debuggerFailure,debuggerCalls,nativeFailure;
const metadataFixture=readFileSync(new URL('./fixtures/1688-metadata.html',import.meta.url),'utf8');
globalThis.fetch=async(url,options)=>{fetches.push({url,credentials:options.credentials});const html=lookupPages.get(url);if(html===undefined)throw new Error('No local metadata fixture');return new Response(html,{headers:{'content-type':'text/html'}});};
const runtime={onMessage:listener(),onStartup:listener(),onInstalled:listener(),getURL:path=>'chrome-extension://test/'+path};
const alarms={onAlarm:listener(),create:async(name,options)=>{scheduled.push({name,...options});}};
globalThis.chrome={runtime,alarms,storage:{local:{get:async()=>({openlinksState:structuredClone(stored)}),set:async data=>{stored=structuredClone(data.openlinksState);}}},
 tabs:{onUpdated:listener(),onCreated:listener(),create:async data=>{opened.push(data.url);return {id:++tabCount};},update:async(id,data)=>{updated.push({id,...data});},query:async()=>structuredClone(listedTabs),get:async id=>tabReplies.get(id) || ({id,url:frameUrl}),
 remove:async id=>{removed.push(id);},
 sendMessage:async(tab,data,options)=>{
  deliveries.push({tabId:tab,frameId:options.frameId,type:data.type});
  commands.push(data.type);
  requests.push(structuredClone(data));
  if(data.type==='PROBE')return {engine:frameUrl.includes('1688.com')?undefined:'supplier-chat-v2',kind:probeKind,key:probeKey,chatRoute:probeRoute,obstacle:obstacle?.text,canDismiss:obstacle?.dismiss,dismissKey:obstacle?.key,reason:probeKind==='inquiry'?'Форма запроса, нужен чат':undefined,...frameProbes.get(options.frameId)};
  if(data.type==='PREPARE')return {ok:prepareOk && !nativeRequired,needsNativeInput:nativeRequired,pageUrl:frameList?.find(frame=>frame.frameId===options.frameId)?.url || frameUrl,reason:prepareOk?undefined:'Редактор изменился'};
  if(data.type==='NATIVE_INPUT' && nativeFailure?.stage===data.stage)return {ok:false,reason:nativeFailure.reason};
  if(data.type==='NATIVE_INPUT' && data.stage==='done')nativeRequired=false;
  if(data.type==='CAN_CLOSE')return {ok:canClose};
  if(data.type==='SEND'){clicks++;beforeClick=structuredClone(stored);if(sendResult==='disconnect')throw new Error('Disconnected');if(sendResult==='malformed')return {ok:false};return {clicked:sendResult!==false,accepted:sendResult===true,reason:'Кнопка изменилась'};}
  if(data.type==='CONTACT'){contactClicks++;return {ok:true,key:probeKey};}
  if(data.type==='DISMISS_CHALLENGE'){if(obstacle?.stuck)return {clicked:true,closed:false};obstacle=null;return {clicked:true,closed:true};}
  return {ok:true};
 }},webNavigation:{onCreatedNavigationTarget:listener(),getAllFrames:async()=>{if(missing)throw new Error('No tab');return frameList || [{frameId:0,url:frameUrl}];}},action:{onClicked:listener()},windows:{}};
await import('../extension/background.js');
chrome.debugger={
 attach:async target=>{debuggerCalls.push({type:'attach',target});if(debuggerFailure)throw new Error(debuggerFailure);},
 detach:async target=>{debuggerCalls.push({type:'detach',target});},
 sendCommand:async(target,method,params)=>{debuggerCalls.push({target,method,params});return domReply(method);},
};
const ui={id:'test',url:'chrome-extension://test/dashboard.html'};
const message=(type,extra={},sender=ui)=>new Promise(resolve=>runtime.onMessage.list[0]({type,...extra},sender,resolve));
async function tick(){alarms.onAlarm.list[0]({name:'openlinks-tick'});await message('GET');}
function reset(){stored=initialState();stored.settings.message='Hello';clicks=0;contactClicks=0;commands=[];requests=[];beforeClick=null;probeKind='chat';sendResult=true;frameUrl='https://a.en.alibaba.com/chat';tabCount=0;opened=[];missing=false;obstacle=null;prepareOk=true;lookupPages=new Map();fetches=[];probeRoute=null;updated=[];probeKey='#contact';listedTabs=[];frameList=null;tabReplies=new Map();frameProbes=new Map();deliveries=[];scheduled=[];removed=[];canClose=true;nativeRequired=false;debuggerFailure=null;debuggerCalls=[];nativeFailure=null;}
async function review(url='https://a.en.alibaba.com/'){await message('IMPORT',{text:url});await message('START');await tick();await tick();}
async function openingTimedOut(){stored.queue[0].chatOpening.at=Date.now()-21000;await tick();}

async function fireClose(token){alarms.onAlarm.list[0]({name:'openlinks-close:'+token});await message('GET');}
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
test('unsent draft, skipped supplier and uncertain 1688 click leave their tabs open',async()=>{
 reset();await review();assert.equal(stored.pendingClosures?.length || 0,0);
 await message('SKIP',{id:stored.activeId});assert.equal(stored.pendingClosures?.length || 0,0);
 reset();frameUrl='https://a.1688.com/chat';sendResult='unaccepted';await review('https://a.1688.com/');await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'uncertain');assert.equal(stored.pendingClosures?.length || 0,0);assert.equal(removed.length,0);
 await message('MARK_SENT');assert.equal(stored.pendingClosures.length,1);
});
test('1688 activates the selected frame before reserving send quota and does not repeat keyboard input after approval',async()=>{
 reset();frameUrl='https://a.1688.com/chat';nativeRequired=true;await review('https://a.1688.com/');
 assert.equal(stored.queue[0].status,'review');assert.equal(clicks,0);assert.equal(stored.slots.filter(s=>s.kind==='send').length,0);
 assert.equal(debuggerCalls[0].type,'attach');assert.equal(debuggerCalls.at(-1).type,'detach');
 const inputCalls=debuggerCalls.length;
 assert.deepEqual(requests.filter(r=>r.type==='NATIVE_INPUT').map(r=>r.stage),['locate','focus','space','done','release']);
 await message('APPROVE');await tick();assert.equal(clicks,1);assert.equal(debuggerCalls.length,inputCalls);
});
test('debugger attach failure pauses without clicking, reserving quota or teaching the wrong button',async()=>{
 reset();frameUrl='https://a.1688.com/chat';nativeRequired=true;debuggerFailure='Another debugger is already attached';await review('https://a.1688.com/');
 assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'blocked');assert.match(stored.queue[0].reason,/DevTools/);
 assert.equal(clicks,0);assert.equal(stored.learning,null);assert.equal(stored.slots.filter(s=>s.kind==='send').length,0);
 assert.equal(debuggerCalls.length,1);
});
test('changed draft reports the keyboard stage without misleading DevTools advice or a send attempt',async()=>{
 reset();frameUrl='https://a.1688.com/chat';nativeRequired=true;nativeFailure={stage:'space',reason:'Текст изменился при вводе клавиш'};
 await review('https://a.1688.com/');
 assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'blocked');
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
 runtime.onStartup.list[0]();await message('GET');assert.equal(stored.queue[0].needsTabCheck,true);
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
test('FIFO waits for first platform and logs identical wait only once',async()=>{
 reset();stored.slots.push({platform:'alibaba',kind:'visit',at:Date.now()});await message('IMPORT',{text:'https://a.en.alibaba.com/\nhttps://b.1688.com/'});await message('START');await tick();await tick();
 assert.equal(opened.length,0);assert.equal(stored.waiting.jobId,stored.queue[0].id);assert.equal(stored.events.filter(e=>e.type==='wait').length,1);
});
test('no chat within the opening deadline pauses and arms a user lesson without sending',async()=>{
 reset();probeKind='inquiry';await review();await openingTimedOut();assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'blocked');assert.equal(stored.learning.field,'contact');assert.equal(clicks,0);assert.ok(commands.includes('PICK_START'));
});
test('learning is scoped and persisted before the new opener uses the chosen contact',async()=>{
 reset();probeKind='inquiry';await review();await openingTimedOut();const token=stored.learning.token;
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
test('native refused click triggers teaching rather than waiting for a server result',async()=>{
 reset();sendResult=false;await review();await message('APPROVE');await tick();assert.equal(stored.queue[0].status,'blocked');assert.equal(stored.learning.field,'send');assert.ok(!commands.includes('CHECK_SENT'));
});
test('composer changing after approval starts teaching without reserving a send',async()=>{
 reset();await review();prepareOk=false;await message('APPROVE');await tick();assert.equal(clicks,0);assert.equal(stored.learning.field,'send');assert.equal(stored.slots.filter(s=>s.kind==='send').length,0);
});
test('new same-platform iframe receives the active lesson but an unrelated frame does not',async()=>{
 reset();probeKind='inquiry';await review();await openingTimedOut();
 const tabId=stored.queue[0].tabId;await message('TEACH',{field:'editor'});
 await message('PAGE_READY',{}, {id:'test',url:frameUrl,tab:{id:tabId},frameId:3});assert.ok(stored.learning.frameIds.includes(3));
 await message('PAGE_READY',{}, {id:'test',url:'https://other.test/',tab:{id:tabId},frameId:4});assert.ok(!stored.learning.frameIds.includes(4));
});
test('manual recheck after obstacle resumes storefront contact discovery',async()=>{
 reset();probeKind='contact';obstacle={text:'CAPTCHA',dismiss:false};await review();assert.equal(stored.queue[0].status,'blocked');
 obstacle=null;await message('RECHECK');await tick();assert.ok(commands.includes('OPEN_CHAT'));assert.equal(contactClicks,0);
});
test('each reappearance of the known 1688 overlay is dismissed, including at review',async()=>{
 reset();frameUrl='https://13153773601.1688.com/';probeKind='contact';obstacle={text:'CAPTCHA',dismiss:true};await review(frameUrl);
 assert.ok(commands.includes('DISMISS_CHALLENGE'));await tick();assert.equal(contactClicks,1);
 obstacle={text:'CAPTCHA',dismiss:true,key:'second'};await tick();assert.equal(commands.filter(c=>c==='DISMISS_CHALLENGE').length,2);
 probeKind='chat';await tick();assert.equal(stored.queue[0].status,'review');
 obstacle={text:'CAPTCHA',dismiss:true,key:'third'};await message('APPROVE');await tick();assert.equal(clicks,0);
 assert.equal(commands.filter(c=>c==='DISMISS_CHALLENGE').length,3);await tick();assert.equal(clicks,1);
});
test('a close control that does not dismiss its overlay pauses rather than looping',async()=>{
 reset();frameUrl='https://named.1688.com/';obstacle={text:'CAPTCHA',dismiss:true,key:'stuck',stuck:true};
 await review(frameUrl);await tick();await tick();assert.equal(commands.filter(c=>c==='DISMISS_CHALLENGE').length,2);
 assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'blocked');assert.equal(clicks,0);
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

test('1688 ignored click stops the queue and cannot be resumed by START, RECHECK or teaching',async()=>{
 reset();frameUrl='https://air.1688.com/chat';sendResult='unchanged';await review('https://shop.1688.com/');
 await message('IMPORT',{text:'https://next.en.made-in-china.com/'});await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'uncertain');assert.equal(stored.running,false);assert.equal(stored.activeId,stored.queue[0].id);
 for(const [type,extra] of [['START',{}],['RECHECK',{}],['TEACH',{field:'send'}]])assert.equal((await message(type,extra)).ok,false);
 await message('BIND_TAB',{tabId:1});assert.equal(stored.queue[0].status,'uncertain');assert.equal(stored.running,false);
 await tick();assert.equal(clicks,1);assert.equal(opened.length,1);
 const firstAttempt=requests.find(r=>r.type==='SEND').attemptId;
 sendResult=true;assert.equal((await message('RETRY_SEND')).ok,true);await tick();
 assert.equal(stored.queue[0].status,'attempted');assert.equal(clicks,2);assert.notEqual(requests.filter(r=>r.type==='SEND').at(-1).attemptId,firstAttempt);
 assert.equal(stored.slots.filter(s=>s.kind==='send').length,2);
 await tick();assert.equal(opened.at(-1),'https://next.en.made-in-china.com/');
});
test('1688 manual confirmation continues without another click and interrupted sends stay paused across restart',async()=>{
 reset();frameUrl='https://air.1688.com/chat';sendResult='disconnect';await review('https://shop.1688.com/');await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'uncertain');assert.equal(stored.running,false);
 runtime.onStartup.list[0]();await message('GET');assert.equal(stored.queue[0].status,'uncertain');assert.ok(stored.queue[0].needsTabCheck);
 assert.equal((await message('RETRY_SEND')).ok,false);assert.equal((await message('MARK_SENT')).ok,true);
 assert.equal(stored.queue[0].status,'sent');assert.equal(stored.activeId,null);assert.equal(stored.running,true);assert.equal(clicks,1);
});
test('1688 worker recovery retains uncertain operation without opening another supplier',async()=>{
 reset();stored.running=true;stored.activeId='x';stored.queue=[{id:'x',platform:'1688',url:'https://shop.1688.com/',status:'sending'}];
 await tick();assert.equal(stored.queue[0].status,'uncertain');assert.equal(stored.activeId,'x');assert.equal(stored.running,false);assert.equal(clicks,0);
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
 reset();probeKind='inquiry';await review();await openingTimedOut();await message('IMPORT',{text:'https://next.en.made-in-china.com/'});
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

test('1688 unexpected reply after SEND is uncertain and never starts send teaching',async()=>{
 reset();frameUrl='https://air.1688.com/chat';sendResult='malformed';await review('https://shop.1688.com/');await message('APPROVE');await tick();
 assert.equal(stored.queue[0].status,'uncertain');assert.equal(stored.running,false);assert.equal(stored.learning,null);assert.equal(clicks,1);
});

const messenger1688='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=cnalichncurrent&siteid=cnalichn';
async function waitingFor1688Contact() {
 reset();frameUrl='https://current.1688.com/';probeKind='waiting';await review(frameUrl);
 stored.queue[0].stepAt=Date.now()-16000;await tick();
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
 stored.queue[0].stepAt=Date.now()-31000;await tick();assert.equal(stored.learning.field,'editor');assert.equal(stored.running,false);
 probeKind='chat';await message('PAGE_READY',{}, {id:'test',url:messenger1688,tab:{id:1},frameId:0});
 assert.equal(stored.learning,null);assert.equal(stored.queue[0].status,'review');assert.equal(contactClicks,0);
});
test('1688 delayed editor can recover on an alarm without another page-load event',async()=>{
 reset();const store='https://current.1688.com/';stored.chatRoutes[store]={url:messenger1688};frameUrl=messenger1688;probeKind='waiting';
 await review(store);stored.queue[0].stepAt=Date.now()-31000;await tick();assert.equal(stored.learning.field,'editor');
 probeKind='chat';await tick();assert.equal(stored.queue[0].status,'review');assert.equal(stored.learning,null);assert.equal(clicks,0);
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
 assert.equal(contactClicks,0);assert.equal(stored.learning.field,'send');assert.ok(stored.queue[0].chatOpened);
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
test('new opener login/captcha stop requires manual recovery and never asks to train the login button',async()=>{
 await beginSupplierOpening();await openingEvent('blocked',{reason:'Нужен вход в аккаунт'});
 assert.equal(stored.running,false);assert.equal(stored.learning,null);assert.equal(stored.queue[0].status,'blocked');assert.ok(commands.includes('STOP_OPEN_CHAT'));
});
test('opening deadline stops retries and late editor discovery removes automatic teaching',async()=>{
 await beginSupplierOpening();await openingTimedOut();assert.equal(stored.learning.field,'contact');assert.equal(stored.running,false);
 probeKind='chat';await tick();assert.equal(stored.queue[0].status,'review');assert.equal(stored.learning,null);assert.equal(contactClicks,0);
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
test('an unrecognized editor loaded after automatic teaching receives the lesson in its new visible frame',async()=>{
 await beginSupplierOpening();frameProbes.set(0,{kind:'waiting',opened:true,frames:[]});await tick();
 stored.queue[0].stepAt=Date.now()-31000;await tick();assert.equal(stored.learning.field,'editor');
 const chat='https://onetalk.alibaba.com/message/weblite.htm';
 frameList=[{frameId:0,url:frameUrl},{frameId:4,parentFrameId:0,url:chat}];
 frameProbes.set(0,{kind:'waiting',opened:true,frames:[{url:chat,visible:true}]});frameProbes.set(4,{kind:'waiting',opened:true});
 await message('PAGE_READY',{}, {id:'test',url:chat,tab:{id:1},frameId:4});
 assert.equal(stored.learning.field,'editor');assert.ok(stored.learning.frameIds.includes(4));
 assert.ok(deliveries.some(item=>item.type==='PICK_START' && item.frameId===4));assert.equal(stored.running,false);
});
