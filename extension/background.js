import {migrateState, validateSettings, classify, parseList, dueJob, eligibility, PLATFORMS, FINAL} from './lib/core.js';
import './rules-shared.js';
import './routes-1688-shared.js';
const {makeRule,mergeRule}=globalThis.OpenLinksRules;
const routes1688=globalThis.OpenLinks1688;

const KEY = 'openlinksState';
const CHAT_LOAD_MS = 30000;
let serial = Promise.resolve();
const exclusive = task => {
  const result = serial.then(task);
  serial = result.catch(error => console.error('OpenLinks:', error.message));
  return result;
};
async function load() { return migrateState((await chrome.storage.local.get(KEY))[KEY]); }
async function save(state) { await chrome.storage.local.set({[KEY]:state}); }
function event(state, type, job, detail = '', level = 'action') {
  const entry={id:crypto.randomUUID(), at:Date.now(), type, level, jobId:job?.id, url:job?.url || '', detail};
  state.events.push(entry);
  state.activity=entry;
}
async function waitFor(state,job,at,reasons,kind) {
  const detail=`${reasons.join('; ')}. Продолжение не ранее ${new Date(at).toISOString()}. Обход очереди разрешён только для площадок с исчерпанной квотой.`;
  if(state.waiting?.jobId!==job.id || state.waiting?.until!==at || state.waiting?.kind!==kind) {
    state.waiting={jobId:job.id,until:at,kind,detail};
    event(state,'wait',job,detail,'wait'); await save(state);
  }
  await alarm(at);
}
function deferQuota(state,job,at,reasons) {
  const detail=`${reasons.join('; ')}. Возврат не ранее ${new Date(at).toISOString()}; проверяю доступность других площадок.`;
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
async function probe(job) {
  const results = await Promise.all((await frames(job)).map(async frame => {
    try { return {...await call(job, frame.frameId, 'PROBE'), frameId:frame.frameId,pageUrl:frame.url}; }
    catch { return null; }
  }));
  return results.filter(Boolean);
}
async function stopLearning(state,job) {
  const learning=state.learning;state.learning=null;
  if(!learning || !job)return;
  await Promise.all(learning.frameIds.map(id=>call({...job,tabId:learning.tabId},id,'PICK_STOP').catch(()=>{})));
}
async function armLearning(state,job,field,automatic=false) {
  if(!['contact','editor','send','chat'].includes(field))throw new Error('Неизвестный этап обучения');
  await stopLearning(state,job);
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
  halt(state,job,reason);await save(state);
  try{await armLearning(state,job,field,true);}catch(error){job.reason+=' '+error.message;await save(state);}
}
async function finish(state, job, status, detail) {
  await stopLearning(state,job);
  job.status = status;
  job.finishedAt = Date.now();
  job.reason = detail;
  event(state, status, job, detail);
  state.activeId = null;
  state.waiting = null;
  await save(state);
  // Do not close the conversation. It can contain a reply or a manually completed form.
  if (state.running) await alarm(Date.now()+1000);
}
async function interruptedSend(state,job,detail) {
  if(job.platform==='1688') {
    halt(state,job,detail+' Проверьте переписку вручную. Очередь остановлена; автоматического повтора нет.','uncertain');
    await save(state);
  } else await finish(state,job,'attempt_unknown',detail+' Результат неизвестен; автоматически не повторяю.');
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
  const reply = await call(job, job.frameId, 'PREPARE');
  if(!reply.ok){await askForHelp(state,job,reply.reason || 'Редактор или кнопка изменились','send');return;}
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
    halt(state,job,result.reason || 'Не подтверждено очищение редактора 1688 после нажатия. Проверьте переписку вручную; автоматического повтора нет.','uncertain');
    await save(state);return;
  }
  if(job.platform==='1688')event(state,'composer_accepted',job,'Редактор 1688 очистился после нажатия. Это локальная реакция чата; сервер, доставка и прочтение не проверяются.','observation');
  await finish(state,job,'attempted',job.platform==='1688'?'Редактор очистился после нажатия; перехожу к следующей ссылке.':'Нажатие выполнено; перехожу к следующей ссылке без ожидания результата.');
}
async function tick() {
  const state = await load();
  let job = state.queue.find(j => j.id === state.activeId);
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
    } catch (error) { halt(state, job, 'Не удалось открыть вкладку: '+error.message); await save(state); }
    return;
  }
  if(job.status==='sending') {await interruptedSend(state,job,'Возобновление после прерывания попытки.');return;}
  if (['blocked','uncertain'].includes(job.status)) { state.running=false; await save(state); return; }
  let results;
  try { results = await probe(job); }
  catch { halt(state, job, 'Вкладка закрыта или недоступна. Проверьте результат вручную; повторная отправка не выполнялась.', job.status==='sending'?'uncertain':'blocked'); await save(state); return; }
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
    halt(state, job, obstacle.obstacle, job.status === 'sending' ? 'uncertain' : 'blocked');
    await save(state); return;
  }
  delete job.challengeAttempt;
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
    const reply = await call(job, job.frameId, 'PREPARE');
    if (!reply.ok) { await askForHelp(state,job,reply.reason,'send'); return; }
    event(state,'chat_ready',job,`Найдена одна пара «редактор + отправка» внутри области чата, фрейм ${job.frameId}. Форма запроса исключена.`,'decision');
    job.status = 'review'; job.reviewUrl = reply.pageUrl; job.approved = job.manualSend || !state.settings.review;job.manualSend=false;
    job.reason = state.settings.review ? 'Проверьте получателя и текст, затем подтвердите отправку.' : '';
    event(state, 'draft_ready', job, state.settings.review ? 'Текст вставлен в чат. Жду проверки получателя и подтверждения пользователя.' : 'Текст вставлен в чат. Автоматический режим: повторно проверю чат и лимит перед отправкой.');
    if(reply.inputMethod)event(state,'editor_input',job,'Способ ввода: '+reply.inputMethod+'. Текст в редакторе проверен.','observation');
    await save(state);
    if (job.approved) await performSend(state, job);
    return;
  }
  const ambiguous = results.find(result => result.kind === 'ambiguous');
  if (ambiguous) { await askForHelp(state,job,ambiguous.reason,ambiguous.diagnostics?.editors || job.chatOpened?'editor':'contact'); return; }
  // Alibaba/MIC may expose another learned control after opening their widget.
  // 1688 has its separate storefront -> messenger routing flow.
  if ((job.status==='visiting' && !job.chatOpened) || (job.status==='contacting' && job.platform!=='1688')) {
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
        } catch { halt(state, job, 'Ссылка ведёт вне поддерживаемой площадки. Откройте чат вручную.'); await save(state); }
      } else {
        const reply = await call(job, contact.frameId, 'CONTACT');
        if (!reply.ok) { halt(state, job, reply.reason); await save(state); }
      }
      return;
    }
  }
  const inquiry=results.find(result=>result.kind==='inquiry');
  if(inquiry) { await askForHelp(state,job,inquiry.reason,job.chatOpened?'editor':'contact'); return; }
  if (Date.now() - job.stepAt > (job.chatOpened?CHAT_LOAD_MS:15000)) {
    const d=results.find(result=>result.diagnostics?.editors)?.diagnostics;
    await askForHelp(state,job,job.chatOpened?'Чат уже открыт, но редактор ещё не распознан. Жду его загрузки или вашего указания поля сообщения.':'Не удалось однозначно найти следующий элемент чата. Жду вашего обучающего действия.',d?.editors?(d.sends?'chat':'send'):job.chatOpened?'editor':'contact');
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
    else {halt(state,job,'Ошибка доступа к вкладке или форме: '+error.message);await save(state);}
  }
}
async function dispatch(message, sender) {
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
      const reply=await call(job,sender.frameId,'CONTACT');
      if(!reply.ok)await askForHelp(state,job,reply.reason || 'Кнопка изменилась после выбора','contact');
      else {rememberContact(job,{frameId:sender.frameId,pageUrl:sender.url,key:reply.key || rule.selector});await save(state);}
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
      if(watchingChat(state,job)){await safeTick();return {ok:true};}
      if(state.learning && !state.learning.frameIds.includes(sender.frameId)) {
        try {
          if(classify(sender.url).platform===job.platform) {
            state.learning.frameIds.push(sender.frameId);await save(state);
            await call(job,sender.frameId,'PICK_START',{field:state.learning.field,token:state.learning.token});
          }
        } catch { /* Only accessible frames on the selected platform are taught. */ }
      } else await safeTick();
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
      event(state,'rule_removed',job,'Выбранное правило удалено.');await save(state);return {ok:true};
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
      await stopLearning(state,job);job.tabId=tab.id;
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
      else { target.status='skipped'; event(state,'skipped',target,'Пропущено пользователем'); await save(state); }
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
chrome.alarms.onAlarm.addListener(item=>{ if(item.name==='openlinks-tick') exclusive(safeTick); });
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
  if(!job || !['contacting','visiting','blocked','review'].includes(job.status))return;
  if(tab.id===job.tabId) {
    const before=state.chatRoutes[routes1688.storeKey(job.url)]?.url;
    rememberChat(state,job,tab.pendingUrl || tab.url,'переход текущей вкладки в чат');
    if(before!==state.chatRoutes[routes1688.storeKey(job.url)]?.url)await save(state);
    if(routes1688.isMessenger(tab.pendingUrl || tab.url))await note1688Chat(state,job);
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
    if(job.platform==='1688') {
      if((expected && observed && expected!==observed) || job.needsTabCheck || (!state.running && !watchingChat(state,job))) {await save(state);return;}
      // Editor/chat lessons belong to the old document. Resume discovery in
      // this related new tab; the next probe will teach only if still necessary.
      if(watchingChat(state,job))await resumeChatDiscovery(state,job,'Открылась вкладка чата 1688. Завершаю устаревший запрос обучения и проверяю редактор в новой вкладке.');
    } else await stopLearning(state,job);
    job.tabId=tab.id; job.stepAt=Date.now(); event(state,'chat_tab',job,'Открыта вкладка чата площадки');
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
  const deferred=state.queue.filter(job=>job.status==='deferred_send');
  for(const job of deferred){job.approved=false;job.needsTabCheck=true;}
  // Existing tab IDs and account state cannot be assumed to survive a browser restart.
  if(state.running || state.activeId || deferred.length) {
    const job=state.queue.find(j=>j.id===state.activeId);
    state.learning=null;
    if(job)job.needsTabCheck=true;
    if(job?.status==='sending'){state.running=false;await interruptedSend(state,job,'Chrome перезапущен во время попытки.');return;}
    halt(state,job,'Chrome перезапущен. Проверьте вкладку перед продолжением.',job?.status==='uncertain'?'uncertain':'blocked');
    await save(state);
  }
}));
chrome.runtime.onInstalled.addListener((details={})=>exclusive(async()=>{
  const state=await load();
  if(details.reason==='update') {
    state.settings.review=true;
    for(const deferred of state.queue.filter(item=>item.status==='deferred_send')){deferred.approved=false;deferred.needsTabCheck=true;}
    const job=state.queue.find(item=>item.id===state.activeId);
    await stopLearning(state,job);
    if(job?.status==='sending'){state.running=false;await interruptedSend(state,job,'Расширение обновлено во время попытки.');return;}
    if(state.running || job) halt(state,job,'Расширение обновлено. Обновите вкладку магазина/чата перед продолжением.',job?.status==='uncertain'?'uncertain':'blocked');
    if(job) job.approved=false;
  }
  await save(state); await alarm();
}));
chrome.action.onClicked.addListener(async()=>{
  const url=chrome.runtime.getURL('dashboard.html');
  const tabs=await chrome.tabs.query({url});
  if(tabs[0]) { await chrome.tabs.update(tabs[0].id,{active:true}); await chrome.windows.update(tabs[0].windowId,{focused:true}); }
  else await chrome.windows.create({url,type:'popup',width:1240,height:900});
});
