import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialState} from '../extension/lib/core.js';
const listener=()=>{const list=[];return {list,addListener(fn){list.push(fn);}};};
let stored,clicks,contactClicks,commands,requests,beforeClick,probeKind,sendResult,frameUrl,tabCount,opened,missing,obstacle,prepareOk,lookupPages,fetches,probeRoute,updated,probeKey;
const metadataFixture=readFileSync(new URL('./fixtures/1688-metadata.html',import.meta.url),'utf8');
globalThis.fetch=async(url,options)=>{fetches.push({url,credentials:options.credentials});const html=lookupPages.get(url);if(html===undefined)throw new Error('No local metadata fixture');return new Response(html,{headers:{'content-type':'text/html'}});};
const runtime={onMessage:listener(),onStartup:listener(),onInstalled:listener(),getURL:path=>'chrome-extension://test/'+path};
const alarms={onAlarm:listener(),create:async()=>{}};
globalThis.chrome={runtime,alarms,storage:{local:{get:async()=>({openlinksState:structuredClone(stored)}),set:async data=>{stored=structuredClone(data.openlinksState);}}},
 tabs:{onUpdated:listener(),onCreated:listener(),create:async data=>{opened.push(data.url);return {id:++tabCount};},update:async(id,data)=>{updated.push({id,...data});},query:async()=>[],get:async id=>({id,url:frameUrl}),
 sendMessage:async(tab,data)=>{
  commands.push(data.type);
  requests.push(structuredClone(data));
  if(data.type==='PROBE')return {kind:probeKind,key:probeKey,chatRoute:probeRoute,obstacle:obstacle?.text,canDismiss:obstacle?.dismiss,dismissKey:obstacle?.key,reason:probeKind==='inquiry'?'Форма запроса, нужен чат':undefined};
  if(data.type==='PREPARE')return {ok:prepareOk,pageUrl:frameUrl,reason:prepareOk?undefined:'Редактор изменился'};
  if(data.type==='SEND'){clicks++;beforeClick=structuredClone(stored);if(sendResult==='disconnect')throw new Error('Disconnected');if(sendResult==='malformed')return {ok:false};return {clicked:sendResult!==false,accepted:sendResult===true,reason:'Кнопка изменилась'};}
  if(data.type==='CONTACT'){contactClicks++;return {ok:true,key:probeKey};}
  if(data.type==='DISMISS_CHALLENGE'){if(obstacle?.stuck)return {clicked:true,closed:false};obstacle=null;return {clicked:true,closed:true};}
  return {ok:true};
 }},webNavigation:{getAllFrames:async()=>{if(missing)throw new Error('No tab');return [{frameId:0,url:frameUrl}];}},action:{onClicked:listener()},windows:{}};
await import('../extension/background.js');
const ui={id:'test',url:'chrome-extension://test/dashboard.html'};
const message=(type,extra={},sender=ui)=>new Promise(resolve=>runtime.onMessage.list[0]({type,...extra},sender,resolve));
async function tick(){alarms.onAlarm.list[0]({name:'openlinks-tick'});await message('GET');}
function reset(){stored=initialState();stored.settings.message='Hello';clicks=0;contactClicks=0;commands=[];requests=[];beforeClick=null;probeKind='chat';sendResult=true;frameUrl='https://a.en.alibaba.com/chat';tabCount=0;opened=[];missing=false;obstacle=null;prepareOk=true;lookupPages=new Map();fetches=[];probeRoute=null;updated=[];probeKey='#contact';}
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
test('subsequent learned contact steps run once each on Alibaba and Made-in-China',async()=>{
 for(const url of ['https://a.trustpass.alibaba.com/','https://a.en.made-in-china.com/']) {
  reset();frameUrl=url;probeKind='contact';probeKey='a.shop-chat';await review(url);assert.equal(contactClicks,1);
  await tick();assert.equal(contactClicks,1);
  probeKey='div[aria-label="tm"]';await tick();assert.equal(contactClicks,2);assert.equal(stored.queue[0].status,'contacting');
  await tick();assert.equal(contactClicks,2);assert.equal(stored.learning,null);
  probeKind='chat';await tick();assert.equal(stored.queue[0].status,'review');
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
 reset();probeKind='inquiry';await review();await message('IMPORT',{text:'https://next.en.made-in-china.com/'});
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
