import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../extension/lib/core.js';
const listener=()=>{const list=[];return {list,addListener(fn){list.push(fn);}};};
let stored,clicks,contactClicks,commands,requests,beforeClick,probeKind,sendResult,frameUrl,tabCount,opened,missing,obstacle,prepareOk;
const runtime={onMessage:listener(),onStartup:listener(),onInstalled:listener(),getURL:path=>'chrome-extension://test/'+path};
const alarms={onAlarm:listener(),create:async()=>{}};
globalThis.chrome={runtime,alarms,storage:{local:{get:async()=>({openlinksState:structuredClone(stored)}),set:async data=>{stored=structuredClone(data.openlinksState);}}},
 tabs:{onUpdated:listener(),onCreated:listener(),create:async data=>{opened.push(data.url);return {id:++tabCount};},update:async()=>{},query:async()=>[],get:async id=>({id,url:frameUrl}),
 sendMessage:async(tab,data)=>{
  commands.push(data.type);
  requests.push(structuredClone(data));
  if(data.type==='PROBE')return {kind:probeKind,obstacle:obstacle?.text,canDismiss:obstacle?.dismiss,dismissKey:obstacle?.key,reason:probeKind==='inquiry'?'Форма запроса, нужен чат':undefined};
  if(data.type==='PREPARE')return {ok:prepareOk,pageUrl:frameUrl,reason:prepareOk?undefined:'Редактор изменился'};
  if(data.type==='SEND'){clicks++;beforeClick=structuredClone(stored);if(sendResult==='disconnect')throw new Error('Disconnected');return {clicked:sendResult!==false,reason:'Кнопка изменилась'};}
  if(data.type==='CONTACT'){contactClicks++;return {ok:true};}
  if(data.type==='DISMISS_CHALLENGE'){if(obstacle?.stuck)return {clicked:true,closed:false};obstacle=null;return {clicked:true,closed:true};}
  return {ok:true};
 }},webNavigation:{getAllFrames:async()=>{if(missing)throw new Error('No tab');return [{frameId:0,url:frameUrl}];}},action:{onClicked:listener()},windows:{}};
await import('../extension/background.js');
const ui={id:'test',url:'chrome-extension://test/dashboard.html'};
const message=(type,extra={},sender=ui)=>new Promise(resolve=>runtime.onMessage.list[0]({type,...extra},sender,resolve));
async function tick(){alarms.onAlarm.list[0]({name:'openlinks-tick'});await message('GET');}
function reset(){stored=initialState();stored.settings.message='Hello';clicks=0;contactClicks=0;commands=[];requests=[];beforeClick=null;probeKind='chat';sendResult=true;frameUrl='https://a.en.alibaba.com/chat';tabCount=0;opened=[];missing=false;obstacle=null;prepareOk=true;}
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
test('direct chat cache is keyed to the exact storefront, never a supplier template',async()=>{
 reset();const store='https://13153773601.1688.com/';const chat='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=supplier-a';
 stored.chatRoutes[store]={url:chat};await message('IMPORT',{text:store});await message('START');await tick();assert.equal(opened[0],chat);
 reset();stored.chatRoutes[store]={url:chat};await message('IMPORT',{text:'https://999999.1688.com/'});await message('START');await tick();assert.equal(opened[0],'https://999999.1688.com/');
});
test('the user provided keyangjixie mapping opens directly without a previous cache entry',async()=>{
 reset();await message('IMPORT',{text:'https://keyangjixie.1688.com/'});await message('START');await tick();
 const chat=new URL(opened[0]);assert.equal(chat.hostname,'air.1688.com');assert.equal(chat.searchParams.get('touid'),'cnalichn山东科阳重工机械');assert.equal(chat.hash,'#/');
 assert.equal(stored.queue[0].status,'contacting');assert.equal(contactClicks,0);
});
test('update during sending finalizes an unknown attempt and preserves quota',async()=>{
 reset();stored.running=true;stored.activeId='x';stored.queue=[{id:'x',platform:'alibaba',url:frameUrl,status:'sending'}];stored.slots=[{platform:'alibaba',kind:'send',at:Date.now()}];
 runtime.onInstalled.list[0]({reason:'update'});await message('GET');assert.equal(stored.queue[0].status,'attempt_unknown');assert.equal(stored.slots.length,1);assert.equal(stored.activeId,null);assert.equal(stored.running,false);
});
