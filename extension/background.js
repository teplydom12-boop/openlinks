import {initialState, validateSettings, classify, parseList, dueJob, nextAllowed, FINAL} from './lib/core.js';

const KEY = 'openlinksState';
let serial = Promise.resolve();
const exclusive = task => {
  const result = serial.then(task);
  serial = result.catch(error => console.error('OpenLinks:', error.message));
  return result;
};
async function load() { return (await chrome.storage.local.get(KEY))[KEY] || initialState(); }
async function save(state) { await chrome.storage.local.set({[KEY]:state}); }
function event(state, type, job, detail = '') {
  state.events.push({id:crypto.randomUUID(), at:Date.now(), type, jobId:job?.id, url:job?.url || '', detail});
}
function halt(state, job, reason, status = 'blocked') {
  state.running = false;
  if (job) { job.status = status; job.reason = reason; event(state, status, job, reason); }
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
    try { return {...await call(job, frame.frameId, 'PROBE'), frameId:frame.frameId}; }
    catch { return null; }
  }));
  return results.filter(Boolean);
}
async function finish(state, job, status, detail) {
  job.status = status;
  job.finishedAt = Date.now();
  job.reason = detail;
  event(state, status, job, detail);
  state.activeId = null;
  await save(state);
  // Do not close the conversation. It can contain a reply or a manually completed form.
  if (state.running) await alarm(Date.now()+1000);
}
async function performSend(state, job) {
  const now = Date.now();
  const allowed = nextAllowed(state, job.platform, 'send', now);
  if (allowed > now) { job.reason = 'Отправка после ' + new Date(allowed).toLocaleTimeString(); await save(state); await alarm(allowed); return; }
  const reply = await call(job, job.frameId, 'PREPARE');
  if (!reply.ok || reply.pageUrl !== job.reviewUrl) {
    halt(state, job, reply.reason || 'Страница изменилась. Проверьте получателя и форму заново.');
    await save(state); return;
  }
  // Persist BEFORE the side effect. Never retry a send after a disconnect/restart.
  job.status = 'sending';
  job.sendAt = Date.now();
  job.evidence = reply.evidence;
  state.slots.push({platform:job.platform, kind:'send', at:job.sendAt, jobId:job.id});
  event(state, 'send_attempt', job, 'Зарезервирован лимит; выполняется одна попытка нажатия');
  await save(state);
  try {
    const result = await call(job, job.frameId, 'SEND', {evidence:reply.evidence, expectedUrl:job.reviewUrl});
    if (!result.clicked) {
      halt(state, job, result.reason || 'Отправка остановлена до нажатия', 'uncertain');
      await save(state); return;
    }
  } catch {
    // Navigation can disconnect the response even when the click succeeded.
  }
  await alarm(Date.now()+3000);
}
async function tick() {
  const state = await load();
  if (!state.running) return;
  await alarm(); // Recovery alarm also survives worker suspension and browser restart.
  let job = state.queue.find(j => j.id === state.activeId);
  if (!job) {
    const due = dueJob(state, Date.now());
    if (!due) { state.running = false; event(state, 'complete', null, 'Очередь завершена'); await save(state); return; }
    if (due.at > Date.now()) { await alarm(due.at); return; }
    job = due.job;
    job.status = 'visiting'; job.visitAt = Date.now(); job.stepAt = Date.now();
    job.message = state.settings.message.trim(); job.profile = structuredClone(state.settings.profiles[job.platform]);
    state.slots.push({platform:job.platform, kind:'visit', at:job.visitAt, jobId:job.id});
    state.activeId = job.id;
    event(state, 'visit', job, 'Открытие страницы; зарезервирован лимит посещения');
    await save(state);
    try {
      const tab = await chrome.tabs.create({url:job.url, active:true});
      job.tabId = tab.id;
      await save(state);
    } catch (error) { halt(state, job, 'Не удалось открыть вкладку: '+error.message); await save(state); }
    return;
  }
  if (job.status === 'review') {
    if (job.approved) await performSend(state, job);
    return;
  }
  if (['blocked','uncertain'].includes(job.status)) { state.running=false; await save(state); return; }
  let results;
  try { results = await probe(job); }
  catch { halt(state, job, 'Вкладка закрыта или недоступна. Проверьте результат вручную; повторная отправка не выполнялась.', job.status==='sending'?'uncertain':'blocked'); await save(state); return; }
  const obstacle = results.find(result => result.obstacle);
  if (obstacle) {
    halt(state, job, obstacle.obstacle, job.status === 'sending' ? 'uncertain' : 'blocked');
    await save(state); return;
  }
  if (job.status === 'sending') {
    const confirmations = await Promise.all(results.filter(result=>result.frameId===job.frameId).map(async result => {
      try { return await call(job, result.frameId, 'CHECK_SENT', {evidence:job.evidence}); }
      catch { return null; }
    }));
    if (confirmations.some(result => result?.confirmed)) {
      await finish(state, job, 'sent', 'Интерфейс показал новое подтверждение отправки'); return;
    }
    if (Date.now() - job.sendAt > 45000) {
      halt(state, job, 'Нет подтверждения от сайта. Проверьте чат вручную. Автоповтор отключён.', 'uncertain');
      await save(state);
    }
    return;
  }
  const forms = results.filter(result => result.kind === 'form');
  if (forms.length > 1) { halt(state, job, 'Найдено несколько форм в разных фреймах. Задайте точный CSS-селектор.'); await save(state); return; }
  if (forms.length === 1) {
    job.frameId = forms[0].frameId;
    const reply = await call(job, job.frameId, 'PREPARE');
    if (!reply.ok) { halt(state, job, reply.reason); await save(state); return; }
    job.status = 'review'; job.reviewUrl = reply.pageUrl; job.approved = !state.settings.review;
    job.reason = state.settings.review ? 'Проверьте получателя и текст, затем подтвердите отправку.' : '';
    event(state, 'draft_ready', job, state.settings.review ? 'Ожидается подтверждение' : 'Автоматический режим');
    await save(state);
    if (job.approved) await performSend(state, job);
    return;
  }
  const ambiguous = results.find(result => result.kind === 'ambiguous');
  if (ambiguous) { halt(state, job, ambiguous.reason); await save(state); return; }
  if (job.status === 'visiting') {
    // Prefer the main frame. Never arbitrarily choose between different contacts.
    const contactFrames = results.filter(result => result.kind === 'contact');
    const contact = contactFrames.find(result => result.frameId === 0) || (contactFrames.length === 1 ? contactFrames[0] : null);
    if (contact) {
      job.status = 'contacting'; job.stepAt = Date.now();
      await save(state);
      if (contact.href) {
        try {
          if (classify(contact.href).platform !== job.platform) throw new Error('Другая площадка');
          await chrome.tabs.update(job.tabId, {url:contact.href});
        } catch { halt(state, job, 'Ссылка ведёт вне поддерживаемой площадки. Откройте чат вручную.'); await save(state); }
      } else {
        const reply = await call(job, contact.frameId, 'CONTACT');
        if (!reply.ok) { halt(state, job, reply.reason); await save(state); }
      }
      return;
    }
  }
  if (Date.now() - job.stepAt > 90000) {
    halt(state, job, 'За 90 секунд не найдена однозначная форма. Откройте чат в этой вкладке или настройте CSS-селекторы.');
    await save(state);
  }
}
async function safeTick() {
  try { await tick(); }
  catch (error) {
    const state=await load();
    const job=state.queue.find(j=>j.id===state.activeId);
    halt(state,job,'Ошибка доступа к вкладке или форме: '+error.message,job?.status==='sending'?'uncertain':'blocked');
    await save(state);
  }
}
async function dispatch(message, sender) {
  if (message.type === 'PAGE_READY') {
    const state = await load();
    const job = state.queue.find(j => j.id === state.activeId);
    if (sender.tab?.id === job?.tabId) await safeTick();
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
      if (state.activeId) throw new Error('Завершите или пропустите текущую задачу перед изменением настроек');
      state.settings = validateSettings(message.settings); await save(state); return {ok:true};
    case 'START':
      if (!state.settings.message.trim()) throw new Error('Сначала сохраните текст сообщения');
      if (job && ['blocked','uncertain'].includes(job.status)) throw new Error('Сначала разрешите ситуацию с текущим поставщиком');
      if (!state.settings.review) {
        for (const key of new Set(state.queue.filter(j=>!FINAL.has(j.status)).map(j=>j.platform))) {
          if (['contact','editor','send','success'].some(field=>!state.settings.profiles[key][field].trim())) {
            throw new Error('Для автоматического режима задайте все четыре проверенных CSS-селектора площадки '+key);
          }
        }
      }
      state.running=true; event(state,'start',null,'Очередь запущена'); await save(state); await alarm(Date.now()+1000); return {ok:true};
    case 'PAUSE':
      state.running=false; event(state,'pause',null,'Пауза пользователя; уже начатое нажатие не отменяется'); await save(state); return {ok:true};
    case 'APPROVE':
      if (!job || job.status !== 'review') throw new Error('Нет сообщения для подтверждения');
      job.approved=true; state.running=true; await save(state); await alarm(Date.now()+1000); return {ok:true};
    case 'RECHECK':
      if (!job || job.status !== 'blocked') throw new Error('Нет заблокированной задачи');
      job.status='contacting'; job.stepAt=Date.now(); job.reason=''; state.running=true;
      event(state,'recheck',job,'Повторная проверка существующей вкладки без нового посещения');
      await save(state); await alarm(Date.now()+1000); return {ok:true};
    case 'MARK_SENT':
      if (!job || job.status !== 'uncertain') throw new Error('Нет неподтверждённой отправки');
      await finish(state,job,'sent','Пользователь вручную подтвердил наличие отправленного сообщения'); return {ok:true};
    case 'SKIP': {
      const target=state.queue.find(j=>j.id===message.id);
      if (!target || FINAL.has(target.status)) throw new Error('Нечего пропускать');
      if (target.status==='sending') throw new Error('Дождитесь проверки уже начатой отправки');
      if (target.id===state.activeId) await finish(state,target,'skipped','Пропущено пользователем');
      else { target.status='skipped'; event(state,'skipped',target,'Пропущено пользователем'); await save(state); }
      return {ok:true};
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
async function adoptChatTab(state,tab) {
  const job=state.queue.find(j=>j.id===state.activeId);
  if(!tab.openerTabId || job?.tabId!==tab.openerTabId || job.status!=='contacting') return;
  try {
    if(classify(tab.pendingUrl || tab.url).platform!==job.platform) return;
    job.tabId=tab.id; job.stepAt=Date.now(); event(state,'chat_tab',job,'Открыта вкладка чата площадки');
    await save(state); await alarm(Date.now()+2000);
  } catch { /* An unrelated or external tab is never adopted. */ }
}
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(change.status==='complete') exclusive(async()=>{
    const state=await load();
    if(tab) await adoptChatTab(state,tab);
    if(state.queue.find(j=>j.id===state.activeId)?.tabId===tabId) await safeTick();
  });
});
// A site's Contact button may open its messenger in a new tab.
chrome.tabs.onCreated.addListener(tab=>{
  if(!tab.openerTabId) return;
  exclusive(async()=>{
    await adoptChatTab(await load(),tab);
  });
});
chrome.runtime.onStartup.addListener(()=>exclusive(async()=>{
  const state=await load();
  // Existing tab IDs and account state cannot be assumed to survive a browser restart.
  if(state.running || state.activeId) {
    const job=state.queue.find(j=>j.id===state.activeId);
    halt(state,job,'Chrome перезапущен. Проверьте вкладку и состояние отправки.', job?.status==='sending'?'uncertain':'blocked');
    await save(state);
  }
}));
chrome.runtime.onInstalled.addListener(()=>exclusive(async()=>{
  const state=await load(); await save(state); await alarm();
}));
chrome.action.onClicked.addListener(async()=>{
  const url=chrome.runtime.getURL('dashboard.html');
  const tabs=await chrome.tabs.query({url});
  if(tabs[0]) { await chrome.tabs.update(tabs[0].id,{active:true}); await chrome.windows.update(tabs[0].windowId,{focused:true}); }
  else await chrome.windows.create({url,type:'popup',width:1240,height:900});
});
