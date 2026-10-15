import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../extension/lib/core.js';
const listener=()=>{const list=[];return {list,addListener(fn){list.push(fn);}};};
let stored,clicks,contactClicks,commands,beforeClick,probeKind,sendResult,frameUrl,tabCount,opened,missing,obstacle,prepareOk;
const runtime={onMessage:listener(),onStartup:listener(),onInstalled:listener(),getURL:path=>'chrome-extension://test/'+path};
const alarms={onAlarm:listener(),create:async()=>{}};
globalThis.chrome={runtime,alarms,storage:{local:{get:async()=>({openlinksState:structuredClone(stored)}),set:async data=>{stored=structuredClone(data.openlinksState);}}},
 tabs:{onUpdated:listener(),onCreated:listener(),create:async data=>{opened.push(data.url);return {id:++tabCount};},update:async()=>{},query:async()=>[],get:async id=>({id,url:frameUrl}),
 sendMessage:async(tab,data)=>{
  commands.push(data.type);
  if(data.type==='PROBE')return {kind:probeKind,obstacle:obstacle?.text,canDismiss:obstacle?.dismiss,reason:probeKind==='inquiry'?'Форма запроса, нужен чат':undefined};
  if(data.type==='PREPARE')return {ok:prepareOk,pageUrl:frameUrl,reason:prepareOk?undefined:'Редактор изменился'};
  if(data.type==='SEND'){clicks++;beforeClick=structuredClone(stored);if(sendResult==='disconnect')throw new Error('Disconnected');return {clicked:sendResult!==false,reason:'Кнопка изменилась'};}
  if(data.type==='CONTACT'){contactClicks++;return {ok:true};}
  if(data.type==='DISMISS_CHALLENGE'){obstacle=null;return {clicked:true};}
  return {ok:true};
 }},webNavigation:{getAllFrames:async()=>{if(missing)throw new Error('No tab');return [{frameId:0,url:frameUrl}];}},action:{onClicked:listener()},windows:{}};
await import('../extension/background.js');
const ui={id:'test',url:'chrome-extension://test/dashboard.html'};
const message=(type,extra={},sender=ui)=>new Promise(resolve=>runtime.onMessage.list[0]({type,...extra},sender,resolve));
async function tick(){alarms.onAlarm.list[0]({name:'openlinks-tick'});await message('GET');}
function reset(){stored=initialState();stored.settings.message='Hello';clicks=0;contactClicks=0;commands=[];beforeClick=null;probeKind='chat';sendResult=true;frameUrl='https://a.en.alibaba.com/chat';tabCount=0;opened=[];missing=false;obstacle=null;prepareOk=true;}
async function review(url='https://a.en.alibaba.com/'){await message('IMPORT',{text:url});await message('START');await tick();await tick();}

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
test('unknown inquiry pauses and arms a user lesson without clicking',async()=>{
 reset();probeKind='inquiry';await review();assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'blocked');assert.equal(stored.learning.field,'contact');assert.equal(clicks,0);assert.ok(commands.includes('PICK_START'));
});
test('learning is scoped, persisted and replays the chosen contact only once',async()=>{
 reset();probeKind='inquiry';await review();const token=stored.learning.token;
 const sender={id:'test',url:frameUrl,tab:{id:stored.queue[0].tabId},frameId:0};
 assert.equal((await message('LEARN_PICK',{token:'wrong',field:'contact',selector:'#contact'},sender)).ok,false);
 const reply=await message('LEARN_PICK',{token,field:'contact',selector:'#contact',tag:'button',label:'Chat'},sender);
 assert.equal(reply.ok,true);assert.equal(stored.rules.length,1);assert.equal(stored.learning,null);assert.equal(contactClicks,1);
 assert.equal((await message('LEARN_PICK',{token,field:'contact',selector:'#contact'},sender)).ok,false);assert.equal(contactClicks,1);
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
 reset();probeKind='inquiry';await review();
 const tabId=stored.queue[0].tabId;
 await message('PAGE_READY',{}, {id:'test',url:frameUrl,tab:{id:tabId},frameId:3});assert.ok(stored.learning.frameIds.includes(3));
 await message('PAGE_READY',{}, {id:'test',url:'https://other.test/',tab:{id:tabId},frameId:4});assert.ok(!stored.learning.frameIds.includes(4));
});
test('manual recheck after obstacle resumes storefront contact discovery',async()=>{
 reset();probeKind='contact';obstacle={text:'CAPTCHA',dismiss:false};await review();assert.equal(stored.queue[0].status,'blocked');
 obstacle=null;await message('RECHECK');await tick();assert.equal(contactClicks,1);
});
test('known 1688 close control is clicked once and contact discovery continues',async()=>{
 reset();frameUrl='https://13153773601.1688.com/';probeKind='contact';obstacle={text:'CAPTCHA',dismiss:true};await review(frameUrl);
 assert.ok(commands.includes('DISMISS_CHALLENGE'));await tick();assert.equal(contactClicks,1);assert.equal(stored.queue[0].dismissedChallenge,true);
});
test('about:blank popup is adopted after navigation; unrelated tabs are not adopted',async()=>{
 reset();frameUrl='https://13153773601.1688.com/';probeKind='contact';await review(frameUrl);
 chrome.tabs.onCreated.list[0]({id:20,openerTabId:1,pendingUrl:'about:blank'});await message('GET');assert.equal(stored.queue[0].tabId,1);
 frameUrl='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=supplier-a&siteid=cnalichn';
 chrome.tabs.onUpdated.list[0](20,{url:frameUrl},{id:20,url:frameUrl});await message('GET');assert.equal(stored.queue[0].tabId,20);assert.ok(stored.chatRoutes[stored.queue[0].url]);
 chrome.tabs.onUpdated.list[0](21,{url:frameUrl},{id:21,url:frameUrl});await message('GET');assert.equal(stored.queue[0].tabId,20);
});
test('direct chat cache is keyed to the exact storefront, never a supplier template',async()=>{
 reset();const store='https://13153773601.1688.com/';const chat='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=supplier-a';
 stored.chatRoutes[store]={url:chat};await message('IMPORT',{text:store});await message('START');await tick();assert.equal(opened[0],chat);
 reset();stored.chatRoutes[store]={url:chat};await message('IMPORT',{text:'https://999999.1688.com/'});await message('START');await tick();assert.equal(opened[0],'https://999999.1688.com/');
});
test('update during sending finalizes an unknown attempt and preserves quota',async()=>{
 reset();stored.running=true;stored.activeId='x';stored.queue=[{id:'x',platform:'alibaba',url:frameUrl,status:'sending'}];stored.slots=[{platform:'alibaba',kind:'send',at:Date.now()}];
 runtime.onInstalled.list[0]({reason:'update'});await message('GET');assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(stored.slots.length,1);assert.equal(stored.activeId,null);assert.equal(stored.running,false);
});
