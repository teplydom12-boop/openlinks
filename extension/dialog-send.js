import {draftRequest,contactAssessment} from './lib/dialogs.js';
import {withTabOwnership} from './lib/tab-ownership.js';
import {activate1688} from './lib/native-input.js';

const domains={'1688':'1688.com',alibaba:'alibaba.com',mic:'made-in-china.com'};
const REQUEST_FIELDS=['key','revision','fingerprint','settingsFingerprint','productFingerprint','purpose'];
function samePlatform(url,platform) {
  try {const parsed=new URL(url),domain=domains[platform];return !!domain && parsed.protocol==='https:' && !parsed.username && !parsed.password && !parsed.port && (parsed.hostname===domain || parsed.hostname.endsWith('.'+domain));}catch{return false;}
}
const blocked=reason=>({status:'blocked',clicked:false,reason});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const busy=value=>value===true || (value && typeof value==='object' && Object.values(value).some(flag=>flag===true));
async function bounded(promise,ms) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Связь с вкладкой не ответила вовремя.')),ms);})]);}
  finally{clearTimeout(timer);}
}

/**
 * Reply only to an already selected, bound conversation. The caller owns the
 * monitor state queue and supplies a durable quota+attempt reservation callback.
 * Never opens/selects/closes a tab, retries a click, or claims server delivery.
 * A lost SEND response is terminal "unknown" even when the transport failed
 * before Chrome could acknowledge the command.
 */
export async function sendDialogReply({api=globalThis.chrome,state,request,text,source,profile={},enabled=false,reserve,dryRun=false,previewOperation,reservePreview,shouldContinue=()=>true,now=()=>Date.now(),wait=sleep,activate=activate1688,timeoutMs=10000}={}) {
  if(enabled!==true)return blocked('Автоматическая отправка выключена.');
  if(dryRun ? typeof reservePreview!=='function'||typeof previewOperation!=='string'||!previewOperation : typeof reserve!=='function')return blocked(dryRun?'Нет сохранения тестового цикла перед заполнением.':'Нет сохранения попытки и общего лимита отправки.');
  if(typeof text!=='string' || !text.trim() || text.length>6000)return blocked('Ответ должен содержать от 1 до 6000 символов.');
  if(!Number.isInteger(source?.tabId) || source.tabId<0 || !Number.isInteger(source?.frameId) || source.frameId<0 || typeof source.documentToken!=='string' || !source.documentToken || typeof source.replyFingerprint!=='string' || !source.replyFingerprint)return blocked('Не подтверждён текущий документ переписки.');
  let attemptId,invoked=false,reserved=false,cleanupToken;
  const metadata=()=>({attemptId,reserved,...(dryRun?{preview:true,clicked:false,cleanupToken}: {})});
  try {
      const assertCurrent=async()=>{
        if(await shouldContinue()!==true)throw new Error('Задание остановлено или изменилось.');
        if(state?.running!==true)throw new Error('Мониторинг остановлен.');
        const current=draftRequest(state,request?.key);
        if(REQUEST_FIELDS.some(field=>current[field]!==request[field]))throw new Error('История, товар или правила изменились. Ответ не отправлен.');
        if(current.purpose==='wechat'&&!dryRun)throw new Error('Приглашение в WeChat из прочитанного чата пока доступно только в тестовом режиме без отправки.');
        const item=state.conversations[current.key];
        if(state.bindings?.[item.platform]?.tabId!==source.tabId || !samePlatform(source.sourceUrl,item.platform))throw new Error('Привязка вкладки или площадка изменились.');
        return item;
      };
      const item=await assertCurrent(),platform=item.platform;
      attemptId=dryRun?previewOperation:crypto.randomUUID();
      const guard={platform,id:item.id,documentToken:source.documentToken,sourceUrl:source.sourceUrl,replyFingerprint:source.replyFingerprint,operation:attemptId};
      if(request.purpose==='wechat')guard.purpose='wechat';
      if(dryRun)cleanupToken={operation:attemptId,platform,id:item.id,documentToken:source.documentToken,sourceUrl:source.sourceUrl,text};
      // The shared quota callback runs in the outreach worker's command queue.
      // Reserve BEFORE acquiring tab ownership: that queue can itself be waiting
      // for this tab, so the opposite lock order would deadlock. No editor action
      // has happened; every live condition is revalidated inside the tab lock.
      const reservation=dryRun?await reservePreview({attemptId,cleanupToken}):await reserve({attemptId,platform,key:request.key,request,source,text,at:now()});
      if(reservation?.ok!==true)return {status:reservation?.retryAt?'deferred':'blocked',clicked:false,reason:reservation?.reason || 'Попытка или общий лимит отправки не сохранены.',...(Number.isFinite(reservation?.retryAt)?{retryAt:reservation.retryAt}:{})};
      reserved=!dryRun;
      return await withTabOwnership(source.tabId,async()=>{
      const job={id:attemptId,tabId:source.tabId,frameId:source.frameId,platform,message:text,profile};
      const call=async(_job,frameId,type,extra={})=>{
        if(dryRun&&type==='SEND')throw new Error('Тестовый цикл не имеет права отправлять сообщения.');
        if(!(type==='NATIVE_INPUT' && extra.stage==='release'))await assertCurrent();
        return bounded(api.tabs.sendMessage(source.tabId,{type,jobId:attemptId,message:text,profile,dialogGuard:guard,...extra,...(dryRun?{dialogPreview:true}:{})},{frameId}),timeoutMs);
      };
      const checkSnapshot=async({initial=false}={})=>{
        await assertCurrent();
        const tab=await bounded(api.tabs.get(source.tabId),timeoutMs);
        if(tab.status==='loading' || tab.pendingUrl || !samePlatform(tab.url,platform))throw new Error('Вкладка чата ещё загружается или адрес изменился.');
        const snapshot=await bounded(api.tabs.sendMessage(source.tabId,{type:'DIALOGS_SNAPSHOT'},{frameId:source.frameId}),timeoutMs);
        const active=Array.isArray(snapshot?.conversations)?snapshot.conversations.filter(row=>row.active):[];
        if(snapshot?.status!=='ready' || snapshot.platform!==platform || snapshot.url!==source.sourceUrl || snapshot.documentToken!==source.documentToken || active.length!==1 || active[0].id!==item.id || active[0].identityReliable!==true || active[0].replyFingerprint!==source.replyFingerprint)throw new Error('Получатель, документ или история изменились. Ответ не отправлен.');
        const row=active[0];
        const lastDirection=row.messages?.filter(message=>message.direction!=='system').at(-1)?.direction;
        const contactPreview=dryRun&&request.purpose==='wechat';
        if((row.historyOrderReliable??row.orderReliable)!==true || (row.historyTailKnown??row.tailKnown)!==true || !Array.isArray(row.messages) || row.messages.some(message=>message.direction==='unknown') || !(contactPreview?['inbound','outbound'].includes(lastDirection):lastDirection==='inbound'))throw new Error('Последние сообщения и порядок истории не подтверждены.');
        if(contactPreview) {
          const fresh={...item,...row,archivedMessages:item.archivedMessages,coverage:row.coverage??item.coverage};
          if(contactAssessment(state,fresh).status!=='not_found')throw new Error('Проверка истории WeChat изменилась. Проверьте диалог перед подготовкой тестового приглашения.');
        }
        if(initial && busy(snapshot.busy))throw new Error('В чате есть ручной черновик или пользователь работает с редактором.');
        await assertCurrent();
      };
      await checkSnapshot({initial:true});
      if(platform==='1688') {
        let readiness;
        // The 1688 composer needs a stable loaded editor before native input.
        // Bounded waiting happens only before text insertion, never after click.
        for(let index=0;index<61;index++) {
          readiness=await call(job,job.frameId,'CHAT_READY');
          if(readiness?.ok || !readiness?.waiting)break;
          if(index===60)break;
          await wait(Math.min(1000,Math.max(100,readiness.waitMs || 1000)));
        }
        if(!readiness?.ok)return {...blocked(readiness?.reason || 'Редактор 1688 ещё не готов.'),...metadata()};
        await checkSnapshot({initial:true});
      }
      await assertCurrent();
      let prepared=await call(job,job.frameId,'PREPARE');
      if(platform==='1688' && prepared?.needsNativeInput) {
        await activate({...job,inputUrl:prepared.pageUrl},call,api.debugger);
        prepared=await call(job,job.frameId,'PREPARE');
      }
      if(!prepared?.ok || prepared.pageUrl!==source.sourceUrl || dryRun&&prepared.preview!==true)return {...blocked(prepared?.reason || 'Редактор или кнопка отправки не готовы.'),...metadata()};
      await checkSnapshot();
      await assertCurrent();
      if(dryRun)return {status:'previewed',...metadata(),reason:'Тестовый ответ подготовлен в поле чата. Отправка не выполнялась.'};
      // The content handler checks guardReply synchronously again before click,
      // including recipient, exact history/attachments, editor and exact draft.
      invoked=true;
      const result=await call(job,job.frameId,'SEND',{expectedUrl:source.sourceUrl,attemptId});
      if(result?.clicked===false)return {...blocked(result.reason || 'Отправка остановлена до нажатия.'),attemptId,reserved:true};
      if(result?.clicked!==true)return {status:'unknown',attemptId,reserved:true,reason:'Неизвестно, сработала ли отправка. Автоматический повтор запрещён.'};
      if(platform==='1688' && result.accepted!==true)return {status:'unknown',attemptId,reserved:true,clicked:true,reason:result.reason || 'Редактор 1688 не подтвердил очистку после нажатия. Автоматический повтор запрещён.'};
      return {status:'attempted',attemptId,reserved:true,clicked:true,accepted:result.accepted===true,reason:'Кнопка отправки нажата. Доставка и прочтение не проверяются.'};
      });
  } catch(error) {
      if(invoked)return {status:'unknown',attemptId,reserved,reason:'Связь потеряна после начала отправки. Автоматический повтор запрещён.'};
      return {...blocked(typeof error?.message==='string' && /^[А-ЯЁ]/u.test(error.message)?error.message:'Не удалось безопасно подготовить ответ. Проверьте вкладку чата.'),...(attemptId?metadata():{})};
  }
}

const cleanupBlocked=reason=>({status:'blocked',cleared:false,reason});
const cleanupUnknown=()=>({status:'unknown',cleared:false,reason:'Не удалось подтвердить очистку тестового черновика. Проверьте вкладку.'});
function validCleanupSource(source,token) {
  return Number.isInteger(source?.tabId)&&source.tabId>=0&&Number.isInteger(source?.frameId)&&source.frameId>=0&&token&&typeof token.operation==='string'&&!!token.operation&&typeof token.text==='string'&&!!token.text.trim()&&token.text.length<=6000&&typeof token.id==='string'&&!!token.id&&typeof token.documentToken==='string'&&!!token.documentToken&&samePlatform(token.sourceUrl,token.platform)&&source.sourceUrl===token.sourceUrl;
}
// Runs under tab ownership. This path only reads: a refreshed document token
// can prove an empty composer, but can never authorize deletion in that document.
async function recoverEmptyPreview({api,source,token,shouldContinue,timeoutMs}) {
  if(await shouldContinue()!==true)return cleanupBlocked('Проверка тестового черновика остановлена.');
  try {
    const tab=await bounded(api.tabs.get(source.tabId),timeoutMs);
    if(tab.status==='loading'||tab.pendingUrl||!samePlatform(tab.url,token.platform))return cleanupBlocked('Вкладка изменилась или ещё загружается.');
    if(await shouldContinue()!==true)return cleanupBlocked('Проверка тестового черновика остановлена.');
    const snapshot=await bounded(api.tabs.sendMessage(source.tabId,{type:'DIALOGS_SNAPSHOT'},{frameId:source.frameId}),timeoutMs);
    const active=Array.isArray(snapshot?.conversations)?snapshot.conversations.filter(row=>row.active):[];
    if(snapshot?.status!=='ready'||snapshot.platform!==token.platform||snapshot.url!==token.sourceUrl||typeof snapshot.documentToken!=='string'||!snapshot.documentToken||active.length!==1||active[0].id!==token.id||active[0].identityReliable!==true)return cleanupBlocked('Получатель или документ для проверки пустого поля не подтверждён.');
    if(await shouldContinue()!==true)return cleanupBlocked('Проверка тестового черновика остановлена.');
    const guard={platform:token.platform,id:token.id,sourceUrl:token.sourceUrl,documentToken:snapshot.documentToken};
    const result=await bounded(api.tabs.sendMessage(source.tabId,{type:'DIALOGS_CHECK_PREVIEW_EMPTY',guard},{frameId:source.frameId}),timeoutMs);
    if(await shouldContinue()!==true)return cleanupBlocked('Проверка тестового черновика остановлена.');
    if(result?.empty===true)return {status:'cleared',cleared:true,recovered:true,reason:'Поле того же собеседника уже пустое. Ничего не удалялось и не отправлялось.'};
    if(result?.empty===false)return cleanupBlocked(result.reason||'В поле есть текст или вложение. Очистите его вручную.');
    return cleanupUnknown();
  }catch{return cleanupUnknown();}
}

/** Read-only recovery also accepts an explicitly rebound source after restart.
 * The old token's exact recipient and URL remain mandatory; never clears text. */
export async function recoverDialogTestDraftEmpty({api=globalThis.chrome,source,token,shouldContinue=()=>true,timeoutMs=10000}={}) {
  if(!validCleanupSource(source,token))return cleanupBlocked('Не подтверждён получатель тестового черновика.');
  try{return await withTabOwnership(source.tabId,()=>recoverEmptyPreview({api,source,token,shouldContinue,timeoutMs}));}
  catch{return cleanupUnknown();}
}

/** Clean only a content-script-owned preview. Changed history is allowed.
 * A changed document can only recover through a read-only empty-field check. */
export async function clearDialogTestDraft({api=globalThis.chrome,source,token,shouldContinue=()=>true,timeoutMs=10000}={}) {
  if(!validCleanupSource(source,token)||source.documentToken!==token.documentToken)return cleanupBlocked('Не подтверждено владение тестовым черновиком.');
  try {
    return await withTabOwnership(source.tabId,async()=>{
      if(await shouldContinue()!==true)return cleanupBlocked('Очистка тестового черновика остановлена.');
      let tab;
      try{tab=await bounded(api.tabs.get(source.tabId),timeoutMs);}
      catch {
        // A transport error is not evidence of closure. Only a successful,
        // well-formed full tab query can retire authority for an absent tab.
        try {
          if(await shouldContinue()!==true)return cleanupBlocked('Очистка тестового черновика остановлена.');
          const tabs=await bounded(api.tabs.query({}),timeoutMs);
          if(await shouldContinue()!==true)return cleanupBlocked('Очистка тестового черновика остановлена.');
          if(Array.isArray(tabs)&&tabs.every(row=>Number.isInteger(row?.id)&&row.id>=0)&&!tabs.some(row=>row.id===source.tabId))return {status:'cleared',cleared:true,recovered:true,closed:true,reason:'Тестовая вкладка закрыта. Текст в других вкладках не изменялся.'};
        }catch{}
        return cleanupUnknown();
      }
      if(tab.status==='loading'||tab.pendingUrl||!samePlatform(tab.url,token.platform)||await shouldContinue()!==true)return cleanupBlocked('Вкладка изменилась или очистка остановлена.');
      let original=cleanupUnknown();
      try {
        const result=await bounded(api.tabs.sendMessage(source.tabId,{type:'DIALOGS_CLEAR_PREVIEW',token},{frameId:source.frameId}),timeoutMs);
        if(result?.cleared===true)return {status:'cleared',cleared:true,reason:'Тестовый черновик очищен. Сообщение не отправлялось.'};
        if(result?.cleared===false)original=cleanupBlocked(result.reason||'Тестовый черновик изменён. Очистите его вручную.');
      }catch{}
      const recovered=await recoverEmptyPreview({api,source,token,shouldContinue,timeoutMs});
      if(recovered.cleared)return recovered;
      return original.status==='unknown'?{...recovered,status:'unknown'}:recovered;
    });
  }catch{return cleanupUnknown();}
}
