export const WINDOW_MS = 20 * 60 * 1000;
export const PLATFORMS = {
  '1688': {label: '1688', domain: '1688.com', limit: 7, interval: 180},
  alibaba: {label: 'Alibaba', domain: 'alibaba.com', limit: 3, interval: 420},
  mic: {label: 'Made-in-China', domain: 'made-in-china.com', limit: null, interval: 60},
};
export const FINAL = new Set(['sent', 'skipped', 'failed']);
export const STATUS = {
  pending: 'В очереди', visiting: 'Открытие магазина', contacting: 'Открытие формы',
  drafting: 'Подготовка сообщения', review: 'Ждёт подтверждения', sending: 'Проверка отправки',
  sent: 'Отправлено', uncertain: 'Отправка не подтверждена', blocked: 'Нужно вмешательство',
  failed: 'Ошибка', skipped: 'Пропущено',
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
    version: 1, running: false, activeId: null, queue: [], events: [], slots: [],
    settings: {message: '', review: true, intervals: { '1688': 180, alibaba: 420, mic: 60 },
      profiles: Object.fromEntries(Object.keys(PLATFORMS).map(key => [key, {
        contact: '', editor: '', send: '', success: '',
      }]))},
  };
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
    for (const field of ['contact', 'editor', 'send', 'success']) {
      if (typeof settings.profiles[key][field] !== 'string' || settings.profiles[key][field].length > 500) {
        throw new Error('CSS-селектор: не более 500 символов');
      }
    }
  }
  return settings;
}
// Count visits and sends separately. Reservations survive errors and queue deletion.
// This limits contact operations, not the HTTP requests made by the site itself.
export function nextAllowed(state, platform, kind, now) {
  const slots = state.slots.filter(s => s.platform === platform && s.kind === kind)
    .map(s => s.at).sort((a,b) => a-b);
  let next = now;
  if (slots.length) next = Math.max(next, slots.at(-1) + state.settings.intervals[platform] * 1000);
  const limit = PLATFORMS[platform].limit;
  if (limit && slots.length >= limit) {
    next = Math.max(next, slots.at(-limit) + WINDOW_MS + 1000);
  }
  return next;
}
export function makePlan(state, now = Date.now()) {
  const virtual = {...state, slots: [...state.slots]};
  const dates = new Map();
  let remaining = state.queue.filter(job => job.status === 'pending');
  let cursor = now;
  while (remaining.length) {
    const {job, at} = dueJob({...virtual, queue: remaining}, cursor);
    dates.set(job.id, at);
    virtual.slots.push({platform: job.platform, kind: 'visit', at});
    remaining = remaining.filter(item => item.id !== job.id);
    cursor = at + 1;
  }
  // The active operation may require a human; pending times are estimates.
  return state.queue.map(job => ({...job, plannedAt: dates.get(job.id) ?? job.visitAt ?? null}));
}
export function dueJob(state, now) {
  // Eligible platforms can proceed while another platform is cooling down.
  return state.queue.filter(job => job.status === 'pending')
    .map(job => ({job, at: nextAllowed(state, job.platform, 'visit', Math.max(now, job.requestedAt || 0))}))
    .sort((a,b) => a.at - b.at || state.queue.indexOf(a.job) - state.queue.indexOf(b.job))[0];
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
const iso = time => time ? new Date(time).toISOString() : '—';
const clean = text => String(text ?? '').replace(/[\r\n\t]/g, ' ');
export function scheduleText(state, now = Date.now()) {
  const plan = makePlan(state, now);
  return '# OpenLinks — schedule.txt\n# Время UTC (ISO 8601). Для ожидающих задач — оценка; ручные паузы сдвигают расписание.\n' +
    '# время\tплощадка\tстатус\tURL\n' +
    plan.map(j => [iso(j.plannedAt), PLATFORMS[j.platform].label, j.status, j.url].join('\t')).join('\n') + '\n';
}
export function reportText(state) {
  return '# OpenLinks — report.txt\n# Время UTC (ISO 8601). sent означает подтверждение интерфейсом, не доставку или прочтение.\n' +
    '# время\tсобытие\tURL\tподробности\n' + state.events.map(e =>
      [iso(e.at), e.type, clean(e.url), clean(e.detail)].join('\t')).join('\n') + '\n';
}
