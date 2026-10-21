import {controlledContact} from './outreach-chat-open.js';

// Install before the first site script. Arming at document_idle is too late for
// stores that open their chat as soon as the storefront loads. These tickets
// belong only to tabs explicitly created/owned by the outreach worker.
const tickets=new Map(),observedDebuggers=new WeakSet(),LOAD_TIMEOUT_MS=120000;
function observeDetach(api) {
  if(!api.debugger.onDetach?.addListener||observedDebuggers.has(api.debugger))return;
  observedDebuggers.add(api.debugger);
  api.debugger.onDetach.addListener(target=>{
    const ticket=tickets.get(target.tabId);if(!ticket)return;
    ticket.attached=false;
    // A user opening DevTools or closing the tab must not masquerade as a
    // successfully protected load. The next readiness/cancellation releases it.
    if(!ticket.releasing)ticket.interrupted=true;
  });
}
const domainFor=value=>{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port)throw new Error('Нужна HTTPS-страница поддерживаемой площадки.');
  const domain=['1688.com','alibaba.com','made-in-china.com'].find(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain));
  if(!domain)throw new Error('Площадка не поддерживается для фонового открытия.');
  return domain;
};
const belongs=(value,domain)=>{
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(url.hostname===domain||url.hostname.endsWith('.'+domain));}catch{return false;}
};

// The function and domain come exclusively from extension code. No supplier
// script, captured URL or user-provided text is interpolated into page code.
export function backgroundGuardSource(domain) {
  if(!['1688.com','alibaba.com','made-in-china.com'].includes(domain))throw new Error('Неизвестная площадка.');
  return `(()=>{const domain=${JSON.stringify(domain)};if(location.protocol==='https:'&&(location.hostname===domain||location.hostname.endsWith('.'+domain)))return (${controlledContact.toString()})({action:'arm',pageUrl:location.href});})();`;
}

async function release(ticket,api,{stopLoading=false}={}) {
  if(ticket.releasing)return ticket.releasing;
  ticket.releasing=(async()=>{
    let detachError;
    // On Pause/error, abort pending navigation before removing its preload.
    // If stopping fails, retain this ticket for cancellation retry; detaching
    // anyway could let the new document finish loading without protection.
    if(ticket.attached&&stopLoading)await api.debugger.sendCommand({tabId:ticket.tabId},'Page.stopLoading',{});
    try {
      if(ticket.attached&&ticket.identifier)await api.debugger.sendCommand({tabId:ticket.tabId},'Page.removeScriptToEvaluateOnNewDocument',{identifier:ticket.identifier}).catch(()=>{});
    } finally {
      if(ticket.attached)try{await api.debugger.detach({tabId:ticket.tabId});ticket.attached=false;}catch(error){detachError=error;}
      if(!ticket.attached&&tickets.get(ticket.tabId)===ticket)tickets.delete(ticket.tabId);
    }
    if(detachError)throw new Error('Не удалось освободить debugger фоновой вкладки: '+detachError.message);
  })();
  try {await ticket.releasing;}finally{ticket.releasing=null;}
}

export function hasBackgroundPage(tabId){return tickets.has(tabId);}

export async function cancelBackgroundPage(tabId,api=chrome) {
  const ticket=tickets.get(tabId);if(!ticket)return;
  ticket.cancelled=true;
  // Navigation setup must finish first: a pending attach may otherwise complete
  // after cancellation and leave an untracked debugger session behind.
  await ticket.settingUp?.catch(()=>{});
  await release(ticket,api,{stopLoading:true});
}

export async function cancelAllBackgroundPages(api=chrome) {
  const results=await Promise.allSettled([...tickets.keys()].map(id=>cancelBackgroundPage(id,api)));
  const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
}

export async function navigateBackgroundPage(tabId,url,api=chrome) {
  if(!Number.isInteger(tabId)||tabId<0)throw new Error('Нет рабочей вкладки очереди.');
  const domain=domainFor(url);
  await cancelBackgroundPage(tabId,api);
  observeDetach(api);
  const ticket={tabId,domain,at:Date.now(),attached:false,identifier:'',cancelled:false,settingUp:null,releasing:null};
  tickets.set(tabId,ticket);
  ticket.settingUp=(async()=>{
    await api.debugger.attach({tabId},'1.3');ticket.attached=true;
    if(ticket.cancelled||ticket.interrupted)throw new Error('Фоновое открытие отменено.');
    await api.debugger.sendCommand({tabId},'Page.enable',{});
    const result=await api.debugger.sendCommand({tabId},'Page.addScriptToEvaluateOnNewDocument',{source:backgroundGuardSource(domain)});
    if(typeof result?.identifier!=='string'||!result.identifier)throw new Error('Chrome не подтвердил защиту фоновой вкладки.');
    ticket.identifier=result.identifier;
    if(ticket.cancelled||ticket.interrupted)throw new Error('Фоновое открытие отменено.');
    // Never set active or update/focus a window here.
    return api.tabs.update(tabId,{url});
  })();
  try {return await ticket.settingUp;}
  catch(error) {
    ticket.settingUp=null;
    try {await release(ticket,api,{stopLoading:true});}catch(cleanup){throw new Error(error.message+' '+cleanup.message);}
    throw error;
  } finally {ticket.settingUp=null;}
}

export async function createBackgroundPage({url,windowId},api=chrome) {
  domainFor(url);
  if(!Number.isInteger(windowId)||windowId<0)throw new Error('Нет окна очереди.');
  const tab=await api.tabs.create({url:'about:blank',active:false,windowId});
  if(!Number.isInteger(tab?.id))throw new Error('Chrome не создал рабочую вкладку.');
  try {await navigateBackgroundPage(tab.id,url,api);return tab;}
  catch(error) {
    // Only this wrapper owns the new blank tab. Rearming an existing chat never
    // closes it on failure, so the user can inspect its state.
    await api.tabs.remove(tab.id).catch(()=>{});throw error;
  }
}

export async function finishBackgroundPage(tabId,api=chrome) {
  const ticket=tickets.get(tabId);
  if(!ticket)return {ready:true,documents:[]};
  try {
    if(ticket.settingUp)return {ready:false,documents:[]};
    if(ticket.cancelled)throw new Error('Фоновое открытие отменено.');
    if(ticket.interrupted||!ticket.attached)throw new Error('Защита фоновой загрузки прервана; повторите открытие вкладки.');
    if(Date.now()-ticket.at>LOAD_TIMEOUT_MS)throw new Error('Страница не загрузилась за две минуты; фоновая проверка остановлена.');
    const tab=await api.tabs.get(tabId);
    if(tab.status!=='complete'||tab.pendingUrl)return {ready:false,documents:[]};
    if(!belongs(tab.url,ticket.domain))throw new Error('Фоновая вкладка перешла на другую площадку; продолжение остановлено.');
    const frames=await api.webNavigation.getAllFrames({tabId});
    const relevant=(frames||[]).filter(frame=>belongs(frame.url,ticket.domain));
    if(!relevant.some(frame=>frame.frameId===0&&frame.url===tab.url))throw new Error('Не удалось подтвердить основной документ фоновой вкладки.');
    const documents=[];
    for(const frame of relevant) {
      if(typeof frame.documentId!=='string'||!frame.documentId)throw new Error('Chrome не сообщил идентификатор документа; обновите браузер.');
      const results=await api.scripting.executeScript({target:{tabId,documentIds:[frame.documentId]},world:'MAIN',func:controlledContact,args:[{action:'read',pageUrl:frame.url}]});
      const result=results?.[0];
      if(results?.length!==1||result.frameId!==frame.frameId||result.documentId!==frame.documentId||result.result?.ok!==true)throw new Error('Защита фоновой вкладки не подтверждена; открытие чата остановлено.');
      documents.push({tabId,frameId:frame.frameId,documentId:frame.documentId,pageUrl:frame.url});
    }
    const current=await api.tabs.get(tabId);
    if(current.status!=='complete'||current.pendingUrl||current.url!==tab.url)return {ready:false,documents:[]};
    const currentFrames=await api.webNavigation.getAllFrames({tabId});
    const currentRelevant=(currentFrames||[]).filter(frame=>belongs(frame.url,ticket.domain));
    if(currentRelevant.length!==documents.length||documents.some(document=>!currentRelevant.some(frame=>frame.frameId===document.frameId&&frame.documentId===document.documentId&&frame.url===document.pageUrl)))return {ready:false,documents:[]};
    // Native-input.js must be able to attach its own session. The page-local
    // guards remain installed after removal of the navigation preload script.
    await release(ticket,api);
    return {ready:true,documents};
  } catch(error) {
    try {await release(ticket,api,{stopLoading:true});}catch(cleanup){throw new Error(error.message+' '+cleanup.message);}
    throw error;
  }
}
