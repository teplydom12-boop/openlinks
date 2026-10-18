import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {diagnosticOptions,platformForURL,safeDiagnosticURL,sanitizeSnapshot,captureSanitizedDOM,captureAlibabaHookShapes,readNextConversation,revealSelectedConversation,openMadeInChinaInbox,collectDiagnostics,downloadDiagnostics} from '../extension/diagnostics.js';

function mock({pause=true,attached=false,frameError=false,tabs,frames}={}) {
  const calls=[];
  const chrome={runtime:{sendMessage:async data=>{calls.push(['pause',data]);return {ok:pause};},getURL:path=>'chrome-extension://test/'+path},tabs:{query:async data=>{calls.push(['tabs',data]);return tabs||[{id:4,url:'https://air.1688.com/chat?token=hidden&touid=recipient'}];}},debugger:{
    attach:async(target,version)=>{calls.push(['attach',target,version]);if(attached)throw new Error('Private sensitive failure');},
    detach:async target=>calls.push(['detach',target]),
    sendCommand:async(target,method,args)=>{calls.push([method,target,args]);
      if(method==='Page.getFrameTree')return {frameTree:frames||{frame:{id:'top',url:'https://air.1688.com/chat?token=hidden'},childFrames:[{frame:{id:'same',url:'https://chat.1688.com/nested'}},{frame:{id:'foreign',url:'https://evil.test/'}}]}};
      if(method==='Page.createIsolatedWorld'){if(frameError && args.frameId==='top')throw new Error('Private sensitive exception');return {executionContextId:args.frameId==='top'?10:20};}
      if(method==='Runtime.evaluate')return {result:{type:'object',value:{status:'ready',url:'https://air.1688.com/chat?token=secret&touid=cn123',html:'<div>Hello</div>',conversations:[]}}};
      throw new Error('Unexpected method');
    }
  }};
  return {chrome,calls,settle:async()=>{}};
}
test('diagnostic URL accepts fixed modes and numeric tab filter only; arbitrary code is ignored',()=>{
  assert.deepEqual(diagnosticOptions('?run=1&mode=snapshot&tabId=42&code=alert(1)'),{mode:'snapshot',tabId:42,run:true});
  assert.deepEqual(diagnosticOptions('?mode=evil&run=yes'),{mode:'dom',tabId:null,run:false});
  assert.throws(()=>diagnosticOptions('?tabId=1;alert(1)'));assert.throws(()=>diagnosticOptions('?tabId=-2'));
});
test('recognized sites are exact HTTPS platform domains and metadata excludes credentials/tokens',()=>{
  assert.equal(platformForURL('https://shop.en.alibaba.com/'),'alibaba');assert.equal(platformForURL('https://x.en.made-in-china.com/'),'mic');
  for(const value of ['https://1688.com.evil.test/','http://shop.1688.com/','https://user:password@shop.1688.com/'])assert.equal(platformForURL(value),null);
  assert.equal(safeDiagnosticURL('https://u:p@air.1688.com/chat?touid=buyer&token=secret&spm=tracking#secret'),'https://air.1688.com/chat?touid=buyer');
  assert.equal(safeDiagnosticURL('javascript:alert(1)'),'');
  assert.equal(safeDiagnosticURL('','https://membercenter.made-in-china.com/message/index.html'),'');
});
test('pause refusal causes a partial export with no tabs, debugger, or content access',async()=>{
  const env=mock({pause:false}),report=await collectDiagnostics({},env);assert.equal(report.paused,false);assert.equal(report.errors[0].code,'outreach_pause_failed');assert.deepEqual(env.calls.map(call=>call[0]),['pause']);
});
test('DOM collection only reads same-platform frames, attaches sequentially and detaches owned target',async()=>{
  const env=mock(),report=await collectDiagnostics({},env);assert.equal(report.paused,true);assert.equal(report.frames,2);assert.equal(report.tabs[0].frames.length,2);
  assert.deepEqual(env.calls.map(call=>call[0]),['pause','tabs','attach','Page.getFrameTree','Page.createIsolatedWorld','Runtime.evaluate','Page.createIsolatedWorld','Runtime.evaluate','detach']);
  const evaluation=env.calls.find(call=>call[0]==='Runtime.evaluate')[2];assert.equal(evaluation.returnByValue,true);assert.equal(evaluation.contextId,10);assert.ok(evaluation.expression.startsWith('(function captureSanitizedDOM'));
  assert.equal(report.tabs[0].url,'https://air.1688.com/chat?touid=recipient');
});
test('already attached debugger is never detached by this diagnostic page',async()=>{
  const env=mock({attached:true}),report=await collectDiagnostics({},env);assert.equal(report.tabs[0].errors[0].code,'debugger_attach_failed');assert.equal(env.calls.some(call=>call[0]==='detach'),false);
  assert.ok(!JSON.stringify(report).includes('Private sensitive'));
});
test('frame errors preserve other partial results and owned debugger detaches in finally',async()=>{
  const env=mock({frameError:true}),report=await collectDiagnostics({},env);assert.equal(report.tabs[0].frames[0].error,'frame_capture_failed');assert.ok(report.tabs[0].frames[1].data);
  assert.equal(env.calls.at(-1)[0],'detach');assert.ok(!JSON.stringify(report).includes('Private sensitive'));
});
test('snapshot mode evaluates only fixed local production reader and sanitizes result URLs',async()=>{
  const env=mock();let requested;
  env.fetch=async(url,options)=>{requested={url,options};return {ok:true,text:async()=>'(function(){globalThis.OpenLinksDialogsReader={snapshot(){return {}}};})();'};};
  const report=await collectDiagnostics({mode:'snapshot'},env);assert.equal(requested.url,'chrome-extension://test/dialogs-content.js');assert.equal(requested.options.cache,'no-store');
  const evaluation=env.calls.find(call=>call[0]==='Runtime.evaluate')[2];assert.ok(evaluation.expression.endsWith('globalThis.OpenLinksDialogsReader.snapshot();'));
  assert.equal(report.tabs[0].frames[0].data.url,'https://air.1688.com/chat?touid=cn123');assert.equal(JSON.stringify(report).includes('token='),false);
});
test('missing local reader does not attach and is reported without raw exception content',async()=>{
  const env=mock();env.fetch=async()=>{throw new Error('secret path');};const report=await collectDiagnostics({mode:'snapshot'},env);assert.equal(report.errors[0].code,'local_reader_unavailable');assert.equal(env.calls.some(call=>call[0]==='attach'),false);
});
test('global frame bound and tab filter prevent unbounded browser traversal',async()=>{
  const frames={frame:{id:'0',url:'https://air.1688.com/chat'},childFrames:Array.from({length:30},(_,i)=>({frame:{id:String(i+1),url:'https://air.1688.com/frame'}}))};
  const env=mock({frames,tabs:[{id:2,url:'https://x.alibaba.com/'},{id:4,url:'https://air.1688.com/chat'},{id:9,url:'https://example.com/'}]});
  const report=await collectDiagnostics({tabId:4},env);assert.equal(report.tabs.length,1);assert.equal(report.frames,12);assert.equal(report.limited,true);assert.equal(env.calls.filter(call=>call[0]==='Runtime.evaluate').length,12);
});
test('snapshot recursive sanitization removes credentials without removing thread identity or document token',()=>{
  const clean=sanitizeSnapshot({documentToken:'localrandom',token:'secret',conversations:[{id:'peer:cn123',text:'Visit https://shop.1688.com/path?token=hidden&touid=recipient',authorization:'secret'}],frames:[{url:'https://air.1688.com/?session=hidden'}]});
  assert.equal(clean.documentToken,'localrandom');assert.equal(clean.token,undefined);assert.equal(clean.conversations[0].id,'peer:cn123');assert.equal(clean.conversations[0].authorization,undefined);
  assert.equal(JSON.stringify(clean).includes('hidden'),false);
});
function element(tag,attrs={},children=[]) {
  return {nodeType:1,tagName:tag.toUpperCase(),id:attrs.id||'',className:attrs.class||'',attributes:Object.entries(attrs).map(([name,value])=>({name,value})),childNodes:children,hidden:attrs.hidden!==undefined,isContentEditable:attrs.contenteditable==='true',getAttribute(name){return attrs[name]??null;}};
}
const text=value=>({nodeType:3,nodeValue:value});
test('actual DOM serializer retains selector structure and visible chat but removes scripts and all editable values',()=>{
  const old={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle};
  try{
    globalThis.location={href:'https://air.1688.com/chat?token=private&touid=recipient'};
    globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
    globalThis.document={title:'Chat',readyState:'complete',body:element('body',{},[
      element('script',{},[text('private script')]),element('div',{'data-message-id':'m42',class:'message inbound','data-token':'private token',onclick:'private handler'},[text('Supplier says hello')]),
      element('input',{value:'private input',type:'password'}),element('textarea',{},[text('private textarea')]),element('pre',{class:'edit',contenteditable:'true'},[text('private draft')]),
      element('iframe',{src:'https://air.1688.com/frame?token=private&touid=peer'},[text('private iframe child')]),element('iframe',{src:''}),element('a',{href:'https://shop.1688.com/?token=private&touid=peer'},[text('Chat')]),element('div',{hidden:''},[text('private hidden')])
    ])};
    const value=captureSanitizedDOM(),serialized=JSON.stringify(value);assert.ok(value.html.includes('data-message-id="m42"'));assert.ok(value.html.includes('class="edit"'));assert.ok(value.visibleText.includes('Supplier says hello'));
    assert.equal(serialized.includes('private'),false);assert.equal(value.iframes.length,2);assert.equal(value.iframes[0].src,'https://air.1688.com/frame?touid=peer');assert.equal(value.iframes[1].src,'');
    assert.equal(value.url,'https://air.1688.com/chat?touid=recipient');
  }finally{for(const [name,value] of Object.entries(old))if(value===undefined)delete globalThis[name];else globalThis[name]=value;}
});
test('diagnostics code has no input, navigation or message-send command; page loads only local script',async()=>{
  const js=await readFile(new URL('../extension/diagnostics.js',import.meta.url),'utf8'),html=await readFile(new URL('../extension/diagnostics.html',import.meta.url),'utf8');
  assert.equal(/Input\.(?:dispatch|insert)|Page\.navigate|tabs\.(?:update|create|remove)|type:\s*['"](?:SEND|PREPARE|START|OPEN_CONTACT)/.test(js),false);
  assert.ok(html.includes('src="diagnostics.js"'));assert.equal(/https?:\/\//.test(html),false);
});
test('one diagnostic download contains real gzip JSON with a predictable safe filename',async()=>{
  const old={document:globalThis.document,create:URL.createObjectURL,revoke:URL.revokeObjectURL,timeout:globalThis.setTimeout};let blob,clicks=0,appends=0;
  try {
    URL.createObjectURL=value=>{blob=value;return 'blob:test';};URL.revokeObjectURL=()=>{};globalThis.setTimeout=()=>0;
    globalThis.document={createElement:()=>({click(){clicks++;},remove(){}}),body:{append(){appends++;}}};
    const report={mode:'dom',tabs:[],errors:[],message:'Проверка'};
    const filename=await downloadDiagnostics(report);assert.match(filename,/^openlinks-diagnostics-dom-\d+\.json\.gz$/);assert.equal(clicks,1);assert.equal(appends,1);
    const decoded=await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).json();assert.deepEqual(decoded,report);
  } finally {if(old.document===undefined)delete globalThis.document;else globalThis.document=old.document;URL.createObjectURL=old.create;URL.revokeObjectURL=old.revoke;globalThis.setTimeout=old.timeout;}
});
test('read-next mode requires a specific tab and cannot default to all tabs',async()=>{
  assert.throws(()=>diagnosticOptions('?mode=read-next'));
  assert.deepEqual(diagnosticOptions('?run=1&mode=read-next&tabId=4'),{run:true,mode:'read-next',tabId:4});
  const env=mock(),report=await collectDiagnostics({mode:'read-next'},env);assert.equal(report.errors[0].code,'targeted_action_requires_tab_id');assert.equal(env.calls.length,0);
});
test('hooks mode reads only Alibaba main world and never creates isolated worlds or accesses other platforms',async()=>{
  const env=mock({tabs:[{id:1,url:'https://air.1688.com/'},{id:2,url:'https://message.alibaba.com/'}],frames:{frame:{id:'top',url:'https://message.alibaba.com/'},childFrames:[{frame:{id:'child',url:'https://message.alibaba.com/child'}}]}});
  const report=await collectDiagnostics({mode:'hooks'},env);assert.equal(report.tabs.length,1);assert.equal(report.frames,1);
  assert.equal(env.calls.some(call=>call[0]==='Page.createIsolatedWorld'),false);const evaluation=env.calls.find(call=>call[0]==='Runtime.evaluate')[2];assert.equal('contextId' in evaluation,false);assert.ok(evaluation.expression.startsWith('(function captureAlibabaHookShapes'));
});
test('React hooks reveal own names and types without primitive values or executing getters',()=>{
  const old=globalThis.document;let getterCalls=0;
  try {
    const props={contact:{id:'private supplier',messages:['private message']},password:'private password',onClick(){throw new Error('Must never execute');}};
    Object.defineProperty(props,'account',{enumerable:true,get(){getterCalls++;return 'private getter';}});
    const row={__reactProps$abc:props,__reactFiber$def:{memoizedProps:props,stateNode:null}};globalThis.document={querySelectorAll:()=>[row]};
    const result=captureAlibabaHookShapes(),serialized=JSON.stringify(result);assert.ok(serialized.includes('memoizedProps'));assert.ok(serialized.includes('contact'));assert.ok(serialized.includes('accessor'));
    assert.equal(getterCalls,0);assert.equal(serialized.includes('private'),false);assert.equal(result.rows.length,1);
  } finally {if(old===undefined)delete globalThis.document;else globalThis.document=old;}
});
test('DOM hooks keep attribute names and safe conversation identifiers from row and ancestors',()=>{
  const old={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle};
  try {
    const row=element('div',{class:'contact-item-container','data-cid':'peer42','data-ali-id':'account42','data-lastmsg-id':'message42','data-unread-count':'2','data-modify-time':'1780000000000','data-temporary-time':'1780000000001','data-name':'private redundant name','data-session-id':'conversation9','data-access-token':'private secret'});
    row.parentElement=element('div',{'data-thread-id':'thread9'});row.parentElement.parentElement=element('section',{role:'list'});
    globalThis.document={body:element('body',{},[row]),title:'Inbox',readyState:'complete',querySelectorAll:()=>[row]};globalThis.location={href:'https://message.alibaba.com/'};globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
    const result=captureSanitizedDOM(),hook=result.hooks[0];assert.equal(hook.ancestry.length,3);assert.ok(hook.ancestry[0].attributeNames.includes('data-access-token'));
    assert.equal(hook.ancestry[0].safeAttributes['data-session-id'],'conversation9');assert.equal(hook.ancestry[0].safeAttributes['data-cid'],'peer42');assert.equal(JSON.stringify(result).includes('private secret'),false);
    for(const [name,value] of Object.entries({'data-cid':'peer42','data-ali-id':'account42','data-lastmsg-id':'message42','data-unread-count':'2','data-modify-time':'1780000000000','data-temporary-time':'1780000000001'})){
      assert.equal(hook.ancestry[0].safeAttributes[name],value);assert.ok(result.html.includes(`${name}="${value}"`));
    }
    assert.equal(JSON.stringify(result).includes('private redundant name'),false);
  } finally {for(const [name,value] of Object.entries(old))if(value===undefined)delete globalThis[name];else globalThis[name]=value;}
});
test('read-next selects exactly the first confirmed unread row and uses adapter guard tokens',async()=>{
  const old=globalThis.OpenLinksDialogsReader;let opened=false,requests=[];
  try {
    globalThis.OpenLinksDialogsReader={snapshot:()=>({status:'ready',documentToken:'document',conversations:opened?[{id:'known',active:true,tailKnown:true}]:[{id:'unknown',unread:true,canSelect:false},{id:'read',unread:false,canSelect:true,selectionToken:'unused'},{id:'known',unread:true,canSelect:true,selectionToken:'selection'},{id:'other',unread:true,canSelect:true,selectionToken:'unused2'}]}),openConversation:async request=>{requests.push(request);opened=true;return {ok:true,openedId:request.conversationId};}};
    const result=await readNextConversation();assert.deepEqual(requests,[{conversationId:'known',documentToken:'document',selectionToken:'selection'}]);assert.equal(result.selection.attempted,true);assert.equal(result.after.conversations[0].active,true);
  } finally {if(old===undefined)delete globalThis.OpenLinksDialogsReader;else globalThis.OpenLinksDialogsReader=old;}
});
test('read-next never acts on captcha or ambiguous rows and does not retry busy adapter result',async()=>{
  const old=globalThis.OpenLinksDialogsReader;let calls=0;
  try {
    for(const snapshot of [{status:'captcha',conversations:[{id:'a',canSelect:true,unread:true,selectionToken:'x'}]},{status:'ready',conversations:[{id:'a',canSelect:false,unread:true}]}]){
      globalThis.OpenLinksDialogsReader={snapshot:()=>snapshot,openConversation:()=>{calls++;return {ok:false,status:'busy'};}};const result=await readNextConversation();assert.equal(result.selection.attempted,false);
    }
    assert.equal(calls,0);globalThis.OpenLinksDialogsReader.snapshot=()=>({status:'ready',documentToken:'d',conversations:[{id:'a',canSelect:true,unread:true,selectionToken:'s'}]});
    const result=await readNextConversation();assert.equal(calls,1);assert.equal(result.selection.result.status,'busy');
  } finally {if(old===undefined)delete globalThis.OpenLinksDialogsReader;else globalThis.OpenLinksDialogsReader=old;}
});
test('lost read-next CDP result cannot cause selection in another frame',async()=>{
  const env=mock();env.fetch=async()=>({ok:true,text:async()=>'(function(){globalThis.OpenLinksDialogsReader={snapshot(){return {}}};})();'});
  const original=env.chrome.debugger.sendCommand;let attempts=0;
  env.chrome.debugger.sendCommand=async(target,method,args)=>{
    if(method==='Runtime.evaluate') {
      env.calls.push([method,target,args]);
      if(args.expression.includes('function readNextConversation')){attempts++;throw new Error('Response lost after click');}
      return {result:{type:'object',value:{status:'ready',conversations:[{id:'known',canSelect:true,unread:true,selectionToken:'token'}]}}};
    }
    return original(target,method,args);
  };
  const report=await collectDiagnostics({mode:'read-next',tabId:4},env);assert.equal(attempts,1);assert.equal(report.selectionAttempted,true);assert.equal(report.tabs[0].frames[0].error,'frame_capture_failed');assert.ok(report.tabs[0].frames[1].data);assert.equal(env.calls.at(-1)[0],'detach');
});
test('separate runs create fresh isolated worlds so newly deployed reader code is actually used',async()=>{
  const env=mock();await collectDiagnostics({},env);await collectDiagnostics({},env);
  const names=env.calls.filter(call=>call[0]==='Page.createIsolatedWorld').map(call=>call[2].worldName);assert.equal(names[0],names[1]);assert.notEqual(names[0],names[2]);
});
test('MIC launcher mode requires a tab and only evaluates its main MIC frame',async()=>{
  assert.throws(()=>diagnosticOptions('?mode=open-mic-inbox'));
  const env=mock({tabs:[{id:4,url:'https://www.made-in-china.com/'},{id:6,url:'https://x.alibaba.com/'}],frames:{frame:{id:'top',url:'https://www.made-in-china.com/'},childFrames:[{frame:{id:'child',url:'https://webim.made-in-china.com/'}}]}});
  const report=await collectDiagnostics({mode:'open-mic-inbox',tabId:4},env);assert.equal(report.tabs.length,1);assert.equal(report.frames,1);
  const evaluation=env.calls.find(call=>call[0]==='Runtime.evaluate')[2];assert.ok(evaluation.expression.includes('function openMadeInChinaInbox'));assert.ok(evaluation.expression.includes('captureSanitizedDOM'));assert.equal(evaluation.awaitPromise,false);assert.ok(Number.isInteger(evaluation.contextId));
});
test('MIC action clicks only one visible exact native launcher and refuses ambiguity or active input',async()=>{
  const old={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle,setTimeout:globalThis.setTimeout};let clicks=0;
  try {
    globalThis.location={href:'https://www.made-in-china.com/'};globalThis.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});globalThis.setTimeout=callback=>{callback();return 0;};
    const launcher={isConnected:true,closest:()=>null,getBoundingClientRect:()=>({width:20,height:20}),getAttribute:()=>null,click(){clicks++;}};
    globalThis.document={activeElement:{closest:()=>null},querySelectorAll:selector=>selector.startsWith('#webtm-wrapper')?[launcher]:[]};
    const success=await openMadeInChinaInbox();assert.equal(success.attempted,true);assert.equal(clicks,1);
    globalThis.document.querySelectorAll=selector=>selector.startsWith('#webtm-wrapper')?[launcher,launcher]:[];assert.equal((await openMadeInChinaInbox()).code,'ambiguous_launcher');assert.equal(clicks,1);
    globalThis.document.activeElement={closest:()=>({})};assert.equal((await openMadeInChinaInbox()).code,'user_input_active');assert.equal(clicks,1);
    globalThis.location.href='https://www.alibaba.com/';assert.equal((await openMadeInChinaInbox()).code,'wrong_platform');assert.equal(clicks,1);
  } finally {for(const [name,value] of Object.entries(old))if(value===undefined)delete globalThis[name];else globalThis[name]=value;}
});
test('read-first separately permits a confirmed already-read row while read-next does not',async()=>{
  assert.throws(()=>diagnosticOptions('?mode=read-first'));assert.equal(diagnosticOptions('?mode=read-first&tabId=4').mode,'read-first');
  const old=globalThis.OpenLinksDialogsReader;let opened=false,calls=0;
  try {
    globalThis.OpenLinksDialogsReader={snapshot:()=>({status:'ready',documentToken:'d',conversations:[{id:'known',canSelect:true,unread:false,selectionToken:'s',active:opened,tailKnown:opened}]}),openConversation:()=>{calls++;opened=true;return {ok:true};}};
    const unread=await readNextConversation();assert.equal(unread.selection.attempted,false);assert.equal(calls,0);
    const first=await readNextConversation(false);assert.equal(first.selection.attempted,true);assert.equal(calls,1);assert.equal(first.selection.conversationId,'known');
  } finally {if(old===undefined)delete globalThis.OpenLinksDialogsReader;else globalThis.OpenLinksDialogsReader=old;}
});
test('fixed chat-root layout metrics describe hidden or zero-sized virtualized lists without changing them',()=>{
  const old={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle,innerWidth:globalThis.innerWidth,innerHeight:globalThis.innerHeight};
  try {
    const node=element('div',{class:'conversation-record-lst'});Object.assign(node,{getBoundingClientRect:()=>({x:10,y:20,width:280,height:0}),scrollHeight:900,clientHeight:0,scrollTop:0,childElementCount:0});
    globalThis.document={body:element('body',{},[node]),title:'TM',readyState:'complete',visibilityState:'hidden',hasFocus:()=>false,querySelectorAll:selector=>selector==='.conversation-record-lst'?[node]:[]};
    globalThis.location={href:'https://webim.made-in-china.com/super-tm/'};globalThis.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1',overflowY:'auto'});globalThis.innerWidth=300;globalThis.innerHeight=500;
    const data=captureSanitizedDOM();assert.equal(data.layout.length,1);assert.equal(data.layout[0].rect.height,0);assert.equal(data.layout[0].scrollHeight,900);assert.equal(data.viewport.visibilityState,'hidden');assert.equal(data.viewport.width,300);
  } finally {for(const [name,value] of Object.entries(old))if(value===undefined)delete globalThis[name];else globalThis[name]=value;}
});
test('MIC expansion requires its own explicit mode and targets only the visible native expand button',async()=>{
  assert.throws(()=>diagnosticOptions('?mode=expand-mic-inbox'));
  const env=mock({tabs:[{id:4,url:'https://www.made-in-china.com/'}],frames:{frame:{id:'top',url:'https://www.made-in-china.com/'}}});await collectDiagnostics({mode:'expand-mic-inbox',tabId:4},env);
  const evaluation=env.calls.find(call=>call[0]==='Runtime.evaluate')[2];assert.equal(evaluation.userGesture,true);assert.ok(evaluation.expression.includes('button.webtm-full-btn'));
  const normal=mock({tabs:[{id:4,url:'https://www.made-in-china.com/'}],frames:{frame:{id:'top',url:'https://www.made-in-china.com/'}}});await collectDiagnostics({mode:'open-mic-inbox',tabId:4},normal);assert.equal(normal.calls.find(call=>call[0]==='Runtime.evaluate')[2].userGesture,undefined);
});
test('page action functions have no background-tab timers and snapshot stability waits in extension context',async()=>{
  assert.equal(/setTimeout|await |new Promise/.test(readNextConversation.toString()),false);assert.equal(/setTimeout|await |new Promise/.test(openMadeInChinaInbox.toString()),false);
  const env=mock();let waits=[];env.settle=async ms=>waits.push(ms);env.fetch=async()=>({ok:true,text:async()=>'(function(){globalThis.OpenLinksDialogsReader={snapshot(){return {}}};})();'});
  const report=await collectDiagnostics({mode:'snapshot'},env);assert.deepEqual(waits,[1150,1150]);assert.ok(report.tabs[0].frames.every(frame=>frame.observations===2));
  for(const call of env.calls.filter(call=>call[0]==='Runtime.evaluate'))assert.equal(call[2].awaitPromise,false);
});
test('an unresponsive Runtime.evaluate is bounded outside the page and owned debugger detaches',async()=>{
  const env=mock(),original=env.chrome.debugger.sendCommand,timer=globalThis.setTimeout;
  env.chrome.debugger.sendCommand=(target,method,args)=>method==='Runtime.evaluate'?new Promise(()=>{}):original(target,method,args);
  try {
    globalThis.setTimeout=(callback,ms,...args)=>timer(callback,ms===15000?1:ms,...args);
    const report=await collectDiagnostics({},env);assert.ok(report.tabs[0].frames.every(frame=>frame.error==='frame_capture_failed'));assert.equal(env.calls.at(-1)[0],'detach');
  }finally{globalThis.setTimeout=timer;}
});
test('MIC hooks resolve the exact default main world for each frame and remove their event listener',async()=>{
  const env=mock({tabs:[{id:4,url:'https://membercenter.made-in-china.com/'}],frames:{frame:{id:'top',url:'https://membercenter.made-in-china.com/'},childFrames:[{frame:{id:'chat',url:'https://webim.made-in-china.com/super-tm/'}}]}});
  let listener,removed=false;env.chrome.debugger.onEvent={addListener(value){listener=value;},removeListener(value){assert.equal(value,listener);removed=true;}};
  const original=env.chrome.debugger.sendCommand;
  env.chrome.debugger.sendCommand=async(target,method,args)=>{
    if(method==='Runtime.enable'){
      env.calls.push([method,target]);
      for(const [frameId,id,isDefault] of [['top',30,true],['chat',40,true],['chat',50,false]])listener(target,'Runtime.executionContextCreated',{context:{id,auxData:{frameId,isDefault}}});return {};
    }
    if(method==='Runtime.disable'){env.calls.push([method,target]);return {};}
    return original(target,method,args);
  };
  const report=await collectDiagnostics({mode:'hooks',tabId:4},env);assert.equal(report.frames,2);assert.equal(removed,true);
  const calls=env.calls.filter(call=>call[0]==='Runtime.evaluate');assert.deepEqual(calls.map(call=>call[2].contextId),[30,40]);assert.ok(calls.every(call=>call[2].expression.endsWith('(true)')));
  assert.equal(env.calls.some(call=>call[0]==='Page.createIsolatedWorld'),false);assert.equal(env.calls.at(-2)[0],'Runtime.disable');assert.equal(env.calls.at(-1)[0],'detach');
});
test('MIC hooks fail closed if a frame main-world context cannot be identified',async()=>{
  const env=mock({tabs:[{id:4,url:'https://webim.made-in-china.com/super-tm/'}],frames:{frame:{id:'chat',url:'https://webim.made-in-china.com/super-tm/'}}});
  const report=await collectDiagnostics({mode:'hooks',tabId:4},env);assert.equal(report.tabs[0].frames[0].error,'main_world_unavailable');assert.equal(env.calls.some(call=>call[0]==='Runtime.evaluate'),false);
});
test('Alibaba message diagnostics preserve ordering geometry and attribute metadata, but unmatched text only by length',()=>{
  const old={document:globalThis.document,location:globalThis.location,getComputedStyle:globalThis.getComputedStyle};
  try {
    const measured=(className,top=0,style={},attrs={})=>Object.assign(element('div',{class:className,...attrs}),{getBoundingClientRect:()=>({x:0,y:top,top,bottom:top+20,width:500,height:20}),clientHeight:20,scrollHeight:300,scrollTop:280,matches(selector){return selector==='.message-box' && className==='message-box';},computed:{display:'flex',visibility:'visible',opacity:'1',position:'relative',order:'0',flexDirection:'column',overflowY:'auto',...style}});
    const box=measured('message-box',0,{flexDirection:'column-reverse'}),flow=measured('im-message-flow'),history=measured('scroll-box');history.parentElement=flow;flow.parentElement=box;
    const first=measured('message-item-wrapper',200,{position:'absolute',order:'1'},{'data-msgid':'123','data-send-time':'1792316000000','data-access-token':'private auth'}),second=measured('message-item-wrapper',100,{order:'2'},{'data-message-id':'456'});
    history.querySelectorAll=()=>[first,second];const unmatched=measured('time-divider',50);unmatched.parentElement=history;unmatched.closest=()=>null;
    const raw='Unmatched private content',textNode={nodeValue:raw,parentElement:unmatched};
    globalThis.document={body:element('body'),readyState:'complete',title:'Chat',querySelectorAll:selector=>selector==='.buyer-messenger-container .message-box .im-message-flow .scroll-box'?[history]:[],createTreeWalker:()=>{let index=0;return {nextNode:()=>index++===0?textNode:null};}};
    globalThis.location={href:'https://message.alibaba.com/'};globalThis.getComputedStyle=node=>node.computed||{display:'block',visibility:'visible'};
    const result=captureSanitizedDOM().alibabaHistory[0];assert.equal(result.ancestry.length,3);assert.equal(result.ancestry[2].flexDirection,'column-reverse');
    assert.deepEqual(result.wrappers.map(row=>[row.index,row.rectTop,row.position,row.order]),[[0,200,'absolute','1'],[1,100,'relative','2']]);
    assert.equal(result.wrappers[0].safeAttributes['data-msgid'],'123');assert.equal(result.wrappers[0].safeAttributes['data-send-time'],'1792316000000');assert.ok(result.wrappers[0].attributeNames.includes('data-access-token'));
    assert.equal(result.unmatchedText[0].length,raw.length);assert.equal(JSON.stringify(result).includes(raw),false);assert.equal(JSON.stringify(result).includes('private auth'),false);
  } finally {for(const [name,value] of Object.entries(old))if(value===undefined)delete globalThis[name];else globalThis[name]=value;}
});
for(const platform of ['1688','alibaba'])test(`reveal delegates only the exact stable ${platform} history to the adapter one-use guard`,()=>{
  const old=globalThis.OpenLinksDialogsReader;let calls=[];
  const row={id:'known',active:true,identityReliable:true,historyStable:true,readComplete:false};
  try {
    globalThis.OpenLinksDialogsReader={snapshot:()=>({platform,status:'ready',documentToken:'doc',conversations:[row]}),revealLatest:value=>{calls.push(value);return {ok:true,revealedId:value.conversationId};}};
    assert.equal(revealSelectedConversation('other').attempted,false);assert.equal(calls.length,0);
    row.historyStable=false;assert.equal(revealSelectedConversation('known').attempted,false);row.historyStable=true;
    assert.equal(revealSelectedConversation('known').result.ok,true);assert.deepEqual(calls,[{conversationId:'known',documentToken:'doc'}]);
    row.readComplete=true;assert.equal(revealSelectedConversation('known').attempted,false);assert.equal(calls.length,1);
  } finally {if(old===undefined)delete globalThis.OpenLinksDialogsReader;else globalThis.OpenLinksDialogsReader=old;}
});
for(const platform of ['1688','alibaba'])test(`diagnostic selected ${platform} history can settle then reveal once; snapshot mode never reveals`,async()=>{
  const url=platform==='1688'?'https://air.1688.com/':'https://message.alibaba.com/';
  const env=mock({tabs:[{id:4,url}],frames:{frame:{id:'top',url}}}),original=env.chrome.debugger.sendCommand;let snapshots=0,selections=0,reveals=0,waits=[];
  env.fetch=async()=>({ok:true,text:async()=>'(function(){globalThis.OpenLinksDialogsReader={snapshot(){return {}}};})();'});env.settle=async ms=>waits.push(ms);
  env.chrome.debugger.sendCommand=async(target,method,args)=>{
    if(method!=='Runtime.evaluate')return original(target,method,args);
    env.calls.push([method,target,args]);let value;
    if(args.expression.includes('function readNextConversation')){selections++;value={selection:{attempted:true,conversationId:'known',result:{ok:true,openedId:'known'}},after:{}};}
    else if(args.expression.includes('function revealSelectedConversation')){reveals++;value={attempted:true,result:{ok:true,revealedId:'known'}};}
    else {snapshots++;value={platform,status:'ready',documentToken:'doc',conversations:[{id:'known',canSelect:true,selectionToken:'token',unread:false,active:snapshots>1,identityReliable:true,readComplete:reveals>0,historyStable:snapshots>=4}]};}
    return {result:{type:'object',value}};
  };
  const report=await collectDiagnostics({mode:'read-first',tabId:4},env);assert.equal(selections,1);assert.equal(reveals,1);assert.deepEqual(waits,[1150,1150,1150,1150]);assert.equal(report.tabs[0].frames[0].data.after.conversations[0].readComplete,true);
  await collectDiagnostics({mode:'snapshot',tabId:4},env);assert.equal(selections,1);assert.equal(reveals,1);
});
test('MIC stays excluded from diagnostic reveal even when a matching active history is incomplete',()=>{
  const old=globalThis.OpenLinksDialogsReader;let calls=0;
  try {
    globalThis.OpenLinksDialogsReader={snapshot:()=>({platform:'mic',status:'ready',documentToken:'doc',conversations:[{id:'known',active:true,identityReliable:true,historyStable:true,readComplete:false}]}),revealLatest:()=>{calls++;return {ok:true};}};
    assert.equal(revealSelectedConversation('known').attempted,false);assert.equal(calls,0);
  }finally{if(old===undefined)delete globalThis.OpenLinksDialogsReader;else globalThis.OpenLinksDialogsReader=old;}
});
