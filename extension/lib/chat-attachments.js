import {attachmentSourceFingerprint,resolveConversationAttachments as applyResolution} from './dialogs.js';
import {deleteProductFile,pruneProductFiles} from './product-files.js';

const MAX_BYTES=10*1024*1024,RETRY_MS=5*60*1000,PORT='openlinks-chat-parser-v1';
const DOMAINS={'1688':['1688.com','alicdn.com'],alibaba:['alibaba.com','alicdn.com','alibabausercontent.com'],mic:['made-in-china.com','micstatic.com']};
const FILE_PATH=/\.(?:pdf|docx|xlsx|csv|tsv|txt|json|xml|jpe?g|png|webp|gif)(?:$)/i;
const within=(host,domain)=>host===domain||host.endsWith('.'+domain);
class AttachmentReadError extends Error {}
let serial=Promise.resolve();
const bounded=(promise,ms,message)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AttachmentReadError(message)),ms);})]).finally(()=>clearTimeout(timer));};

export function allowedChatAttachmentURL(value,platform) {
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||u.href.length>4096||!DOMAINS[platform]?.some(domain=>within(u.hostname,domain)))return '';return u.href;}catch{return '';}
}
function frames(tree) {const out=[],queue=[tree];while(queue.length&&out.length<100){const item=queue.shift();if(item?.frame)out.push(item);queue.push(...(item?.childFrames||[]));}return out;}
function base64(bytes){let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);}
function mediaName(raw,mime) {
  const name=String(raw.name||'').replace(/[\u0000-\u001f/\\]/g,' ').trim().slice(0,240);
  if(name&&/\.[a-z0-9]{1,8}$/i.test(name))return name;
  const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','application/pdf':'pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','text/plain':'txt','text/csv':'csv'}[mime];
  if(extension)return (name||'attachment')+'.'+extension;
  try{return decodeURIComponent(new URL(raw.url).pathname.split('/').pop()).slice(0,240)||name||'attachment';}catch{return name||'attachment';}
}
function remaining(context,maximum){const value=Math.min(maximum,context.deadline-Date.now());if(value<=0)throw new AttachmentReadError('Проверка вложения отложена до следующего цикла.');return value;}
async function cachedBytes(api,context,url) {
  if(!api.debugger?.attach)throw new AttachmentReadError('Кэш страницы недоступен.');
  const target={tabId:context.tabId};let attached=false,closed=false;
  try {
    await bounded(api.debugger.attach(target,'1.3').then(async()=>{attached=true;if(closed){await api.debugger.detach(target).catch(()=>{});throw new AttachmentReadError('Чтение кэша отменено.');}}),remaining(context,5000),'Не удалось подключиться к кэшу страницы.');
    const tree=await bounded(api.debugger.sendCommand(target,'Page.getResourceTree'),remaining(context,5000),'Не удалось прочитать ресурсы чата.');
    const matching=frames(tree?.frameTree).filter(item=>item.frame.url===context.sourceUrl);
    if(matching.length!==1)throw new AttachmentReadError('Документ вложения изменился.');
    const resource=(matching[0].resources||[]).filter(item=>item.url===url);
    if(resource.length!==1)throw new AttachmentReadError('Вложение ещё не загружено площадкой.');
    const data=await bounded(api.debugger.sendCommand(target,'Page.getResourceContent',{frameId:matching[0].frame.id,url}),remaining(context,5000),'Не удалось прочитать вложение из кэша.');
    if(typeof data?.content!=='string'||data.content.length>Math.ceil(MAX_BYTES/3)*4)throw new AttachmentReadError('Вложение превышает предел 10 МБ.');
    const bytes=data.base64Encoded?Uint8Array.from(atob(data.content),c=>c.charCodeAt(0)):new TextEncoder().encode(data.content);
    if(!bytes.length||bytes.length>MAX_BYTES)throw new AttachmentReadError('Вложение пусто или превышает предел 10 МБ.');
    return {base64:base64(bytes),mime:resource[0].mimeType||'application/octet-stream'};
  } finally {closed=true;if(attached)await api.debugger.detach(target).catch(()=>{});}
}
async function fetchedBytes(api,context,url,fetchImpl) {
  const parsed=new URL(url),platformHost=DOMAINS[context.state.conversations[context.key].platform]?.[0];
  // Download only explicitly named document/image resources on the marketplace.
  // CDN content uses the already loaded resource cache; no new broad permission.
  if(!within(parsed.hostname,platformHost)||!FILE_PATH.test(parsed.pathname)||!await api.permissions?.contains({origins:[parsed.origin+'/*']}))throw new AttachmentReadError('Содержимое вложения пока недоступно в кэше чата.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),remaining(context,8000));
  try {
    const response=await fetchImpl(url,{credentials:'include',redirect:'error',signal:controller.signal,cache:'no-store'});
    if(!response.ok||!response.body)throw new AttachmentReadError('Площадка не предоставила файл.');
    const declared=Number(response.headers.get('content-length'));if(declared>MAX_BYTES)throw new AttachmentReadError('Вложение превышает предел 10 МБ.');
    const reader=response.body.getReader(),parts=[];let length=0;
    try{for(;;){const result=await reader.read();if(result.done)break;length+=result.value.length;if(length>MAX_BYTES){await reader.cancel();throw new AttachmentReadError('Вложение превышает предел 10 МБ.');}parts.push(result.value);}}finally{reader.releaseLock();}
    if(!length)throw new AttachmentReadError('Площадка вернула пустое вложение.');
    const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    return {base64:base64(bytes),mime:response.headers.get('content-type')?.split(';')[0].trim()||'application/octet-stream'};
  }finally{clearTimeout(timer);}
}
async function parseBytes(api,raw,bytes,context) {
  if(!api.offscreen?.createDocument||!api.runtime?.connect)throw new AttachmentReadError('Обновите расширение: модуль чтения вложений недоступен.');
  const url=api.runtime.getURL('attachment-parser.html');let created=false;
  const contexts=await api.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
  if(contexts.length&&!contexts.some(c=>c.documentUrl===url))throw new AttachmentReadError('Локальный обработчик занят. Повторная проверка запланирована.');
  if(!contexts.length){await api.offscreen.createDocument({url:'attachment-parser.html',reasons:['DOM_PARSER','BLOBS','WORKERS'],justification:'Локальное чтение документов и изображений из сообщений поставщика без отправки сообщений.'});created=true;}
  let port,successful=false;const ownerId=crypto.randomUUID();
  try {
    port=api.runtime.connect({name:PORT});
    const record=await bounded(new Promise((resolve,reject)=>{
      port.onMessage.addListener(reply=>reply?.ok&&reply.record?resolve(reply.record):reject(new AttachmentReadError('Не удалось обработать вложение локально.')));
      port.onDisconnect.addListener(()=>{void api.runtime.lastError;reject(new AttachmentReadError('Локальный обработчик вложений отключился.'));});
      port.postMessage({type:'PARSE',ownerId,name:mediaName(raw,bytes.mime),mime:bytes.mime,base64:bytes.base64});
    }),remaining(context,20000),'Обработка вложения заняла слишком много времени.');
    if(record.status==='ready'&&record.id!==ownerId)throw new AttachmentReadError('Локальное вложение не соответствует запросу.');
    successful=record.status==='ready';return record;
  }finally{port?.disconnect();if(created)await api.offscreen.closeDocument().catch(()=>{});if(!successful)await deleteProductFile(ownerId).catch(()=>{});}
}
const transcript=row=>JSON.stringify((row.messages||[]).map(m=>[m.id||'',m.direction,m.text,m.at??null,(m.attachments||[]).map(a=>[attachmentSourceFingerprint(a),a.url||''])]));
function candidates(context) {
  const stored=context.state.conversations[context.key],raw=context.rawConversation;
  if(!stored||!raw||stored.id!==raw.id||raw.active!==true||raw.identityReliable!==true||raw.historyTailKnown!==true||raw.historyOrderReliable!==true)return [];
  const result=[];
  for(const message of stored.messages){
    const rawMatches=(raw.messages||[]).filter(item=>message.id?item.id===message.id:item.direction===message.direction&&item.text===message.text);
    if(rawMatches.length!==1)continue;
    for(const attachment of message.attachments||[]){
      if(attachment.type==='link'||attachment.contentReady||attachment.resolution?.status==='ready'||attachment.resolution?.retryAt>context.now)continue;
      const matches=(rawMatches[0].attachments||[]).filter(item=>attachmentSourceFingerprint(item)===attachment.sourceFingerprint);
      if(matches.length===1)result.push({messageKey:message.key,sourceFingerprint:attachment.sourceFingerprint,raw:matches[0],messageId:rawMatches[0].id||'',messageText:rawMatches[0].text,messageDirection:rawMatches[0].direction,messageAt:rawMatches[0].at??null,transcript:transcript(raw),oldOwnerId:attachment.resolution?.ownerId});
    }
  }
  return result.slice(0,2);
}
async function confirm(api,context,candidate) {
  const tab=await api.tabs.get(context.tabId);if(tab.pendingUrl||tab.status==='loading')throw new AttachmentReadError('Страница чата изменилась.');
  const snapshot=await bounded(api.tabs.sendMessage(context.tabId,{type:'DIALOGS_SNAPSHOT'},{frameId:context.frameId}),remaining(context,5000),'Чат не ответил на проверку вложения.');
  if(snapshot?.status!=='ready'||snapshot.documentToken!==context.documentToken||snapshot.url!==context.sourceUrl)throw new AttachmentReadError('Документ чата изменился.');
  const active=snapshot.conversations?.filter(row=>row.active&&row.id===context.rawConversation.id&&row.identityReliable);
  if(active?.length!==1)throw new AttachmentReadError('Получатель чата изменился.');
  if(snapshot.busy===true||(snapshot.busy&&Object.values(snapshot.busy).some(value=>value===true)))throw new AttachmentReadError('Пользователь работает в чате; чтение вложения отложено.');
  if(transcript(active[0])!==candidate.transcript)throw new AttachmentReadError('История чата изменилась; чтение вложения отложено.');
  const messages=active[0].messages?.filter(m=>candidate.messageId?m.id===candidate.messageId:m.text===candidate.messageText&&m.direction===candidate.messageDirection&&(m.at??null)===candidate.messageAt);
  if(messages?.length!==1)throw new AttachmentReadError('Сообщение с вложением изменилось или неоднозначно.');
  const source=messages[0].attachments?.filter(a=>attachmentSourceFingerprint(a)===candidate.sourceFingerprint&&a.url===candidate.raw.url);
  if(source?.length!==1)throw new AttachmentReadError('Источник вложения изменился или неоднозначен.');
}
async function resolve(context,dependencies) {
  const api=context.api||globalThis.chrome,results=[];context={...context,api,now:typeof context.now==='number'?context.now:Date.now(),deadline:Date.now()+22000};
  for(const candidate of candidates(context)){
    if(Date.now()>=context.deadline)break;
    let ownerId='';
    try {
      if(!['image','file'].includes(candidate.raw.type))throw new AttachmentReadError('Формат вложения пока не поддерживается.');
      const url=allowedChatAttachmentURL(candidate.raw.url,context.state.conversations[context.key].platform);if(!url)throw new AttachmentReadError('Нет подтверждённого адреса файла на площадке.');
      await confirm(api,context,candidate);
      let bytes;try{bytes=await (dependencies.cachedBytes||cachedBytes)(api,context,url);}catch{bytes=await (dependencies.fetchedBytes||fetchedBytes)(api,context,url,dependencies.fetch||globalThis.fetch);}
      await confirm(api,context,candidate);
      const record=await (dependencies.parseBytes||parseBytes)(api,candidate.raw,bytes,context);ownerId=record.id||'';
      await confirm(api,context,candidate);
      if(record.status!=='ready')throw new AttachmentReadError(record.error?.startsWith('Локальное хранилище вложений заполнено:')?'Локальное хранилище вложений заполнено: предел 256 МБ. Удалите ненужные файлы.':record.status==='unsupported'?'Формат вложения пока не поддерживается.':'Вложение прочитано не полностью. Откройте исходный файл для проверки.');
      results.push({messageKey:candidate.messageKey,sourceFingerprint:candidate.sourceFingerprint,status:'ready',text:record.text||'',images:record.images||[],warnings:[],attemptedAt:context.now,retryAt:null,ownerId});
      if(candidate.oldOwnerId&&candidate.oldOwnerId!==ownerId)await (dependencies.deleteFile||deleteProductFile)(candidate.oldOwnerId).catch(()=>{});
    }catch(error){if(ownerId)await (dependencies.deleteFile||deleteProductFile)(ownerId).catch(()=>{});const message=error instanceof AttachmentReadError?String(error.message).slice(0,500):'Не удалось прочитать вложение. Повторная проверка через 5 минут.';results.push({messageKey:candidate.messageKey,sourceFingerprint:candidate.sourceFingerprint,status:'error',text:'',images:[],warnings:[message],attemptedAt:context.now,retryAt:context.now+RETRY_MS,ownerId:''});}
  }
  if(results.length)applyResolution(context.state,context.key,results,context.now);
  return {changed:results.length>0,resolved:results.filter(r=>r.status==='ready').length,failed:results.filter(r=>r.status!=='ready').length};
}
export function resolveChatAttachments(context,dependencies={}) {
  // One owned debugger/offscreen operation at a time, independently of AI work.
  const task=serial.then(()=>resolve(context,dependencies));serial=task.catch(()=>{});return task;
}

export async function pruneChatAttachmentCache({api=globalThis.chrome,state,now=Date.now()}) {
  if(!globalThis.indexedDB)return;
  const key='openlinksMediaPrunedAt',saved=(await api.storage.local.get(key))[key];
  if(Number.isFinite(saved)&&saved<=now&&now-saved<60*60*1000)return;
  const retained=new Set((state.product?.files||[]).map(file=>file.id));
  for(const conversation of Object.values(state.conversations||{}))for(const message of [...(conversation.messages||[]),...(conversation.archivedMessages||[])])for(const attachment of message.attachments||[])if(attachment.resolution?.ownerId)retained.add(attachment.resolution.ownerId);
  // A recent unreferenced file may still be edited in a product tab. Its grace
  // period protects those imports; retained product/history assets never expire.
  await pruneProductFiles([...retained],{olderThan:now-24*60*60*1000});
  await api.storage.local.set({[key]:now});
}
