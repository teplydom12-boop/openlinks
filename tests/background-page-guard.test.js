import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundGuardSource,createBackgroundPage,navigateBackgroundPage,finishBackgroundPage,cancelBackgroundPage,cancelAllBackgroundPages,hasBackgroundPage} from '../extension/lib/background-page-guard.js';

const STORE='https://shop.1688.com/',FRAME='https://air.1688.com/chat';
function harness() {
  const events=[],tabs=new Map(),frames=new Map(),attached=new Set();
  let id=0,fail='',guard={ok:true,urls:[]},onUpdate=null,onGet=null,holdAttach=null;
  const detachListeners=[];
  const api={
    tabs:{
      create:async options=>{events.push(['create',structuredClone(options)]);const tab={id:++id,windowId:options.windowId,url:options.url,status:'complete'};tabs.set(tab.id,tab);return structuredClone(tab);},
      update:async(tabId,options)=>{events.push(['update',tabId,structuredClone(options)]);if(fail==='update')throw new Error('update failed');Object.assign(tabs.get(tabId),options,{status:'loading'});onUpdate?.();return structuredClone(tabs.get(tabId));},
      get:async tabId=>{events.push(['get',tabId]);onGet?.();if(!tabs.has(tabId))throw new Error('tab missing');return structuredClone(tabs.get(tabId));},
      remove:async tabId=>{events.push(['remove',tabId]);tabs.delete(tabId);},
    },
    debugger:{
      onDetach:{addListener:listener=>detachListeners.push(listener)},
      attach:async(target,protocol)=>{events.push(['attach',target,protocol]);if(holdAttach)await holdAttach;if(fail==='attach')throw new Error('attach failed');attached.add(target.tabId);},
      detach:async target=>{events.push(['detach',target]);if(fail==='detach')throw new Error('detach failed');attached.delete(target.tabId);},
      sendCommand:async(target,method,params)=>{events.push([method,target,params]);if(fail===method)throw new Error(method+' failed');return method==='Page.addScriptToEvaluateOnNewDocument'?{identifier:'preload-'+target.tabId}:{};},
    },
    webNavigation:{getAllFrames:async({tabId})=>structuredClone(frames.get(tabId)||[])},
    scripting:{executeScript:async options=>{events.push(['execute',options]);if(fail==='execute')throw new Error('execution denied');const frame=frames.get(options.target.tabId)?.find(frame=>frame.documentId===options.target.documentIds[0]);return [{frameId:frame?.frameId,documentId:frame?.documentId,result:structuredClone(guard)}];}},
  };
  function loaded(tabId=1,url=STORE){Object.assign(tabs.get(tabId),{url,status:'complete'});frames.set(tabId,[{frameId:0,documentId:'doc-main-'+tabId,url},{frameId:2,documentId:'doc-child-'+tabId,url:FRAME},{frameId:3,documentId:'doc-foreign-'+tabId,url:'https://unrelated.example/'}]);}
  return {api,events,tabs,frames,attached,loaded,externalDetach:tabId=>{attached.delete(tabId);for(const listener of detachListeners)listener({tabId},'canceled_by_user');},setFail:value=>fail=value,setGuard:value=>guard=value,setOnGet:value=>onGet=value,setOnUpdate:value=>onUpdate=value,setHoldAttach:value=>holdAttach=value};
}

test('creates inactive blank tab, installs MAIN preload before navigation, verifies exact frames and releases debugger',async()=>{
  const h=harness();
  const tab=await createBackgroundPage({url:STORE,windowId:22},h.api);
  assert.deepEqual(tab,{id:1,windowId:22,url:'about:blank',status:'complete'});
  assert.deepEqual(h.events.map(event=>event[0]),['create','attach','Page.enable','Page.addScriptToEvaluateOnNewDocument','update']);
  assert.deepEqual(h.events[0][1],{url:'about:blank',active:false,windowId:22});
  assert.deepEqual(h.events.at(-1),['update',1,{url:STORE}]);
  const source=h.events.find(event=>event[0]==='Page.addScriptToEvaluateOnNewDocument')[2].source;
  assert.equal(source,backgroundGuardSource('1688.com'));assert.ok(!source.includes(STORE));
  assert.deepEqual(await finishBackgroundPage(1,h.api),{ready:false,documents:[]});
  assert.equal(hasBackgroundPage(1),true);assert.equal(h.attached.size,1);
  h.loaded();
  const reply=await finishBackgroundPage(1,h.api);
  assert.deepEqual(reply,{ready:true,documents:[{tabId:1,frameId:0,documentId:'doc-main-1',pageUrl:STORE},{tabId:1,frameId:2,documentId:'doc-child-1',pageUrl:FRAME}]});
  assert.equal(h.attached.size,0);assert.equal(hasBackgroundPage(1),false);
  assert.deepEqual(h.events.filter(event=>event[0]==='execute').map(event=>event[1].target.documentIds),[['doc-main-1'],['doc-child-1']]);
  assert.deepEqual(h.events.slice(-2).map(event=>event[0]),['Page.removeScriptToEvaluateOnNewDocument','detach']);
  assert.ok(h.events.every(event=>event[0]!=='update'||!Object.hasOwn(event[2],'active')));
  assert.deepEqual(await finishBackgroundPage(1,h.api),{ready:true,documents:[]});
});

test('startup captures are inspected without being persisted or consumed by readiness check',async()=>{
  const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);h.loaded();
  h.setGuard({ok:true,urls:['https://air.1688.com/chat?synthetic-private=sensitive']});
  const ready=await finishBackgroundPage(1,h.api);
  assert.equal(ready.ready,true);assert.ok(!JSON.stringify(ready).includes('sensitive'));
});

for(const failure of ['attach','Page.enable','Page.addScriptToEvaluateOnNewDocument','update'])test('failed creation cleans its owned tab and debugger: '+failure,async()=>{
  const h=harness();h.setFail(failure);
  await assert.rejects(createBackgroundPage({url:STORE,windowId:22},h.api),/failed/);
  assert.equal(h.tabs.size,0);assert.equal(h.attached.size,0);assert.equal(hasBackgroundPage(1),false);
  assert.equal(h.events.filter(event=>event[0]==='remove').length,1);
  if(failure!=='update')assert.ok(!h.events.some(event=>event[0]==='update'));
});

test('unguarded frame or changed exact document fails closed and detaches before returning',async()=>{
  for(const kind of ['guard','document','execute','foreign']){
    const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);h.loaded();
    if(kind==='guard')h.setGuard({ok:false,reason:'guard_missing'});
    if(kind==='document')delete h.frames.get(1)[0].documentId;
    if(kind==='execute')h.setFail('execute');
    if(kind==='foreign')h.tabs.get(1).url='https://different.example/';
    await assert.rejects(finishBackgroundPage(1,h.api));
    assert.equal(h.attached.size,0);assert.equal(hasBackgroundPage(1),false);assert.equal(h.tabs.size,1);
  }
});

test('same-tab re-navigation rearms preload before URL update without activating or closing tab',async()=>{
  const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);
  await navigateBackgroundPage(1,FRAME,h.api);
  const relevant=h.events.filter(event=>['detach','attach','update'].includes(event[0]));
  assert.deepEqual(relevant.map(event=>event[0]),['attach','update','detach','attach','update']);
  assert.deepEqual(relevant.at(-1),['update',1,{url:FRAME}]);
  h.setFail('update');await assert.rejects(navigateBackgroundPage(1,STORE,h.api),/failed/);
  assert.equal(h.tabs.size,1);assert.equal(h.attached.size,0);assert.equal(hasBackgroundPage(1),false);
});

test('pending navigation or changed frame list stays loading without releasing preload',async()=>{
  const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);h.loaded();h.tabs.get(1).pendingUrl=FRAME;
  assert.equal((await finishBackgroundPage(1,h.api)).ready,false);delete h.tabs.get(1).pendingUrl;
  let gets=0;h.setOnGet(()=>{if(++gets===2)h.frames.get(1).push({frameId:4,documentId:'new-frame',url:'https://air.1688.com/new'});});
  assert.equal((await finishBackgroundPage(1,h.api)).ready,false);assert.equal(h.attached.size,1);
  h.setOnGet(null);assert.equal((await finishBackgroundPage(1,h.api)).ready,true);assert.equal(h.attached.size,0);
});

test('pause/skip cancellation is idempotent and releases every tracked session',async()=>{
  const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);await createBackgroundPage({url:STORE,windowId:22},h.api);
  await cancelBackgroundPage(1,h.api);await cancelBackgroundPage(1,h.api);
  assert.equal(h.events.filter(event=>event[0]==='detach'&&event[1].tabId===1).length,1);
  assert.deepEqual(h.events.filter(event=>['Page.stopLoading','Page.removeScriptToEvaluateOnNewDocument','detach'].includes(event[0])&&event[1].tabId===1).map(event=>event[0]),['Page.stopLoading','Page.removeScriptToEvaluateOnNewDocument','detach']);
  await cancelAllBackgroundPages(h.api);assert.equal(h.attached.size,0);assert.equal(hasBackgroundPage(2),false);
  assert.equal(h.tabs.size,2);assert.ok(!h.events.some(event=>event[0]==='remove'));
});

test('cancellation during attach cannot navigate or leak a late debugger attachment',async()=>{
  const h=harness();let release;h.setHoldAttach(new Promise(resolve=>release=resolve));
  const pending=createBackgroundPage({url:STORE,windowId:22},h.api);
  while(!hasBackgroundPage(1))await new Promise(resolve=>setImmediate(resolve));
  const cancelling=cancelBackgroundPage(1,h.api);release();
  await assert.rejects(pending,/отменено/);await cancelling;
  assert.equal(h.attached.size,0);assert.equal(h.tabs.size,0);assert.equal(hasBackgroundPage(1),false);
  assert.ok(!h.events.some(event=>event[0]==='update'));
});

test('detach failure is reported, retained for retry and never returned as readiness',async()=>{
  const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);h.loaded();h.setFail('detach');
  await assert.rejects(finishBackgroundPage(1,h.api),/освободить debugger/);assert.equal(hasBackgroundPage(1),true);
  h.setFail('');await cancelBackgroundPage(1,h.api);assert.equal(hasBackgroundPage(1),false);assert.equal(h.attached.size,0);
});

test('interrupted debugger session fails readiness and removes its ticket without detaching another owner',async()=>{
  const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);h.loaded();h.externalDetach(1);
  await assert.rejects(finishBackgroundPage(1,h.api),/прервана/);
  assert.equal(hasBackgroundPage(1),false);assert.ok(!h.events.some(event=>event[0]==='detach'));
});

test('failed stopLoading retains protection until a successful cancellation retry',async()=>{
  const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);h.setFail('Page.stopLoading');
  await assert.rejects(cancelBackgroundPage(1,h.api),/failed/);assert.equal(hasBackgroundPage(1),true);assert.equal(h.attached.size,1);
  assert.ok(!h.events.some(event=>event[0]==='detach'||event[0]==='Page.removeScriptToEvaluateOnNewDocument'));
  h.setFail('');await cancelBackgroundPage(1,h.api);assert.equal(hasBackgroundPage(1),false);assert.equal(h.attached.size,0);
});

test('loading timeout releases debugger even if the page never becomes complete',async()=>{
  const h=harness();await createBackgroundPage({url:STORE,windowId:22},h.api);
  const realNow=Date.now;Date.now=()=>realNow()+121000;
  try{await assert.rejects(finishBackgroundPage(1,h.api),/две минуты/);}finally{Date.now=realNow;}
  assert.equal(h.attached.size,0);assert.equal(hasBackgroundPage(1),false);
  assert.deepEqual(h.events.slice(-3).map(event=>event[0]),['Page.stopLoading','Page.removeScriptToEvaluateOnNewDocument','detach']);
});

test('untrusted code and unsupported URLs never enter a preload source or create a tab',async()=>{
  const h=harness();
  for(const url of ['javascript:alert(1)','https://unrelated.example/','https://user:password@shop.1688.com/','https://shop.1688.com:444/'])await assert.rejects(createBackgroundPage({url,windowId:22},h.api));
  assert.equal(h.events.length,0);assert.throws(()=>backgroundGuardSource('1688.com";window.open("evil")'));
});
