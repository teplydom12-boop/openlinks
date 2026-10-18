import {
  normalizeDialogs, bindDialogTab, unbindDialogTab, mergeDialogSnapshot,
  setConversationControl, draftRequest, acceptDraft, setDialogSettings, addDialogEvent, buildDraftPrompt, conversationKey,
} from './lib/dialogs.js';
import {AI_ORIGIN, generateDialogDraft, validateModel} from './lib/dialog-ai.js';
import {withTabOwnership} from './lib/tab-ownership.js';

export const DIALOGS_KEY = 'openlinksDialogs';
const PROVIDER_KEY = 'openlinksDialogsProvider';
const ALARM = 'openlinks-dialogs';
const PLATFORMS = ['1688','alibaba','mic'];
const DOMAINS = {'1688':'1688.com',alibaba:'alibaba.com',mic:'made-in-china.com'};
const READ_TIMEOUT_MS=120000,READ_BACKOFF_MS=5*60000;
const KNOWN_COMMANDS = new Set(['GET','LIST_TABS','BIND_TAB','UNBIND_TAB','START','STOP','SCAN','SETTINGS','CONTROL','GENERATE_DRAFT','SAVE_DRAFT','DISCARD_DRAFT'].map(name=>'DIALOGS_'+name));

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

export function createDialogMonitor({api=globalThis.chrome, fetchImpl=globalThis.fetch, now=()=>Date.now()}={}) {
  let serial = Promise.resolve();
  const pending = new Map();
  const exclusive = task => {
    const result = serial.then(task);
    serial = result.catch(()=>{});
    return result;
  };
  const load = async () => normalizeDialogs((await api.storage.local.get(DIALOGS_KEY))[DIALOGS_KEY]);
  const save = state => api.storage.local.set({[DIALOGS_KEY]:state});
  const provider = async () => {
    const raw = (await api.storage.local.get(PROVIDER_KEY))[PROVIDER_KEY] || {};
    return {model:typeof raw.model==='string'?raw.model:'',apiKey:typeof raw.apiKey==='string'?raw.apiKey:'',revision:Number(raw.revision)||0};
  };
  const publicState = async state => { const config=await provider();return {ok:true,state,ai:{model:config.model,keyStored:!!config.apiKey}}; };
  const cancel = key => {
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
    const ready=valid.filter(reply=>reply.status==='ready');
    if(!ready.length) {
      const status=valid.some(reply=>reply.status==='loading')?'loading':valid.length?'unsupported':'error';
      markHealth(state,name,status,status==='loading'?'Чат ещё загружается.':'Чат не распознан. Откройте список сообщений и обновите вкладку после установки расширения.');return [];
    }
    const rows=new Map(),ambiguous=new Set();
    const transcript=row=>JSON.stringify((row.messages || []).map(item=>[item.id || '',item.direction,item.text,item.at ?? null]));
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
    const confirmed=conversations.filter(row=>row.identityReliable===true && row.orderReliable===true && row.tailKnown===true && row.messages?.length).map(row=>({platform:name,id:row.id,documentToken:row.documentToken,frameId:row.frameId}));
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

  async function advanceRead(state,name,observed,allowSelect) {
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
        read.revealed=true;log(state,'read_reveal',`Показываю последние сообщения ранее открытого диалога ${name==='1688'?'1688':'Alibaba'}. Текст не вводится.`,{key:conversationKey(name,read.id),platform:name});await save(state);
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
    const candidates=rows.filter(row=>{
      const key=keyOf(row),item=controls(row);
      if(!key || !item || row.active===true || row.identityReliable!==true || row.canSelect!==true || row.selectionBusy || item.paused || item.takeover || traversal.backoff[key]>now())return false;
      if(typeof row.selectionToken!=='string' || !row.selectionToken || row.selectionToken.length>1024 || typeof row.documentToken!=='string' || !row.documentToken || row.documentToken.length>200)return false;
      const preview=String(row.preview || '').slice(0,1000),changed=preview && preview!==traversal.seenPreviews[key];
      return (row.unread===true && (!preview || changed)) || (row.needsRead===true && changed);
    }).sort((left,right)=>Number(right.unread===true)-Number(left.unread===true));
    const row=candidates[0];if(!row)return;
    const key=keyOf(row);
    // Persist intent before the single inbox-row click. A worker restart must not repeat it.
    traversal.pending={id:row.id,startedAt:now(),documentToken:row.documentToken,frameId:row.frameId,sourceUrl:controls(row)?.sourceUrl || binding.url,preview:String(row.preview || '').slice(0,1000)};
    log(state,'read_requested','Открываю существующий диалог для чтения последних сообщений.',{key,platform:name});await save(state);
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

  async function scan(state, selected, {traverse=false}={}) {
    const confirmed=[];
    for(const name of selected?[platform(selected)]:PLATFORMS) {
      const observed=await scanPlatform(state,name);confirmed.push(...observed);
      await advanceRead(state,name,observed,traverse);
    }
    await save(state);
    return confirmed;
  }

  async function generate(key) {
    let prepared;
    try {
      prepared=await exclusive(async()=>{
        if(pending.has(key))throw new Error('Черновик для этого диалога уже готовится.');
        const state=await load(), conversation=state.conversations[key];
        if(!conversation)throw new Error('Диалог не найден.');
        const config=await provider();
        if(!config.apiKey || !config.model)throw new Error('Укажите API-ключ и модель OpenAI в настройках диалогов.');
        if(!await api.permissions?.contains({origins:[AI_ORIGIN]}))throw new Error('Разрешите доступ к OpenAI кнопкой подготовки черновика.');
        const confirmed=await scan(state,conversation.platform);
        if(state.traversal[conversation.platform].pending)throw new Error('Дождитесь завершения чтения выбранного диалога, затем подготовьте черновик.');
        if(!confirmed.some(row=>row.platform===conversation.platform && row.id===conversation.id))throw new Error('Откройте этот диалог в привязанной вкладке: нужен свежий текст и достоверный порядок сообщений.');
        const source=confirmed.find(row=>row.platform===conversation.platform && row.id===conversation.id);
        const request=draftRequest(state,key), prompt=buildDraftPrompt(state,request), controller=new AbortController();
        const task={id:crypto.randomUUID(),controller,platform:conversation.platform};
        log(state,'draft_requested','Подготовка черновика запрошена пользователем. Сообщение не отправляется.',{key,platform:conversation.platform});
        await save(state);
        pending.set(key,task);
        return {request,prompt,config,task,source,tabId:state.bindings[conversation.platform].tabId,platform:conversation.platform};
      });
      const result=await generateDialogDraft({apiKey:prepared.config.apiKey,model:prepared.config.model,prompt:prepared.prompt,signal:prepared.task.controller.signal,fetchImpl});
      return await exclusive(async()=>{
        if(pending.get(key)!==prepared.task)throw new Error('Подготовка отменена; полученный черновик отброшен.');
        const state=await load(), config=await provider();
        if(config.revision!==prepared.config.revision || state.bindings[prepared.platform]?.tabId!==prepared.tabId)throw new Error('Настройки или привязка изменились; черновик отброшен.');
        // Re-read before accepting: supplier may have replied while the provider was working.
        const confirmed=await scan(state,prepared.platform);
        const conversation=state.conversations[key];
        const source=confirmed.find(row=>row.platform===prepared.platform && row.id===conversation?.id);
        if(!source || source.frameId!==prepared.source.frameId || source.documentToken!==prepared.source.documentToken)throw new Error('Диалог или страница изменились; черновик отброшен.');
        acceptDraft(state,prepared.request,result,now());
        await save(state);
        return publicState(state);
      });
    } catch(error) {
      const detail=error instanceof Error?error.message:'Не удалось подготовить черновик.';
      // Journal contains only fixed diagnostics, never provider errors or transcript text.
      const reason=detail==='Укажите API-ключ и модель OpenAI в настройках диалогов.'?'Не заданы API-ключ или модель OpenAI.':detail==='Разрешите доступ к OpenAI кнопкой подготовки черновика.'?'Доступ к OpenAI не разрешён.':prepared?'Черновик не получен, отменён или устарел. Проверьте состояние диалога перед повторной попыткой.':'Не удалось начать подготовку черновика. Проверьте настройки и откройте актуальный диалог.';
      await exclusive(async()=>{const state=await load();log(state,'draft_failed',reason,{key,platform:prepared?.platform || state.conversations[key]?.platform,level:'warning'});await save(state);}).catch(()=>{});
      return {ok:false,error:detail};
    } finally {
      if(prepared && pending.get(key)===prepared.task)pending.delete(key);
    }
  }

  async function command(message) {
    const state=await load();
    switch(message.type) {
      case 'DIALOGS_GET': return publicState(state);
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
        state.running=true;state.readUnread=message.readUnread===true;log(state,'monitor_started',state.readUnread?'Мониторинг запущен с открытием существующих непрочитанных диалогов. Ввод, отправка и автоматические запросы к ИИ отключены.':'Мониторинг запущен: только чтение открытого чата, без переключения, отправки и автоматических запросов к ИИ.');await schedule();break;
      case 'DIALOGS_STOP': cancel();state.running=false;for(const name of PLATFORMS)state.traversal[name].pending=null;log(state,'monitor_stopped','Мониторинг приостановлен.');await clearAlarm();break;
      case 'DIALOGS_SCAN': await scan(state,message.platform);return publicState(state);
      case 'DIALOGS_SETTINGS': {
        const config=await provider();
        const next={...config,revision:config.revision+1};
        if(Object.hasOwn(message,'model'))next.model=validateModel(message.model);
        if(Object.hasOwn(message,'apiKey')) {
          if(typeof message.apiKey!=='string' || message.apiKey.length>512 || /[\r\n\0]/.test(message.apiKey))throw new Error('Некорректный API-ключ.');
          if(message.apiKey.trim())next.apiKey=message.apiKey.trim();
        }
        if(message.clearApiKey===true)next.apiKey='';
        if(message.settings)setDialogSettings(state,message.settings,now());
        cancel();await api.storage.local.set({[PROVIDER_KEY]:next});break;
      }
      case 'DIALOGS_CONTROL': {
        const patch={};for(const name of ['paused','takeover'])if(Object.hasOwn(message,name))patch[name]=message[name];
        cancel(message.key);setConversationControl(state,message.key,patch,now());break;
      }
      case 'DIALOGS_SAVE_DRAFT': {
        const request=draftRequest(state,message.key);
        if(message.revision!==request.revision || message.fingerprint!==request.fingerprint)throw new Error('Диалог изменился. Обновите страницу перед сохранением черновика.');
        if(typeof message.text!=='string' || !message.text.trim() || message.text.length>6000)throw new Error('Укажите текст черновика до 6000 символов.');
        cancel(message.key);acceptDraft(state,request,{text:message.text,reason:'Изменено вручную. Отправка не выполнялась.'},now());break;
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
    if(message.type==='DIALOGS_GENERATE_DRAFT')return generate(message.key);
    try { return await exclusive(()=>command(message)); }
    catch(error) { return {ok:false,error:error instanceof Error && /^[А-ЯЁ]/.test(error.message)?error.message:'Не удалось выполнить команду диалогов. Проверьте выбранную вкладку и настройки.'}; }
  }
  const onAlarm=alarm=>alarm.name===ALARM?exclusive(async()=>{const state=await load();if(state.running)await scan(state,undefined,{traverse:true});}):Promise.resolve();
  const resetBindings=()=>exclusive(async()=>{
    cancel();const state=await load();state.running=false;
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
export function installDialogMonitor(api=globalThis.chrome) {
  if(installed)return installed;
  installed=createDialogMonitor({api});
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
