// A finite, read-only WeChat audit. This state deliberately does not reuse reply
// eligibility, legacy contact evidence, or cached per-chat workflow results.
export const WECHAT_AUDIT_PLATFORMS = Object.freeze(['1688','alibaba','mic']);
export const WECHAT_AUDIT_LIMITS = Object.freeze({records:2000,bytes:2*1024*1024});
const phases=new Set(['idle','running','paused','blocked','completed']);
const platformPhases=new Set(['pending','running','blocked','completed']);
const statuses=new Set(['found','not_found','older','incomplete','error']);
const obj=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const clean=(value,max=1000)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max):'';
const stamp=value=>Number.isFinite(value)&&typeof value==='number'&&value>=0&&value<=8640000000000000?value:null;
const int=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0?Math.min(value,max):0;
const has=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const platformOK=value=>WECHAT_AUDIT_PLATFORMS.includes(value);
const digest=text=>{let a=2166136261,b=2246822507;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),3266489909);}return `${(a>>>0).toString(16)}${(b>>>0).toString(16)}:${text.length}`;};
const normalizedContact=value=>typeof value==='string'?value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g,'').toLowerCase():'';
export function wechatContactFingerprint(contact){const normalized=normalizedContact(contact).trim();return normalized?digest(normalized):'';}
export function textContainsWechatContact(text,contact){
  const needle=normalizedContact(contact).trim(),haystack=normalizedContact(text);if(!needle)return false;
  let at=haystack.indexOf(needle);
  while(at!==-1){const before=haystack[at-1]||'',after=haystack[at+needle.length]||'';if(!/[a-z0-9_-]/i.test(before)&&!/[a-z0-9_-]/i.test(after))return true;at=haystack.indexOf(needle,at+1);}
  return false;
}
function auditURL(value,platform){
  const domain={'1688':'1688.com',alibaba:'alibaba.com',mic:'made-in-china.com'}[platform];
  try{if(typeof value!=='string'||value.length>4096)return '';const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||!domain||!(url.hostname===domain||url.hostname.endsWith('.'+domain)))return '';
    const routing=new Set(['touid','siteid','threadId','thread_id','conversationId','conversation_id','peerId','toUserId']);for(const name of [...url.searchParams.keys()])if(!routing.has(name))url.searchParams.delete(name);if(!/^#\/[a-z0-9/_-]{0,200}$/i.test(url.hash))url.hash='';return url.href;
  }catch{return '';}
}
function validKey(key,platform){return typeof key==='string'&&key.length<=1600&&key.startsWith(platform+':')&&key.length>platform.length+1&&!/[\u0000-\u001f]/.test(key);}
function initialProgress(){return {positioned:false,nextAt:0,listProgress:'',listStalls:0,startAttempts:0,startedAt:null,waitingSince:null,documentToken:'',frameId:null,sourceUrl:'',pending:null};}
export function initialWechatAudit(){return {version:1,runId:'',phase:'idle',cursor:0,startedAt:null,finishedAt:null,pausedAt:null,contactFingerprint:'',blockedReason:'',records:{},platforms:Object.fromEntries(WECHAT_AUDIT_PLATFORMS.map(platform=>[platform,{phase:'pending',checkedAt:null,detail:''}])),progress:initialProgress(),bytes:2,saturated:false,discardedRecords:0};}
function normalizeProgress(value){
  const input=obj(value),result={positioned:input.positioned===true,nextAt:stamp(input.nextAt)??0,listProgress:clean(input.listProgress,40000),listStalls:int(input.listStalls,1000),startAttempts:int(input.startAttempts,10),startedAt:stamp(input.startedAt),waitingSince:stamp(input.waitingSince),documentToken:clean(input.documentToken,200),frameId:Number.isSafeInteger(input.frameId)&&input.frameId>=0?input.frameId:null,sourceUrl:auditURL(input.sourceUrl,WECHAT_AUDIT_PLATFORMS.find(platform=>auditURL(input.sourceUrl,platform))),pending:null};
  const pending=obj(input.pending),platform=clean(pending.key,1600).split(':')[0];
  if(platformOK(platform)&&validKey(pending.key,platform)&&typeof pending.id==='string'&&pending.id.length&&pending.id.length<=512){
    result.pending={key:pending.key,id:clean(pending.id,512),title:clean(pending.title,300),url:auditURL(pending.url,platform),position:int(pending.position,1000000000),latestMessageAt:stamp(pending.latestMessageAt),latestMessageAtReliable:pending.latestMessageAtReliable===true&&stamp(pending.latestMessageAt)!==null,frameId:Number.isSafeInteger(pending.frameId)&&pending.frameId>=0?pending.frameId:null,documentToken:clean(pending.documentToken,200),sourceUrl:auditURL(pending.sourceUrl,platform),startedAt:stamp(pending.startedAt),openedAt:stamp(pending.openedAt),attempts:int(pending.attempts,1000),phase:clean(pending.phase,80),historyAttempts:int(pending.historyAttempts,1000),nextAt:stamp(pending.nextAt)??0,lastProgress:clean(pending.lastProgress,40000)};
  }
  return result;
}
function normalizeRecord(raw,audit,keyOverride){
  const input=obj(raw),platform=input.platform,key=keyOverride??input.key;
  if(!platformOK(platform)||!validKey(key,platform)||!statuses.has(input.status)||input.runId!==audit.runId)return null;
  let id=clean(input.id,512);if(!id){try{id=decodeURIComponent(key.slice(platform.length+1));}catch{return null;}}
  if(!id||id.length>512||/[\u0000-\u001f]/.test(id)||key!==platform+':'+encodeURIComponent(id))return null;
  const result={runId:audit.runId,platform,key,id,title:clean(input.title,300),url:auditURL(input.url,platform),position:int(input.position,1000000000),checkedAt:stamp(input.checkedAt),lastMessageAt:stamp(input.lastMessageAt),status:input.status,detail:clean(input.detail,1200)};
  if(input.status==='found'){if(['inbound','outbound','unknown','system'].includes(input.matchDirection))result.matchDirection=input.matchDirection;if(typeof input.matchMessageKey==='string')result.matchMessageKey=clean(input.matchMessageKey,1600);}
  return result;
}
function capacityBlocked(audit){audit.saturated=true;audit.phase='blocked';audit.finishedAt=null;audit.pausedAt=null;audit.blockedReason=audit.discardedRecords?'Превышен предел отчёта (2000 чатов или 2 МиБ). Не загружено записей: '+audit.discardedRecords+'. Проверка не завершена.':'Достигнут предел отчёта (2000 чатов или 2 МиБ). Проверка остановлена; сохранённые результаты не удалены.';return audit;}
export function normalizeWechatAudit(value){
  const input=obj(value),result=initialWechatAudit();result.runId=clean(input.runId,200);result.phase=phases.has(input.phase)?input.phase:'idle';result.cursor=int(input.cursor,3);result.startedAt=stamp(input.startedAt);result.finishedAt=stamp(input.finishedAt);result.pausedAt=result.phase==='paused'?stamp(input.pausedAt):null;result.contactFingerprint=/^[a-f0-9]{1,16}:\d{1,6}$/.test(input.contactFingerprint||'')?input.contactFingerprint:'';result.blockedReason=clean(input.blockedReason,1200);result.progress=normalizeProgress(input.progress);result.saturated=input.saturated===true;result.discardedRecords=int(input.discardedRecords,1000000000);
  if(!result.runId){result.phase='idle';result.startedAt=null;result.finishedAt=null;result.pausedAt=null;result.cursor=0;result.progress=initialProgress();return result;}
  for(const platform of WECHAT_AUDIT_PLATFORMS){const source=obj(obj(input.platforms)[platform]);result.platforms[platform]={phase:platformPhases.has(source.phase)?source.phase:'pending',checkedAt:stamp(source.checkedAt),detail:clean(source.detail,1200)};}
  for(const [key,raw] of Object.entries(obj(input.records))){const record=normalizeRecord(raw,result,key);if(!record)continue;const nextBytes=result.bytes+bytes([key,record])+1;if(Object.keys(result.records).length>=WECHAT_AUDIT_LIMITS.records||nextBytes>WECHAT_AUDIT_LIMITS.bytes){result.discardedRecords++;capacityBlocked(result);continue;}result.records[key]=record;result.bytes=nextBytes;}
  if(result.saturated)capacityBlocked(result);
  if(!result.contactFingerprint&&result.phase!=='idle'){result.phase='blocked';result.blockedReason='Не задан WeChat ID для этой проверки.';result.finishedAt=null;}
  // A truncated or unfinished platform must never look like a successful pass.
  if(result.phase==='completed'&&(result.cursor!==3||WECHAT_AUDIT_PLATFORMS.some(platform=>result.platforms[platform].phase!=='completed')||Object.values(result.records).some(record=>['incomplete','error'].includes(record.status)))){result.phase='blocked';result.finishedAt=null;result.blockedReason=result.blockedReason||'Проверка не завершена: остались непроверенные чаты или площадки.';}
  return result;
}
export function startWechatAudit(previous,contact,now=Date.now(),runId=''){
  const contactFingerprint=wechatContactFingerprint(contact);if(!contactFingerprint)throw new Error('Укажите свой WeChat ID перед проверкой.');
  const audit=initialWechatAudit();audit.runId=clean(runId,200)||`${stamp(now)??Date.now()}-${globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)}`;audit.phase='running';audit.startedAt=stamp(now)??Date.now();audit.contactFingerprint=contactFingerprint;audit.platforms['1688'].phase='running';return audit;
}
export function pauseWechatAudit(audit,now=Date.now()){
  if(audit.phase==='running'){audit.phase='paused';audit.finishedAt=null;audit.pausedAt=stamp(now)??Date.now();}return audit;
}
export function resumeWechatAudit(audit,contact,now=Date.now()){
  if(audit.saturated)return capacityBlocked(audit);
  if(!audit.runId||audit.phase==='idle'||audit.phase==='completed')throw new Error('Начните новую проверку WeChat.');
  if(!wechatContactFingerprint(contact)||wechatContactFingerprint(contact)!==audit.contactFingerprint){audit.phase='blocked';audit.pausedAt=null;audit.blockedReason='WeChat ID изменён. Начните новую проверку, чтобы результаты относились к одному ID.';return audit;}
  if(audit.phase==='paused'&&stamp(audit.pausedAt)!==null){
    // Pausing consumes no reader timeout budget. Keep the original amount of
    // work time already spent instead of granting a fresh deadline each time.
    const elapsed=Math.max(0,(stamp(now)??Date.now())-audit.pausedAt);
    const shift=(target,key,{zeroIsSentinel=false}={})=>{const value=stamp(target?.[key]);if(value!==null&&(!zeroIsSentinel||value>0))target[key]=Math.min(8640000000000000,value+elapsed);};
    shift(audit.progress,'startedAt');shift(audit.progress,'waitingSince');shift(audit.progress,'nextAt',{zeroIsSentinel:true});
    shift(audit.progress?.pending,'startedAt');shift(audit.progress?.pending,'nextAt',{zeroIsSentinel:true});
  }
  if(audit.phase==='blocked'){
    const platform=WECHAT_AUDIT_PLATFORMS[audit.cursor];
    for(const [key,record] of Object.entries(audit.records))if(record.platform===platform&&['incomplete','error'].includes(record.status))delete audit.records[key];
    audit.bytes=2+Object.entries(audit.records).reduce((sum,pair)=>sum+bytes(pair)+1,0);audit.progress=initialProgress();
    if(platform)audit.platforms[platform]={phase:'running',checkedAt:stamp(now)??Date.now(),detail:'Повторная проверка незавершённых чатов.'};
  }
  audit.phase='running';audit.blockedReason='';audit.finishedAt=null;audit.pausedAt=null;return audit;
}
export function recordWechatAuditResult(audit,result,context,now=Date.now()){
  if(audit.phase!=='running')return {accepted:false,reason:'not_running',record:null};
  if(!context||context.runId!==audit.runId)return {accepted:false,reason:'stale_run',record:null};
  if(!wechatContactFingerprint(context.contact)||wechatContactFingerprint(context.contact)!==audit.contactFingerprint)return {accepted:false,reason:'changed_contact',record:null};
  const record=normalizeRecord({...obj(result),runId:audit.runId,checkedAt:stamp(now)??Date.now()},audit);if(!record)return {accepted:false,reason:'invalid_result',record:null};
  const previous=has(audit.records,record.key)?audit.records[record.key]:null;
  const projected=(audit.bytes??2)-(previous?bytes([record.key,previous])+1:0)+bytes([record.key,record])+1;
  if((!previous&&Object.keys(audit.records).length>=WECHAT_AUDIT_LIMITS.records)||projected>WECHAT_AUDIT_LIMITS.bytes){capacityBlocked(audit);return {accepted:false,reason:'capacity',record:null};}
  audit.records[record.key]=record;audit.bytes=projected;return {accepted:true,reason:'',record};
}
export function wechatAuditSummary(audit){
  const counts={total:0,found:0,not_found:0,older:0,incomplete:0,error:0};for(const record of Object.values(obj(audit?.records))){if(record.runId!==audit?.runId||!statuses.has(record.status))continue;counts.total++;counts[record.status]++;}return counts;
}
export function wechatAuditHasResult(audit,key,contact){return !!audit?.runId&&audit.contactFingerprint===wechatContactFingerprint(contact)&&has(obj(audit.records),key)&&audit.records[key].runId===audit.runId&&['found','not_found','older'].includes(audit.records[key].status);}
// The caller supplies a fresh read after opening this conversation. Neither a
// historical contact ledger nor a previous run can establish this run's result.
export function assessWechatAuditConversation(item,contact,{now=Date.now(),openedAt=null,runStartedAt=null,proof=null}={}){
  const incomplete=(detail,extra={})=>({status:'incomplete',detail,lastMessageAt:null,...extra});
  const contactFingerprint=wechatContactFingerprint(contact);if(!contactFingerprint)return incomplete('Не задан ваш WeChat ID.');
  const source=proof?obj(proof):obj(item),observedAt=stamp(proof?source.observedAt:source.lastObservedAt),minimum=Math.max(stamp(openedAt)??Infinity,stamp(runStartedAt)??0);
  if(observedAt===null||observedAt<minimum||observedAt>now+5000||source.identityReliable!==true||(!proof&&source.active!==true))return incomplete('Нужно открыть чат и прочитать его заново в текущей проверке.');
  if(proof&&(source.contactFingerprint!==contactFingerprint||source.conversationId!==item?.id))return incomplete('Результат чтения относится к другому чату или WeChat ID.');
  const tail=Array.isArray(source.messages)?source.messages.filter(message=>message?.direction!=='system').at(-1):null;
  const lastMessageAt=source.latestMessageAtReliable===true?stamp(source.latestMessageAt):source.tailKnown===true&&source.orderReliable===true?stamp(tail?.at):null;
  if(lastMessageAt===null)return incomplete('Не удалось достоверно определить дату последнего сообщения.');
  if(lastMessageAt>now+5*60*1000)return incomplete('Дата последнего сообщения находится в будущем; требуется повторная проверка.',{lastMessageAt});
  if(now-lastMessageAt>24*60*60*1000)return {status:'older',detail:'Последнее сообщение старше 24 часов; чат вне периода проверки.',lastMessageAt};
  let match=null;
  if(proof&&source.found===true&&source.status==='found')match={direction:source.matchDirection,key:source.matchMessageKey};
  if(!proof)match=(Array.isArray(source.messages)?source.messages:[]).find(message=>message&&textContainsWechatContact(message.text,contact));
  if(match)return {status:'found',detail:'Ваш WeChat ID найден в сообщении чата.',lastMessageAt,...(['inbound','outbound','unknown','system'].includes(match.direction)?{matchDirection:match.direction}:{}),...(typeof match.key==='string'?{matchMessageKey:clean(match.key,1600)}:{})};
  const unreadable=!proof&&((source.messages||[]).some(message=>message.format==='unrecognized'||message.attachments?.some(file=>!file.contentReady))||['unreadAttachments','unsupportedMessages','unmatchedTextNodes','limited'].some(key=>source.coverage?.[key]));
  const complete=proof?source.complete===true&&source.fullHistory===true&&source.found===false&&source.status==='not_found':source.historyComplete===true&&source.historyStartKnown===true&&source.tailKnown===true&&source.orderReliable===true&&!source.needsRead&&!unreadable;
  if(complete)return {status:'not_found',detail:'Ваш WeChat ID не найден в тексте сообщений. Вложения и QR-коды не проверялись.',lastMessageAt};
  return incomplete(clean(source.detail,1200)||'История чата прочитана не полностью. Отсутствие WeChat ID не подтверждено.',{lastMessageAt});
}
