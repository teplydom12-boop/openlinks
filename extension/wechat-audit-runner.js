import {conversationKey} from './lib/dialogs.js';
import {WECHAT_AUDIT_PLATFORMS,initialWechatAudit,wechatContactFingerprint,assessWechatAuditConversation,recordWechatAuditResult} from './lib/wechat-audit.js';

const DAY=86400000,WAIT_LIMIT=120000,MAX_ATTEMPTS=8;
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value||{},key);
const delay=value=>Math.max(250,Math.min(5000,Number(value)||1000));
const busy=value=>value===true||value&&typeof value==='object'&&Object.values(value).some(flag=>flag===true);
const knownTime=row=>row?.latestMessageAtReliable===true&&Number.isFinite(row.latestMessageAt)&&row.latestMessageAt>=0?row.latestMessageAt:null;
const keyOf=(platform,row)=>{try{return conversationKey(platform,row.id);}catch{return '';}};
const sameRoute=(left,right)=>{try{const a=new URL(left),b=new URL(right);return a.origin===b.origin&&a.pathname===b.pathname;}catch{return false;}};
async function timed(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Reader timeout')),7000);})]);}finally{clearTimeout(timer);}}

// This runner has no draft, provider, editor or send dependencies. A step reads
// the current platform and performs at most one reader action. Persisted intent
// and fresh document/thread proofs make worker suspension and pause resumable.
export function createWechatAuditRunner({api,now=Date.now,scanPlatform,activateWorkingTab=async()=>{},activity=()=>{},save=async()=>{},cancelled=()=>false}) {
  async function step(state) {
    const audit=state.workflow?.audit,contact=String(state.settings?.wechat||'').trim();
    if(!audit||audit.phase!=='running'||!state.running||cancelled())return null;
    const runId=audit.runId,name=WECHAT_AUDIT_PLATFORMS[audit.cursor],progress=audit.progress;
    const stopped=()=>cancelled()||!state.running||audit.phase!=='running'||state.workflow?.audit!==audit||audit.runId!==runId;
    const persist=async continuation=>{if(!stopped())await save(state);return stopped()?null:continuation;};
    const note=(phase,detail,key='')=>activity(state,phase,detail,{platform:name||'',key});
    const block=async detail=>{
      if(stopped())return null;
      audit.phase='blocked';audit.blockedReason=detail;audit.finishedAt=null;state.running=false;
      if(name)Object.assign(audit.platforms[name],{phase:'blocked',checkedAt:now(),detail});
      note('audit_blocked',detail);await save(state);return null;
    };
    const result=async(row,status,detail,extra={})=>{
      if(stopped())return null;
      const key=keyOf(name,row),record=recordWechatAuditResult(audit,{platform:name,key,id:row.id,title:row.title||'',url:row.url||row.sourceUrl||state.bindings[name]?.url||'',position:Number.isInteger(row.position)?row.position:Number.isInteger(row.listOrder)?row.listOrder+1:Object.keys(audit.records).length+1,status,detail,lastMessageAt:knownTime(row),...extra},{runId,contact},now());
      if(!record.accepted){state.running=false;note('audit_blocked',audit.blockedReason||'Не удалось сохранить результат проверки. Обход остановлен.');await save(state);return null;}
      progress.pending=null;note('audit_result',record.record.detail,key);return persist({delay:250});
    };
    const send=async(source,message)=>{
      if(stopped())return null;
      await activateWorkingTab(state,name);
      if(stopped())return null;
      await save(state);
      if(stopped())return null;
      return timed(api.tabs.sendMessage(state.bindings[name].tabId,{...message,documentToken:source.documentToken},{frameId:source.frameId}));
    };
    if(!contact||wechatContactFingerprint(contact)!==audit.contactFingerprint)return block('WeChat ID изменился. Начните новую проверку, чтобы все результаты относились к одному ID.');
    if(!name)return block('Порядок площадок не подтверждён. Начните новую проверку.');
    if(audit.saturated)return block(audit.blockedReason||'Память отчёта заполнена. Сохранённые результаты оставлены без изменений.');
    progress.startedAt??=now();audit.platforms[name].phase='running';
    if(progress.nextAt>now())return persist({delay:delay(progress.nextAt-now())});
    let observed;
    try{observed=await scanPlatform(state,name);}catch{return block('Не удалось прочитать текущую площадку. Проверка других площадок не начиналась.');}
    if(stopped())return null;
    const binding=state.bindings[name],sources=observed?.sources||[],rows=[...(observed?.rows||[])].sort((a,b)=>(Number.isInteger(a.listOrder)?a.listOrder:Infinity)-(Number.isInteger(b.listOrder)?b.listOrder:Infinity));
    if(binding?.status!=='ready'){
      progress.waitingSince??=now();
      if((binding?.status==='loading'||binding?.managed?.pending)&&now()-progress.waitingSince<WAIT_LIMIT){note('audit_waiting','Ожидаю загрузку текущей площадки.');return persist({delay:1000});}
      return block(binding?.detail||'Текущая площадка недоступна. Откройте её чат и продолжите проверку.');
    }
    try{await activateWorkingTab(state,name);}catch{return block('Не удалось показать рабочую вкладку текущей площадки. Проверьте её адрес и продолжите проверку.');}
    if(stopped())return null;
    if(sources.some(source=>busy(source.busy)))return block('Проверка приостановлена: в текущем чате есть черновик или пользователь работает с ним. Уберите черновик или закончите ввод и продолжите.');
    const lists=sources.filter(source=>source.listCoverage?.token),source=lists[0],coverage=source?.listCoverage;
    if(lists.length!==1)return block('Не удалось однозначно прочитать список чатов. Проверка этой площадки не завершена.');
    if(progress.positioned&&(progress.documentToken!==source.documentToken||progress.frameId!==source.frameId||!sameRoute(progress.sourceUrl,source.sourceUrl)))return block('Страница списка чатов изменилась. Начните новую проверку, чтобы не пропустить начало списка.');
    if(coverage.status==='limited'||coverage.windowLimited===true)return block(coverage.detail||'Список чатов прочитан не полностью. Проверка этой площадки не завершена.');
    if(coverage.nativePending===true||coverage.loading===true){
      progress.waitingSince??=now();
      if(now()-progress.waitingSince>=WAIT_LIMIT)return block('Площадка не подтвердила загрузку списка за 120 секунд. Проверка остановлена на этой площадке.');
      note('audit_waiting','Ожидаю подтверждённый порядок и загрузку списка чатов.');return persist({delay:delay(coverage.retryAfterMs)});
    }
    progress.waitingSince=null;
    if(!progress.positioned){
      if(coverage.atStart===true){Object.assign(progress,{positioned:true,documentToken:source.documentToken,frameId:source.frameId,sourceUrl:source.sourceUrl});}
      else {
        if(progress.startAttempts>=3)return block('Не удалось подтвердить начало списка чатов. Обход с середины списка не выполняется.');
        progress.startAttempts++;note('audit_list','Возвращаю список чатов к самой верхней строке.');
        try{const reply=await send(source,{type:'DIALOGS_ADVANCE_LIST',listToken:coverage.token,direction:'start'});if(stopped())return null;if(reply?.busy||reply?.status==='busy')return block('Переход к началу списка остановлен из-за работы пользователя в чате.');if(reply?.ok!==true&&!['loading'].includes(reply?.status))return block('Не удалось вернуться к началу списка чатов. Повторите проверку после загрузки площадки.');progress.nextAt=now()+delay(reply?.retryAfterMs);}
        catch{return block('Нет подтверждения перехода к началу списка. Проверка остановлена на текущей площадке.');}
        return persist({delay:delay(progress.nextAt-now())});
      }
    }
    let pending=progress.pending;
    if(pending){
      if(pending.nextAt>now())return persist({delay:delay(pending.nextAt-now())});
      if(now()-pending.startedAt>=WAIT_LIMIT)return result(pending,'incomplete','Не удалось полностью прочитать чат за 120 секунд. Отсутствие WeChat ID не подтверждено.');
      const active=rows.filter(row=>row.active&&row.identityReliable===true&&row.id===pending.id&&row.frameId===pending.frameId&&row.documentToken===pending.documentToken&&sameRoute(row.sourceUrl,pending.sourceUrl));
      if(active.length!==1){note('audit_opening','Ожидаю открытия выбранного чата.',pending.key);return persist({delay:500});}
      const row={...pending,...active[0],position:pending.position};
      if(row.historyStable===false){note('audit_reading','Ожидаю загрузку сообщений выбранного чата.',pending.key);return persist({delay:1100});}
      if(pending.phase==='opening'){pending.phase='check';pending.openedAt=now();}
      if(['history_start','history_tail'].includes(pending.phase)){
        if(pending.historyAttempts>=MAX_ATTEMPTS)return result(row,'incomplete','История не продвигается после 8 попыток. Отсутствие WeChat ID не подтверждено.');
        const tail=pending.phase==='history_tail';note('audit_history',tail?'Дочитываю последние сообщения чата.':'Загружаю более ранние сообщения и ищу ваш WeChat ID.',pending.key);
        try{
          const reply=await send(row,{type:tail?'DIALOGS_REVEAL_LATEST':'DIALOGS_LOAD_HISTORY_START',conversationId:row.id,...(!tail?{purpose:'wechat-audit'}:{})});
          if(stopped())return null;
          if(reply?.busy||reply?.status==='busy')return block('Чтение истории приостановлено: пользователь работает в чате или появился черновик.');
          if(reply?.status!=='loading')pending.historyAttempts++;
          if(reply?.ok===false&&reply.status!=='loading'||['unsupported','limited'].includes(reply?.status))return result(row,'incomplete',reply?.detail||'Площадка не позволила прочитать всю историю чата.');
          pending.phase='check';pending.nextAt=now()+Math.max(1100,delay(reply?.retryAfterMs));
        }catch{pending.attempts++;pending.phase='check';pending.nextAt=now()+1100;}
        return persist({delay:Math.max(1100,delay(pending.nextAt-now()))});
      }
      note('audit_reading','Проверяю сообщения выбранного чата на наличие вашего WeChat ID.',pending.key);
      let proof;
      try{proof=await send(row,{type:'DIALOGS_CHECK_WECHAT',conversationId:row.id,wechatId:contact});}
      catch{pending.attempts++;if(pending.attempts>=MAX_ATTEMPTS)return result(row,'error','Страница не ответила на 8 проверок. Чат не проверен.');pending.nextAt=now()+1000;return persist({delay:1000});}
      if(stopped())return null;
      if(proof?.busy||proof?.status==='busy')return block('Проверка чата приостановлена из-за ввода пользователя или открытого черновика.');
      const fresh=proof?.ok===true&&proof.conversationId===row.id&&proof.documentToken===row.documentToken&&proof.sourceUrl===row.sourceUrl&&proof.contactFingerprint===audit.contactFingerprint&&proof.identityReliable===true&&Number.isFinite(proof.observedAt)&&proof.observedAt>=pending.openedAt&&proof.observedAt<=now()+5000;
      if(!fresh){pending.attempts++;if(pending.attempts>=MAX_ATTEMPTS)return result(row,'incomplete','Не получено актуальное подтверждение содержимого выбранного чата.');pending.nextAt=now()+500;return persist({delay:500});}
      if(proof.status==='loading'){pending.nextAt=now()+Math.max(1100,delay(proof.retryAfterMs));return persist({delay:Math.max(1100,delay(proof.retryAfterMs))});}
      const assessment=assessWechatAuditConversation(row,contact,{now:now(),openedAt:pending.openedAt,runStartedAt:audit.startedAt,proof});
      if(['found','not_found','older'].includes(assessment.status))return result(row,assessment.status,assessment.detail,assessment);
      // Virtual histories can replace one fixed-size page with another without
      // changing its message count. Only the reader's content digest (never a
      // new observation timestamp or action token) establishes that progress.
      const historyProgress=typeof proof.historyProgress==='string'&&proof.historyProgress.length<=200?proof.historyProgress:'';
      const fingerprint=JSON.stringify([historyProgress,proof.checkedMessages,proof.fullHistory,proof.reason]);
      if(pending.lastProgress!==fingerprint){pending.lastProgress=fingerprint;pending.historyAttempts=0;}
      if(proof.reason==='history_start_missing'){pending.phase='history_start';return persist({delay:250});}
      if(proof.reason==='history_tail_missing'){pending.phase='history_tail';return persist({delay:250});}
      return result(row,'incomplete',assessment.detail,assessment);
    }
    // Do not reuse cached positive evidence or legacy reply eligibility. Each
    // row receives exactly one fresh result in this finite run, in native order.
    const row=rows.find(row=>{const key=keyOf(name,row);return !key||!own(audit.records,key)||audit.records[key].runId!==runId;});
    if(row){
      const key=keyOf(name,row);
      if(!key||row.identityReliable!==true||!Number.isInteger(row.listOrder))return block('Не подтверждены адресат или порядок очередной строки. Чаты ниже неё пока не проверяются.');
      const last=knownTime(row);
      if(last!==null&&now()-last>DAY)return result(row,'older','Последнее сообщение старше 24 часов; чат вне периода проверки.');
      const position=row.listOrder+1;
      if(row.selectionBusy)return block('Нельзя открыть следующий чат во время работы пользователя или при наличии черновика.');
      if(!row.active&&(!row.canSelect||!row.selectionToken))return result({...row,position},'error','Не удалось получить подтверждённую кнопку открытия этого чата.');
      progress.pending={key,id:row.id,title:row.title||'',url:row.url||'',position,latestMessageAt:row.latestMessageAt,latestMessageAtReliable:row.latestMessageAtReliable===true,frameId:row.frameId,documentToken:row.documentToken,sourceUrl:row.sourceUrl,startedAt:now(),openedAt:row.active?now():null,attempts:0,phase:row.active?'check':'opening',historyAttempts:0,nextAt:0,lastProgress:''};
      if(row.active){note('audit_reading','Проверяю уже открытый чат заново в текущем проходе.',key);return persist({delay:250});}
      note('audit_opening','Открываю следующий чат по порядку списка.',key);
      try{const reply=await send(row,{type:'DIALOGS_OPEN_CONVERSATION',conversationId:row.id,selectionToken:row.selectionToken});if(stopped())return null;if(reply?.busy||reply?.status==='busy')return block('Переключение чата остановлено: пользователь работает в нём или есть черновик.');if(reply?.ok===false)return result({...row,position},'error',reply.detail||'Не удалось открыть чат.');}
      catch{note('audit_opening','Подтверждение открытия потеряно; проверю выбранный чат без повторного клика.',key);}
      return persist({delay:250});
    }
    if(coverage.complete===true&&coverage.hasMore===false){
      const incomplete=Object.values(audit.records).filter(record=>record.runId===runId&&record.platform===name&&['incomplete','error'].includes(record.status));
      if(incomplete.length)return block(`Список площадки просмотрен, но ${incomplete.length} чатов не проверены полностью. Результаты указаны в отчёте; следующая площадка не запущена.`);
      Object.assign(audit.platforms[name],{phase:'completed',checkedAt:now(),detail:'Список чатов прочитан полностью. Результаты проверки сохранены.'});audit.cursor++;audit.progress=initialWechatAudit().progress;
      if(audit.cursor>=WECHAT_AUDIT_PLATFORMS.length){audit.phase='completed';audit.finishedAt=now();audit.blockedReason='';state.running=false;note('audit_completed','Проверка всех трёх площадок завершена. Отчёт готов.');await save(state);return null;}
      audit.platforms[WECHAT_AUDIT_PLATFORMS[audit.cursor]].phase='running';note('audit_platform_complete','Площадка проверена полностью. Перехожу к следующей.');return persist({delay:250});
    }
    if(coverage.hasMore!==true)return block('Конец полного списка чатов не подтверждён. Проверка этой площадки не завершена.');
    const fingerprint=coverage.progressToken||JSON.stringify(rows.map(row=>[row.id,row.listOrder]));
    if(progress.listProgress&&progress.listProgress===fingerprint)progress.listStalls++;else progress.listStalls=0;
    progress.listProgress=fingerprint;
    if(progress.listStalls>=MAX_ATTEMPTS)return block('Список чатов не продвигается после 8 попыток. Проверка этой площадки не завершена.');
    note('audit_list','Загружаю следующую часть списка чатов текущей площадки.');
    try{const reply=await send(source,{type:'DIALOGS_ADVANCE_LIST',listToken:coverage.token});if(stopped())return null;if(reply?.busy||reply?.status==='busy')return block('Прокрутка списка остановлена из-за работы пользователя в чате.');if(reply?.ok!==true&&reply?.status!=='loading')return block(reply?.detail||'Не удалось загрузить следующую часть списка чатов.');if(reply?.status==='loading')progress.listStalls=Math.max(0,progress.listStalls-1);progress.nextAt=now()+delay(reply?.retryAfterMs);}
    catch{return block('Не получено подтверждение подгрузки списка чатов. Проверка остановлена на текущей площадке.');}
    return persist({delay:delay(progress.nextAt-now())});
  }
  return {step};
}
