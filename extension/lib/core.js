import '../rules-shared.js';
import {localTimestamp,timeZone} from './time.js';
const {upgradeRule}=globalThis.OpenLinksRules;
export const WINDOW_MS = 20 * 60 * 1000;
export const PLATFORMS = {
  '1688': {label: '1688', domain: '1688.com', limit: 7, interval: 180},
  alibaba: {label: 'Alibaba', domain: 'alibaba.com', limit: 3, interval: 420},
  mic: {label: 'Made-in-China', domain: 'made-in-china.com', limit: null, interval: 60},
};
export const FINAL = new Set(['sent', 'attempted', 'attempt_unknown', 'skipped', 'failed']);
export const STATUS = {
  pending: 'В очереди', deferred_send:'Отложено до обновления лимита', visiting: 'Открытие магазина', contacting: 'Открытие чата',
  drafting: 'Подготовка сообщения', review: 'Ждёт подтверждения', sending: 'Нажимаю «Отправить»',
  attempted:'Кнопка отправки нажата', attempt_unknown:'Результат отправки неизвестен',
  sent: 'Отправлено', uncertain: 'Отправка не подтверждена', blocked: 'Нужно вмешательство',
  failed: 'Ошибка — пропущено', skipped: 'Пропущено', retry_wait:'Ожидание автоматической проверки', removed:'Удалено из очереди',
};
export function classify(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Некорректная ссылка'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Нужна HTTPS-ссылка без пароля и нестандартного порта');
  }
  const platform = Object.keys(PLATFORMS).find(key => {
    const host = PLATFORMS[key].domain;
    return url.hostname === host || url.hostname.endsWith('.' + host);
  });
  if (!platform) throw new Error('Поддерживаются только 1688, Alibaba и Made-in-China');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|spm$|tracelog$)/i.test(key)) url.searchParams.delete(key);
  }
  return {platform, url: url.href};
}
export function initialState() {
  return {
    version: 5, running: false, activeId: null, waiting: null, activity: null, learning:null, rules:[], chatRoutes:{}, queue: [], events: [], slots: [],
    settings: {message: '', review: true, intervals: { '1688': 180, alibaba: 420, mic: 60 },
      profiles: Object.fromEntries(Object.keys(PLATFORMS).map(key => [key, {
        chat: '', contact: '', editor: '', send: '', success: '',
      }]))},
  };
}
export function migrateState(saved) {
  if (!saved) return initialState();
  if (saved.version === 5) return saved;
  const state = structuredClone(saved);
  state.version = 5; state.running = false; state.waiting = null; state.activity = null; state.learning=null; state.rules=(state.rules || []).map(upgradeRule);state.chatRoutes||={};
  state.settings.review = true;
  for (const profile of Object.values(state.settings.profiles)) profile.chat ||= '';
  const active = state.queue.find(job => job.id === state.activeId);
  for(const job of state.queue) if(job.profile) job.profile.rules=state.rules.filter(rule=>rule.platform===job.platform);
  if (active) {
    const started=active.status==='sending' || active.status==='uncertain';
    active.status = started ? (active.platform==='1688'?'uncertain':'attempt_unknown') : 'blocked';
    if(started && active.status==='attempt_unknown'){active.finishedAt=Date.now();state.activeId=null;}
    active.needsTabCheck=true;
    active.reason = 'Расширение обновлено. Обновите вкладки и продолжите задачу; обучение и лимиты сохранены.';
    active.approved = false;
  }
  state.events.push({id:crypto.randomUUID(),at:Date.now(),type:'upgrade',level:'decision',detail:`Сохранено правил: ${state.rules.length}. Область Alibaba TrustPass расширена на другие магазины; добавлены этапы открытия чата и проверка редактора 1688. История и лимиты сохранены.`});
  return state;
}
export function validateSettings(value) {
  const settings = structuredClone(value);
  if (typeof settings.message !== 'string' || settings.message.length > 10000) {
    throw new Error('Текст сообщения: не более 10 000 символов');
  }
  settings.review = settings.review !== false;
  for (const key of Object.keys(PLATFORMS)) {
    const interval = Number(settings.intervals?.[key]);
    if (!Number.isInteger(interval) || interval < 30 || interval > 86400) {
      throw new Error('Интервал должен быть целым числом от 30 до 86 400 секунд');
    }
    settings.intervals[key] = interval;
    if (!settings.profiles?.[key]) throw new Error('Не задан профиль площадки');
    settings.profiles[key].chat ||= '';
    for (const field of ['chat', 'contact', 'editor', 'send', 'success']) {
      if (typeof settings.profiles[key][field] !== 'string' || settings.profiles[key][field].length > 500) {
        throw new Error('CSS-селектор: не более 500 символов');
      }
    }
  }
  return settings;
}
// Count visits and sends separately. Reservations survive errors and queue deletion.
// This limits contact operations, not the HTTP requests made by the site itself.
export function eligibility(state, platform, kind, now) {
  const slots = state.slots.filter(s => s.platform === platform && s.kind === kind)
    .map(s => s.at).sort((a,b) => a-b);
  let next = now,quotaUntil=now;
  const reasons = [];
  const last = state.slots.filter(slot => slot.kind === 'visit').at(-1);
  if (kind === 'visit' && last?.platform === platform) {
    const intervalAt = last.at + state.settings.intervals[platform] * 1000;
    if (intervalAt > now) { next = Math.max(next, intervalAt); reasons.push(`Соседние магазины на ${PLATFORMS[platform].label}: интервал ${state.settings.intervals[platform]} с`); }
  }
  // Clock rollback must not turn future reservations into unused capacity.
  if (slots.at(-1) > now) { next = Math.max(next, slots.at(-1) + 1000); reasons.push('Системные часы отстают от сохранённых операций'); }
  const limit = PLATFORMS[platform].limit;
  if (limit && slots.length >= limit) {
    const quotaAt = slots.at(-limit) + WINDOW_MS + 1000;
    if (quotaAt > now) { quotaUntil=quotaAt;next = Math.max(next, quotaAt); reasons.push(`Лимит ${PLATFORMS[platform].label}: ${limit} за 20 минут (${kind === 'visit' ? 'посещения' : 'отправки'})`); }
  }
  return {at: next, quotaUntil, reasons, previousPlatform:last?.platform || null};
}
export const nextAllowed = (state, platform, kind, now) => eligibility(state, platform, kind, now).at;
export function makePlan(state, now = Date.now()) {
  const virtual = {...state, slots: [...state.slots]};
  const dates = new Map();
  let remaining = state.queue.filter(job => ['pending','deferred_send'].includes(job.status));
  let cursor = now;
  while (remaining.length) {
    const {job, at} = dueJob({...virtual, queue: remaining}, cursor);
    dates.set(job.id, at);
    if(job.status==='pending')virtual.slots.push({platform: job.platform, kind: 'visit', at});
    virtual.slots.push({platform: job.platform, kind: 'send', at});
    remaining = remaining.filter(item => item.id !== job.id);
    cursor = at + 1;
  }
  // The active operation may require a human; pending times are estimates.
  return state.queue.map(job => ({...job, plannedAt: dates.get(job.id) ?? job.visitAt ?? null}));
}
export function dueJob(state, now) {
  const candidates=state.queue.filter(job=>['pending','deferred_send'].includes(job.status));
  const blocked=[],seen=new Set();
  for(const job of candidates) {
    if(seen.has(job.platform))continue;
    seen.add(job.platform);
    const send=eligibility(state,job.platform,'send',now);
    const visit=job.status==='pending'?eligibility(state,job.platform,'visit',now):send;
    const reasons=[...new Set([...visit.reasons,...send.reasons])];
    if(job.requestedAt>now)reasons.push('Заданное время посещения ещё не наступило');
    const due={job,at:Math.max(visit.at,send.at,job.requestedAt || 0),reasons,quotaUntil:Math.max(visit.quotaUntil,send.quotaUntil)};
    // Preserve order within each platform, but never let its interval, quota
    // or scheduled time block another platform that can run now. Recalculate
    // from actual visits every time: switching platforms removes adjacency.
    if(due.at>now) {blocked.push(due);continue;}
    return {...due,deferred:blocked};
  }
  if(blocked.length) {
    const selected=blocked.reduce((best,item)=>item.at<best.at?item:best);
    return {...selected,deferred:blocked.filter(item=>item.job!==selected.job)};
  }
  return undefined;
}
export function parseList(text, existing = [], now = Date.now()) {
  const seen = new Set(existing.map(job => job.url));
  const jobs = [], errors = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    try {
      const columns = line.split('\t');
      if (columns.length >= 4 && STATUS[columns[2]] && columns[2] !== 'pending') {
        throw new Error('Из расписания импортируются только задачи pending; остальные статусы требуют ручной проверки');
      }
      const match = line.match(/https?:\/\/[^\s<>\])]+/i);
      if (!match) throw new Error('Нет ссылки');
      const {platform, url} = classify(match[0]);
      const date = line.replace(match[0], '').match(/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)/);
      const requestedAt = date ? Date.parse(date[0]) : now;
      if (!Number.isFinite(requestedAt)) throw new Error('Некорректное время');
      if (seen.has(url)) throw new Error('Такая ссылка уже есть в очереди или истории');
      seen.add(url);
      jobs.push({id: crypto.randomUUID(), url, platform, requestedAt, status:'pending', createdAt:now});
    } catch (error) { errors.push(`Строка ${index+1}: ${error.message}`); }
  });
  return {jobs, errors};
}
const iso = localTimestamp;
const clean = text => String(text ?? '').replace(/[\r\n\t]/g, ' ');
export function scheduleText(state, now = Date.now()) {
  const plan = makePlan(state, now);
  return `# OpenLinks — schedule.txt\n# Местное время компьютера: ${timeZone()} (ISO 8601 со смещением UTC). Для ожидающих задач — оценка; ручные паузы сдвигают расписание.\n` +
    '# время\tплощадка\tстатус\tURL\n' +
    plan.map(j => [iso(j.plannedAt), PLATFORMS[j.platform].label, j.status, j.url].join('\t')).join('\n') + '\n';
}
export function linkResults(state) {
  const rows=new Map();
  for(const e of state.events) {
    if(!e.jobId || !e.url)continue;
    const row=rows.get(e.jobId) || {id:e.jobId,url:e.url,status:'pending',errorCount:0};
    row.at=e.at;
    if(e.jobStatus || STATUS[e.type])row.status=e.jobStatus || e.type;
    row.errorCount=Math.max(row.errorCount,e.errorCount || 0);
    if(e.type==='job_error' || FINAL.has(e.type) || ['blocked','uncertain','retry_scheduled'].includes(e.type))row.reason=e.detail;
    if(e.type==='remove_job' && !FINAL.has(row.status)){row.status='removed';row.reason=e.detail;}
    rows.set(e.jobId,row);
  }
  for(const job of state.queue) {
    const previous=rows.get(job.id) || {};
    rows.set(job.id,{...previous,id:job.id,url:job.url,status:job.status,errorCount:job.errorCount || previous.errorCount || 0,
      at:job.finishedAt || previous.at || job.createdAt,reason:job.reason || previous.reason || ''});
  }
  return [...rows.values()].map(row=>({...row,
    group:['sent','attempted'].includes(row.status)?'worked':['failed','attempt_unknown','uncertain','blocked'].includes(row.status)?'errors':['skipped','removed'].includes(row.status)?'skipped':'pending',
    label:row.status==='attempt_unknown'?'Нужна проверка — без повтора':STATUS[row.status] || row.status,
  })).sort((a,b)=>(b.at || 0)-(a.at || 0));
}
export function reportText(state) {
  return `# OpenLinks — report.txt\n# Местное время компьютера: ${timeZone()}. attempted = нажатие отправки; attempt_unknown = результат неизвестен, без автоповтора. Для новых attempted на 1688 проверено очищение редактора. Сервер, доставка и прочтение не проверяются. sent = старая или ручная отметка.\n` +
    '# РЕЗУЛЬТАТЫ ПО ССЫЛКАМ — каждое повторное добавление является отдельной задачей\n# время\tID задачи\tстатус\tошибок\tURL\tпричина\n'+
    linkResults(state).map(row=>[iso(row.at),row.id,row.status,row.errorCount,clean(row.url),clean(row.reason)].join('\t')).join('\n')+'\n\n'+
    '# СОБЫТИЯ\n# время\tсобытие\tURL\tподробности\n' + state.events.map(e =>
      [iso(e.at), e.type, clean(e.url), clean(e.detail)].join('\t')).join('\n') + '\n';
}
export const EVENT_LABELS = {
  decision:'Выбор следующего магазина', wait:'Ожидание', visit:'Открываю магазин', page_opened:'Вкладка открыта',
  dom_scan:'Проверка страницы', chat_open:'Открываю чат', chat_ready:'Чат найден', draft_ready:'Сообщение подготовлено',
  approved:'Отправка подтверждена пользователем', send_attempt:'Отправляю в чат', clicked:'Кнопка отправки нажата',
  delivery_check:'Проверка результата', send_disconnect:'Ответ вкладки потерян', settings:'Настройки сохранены',
  start:'Запуск',pause:'Пауза',import:'Импорт',complete:'Очередь завершена',recheck:'Проверяю снова',
  chat_tab:'Новая вкладка чата',remove_pending:'Удаление ожидающих задач',upgrade:'Обновление расширения',...STATUS,
  learning:'Жду обучающего клика',learned:'Правило сохранено',learning_cancel:'Обучение отменено',rule_removed:'Правило удалено',
  challenge_close:'Закрываю окно проверки',direct_chat:'Прямой переход в чат',chat_route:'Адрес чата сохранён',
  chat_lookup:'Определяю получателя 1688',chat_lookup_fallback:'Перехожу к обычному открытию чата',chat_route_removed:'Адрес чата забыт',
  quota_deferred:'Площадка временно отложена',quota_resume:'Возврат к отложенной задаче',
  remove_job:'Строка удалена',manual_retry:'Повтор по решению пользователя',editor_input:'Ввод текста',composer_accepted:'Редактор 1688 очистился',
  chat_close_scheduled:'Закрытие чата назначено',chat_closed:'Вкладка чата закрыта',chat_close_cancelled:'Закрытие чата отменено',
  skip_tab_closed:'Вкладка закрыта при пропуске',skip_tab_kept:'Вкладка не закрыта при пропуске',
  chat_discovered:'Открытый чат распознан',
  chat_open_attempt:'Штатный клик открытия чата',
  chat_loading:'Ожидание готовности чата',job_error:'Ошибка ссылки',retry_scheduled:'Автопроверка назначена',retry_started:'Автоматически проверяю снова',
  draft_replaced:'Старый текст в поле заменён',
};
export function activityText(state) {
  return `# OpenLinks — activity.log\n# Наблюдаемые действия, результаты проверок и причины решений. Местное время компьютера: ${timeZone()}.\n` +
    state.events.map(entry => `${iso(entry.at)} [${entry.level || 'action'}] ${EVENT_LABELS[entry.type] || entry.type}${entry.url ? ' | '+clean(entry.url) : ''} | ${clean(entry.detail)}`).join('\n') + '\n';
}
