import {draftRequest} from './lib/dialogs.js';
import {withTabOwnership} from './lib/tab-ownership.js';
import {activate1688} from './lib/native-input.js';

const domains={'1688':'1688.com',alibaba:'alibaba.com',mic:'made-in-china.com'};
const REQUEST_FIELDS=['key','revision','fingerprint','settingsFingerprint','productFingerprint'];
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
export async function sendDialogReply({api=globalThis.chrome,state,request,text,source,profile={},enabled=false,reserve,shouldContinue=()=>true,now=()=>Date.now(),wait=sleep,activate=activate1688,timeoutMs=10000}={}) {
  if(enabled!==true)return blocked('Автоматическая отправка выключена.');
  if(typeof reserve!=='function')return blocked('Нет сохранения попытки и общего лимита отправки.');
  if(typeof text!=='string' || !text.trim() || text.length>6000)return blocked('Ответ должен содержать от 1 до 6000 символов.');
  if(!Number.isInteger(source?.tabId) || source.tabId<0 || !Number.isInteger(source?.frameId) || source.frameId<0 || typeof source.documentToken!=='string' || !source.documentToken || typeof source.replyFingerprint!=='string' || !source.replyFingerprint)return blocked('Не подтверждён текущий документ переписки.');
  let attemptId,invoked=false,reserved=false;
  try {
      const assertCurrent=async()=>{
        if(await shouldContinue()!==true)throw new Error('Задание остановлено или изменилось.');
        if(state?.running!==true)throw new Error('Мониторинг остановлен.');
        const current=draftRequest(state,request?.key);
        if(REQUEST_FIELDS.some(field=>current[field]!==request[field]))throw new Error('История, товар или правила изменились. Ответ не отправлен.');
        const item=state.conversations[current.key];
        if(state.bindings?.[item.platform]?.tabId!==source.tabId || !samePlatform(source.sourceUrl,item.platform))throw new Error('Привязка вкладки или площадка изменились.');
        return item;
      };
      const item=await assertCurrent(),platform=item.platform;
      attemptId=crypto.randomUUID();
      // The shared quota callback runs in the outreach worker's command queue.
      // Reserve BEFORE acquiring tab ownership: that queue can itself be waiting
      // for this tab, so the opposite lock order would deadlock. No editor action
      // has happened; every live condition is revalidated inside the tab lock.
      const reservation=await reserve({attemptId,platform,key:request.key,request,source,text,at:now()});
      if(reservation?.ok!==true)return {status:reservation?.retryAt?'deferred':'blocked',clicked:false,reason:reservation?.reason || 'Попытка или общий лимит отправки не сохранены.',...(Number.isFinite(reservation?.retryAt)?{retryAt:reservation.retryAt}:{})};
      reserved=true;
      return await withTabOwnership(source.tabId,async()=>{
      const guard={platform,id:item.id,documentToken:source.documentToken,sourceUrl:source.sourceUrl,replyFingerprint:source.replyFingerprint,operation:attemptId};
      const job={id:attemptId,tabId:source.tabId,frameId:source.frameId,platform,message:text,profile};
      const call=async(_job,frameId,type,extra={})=>{
        if(!(type==='NATIVE_INPUT' && extra.stage==='release'))await assertCurrent();
        return bounded(api.tabs.sendMessage(source.tabId,{type,jobId:attemptId,message:text,profile,dialogGuard:guard,...extra},{frameId}),timeoutMs);
      };
      const checkSnapshot=async({initial=false}={})=>{
        await assertCurrent();
        const tab=await bounded(api.tabs.get(source.tabId),timeoutMs);
        if(tab.status==='loading' || tab.pendingUrl || !samePlatform(tab.url,platform))throw new Error('Вкладка чата ещё загружается или адрес изменился.');
        const snapshot=await bounded(api.tabs.sendMessage(source.tabId,{type:'DIALOGS_SNAPSHOT'},{frameId:source.frameId}),timeoutMs);
        const active=Array.isArray(snapshot?.conversations)?snapshot.conversations.filter(row=>row.active):[];
        if(snapshot?.status!=='ready' || snapshot.platform!==platform || snapshot.url!==source.sourceUrl || snapshot.documentToken!==source.documentToken || active.length!==1 || active[0].id!==item.id || active[0].identityReliable!==true || active[0].replyFingerprint!==source.replyFingerprint)throw new Error('Получатель, документ или история изменились. Ответ не отправлен.');
        const row=active[0];
        if((row.historyOrderReliable??row.orderReliable)!==true || (row.historyTailKnown??row.tailKnown)!==true || !Array.isArray(row.messages) || row.messages.some(message=>message.direction==='unknown') || row.messages.filter(message=>message.direction!=='system').at(-1)?.direction!=='inbound')throw new Error('Последнее входящее сообщение и порядок истории не подтверждены.');
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
        if(!readiness?.ok)return {...blocked(readiness?.reason || 'Редактор 1688 ещё не готов.'),attemptId,reserved:true};
        await checkSnapshot({initial:true});
      }
      await assertCurrent();
      let prepared=await call(job,job.frameId,'PREPARE');
      if(platform==='1688' && prepared?.needsNativeInput) {
        await activate({...job,inputUrl:prepared.pageUrl},call,api.debugger);
        prepared=await call(job,job.frameId,'PREPARE');
      }
      if(!prepared?.ok || prepared.pageUrl!==source.sourceUrl)return {...blocked(prepared?.reason || 'Редактор или кнопка отправки не готовы.'),attemptId,reserved:true};
      await checkSnapshot();
      await assertCurrent();
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
      return {...blocked(typeof error?.message==='string' && /^[А-ЯЁ]/u.test(error.message)?error.message:'Не удалось безопасно подготовить ответ. Проверьте вкладку чата.'),...(reserved?{attemptId,reserved:true}:{})};
  }
}
