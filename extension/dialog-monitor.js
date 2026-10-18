import {
  normalizeDialogs, bindDialogTab, unbindDialogTab, mergeDialogSnapshot,
  setConversationControl, draftRequest, acceptDraft, setDialogSettings, addDialogEvent, buildDraftPrompt, conversationKey,
  attachmentSourceFingerprint,saveProduct,productExtractionRequest,buildProductExtractionPrompt,acceptProductExtraction,approveProduct,productFingerprint,
} from './lib/dialogs.js';
import {generateDialogDraft, extractProductKeyPoints, validateModel, validateProvider, providerInfo, parseProductKeyPoints} from './lib/dialog-ai.js';
import {buildManualProductPrompt, buildManualDialogPrompt} from './lib/manual-prompts.js';
import {FOLDER_KEY,FOLDER_LIMITS,normalizeFolder,publicFolder,folderModel,folderDigest,folderPending,finishFolderJob,reserveFolderJob,folderImages,renderFolderPrompt,createFolderBridge} from './lib/folder-bridge.js';
import {sendDialogReply} from './dialog-send.js';
import {withTabOwnership} from './lib/tab-ownership.js';
import {loadProductImage} from './lib/product-files.js';
import {resolveChatAttachments,pruneChatAttachmentCache} from './lib/chat-attachments.js';
import {sameJsonValue} from './lib/json-values.js';

export const DIALOGS_KEY = 'openlinksDialogs';
const PROVIDER_KEY = 'openlinksDialogsProvider';
const ALARM = 'openlinks-dialogs';
const PLATFORMS = ['1688','alibaba','mic'];
const DOMAINS = {'1688':'1688.com',alibaba:'alibaba.com',mic:'made-in-china.com'};
const READ_TIMEOUT_MS=120000,READ_BACKOFF_MS=5*60000;
const KNOWN_COMMANDS = new Set(['GET','LIST_TABS','BIND_TAB','UNBIND_TAB','START','STOP','SCAN','SETTINGS','CONTROL','CONTEXT_EDITING','GENERATE_DRAFT','SAVE_DRAFT','DRAFT_EDITING','SEND_DRAFT','DISCARD_DRAFT','PRODUCT_SAVE','PRODUCT_EXTRACT','PRODUCT_APPROVE','AUTODRAFT','EXPORT_PRODUCT_PROMPT','EXPORT_DRAFT_PROMPT','IMPORT_PRODUCT_RESULT','FOLDER_STATUS','FOLDER_SETTINGS','FOLDER_PRODUCT','FOLDER_DRAFT','FOLDER_POLL','FOLDER_RETRY','FOLDER_CANCEL'].map(name=>'DIALOGS_'+name));

export function dialogPlatform(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
    return PLATFORMS.find(platform => parsed.hostname === DOMAINS[platform] || parsed.hostname.endsWith(`.${DOMAINS[platform]}`)) || null;
  } catch { return null; }
}

// Bound tabs remain reserved while monitoring is paused. Restart explicitly unbinds them.
export async function isMonitoredTab(tabId, api = globalThis.chrome) {
  if (!Number.isInteger(tabId)) return false;
  const saved = (await api.storage.local.get(DIALOGS_KEY))[DIALOGS_KEY];
  return Object.values(saved?.bindings || {}).some(binding => binding?.tabId === tabId);
}

const timeout = async (promise, ms = 7000) => {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),ms);})]); }
  finally { clearTimeout(timer); }
};

export function createDialogMonitor({api=globalThis.chrome, fetchImpl=globalThis.fetch, now=()=>Date.now(),imageLoader=loadProductImage,attachmentResolver=resolveChatAttachments,folderBridge,folderSender=sendDialogReply,reserveDialogSendQuota}={}) {
  let serial = Promise.resolve();
  let providerTask=null, cancelEpoch=0;
  const keyEpochs=new Map();
  const epoch=key=>`${cancelEpoch}:${keyEpochs.get(key) || 0}`;
  const pending = new Map();
  const exclusive = task => {
    const result = serial.then(task);
    serial = result.catch(()=>{});
    return result;
  };
  const bridge=folderBridge || createFolderBridge({api});
  const loadFolder=async()=>normalizeFolder((await api.storage.local.get(FOLDER_KEY))[FOLDER_KEY]);
  const saveFolder=folder=>api.storage.local.set({[FOLDER_KEY]:folder});
  const apiAutoAvailable=()=>{
    try {return typeof api.permissions?.contains==='function'&&api.runtime.getManifest().optional_host_permissions?.some(origin=>['https://api.openai.com/*','https://api.anthropic.com/*'].includes(origin))===true;}catch{return false;}
  };
  const load = async () => {
    const raw=(await api.storage.local.get(DIALOGS_KEY))[DIALOGS_KEY],state=normalizeDialogs(raw);
    if(!apiAutoAvailable()&&state.settings.autoDraft) {state.settings.autoDraft=false;await api.storage.local.set({[DIALOGS_KEY]:state});}
    return state;
  };
  const save = state => api.storage.local.set({[DIALOGS_KEY]:state});
  const provider = async () => {
    const raw = (await api.storage.local.get(PROVIDER_KEY))[PROVIDER_KEY] || {};
    const selected=validateProvider(raw.provider ?? 'openai'), profiles={};
    for(const name of ['openai','anthropic']) {
      // Old installations stored only one OpenAI profile. Never move that key
      // to another provider when the selection changes.
      const value=raw.profiles?.[name] || (name==='openai' && !raw.profiles?raw:{});
      profiles[name]={model:typeof value.model==='string'?value.model:'',apiKey:typeof value.apiKey==='string'?value.apiKey:''};
    }
    return {provider:selected,profiles,...profiles[selected],revision:Number.isSafeInteger(raw.revision)&&raw.revision>=0?raw.revision:0};
  };
  const publicState = async state => {
    const config=await provider();
    const profiles=Object.fromEntries(Object.entries(config.profiles).map(([name,value])=>[name,{model:value.model,keyStored:!!value.apiKey}]));
    return {ok:true,state,folder:publicFolder(await loadFolder()),productFingerprint:productFingerprint(state),ai:{provider:config.provider,model:config.model,keyStored:!!config.apiKey,providers:profiles,busy:!!providerTask}};
  };
  const cancel = key => {
    if(key)keyEpochs.set(key,(keyEpochs.get(key) || 0)+1);else {cancelEpoch++;keyEpochs.clear();}
    for (const [id,task] of pending) if (!key || id===key) { task.controller.abort();pending.delete(id); }
  };
  const log = (state,type,detail,extra={}) => addDialogEvent(state,type,detail,extra,now());
  const schedule = async () => api.alarms.create(ALARM,{periodInMinutes:0.5});
  const clearAlarm = async () => { if(api.alarms.clear)await api.alarms.clear(ALARM); };
  const platform = value => { if(!PLATFORMS.includes(value))throw new Error('Неизвестная площадка.');return value; };
  const isUI = sender => {
    if (api.runtime.id && sender?.id!==api.runtime.id) return false;
    return ['dialogs.html','dashboard.html'].some(page=>sender?.url?.split('#')[0]===api.runtime.getURL(page));
  };
  const approved=state=>!!state.product?.approval && state.product.approval.fingerprint===productFingerprint(state);
  const attemptFingerprint=async(state,request,config)=>{
    // Readiness and view changes affect the revision guard, but must not buy a
    // second paid request for the same supplier message and approved context.
    const content=state.conversations[request.key].messages.map(message=>[message.key,message.direction,message.text,message.at,message.format || '',(message.attachments || []).map(file=>[file.sourceFingerprint,file.resolution?.text || '',file.resolution?.images || []])]);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(content)));
    return JSON.stringify({key:request.key,content:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''),settings:request.settingsFingerprint,product:request.productFingerprint,provider:config.revision});
  };
  const mayAuto=(item,signature)=>{
    const prior=item.autoDraft;
    if(item.draft)return false;
    if(!prior || prior.fingerprint!==signature)return true;
    if(prior.status==='done' || prior.attempts>=3)return false;
    return prior.status==='pending'?now()-prior.at>=300000:now()>=(prior.retryAt || 0);
  };
  async function candidate(state,observed,config,{ignoreBusy=false}={}) {
    if((providerTask && !ignoreBusy) || !state.running || !state.settings.autoDraft || !approved(state))return null;
    for(const row of observed) {
      if(!row.active || row.busy)continue;
      const key=conversationKey(row.platform,row.id),item=state.conversations[key];
      if(state.traversal[row.platform].pending)continue;
      try {if(mayAuto(item,await attemptFingerprint(state,draftRequest(state,key),config)))return key;}catch{}
    }
    return null;
  }
  async function reserveAttempt(state,key,request,config) {
    const item=state.conversations[key],fingerprint=await attemptFingerprint(state,request,config),previous=item.autoDraft;
    item.autoDraft={fingerprint,status:'pending',at:now(),attempts:previous?.fingerprint===fingerprint?(previous.attempts || 0)+1:1,retryAt:0,error:''};
    return fingerprint;
  }

  function markHealth(state, name, status, detail) {
    const before=state.bindings[name],changed=before?.status!==status || before?.detail!==(detail || '');
    mergeDialogSnapshot(state,{platform:name,status,url:state.bindings[name]?.url || '',detail,conversations:[]},now());
    if(changed) {
      const labels={ready:'Чат доступен для чтения',loading:'Ожидание загрузки',login:'Нужен вход в аккаунт',captcha:'Нужна проверка пользователя',unsupported:'Структура чата не распознана',error:'Ошибка чтения'};
      log(state,'monitor_health',`${labels[status] || 'Статус мониторинга изменён'}${detail?': '+detail:'.'}`,{platform:name,level:['error','login','captcha'].includes(status)?'warning':'info'});
    }
  }

  async function scanPlatform(state,name) {
    const binding=state.bindings[name];
    if(!Number.isInteger(binding?.tabId))return [];
    let tab;
    try { tab=await api.tabs.get(binding.tabId); }
    catch { unbindDialogTab(state,name,now());log(state,'tab_closed','Вкладка закрыта. Привяжите открытую вкладку повторно.',{platform:name,level:'error'});return []; }
    if(dialogPlatform(tab.url)!==name || (tab.pendingUrl && dialogPlatform(tab.pendingUrl)!==name)) {
      unbindDialogTab(state,name,now());log(state,'tab_left_platform','Вкладка ушла с площадки. Привязка снята.',{platform:name,level:'error'});return [];
    }
    if(tab.status==='loading' || tab.pendingUrl) { markHealth(state,name,'loading','Страница загружается.');return []; }
    let frames;
    try { frames=await timeout(api.webNavigation.getAllFrames({tabId:tab.id})); }
    catch { markHealth(state,name,'error','Не удалось прочитать список фреймов вкладки.');return []; }
    frames=(frames || []).filter(frame=>dialogPlatform(frame.url)===name).slice(0,24);
    const replies=await Promise.all(frames.map(async frame=>{
      try {
        const reply=await timeout(api.tabs.sendMessage(tab.id,{type:'DIALOGS_SNAPSHOT'},{frameId:frame.frameId}));
        if(!reply || reply.platform!==name || !Array.isArray(reply.conversations))return null;
        if(reply.url && reply.url!==frame.url)return null;
        if(!['ready','loading','login','captcha','unsupported','error'].includes(reply.status))return null;
        return {...reply,frameId:frame.frameId,sourceUrl:frame.url};
      } catch { return null; }
    }));
    // Navigation during a scan invalidates the complete snapshot, including stale frame replies.
    try {
      const latest=await api.tabs.get(tab.id);
      if(latest.url!==tab.url || latest.pendingUrl || latest.status==='loading') { markHealth(state,name,'loading','Вкладка изменилась во время чтения; повторю проверку.');return []; }
    } catch { unbindDialogTab(state,name,now());return []; }
    const byFrame=new Map(frames.map((frame,index)=>[frame.frameId,{frame,reply:replies[index]}]));
    const visibleFrame=(id,seen=new Set())=>{
      if(id===0)return true;
      if(seen.has(id))return false;
      seen.add(id);
      const entry=byFrame.get(id),parent=byFrame.get(entry?.frame.parentFrameId);
      if(!entry || !parent?.reply || !visibleFrame(parent.frame.frameId,seen))return false;
      const listed=parent.reply.frames || [];
      let matches=listed.filter(child=>child.url===entry.frame.url);
      if(!matches.length)matches=listed.filter(child=>{
        try {const left=new URL(child.url),right=new URL(entry.frame.url);return left.origin===right.origin && left.pathname===right.pathname;}catch{return false;}
      });
      return matches.length===1 && matches[0].visible===true;
    };
    const valid=replies.filter(reply=>reply && visibleFrame(reply.frameId));
    const obstacle=valid.find(reply=>['captcha','login'].includes(reply.status));
    if(obstacle) { markHealth(state,name,obstacle.status,obstacle.status==='captcha'?'На странице обнаружена проверка. Требуется ваше действие.':'Требуется вход в аккаунт.');return []; }
    // The fixed bundled reader only inspects known 1688 model data properties.
    // Page-owned values remain evidence until the isolated reader matches its
    // own one-use nonce, document, active thread and exact DOM-row digest.
    if(name==='1688' && api.scripting?.executeScript)for(let index=0;index<valid.length;index++) {
      const source=valid[index];
      if(source.status!=='ready' || typeof source.modelEvidenceToken!=='string' || !source.modelEvidenceToken || source.modelEvidenceToken.length>200 || !source.documentToken)continue;
      try {
        const results=await timeout(api.scripting.executeScript({target:{tabId:tab.id,frameIds:[source.frameId]},world:'MAIN',files:['chat-model-evidence.js']}));
        if(results?.length!==1 || results[0].frameId!==source.frameId)continue;
        const evidence=results[0].result;
        if(evidence?.platform!=='1688' || evidence.url!==source.sourceUrl || evidence.status!=='ready')continue;
        const applied=await timeout(api.tabs.sendMessage(tab.id,{type:'DIALOGS_APPLY_MODEL_EVIDENCE',documentToken:source.documentToken,modelEvidenceToken:source.modelEvidenceToken,evidence},{frameId:source.frameId}));
        if(applied?.ok!==true)continue;
        const refreshed=await timeout(api.tabs.sendMessage(tab.id,{type:'DIALOGS_SNAPSHOT'},{frameId:source.frameId}));
        if(refreshed?.platform===name && refreshed.url===source.sourceUrl && refreshed.documentToken===source.documentToken && ['ready','loading','login','captcha','unsupported','error'].includes(refreshed.status) && Array.isArray(refreshed.conversations))valid[index]={...refreshed,frameId:source.frameId,sourceUrl:source.sourceUrl};
        else valid[index]={...source,status:'loading',conversations:[]};
      } catch { /* Unsupported model evidence leaves unknown senders blocked. */ }
    }
    try {
      const latest=await api.tabs.get(tab.id);
      if(latest.url!==tab.url || latest.pendingUrl || latest.status==='loading'){markHealth(state,name,'loading','Вкладка изменилась во время чтения; повторю проверку.');return [];}
    } catch {unbindDialogTab(state,name,now());return [];}
    const newObstacle=valid.find(reply=>['captcha','login'].includes(reply.status));
    if(newObstacle){markHealth(state,name,newObstacle.status,newObstacle.status==='captcha'?'На странице обнаружена проверка. Требуется ваше действие.':'Требуется вход в аккаунт.');return [];}
    const ready=valid.filter(reply=>reply.status==='ready');
    if(!ready.length) {
      const status=valid.some(reply=>reply.status==='loading')?'loading':valid.length?'unsupported':'error';
      markHealth(state,name,status,status==='loading'?'Чат ещё загружается.':'Чат не распознан. Откройте список сообщений и обновите вкладку после установки расширения.');return [];
    }
    const rows=new Map(),ambiguous=new Set();
    const transcript=row=>JSON.stringify((row.messages || []).map(item=>[item.id || '',item.direction,item.text,item.at ?? null,item.format || '',(item.attachments || []).map(attachmentSourceFingerprint)]));
    for(const reply of ready)for(const conversation of reply.conversations) {
      if(!conversation || typeof conversation.id!=='string')continue;
      const row={...conversation,frameId:reply.frameId,sourceUrl:reply.sourceUrl,documentToken:reply.documentToken,selectionBusy:reply.busy===true || (reply.busy && typeof reply.busy==='object' && Object.values(reply.busy).some(value=>value===true))};
      const old=rows.get(row.id);
      if(ambiguous.has(row.id))continue;
      if(old?.messages?.length && row.messages?.length && transcript(old)!==transcript(row)) {
        ambiguous.add(row.id);rows.set(row.id,{...old,messages:[],identityReliable:false,orderReliable:false,tailKnown:false,needsRead:true});continue;
      }
      if(!old || (row.messages?.length || 0)>(old.messages?.length || 0))rows.set(row.id,row);
    }
    const conversations=[...rows.values()];
    const detail=ambiguous.size?'Найдены противоречивые копии диалога в разных фреймах. Черновик для них недоступен.':'';
    markHealth(state,name,'ready',detail);
    mergeDialogSnapshot(state,{platform:name,status:'ready',url:tab.url,detail,conversations},now());
    for(const row of conversations)if(row.active===true && row.identityReliable===true && row.historyTailKnown===true && row.historyOrderReliable===true) {
      try {await attachmentResolver({api,state,key:conversationKey(name,row.id),rawConversation:row,tabId:tab.id,frameId:row.frameId,documentToken:row.documentToken,sourceUrl:row.sourceUrl,now:now()});}
      catch {const item=state.conversations[conversationKey(name,row.id)];if(item)item.detail='Не удалось прочитать вложение. Подготовка ответа остаётся заблокированной.';}
    }
    const confirmed=conversations.filter(row=>{
      const item=state.conversations[conversationKey(name,row.id)];return row.identityReliable===true && item?.identityReliable===true && item.orderReliable===true && item.tailKnown===true && item.messages?.length;
    }).map(row=>({platform:name,id:row.id,documentToken:row.documentToken,frameId:row.frameId,active:row.active===true,busy:row.selectionBusy===true,replyFingerprint:row.replyFingerprint,sourceUrl:row.sourceUrl}));
    confirmed.rows=conversations;confirmed.sources=valid;
    return confirmed;
  }

  function finishRead(state,name,detail,{failed=false,type='read_completed'}={}) {
    const traversal=state.traversal[name],read=traversal.pending;
    if(!read)return;
    const key=conversationKey(name,read.id);
    if(failed)traversal.backoff[key]=now()+READ_BACKOFF_MS;
    else traversal.seenPreviews[key]=read.preview || '';
    traversal.pending=null;
    log(state,type,detail,{key,platform:name,level:failed?'warning':'info'});
  }

  async function advanceRead(state,name,observed,allowSelect,autoConfig=null,folderConfig=null) {
    const traversal=state.traversal[name],binding=state.bindings[name],rows=observed.rows || [],sources=observed.sources || [];
    for(const key of Object.keys(traversal.backoff))if(traversal.backoff[key]<=now())delete traversal.backoff[key];
    const keyOf=row=>{try{return conversationKey(name,row.id);}catch{return '';}};
    const controls=row=>state.conversations[keyOf(row)];
    for(const row of rows)if(typeof row.unread==='boolean') {
      const key=keyOf(row);if(!key)continue;
      // A later supplier may repeat exactly the same preview ("Yes", a sticker,
      // etc.). A renewed unread badge still requires opening that conversation.
      if(row.unread && traversal.unreadStates[key]===false)delete traversal.seenPreviews[key];
      traversal.unreadStates[key]=row.unread;
    }
    for(const key of Object.keys(traversal.unreadStates).slice(0,-100))delete traversal.unreadStates[key];
    if(traversal.pending) {
      const read=traversal.pending,item=state.conversations[conversationKey(name,read.id)];
      if(item?.paused || item?.takeover){finishRead(state,name,'Чтение остановлено: диалог приостановлен или передан пользователю.',{failed:true,type:'read_cancelled'});return;}
      const source=sources.find(reply=>reply.frameId===read.frameId);
      if(source && source.documentToken!==read.documentToken){finishRead(state,name,'Страница изменилась во время чтения. Повторное открытие отложено на 5 минут.',{failed:true,type:'read_cancelled'});return;}
      const active=rows.filter(row=>row.active===true);
      const target=active.find(row=>row.id===read.id && row.frameId===read.frameId && row.documentToken===read.documentToken && row.identityReliable===true);
      const draftReady=target && observed.some(row=>row.id===read.id && row.frameId===read.frameId) && !target.needsRead;
      // A late alarm may already observe the complete history; check it before
      // the deadline so a successfully loaded conversation is not called an error.
      if(source && target && (target.readComplete===true || draftReady)) {
        finishRead(state,name,draftReady?'Выбранный диалог открыт, последние доступные сообщения прочитаны. Отправка не выполнялась.':'Доступная история выбранного диалога загружена. Часть содержимого не подходит для подготовки ответа; отправка не выполнялась.');return;
      }
      const busy=sources.some(reply=>reply.busy===true || (reply.busy && typeof reply.busy==='object' && Object.values(reply.busy).some(value=>value===true)));
      if(['alibaba','1688'].includes(name) && allowSelect && state.running && state.readUnread && binding.status==='ready' && source && target?.historyStable===true && now()-read.startedAt<READ_TIMEOUT_MS && !read.revealed && !busy && ![...pending.values()].some(task=>task.platform===name) && !active.some(row=>controls(row)?.paused || controls(row)?.takeover)) {
        // These adapters can leave a newly selected history scrolled up in a background
        // tab. Only the content adapter's private prior-open permit authorizes
        // one reveal; persist consumption before the request, including lost ACKs.
        const readEpoch=epoch(conversationKey(name,read.id));
        read.revealed=true;log(state,'read_reveal',`Показываю последние сообщения ранее открытого диалога ${name==='1688'?'1688':'Alibaba'}. Текст не вводится.`,{key:conversationKey(name,read.id),platform:name});await save(state);
        if(epoch(conversationKey(name,read.id))!==readEpoch){finishRead(state,name,'Показ последних сообщений отменён пользователем.',{type:'read_cancelled'});await save(state);return;}
        try {
          const reply=await timeout(api.tabs.sendMessage(binding.tabId,{type:'DIALOGS_REVEAL_LATEST',conversationId:read.id,documentToken:read.documentToken},{frameId:read.frameId}));
          if(reply?.ok!==true)log(state,'read_reveal_skipped','Показ последних сообщений не подтверждён. Повторная прокрутка не выполняется.',{platform:name,level:'warning'});
        } catch {log(state,'read_reveal_waiting','Ответ вкладки потерян. Проверю историю без повторной прокрутки.',{platform:name,level:'warning'});}
        const refreshed=await scanPlatform(state,name);
        await advanceRead(state,name,refreshed,false);return;
      }
      if(now()-read.startedAt>=READ_TIMEOUT_MS)finishRead(state,name,'История выбранного диалога не загрузилась за 120 секунд. Повторное открытие отложено на 5 минут.',{failed:true,type:'read_timeout'});
      // At most one transition per platform and scan, even after timeout/completion.
      return;
    }
    for(const row of rows)if(row.active===true && observed.some(item=>item.id===row.id) && !row.needsRead)traversal.seenPreviews[keyOf(row)]=String(row.preview || '').slice(0,1000);
    for(const key of Object.keys(traversal.seenPreviews).slice(0,-100))delete traversal.seenPreviews[key];
    if(!allowSelect || !state.running || !state.readUnread || binding.status!=='ready' || !Number.isInteger(binding.tabId))return;
    if([...pending.values()].some(task=>task.platform===name))return;
    if(rows.some(row=>row.active===true && (controls(row)?.paused || controls(row)?.takeover)))return;
    if(sources.some(reply=>reply.busy===true || (reply.busy && typeof reply.busy==='object' && Object.values(reply.busy).some(value=>value===true)))) {
      const last=[...state.events].reverse().find(entry=>entry.platform===name && entry.type.startsWith('read_'));
      if(last?.type!=='read_busy')log(state,'read_busy','Диалоги не переключаются: в чате есть черновик или пользователь работает с ним.',{platform:name});
      return;
    }
    const folderWanted=new Set();
    if(folderConfig?.enabled&&folderConfig.auto&&approved(state)&&folderConfig.jobs.filter(folderPending).length<FOLDER_LIMITS.pending)for(const row of rows) {
      const key=keyOf(row),item=controls(row);if(!key||!item||row.active||item.draft||item.paused||item.takeover)continue;
      try {if(folderMayQueue(folderConfig,await folderSignature(state,draftRequest(state,key),folderConfig)))folderWanted.add(key);}catch{}
    }
    const candidates=rows.filter(row=>{
      const key=keyOf(row),item=controls(row);
      if(!key || !item || row.active===true || row.identityReliable!==true || row.canSelect!==true || row.selectionBusy || item.paused || item.takeover || traversal.backoff[key]>now())return false;
      if(typeof row.selectionToken!=='string' || !row.selectionToken || row.selectionToken.length>1024 || typeof row.documentToken!=='string' || !row.documentToken || row.documentToken.length>200)return false;
      const preview=String(row.preview || '').slice(0,1000),changed=preview && preview!==traversal.seenPreviews[key];
      const attempt=item.autoDraft,retry=autoConfig && !item.draft && item.unanswered && attempt && attempt.status!=='done' && attempt.attempts<3 && (attempt.status==='pending'?now()-attempt.at>=300000:now()>=(attempt.retryAt || 0));
      const folderReady=folderConfig?.enabled && folderConfig.jobs.some(job=>job.kind==='dialog'&&job.key===key&&(job.status==='done'||job.status==='awaiting_limit'&&now()>=(job.retryAt || 0)));
      return (row.unread===true && (!preview || changed)) || (row.needsRead===true && changed) || retry || folderReady || folderWanted.has(key);
    }).sort((left,right)=>Number(right.unread===true)-Number(left.unread===true));
    const row=candidates[0];if(!row)return;
    const key=keyOf(row),readEpoch=epoch(key);
    // Persist intent before the single inbox-row click. A worker restart must not repeat it.
    traversal.pending={id:row.id,startedAt:now(),documentToken:row.documentToken,frameId:row.frameId,sourceUrl:controls(row)?.sourceUrl || binding.url,preview:String(row.preview || '').slice(0,1000)};
    log(state,'read_requested','Открываю существующий диалог для чтения последних сообщений.',{key,platform:name});await save(state);
    if(epoch(key)!==readEpoch){finishRead(state,name,'Открытие диалога отменено пользователем.',{type:'read_cancelled'});await save(state);return;}
    let reply;
    try {
      reply=await timeout(api.tabs.sendMessage(binding.tabId,{type:'DIALOGS_OPEN_CONVERSATION',conversationId:row.id,documentToken:row.documentToken,selectionToken:row.selectionToken},{frameId:row.frameId}));
    } catch {
      // The click may already have happened. Observe the selected ID on the next poll.
      log(state,'read_waiting','Ответ вкладки потерян; проверю выбранный диалог без повторного клика.',{key,platform:name,level:'warning'});return;
    }
    if(reply?.ok===false) {
      finishRead(state,name,reply.busy?'Переключение отменено: в чате есть черновик или пользователь работает с ним.':'Вкладка отказалась открыть подтверждённую строку. Повторное открытие отложено на 5 минут.',{failed:true,type:reply.busy?'read_busy':'read_cancelled'});
    } else if(reply?.openedId!==row.id || reply.ok!==true) {
      log(state,'read_waiting','Открытие ещё не подтверждено; проверю точный идентификатор диалога на следующем опросе.',{key,platform:name,level:'warning'});
    }
  }

  async function scan(state, selected, {traverse=false,autoConfig=null,folderConfig=null}={}) {
    const confirmed=[],scanEpoch=cancelEpoch;confirmed.folderKeys=[];
    for(const name of selected?[platform(selected)]:PLATFORMS) {
      const observed=await scanPlatform(state,name);confirmed.push(...observed);
      const localKey=autoConfig?await candidate(state,observed,autoConfig,{ignoreBusy:true}):null;
      if(!confirmed.autoKey && !providerTask)confirmed.autoKey=localKey;
      // Preserve every eligible open history until its turn in the single AI
      // queue, including while a different platform request is in flight.
      const localFolderKey=folderConfig?await folderCandidate(state,observed,folderConfig):null;
      if(localFolderKey)confirmed.folderKeys.push(localFolderKey);
      const folderHolding=folderConfig?.enabled && observed.some(row=>row.active && folderConfig.jobs.some(job=>job.kind==='dialog' && job.key===conversationKey(name,row.id) && folderPending(job) && now()-job.createdAt<600000));
      await advanceRead(state,name,observed,traverse && !localKey && !localFolderKey && !folderHolding && cancelEpoch===scanEpoch,autoConfig,folderConfig);
    }
    await save(state);
    return confirmed;
  }

  async function generate(key,{automatic=false}={}) {
    let prepared;
    const generationEpoch=epoch(key);
    const assertCurrent=()=>{if(epoch(key)!==generationEpoch || prepared?.task?.controller.signal.aborted)throw new Error('Подготовка отменена; результат отброшен.');};
    try {
      prepared=await exclusive(async()=>{
        assertCurrent();
        if(providerTask)throw new Error('Уже выполняется один запрос к ИИ. Дождитесь его завершения.');
        const state=await load(), conversation=state.conversations[key];
        if(!conversation)throw new Error('Диалог не найден.');
        if(!approved(state))throw new Error('Сначала проверьте и утвердите тезисы товара.');
        if(automatic && (!state.running || !state.settings.autoDraft))return null;
        const config=await provider();
        if(!config.apiKey || !config.model)throw new Error(`Укажите API-ключ и модель ${providerInfo(config.provider).label} в настройках диалогов.`);
        if(!await api.permissions?.contains({origins:[providerInfo(config.provider).origin]}))throw new Error(`Разрешите доступ к ${providerInfo(config.provider).label} кнопкой подготовки черновика.`);
        const confirmed=await scan(state,conversation.platform);
        assertCurrent();
        if(state.traversal[conversation.platform].pending)throw new Error('Дождитесь завершения чтения выбранного диалога, затем подготовьте черновик.');
        if(!confirmed.some(row=>row.platform===conversation.platform && row.id===conversation.id && row.active))throw new Error('Откройте этот диалог в привязанной вкладке: нужен свежий текст и достоверный порядок сообщений.');
        const source=confirmed.find(row=>row.platform===conversation.platform && row.id===conversation.id && row.active);
        const request=draftRequest(state,key), prompt=buildDraftPrompt(state,request), controller=new AbortController();
        if(automatic && (source.busy || !mayAuto(conversation,await attemptFingerprint(state,request,config))))return null;
        const imageKeys=[],imageInputs=[];
        for(const message of conversation.messages)for(const attachment of message.attachments || [])for(const image of attachment.resolution?.images || []) {
          if(!imageKeys.includes(image.imageKey))imageKeys.push(image.imageKey);
          imageInputs.push({imageIndex:imageKeys.indexOf(image.imageKey)+1,messageKey:message.key,direction:message.direction,attachmentName:attachment.name || '',imageKey:image.imageKey});
        }
        if(imageKeys.length>8) {
          const error='В доступной истории больше восьми изображений. Нужна ручная проверка вложений перед подготовкой ответа.';
          await reserveAttempt(state,key,request,config);assertCurrent();
          conversation.autoDraft={...conversation.autoDraft,status:'error',attempts:3,retryAt:0,error};
          log(state,'draft_failed',error,{key,platform:conversation.platform,level:'warning'});await save(state);
          return {blocked:true,error};
        }
        if(imageInputs.length)prompt.user=JSON.stringify({...JSON.parse(prompt.user),imageInputs});
        const task={id:crypto.randomUUID(),controller,platform:conversation.platform};
        const signature=await reserveAttempt(state,key,request,config);assertCurrent();
        log(state,'draft_requested',automatic?'Готовлю черновик для нового входящего по утверждённому заданию. Сообщение не отправляется.':'Подготовка черновика запрошена пользователем. Сообщение не отправляется.',{key,platform:conversation.platform});
        await save(state);
        pending.set(key,task);providerTask=task;
        return {request,prompt,config,task,source,signature,imageKeys,tabId:state.bindings[conversation.platform].tabId,platform:conversation.platform};
      });
      if(!prepared)return {ok:true,skipped:true};
      if(prepared.blocked)return {ok:false,error:prepared.error};
      assertCurrent();
      const images=[];for(const imageKey of prepared.imageKeys){if(prepared.task.controller.signal.aborted)throw new Error('Подготовка отменена.');images.push(await imageLoader(imageKey));}
      assertCurrent();
      const result=await generateDialogDraft({provider:prepared.config.provider,apiKey:prepared.config.apiKey,model:prepared.config.model,prompt:prepared.prompt,images,signal:prepared.task.controller.signal,fetchImpl});
      return await exclusive(async()=>{
        if(pending.get(key)!==prepared.task)throw new Error('Подготовка отменена; полученный черновик отброшен.');
        const state=await load(), config=await provider();
        if(automatic && (!state.running || !state.settings.autoDraft))throw new Error('Авточерновики остановлены; результат отброшен.');
        if(config.revision!==prepared.config.revision || state.bindings[prepared.platform]?.tabId!==prepared.tabId)throw new Error('Настройки или привязка изменились; черновик отброшен.');
        // Re-read before accepting: supplier may have replied while the provider was working.
        const confirmed=await scan(state,prepared.platform);
        assertCurrent();
        if(pending.get(key)!==prepared.task)throw new Error('Подготовка отменена; полученный черновик отброшен.');
        const conversation=state.conversations[key];
        const source=confirmed.find(row=>row.platform===prepared.platform && row.id===conversation?.id && row.active);
        if(!source || (automatic && source.busy) || source.frameId!==prepared.source.frameId || source.documentToken!==prepared.source.documentToken)throw new Error('Диалог или страница изменились; черновик отброшен.');
        acceptDraft(state,prepared.request,result,now());
        conversation.autoDraft={...conversation.autoDraft,status:'done',at:now(),retryAt:0,error:''};
        await save(state);
        return publicState(state);
      });
    } catch(error) {
      const detail=error instanceof Error?error.message:'Не удалось подготовить черновик.';
      // Journal contains only fixed diagnostics, never provider errors or transcript text.
      const reason=detail.startsWith('Укажите API-ключ и модель ')?'Не заданы API-ключ или модель выбранного сервиса.':prepared?'Черновик не получен, отменён или устарел. Проверьте состояние диалога перед повторной попыткой.':'Не удалось начать подготовку черновика. Проверьте настройки ИИ и откройте актуальный диалог.';
      await exclusive(async()=>{
        const state=await load(),item=state.conversations[key];
        if(prepared && item?.autoDraft?.fingerprint===prepared.signature && item.autoDraft.status==='pending')item.autoDraft={...item.autoDraft,status:'error',at:now(),retryAt:now()+Math.min(1800000,300000*2**Math.max(0,item.autoDraft.attempts-1)),error:reason};
        log(state,'draft_failed',reason,{key,platform:prepared?.platform || item?.platform,level:'warning'});await save(state);
      }).catch(()=>{});
      return {ok:false,error:detail};
    } finally {
      if(prepared && pending.get(key)===prepared.task)pending.delete(key);
      if(prepared && providerTask===prepared.task)providerTask=null;
    }
  }

  function checkProductVersion(state,message) {
    if(message.revision!==undefined && message.revision!==state.product.revision)throw new Error('Задание товара изменилось. Обновите страницу перед сохранением.');
    if(message.fingerprint!==undefined && message.fingerprint!==productFingerprint(state))throw new Error('Задание товара изменилось. Проверьте актуальные тезисы.');
  }
  async function extractProduct(message) {
    let prepared;
    const key='__product_extraction__',generationEpoch=epoch(key);
    const assertCurrent=()=>{if(epoch(key)!==generationEpoch || prepared?.task?.controller.signal.aborted)throw new Error('Разбор отменён; результат отброшен.');};
    try {
      prepared=await exclusive(async()=>{
        if(providerTask)throw new Error('Уже выполняется один запрос к ИИ. Дождитесь его завершения.');
        const state=await load();checkProductVersion(state,message);
        const config=await provider();
        if(!config.apiKey || !config.model)throw new Error(`Укажите API-ключ и модель ${providerInfo(config.provider).label} в настройках диалогов.`);
        if(!await api.permissions?.contains({origins:[providerInfo(config.provider).origin]}))throw new Error(`Разрешите доступ к ${providerInfo(config.provider).label}.`);
        assertCurrent();
        const request=productExtractionRequest(state),prompt=buildProductExtractionPrompt(state,request);
        const imageKeys=[...new Set(state.product.files.filter(file=>!file.excluded).flatMap(file=>(file.images?.length?file.images.map(image=>image.imageKey):file.imageKey?[file.imageKey]:[])).filter(Boolean))];
        if(imageKeys.length>8)throw new Error('Для одного разбора разрешено не более восьми изображений.');
        const task={id:crypto.randomUUID(),controller:new AbortController(),platform:null};
        log(state,'product_extraction_started','Разбор материалов товара запрошен пользователем. Результат потребует проверки и утверждения.');await save(state);
        providerTask=task;pending.set(key,task);return {request,prompt,config,task,imageKeys};
      });
      assertCurrent();
      const images=[];for(const imageKey of prepared.imageKeys){if(prepared.task.controller.signal.aborted)throw new Error('Разбор отменён.');images.push(await imageLoader(imageKey));}
      if(prepared.task.controller.signal.aborted)throw new Error('Разбор отменён.');
      const result=await extractProductKeyPoints({provider:prepared.config.provider,apiKey:prepared.config.apiKey,model:prepared.config.model,prompt:prepared.prompt,images,signal:prepared.task.controller.signal,fetchImpl});
      return await exclusive(async()=>{
        if(pending.get(key)!==prepared.task)throw new Error('Разбор отменён; результат отброшен.');
        const state=await load(),config=await provider();
        if(config.revision!==prepared.config.revision)throw new Error('Настройки ИИ изменились; разбор повторите после проверки.');
        assertCurrent();
        acceptProductExtraction(state,prepared.request,{...result,processedImageKeys:prepared.imageKeys},now());await save(state);return publicState(state);
      });
    } catch(error) {
      await exclusive(async()=>{const state=await load();log(state,'product_extraction_failed','Разбор материалов не завершён, отменён или устарел. Проверьте файлы и настройки; товар не утверждён.',{level:'warning'});await save(state);}).catch(()=>{});
      return {ok:false,error:error instanceof Error?error.message:'Не удалось разобрать материалы товара.'};
    } finally {
      if(prepared && pending.get(key)===prepared.task)pending.delete(key);
      if(prepared && providerTask===prepared.task)providerTask=null;
    }
  }

  const folderDraftGuard=item=>folderDigest(item?.draft || null);
  const sameRequest=sameJsonValue;
  const folderCurrentRequest=(request,job)=>({...request,imageKeys:job.request.imageKeys || []});
  async function folderSignature(state,request,folder) {
    return folderDigest(request.key?{kind:'dialog',context:await attemptFingerprint(state,request,{revision:0}),model:folder.model}:{kind:'product',request,model:folder.model});
  }
  function folderMayQueue(folder,signature) {
    if(folder.completed.includes(signature))return false;
    const prior=folder.jobs.filter(job=>job.signature===signature);
    if(prior.some(job=>folderPending(job)||['accepted','sending','sent','send_unknown','cancelled'].includes(job.status)))return false;
    // Failed jobs are retried explicitly. Never spend subscription quota in a loop.
    return !prior.length || prior.every(job=>job.status==='stale')&&Math.max(...prior.map(job=>job.attempts))<FOLDER_LIMITS.attempts;
  }
  async function folderCandidate(state,observed,folder) {
    if(!folder.enabled||!folder.auto||!state.running||!approved(state)||providerTask||folder.jobs.filter(folderPending).length>=FOLDER_LIMITS.pending)return null;
    for(const row of observed) {
      if(!row.active||row.busy||state.traversal[row.platform].pending)continue;
      const key=conversationKey(row.platform,row.id),item=state.conversations[key];
      if(item?.draft)continue;
      try {if(folderMayQueue(folder,await folderSignature(state,draftRequest(state,key),folder)))return key;}catch{}
    }
    return null;
  }
  async function folderStatus(folder) {
    try {
      const response=await bridge.call('status');
      if(response.protocol!==1)throw new Error('Несовместимая версия локального моста.');
      folder.folder=typeof response.folder==='string'?response.folder.slice(0,1000):'';
      folder.worker={running:response.worker?.running===true,heartbeat:Number.isFinite(response.worker?.heartbeat)?response.worker.heartbeat:null,status:typeof response.worker?.status==='string'?response.worker.status.slice(0,80):'',pauseReason:typeof response.worker?.pauseReason==='string'?response.worker.pauseReason.slice(0,80):''};
      folder.claude={available:response.claude?.available===true};
      folder.status=!folder.enabled?'disabled':!folder.claude.available?'claude_missing':folder.worker.status==='paused'?'paused':folder.worker.running?'ready':'waiting';
      folder.detail=!folder.enabled?'Обработка через папку выключена.':!folder.claude.available?'Claude Code не найден. Установите его и войдите в аккаунт; для ответов нужен интернет.':folder.worker.running?'Локальный обработчик доступен. Доступ к Claude требует интернет-соединения.':'Задания сохраняются в папку. Запустите обработчик; для ответов Claude нужен интернет.';
      if(folder.enabled&&folder.worker.status==='paused')folder.detail=({offline:'Claude без интернета. Задания сохранены; после подключения нажмите «Подключить / возобновить».',authentication_required:'Нужен вход в Claude Code. После входа возобновите обработчик.',usage_limit:'Достигнут лимит Claude. После обновления лимита возобновите обработку.',claude_update_required:'Обновите Claude Code и возобновите обработку.'})[folder.worker.pauseReason] || 'Обработчик Claude приостановлен. Проверьте его локальный журнал и возобновите работу.';
    } catch {
      folder.status='unavailable';folder.detail='Локальный мост недоступен. Проверьте установку компонента Windows и разрешение nativeMessaging.';
    }
    await saveFolder(folder);return folder;
  }
  async function folderCancelPending(folder,{key=null,automaticOnly=false}={}) {
    const jobs=folder.jobs.filter(job=>folderPending(job)&&(!key||job.key===key)&&(!automaticOnly||job.automatic));
    for(const job of jobs) {finishFolderJob(folder,job,'cancelled','Задание отменено. Полученный ответ не будет использован.',now());job.ack='cancelled';job.ackPending=true;}
    await saveFolder(folder);
    await Promise.all(jobs.map(async job=>{try {await bridge.call('cancel',{id:job.id});job.ackPending=false;}catch{}}));
    await saveFolder(folder);
  }
  const folderImageDescriptors=(state,kind,key)=>kind==='product'?state.product.files.filter(file=>!file.excluded).flatMap(file=>(file.images || []).map(image=>({...image,name:file.name}))):state.conversations[key].messages.flatMap(message=>(message.attachments || []).flatMap(file=>(file.resolution?.images || []).map(image=>({...image,name:file.name,messageKey:message.key,direction:message.direction}))));
  async function folderPayload(state,job) {
    let prompt;const descriptors=folderImageDescriptors(state,job.kind,job.key);
    if(job.kind==='product') {
      prompt=buildProductExtractionPrompt(state,job.request);
    } else {
      prompt=buildDraftPrompt(state,job.request);
      if(descriptors.length)prompt.user=JSON.stringify({...JSON.parse(prompt.user),imageInputs:descriptors.map(({imageKey,messageKey,direction,name})=>({imageKey,messageKey,direction,attachmentName:name}))});
    }
    const images=await folderImages(descriptors,imageLoader);
    return {id:job.id,kind:job.kind,createdAt:job.createdAt,request:job.request,prompt:renderFolderPrompt(prompt),images};
  }
  async function submitFolder(state,folder,job,preparedPayload=null) {
    const jobEpoch=epoch(job.key);let payload;
    try {payload=preparedPayload || await folderPayload(state,job);}catch {finishFolderJob(folder,job,'error','Не удалось прочитать все материалы задания. Проверьте локальные изображения.',now());await saveFolder(folder);return;}
    if(epoch(job.key)!==jobEpoch)throw new Error('Задание отменено до записи в папку.');
    // Record the UUID before writing a file: timeout means outcome unknown, not absent.
    job.status='unknown';job.at=now();job.detail='Записываю задание в локальную папку.';await saveFolder(folder);
    try {
      const response=await bridge.call('submit',{job:payload});
      if(response.jobId!==job.id||!['queued','running','done','error','cancelled'].includes(response.status))throw new Error('Некорректный ответ моста.');
      if(epoch(job.key)!==jobEpoch) {finishFolderJob(folder,job,'cancelled','Задание отменено во время записи.',now());job.ack='cancelled';job.ackPending=true;}
      else {job.status=response.status;job.detail=response.status==='error'?'Обработчик сообщил об ошибке. Проверьте локальный журнал.':'Задание записано. Ожидаю ответ Claude.';}
    } catch {job.status='unknown';job.detail='Ответ моста потерян. Проверю тот же идентификатор; новая копия задания не создаётся.';}
    await saveFolder(folder);
    log(state,'folder_queued','Задание записано или ожидает подтверждения локальной папки. Сообщение поставщику не отправлено.',{key:job.key,platform:state.conversations[job.key]?.platform});await save(state);
  }
  async function enqueueFolder(state,folder,{kind='dialog',key='',message={},automatic=false,observed=null}={}) {
    if(!folder.enabled)throw new Error('Сначала включите обработку через локальную папку.');
    if(!await api.permissions?.contains({permissions:['nativeMessaging']}))throw new Error('Разрешите подключение к локальной папке.');
    if(providerTask)throw new Error('Дождитесь завершения текущего запроса к ИИ.');
    let request,source;
    if(kind==='product') {checkProductVersion(state,message);request=productExtractionRequest(state);buildProductExtractionPrompt(state,request);key='__product_extraction__';}
    else {
      const item=state.conversations[key];if(!item)throw new Error('Диалог не найден.');
      if(item.draft)throw new Error('В диалоге уже есть черновик. Сначала проверьте или удалите его.');
      observed=observed || await scan(state,item.platform);
      source=observed.find(row=>row.platform===item.platform&&row.id===item.id&&row.active);
      if(!source||source.busy||state.traversal[item.platform].pending)throw new Error('Откройте диалог и дождитесь полного чтения. Поле чата должно быть свободно.');
      request=draftRequest(state,key);
    }
    const signature=await folderSignature(state,request,folder);
    if(!folderMayQueue(folder,signature))throw new Error('Такое задание уже есть в журнале папки. При ошибке используйте повтор той же записи.');
    request={...request,imageKeys:[...new Set(folderImageDescriptors(state,kind,key).map(image=>image.imageKey))]};
    const job={id:crypto.randomUUID(),kind,key,signature,request,createdAt:now(),at:now(),status:'preparing',detail:'Подготовка задания.',configRevision:folder.revision,attempts:1+Math.max(0,...folder.jobs.filter(job=>job.signature===signature).map(job=>job.attempts)),automatic,draftGuard:await folderDraftGuard(state.conversations[key]),tabId:source?state.bindings[state.conversations[key].platform].tabId:null,frameId:source?.frameId??null,documentToken:source?.documentToken||'',sourceUrl:source?.sourceUrl||'',ack:null,ackPending:false};
    // Missing images become a retryable error, never a text-only Claude request.
    let checkedPayload;
    try {checkedPayload=await folderPayload(state,job);job.request={...job.request,imageKeys:checkedPayload.images.map(image=>image.imageKey)};checkedPayload.request=job.request;}
    catch {reserveFolderJob(folder,job);finishFolderJob(folder,job,'error','Не удалось прочитать все материалы задания. Проверьте локальные изображения.',now());await saveFolder(folder);throw new Error('Не удалось прочитать изображения задания. Проверьте вложения и повторите запись из журнала.');}
    reserveFolderJob(folder,job);await saveFolder(folder);
    await submitFolder(state,folder,job,checkedPayload);await schedule();return job;
  }
  async function acknowledgeFolder(folder,job,outcome) {
    job.ack=outcome;job.ackPending=true;await saveFolder(folder);
    try {await bridge.call('ack',{id:job.id,outcome});job.ackPending=false;await saveFolder(folder);}catch{}
  }
  async function sendContext(state,key) {
    const item=state.conversations[key],last=item?.messages.filter(message=>message.direction==='inbound').at(-1);
    if(!last)throw new Error('Последнее входящее сообщение не подтверждено.');
    // One reply per incoming supplier message, even if model, buyer settings or
    // the reviewed text change while the platform has not refreshed its DOM.
    return folderDigest([key,last.key,last.text,last.at,(last.attachments || []).map(file=>file.sourceFingerprint)]);
  }
  async function guardedReply(state,folder,{request,text,source,job=null,jobEpoch}) {
    const context=await sendContext(state,request.key),item=state.conversations[request.key];
    const prior=folder.sendReceipts.find(receipt=>receipt.context===context&&['reserved','sent','unknown'].includes(receipt.status));
    const legacy=folder.jobs.some(candidate=>candidate.key===request.key&&candidate.request?.fingerprint===request.fingerprint&&['sending','sent','send_unknown'].includes(candidate.status));
    if(prior||legacy)return {status:'blocked',reason:'Для этого входящего сообщения отправка уже выполнена или её исход неизвестен. Проверьте переписку; повтор запрещён.'};
    const textHash=await folderDigest(text);let receipt=null,outcome;
    try {
      outcome=await folderSender({api,now,state,request,text,enabled:true,source,shouldContinue:()=>epoch(request.key)===jobEpoch,reserve:async reservation=>{
        if(epoch(request.key)!==jobEpoch)return {ok:false,reason:'Отправка остановлена: режим или контекст изменился.'};
        if(typeof reserveDialogSendQuota!=='function')return {ok:false,reason:'Недоступна общая очередь лимитов отправки.'};
        folder.sendReceipts=folder.sendReceipts.filter(entry=>entry.status!=='blocked');
        if(folder.sendReceipts.length>=FOLDER_LIMITS.sendReceipts)return {ok:false,reason:'Журнал подтверждённых отправок заполнен. Отправка остановлена; сохранённые подтверждения не удаляются автоматически.'};
        const jobId=job?.id || crypto.randomUUID(),quota=await reserveDialogSendQuota({...reservation,jobId});if(quota?.ok!==true)return quota;
        receipt={id:reservation.attemptId,jobId,context,textHash,key:request.key,fingerprint:item.fingerprint,status:'reserved',at:now()};folder.sendReceipts.push(receipt);
        if(job)finishFolderJob(folder,job,'sending','Попытка отправки зарегистрирована. Автоматический повтор запрещён.',now());
        await saveFolder(folder);return {ok:true};
      }});
    } catch {outcome={status:receipt?'unknown':'blocked',reason:receipt?'Связь потеряна после регистрации отправки. Проверьте переписку; повтор запрещён.':'Не удалось подготовить отправку. Проверьте вкладку чата.'};}
    if(receipt) {
      receipt.status=outcome?.status==='attempted'?'sent':outcome?.status==='blocked'?'blocked':'unknown';receipt.at=now();
      await saveFolder(folder);
    }
    return outcome || {status:'blocked',reason:'Отправка не выполнялась.'};
  }
  async function sendReviewedDraft(state,folder,message,jobEpoch) {
    if(!state.running)throw new Error('Сначала запустите мониторинг привязанных чатов.');
    if(typeof folderSender!=='function')throw new Error('Обработчик отправки недоступен.');
    const validate=()=>{
      if(epoch(message.key)!==jobEpoch)throw new Error('Отправка остановлена: режим, черновик или контекст изменился.');
      const request=draftRequest(state,message.key),item=state.conversations[message.key];
      if(!item?.draft || item.draft.status!=='draft' || item.draft.revision!==request.revision || item.draft.fingerprint!==request.fingerprint || item.draft.productFingerprint!==request.productFingerprint || typeof message.text!=='string' || message.text!==item.draft.text || message.revision!==request.revision || message.fingerprint!==request.fingerprint || message.productFingerprint!==request.productFingerprint)throw new Error('Черновик или задание изменились. Проверьте и сохраните актуальный ответ перед отправкой.');
      return {request,item};
    };
    let {item}=validate();
    const observed=await scan(state,item.platform),checked=validate(),source=observed.find(row=>row.platform===item.platform&&row.id===item.id&&row.active);
    item=checked.item;
    if(!source || source.busy || state.traversal[item.platform].pending)throw new Error('Откройте именно этот диалог и дождитесь полного чтения. Поле чата должно быть свободно.');
    const outcome=await guardedReply(state,folder,{request:checked.request,text:message.text,source:{tabId:state.bindings[item.platform].tabId,frameId:source.frameId,documentToken:source.documentToken,sourceUrl:source.sourceUrl,replyFingerprint:source.replyFingerprint},jobEpoch});
    const status=['attempted','unknown','deferred'].includes(outcome.status)?outcome.status:'blocked';
    const detail=status==='attempted'?'Кнопка отправки нажата. Доставка и прочтение не проверяются.':status==='unknown'?'Исход отправки неизвестен. Проверьте переписку; повтор запрещён.':status==='deferred'?'Лимит площадки пока исчерпан. Ответ сохранён; после обновления лимита подтвердите отправку заново.':outcome.reason || 'Отправка остановлена до нажатия. Проверьте диалог.';
    log(state,'draft_send',detail,{key:message.key,platform:item.platform,level:status==='unknown'?'warning':'info'});await save(state);
    return {...await publicState(state),send:{status,detail,...(Number.isFinite(outcome.retryAt)?{retryAt:outcome.retryAt}:{})}};
  }
  async function pollFolder(state,folder) {
    if(!folder.enabled)return;
    const pollEpoch=cancelEpoch;
    await folderStatus(folder);if(cancelEpoch!==pollEpoch)return;if(folder.status==='unavailable')return;
    for(const job of folder.jobs.filter(job=>job.ackPending))await acknowledgeFolder(folder,job,job.ack);
    const jobs=folder.jobs.filter(job=>folderPending(job)&&(job.status!=='awaiting_limit'||now()>=(job.retryAt || 0))).slice(0,FOLDER_LIMITS.poll);if(!jobs.length)return;
    let response;
    try {response=await bridge.call('poll',{ids:jobs.map(job=>job.id)});if(!Array.isArray(response.results))throw new Error('Invalid poll');}
    catch {folder.status='unavailable';folder.detail='Не удалось проверить файлы ответов. Ожидающие задания сохранены.';await saveFolder(folder);return;}
    if(cancelEpoch!==pollEpoch)return;
    const seen=new Set();
    for(const result of response.results.slice(0,FOLDER_LIMITS.poll)) {
      if(cancelEpoch!==pollEpoch)break;
      const job=jobs.find(job=>job.id===result?.id);if(!job||seen.has(job.id))continue;seen.add(job.id);
      if(!['queued','running','done','error','cancelled'].includes(result.status))continue;
      if(result.status!=='done') {job.status=result.status;job.at=now();job.detail=result.status==='error'?'Claude не обработал задание. Проверьте интернет, вход и журнал; повтор доступен вручную.':result.status==='cancelled'?'Обработчик отменил задание.':'Ожидаю ответ Claude в локальной папке.';continue;}
      const awaitingLimit=job.status==='awaiting_limit'||(job.sendDeferrals || 0)>0;
      job.status='done';job.at=now();job.detail='Ответ готов; проверяю актуальность диалога.';
      const jobEpoch=epoch(job.key);
      const reject=async detail=>{finishFolderJob(folder,job,'stale',detail,now());await acknowledgeFolder(folder,job,'stale');log(state,'folder_stale',detail,{key:job.key,level:'warning'});};
      if(!sameRequest(result.request,job.request)||!sameRequest(result.imageKeys || [],job.request.imageKeys || [])||job.configRevision!==folder.revision) {await reject('Ответ отклонён: задание или настройки изменились.');continue;}
      try {
        if(job.kind==='product') {
          if(!sameRequest(folderCurrentRequest(productExtractionRequest(state),job),job.request))throw new Error('stale');
          const parsed=parseProductKeyPoints(result.text,'anthropic');
          if(epoch(job.key)!==jobEpoch)throw new Error('cancelled');
          const imageKeys=state.product.files.filter(file=>!file.excluded).flatMap(file=>(file.images || []).map(image=>image.imageKey));
          acceptProductExtraction(state,job.request,{...parsed,processedImageKeys:imageKeys},now());state.settings.autoDraft=false;
          finishFolderJob(folder,job,'accepted','Тезисы получены. Проверьте и утвердите товар вручную.',now());await save(state);await acknowledgeFolder(folder,job,'accepted');continue;
        }
        const item=state.conversations[job.key];
        if(!item||item.paused||item.takeover||await folderDraftGuard(item)!==job.draftGuard||state.bindings[item.platform]?.tabId!==job.tabId)throw new Error('stale');
        // Pausing observation freezes automatic consumption. Explicit/manual
        // jobs can still become drafts, but can never send with the monitor off.
        if(job.automatic&&(!state.running||!folder.auto))continue;
        const observed=await scan(state,item.platform),current=state.conversations[job.key],source=observed.find(row=>row.platform===item.platform&&row.id===item.id&&row.active);
        if(!source){job.detail='Ответ готов. Ожидаю повторного чтения именно этого диалога.';continue;}
        if(source.busy){job.detail='Ответ готов. Ожидаю завершения работы пользователя в чате.';continue;}
        if(source.documentToken!==job.documentToken||source.frameId!==job.frameId||source.sourceUrl!==job.sourceUrl||!sameRequest(folderCurrentRequest(draftRequest(state,job.key),job),job.request)||await folderDraftGuard(current)!==job.draftGuard||epoch(job.key)!==jobEpoch)throw new Error('stale');
        if(typeof result.text!=='string'||!result.text.trim()||result.text.length>6000)throw new Error('invalid');
        if(awaitingLimit&&current.draft?.text!==result.text.trim())throw new Error('draft changed');
        if(!awaitingLimit)acceptDraft(state,job.request,{text:result.text,reason:'Ответ Claude получен из локальной папки.'},now());
        finishFolderJob(folder,job,'accepted','Ответ сохранён как черновик.',now());await save(state);await saveFolder(folder);
        if(folder.autoSend&&folder.auto&&state.running&&approved(state)&&typeof folderSender==='function') {
          const outcome=await guardedReply(state,folder,{request:job.request,text:current.draft.text,source:{tabId:job.tabId,frameId:source.frameId,documentToken:source.documentToken,sourceUrl:source.sourceUrl,replyFingerprint:source.replyFingerprint},job,jobEpoch});
          const deferred=outcome?.status==='deferred'&&outcome.reserved!==true&&Number.isFinite(outcome.retryAt)&&(job.sendDeferrals || 0)<100;
          const status=deferred?'awaiting_limit':outcome?.status==='attempted'?'sent':outcome?.status==='unknown'?'send_unknown':'accepted';
          if(deferred){job.retryAt=Math.max(now()+30000,outcome.retryAt+500);job.sendDeferrals=(job.sendDeferrals || 0)+1;job.draftGuard=await folderDraftGuard(current);}
          finishFolderJob(folder,job,status,status==='awaiting_limit'?'Ответ готов. Ожидаю освобождения общего лимита площадки; новый запрос Claude не выполняется.':status==='sent'?'Нажатие отправки выполнено; доставка не проверяется.':status==='send_unknown'?'Исход отправки неизвестен. Проверьте переписку; автоматического повтора не будет.':'Черновик сохранён. Отправка отложена или заблокирована; проверьте диалог.',now());
          log(state,'folder_send',job.detail,{key:job.key,platform:item.platform,level:status==='send_unknown'?'warning':'info'});await save(state);
        }
        if(job.status==='awaiting_limit')await saveFolder(folder);else await acknowledgeFolder(folder,job,'accepted');
      } catch {await reject('Ответ не применён: история, получатель, товар или черновик изменились либо ответ некорректен.');}
    }
    await saveFolder(folder);await save(state);
  }
  async function folderSettings(state,folder,message) {
    const next={enabled:Object.hasOwn(message,'enabled')?message.enabled===true:folder.enabled,auto:Object.hasOwn(message,'auto')?message.auto===true:folder.auto,autoSend:Object.hasOwn(message,'autoSend')?message.autoSend===true:folder.autoSend,model:Object.hasOwn(message,'model')?folderModel(message.model):folder.model};
    if(!next.enabled){next.auto=false;next.autoSend=false;}if(!next.auto)next.autoSend=false;
    if(next.enabled&&!await api.permissions?.contains({permissions:['nativeMessaging']}))throw new Error('Разрешите подключение к локальной папке.');
    if(next.auto&&!approved(state))throw new Error('Сначала проверьте и утвердите тезисы товара.');
    if(next.enabled)state.settings.autoDraft=false;
    const generationChanged=['enabled','auto','model'].some(key=>folder[key]!==next[key]);
    const workerChanged=['enabled','model'].some(key=>folder[key]!==next[key]);
    if(generationChanged) {await folderCancelPending(folder);folder.revision++;}
    Object.assign(folder,next);await saveFolder(folder);
    try {
      // Switching only send approval never cancels a paid draft generation or
      // silently resumes a worker paused for connection/auth/subscription limits.
      if(workerChanged || message.resume===true || !folder.enabled)await bridge.call('configure',{enabled:folder.enabled,model:folder.model});
      await folderStatus(folder);
    }catch {folder.status='unavailable';folder.detail='Настройки сохранены. Установите локальный мост и обработчик папки.';await saveFolder(folder);}
    if(folder.enabled)await schedule();else if(!state.running)await clearAlarm();
    log(state,'folder_settings',folder.enabled?`Обработка через папку включена. ${folder.autoSend?'Автоматическая отправка разрешена для проверенных ответов.':'Ответы сохраняются черновиками.'}`:'Обработка через папку выключена.');await save(state);
  }

  async function toggleAuto(state,enabled) {
    if(enabled) {
      if(!apiAutoAvailable())throw new Error('Автоматические ответы доступны через локальную папку Claude.');
      if((await loadFolder()).auto)throw new Error('Сначала выключите автоматическую обработку через папку.');
      if(!approved(state))throw new Error('Сначала проверьте и утвердите тезисы товара.');
      const config=await provider();
      if(!config.apiKey || !config.model)throw new Error(`Укажите API-ключ и модель ${providerInfo(config.provider).label}.`);
      if(!await api.permissions?.contains({origins:[providerInfo(config.provider).origin]}))throw new Error(`Разрешите доступ к ${providerInfo(config.provider).label} для авточерновиков.`);
    } else cancel();
    setDialogSettings(state,{...state.settings,autoDraft:enabled},now());
    log(state,'auto_drafts',enabled?'Авточерновики включены для новых входящих по утверждённому заданию. Отправка отключена.':'Авточерновики выключены.');
  }

  async function command(message,commandEpoch) {
    const state=await load(),folder=await loadFolder();
    const invalidates=['DIALOGS_STOP','DIALOGS_SETTINGS','DIALOGS_CONTEXT_EDITING','DIALOGS_PRODUCT_SAVE','DIALOGS_PRODUCT_APPROVE','DIALOGS_IMPORT_PRODUCT_RESULT','DIALOGS_BIND_TAB','DIALOGS_UNBIND_TAB'];
    if(invalidates.includes(message.type))await folderCancelPending(folder);
    else if(['DIALOGS_CONTROL','DIALOGS_SAVE_DRAFT','DIALOGS_DRAFT_EDITING','DIALOGS_SEND_DRAFT','DIALOGS_DISCARD_DRAFT'].includes(message.type))await folderCancelPending(folder,{key:message.key});
    switch(message.type) {
      case 'DIALOGS_SEND_DRAFT':return sendReviewedDraft(state,folder,message,commandEpoch);
      case 'DIALOGS_DRAFT_EDITING':return publicState(state);
      case 'DIALOGS_CONTEXT_EDITING':folder.auto=false;folder.autoSend=false;state.settings.autoDraft=false;await saveFolder(folder);await save(state);return publicState(state);
      case 'DIALOGS_FOLDER_STATUS':await folderStatus(folder);return publicState(state);
      case 'DIALOGS_FOLDER_SETTINGS':await folderSettings(state,folder,message);return publicState(state);
      case 'DIALOGS_FOLDER_PRODUCT':await enqueueFolder(state,folder,{kind:'product',message});return publicState(state);
      case 'DIALOGS_FOLDER_DRAFT':await enqueueFolder(state,folder,{key:message.key});return publicState(state);
      case 'DIALOGS_FOLDER_POLL':await pollFolder(state,folder);return publicState(state);
      case 'DIALOGS_FOLDER_CANCEL': {
        const job=folder.jobs.find(job=>job.id===message.id);if(!job)throw new Error('Задание папки не найдено.');
        if(!folderPending(job))throw new Error('Задание уже завершено.');
        cancel(job.key);await folderCancelPending(folder,{key:job.key});return publicState(state);
      }
      case 'DIALOGS_FOLDER_RETRY': {
        const job=folder.jobs.find(job=>job.id===message.id);if(!job)throw new Error('Задание папки не найдено.');
        if(!folder.enabled)throw new Error('Сначала включите обработку через папку.');
        if(!['unknown','error'].includes(job.status)||job.attempts>=FOLDER_LIMITS.attempts)throw new Error('Повтор недоступен: задание завершено, ещё работает или достигнут предел трёх попыток.');
        if(job.configRevision!==folder.revision)throw new Error('Настройки изменились. Создайте актуальное задание.');
        if(job.kind==='dialog') {
          const item=state.conversations[job.key];if(!item)throw new Error('Диалог не найден.');
          const observed=await scan(state,item.platform),source=observed.find(row=>row.active&&row.id===item.id&&row.platform===item.platform);
          if(!source||source.busy||source.frameId!==job.frameId||source.documentToken!==job.documentToken||await folderDraftGuard(item)!==job.draftGuard||!sameRequest(folderCurrentRequest(draftRequest(state,job.key),job),job.request))throw new Error('Диалог изменился. Создайте актуальное задание.');
        } else if(!sameRequest(folderCurrentRequest(productExtractionRequest(state),job),job.request))throw new Error('Товар изменился. Создайте актуальное задание.');
        const related=folder.jobs.filter(item=>item.signature===job.signature);
        if(related.some(item=>item.id!==job.id&&folderPending(item))||folder.completed.includes(job.signature))throw new Error('Это задание уже обрабатывается или завершено.');
        const attempts=Math.max(...related.map(item=>item.attempts));if(attempts>=FOLDER_LIMITS.attempts)throw new Error('Достигнут предел трёх попыток. Проверьте ошибку вручную.');
        if(job.status==='error') {
          const retry={...job,id:crypto.randomUUID(),createdAt:now(),at:now(),status:'preparing',attempts:attempts+1,ack:null,ackPending:false};reserveFolderJob(folder,retry);await saveFolder(folder);await submitFolder(state,folder,retry);
        } else {job.attempts=attempts+1;await submitFolder(state,folder,job);}
        return publicState(state);
      }
      case 'DIALOGS_GET': return publicState(state);
      case 'DIALOGS_EXPORT_PRODUCT_PROMPT': {
        checkProductVersion(state,message);
        const promptExport=buildManualProductPrompt(state,productExtractionRequest(state),{now:now()});
        log(state,'product_prompt_exported','Промпт товара подготовлен для ручной передачи в Claude. Запрос к API не выполнялся.');
        await save(state);return {...await publicState(state),promptExport};
      }
      case 'DIALOGS_IMPORT_PRODUCT_RESULT': {
        if(!message.request || typeof message.request.fingerprint!=='string' || !Number.isSafeInteger(message.request.revision))throw new Error('Сначала сформируйте промпт для текущей версии товара.');
        const promptExport=buildManualProductPrompt(state,message.request,{now:now()});
        if(promptExport.requiredImages.length && message.imagesAttached!==true)throw new Error('Подтвердите, что приложили все перечисленные изображения к запросу Claude.');
        let result;
        try {result=parseProductKeyPoints(message.text,'anthropic');}
        catch {throw new Error('Вставьте полный JSON-ответ Claude с текстовыми полями keyPoints, questions и warnings. Поле keyPoints не должно быть пустым; ответ — не более 40000 символов.');}
        cancel();
        acceptProductExtraction(state,message.request,{...result,processedImageKeys:promptExport.requiredImages.map(image=>image.imageKey)},now());
        state.settings.autoDraft=false;
        log(state,'product_result_imported','Ответ Claude добавлен вручную. Проверьте факты и согласуйте новую версию товара.');
        break;
      }
      case 'DIALOGS_EXPORT_DRAFT_PROMPT': {
        const item=state.conversations[message.key];
        if(!item)throw new Error('Диалог не найден.');
        const observed=await scan(state,item.platform);
        if(state.traversal[item.platform].pending || !observed.some(row=>row.platform===item.platform && row.id===item.id && row.active))throw new Error('Откройте выбранный диалог и дождитесь полного чтения переписки перед экспортом.');
        const promptExport=buildManualDialogPrompt(state,draftRequest(state,message.key),{now:now()});
        log(state,'draft_prompt_exported','Промпт ответа подготовлен для ручной передачи в Claude. Сообщение не отправлено.',{key:message.key,platform:item.platform});
        await save(state);return {...await publicState(state),promptExport};
      }
      case 'DIALOGS_PRODUCT_SAVE':checkProductVersion(state,message);cancel();saveProduct(state,message.product || {},now());state.settings.autoDraft=false;break;
      case 'DIALOGS_PRODUCT_APPROVE':checkProductVersion(state,message);cancel();approveProduct(state,message.fingerprint ?? productFingerprint(state),now());break;
      case 'DIALOGS_AUTODRAFT':await toggleAuto(state,message.enabled===true);break;
      case 'DIALOGS_LIST_TABS': {
        const tabs=(await api.tabs.query({})).filter(tab=>dialogPlatform(tab.url)).map(tab=>({id:tab.id,title:tab.title || '',url:tab.url,platform:dialogPlatform(tab.url)}));
        return {ok:true,tabs};
      }
      case 'DIALOGS_BIND_TAB': {
        const name=platform(message.platform);
        if(!Number.isInteger(message.tabId))throw new Error('Выберите открытую вкладку.');
        return withTabOwnership(message.tabId,async()=>{
          const tab=await api.tabs.get(message.tabId);
          if(dialogPlatform(tab.url)!==name || (tab.pendingUrl && dialogPlatform(tab.pendingUrl)!==name))throw new Error('Эта вкладка не относится к выбранной площадке.');
          const outreach=(await api.storage.local.get('openlinksState')).openlinksState;
          if(outreach?.queue?.some(job=>!['sent','attempted','attempt_unknown','skipped','failed'].includes(job.status) && [job.tabId,job.supplierTabId].includes(tab.id)))throw new Error('Вкладка занята очередью рассылки. Выберите отдельную вкладку для мониторинга.');
          cancel();bindDialogTab(state,name,tab.id,tab.url,now());await save(state);return publicState(state);
        });
      }
      case 'DIALOGS_UNBIND_TAB': cancel();unbindDialogTab(state,platform(message.platform),now());break;
      case 'DIALOGS_START':
        if(!Object.values(state.bindings).some(binding=>Number.isInteger(binding.tabId)))throw new Error('Сначала привяжите вкладки площадок.');
        if(folder.enabled || !apiAutoAvailable())state.settings.autoDraft=false;
        state.running=true;state.readUnread=message.readUnread===true;log(state,'monitor_started',`${state.readUnread?'Мониторинг запущен с открытием существующих непрочитанных диалогов.':'Мониторинг запущен без переключения диалогов.'} ${folder.enabled&&folder.auto?'Автоматическая обработка через папку включена.':state.settings.autoDraft?'Авточерновики включены по утверждённому заданию.':'Автоматическая подготовка ответов отключена.'} ${folder.enabled&&folder.auto&&folder.autoSend?'Автоматическая отправка разрешена после проверки контекста и общего лимита.':'Ввод и отправка сообщений отключены.'}`);await schedule();break;
      case 'DIALOGS_STOP': cancel();state.running=false;for(const name of PLATFORMS)state.traversal[name].pending=null;log(state,'monitor_stopped','Мониторинг приостановлен.');if(folder.enabled)await schedule();else await clearAlarm();break;
      case 'DIALOGS_SCAN': await scan(state,message.platform);return publicState(state);
      case 'DIALOGS_SETTINGS': {
        const config=await provider(), selected=validateProvider(message.provider ?? config.provider);
        const profile={...config.profiles[selected]};
        if(Object.hasOwn(message,'model'))profile.model=validateModel(message.model,selected);
        if(Object.hasOwn(message,'apiKey')) {
          if(typeof message.apiKey!=='string' || message.apiKey.length>512 || /[\r\n\0]/.test(message.apiKey))throw new Error('Некорректный API-ключ.');
          if(message.apiKey.trim() && message.clearApiKey===true)throw new Error('Для замены ключа снимите отметку удаления.');
          if(message.apiKey.trim())profile.apiKey=message.apiKey.trim();
        }
        if(message.clearApiKey===true)profile.apiKey='';
        const changed=selected!==config.provider || profile.model!==config.model || profile.apiKey!==config.apiKey;
        const next={provider:selected,profiles:{...config.profiles,[selected]:profile},revision:config.revision+Number(changed)};
        if(changed)state.settings.autoDraft=false;
        if(message.settings) {
          const enable=message.settings.autoDraft===true;
          if(enable&&folder.auto)throw new Error('Сначала выключите автоматическую обработку через папку.');
          setDialogSettings(state,{...message.settings,autoDraft:false},now());
          if(enable && apiAutoAvailable() && approved(state) && profile.apiKey && profile.model && await api.permissions?.contains({origins:[providerInfo(selected).origin]}))setDialogSettings(state,{...state.settings,autoDraft:true},now());
        }
        cancel();await api.storage.local.set({[PROVIDER_KEY]:next});break;
      }
      case 'DIALOGS_CONTROL': {
        const patch={};for(const name of ['paused','takeover'])if(Object.hasOwn(message,name))patch[name]=message[name];
        cancel(message.key);setConversationControl(state,message.key,patch,now());break;
      }
      case 'DIALOGS_SAVE_DRAFT': {
        if(Object.hasOwn(message,'productFingerprint')&&message.productFingerprint!==productFingerprint(state))throw new Error('Задание по товару изменилось. Проверьте актуальный ответ перед сохранением.');
        if(message.request) {
          const item=state.conversations[message.key];
          if(!item)throw new Error('Диалог не найден.');
          const observed=await scan(state,item.platform);
          if(state.traversal[item.platform].pending || !observed.some(row=>row.platform===item.platform && row.id===item.id && row.active))throw new Error('Откройте выбранный диалог и обновите историю перед сохранением ответа Claude.');
        }
        const request=message.request || draftRequest(state,message.key);
        if(request.key!==message.key)throw new Error('Ответ относится к другому диалогу.');
        buildDraftPrompt(state,request);
        if(message.revision!==request.revision || message.fingerprint!==request.fingerprint)throw new Error('Диалог изменился. Обновите страницу перед сохранением черновика.');
        if(typeof message.text!=='string' || !message.text.trim() || message.text.length>6000)throw new Error('Укажите текст черновика до 6000 символов.');
        cancel(message.key);acceptDraft(state,request,{text:message.text,reason:'Изменено вручную. Отправка не выполнялась.'},now());
        const config=await provider();state.conversations[message.key].autoDraft={fingerprint:await attemptFingerprint(state,request,config),status:'done',at:now(),attempts:1,retryAt:0,error:''};break;
      }
      case 'DIALOGS_DISCARD_DRAFT':
        if(!state.conversations[message.key])throw new Error('Диалог не найден.');
        cancel(message.key);state.conversations[message.key].draft=null;log(state,'draft_discarded','Черновик удалён.',{key:message.key});break;
      default: throw new Error('Неизвестная команда диалогов.');
    }
    await save(state);return publicState(state);
  }

  async function handle(message,sender) {
    if(!KNOWN_COMMANDS.has(message?.type))return {ok:false,error:'Неизвестная команда диалогов.'};
    if(!isUI(sender))return {ok:false,error:'Команда доступна только в интерфейсе расширения.'};
    if(['DIALOGS_PRODUCT_EXTRACT','DIALOGS_GENERATE_DRAFT'].includes(message.type)&&!apiAutoAvailable())return {ok:false,error:'Используйте подключённый Claude через локальную папку.'};
    if(message.type==='DIALOGS_PRODUCT_EXTRACT')return extractProduct(message);
    if(message.type==='DIALOGS_GENERATE_DRAFT')return generate(message.key);
    if(['DIALOGS_FOLDER_CANCEL','DIALOGS_FOLDER_SETTINGS','DIALOGS_STOP','DIALOGS_SETTINGS','DIALOGS_CONTEXT_EDITING','DIALOGS_PRODUCT_SAVE','DIALOGS_PRODUCT_APPROVE','DIALOGS_IMPORT_PRODUCT_RESULT','DIALOGS_BIND_TAB','DIALOGS_UNBIND_TAB'].includes(message.type) || (message.type==='DIALOGS_AUTODRAFT' && message.enabled!==true))cancel();
    else if(['DIALOGS_CONTROL','DIALOGS_SAVE_DRAFT','DIALOGS_DRAFT_EDITING','DIALOGS_SEND_DRAFT','DIALOGS_DISCARD_DRAFT'].includes(message.type))cancel(message.key);
    const commandEpoch=epoch(message.key);
    try { return await exclusive(()=>command(message,commandEpoch)); }
    catch(error) { return {ok:false,error:error instanceof Error && /^[А-ЯЁ]/.test(error.message)?error.message:'Не удалось выполнить команду диалогов. Проверьте выбранную вкладку и настройки.'}; }
  }
  const onAlarm=async alarm=>{
    if(alarm.name!==ALARM)return;
    const autoKey=await exclusive(async()=>{
      const cycleEpoch=cancelEpoch,state=await load(),folder=await loadFolder();if(!state.running){if(folder.enabled)await pollFolder(state,folder);return null;}
      let config=null;
      if(state.settings.autoDraft) {
        const value=await provider();
        if(approved(state) && value.apiKey && value.model && await api.permissions?.contains({origins:[providerInfo(value.provider).origin]}))config=value;
        else {state.settings.autoDraft=false;log(state,'auto_drafts_paused','Авточерновики остановлены: проверьте утверждение задания и доступ к ИИ.',{level:'warning'});}
      }
      const observed=await scan(state,undefined,{traverse:true,autoConfig:config,folderConfig:folder.enabled?folder:null});
      if(cancelEpoch!==cycleEpoch)return null;
      if(folder.enabled) {
        for(const key of observed.folderKeys) {
          if(cancelEpoch!==cycleEpoch)break;
          try {await enqueueFolder(state,folder,{key,automatic:true,observed});}
          catch {log(state,'folder_failed','Не удалось подготовить задание папки. Проверьте вложения и локальный обработчик.',{key,level:'warning'});}
        }
        if(cancelEpoch===cycleEpoch)await pollFolder(state,folder);
      }
      if(globalThis.indexedDB)await pruneChatAttachmentCache({api,state,now:now()}).catch(()=>{});
      return observed.autoKey || null;
    });
    if(autoKey)await generate(autoKey,{automatic:true});
  };
  const resetBindings=()=>exclusive(async()=>{
    cancel();const state=await load(),folder=await loadFolder();state.running=false;await folderCancelPending(folder);folder.enabled=false;folder.auto=false;folder.autoSend=false;await saveFolder(folder);
    for(const name of PLATFORMS)if(Number.isInteger(state.bindings[name]?.tabId))unbindDialogTab(state,name,now());
    log(state,'bindings_reset','После перезапуска Chrome или обновления расширения привяжите вкладки заново.');
    await clearAlarm();await save(state);
  });
  const onTabRemoved=tabId=>exclusive(async()=>{
    const state=await load();let changed=false;
    for(const name of PLATFORMS)if(state.bindings[name]?.tabId===tabId){cancel();unbindDialogTab(state,name,now());changed=true;}
    if(changed)await save(state);
  });
  const onTabUpdated=(tabId,change,tab)=>exclusive(async()=>{
    if(!change.url)return;
    const state=await load();let changed=false;
    for(const name of PLATFORMS)if(state.bindings[name]?.tabId===tabId && dialogPlatform(change.url || tab?.url)!==name){cancel();unbindDialogTab(state,name,now());changed=true;}
    if(changed)await save(state);
  });
  return {handle,onAlarm,onStartup:resetBindings,onInstalled:details=>details?.reason==='update'?resetBindings():Promise.resolve(),onTabRemoved,onTabUpdated};
}

let installed;
export function installDialogMonitor(api=globalThis.chrome,options={}) {
  if(installed)return installed;
  installed=createDialogMonitor({api,...options});
  // Only extension pages/service workers can read the separately stored API credential.
  api.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'}).catch(()=>{});
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!message?.type?.startsWith('DIALOGS_'))return;
    installed.handle(message,sender).then(reply).catch(()=>reply({ok:false,error:'Ошибка модуля диалогов.'}));return true;
  });
  api.alarms.onAlarm.addListener(alarm=>{installed.onAlarm(alarm).catch(()=>{});});
  api.runtime.onStartup.addListener(()=>{installed.onStartup().catch(()=>{});});
  api.runtime.onInstalled.addListener(details=>{installed.onInstalled(details).catch(()=>{});});
  api.tabs.onRemoved?.addListener(tabId=>{installed.onTabRemoved(tabId).catch(()=>{});});
  api.tabs.onUpdated?.addListener((tabId,change,tab)=>{installed.onTabUpdated(tabId,change,tab).catch(()=>{});});
  return installed;
}
