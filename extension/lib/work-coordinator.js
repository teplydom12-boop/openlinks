import {dueJob,eligibility,FINAL,PLATFORMS} from './core.js';

export const WORK_COORDINATOR_KEY='openlinksWorkCoordinator';
export function normalizeWorkCoordinator(value) {
  return {version:1,enabled:value?.enabled===true,startedAt:Number.isFinite(value?.startedAt)?value.startedAt:null};
}

// A scheduled visit or the interval between neighbouring shops is not a quota
// wait. Only exhausted rolling quotas on every remaining platform give the
// inbox a turn; a ready Made-in-China row therefore keeps outreach priority.
export function assessWorkCoordination(state,{enabled=false,testMode=false,dialogsRunning=false}={},now=Date.now()) {
  const remaining=state.queue.filter(job=>!FINAL.has(job.status));
  const result={enabled:enabled===true,testMode:testMode===true,phase:testMode?'test_paused':'independent',allowDialogs:true,detail:testMode?'Тестовый режим без отправки. Совместный запуск недоступен; отдельные тестовые циклы диалогов работают.':'Блоки работают раздельно.',nextAt:null,pending:remaining.length,quotaPlatforms:[]};
  if(!enabled)return result;
  if(testMode)return {...result,phase:'test_paused',allowDialogs:false,detail:'Тестовый режим: совместная работа остановлена, настоящая отправка запрещена.'};
  if(!dialogsRunning)return {...result,phase:'needs_attention',allowDialogs:false,detail:'Переписка приостановлена. Для совместной работы запустите оба блока снова.'};
  const active=state.queue.find(job=>job.id===state.activeId&&!FINAL.has(job.status));
  if(!remaining.length&&!active)return {...result,phase:'dialogs_queue_complete',detail:'Первичная очередь завершена. Продолжается переписка с поставщиками.'};
  if(!state.running||active&&['blocked','uncertain'].includes(active.status))return {...result,phase:'needs_attention',allowDialogs:false,detail:'Первичная очередь приостановлена или требует вмешательства. Совместная работа ожидает решения.'};
  if(active)return {...result,phase:'outreach',allowDialogs:false,detail:'Сначала завершаю работу с текущим поставщиком в первичной очереди.'};
  const firstByPlatform=new Map();
  for(const job of remaining) {
    if(!['pending','deferred_send'].includes(job.status))return {...result,phase:'needs_attention',allowDialogs:false,detail:'В первичной очереди есть незавершённая задача без активной вкладки. Проверьте её перед продолжением.'};
    if(!Object.hasOwn(PLATFORMS,job.platform))return {...result,phase:'needs_attention',allowDialogs:false,detail:'В первичной очереди обнаружена неизвестная площадка.'};
    if(!firstByPlatform.has(job.platform))firstByPlatform.set(job.platform,job);
  }
  const quotas=[];
  for(const [platform,job] of firstByPlatform) {
    const send=eligibility(state,platform,'send',now);
    const visit=job.status==='pending'?eligibility(state,platform,'visit',now):send;
    const until=Math.max(send.quotaUntil,visit.quotaUntil);
    if(until<=now) {
      const due=dueJob(state,now);
      return {...result,phase:'outreach',allowDialogs:false,nextAt:due?.at>now?due.at:null,detail:due?.at>now?'Первичная очередь ждёт назначенное время или интервал между магазинами. Приоритет остаётся у первичных обращений.':'В первичной очереди есть доступная площадка. Сначала обрабатываю её поставщиков.'};
    }
    quotas.push({platform,until});
  }
  if(!quotas.length)return {...result,phase:'needs_attention',allowDialogs:false,detail:'Не удалось определить следующую задачу первичной очереди.'};
  return {...result,phase:'dialogs_quota_wait',nextAt:Math.min(...quotas.map(item=>item.until)),quotaPlatforms:quotas.map(item=>item.platform),detail:'Лимиты всех оставшихся площадок первичной очереди исчерпаны. Во время ожидания работаю с перепиской; общие лимиты отправки сохраняются.'};
}
