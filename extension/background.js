import {migrateState, validateSettings, classify, parseList, dueJob, eligibility, PLATFORMS, FINAL} from './lib/core.js';
import './rules-shared.js';
import './routes-1688-shared.js';
import './supplier-chat.js';
import {activate1688} from './lib/native-input.js';
import {localTimestamp} from './lib/time.js';
const {makeRule,mergeRule}=globalThis.OpenLinksRules;
const routes1688=globalThis.OpenLinks1688;
const supplierChat=globalThis.OpenLinksSupplierChat;

const KEY = 'openlinksState';
const CHAT_LOAD_MS = 30000;
const MAX_ERRORS=3, RETRY_MS=10000, READY_TIMEOUT_MS=60000;
const CLOSE_PREFIX='openlinks-close:';
let serial = Promise.resolve();
const exclusive = task => {
  const result = serial.then(task);
  serial = result.catch(error => console.error('OpenLinks:', error.message));
  return result;
};
async function load() { return migrateState((await chrome.storage.local.get(KEY))[KEY]); }
async function save(state) { await chrome.storage.local.set({[KEY]:state}); }
function event(state, type, job, detail = '', level = 'action') {
  const entry={id:crypto.randomUUID(), at:Date.now(), type, level, jobId:job?.id, url:job?.url || '', detail,jobStatus:job?.status,errorCount:job?.errorCount || 0};
  state.events.push(entry);
  state.activity=entry;
}
async function waitFor(state,job,at,reasons,kind) {
  const detail=`${reasons.join('; ')}. Продолжение не ранее ${localTimestamp(at)}. Обход очереди разрешён только для площадок с исчерпанной квотой.`;
  if(state.waiting?.jobId!==job.id || state.waiting?.until!==at || state.waiting?.kind!==kind) {
    state.waiting={jobId:job.id,until:at,kind,detail};
    event(state,'wait',job,detail,'wait'); await save(state);
  }
  await alarm(at);
}
function deferQuota(state,job,at,reasons) {
  const detail=`${reasons.join('; ')}. Возврат не ранее ${localTimestamp(at)}; проверяю доступность других площадок.`;
  if(job.quotaDeferredUntil!==at)event(state,'quota_deferred',job,detail,'decision');
  job.quotaDeferredUntil=at;job.reason=detail;
}
function halt(state, job, reason, status = 'blocked') {
  state.running = false;
  state.waiting = null;
  if (job) { if(job.status!=='blocked')job.resumeStatus=job.status; job.status = status; job.reason = reason; event(state, status, job, reason, 'error'); }
  else event(state,'pause',null,reason,'error');
}
async function alarm(at = Date.now() + 30000) {
  await chrome.alarms.create('openlinks-tick', {when:Math.max(Date.now()+1000, at)});
}
async function frames(job) {
  const all = await chrome.webNavigation.getAllFrames({tabId:job.tabId});
  return (all || []).filter(frame => {
    try { return classify(frame.url).platform === job.platform; } catch { return false; }
  });
}
async function call(job, frameId, type, extra = {}) {
  return chrome.tabs.sendMessage(job.tabId, {
    type, jobId:job.id, message:job.message, profile:job.profile, ...extra,
  }, {frameId});
}
async function prepareChat(state,job) {
  if(job.platform==='1688') {
    const tab=await chrome.tabs.get(job.tabId);
    if(tab.status==='loading' || tab.pendingUrl)return {ok:false,waiting:true,reason:'Жду полной загрузки вкладки 1688',waitMs:1000};
    const readiness=await call(job,job.frameId,'CHAT_READY');
    if(!readiness?.ok)return {...readiness,ok:false,waiting:true,reason:readiness?.reason || 'Жду готовности редактора 1688'};
  }
  const reply=await call(job,job.frameId,'PREPARE',{reactivate:job.reactivate===true});
  if(reply?.draftReplaced){event(state,'draft_replaced',job,'Старый текст в найденном поле чата полностью очищен и заменён сообщением из настроек. Содержимое старого текста не записывается.');await save(state);}
  if(reply?.ok)delete job.readyWaitAt;
  if(!reply?.waiting)delete job.reactivate;
  if(job.platform!=='1688' || !reply?.needsNativeInput)return reply;
  event(state,'editor_input',job,'1688: кликаю мышью в поле сообщения, нажимаю пробел, затем Backspace. Используются настоящие события Chrome; текст проверю после этой последовательности.');
  await save(state);
  try {
    await activate1688({...job,inputUrl:reply.pageUrl},call);
    await new Promise(resolve=>setTimeout(resolve,350));
    const ready=await call(job,job.frameId,'PREPARE');
    if(ready.needsNativeInput)throw Object.assign(new Error('Редактор не сохранил результат ввода клавиш'),{inputFailure:'editor',inputStage:'done'});
    return ready;
  } catch(error) {
    if(error.inputFailure==='waiting')return {ok:false,waiting:true,reason:error.message,waitMs:1000};
    const stage={locate:'при поиске поля для клика',focus:'после клика в поле',space:'после пробела',done:'после Backspace'}[error.inputStage];
    const hint=['attach','transport'].includes(error.inputFailure)?'Проверьте разрешение debugger и закройте DevTools этой вкладки.':'Проверьте черновик.';
    return {ok:false,nativeInputError:true,reason:`Не удалось активировать редактор 1688${stage?' ('+stage+')':''}: ${error.message}. ${hint} Отправка не выполнялась.`};
  }
}
async function prepareFailed(state,job,reply) {
  if(reply?.waiting) {
    job.readyWaitAt ??= Date.now();
    if(Date.now()-job.readyWaitAt<READY_TIMEOUT_MS) {
      const reason=reply.reason || 'Жду готовности чата';
      if(job.reason!==reason){job.reason=reason;event(state,'chat_loading',job,reason,'wait');}
      await save(state);await alarm(Date.now()+Math.max(1000,reply.waitMs || 1000));return;
    }
    return retryFailure(state,job,'Чат не стал готов за 60 секунд. '+(reply.reason || ''),'loading');
  }
  await retryFailure(state,job,reply?.reason || 'Редактор или кнопка изменились','prepare');
}
async function retryFailure(state,job,reason,stage='chat') {
  if(job.status==='retry_wait' && job.retryAt>Date.now())return;
  await stopLearning(state,job);
  job.errorCount=(job.errorCount || 0)+1;
  job.lastError=reason;job.failures ||= [];
  job.failures.push({at:Date.now(),stage,reason});
  event(state,'job_error',job,`Ошибка ${job.errorCount}/${MAX_ERRORS} (${stage}): ${reason}`,'error');
  delete job.readyWaitAt;
  if(job.errorCount>=MAX_ERRORS) {
    job.autoSkipped=true;
    await finish(state,job,'failed',`Пропущено автоматически после ${job.errorCount} ошибок. ${reason}`);return;
  }
  job.retryStatus=job.status==='visiting' && !job.chatOpened?'visiting':'contacting';
  if(job.approved && job.reviewUrl)job.retryApprovedUrl=job.reviewUrl;
  job.status='retry_wait';job.retryAt=Date.now()+RETRY_MS;job.reactivate=true;job.approved=false;
  job.reason=`Ошибка ${job.errorCount}/${MAX_ERRORS}. Автоматическая проверка через 10 секунд: ${reason}`;
  state.waiting=null;
  event(state,'retry_scheduled',job,job.reason,'wait');await save(state);await alarm(job.retryAt);
}
async function scheduleClose(state,job) {
  if(job.needsTabCheck || !Number.isInteger(job.tabId) || !Number.isInteger(job.frameId) || !job.reviewUrl)return;
  try {
    const tab=await chrome.tabs.get(job.tabId);
    if(classify(tab.url).platform!==job.platform || tab.pendingUrl)return;
    const closing={token:crypto.randomUUID(),jobId:job.id,tabId:job.tabId,frameId:job.frameId,pageUrl:job.reviewUrl,topUrl:tab.url,url:job.url,at:job.finishedAt+10000};
    state.pendingClosures ||= [];
    state.pendingClosures=state.pendingClosures.filter(item=>item.tabId!==job.tabId);
    state.pendingClosures.push(closing);await save(state);
    await chrome.alarms.create(CLOSE_PREFIX+closing.token,{when:closing.at});
    if(job.frameId!==0) {
      const top=await call(job,0,'ARM_CLOSE',{token:closing.token,expectedUrl:closing.topUrl,at:closing.at,guardOnly:true});
      if(!top?.ok)throw new Error('Основная страница изменилась');
    }
    const armed=await call(job,job.frameId,'ARM_CLOSE',{token:closing.token,expectedUrl:closing.pageUrl,at:closing.at});
    if(!armed?.ok)throw new Error('Страница чата изменилась');
    event(state,'chat_close_scheduled',job,'Вкладка чата закроется через 10 секунд. Очередь может продолжать работу.');
  } catch(error) {
    state.pendingClosures=(state.pendingClosures || []).filter(item=>item.jobId!==job.id);
    event(state,'chat_close_cancelled',job,'Не удалось назначить закрытие: '+error.message,'observation');
  }
  await save(state);
}
async function closeChat(token,sender) {
  const state=await load(),closing=state.pendingClosures?.find(item=>item.token===token);
  if(!closing)return {ok:false};
  if(sender && (sender.tab?.id!==closing.tabId || sender.frameId!==closing.frameId || sender.url!==closing.pageUrl))return {ok:false};
  if(Date.now()<closing.at){await chrome.alarms.create(CLOSE_PREFIX+token,{when:closing.at});return {ok:false};}
  const job=state.queue.find(item=>item.id===closing.jobId) || {id:closing.jobId,url:closing.url};
  state.pendingClosures=state.pendingClosures.filter(item=>item.token!==token);
  // Consume before closing: duplicate alarms/messages cannot close a reused tab.
  await save(state);
  try {
    if(state.queue.some(item=>item.tabId===closing.tabId && !FINAL.has(item.status)))throw new Error('Вкладка используется другой задачей');
    const tab=await chrome.tabs.get(closing.tabId);
    if(tab.url!==closing.topUrl || tab.pendingUrl)throw new Error('Адрес вкладки изменился');
    const ready=await chrome.tabs.sendMessage(closing.tabId,{type:'CAN_CLOSE',token},{frameId:closing.frameId});
    if(!ready?.ok)throw new Error('Чат изменился или вы продолжили работу в нём');
    if(closing.frameId!==0) {
      const top=await chrome.tabs.sendMessage(closing.tabId,{type:'CAN_CLOSE',token},{frameId:0});
      if(!top?.ok)throw new Error('Вы продолжили работу на основной странице');
    }
    await chrome.tabs.remove(closing.tabId);
    event(state,'chat_closed',job,'Прошло 10 секунд после отправки; вкладка чата закрыта.');
  } catch(error) {event(state,'chat_close_cancelled',job,'Вкладка оставлена открытой: '+error.message,'observation');}
  await save(state);return {ok:true};
}
async function closeSkippedTabs(state,job) {
  const tabIds=[...new Set([job.tabId,job.supplierTabId].filter(Number.isInteger))];
  state.pendingClosures=(state.pendingClosures || []).filter(item=>item.jobId!==job.id);
  await save(state);
  for(const tabId of tabIds) {
    try {
      if(job.needsTabCheck)throw new Error('После перезапуска вкладка ещё не привязана заново');
      if(state.queue.some(item=>item.id!==job.id && !FINAL.has(item.status) && [item.tabId,item.supplierTabId].includes(tabId)))
        throw new Error('Вкладка используется другой задачей');
      const tab=await chrome.tabs.get(tabId);
      const matches=url=>{
        try {
          if(classify(url).platform!==job.platform)return false;
          const storefront=!routes1688.isMessenger(job.url) && !supplierChat.isMessenger(job.url,job.platform);
          if(storefront && new URL(url).origin===new URL(job.url).origin)return true;
          const known=job.platform==='1688' && routes1688.cached(state.chatRoutes,job.url);
          if(known && routes1688.route(url)===known)return true;
          if(tabId!==job.tabId)return false;
          if([job.url,job.chatTabUrl,job.boundTabUrl,job.frameId===0?job.reviewUrl:null].includes(url))return true;
          // Jobs saved before 0.9.1 already own this tab ID but have no top URL.
          return !job.chatTabUrl && !job.boundTabUrl && supplierChat.isMessenger(url,job.platform);
        } catch {return false;}
      };
      if((tab.url && tab.url!=='about:blank' && !matches(tab.url)) ||
        (tab.pendingUrl && !matches(tab.pendingUrl)) || (!matches(tab.url) && !matches(tab.pendingUrl)))
        throw new Error('Вкладка больше не открыта на странице этого поставщика');
      await chrome.tabs.remove(tabId);
      event(state,'skip_tab_closed',job,`Пропущено пользователем; вкладка ${tabId} закрыта сразу.`);
    } catch(error) {
      event(state,'skip_tab_kept',job,`Пропуск сохранён; вкладка ${tabId} не закрыта: ${error.message}`,'observation');
    }
  }
  await save(state);
}
async function probe(job) {
  const results = await Promise.all((await frames(job)).map(async frame => {
    try { return {...await call(job, frame.frameId, 'PROBE'), frameId:frame.frameId,parentFrameId:frame.parentFrameId ?? 0,pageUrl:frame.url}; }
    catch { return null; }
  }));
  const present=results.filter(Boolean);
  function accessible(result,seen=new Set()) {
    if(!supplierChat.supports(job.platform) || result.frameId===0)return true;
    if(seen.has(result.frameId))return false;
    seen.add(result.frameId);
    const parent=present.find(item=>item.frameId===result.parentFrameId);
    if(!parent?.frames || !accessible(parent,seen))return false;
    let candidates=parent.frames.filter(frame=>frame.url===result.pageUrl);
    if(!candidates.length)candidates=parent.frames.filter(frame=>{
      try {const a=new URL(frame.url),b=new URL(result.pageUrl);return a.origin+a.pathname===b.origin+b.pathname;}catch{return false;}
    });
    return candidates.length===1 && candidates[0].visible;
  }
  return present.filter(result=>accessible(result));
}
async function stopOpening(job) {
  const opening=job?.chatOpening;if(!opening || opening.status==='stopped')return;
  opening.status='stopped';
  await call({...job,tabId:opening.tabId},opening.frameId,'STOP_OPEN_CHAT',{token:opening.token}).catch(()=>{});
}
function watchingSupplierChat(state,job) {
  return supplierChat.supports(job?.platform) && job.status==='blocked' && !job.needsTabCheck &&
    state.learning?.jobId===job.id && state.learning.automatic===true && ['contact','editor','chat'].includes(state.learning.field);
}
async function openSupplierChat(state,job,results) {
  const available=results.filter(result=>result.engine===supplierChat.ENGINE);
  const frame=available.find(result=>result.frameId===0) || (available.length===1?available[0]:null);
  if(!frame) {
    if(Date.now()-job.stepAt>CHAT_LOAD_MS)await retryFailure(state,job,'Механизм чата ещё не загрузился. Обновите вкладку магазина.','loading');
    else await alarm(Date.now()+2000);
    return;
  }
  let opening=job.chatOpening;
  if(opening?.status==='stopped' && opening.attempts>=supplierChat.MAX_ATTEMPTS) {
    await retryFailure(state,job,'Лимит кликов открытия для этой ссылки исчерпан; чат не появился.','contact');return;
  }
  if(opening?.status==='opening' && Date.now()-opening.at>=supplierChat.TIMEOUT_MS) {
    await askForHelp(state,job,'За 20 секунд окно чата не открылось. Покажите кнопку чата на странице.','contact');return;
  }
  if(!opening || opening.status==='stopped') {
    opening=job.chatOpening={token:crypto.randomUUID(),tabId:job.tabId,frameId:frame.frameId,at:Date.now(),attempts:opening?.attempts || 0,lastClick:opening?.lastClick || 0,status:'opening'};
    job.status='contacting';job.stepAt=Date.now();
    event(state,'chat_open',job,'Новый механизм: ищу штатную кнопку каждые 700 мс, до 3 кликов с интервалом 5 секунд, не более 20 секунд. Проверяю видимость окна чата.');
    await save(state);
  }
  if(opening.tabId!==job.tabId || opening.frameId!==frame.frameId){await stopOpening(job);await save(state);await alarm(Date.now()+1000);return;}
  if(frame.opening?.token!==opening.token) {
    const reply=await call(job,opening.frameId,'OPEN_CHAT',{token:opening.token,at:opening.at,attempts:opening.attempts,lastClick:opening.lastClick});
    if(!reply?.ok){await retryFailure(state,job,reply?.reason || 'Не удалось запустить механизм чата. Обновите вкладку.','contact');return;}
  }
  await alarm(opening.at+supplierChat.TIMEOUT_MS+500);
}
async function stopLearning(state,job) {
  await stopOpening(job);
  const learning=state.learning;state.learning=null;
  if(!learning || !job)return;
  await Promise.all(learning.frameIds.map(id=>call({...job,tabId:learning.tabId},id,'PICK_STOP').catch(()=>{})));
}
async function joinLearningFrame(state,job,sender) {
  const learning=state.learning;
  if(!job || !learning || sender.tab?.id!==learning.tabId || learning.frameIds.includes(sender.frameId))return;
  try {if(classify(sender.url).platform!==job.platform)return;}catch{return;}
  learning.frameIds.push(sender.frameId);await save(state);
  await call(job,sender.frameId,'PICK_START',{field:learning.field,token:learning.token}).catch(()=>{});
}
async function armLearning(state,job,field,automatic=false) {
  if(!['contact','editor','send','chat'].includes(field))throw new Error('Неизвестный этап обучения');
  await stopLearning(state,job);
  delete job.retryApprovedUrl;
  if(job.status!=='blocked')job.resumeStatus=job.status;
  job.status='blocked';state.running=false;state.waiting=null;
  const list=await frames(job);
  if(!list.length)throw new Error('Откройте вкладку нужной площадки и привяжите её к задаче');
  state.learning={token:crypto.randomUUID(),jobId:job.id,tabId:job.tabId,field,automatic,frameIds:list.map(f=>f.frameId)};
  job.reason='Нужен ваш обучающий клик: '+({contact:'кнопка открытия чата',editor:'поле сообщения',send:'кнопка отправки',chat:'область диалога'}[field])+'. Откройте вкладку поставщика; первый клик будет обработан расширением.';
  event(state,'learning',job,job.reason,'decision');await save(state);
  await Promise.all(list.map(f=>call(job,f.frameId,'PICK_START',{field,token:state.learning.token}).catch(()=>{})));
}
async function askForHelp(state,job,reason,field='contact') {
  job.helpField=field;
  await retryFailure(state,job,reason,field);
}
async function finish(state, job, status, detail) {
  await stopLearning(state,job);
  job.status = status;
  job.finishedAt = Date.now();
  job.reason = detail;
  event(state, status, job, detail,['failed','attempt_unknown'].includes(status)?'error':'action');
  state.activeId = null;
  state.waiting = null;
  await save(state);
  if(['attempted','sent'].includes(status))await scheduleClose(state,job);
  if (state.running) await alarm(Date.now()+1000);
}
async function interruptedSend(state,job,detail) {
  job.lastError=detail;
  job.errorCount=(job.errorCount || 0)+1;
  job.failures ||= [];job.failures.push({at:Date.now(),stage:'send',reason:detail});
  await finish(state,job,'attempt_unknown',detail+' Результат неизвестен; без повторной отправки перехожу к следующей ссылке. Чат оставлен открытым для ручной проверки.');
}
function contactStep(frame) {return JSON.stringify([frame.frameId,frame.pageUrl,frame.key]);}
function rememberContact(job,frame) {
  job.contactSteps ||= [];
  const step=contactStep(frame);if(!job.contactSteps.includes(step))job.contactSteps.push(step);
}
async function performSend(state, job) {
  const now = Date.now();
  const allowed = eligibility(state, job.platform, 'send', now);
  if (allowed.at > now) {
    if(allowed.quotaUntil>now) {
      deferQuota(state,job,allowed.at,allowed.reasons);job.status='deferred_send';state.activeId=null;state.waiting=null;
      await save(state);await alarm(Date.now()+1000);
    } else await waitFor(state,job,allowed.at,allowed.reasons,'send');
    return;
  }
  state.waiting = null;
  const reply = await prepareChat(state,job);
  if(!reply.ok){await prepareFailed(state,job,reply);return;}
  if (reply.pageUrl !== job.reviewUrl) {
    halt(state, job, reply.reason || 'Страница изменилась. Проверьте получателя и форму заново.');
    await save(state); return;
  }
  // Persist BEFORE the side effect. Never retry a send after a disconnect/restart.
  job.status = 'sending';
  job.attemptId = crypto.randomUUID();
  job.sendAt = Date.now();
  state.slots.push({platform:job.platform, kind:'send', at:job.sendAt, jobId:job.id});
  event(state, 'send_attempt', job, 'Редактор чата и текст проверены повторно. Лимит отправки зарезервирован; нажимаю кнопку ровно один раз. Формы Inquiry не используются.');
  await save(state);
  let result;
  try {result=await call(job, job.frameId, 'SEND', {expectedUrl:job.reviewUrl,attemptId:job.attemptId});}
  catch {
    event(state,'send_disconnect',job,'Ответ вкладки потерян после начала попытки. Нажатие могло сработать; повтор и ожидание результата отключены.','observation');
    await interruptedSend(state,job,'Попытка зарегистрирована без ответа вкладки.');
    return;
  }
  if(result?.clicked!==true && result?.clicked!==false){await interruptedSend(state,job,'Вкладка не сообщила, было ли выполнено нажатие.');return;}
  if(!result.clicked){await askForHelp(state,job,result.reason || 'Отправка остановлена до нажатия','send');return;}
  event(state,'clicked',job,'Кнопка чата нажата. Доставка и прочтение не проверяются.');
  if(job.platform==='1688' && result.accepted!==true) {
    await interruptedSend(state,job,result.reason || 'Редактор 1688 не очистился после нажатия.');return;
  }
  if(job.platform==='1688')event(state,'composer_accepted',job,'Редактор 1688 очистился после нажатия. Это локальная реакция чата; сервер, доставка и прочтение не проверяются.','observation');
  await finish(state,job,'attempted',job.platform==='1688'?'Редактор очистился после нажатия; перехожу к следующей ссылке.':'Нажатие выполнено; перехожу к следующей ссылке без ожидания результата.');
}
async function tick() {
  const state = await load();
  let job = state.queue.find(j => j.id === state.activeId);
  if(supplierChat.supports(job?.platform) && watchingSupplierChat(state,job)) {
    const results=await probe(job).catch(()=>[]);
    if(!results.some(result=>result.obstacle)) {
      const ready=results.filter(result=>result.kind==='chat').length===1;
      if(ready || (state.learning.field==='contact' && results.some(result=>result.opened))) {
        job.chatOpened=true;await resumeChatDiscovery(state,job,'Чат загрузился. Завершаю автоматический запрос обучения и проверяю редактор.');
      }
    }
    if(!state.running){await alarm();return;}
  }
  // A delayed popup/frame can finish loading while automatic teaching has paused
  // the queue. Keep observing only that unresolved pre-send stage, never a user pause.
  if(job?.platform==='1688' && !job.needsTabCheck &&
    ((state.running && ['visiting','contacting'].includes(job.status)) || watchingChat(state,job))) {
    await reconcile1688Chat(state,job);
    if(!state.running && watchingChat(state,job)) {
      if(job.chatOpened && state.learning.field!=='contact') {
        const results=await probe(job).catch(()=>[]);
        if(!results.some(result=>result.obstacle) && results.filter(result=>result.kind==='chat').length===1)
          await resumeChatDiscovery(state,job,'Редактор открытого чата загрузился; обучающий клик больше не нужен.');
      }
      if(!state.running){await alarm();return;}
    }
  }
  if (!state.running) return;
  await alarm(); // Recovery alarm also survives worker suspension and browser restart.
  if(job?.status==='retry_wait') {
    if(Date.now()<job.retryAt){await alarm(job.retryAt);return;}
    job.status=job.retryStatus || 'contacting';job.stepAt=Date.now();delete job.retryAt;
    event(state,'retry_started',job,`Автоматическая проверка ${job.errorCount+1}/${MAX_ERRORS}. Проверяю ту же вкладку; новое посещение не создаётся.`);
    await save(state);
    if(job.platform==='1688')await reconcile1688Chat(state,job);
  }
  if (!job) {
    const due = dueJob(state, Date.now());
    if (!due) { state.running = false; event(state, 'complete', null, 'Очередь завершена'); await save(state); return; }
    if (due.at > Date.now()) { await waitFor(state,due.job,due.at,due.reasons,'visit'); return; }
    job = due.job;
    for(const deferred of due.deferred || [])deferQuota(state,deferred.job,deferred.at,deferred.reasons);
    if(job.quotaDeferredUntil) {
      event(state,'quota_resume',job,'Лимит снова позволяет обработку. Возвращаюсь к первой отложенной строке этой площадки.','decision');
      delete job.quotaDeferredUntil;job.reason='';
    }
    if(job.status==='deferred_send') {
      state.activeId=job.id;state.waiting=null;
      if(job.needsTabCheck) {
        halt(state,job,'Chrome или расширение перезапущены. Выберите и привяжите вкладку нужного чата перед продолжением.');
        await save(state);return;
      }
      job.status='review';
      job.profile.rules=state.rules.filter(rule=>rule.platform===job.platform);
      event(state,'decision',job,'Возвращаюсь к подготовленному чату в существующей вкладке. Перед отправкой повторно проверю получателя и текст.','decision');
      await save(state);await alarm(Date.now()+1000);return;
    }
    const previous=state.slots.filter(slot=>slot.kind==='visit').at(-1);
    const transition=previous ? (previous.platform===job.platform ? 'Та же площадка; настроенный интервал выдержан.' : `Смена ${PLATFORMS[previous.platform].label} → ${PLATFORMS[job.platform].label}: дополнительная пауза не нужна.`) : 'Первое посещение.';
    state.waiting = null;
    event(state,'decision',job,`Выбрана ссылка №${state.queue.indexOf(job)+1}${due.deferred?.length?' после временного пропуска площадок с исчерпанной квотой':' по порядку списка'}. ${transition} Лимиты посещений и отправок за 20 минут проверены.`,'decision');
    job.status = 'visiting'; job.visitAt = Date.now(); job.stepAt = Date.now();
    job.message = state.settings.message.trim(); job.profile = {...structuredClone(state.settings.profiles[job.platform]),rules:state.rules.filter(rule=>rule.platform===job.platform)};
    state.slots.push({platform:job.platform, kind:'visit', at:job.visitAt, jobId:job.id});
    state.activeId = job.id;
    event(state, 'visit', job, 'Открытие страницы; зарезервирован лимит посещения');
    await save(state);
    try {
      let cached=job.platform==='1688'?routes1688.cached(state.chatRoutes,job.url):null;
      if(!cached && routes1688.storeKey(job.url)) {
        event(state,'chat_lookup',job,'Связь с получателем ещё не известна. Однократно читаю публичные данные витрины фоновым запросом в рамках зарезервированного обращения.');
        await save(state);
        const result=await routes1688.lookup(job.url);
        if(result.url){cached=result.url;rememberChat(state,job,cached,result.source);await save(state);}
        else event(state,'chat_lookup_fallback',job,result.reason+'. Открываю витрину и использую 客服; адрес открывшегося чата будет сохранён.','observation');
      }
      if(cached)event(state,'direct_chat',job,'Открываю чат по сохранённому идентификатору этого магазина. Витрину во вкладке не открываю.');
      const tab = await chrome.tabs.create({url:cached || job.url, active:true});
      job.tabId = tab.id;job.supplierTabId=tab.id;
      if(cached){job.status='contacting';job.chatOpened=true;job.stepAt=Date.now();}
      event(state,'page_opened',job,`Вкладка ${tab.id} создана. Жду загрузки и ищу веб-чат продавца.`);
      await save(state);
    } catch (error) { await retryFailure(state,job,'Не удалось открыть вкладку: '+error.message,'open'); }
    return;
  }
  if(job.status==='sending') {await interruptedSend(state,job,'Возобновление после прерывания попытки.');return;}
  if (['blocked','uncertain'].includes(job.status)) { state.running=false; await save(state); return; }
  let results;
  try { results = await probe(job); }
  catch { await retryFailure(state,job,'Вкладка закрыта или недоступна. Отправка не выполнялась.','tab');return; }
  const obstacle = results.find(result => result.obstacle);
  const signature=JSON.stringify(results.map(result=>({frameId:result.frameId,kind:result.kind,diagnostics:result.diagnostics,obstacle:result.obstacle,reason:result.reason})));
  if(job.probeSignature!==signature) {
    job.probeSignature=signature;
    const findings=results.map(result=>{
      const d=result.diagnostics;
      return `Фрейм ${result.frameId}: ${result.kind}${d ? `; адаптер ${d.adapter || 'общий'}, полей ${d.editors}, кнопок отправки ${d.sends}, областей чата ${d.chatRoots}, кнопок чата ${d.contacts}, встроенных чатов ${d.chatFrames || 0}, исключено запросов ${d.inquiriesIgnored}${d.learning?`; обучение: сохранено ${d.learning.saved}, область совпала ${d.learning.scoped}, применено ${d.learning.applied.join(', ') || 'нет'}${d.learning.derivedRoot?'; контейнер найден по изученным полю и кнопке':''}${d.learning.rejected.length?'; не подошли: '+d.learning.rejected.join(', '):''}`:''}` : ''}${result.reason ? '; '+result.reason : ''}`;
    }).join(' | ') || 'Страница ещё не отвечает: жду загрузки контентного скрипта.';
    event(state,'dom_scan',job,findings,'observation'); await save(state);
  }
  if (obstacle) {
    const key=obstacle.frameId+':'+(obstacle.dismissKey || 'current');
    if(job.platform==='1688' && obstacle.canDismiss && (job.challengeAttempt?.key!==key || job.challengeAttempt.count<2)) {
      job.challengeAttempt={key,count:job.challengeAttempt?.key===key?job.challengeAttempt.count+1:1};
      event(state,'challenge_close',job,'Нажимаю штатный крестик известного окна 1688. Каждое повторное появление закрывается отдельно; затем повторно проверяю страницу.');
      await save(state);
      const reply=await call(job,obstacle.frameId,'DISMISS_CHALLENGE',{dismissKey:obstacle.dismissKey});
      if(reply.closed)delete job.challengeAttempt;
      await save(state);await alarm(Date.now()+1000);return;
    }
    await retryFailure(state,job,obstacle.obstacle,'obstacle');return;
  }
  delete job.challengeAttempt;
  if(supplierChat.supports(job.platform) && results.some(result=>result.opened || result.kind==='chat')) {
    await stopOpening(job);
    if(!job.chatOpened) {
      job.chatOpened=true;job.stepAt=Date.now();
      event(state,'chat_discovered',job,'Новый механизм распознал открытое окно чата. Кнопки открытия больше не нажимаются; проверяю редактор.','observation');
      await save(state);
    }
  }
  if(job.platform==='1688') {
    let learned=false;
    const store=routes1688.storeKey(job.url);
    const storefront=results.find(result=>routes1688.storeKey(result.pageUrl)===store && result.chatRoute && routes1688.route(result.chatRoute));
    if(storefront && store) {
      const target=routes1688.route(storefront.chatRoute);learned=rememberChat(state,job,target,'pageData текущей витрины');
      if(job.status==='visiting') {
        job.status='contacting';job.chatOpened=true;job.stepAt=Date.now();event(state,'direct_chat',job,'В данных текущей витрины найден адрес получателя. Открываю веб-чат напрямую без поиска кнопки 客服.');
        await save(state);await chrome.tabs.update(job.tabId,{url:target});return;
      }
    }
    const observed=[...new Set(results.map(result=>routes1688.route(result.pageUrl)).filter(Boolean))];
    if(store && observed.length===1)learned=rememberChat(state,job,observed[0],'адрес фрейма открытого чата') || learned;
    if(learned)await save(state);
  }
  if (job.status === 'review') {
    if (job.approved) await performSend(state, job);
    return;
  }
  const forms = results.filter(result => result.kind === 'chat');
  if (forms.length > 1) { await askForHelp(state,job,'Несколько редакторов в разных фреймах. Укажите нужное поле.','editor'); return; }
  if (forms.length === 1) {
    job.frameId = forms[0].frameId;
    const reply = await prepareChat(state,job);
    if (!reply.ok) { await prepareFailed(state,job,reply); return; }
    event(state,'chat_ready',job,`Найдена одна пара «редактор + отправка» внутри области чата, фрейм ${job.frameId}. Форма запроса исключена.`,'decision');
    job.status = 'review'; job.reviewUrl = reply.pageUrl; job.approved = job.manualSend || !state.settings.review || job.retryApprovedUrl===reply.pageUrl;job.manualSend=false;delete job.retryApprovedUrl;
    job.reason = !job.approved ? 'Проверьте получателя и текст, затем подтвердите отправку.' : '';
    event(state, 'draft_ready', job, !job.approved ? 'Текст вставлен в чат. Жду проверки получателя и подтверждения пользователя.' : 'Текст готов. Повторно проверю чат и лимит перед отправкой.');
    if(reply.inputMethod)event(state,'editor_input',job,'Способ ввода: '+reply.inputMethod+'. Текст в редакторе проверен.','observation');
    await save(state);
    if (job.approved) await performSend(state, job);
    return;
  }
  const ambiguous = results.find(result => result.kind === 'ambiguous');
  if(supplierChat.supports(job.platform)) {
    if(job.chatOpened) {
      if(ambiguous){await askForHelp(state,job,ambiguous.reason,'editor');return;}
      if(Date.now()-job.stepAt>CHAT_LOAD_MS) {
        const d=results.find(result=>result.diagnostics?.editors)?.diagnostics;
        await askForHelp(state,job,'Окно чата открыто. Покажите недостающий элемент внутри диалога.',d?.editors?(d.sends?'chat':'send'):'editor');
      } else await alarm(Date.now()+2000);
    } else await openSupplierChat(state,job,results);
    return;
  }
  if (ambiguous) { await askForHelp(state,job,ambiguous.reason,ambiguous.diagnostics?.editors || job.chatOpened?'editor':'contact'); return; }
  if (job.status==='visiting' && !job.chatOpened) {
    // Prefer the main frame. Never arbitrarily choose between different contacts.
    const contactFrames = results.filter(result => result.kind === 'contact');
    const contact = contactFrames.find(result => result.frameId === 0) || (contactFrames.length === 1 ? contactFrames[0] : null);
    if (contact && !job.contactSteps?.includes(contactStep(contact)) && (job.contactSteps?.length || 0)<8) {
      rememberContact(job,contact);
      event(state,'chat_open',job,`Выбрана единственная кнопка чата во фрейме ${contact.frameId}. ${contact.href ? 'Открываю её HTTPS-ссылку в текущей вкладке.' : 'Нажимаю кнопку открытия диалога.'}`,'decision');
      job.status = 'contacting'; job.stepAt = Date.now();
      await save(state);
      if (contact.href) {
        try {
          if (classify(contact.href).platform !== job.platform) throw new Error('Другая площадка');
          rememberChat(state,job,contact.href,'ссылка штатной кнопки чата');await save(state);
          await chrome.tabs.update(job.tabId, {url:contact.href});
        } catch { await retryFailure(state,job,'Не удалось открыть ссылку чата поддерживаемой площадки.','contact'); }
      } else {
        const reply = await call(job, contact.frameId, 'CONTACT');
        if (!reply.ok)await retryFailure(state,job,reply.reason || 'Кнопка открытия чата недоступна','contact');
      }
      return;
    }
  }
  const inquiry=results.find(result=>result.kind==='inquiry');
  if(inquiry) { await askForHelp(state,job,inquiry.reason,job.chatOpened?'editor':'contact'); return; }
  if (Date.now() - job.stepAt > (job.chatOpened?CHAT_LOAD_MS:15000)) {
    const d=results.find(result=>result.diagnostics?.editors)?.diagnostics;
    await askForHelp(state,job,job.chatOpened?'Чат открыт, но редактор ещё не распознан. Можно показать поле через обучение.':'Не удалось однозначно найти следующий элемент чата. Можно показать элемент через обучение.',d?.editors?(d.sends?'chat':'send'):job.chatOpened?'editor':'contact');
  } else if(job.chatOpened) {
    await alarm(Date.now()+2000);
  }
}
async function safeTick() {
  try { await tick(); }
  catch (error) {
    const state=await load();
    const job=state.queue.find(j=>j.id===state.activeId);
    if(job?.status==='sending')await interruptedSend(state,job,'Попытка прервана: '+error.message+'.');
    else if(job)await retryFailure(state,job,'Ошибка доступа к вкладке или форме: '+error.message,'access');
    else {halt(state,null,'Ошибка очереди: '+error.message);await save(state);}
  }
}
async function dispatch(message, sender) {
  if(message.type==='CHAT_CLOSE_DUE')return closeChat(message.token,sender);
  if(message.type==='CHAT_OPEN_EVENT') {
    const state=await load(),job=state.queue.find(item=>item.id===state.activeId),opening=job?.chatOpening;
    if(!job || !supplierChat.supports(job.platform) || !state.running || job.status!=='contacting' || job.chatOpened ||
      opening?.status!=='opening' || message.jobId!==job.id || message.token!==opening.token || sender.tab?.id!==opening.tabId || sender.frameId!==opening.frameId || classify(sender.url).platform!==job.platform)return {ok:false};
    if(message.phase==='attempt') {
      const now=Date.now();
      if(message.attempt!==opening.attempts+1 || message.attempt>supplierChat.MAX_ATTEMPTS || now-opening.at>=supplierChat.TIMEOUT_MS ||
        (opening.lastClick && now-opening.lastClick<supplierChat.RETRY_MS))return {ok:false};
      opening.attempts=message.attempt;opening.lastClick=now;
      event(state,'chat_open_attempt',job,`Открытие чата: попытка ${opening.attempts}/3; ${String(message.selector || '').slice(0,500)}${message.hidden?' (скрытая штатная кнопка)':''}. Прокрутка, наведение и штатный клик; отправка сообщения не выполняется.`);
      await save(state);return {ok:true};
    }
    if(message.phase==='opened') {
      job.chatOpened=true;job.stepAt=Date.now();await stopOpening(job);
      event(state,'chat_discovered',job,'Окно чата открылось. Завершаю поиск кнопки и проверяю редактор.','observation');
      await save(state);await safeTick();return {ok:true};
    }
    if(['blocked','timeout','error'].includes(message.phase)) {
      await stopOpening(job);
      if(message.phase==='blocked')await retryFailure(state,job,String(message.reason || 'Нужен вход или проверка сайта').slice(0,700),'obstacle');
      else await askForHelp(state,job,String(message.reason || 'Чат не открылся').slice(0,700),'contact');
      return {ok:true};
    }
    return {ok:false};
  }
  if(message.type==='LEARN_PICK' || message.type==='LEARN_CANCEL') {
    const state=await load(),job=state.queue.find(item=>item.id===state.activeId),learning=state.learning;
    if(!job || !learning || message.token!==learning.token || sender.tab?.id!==learning.tabId || !learning.frameIds.includes(sender.frameId))throw new Error('Обучающий клик устарел или пришёл из другой вкладки');
    if(message.type==='LEARN_CANCEL'){await stopLearning(state,job);event(state,'learning_cancel',job,'Обучение отменено; задача остаётся на паузе.');await save(state);return {ok:true};}
    if(message.field!==learning.field)throw new Error('Этап обучения изменился');
    const rule=makeRule(message,sender.url,job.platform);
    state.rules=mergeRule(state.rules,rule);
    if(message.chatSelector) {
      const root=makeRule({field:'chat',selector:message.chatSelector},sender.url,job.platform);
      state.rules=mergeRule(state.rules,root);
    }
    if(state.rules.length>500)throw new Error('Сохранено 500 вариантов обучения. Удалите ненужные правила в настройках; прежние правила сохранены.');
    job.profile.rules=state.rules.filter(r=>r.platform===job.platform);
    await stopLearning(state,job);event(state,'learned',job,`Сохранён ${rule.field}: ${rule.selector}; область ${rule.scope.host}${rule.scope.path}. Всего вариантов: ${state.rules.length}. Другие шаблоны сохранены; значения полей и переписка не записывались.`,'decision');
    state.running=true;job.stepAt=Date.now();job.reason='';job.status='contacting';
    if(rule.field==='send')job.manualSend=true;
    await save(state);
    if(rule.field==='contact') {
      if(supplierChat.supports(job.platform)){delete job.chatOpening;job.chatOpened=false;await save(state);}
      else {
        const reply=await call(job,sender.frameId,'CONTACT');
        if(!reply.ok)await askForHelp(state,job,reply.reason || 'Кнопка изменилась после выбора','contact');
        else {rememberContact(job,{frameId:sender.frameId,pageUrl:sender.url,key:reply.key || rule.selector});await save(state);}
      }
    }
    await alarm(Date.now()+1000);return {ok:true};
  }
  if (message.type === 'PAGE_READY') {
    const state = await load();
    const job = state.queue.find(j => j.id === state.activeId);
    if(sender.tab?.id && sender.frameId===0 && routes1688.storeKey(sender.url) && routes1688.route(message.chatRoute)) {
      rememberChat(state,{url:sender.url,platform:'1688'},message.chatRoute,'данные открытой витрины');await save(state);
    }
    if(job?.platform==='1688' && sender.tab?.id && routes1688.isMessenger(sender.url)) {
      if(sender.tab.id===job.tabId)await note1688Chat(state,job);
      else if(sender.frameId===0)await adoptChatTab(state,{...sender.tab,url:sender.url});
    }
    if (sender.tab?.id === job?.tabId) {
      if(watchingChat(state,job) || watchingSupplierChat(state,job)) {
        await safeTick();
        const latest=await load();
        await joinLearningFrame(latest,latest.queue.find(item=>item.id===latest.activeId),sender);
      } else if(state.learning)await joinLearningFrame(state,job,sender);
      else await safeTick();
    }
    return {ok:true};
  }
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Команда доступна только из окна расширения');
  const state = await load();
  const job = state.queue.find(j => j.id === state.activeId);
  switch (message.type) {
    case 'GET': return {ok:true, state};
    case 'IMPORT': {
      if (state.queue.length > 5000 || String(message.text).length > 2000000) throw new Error('Список слишком большой; используйте партии до 5000 ссылок');
      const parsed = parseList(String(message.text), state.queue);
      if (state.queue.length + parsed.jobs.length > 5000) throw new Error('В очереди может быть до 5000 ссылок');
      state.queue.push(...parsed.jobs);
      event(state, 'import', null, `Добавлено: ${parsed.jobs.length}; пропущено: ${parsed.errors.length}`);
      await save(state); await alarm(); return {ok:true, added:parsed.jobs.length, errors:parsed.errors};
    }
    case 'SETTINGS':
      if (state.activeId || state.queue.some(item=>item.status==='deferred_send')) throw new Error('Завершите или пропустите подготовленные задачи перед изменением настроек');
      state.settings = validateSettings(message.settings);
      event(state,'settings',null,`Сообщение ${state.settings.message.length} символов; подтверждение ${state.settings.review ? 'включено' : 'выключено'}. Режим: только чат; обход очереди только при исчерпании квоты.`);
      await save(state); return {ok:true};
    case 'START':
      if (!state.settings.message.trim()) throw new Error('Сначала сохраните текст сообщения');
      if (job && ['blocked','uncertain'].includes(job.status)) throw new Error('Сначала разрешите ситуацию с текущим поставщиком');
      state.running=true; event(state,'start',null,'Очередь запущена: только чат; интервал между соседними магазинами одной площадки. При исчерпании квоты перехожу к доступной площадке и затем возвращаюсь; лимиты 7/20 и 3/20 сохраняются.'); await save(state); await alarm(Date.now()+1000); return {ok:true};
    case 'PAUSE':
      await stopLearning(state,job);
      state.running=false; state.waiting=null; event(state,'pause',null,'Пауза пользователя; уже начатое нажатие не отменяется'); await save(state); return {ok:true};
    case 'APPROVE':
      if (!job || job.status !== 'review') throw new Error('Нет сообщения для подтверждения');
      job.approved=true; state.running=true; event(state,'approved',job,'Пользователь подтвердил получателя и текст. Перед отправкой повторно проверю чат и лимит.','decision'); await save(state); await alarm(Date.now()+1000); return {ok:true};
    case 'RECHECK':
      if (!job || job.status !== 'blocked') throw new Error('Нет заблокированной задачи');
      if(job.needsTabCheck)throw new Error('Сначала выберите и привяжите вкладку чата: её старый номер мог измениться после перезапуска');
      await stopLearning(state,job);
      job.reactivate=true;delete job.readyWaitAt;
      if(supplierChat.supports(job.platform)){delete job.chatOpening;job.chatOpened=false;}
      job.status=job.resumeStatus==='visiting'?'visiting':'contacting'; job.stepAt=Date.now(); job.reason=''; state.running=true;
      event(state,'recheck',job,'Повторная проверка существующей вкладки без нового посещения');
      await save(state); await alarm(Date.now()+1000); return {ok:true};
    case 'TEACH':
      if(!job || FINAL.has(job.status) || ['sending','uncertain'].includes(job.status))throw new Error('Сначала проверьте результат начатой отправки');
      await armLearning(state,job,message.field);return {ok:true};
    case 'CANCEL_TEACH':
      await stopLearning(state,job);event(state,'learning_cancel',job,'Обучение отменено; задача остаётся на паузе.');await save(state);return {ok:true};
    case 'FORGET_RULE':
      state.rules=state.rules.filter(rule=>rule.id!==message.id);
      if(job)job.profile.rules=state.rules.filter(rule=>rule.platform===job.platform);
      if(supplierChat.supports(job?.platform))await stopOpening(job);
      event(state,'rule_removed',job,'Выбранное правило удалено.');await save(state);if(state.running)await alarm(Date.now()+1000);return {ok:true};
    case 'FORGET_CHAT_ROUTE': {
      const key=routes1688.storeKey(message.store);if(!key)throw new Error('Некорректный адрес магазина');
      for(const saved of Object.keys(state.chatRoutes))if(routes1688.storeKey(saved)===key)delete state.chatRoutes[saved];
      event(state,'chat_route_removed',{url:key},'Адрес чата забыт. При следующем обращении получатель будет определён заново.');await save(state);return {ok:true};
    }
    case 'LIST_TABS': {
      if(!job)return {ok:true,tabs:[]};
      const tabs=(await chrome.tabs.query({})).filter(tab=>{try{return classify(tab.url).platform===job.platform;}catch{return false;}});
      return {ok:true,tabs:tabs.map(tab=>({id:tab.id,title:tab.title || new URL(tab.url).hostname}))};
    }
    case 'BIND_TAB': {
      if(!job || job.status==='sending' || FINAL.has(job.status))throw new Error('Нет задачи для привязки');
      const tab=await chrome.tabs.get(Number(message.tabId));
      if(classify(tab.url).platform!==job.platform)throw new Error('Вкладка другой площадки');
      if(job.needsTabCheck && job.supplierTabId!==tab.id)delete job.supplierTabId;
      await stopLearning(state,job);job.tabId=tab.id;
      job.boundTabUrl=tab.url;
      if(supplierChat.supports(job.platform)){delete job.chatOpening;job.chatOpened=false;}
      if(job.status!=='uncertain'){job.status='contacting';job.stepAt=Date.now();job.reason='';state.running=true;}
      delete job.needsTabCheck;
      rememberChat(state,job,tab.url);event(state,'chat_tab',job,'Вкладка явно выбрана пользователем. Проверьте получателя.');await save(state);await alarm(Date.now()+1000);return {ok:true};
    }
    case 'MARK_SENT':
      if (!job || job.status !== 'uncertain') throw new Error('Нет неподтверждённой отправки');
      state.running=true;
      await finish(state,job,'sent','Пользователь вручную подтвердил наличие отправленного сообщения'); return {ok:true};
    case 'RETRY_SEND':
      if(!job || job.status!=='uncertain')throw new Error('Нет попытки для ручного повтора');
      if(job.needsTabCheck)throw new Error('Сначала выберите и привяжите вкладку чата после перезапуска');
      job.status='contacting';job.stepAt=Date.now();job.reason='';job.approved=false;job.manualSend=true;state.running=true;
      event(state,'manual_retry',job,'Пользователь указал, что сообщение не отправлено, и запросил новую попытку. Повторно проверю редактор и лимит; прежняя попытка остаётся в счётчике.','decision');
      await save(state);await alarm(Date.now()+1000);return {ok:true};
    case 'SKIP': {
      const target=state.queue.find(j=>j.id===message.id);
      if (!target || FINAL.has(target.status)) throw new Error('Нечего пропускать');
      if (target.status==='sending') throw new Error('Дождитесь проверки уже начатой отправки');
      if (target.id===state.activeId) await finish(state,target,'skipped','Пропущено пользователем');
      else {
        await stopOpening(target);target.status='skipped';target.finishedAt=Date.now();target.reason='Пропущено пользователем';
        if(state.waiting?.jobId===target.id)state.waiting=null;
        event(state,'skipped',target,target.reason);await save(state);
      }
      await closeSkippedTabs(state,target);
      if(state.running)await alarm(Date.now()+1000);
      return {ok:true};
    }
    case 'REMOVE_JOB': {
      const target=state.queue.find(item=>item.id===message.id);
      if(!target)throw new Error('Строка уже удалена');
      if(target.status==='sending')throw new Error('Дождитесь завершения уже начатого нажатия');
      if(target.id===state.activeId) {
        await stopLearning(state,target);state.activeId=null;state.waiting=null;
      }
      if(state.waiting?.jobId===target.id)state.waiting=null;
      state.queue=state.queue.filter(item=>item.id!==target.id);
      event(state,'remove_job',target,'Строка удалена из очереди. Ссылку можно добавить повторно; история, обучение и счётчики лимитов сохранены.');
      await save(state);if(state.running)await alarm(Date.now()+1000);return {ok:true};
    }
    case 'REMOVE_PENDING':
      for(const item of state.queue.filter(j=>j.status==='pending'))event(state,'remove_job',item,'Ожидающая ссылка удалена из очереди');
      state.queue=state.queue.filter(j=>j.status!=='pending');
      event(state,'remove_pending',null,'Удалены только ожидающие задачи; история и лимиты сохранены');
      await save(state); return {ok:true};
    default: throw new Error('Неизвестная команда');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  exclusive(()=>dispatch(message,sender)).then(respond,error=>respond({ok:false,error:error.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(item=>{
  if(item.name==='openlinks-tick')exclusive(safeTick);
  else if(item.name.startsWith(CLOSE_PREFIX))exclusive(()=>closeChat(item.name.slice(CLOSE_PREFIX.length)));
});
function rememberChat(state,job,url,source='вкладка открытого чата') {
  if(job.platform!=='1688')return false;
  const key=routes1688.storeKey(job.url),safe=routes1688.route(url);if(!key || !safe)return false;
  if(state.chatRoutes[key]?.url===safe)return false;
  state.chatRoutes[key]={url:safe,at:Date.now(),source};
  event(state,'chat_route',job,`Сохранена связь ${new URL(key).hostname} → получатель чата; источник: ${source}. Применяется ко всем страницам этого магазина, без данных сессии.`);
  return true;
}
function watchingChat(state,job) {
  return job?.platform==='1688' && job.status==='blocked' && !job.needsTabCheck &&
    state.learning?.jobId===job.id && state.learning.automatic===true && ['contact','editor','chat'].includes(state.learning.field);
}
async function resumeChatDiscovery(state,job,detail) {
  await stopLearning(state,job);
  job.status='contacting';job.stepAt=Date.now();job.reason='';job.approved=false;
  state.running=true;state.waiting=null;
  event(state,'chat_discovered',job,detail,'decision');await save(state);await alarm(Date.now()+1000);
}
async function note1688Chat(state,job) {
  if(job.platform!=='1688' || !['visiting','contacting','blocked'].includes(job.status) || job.needsTabCheck)return;
  const first=!job.chatOpened;
  job.chatOpened=true;
  if(first)job.stepAt=Date.now();
  if(watchingChat(state,job) && state.learning.field==='contact') {
    await resumeChatDiscovery(state,job,'Чат 1688 уже открыт. Снимаю запрос кнопки чата и перехожу к поиску редактора сообщения.');
  } else if(first || (state.running && job.status==='visiting')) {
    if(state.running && job.status==='visiting')job.status='contacting';
    event(state,'chat_discovered',job,'Распознана страница или фрейм чата 1688. Кнопка открытия больше не требуется; жду редактор.','observation');await save(state);
  }
}
async function reconcile1688Chat(state,job) {
  const current=await chrome.tabs.get(job.tabId).catch(()=>null);
  if(current && routes1688.isMessenger(current.pendingUrl || current.url)) {
    await adoptChatTab(state,current);return;
  }
  // Recover missed popup events or a messenger tab reused by the site. An
  // unrelated chat is eligible only when its recipient matches this store's cache.
  const expected=routes1688.cached(state.chatRoutes,job.url);
  const tabs=await chrome.tabs.query({url:'https://air.1688.com/*'}).catch(()=>[]);
  const candidates=tabs.filter(tab=>{
    const url=tab.pendingUrl || tab.url,route=routes1688.route(url);
    if(tab.id===job.tabId || job.ignoredPopupIds?.includes(tab.id) || !routes1688.isMessenger(url))return false;
    if(expected && route && expected!==route)return false;
    const related=(tab.openerTabId!==undefined && [job.tabId,job.supplierTabId].includes(tab.openerTabId)) || job.popupCandidates?.includes(tab.id);
    return related || (expected && route===expected);
  });
  if(candidates.length===1 && await adoptChatTab(state,candidates[0],true))return;
  const list=await frames(job).catch(()=>[]);
  if(list.some(frame=>routes1688.isMessenger(frame.url)))await note1688Chat(state,job);
}
async function adoptChatTab(state,tab,allowKnownRecipient=false) {
  const job=state.queue.find(j=>j.id===state.activeId);
  if(!job || !['contacting','visiting','blocked','review','retry_wait'].includes(job.status))return;
  if(tab.id===job.tabId) {
    const before=state.chatRoutes[routes1688.storeKey(job.url)]?.url;
    rememberChat(state,job,tab.pendingUrl || tab.url,'переход текущей вкладки в чат');
    if(before!==state.chatRoutes[routes1688.storeKey(job.url)]?.url)await save(state);
    if(routes1688.isMessenger(tab.pendingUrl || tab.url))await note1688Chat(state,job);
    if(supplierChat.supports(job.platform) && supplierChat.isMessenger(tab.pendingUrl || tab.url,job.platform) && (state.running || watchingSupplierChat(state,job))) {
      job.chatTabUrl=tab.pendingUrl || tab.url;
      job.chatOpened=true;
      if(watchingSupplierChat(state,job))await resumeChatDiscovery(state,job,'Открылась страница мессенджера. Перехожу к редактору.');
      await stopOpening(job);await save(state);
    }
    return;
  }
  if(job.status==='review')return;
  if(job.ignoredPopupIds?.includes(tab.id))return;
  const expected=job.platform==='1688'?routes1688.cached(state.chatRoutes,job.url):null;
  const observed=routes1688.route(tab.pendingUrl || tab.url);
  const related=(tab.openerTabId!==undefined && [job.tabId,job.supplierTabId].includes(tab.openerTabId)) || job.popupCandidates?.includes(tab.id) || (allowKnownRecipient && expected && observed===expected);
  if(!related)return;
  job.popupCandidates=[...new Set([...(job.popupCandidates || []),tab.id])];
  try {
    if(classify(tab.pendingUrl || tab.url).platform!==job.platform) {await save(state);return;}
    if(job.platform==='1688' && !routes1688.isMessenger(tab.pendingUrl || tab.url)) {
      job.popupCandidates=job.popupCandidates.filter(id=>id!==tab.id);
      job.ignoredPopupIds=[...(job.ignoredPopupIds || []),tab.id];await save(state);return;
    }
    if(supplierChat.supports(job.platform) && (!supplierChat.isMessenger(tab.pendingUrl || tab.url,job.platform) || job.needsTabCheck || (!state.running && !watchingSupplierChat(state,job)))) {await save(state);return;}
    if(job.platform==='1688') {
      if((expected && observed && expected!==observed) || job.needsTabCheck || (!state.running && !watchingChat(state,job))) {await save(state);return;}
      // Editor/chat lessons belong to the old document. Resume discovery in
      // this related new tab; the next probe will teach only if still necessary.
      if(watchingChat(state,job))await resumeChatDiscovery(state,job,'Открылась вкладка чата 1688. Завершаю устаревший запрос обучения и проверяю редактор в новой вкладке.');
    } else {
      if(watchingSupplierChat(state,job))await resumeChatDiscovery(state,job,'Открылась вкладка мессенджера. Перехожу к редактору.');
      else await stopLearning(state,job);
      job.chatOpened=true;if(job.status!=='retry_wait')job.status='contacting';
    }
    job.tabId=tab.id;job.chatTabUrl=tab.pendingUrl || tab.url; job.stepAt=Date.now(); event(state,'chat_tab',job,'Открыта вкладка чата площадки');
    if(job.status==='blocked')job.resumeStatus='contacting';
    rememberChat(state,job,tab.pendingUrl || tab.url);
    if(job.platform==='1688')await note1688Chat(state,job);
    await save(state); await alarm(Date.now()+2000);return true;
  } catch { await save(state); /* about:blank is checked again when its real URL arrives. */ }
}
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(change.status==='complete' || change.url) exclusive(async()=>{
    const state=await load();
    if(tab) await adoptChatTab(state,tab);
    if(change.status==='complete' && state.queue.find(j=>j.id===state.activeId)?.tabId===tabId) await safeTick();
  });
});
// A site's Contact button may open its messenger in a new tab.
chrome.tabs.onCreated.addListener(tab=>{
  if(!tab.openerTabId) return;
  exclusive(async()=>{
    await adoptChatTab(await load(),tab);
  });
});
// Some popups omit tabs.openerTabId. Chrome's navigation event still identifies
// the source tab; do not infer a supplier from an arbitrary open 1688 chat.
chrome.webNavigation.onCreatedNavigationTarget.addListener(details=>exclusive(async()=>{
  await adoptChatTab(await load(),{id:details.tabId,openerTabId:details.sourceTabId,url:details.url});
}));
chrome.runtime.onStartup.addListener(()=>exclusive(async()=>{
  const state=await load();
  // Tab IDs may be reused after a browser restart. Old closure timers lose authority.
  if(state.pendingClosures?.length){state.pendingClosures=[];await save(state);}
  const deferred=state.queue.filter(job=>job.status==='deferred_send');
  for(const job of deferred){job.approved=false;job.needsTabCheck=true;}
  // Existing tab IDs and account state cannot be assumed to survive a browser restart.
  if(state.running || state.activeId || deferred.length) {
    const job=state.queue.find(j=>j.id===state.activeId);
    state.learning=null;
    if(job){job.needsTabCheck=true;delete job.retryApprovedUrl;}
    if(job?.status==='sending'){state.running=false;await interruptedSend(state,job,'Chrome перезапущен во время попытки.');return;}
    halt(state,job,'Chrome перезапущен. Проверьте вкладку перед продолжением.',job?.status==='uncertain'?'uncertain':'blocked');
    await save(state);
  }
}));
chrome.runtime.onInstalled.addListener((details={})=>exclusive(async()=>{
  const state=await load();
  state.pendingClosures=[];
  if(details.reason==='update') {
    state.settings.review=true;
    for(const deferred of state.queue.filter(item=>item.status==='deferred_send')){deferred.approved=false;deferred.needsTabCheck=true;}
    const job=state.queue.find(item=>item.id===state.activeId);
    await stopLearning(state,job);
    if(job?.status==='sending'){state.running=false;await interruptedSend(state,job,'Расширение обновлено во время попытки.');return;}
    if(state.running || job) halt(state,job,'Расширение обновлено. Обновите вкладку магазина/чата перед продолжением.',job?.status==='uncertain'?'uncertain':'blocked');
    if(job){job.approved=false;delete job.retryApprovedUrl;}
  }
  await save(state); await alarm();
}));
chrome.action.onClicked.addListener(async()=>{
  const url=chrome.runtime.getURL('dashboard.html');
  const tabs=await chrome.tabs.query({url});
  if(tabs[0]) { await chrome.tabs.update(tabs[0].id,{active:true}); await chrome.windows.update(tabs[0].windowId,{focused:true}); }
  else await chrome.windows.create({url,type:'popup',width:1240,height:900});
});
