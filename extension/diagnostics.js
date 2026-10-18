// Standalone diagnostic page: it also works inside the previous unpacked build.
// All evaluated expressions are fixed local code; URL parameters cannot supply JS.
const DOMAINS={'1688':'1688.com',alibaba:'alibaba.com',mic:'made-in-china.com'};
const MAX_FRAMES=12,MAX_TABS=12;
const MODES=new Set(['dom','snapshot','hooks','read-next','read-first','open-mic-inbox','expand-mic-inbox']);
export function platformForURL(value) {
  try{const u=new URL(value);if(u.protocol!=='https:' || u.username || u.password || u.port)return null;
    return Object.keys(DOMAINS).find(p=>u.hostname===DOMAINS[p] || u.hostname.endsWith('.'+DOMAINS[p]))||null;
  }catch{return null;}
}
export function safeDiagnosticURL(value,base) {
  try{
    if(typeof value!=='string' || !value.trim())return '';
    const u=new URL(value,base);if(!['https:','http:'].includes(u.protocol))return '';
    u.username='';u.password='';u.hash='';
    for(const key of [...u.searchParams.keys()])if(!/^(touid|uid|sellerid|memberid|shopid|conversationid|threadid|messageid|siteid)$/i.test(key))u.searchParams.delete(key);
    return u.href.slice(0,1600).replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,'[redacted]');
  }catch{return '';}
}
export function diagnosticOptions(search='') {
  const params=new URLSearchParams(search),mode=MODES.has(params.get('mode'))?params.get('mode'):'dom',raw=params.get('tabId');
  if(raw!==null && !/^\d{1,10}$/.test(raw))throw new Error('Некорректный номер вкладки.');
  if(['read-next','read-first','open-mic-inbox','expand-mic-inbox'].includes(mode) && raw===null)throw new Error('Для открытия чата нужна конкретная вкладка.');
  return {mode,tabId:raw===null?null:Number(raw),run:params.get('run')==='1'};
}
export function sanitizeSnapshot(value,key='',depth=0) {
  if(depth>12)return null;
  if(typeof value==='string') {
    if(/(?:url|src|href)$/i.test(key))return safeDiagnosticURL(value);
    return value.slice(0,12000).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,'[redacted]').replace(/https?:\/\/[^\s<>"']+/g,url=>safeDiagnosticURL(url));
  }
  if(Array.isArray(value))return value.slice(0,500).map(item=>sanitizeSnapshot(item,key,depth+1));
  if(value && typeof value==='object') {
    const result={};for(const [name,item] of Object.entries(value).slice(0,100)){
      if(['__proto__','constructor','prototype'].includes(name) || (/token|password|secret|authorization|cookie|credential/i.test(name) && name!=='documentToken'))continue;
      result[name]=sanitizeSnapshot(item,name,depth+1);
    }return result;
  }
  return value===null || typeof value==='boolean' || (typeof value==='number' && Number.isFinite(value))?value:null;
}

// Self-contained to serialize into an isolated CDP world. Never writes to the DOM.
export function captureSanitizedDOM() {
  const HTML_LIMIT=200000,TEXT_LIMIT=25000,NODE_LIMIT=12000;
  let html='',visibleText='',nodes=0,truncated=false;
  const secret=/token|password|passwd|secret|authorization|cookie|session|csrf|xsrf|jwt|credential/i;
  const safeURL=(value)=>{
    try{if(typeof value!=='string' || !value.trim())return '';const u=new URL(value,location.href);if(!['https:','http:'].includes(u.protocol))return '';
      u.username='';u.password='';u.hash='';
      for(const key of [...u.searchParams.keys()])if(!/^(touid|uid|sellerid|memberid|shopid|conversationid|threadid|messageid|siteid)$/i.test(key))u.searchParams.delete(key);
      return u.href.slice(0,1600).replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,'[redacted]');
    }catch{return '';}
  };
  const clean=value=>String(value||'').slice(0,20000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,'[redacted]').replace(/https?:\/\/[^\s<>"']+/g,url=>safeURL(url));
  const escape=value=>clean(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const append=value=>{if(html.length+value.length>HTML_LIMIT){html+=value.slice(0,Math.max(0,HTML_LIMIT-html.length));truncated=true;}else html+=value;};
  const metadata=[];
  function walk(node,depth,hidden) {
    if(nodes++>=NODE_LIMIT || depth>60 || html.length>=HTML_LIMIT){truncated=true;return;}
    if(node.nodeType===3){if(!hidden){const value=clean(node.nodeValue).slice(0,12000);append(escape(value));if(visibleText.length<TEXT_LIMIT)visibleText+=(value+'\n').slice(0,TEXT_LIMIT-visibleText.length);}return;}
    if(node.nodeType!==1)return;
    const tag=node.tagName.toLowerCase();
    if(['script','style','noscript','template'].includes(tag))return;
    let invisible=hidden || node.hidden || node.getAttribute('aria-hidden')==='true';
    try{const style=getComputedStyle(node);invisible=invisible || style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse';}catch{}
    let attrs='';
    for(const attr of [...node.attributes].slice(0,80)) {
      const name=attr.name.toLowerCase();
      if(secret.test(name) || name.startsWith('on') || /^(value|srcdoc|style|formaction|action)$/.test(name))continue;
      const allowed=/^(id|class|role|name|type|title|hidden|disabled|contenteditable|tabindex|datetime)$/.test(name) || /^aria-(label|labelledby|selected|expanded|hidden|disabled|live|controls)$/.test(name) || /^data-(id|uid|touid|cid|ali-id|unread-count|lastmsg-id|modify-time|temporary-time|send-time|seller-?id|member-?id|recipient-?id|conversation-?id|thread-?id|message-?id|msg-?id|contact-?id|chat-?id|user-?id|account-?id|current-user-?id|peer-?id|direction|sender-?id|receiver-?id|from-?id|to-?id|role|type|testid|test-id|selected|active|index|timestamp|time)$/.test(name);
      if(name==='href' || name==='src'){const value=safeURL(attr.value);if(value)attrs+=' '+name+'="'+escape(value)+'"';}
      else if(allowed)attrs+=' '+name+'="'+escape(attr.value.slice(0,name==='class'?1200:512))+'"';
    }
    append('<'+tag+attrs+'>');
    if(tag==='iframe'){metadata.push({id:clean(node.id).slice(0,200),className:clean(node.className).slice(0,500),src:safeURL(node.getAttribute('src')||'')});}
    const formValue=['input','textarea','select','option'].includes(tag) || node.isContentEditable || node.getAttribute('contenteditable')==='true' || node.getAttribute('role')==='textbox';
    if(tag!=='iframe' && !formValue){for(const child of node.childNodes){if(nodes>=NODE_LIMIT || html.length>=HTML_LIMIT){truncated=true;break;}walk(child,depth+1,invisible);}if(node.shadowRoot){append('<open-shadow-root>');for(const child of node.shadowRoot.childNodes){if(nodes>=NODE_LIMIT || html.length>=HTML_LIMIT){truncated=true;break;}walk(child,depth+1,invisible);}append('</open-shadow-root>');}}
    if(!['input','img','br','hr','meta','link','source','area','base','col','embed','param','track','wbr'].includes(tag))append('</'+tag+'>');
  }
  if(document.body)walk(document.body,0,false);
  const hooks=[];let hookSize=0;
  for(const [index,row] of [...(document.querySelectorAll?.('.contact-item-container,.conversation-item,.conversation-record-lst .lst-item[id^="friend-PERSON-"],.user-avater,.main-wrapper')||[])].slice(0,12).entries()) {
    const ancestry=[];let node=row;
    for(let depth=0;node && depth<3;depth++,node=node.parentElement) {
      const attributeNames=[],safeAttributes={};
      for(const attribute of [...node.attributes].slice(0,48)) {
        const name=attribute.name.toLowerCase();attributeNames.push(name.slice(0,80));
        const allowed=/^(id|class|role)$/.test(name) || /^data-(id|cid|ali-id|unread-count|lastmsg-id|modify-time|temporary-time|sid|session-id|conversation-id|thread-id|contact-id|recipient-id|peer-id|user-id|member-id|account-id|current-user-id|seller-id|uid|touid)$/.test(name);
        if(allowed && !/token|auth|password|passwd|secret|cookie|csrf|xsrf|jwt|credential/i.test(name))safeAttributes[name]=clean(attribute.value).slice(0,name==='class'?600:256);
      }
      ancestry.push({tag:node.tagName.toLowerCase(),attributeNames,safeAttributes});
    }
    const hook={index,ancestry},size=JSON.stringify(hook).length;if(hookSize+size>16000)break;
    hookSize+=size;hooks.push(hook);
  }
  const layout=[],metric=value=>typeof value==='number' && Number.isFinite(value)?Math.round(Math.max(-10000000,Math.min(10000000,value))*100)/100:null;
  for(const selector of ['#app','#webtm-wrapper .webtm-lite-content','#webtm-wrapper .webtm-lite-iframe','.conversation-box-wrapper','.conversation-lst','.conversation-record-lst','.conversation-area','.rc-virtual-list-holder','[data-virtuoso-scroller]','[data-viewport-type]','.ww_conversation_list','.ww_message .message-list','.ww_message .rc-scrollbars-view','.ww_box','.contact-item-container']) {
    for(const node of [...(document.querySelectorAll?.(selector)||[])].slice(0,2))try {
      const box=node.getBoundingClientRect(),style=getComputedStyle(node);
      layout.push({selector,tag:node.tagName.toLowerCase(),id:clean(node.id).slice(0,100),className:clean(node.className).slice(0,300),rect:{x:metric(box.x),y:metric(box.y),width:metric(box.width),height:metric(box.height)},clientWidth:metric(node.clientWidth),clientHeight:metric(node.clientHeight),scrollWidth:metric(node.scrollWidth),scrollHeight:metric(node.scrollHeight),scrollTop:metric(node.scrollTop),children:metric(node.childElementCount),display:clean(style.display).slice(0,30),visibility:clean(style.visibility).slice(0,30),opacity:clean(style.opacity).slice(0,20),overflowY:clean(style.overflowY).slice(0,20)});
    }catch{}
  }
  const viewport={width:metric(globalThis.innerWidth),height:metric(globalThis.innerHeight),visibilityState:clean(document.visibilityState).slice(0,20),hasFocus:typeof document.hasFocus==='function'?document.hasFocus():null};
  const alibabaHistory=[];
  if(/(^|\.)alibaba\.com$/.test(new URL(location.href).hostname)) {
    const measure=node=>{
      const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
      return {tag:node.tagName.toLowerCase(),className:clean(node.className).slice(0,300),rectTop:metric(rect.top??rect.y),rectBottom:metric(rect.bottom??((rect.y||0)+(rect.height||0))),rectHeight:metric(rect.height),rectWidth:metric(rect.width),position:clean(style.position).slice(0,30),order:clean(style.order).slice(0,30),flexDirection:clean(style.flexDirection).slice(0,40),display:clean(style.display).slice(0,30),visibility:clean(style.visibility).slice(0,30),overflowY:clean(style.overflowY).slice(0,20),clientHeight:metric(node.clientHeight),scrollHeight:metric(node.scrollHeight),scrollTop:metric(node.scrollTop)};
    };
    for(const history of [...(document.querySelectorAll?.('.buyer-messenger-container .message-box .im-message-flow .scroll-box')||[])].slice(0,2))try {
      const ancestry=[];for(let node=history,depth=0;node && depth<8;node=node.parentElement,depth++){ancestry.push(measure(node));if(node.matches?.('.message-box'))break;}
      const wrappers=[...(history.querySelectorAll?.('.message-item-wrapper')||[])].slice(0,40).map((node,index)=>{
        const attributeNames=[],safeAttributes={};
        for(const attribute of [...node.attributes].slice(0,48)) {
          const name=attribute.name.toLowerCase();attributeNames.push(name.slice(0,80));
          if(/^(id|data-(msgid|messageid|msg-id|message-id|timestamp|time|send-time|index))$/.test(name) && /^[\w:./+ -]{1,256}$/.test(attribute.value))safeAttributes[name]=attribute.value;
        }
        return {index,...measure(node),attributeNames,safeAttributes};
      });
      const unmatched=[];let inspected=0;
      if(document.createTreeWalker) {
        const walker=document.createTreeWalker(history,4);let textNode;
        while((textNode=walker.nextNode()) && inspected++<2000 && unmatched.length<30) {
          const parent=textNode.parentElement,length=String(textNode.nodeValue??textNode.textContent??'').trim().length;
          if(!length || !parent || parent.closest?.('.message-item-wrapper,script,style,input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"]'))continue;
          let visible=true;for(let cursor=parent,depth=0;cursor && depth<12;cursor=cursor.parentElement,depth++){const style=getComputedStyle(cursor);if(style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' || style.opacity==='0'){visible=false;break;}if(cursor===history)break;}
          if(!visible)continue;const info=measure(parent);if(info.rectWidth<=0 || info.rectHeight<=0)continue;
          unmatched.push({length:Math.min(length,1000000),parent:info,ancestorClasses:[parent.parentElement,parent.parentElement?.parentElement].filter(Boolean).map(node=>clean(node.className).slice(0,200))});
        }
      }
      const details={ancestry,wrappers,unmatchedText:unmatched,inspectedTextNodes:Math.min(inspected,2000)};
      if(JSON.stringify([...alibabaHistory,details]).length<=30000)alibabaHistory.push(details);
    }catch{}
  }
  return {url:safeURL(location.href),title:clean(document.title).slice(0,300),readyState:document.readyState,html,visibleText,iframes:metadata.slice(0,20).map(frame=>({...frame,id:frame.id.slice(0,100),className:frame.className.slice(0,200),src:frame.src.slice(0,800)})),hooks,layout,viewport,alibabaHistory,nodes:Math.min(nodes,NODE_LIMIT),truncated};
}
// Marketplace-specific schema inspection. Only own descriptor names/types are read;
// primitive values, accessor getters, functions and application globals are not.
export function captureAlibabaHookShapes(mic=false) {
  const rows=[],seen=new WeakSet();let count=0,truncated=false;
  function shape(value,depth) {
    const type=value===null?'null':Array.isArray(value)?'array':typeof value;
    if(type!=='object' && type!=='array')return {type};
    if(seen.has(value))return {type,circular:true};seen.add(value);
    if(depth>=(mic?4:3) || count>=500){truncated=true;return {type,bounded:true};}
    const properties=[];
    for(const name of Object.getOwnPropertyNames(value).slice(0,30)) {
      if(count++>=500){truncated=true;break;}
      const descriptor=Object.getOwnPropertyDescriptor(value,name);if(!descriptor)continue;
      const property={name:name.slice(0,100)};
      if(!Object.prototype.hasOwnProperty.call(descriptor,'value'))property.shape={type:'accessor',skipped:true};
      else if(/token|password|passwd|secret|authorization|cookie|credential/i.test(name))property.shape={type:'redacted'};
      else property.shape=shape(descriptor.value,depth+1);
      properties.push(property);
    }
    return {type,properties};
  }
  const selector=mic?'.conversation-record-lst .lst-item[id^="friend-PERSON-"],.user-avater,.main-wrapper':'.contact-item-container,.conversation-item';
  for(const [index,row] of [...document.querySelectorAll(selector)].slice(0,3).entries()) {
    const properties=[];
    for(const name of Object.getOwnPropertyNames(row).filter(key=>/^__react(?:Props|Fiber)\$/.test(key)).slice(0,4)) {
      const descriptor=Object.getOwnPropertyDescriptor(row,name);if(!descriptor || !Object.prototype.hasOwnProperty.call(descriptor,'value'))continue;
      properties.push({name:name.slice(0,100),shape:shape(descriptor.value,0)});
    }
    rows.push({index,properties});
  }
  return {rows,truncated};
}
// The sole interactive diagnostic action: open one adapter-confirmed unread row.
// Selection tokens and the adapter's draft/focus/CAPTCHA guards remain authoritative.
export function readNextConversation(unreadOnly=true) {
  const reader=globalThis.OpenLinksDialogsReader,before=reader?.snapshot?.();
  if(!before || typeof reader.openConversation!=='function')return {before:before||null,selection:{attempted:false,code:'reader_selection_unavailable'}};
  if(before.status!=='ready')return {before,selection:{attempted:false,code:'inbox_not_ready'}};
  const row=(before.conversations||[]).find(item=>item.canSelect===true && (!unreadOnly || item.unread===true) && typeof item.id==='string' && typeof item.selectionToken==='string');
  if(!row)return {before,selection:{attempted:false,code:unreadOnly?'no_selectable_unread':'no_selectable_conversation'}};
  let result;
  try{result=reader.openConversation({conversationId:row.id,documentToken:before.documentToken,selectionToken:row.selectionToken});}
  catch{return {before,selection:{attempted:true,code:'selection_failed'},after:reader.snapshot()};}
  const after=reader.snapshot();
  return {before,selection:{attempted:true,conversationId:row.id,result},after};
}
// Uses only the adapter's one-use permit created by a successful programmatic
// opening. The expected ID is JSON data from that result, never executable input.
export function revealSelectedConversation(expectedId) {
  const reader=globalThis.OpenLinksDialogsReader,snapshot=reader?.snapshot?.();
  if(typeof expectedId!=='string' || expectedId.length>512 || !snapshot || !['1688','alibaba'].includes(snapshot.platform) || snapshot.status!=='ready' || typeof reader.revealLatest!=='function')return {attempted:false,code:'reveal_unavailable'};
  const active=(snapshot.conversations||[]).filter(row=>row.active===true);
  if(active.length!==1 || active[0].id!==expectedId || active[0].identityReliable!==true || active[0].historyStable!==true || active[0].readComplete!==false)return {attempted:false,code:'selected_history_not_ready'};
  try{return {attempted:true,result:reader.revealLatest({conversationId:expectedId,documentToken:snapshot.documentToken})};}
  catch{return {attempted:true,code:'reveal_failed'};}
}
// One specific native MIC inbox launcher observed on the marketplace homepage.
// It does not target a supplier, an editor, Reply Now, or any message send control.
export function openMadeInChinaInbox(expand=false) {
  const url=new URL(location.href);
  if(url.protocol!=='https:' || !(url.hostname==='made-in-china.com' || url.hostname.endsWith('.made-in-china.com')))return {attempted:false,code:'wrong_platform'};
  const visible=node=>{
    if(!node?.isConnected || node.closest('[hidden],[aria-hidden="true"],[inert]'))return false;
    for(let cursor=node;cursor;cursor=cursor.parentElement){const style=getComputedStyle(cursor);if(style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' || Number(style.opacity)===0)return false;}
    const box=node.getBoundingClientRect();return box.width>2 && box.height>2;
  };
  if([...document.querySelectorAll('input[type="password"],[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i]')].some(visible))return {attempted:false,code:'login_or_captcha'};
  if(document.activeElement?.closest('textarea,input,[contenteditable="true"],[role="textbox"]'))return {attempted:false,code:'user_input_active'};
  const selector=expand?'#webtm-wrapper .webtm-min-task-expanded .webtm-lite-content-visible button.webtm-full-btn':'#webtm-wrapper .webtm-min-box[role="button"][aria-label="tm"]';
  const candidates=[...document.querySelectorAll(selector)].filter(visible);
  if(candidates.length!==1)return {attempted:false,code:candidates.length?'ambiguous_launcher':'launcher_not_visible'};
  const launcher=candidates[0];
  if(launcher.getAttribute('aria-expanded')==='true')return {attempted:false,code:'already_open'};
  if(launcher.getAttribute('aria-disabled')==='true' || launcher.disabled)return {attempted:false,code:'launcher_disabled'};
  if(!visible(launcher))return {attempted:false,code:'launcher_changed'};
  launcher.click();
  return {attempted:true,clicked:true,code:expand?'native_full_inbox_clicked':'native_inbox_clicked'};
}
function frameList(tree) {
  const frames=[],pending=[tree];while(pending.length && frames.length<128){const item=pending.shift();if(item?.frame)frames.push(item.frame);if(Array.isArray(item?.childFrames))pending.push(...item.childFrames.slice(0,128));}return frames;
}
function timeout(promise,ms) {
  let timer;return Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),ms);})]).finally(()=>clearTimeout(timer));
}
export async function collectDiagnostics(options={},environment={}) {
  const api=environment.chrome||globalThis.chrome,fetcher=environment.fetch||globalThis.fetch,progress=environment.onProgress||(()=>{});
  // Waiting belongs to the extension page: timers inside a long-backgrounded
  // marketplace tab can be throttled for minutes even while CDP is attached.
  const settle=environment.settle || (milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)));
  const mode=MODES.has(options.mode)?options.mode:'dom',filter=Number.isInteger(options.tabId)&&options.tabId>=0?options.tabId:null;
  const report={format:'openlinks-readonly-diagnostics',version:1,mode,createdAt:new Date().toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,paused:false,tabs:[],errors:[]};
  const readMode=mode==='read-next' || mode==='read-first';
  const micMode=mode==='open-mic-inbox' || mode==='expand-mic-inbox';
  if((readMode || micMode) && filter===null){report.errors.push({code:'targeted_action_requires_tab_id'});return report;}
  progress('Ставлю очередь рассылки на паузу.');
  try{const paused=await timeout(api.runtime.sendMessage({type:'PAUSE'}),20000);if(!paused?.ok)throw new Error('pause');report.paused=true;}
  catch{report.errors.push({code:'outreach_pause_failed'});return report;}
  let expression='('+captureSanitizedDOM.toString()+')()',snapshotExpression='';
  if(mode==='hooks')expression='('+captureAlibabaHookShapes.toString()+')()';
  if(micMode)expression='(()=>{const action=('+openMadeInChinaInbox.toString()+')('+(mode==='expand-mic-inbox'?'true':'false')+');return {action,data:('+captureSanitizedDOM.toString()+')()};})()';
  if(mode==='snapshot' || readMode) {
    try{const response=await fetcher(api.runtime.getURL('dialogs-content.js'),{cache:'no-store'});if(!response.ok)throw new Error('reader');const source=await response.text();if(source.length>200000 || !source.includes('OpenLinksDialogsReader'))throw new Error('reader');snapshotExpression=source+'\n;globalThis.OpenLinksDialogsReader.snapshot();';expression=mode==='snapshot'?snapshotExpression:source+'\n;('+readNextConversation.toString()+')('+(mode==='read-next'?'true':'false')+');';}
    catch{report.errors.push({code:'local_reader_unavailable'});return report;}
  }
  let tabs;
  try{tabs=(await api.tabs.query({})).filter(tab=>platformForURL(tab.url) && (mode!=='hooks' || ['alibaba','mic'].includes(platformForURL(tab.url))) && (!micMode || platformForURL(tab.url)==='mic') && (filter===null || tab.id===filter)).slice(0,MAX_TABS);}
  catch{report.errors.push({code:'tab_query_failed'});return report;}
  let count=0,selectionAttempted=false;const worldName='openlinks-readonly-diagnostics-'+crypto.randomUUID();
  for(const tab of tabs) {
    if(count>=MAX_FRAMES)break;
    const platform=platformForURL(tab.url),target={tabId:tab.id},entry={tabId:tab.id,platform,url:safeDiagnosticURL(tab.url),frames:[],errors:[]};report.tabs.push(entry);
    let owned=false,contextListener=null,runtimeEnabled=false;const mainContexts=new Map();
    try {
      progress(`Читаю структуру вкладки ${report.tabs.length} из ${tabs.length}.`);
      try{await api.debugger.attach(target,'1.3');owned=true;}catch{entry.errors.push({code:'debugger_attach_failed'});continue;}
      if(mode==='hooks' && platform==='mic' && api.debugger.onEvent?.addListener) {
        contextListener=(source,method,event)=>{if(source.tabId===target.tabId && method==='Runtime.executionContextCreated' && event.context?.auxData?.isDefault===true)mainContexts.set(event.context.auxData.frameId,event.context.id);};
        api.debugger.onEvent.addListener(contextListener);
        await timeout(api.debugger.sendCommand(target,'Runtime.enable'),15000);runtimeEnabled=true;
      }
      const tree=await api.debugger.sendCommand(target,'Page.getFrameTree');
      for(const frame of frameList(tree?.frameTree)) {
        if(count>=MAX_FRAMES)break;
        if(platformForURL(frame.url)!==platform || ((mode==='hooks' && platform==='alibaba' || micMode) && frame.id!==tree.frameTree.frame.id))continue;
        count++;
        const result={frameId:frame.id,url:safeDiagnosticURL(frame.url)};entry.frames.push(result);
        try {
          const parameters={expression:readMode?snapshotExpression:expression,returnByValue:true,awaitPromise:false,timeout:15000};
          if(mode==='expand-mic-inbox')parameters.userGesture=true;
          if(mode==='hooks' && platform==='mic') {
            const context=mainContexts.get(frame.id);
            if(!Number.isInteger(context)){result.error='main_world_unavailable';continue;}
            parameters.contextId=context;parameters.expression='('+captureAlibabaHookShapes.toString()+')(true)';
          }
          if(mode!=='hooks') {
            const world=await api.debugger.sendCommand(target,'Page.createIsolatedWorld',{frameId:frame.id,worldName,grantUniveralAccess:false});
            if(!Number.isInteger(world?.executionContextId))throw new Error('context');parameters.contextId=world.executionContextId;
          }
          const evaluate=parameters=>timeout(api.debugger.sendCommand(target,'Runtime.evaluate',parameters),15000);
          let evaluation=await evaluate(parameters);
          if(mode==='snapshot' && !evaluation?.exceptionDetails && evaluation?.result?.value) {
            result.data=sanitizeSnapshot(evaluation.result.value);
            await timeout(settle(1150),5000);
            evaluation=await evaluate(parameters);result.observations=2;
          }
          const initial=evaluation?.result?.value;
          if(readMode && !selectionAttempted && !evaluation.exceptionDetails && initial?.status==='ready' && initial.conversations?.some(row=>row.canSelect===true && (mode==='read-first' || row.unread===true) && typeof row.id==='string' && typeof row.selectionToken==='string')) {
            // Reserve the one selection before CDP execution. Even if the page
            // changes or the response is lost, another frame cannot click again.
            selectionAttempted=true;progress(mode==='read-next'?'Открываю один непрочитанный диалог для чтения.':'Открываю первый подтверждённый диалог для чтения.');
            evaluation=await evaluate({...parameters,expression});
            if(!evaluation?.exceptionDetails && evaluation?.result?.value) {
              result.data=sanitizeSnapshot(evaluation.result.value);
              try {
                await timeout(settle(1150),5000);
                const after=await evaluate({...parameters,expression:snapshotExpression});
                if(after?.exceptionDetails || !after?.result?.value)throw new Error('post');
                evaluation.result.value.after=after.result.value;result.observations=2;
                const selected=evaluation.result.value.selection,selectedId=selected?.conversationId;
                if(['1688','alibaba'].includes(platform) && selected?.attempted===true && selected.result?.ok===true && selected.result.openedId===selectedId) {
                  const activeRow=()=>evaluation.result.value.after?.conversations?.find(row=>row.id===selectedId && row.active===true && row.identityReliable===true);
                  for(let probe=0;probe<2 && activeRow()?.historyStable!==true;probe++) {
                    if(!['ready','loading'].includes(evaluation.result.value.after?.status))break;
                    await timeout(settle(1150),5000);
                    const stable=await evaluate({...parameters,expression:snapshotExpression});
                    if(stable?.exceptionDetails || !stable?.result?.value)throw new Error('stable');
                    evaluation.result.value.after=stable.result.value;result.observations++;
                  }
                  if(activeRow()?.readComplete===false && activeRow()?.historyStable===true) {
                    try {
                      const reveal=await evaluate({...parameters,expression:'('+revealSelectedConversation.toString()+')('+JSON.stringify(selectedId)+')'});
                      if(reveal?.exceptionDetails || !reveal?.result?.value)throw new Error('reveal');
                      evaluation.result.value.reveal=reveal.result.value;
                      if(reveal.result.value.attempted===true) {
                        await timeout(settle(1150),5000);
                        const latest=await evaluate({...parameters,expression:snapshotExpression});
                        if(latest?.exceptionDetails || !latest?.result?.value)throw new Error('latest');
                        evaluation.result.value.after=latest.result.value;result.observations++;
                      }
                    }catch{result.revealError='reveal_or_followup_failed';}
                  }
                }
              }catch{result.postSnapshotError='post_selection_snapshot_failed';}
            }
          }
          if(micMode && !evaluation?.exceptionDetails && evaluation?.result?.value) {
            result.data=evaluation.result.value;
            try {
              await timeout(settle(1200),5000);
              const after=await evaluate({...parameters,expression:'('+captureSanitizedDOM.toString()+')()',userGesture:false});
              if(after?.exceptionDetails || !after?.result?.value)throw new Error('post');
              evaluation.result.value.data=after.result.value;result.observations=2;
            }catch{result.postSnapshotError='post_open_snapshot_failed';}
          }
          if(evaluation?.exceptionDetails || evaluation?.result?.type!=='object' || !evaluation.result.value)throw new Error('capture');
          const value=mode==='snapshot' || readMode?sanitizeSnapshot(evaluation.result.value):evaluation.result.value;
          if(JSON.stringify(value).length>(mode==='dom'?310000:500000))throw new Error('size');
          result.data=value;
        }catch{result.error='frame_capture_failed';}
      }
    }catch{entry.errors.push({code:'tab_capture_failed'});}
    finally{
      if(contextListener)api.debugger.onEvent.removeListener(contextListener);
      if(runtimeEnabled)try{await timeout(api.debugger.sendCommand(target,'Runtime.disable'),5000);}catch{}
      if(owned)try{await api.debugger.detach(target);}catch{entry.errors.push({code:'debugger_detach_failed'});}
    }
  }
  report.frames=count;report.limited=count>=MAX_FRAMES || tabs.length>=MAX_TABS;if(readMode)report.selectionAttempted=selectionAttempted;
  if(!tabs.length)report.errors.push({code:'no_matching_tabs'});
  return report;
}
export async function downloadDiagnostics(report) {
  const blob=new Blob([JSON.stringify(report)],{type:'application/json'}),stream=blob.stream().pipeThrough(new CompressionStream('gzip'));
  const compressed=await new Response(stream).blob(),url=URL.createObjectURL(compressed),anchor=document.createElement('a');
  anchor.href=url;anchor.download=`openlinks-diagnostics-${report.mode}-${Date.now()}.json.gz`;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  return anchor.download;
}
if(typeof document!=='undefined' && document.getElementById('run')) {
  const button=document.getElementById('run'),status=document.getElementById('status');let options;
  try{options=diagnosticOptions(location.search);}catch{status.textContent='Некорректный номер вкладки. Проверка не запущена.';button.disabled=true;}
  if(options) {
    document.getElementById('mode').textContent={dom:'Режим: структура страниц.',snapshot:'Режим: проверка чтения диалогов.',hooks:'Режим: названия и типы свойств строк чата, без значений.', 'read-next':'Режим: открывает один непрочитанный диалог для чтения. Сообщения не отправляются.', 'read-first':'Режим: открывает первый подтверждённый диалог для чтения. Сообщения не отправляются.', 'open-mic-inbox':'Режим: открывает штатный список чатов Made-in-China. Сообщения не отправляются.', 'expand-mic-inbox':'Режим: разворачивает уже открытый чат Made-in-China штатной кнопкой. Сообщения не отправляются.'}[options.mode];
    if(options.mode==='read-next')document.getElementById('read-only-description').textContent='Сначала очередь рассылки ставится на паузу. Затем адаптер может открыть один подтверждённый непрочитанный диалог в указанной вкладке. После открытия 1688 или Alibaba допускается одно защищённое прокручивание истории к последним сообщениям. Поле сообщения не изменяется, ответы не отправляются. При проверке входа, CAPTCHA, активном вводе или черновике переход блокируется.';
    if(options.mode==='read-first')document.getElementById('read-only-description').textContent='Сначала очередь рассылки ставится на паузу. Затем адаптер может открыть первый подтверждённый диалог в указанной вкладке, даже если он уже прочитан. После открытия 1688 или Alibaba допускается одно защищённое прокручивание истории к последним сообщениям. Поле сообщения не изменяется, ответы не отправляются. Защитные проверки адаптера сохраняются.';
    if(options.mode==='open-mic-inbox')document.getElementById('read-only-description').textContent='Сначала очередь рассылки ставится на паузу. Затем открывается только штатная кнопка списка чатов Made-in-China в указанной вкладке. Кнопки ответа и отправки, поля сообщения и карточки поставщиков не нажимаются.';
    if(options.mode==='expand-mic-inbox')document.getElementById('read-only-description').textContent='Сначала очередь рассылки ставится на паузу. Затем единственная видимая штатная кнопка разворачивает уже открытый чат Made-in-China. Площадка может открыть отдельную вкладку чатов. Поля ввода и кнопки отправки не используются.';
    async function run(){button.disabled=true;try{const report=await collectDiagnostics(options,{onProgress:text=>{status.textContent=text;}});const file=await downloadDiagnostics(report);const failed=report.errors.length+report.tabs.reduce((sum,tab)=>sum+tab.errors.length+tab.frames.filter(frame=>frame.error).length,0);status.textContent=`Сохранён ${file}\nВкладок: ${report.tabs.length}; фреймов: ${report.frames||0}; замечаний: ${failed}. Сообщения не отправлялись.`;}catch{status.textContent='Не удалось сохранить файл диагностики. Сообщения не отправлялись.';}finally{button.disabled=false;button.textContent='Повторить проверку';}}
    button.addEventListener('click',run);if(options.run)run();
  }
}
