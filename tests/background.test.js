import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../extension/lib/core.js';

const listener=()=>{const list=[];return {list,addListener(fn){list.push(fn);}};};
let stored=initialState(), tabCount=0, clicks=0, confirmed=false, beforeClick, tabMissing=false, probeKind='chat';
const runtime={onMessage:listener(),onStartup:listener(),onInstalled:listener(),getURL:path=>'chrome-extension://test/'+path};
const alarms={onAlarm:listener(),create:async()=>{}};
globalThis.chrome={
  runtime,alarms,storage:{local:{get:async()=>({openlinksState:structuredClone(stored)}),set:async data=>{stored=structuredClone(data.openlinksState);}}},
  tabs:{onUpdated:listener(),onCreated:listener(),create:async()=>({id:++tabCount}),update:async()=>{},
    sendMessage:async(tab,data)=>{
      if(data.type==='PROBE') return {kind:probeKind,reason:probeKind==='inquiry'?'Найдена форма запроса, нужен чат.':undefined};
      if(data.type==='PREPARE') return {ok:true,pageUrl:'https://a.alibaba.com/chat',evidence:{successes:[],outgoing:0}};
      if(data.type==='SEND') { clicks++;beforeClick=structuredClone(stored);throw new Error('Channel disconnected after click'); }
      if(data.type==='CHECK_SENT') return {confirmed};
    }},
  webNavigation:{getAllFrames:async()=>{if(tabMissing) throw new Error('No tab');return [{frameId:0,url:'https://a.alibaba.com/chat'}];}},
  action:{onClicked:listener()},windows:{},
};
await import('../extension/background.js');
const ui={id:'test',url:'chrome-extension://test/dashboard.html'};
function message(type,extra={},sender=ui) {
  return new Promise(resolve=>runtime.onMessage.list[0]({type,...extra},sender,resolve));
}
async function tick() {
  alarms.onAlarm.list[0]({name:'openlinks-tick'});
  await message('GET'); // A barrier after the serialized alarm handler.
}
test('coordinator persists limits before side effects; disconnect and worker resume never resend',async()=>{
  stored=initialState();stored.settings.message='Hello';
  assert.equal((await message('IMPORT',{text:'https://a.alibaba.com/'})).added,1);
  assert.equal((await message('START')).ok,true);
  await tick();assert.equal(tabCount,1);assert.equal(stored.slots.filter(s=>s.kind==='visit').length,1);
  await tick(); assert.equal(stored.queue[0].status,'review');assert.equal(clicks,0);
  await message('APPROVE');await tick();
  assert.equal(clicks,1);assert.equal(beforeClick.queue[0].status,'sending');
  assert.equal(beforeClick.slots.filter(s=>s.kind==='send').length,1);
  await tick();await tick();assert.equal(clicks,1);
  confirmed=true;await tick();assert.equal(stored.queue[0].status,'sent');assert.equal(stored.activeId,null);
});
test('unconfirmed click stops queue and can only be resolved explicitly',async()=>{
  stored=initialState();stored.settings.message='Hello';confirmed=false;
  await message('IMPORT',{text:'https://a.alibaba.com/'});await message('START');await tick();await tick();
  await message('APPROVE');await tick();
  stored.queue[0].sendAt=Date.now()-60000;
  await tick();assert.equal(stored.queue[0].status,'uncertain');assert.equal(stored.running,false);
  assert.equal((await message('START')).ok,false);assert.equal((await message('RECHECK')).ok,false);
  assert.equal((await message('MARK_SENT')).ok,true);assert.equal(stored.queue[0].status,'sent');
});
test('browser restart pauses a pending send as uncertain',async()=>{
  stored=initialState();stored.running=true;stored.activeId='x';stored.queue=[{id:'x',status:'sending',url:'https://a.alibaba.com/'}];
  runtime.onStartup.list[0]();await message('GET');
  assert.equal(stored.running,false);assert.equal(stored.queue[0].status,'uncertain');
});
test('automatic mode requires calibrated selectors and sites cannot call UI commands',async()=>{
  stored=initialState();stored.settings.message='Hello';stored.settings.review=false;
  await message('IMPORT',{text:'https://a.alibaba.com/'});
  assert.equal((await message('START')).ok,false);
  assert.equal((await message('START',{}, {url:'https://a.alibaba.com/',tab:{id:1}})).ok,false);
  assert.equal(stored.running,false);
});
test('pausing prevents a queued job from opening',async()=>{
  stored=initialState();stored.settings.message='Hello';
  await message('IMPORT',{text:'https://b.alibaba.com/'});await message('START');await message('PAUSE');
  const before=tabCount;await tick();assert.equal(tabCount,before);
});
test('closed tab during send cannot be rechecked into a duplicate send',async()=>{
  stored=initialState();stored.settings.message='Hello';confirmed=false;
  await message('IMPORT',{text:'https://a.alibaba.com/'});await message('START');await tick();await tick();
  await message('APPROVE');await tick();const before=clicks;
  tabMissing=true;
  try {
    await tick();assert.equal(stored.queue[0].status,'uncertain');assert.equal(stored.running,false);
    assert.equal((await message('RECHECK')).ok,false);await tick();assert.equal(clicks,before);
  } finally {tabMissing=false;}
});
test('waiting for first item does not open a later available platform and is logged once',async()=>{
  stored=initialState();stored.settings.message='Hello';
  stored.slots.push({platform:'alibaba',kind:'visit',at:Date.now()});
  await message('IMPORT',{text:'https://a.alibaba.com/\nhttps://b.1688.com/'});await message('START');
  const before=tabCount;
  await tick();await tick();
  assert.equal(tabCount,before);assert.equal(stored.waiting.jobId,stored.queue[0].id);
  assert.match(stored.waiting.detail,/Соседние/);
  assert.equal(stored.events.filter(e=>e.type==='wait').length,1);
});
test('inquiry response halts without preparing or sending and records the diagnosis',async()=>{
  stored=initialState();stored.settings.message='Hello';probeKind='inquiry';
  try {
    const before=clicks;
    await message('IMPORT',{text:'https://a.alibaba.com/'});await message('START');await tick();await tick();
    assert.equal(stored.queue[0].status,'blocked');assert.equal(stored.running,false);assert.equal(clicks,before);
    assert.match(stored.events.find(e=>e.type==='dom_scan').detail,/inquiry/);
    assert.equal(stored.events.at(-1).level,'error');
  } finally {probeKind='chat';}
});
test('successful chat lifecycle logs decisions, observations, approval and send attempt',async()=>{
  stored=initialState();stored.settings.message='Hello';confirmed=true;
  await message('IMPORT',{text:'https://a.alibaba.com/'});await message('START');await tick();await tick();
  await message('APPROVE');await tick();await tick();
  for(const type of ['decision','visit','page_opened','dom_scan','chat_ready','draft_ready','approved','send_attempt','send_disconnect','sent']) {
    assert.ok(stored.events.some(event=>event.type===type),`missing ${type}`);
  }
});
