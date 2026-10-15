import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../extension/lib/core.js';

const listener=()=>{const list=[];return {list,addListener(fn){list.push(fn);}};};
let stored=initialState(), tabCount=0, clicks=0, confirmed=false, beforeClick, tabMissing=false;
const runtime={onMessage:listener(),onStartup:listener(),onInstalled:listener(),getURL:path=>'chrome-extension://test/'+path};
const alarms={onAlarm:listener(),create:async()=>{}};
globalThis.chrome={
  runtime,alarms,storage:{local:{get:async()=>({openlinksState:structuredClone(stored)}),set:async data=>{stored=structuredClone(data.openlinksState);}}},
  tabs:{onUpdated:listener(),onCreated:listener(),create:async()=>({id:++tabCount}),update:async()=>{},
    sendMessage:async(tab,data)=>{
      if(data.type==='PROBE') return {kind:'form'};
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
