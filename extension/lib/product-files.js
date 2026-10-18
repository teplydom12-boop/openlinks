// Product attachments are parsed locally. Raw files and rendered images stay in
// IndexedDB; only bounded descriptors/text belong in chrome.storage. Nothing in
// this module sends a request to an AI provider or executes document content.
export const PRODUCT_FILE_LIMITS = Object.freeze({files:8,fileBytes:20*1024*1024,batchBytes:60*1024*1024,storageBytes:256*1024*1024,textPerFile:50000,textTotal:150000,images:8,imageBytes:2*1024*1024,imagePixels:2000,pdfPages:50,zipEntries:1000,zipBytes:50*1024*1024,zipEntryBytes:20*1024*1024});
const DB_NAME='openlinksProductFiles',DB_VERSION=1,STORE='attachments';
const MIME_IMAGES=new Set(['image/jpeg','image/png','image/webp']);
const INPUT_IMAGES=new Set([...MIME_IMAGES,'image/gif']);
const TEXT_EXTENSIONS=new Set(['txt','csv','tsv','md','markdown','json','xml','html','htm','log','yaml','yml']);
const encoder=new TextEncoder();
const textDecoder=new TextDecoder('utf-8');
const cleanText=value=>String(value??'').replace(/\u0000/g,'').replace(/\r\n?/g,'\n').trim();
const extension=name=>String(name).toLowerCase().split('.').pop();
const uuid=()=>globalThis.crypto.randomUUID();
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
const warning=(record,message)=>{if(!record.warnings.includes(message))record.warnings.push(message);};
const note=(record,message)=>{record.note=[record.note,message].filter(Boolean).join(' ');};
const abortError=()=>new DOMException('Чтение файла отменено.','AbortError');
function checkSignal(signal){if(signal?.aborted)throw abortError();}
function cancellable(promise,signal,onLateValue) {
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const abort=()=>{if(settled)return;settled=true;reject(abortError());};
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    Promise.resolve(promise).then(value=>{if(settled){onLateValue?.(value);return;}settled=true;resolve(value);},error=>{if(!settled){settled=true;reject(error);}}).finally(()=>signal.removeEventListener('abort',abort));
  });
}
const budget=(value,maximum)=>Number.isFinite(value)?Math.max(0,Math.min(maximum,Math.floor(value))):maximum;
let dbPromise;
function database() {
  if(!globalThis.indexedDB)throw new Error('Локальное хранилище файлов недоступно в этом браузере.');
  if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'key'});};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();dbPromise=undefined;};resolve(db);};
    request.onerror=()=>{dbPromise=undefined;reject(new Error('Не удалось открыть локальное хранилище файлов.'));};
    request.onblocked=()=>{dbPromise=undefined;reject(new Error('Хранилище файлов занято другой вкладкой. Закройте старые окна OpenLinks и повторите.'));};
  });
  return dbPromise;
}
async function storeRecords(records,signal) {
  checkSignal(signal);const db=await database();checkSignal(signal);
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),request=store.openCursor();let used=0,quota=false;
    const abort=()=>{try{tx.abort();}catch{}};signal?.addEventListener('abort',abort,{once:true});
    request.onsuccess=()=>{
      const cursor=request.result;
      if(cursor){used+=Math.max(0,Number(cursor.value.blob?.size)||0);cursor.continue();return;}
      if(used+records.reduce((sum,record)=>sum+record.blob.size,0)>PRODUCT_FILE_LIMITS.storageBytes){quota=true;tx.abort();return;}
      for(const record of records)store.add({...record,createdAt:Date.now()});
    };
    tx.oncomplete=()=>{signal?.removeEventListener('abort',abort);resolve();};
    tx.onerror=tx.onabort=()=>{signal?.removeEventListener('abort',abort);reject(signal?.aborted?abortError():new Error(quota?'Локальное хранилище вложений заполнено: предел 256 МБ. Удалите ненужные файлы и повторите.':'Не удалось сохранить файл на этом компьютере. Проверьте свободное место.'));};
  });
}
async function getRecord(key) {
  const db=await database();
  return new Promise((resolve,reject)=>{const request=db.transaction(STORE).objectStore(STORE).get(key);request.onsuccess=()=>resolve(request.result??null);request.onerror=()=>reject(new Error('Не удалось прочитать локальный файл.'));});
}
export async function readProductOriginal(id) {return (await getRecord(`file:${String(id)}`))?.blob??null;}
export async function loadProductImage(imageKey) {
  if(typeof imageKey!=='string'||imageKey.length>200)throw new Error('Некорректная ссылка на изображение товара.');
  const record=await getRecord(imageKey);
  if(!record?.blob||!MIME_IMAGES.has(record.blob.type)||record.blob.size>PRODUCT_FILE_LIMITS.imageBytes)throw new Error('Изображение товара не найдено в локальном хранилище. Прикрепите файл заново.');
  const bytes=new Uint8Array(await record.blob.arrayBuffer());
  let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return `data:${record.blob.type};base64,${btoa(binary)}`;
}
export async function deleteProductFile(id) {
  const db=await database(),owner=String(id);
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),request=store.openCursor();
    request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(cursor.value.owner===owner)cursor.delete();cursor.continue();};
    tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(new Error('Не удалось удалить локальный файл.'));
  });
}
/** Keep saved references and fresh/unsaved imports; delete only old orphan owners. */
export async function pruneProductFiles(retainIds,{olderThan=Date.now()-24*60*60*1000}={}) {
  if(!Number.isFinite(olderThan))throw new Error('Не удалось проверить возраст локальных файлов.');
  const retain=new Set(Array.from(retainIds??[],String)),db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),scan=store.openCursor(),owners=new Map();let deleted=0,bytes=0;
    scan.onsuccess=()=>{
      const cursor=scan.result;
      if(cursor){const value=cursor.value,owner=String(value.owner||''),group=owners.get(owner)||{latest:0,records:[]};group.latest=Math.max(group.latest,Number(value.createdAt)||0);group.records.push({key:cursor.key,bytes:Math.max(0,Number(value.blob?.size)||0)});owners.set(owner,group);cursor.continue();return;}
      for(const [owner,group] of owners){if(!owner||retain.has(owner)||group.latest>=olderThan)continue;for(const record of group.records){store.delete(record.key);deleted++;bytes+=record.bytes;}}
    };
    tx.oncomplete=()=>resolve({deleted,bytes});tx.onerror=tx.onabort=()=>reject(new Error('Не удалось очистить старые локальные вложения.'));
  });
}

function safeError(error) {
  if(error?.name==='PasswordException')return 'PDF защищён паролем. Сохраните копию без пароля и прикрепите заново.';
  const message=String(error?.message??'');
  // Only our messages are surfaced. Parser exceptions may contain document data.
  if(/^(Файл |ZIP |XML |PDF |Изображение |Таблица |Документ |Не удалось |Локальное |Слишком )/.test(message))return message.slice(0,500);
  return 'Не удалось прочитать этот файл. Проверьте формат и прикрепите другую копию.';
}
function finish(record,textBudget) {
  record.text=cleanText(record.text);
  const cap=Math.max(0,Math.min(PRODUCT_FILE_LIMITS.textPerFile,textBudget.remaining));
  if(record.text.length>cap){record.text=record.text.slice(0,cap);warning(record,`Текст извлечён частично: предел ${cap.toLocaleString('ru-RU')} символов для этого вложения. Разделите файл на части.`);}
  textBudget.remaining-=record.text.length;
  if(record.status==='ready'&&record.warnings.length)record.status='partial';
  record.imageKey=record.images[0]?.imageKey??'';
  record.note=[record.note,record.error,...record.warnings].filter(Boolean).join(' ').slice(0,3000);
  return record;
}

/** Every selected file gets a visible result, including rejected/unsupported files. */
export async function readProductFiles(files,options={}) {
  const selected=Array.from(files??[]),results=[],textBudget={remaining:budget(options.textBudget,PRODUCT_FILE_LIMITS.textTotal)},signal=options.signal;
  if(options.ownerId!==undefined&&(selected.length!==1||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(options.ownerId)))throw new Error('Не удалось определить владельца локального вложения.');
  const imageBudget={remaining:budget(options.imageBudget,PRODUCT_FILE_LIMITS.images)};
  checkSignal(signal);
  let batchBytes=0;
  for(let index=0;index<selected.length;index++) {
    const file=selected[index],record={id:options.ownerId??uuid(),name:String(file?.name??'Без имени').slice(0,240),mime:String(file?.type??'').slice(0,150),size:Number(file?.size)||0,lastModified:Number(file?.lastModified)||0,kind:'unsupported',format:extension(file?.name),status:'ready',text:'',contentHash:'',images:[],imageKey:'',warnings:[],error:'',note:''};
    results.push(record);
    if(index>=PRODUCT_FILE_LIMITS.files){record.status='error';record.error=`Слишком много файлов: за один раз можно обработать ${PRODUCT_FILE_LIMITS.files}.`;finish(record,textBudget);continue;}
    if(!file||typeof file.arrayBuffer!=='function'||!Number.isSafeInteger(file.size)||file.size<1){record.status='error';record.error='Файл пуст или недоступен.';finish(record,textBudget);continue;}
    if(file.size>PRODUCT_FILE_LIMITS.fileBytes){record.status='error';record.error='Файл превышает предел 20 МБ. Разделите его на части.';finish(record,textBudget);continue;}
    if(batchBytes+file.size>PRODUCT_FILE_LIMITS.batchBytes){record.status='error';record.error='Слишком большой набор вложений: предел 60 МБ за один раз.';finish(record,textBudget);continue;}
    batchBytes+=file.size;
    try {
      checkSignal(signal);const bytes=new Uint8Array(await cancellable(file.arrayBuffer(),signal));checkSignal(signal);
      if(bytes.length!==file.size)throw new Error('Файл изменился во время чтения. Прикрепите его снова.');
      record.contentHash=await cancellable(digest(bytes),signal);checkSignal(signal);
      await storeRecords([{key:`file:${record.id}`,owner:record.id,kind:'original',blob:new Blob([bytes],{type:file.type||'application/octet-stream'}),name:record.name}],signal);
      const type=detectFormat(bytes,record.name,record.mime);record.format=type;
      if(type==='xlsx'||type==='docx')await readOffice(bytes,record,imageBudget,type,signal);
      else if(type==='pdf')await readPdf(bytes,record,imageBudget,signal);
      else if(INPUT_IMAGES.has(type)){record.kind='image';await addImage(new Blob([bytes],{type}),record,imageBudget,{},signal);note(record,'Изображение сохранено локально для анализа ИИ; локальное распознавание текста не выполнялось.');}
      else if(type==='text'||type==='html'||type==='xml'||type==='json')readText(bytes,record,type);
      else {record.status='unsupported';record.error='Файл сохранён локально, но этот формат пока не читается. Используйте XLSX, CSV, TXT, DOCX, PDF, JPEG, PNG или WebP.';}
      if(record.status==='ready'&&!record.text&&!record.images.length){record.status='error';record.error='Файл не содержит доступного текста или изображений.';}
      checkSignal(signal);
    }catch(error){if(signal?.aborted||error?.name==='AbortError'){await Promise.all(results.map(item=>deleteProductFile(item.id).catch(()=>{})));throw abortError();}record.status='error';record.error=safeError(error);}
    finish(record,textBudget);
  }
  return results;
}

export function detectFormat(bytes,name,mime='') {
  const ext=extension(name),starts=(...values)=>values.every((x,i)=>bytes[i]===x);
  if(starts(0x25,0x50,0x44,0x46,0x2d))return 'pdf';
  if(starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))return 'image/png';
  if(starts(0xff,0xd8,0xff))return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(textDecoder.decode(bytes.subarray(0,6))))return 'image/gif';
  if(starts(0x52,0x49,0x46,0x46)&&textDecoder.decode(bytes.subarray(8,12))==='WEBP')return 'image/webp';
  if(starts(0x50,0x4b,3,4))return ['xlsx','docx'].includes(ext)?ext:'unsupported';
  if(starts(0xd0,0xcf,0x11,0xe0))return 'unsupported'; // Legacy XLS/DOC, encrypted Office containers.
  if(['pdf','xlsx','docx'].includes(ext)||mime==='application/pdf'||mime.startsWith('image/'))throw new Error('Файл не соответствует указанному формату или повреждён.');
  if(TEXT_EXTENSIONS.has(ext)||mime.startsWith('text/')||mime==='application/json')return ['html','htm'].includes(ext)||mime==='text/html'?'html':ext==='xml'?'xml':ext==='json'||mime==='application/json'?'json':'text';
  return 'unsupported';
}
function decodeText(bytes,record) {
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le',{fatal:true}).decode(bytes.subarray(2));
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be',{fatal:true}).decode(bytes.subarray(2));
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch {warning(record,'Кодировка UTF-8 не обнаружена; применена Windows-1251. Проверьте извлечённый текст.');return new TextDecoder('windows-1251').decode(bytes);}
}
function xmlDocument(text) {
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('XML с внешними сущностями или DTD не поддерживается.');
  const document=new DOMParser().parseFromString(text,'application/xml');
  if(document.querySelector('parsererror'))throw new Error('XML внутри документа повреждён.');
  return document;
}
function readText(bytes,record,type) {
  record.kind='text';let text=decodeText(bytes,record);
  if(/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text))throw new Error('Файл содержит двоичные данные вместо текста.');
  if(type==='html') {
    // An inert template never connects document nodes or loads external resources.
    const template=document.createElement('template');template.innerHTML=text;
    for(const node of template.content.querySelectorAll('script,style,iframe,object,embed,link,meta,template,noscript'))node.remove();
    const textParts=[],blocks=new Set(['P','DIV','TR','LI','H1','H2','H3','H4','PRE','SECTION','ARTICLE','TABLE','UL','OL','BR']);
    const visit=node=>{if(node.nodeType===3){textParts.push(node.textContent);return;}if(blocks.has(node.nodeName))textParts.push('\n');if(node.nodeName==='IMG'&&node.getAttribute('alt'))textParts.push(`[Изображение: ${node.getAttribute('alt')}]`);for(const child of node.childNodes)visit(child);if(blocks.has(node.nodeName))textParts.push('\n');if(['TD','TH'].includes(node.nodeName))textParts.push('\t');};
    visit(template.content);text=textParts.join('').replace(/\n[ \t]*\n+/g,'\n');
    if(template.content.querySelector('img[src],video,audio,canvas,svg'))warning(record,'Изображения и мультимедиа HTML не извлечены. Прикрепите их отдельными файлами.');
  } else if(type==='xml')text=xmlDocument(text).documentElement.textContent;
  else if(type==='json'){try{text=JSON.stringify(JSON.parse(text),null,2);}catch{throw new Error('Файл JSON повреждён: синтаксис не соответствует формату.');}}
  record.text=text;
}

// Central-directory validation precedes decompression. No entry can escape the
// in-memory map, no links are followed, and actual expanded bytes are bounded.
export function inspectZip(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===bytes.length){end=i;break;}
  if(end<0)throw new Error('ZIP внутри документа повреждён: не найдена таблица файлов.');
  const count=view.getUint16(end+10,true),centralSize=view.getUint32(end+12,true),centralAt=view.getUint32(end+16,true);
  if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||view.getUint16(end+8,true)!==count||count===65535||centralSize===0xffffffff||centralAt===0xffffffff)throw new Error('ZIP64 и составные ZIP-документы не поддерживаются.');
  if(count>PRODUCT_FILE_LIMITS.zipEntries||centralAt+centralSize>end)throw new Error('ZIP превышает допустимое число файлов или повреждён.');
  const entries=[];let at=centralAt,total=0;const names=new Set();
  for(let i=0;i<count;i++) {
    if(at+46>centralAt+centralSize||view.getUint32(at,true)!==0x02014b50)throw new Error('ZIP содержит повреждённую запись.');
    const flags=view.getUint16(at+8,true),method=view.getUint16(at+10,true),crc=view.getUint32(at+16,true),compressed=view.getUint32(at+20,true),expanded=view.getUint32(at+24,true),nameSize=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true),localAt=view.getUint32(at+42,true);
    if(at+46+nameSize+extra+comment>centralAt+centralSize)throw new Error('ZIP содержит обрезанное имя файла.');
    const name=textDecoder.decode(bytes.subarray(at+46,at+46+nameSize));
    if(!name||name.includes('\\')||name.startsWith('/')||name.includes('\u0000')||name.split('/').includes('..')||names.has(name))throw new Error('ZIP содержит недопустимые или повторяющиеся имена файлов.');
    if(flags&1)throw new Error('ZIP-документ защищён паролем. Сохраните копию без пароля.');
    if(![0,8].includes(method))throw new Error('ZIP использует неподдерживаемое сжатие.');
    total+=expanded;
    if(expanded>PRODUCT_FILE_LIMITS.zipEntryBytes||total>PRODUCT_FILE_LIMITS.zipBytes||expanded>Math.max(1024*1024,compressed*1000))throw new Error('ZIP превышает предел распакованного размера: 50 МБ на документ, 20 МБ на часть.');
    if(localAt+30>centralAt||view.getUint32(localAt,true)!==0x04034b50)throw new Error('ZIP содержит повреждённый заголовок файла.');
    const localNameLength=view.getUint16(localAt+26,true),localExtra=view.getUint16(localAt+28,true),start=localAt+30+localNameLength+localExtra;
    if(start+compressed>centralAt||textDecoder.decode(bytes.subarray(localAt+30,localAt+30+localNameLength))!==name||view.getUint16(localAt+8,true)!==method)throw new Error('ZIP содержит несовпадающие заголовки.');
    entries.push({name,method,compressed,expanded,crc,start});names.add(name);at+=46+nameSize+extra+comment;
  }
  if(at!==centralAt+centralSize)throw new Error('ZIP содержит лишние записи в каталоге.');
  return entries;
}
const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
async function unzipEntry(bytes,entry,signal) {
  checkSignal(signal);
  let output;
  if(entry.method===0)output=bytes.slice(entry.start,entry.start+entry.compressed);
  else {
    const stream=new Blob([bytes.subarray(entry.start,entry.start+entry.compressed)]).stream().pipeThrough(new DecompressionStream('deflate-raw')),reader=stream.getReader(),chunks=[];let size=0;
    try {while(true){const {value,done}=await cancellable(reader.read(),signal);if(done)break;size+=value.length;if(size>entry.expanded||size>PRODUCT_FILE_LIMITS.zipEntryBytes){await reader.cancel();throw new Error('ZIP распаковывается в больший размер, чем заявлено.');}chunks.push(value);}}
    catch(error){try{await reader.cancel();}catch{}if(error?.name==='AbortError'||String(error?.message).startsWith('ZIP '))throw error;throw new Error('ZIP содержит повреждённые сжатые данные.');}
    output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}
  }
  if(output.length!==entry.expanded||crc32(output)!==entry.crc)throw new Error('ZIP содержит повреждённые данные: размер или контрольная сумма не совпадают.');
  return output;
}
async function readOffice(bytes,record,imageBudget,type,signal) {
  record.kind='text';const entries=inspectZip(bytes),map=new Map(entries.map(entry=>[entry.name,entry]));
  const get=async name=>{checkSignal(signal);const entry=map.get(name);if(!entry)throw new Error(`Документ не содержит обязательную часть ${name}.`);return xmlDocument(new TextDecoder('utf-8',{fatal:true}).decode(await unzipEntry(bytes,entry,signal)));};
  if(type==='xlsx')await readWorkbook(get,map,record);
  else {
    const doc=await get('word/document.xml');
    record.text=Array.from(doc.getElementsByTagNameNS('*','p')).map(paragraph=>Array.from(paragraph.getElementsByTagNameNS('*','t')).map(node=>node.textContent).join('')).join('\n');
    for(const entry of entries.filter(item=>/^word\/(header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(item.name))){const extra=await get(entry.name);record.text+=`\n[${entry.name}]\n`+Array.from(extra.getElementsByTagNameNS('*','p')).map(node=>node.textContent).join('\n');}
    if(map.has('word/comments.xml')){const comments=await get('word/comments.xml');record.text+='\n[Комментарии Word]\n'+Array.from(comments.getElementsByTagNameNS('*','comment')).map(comment=>Array.from(comment.getElementsByTagNameNS('*','t')).map(t=>t.textContent).join('')).join('\n');}
  }
  if(entries.some(entry=>/vbaProject\.bin$/i.test(entry.name)))warning(record,'Макросы документа не запускались и не читались.');
  const media=entries.filter(entry=>new RegExp(`^${type==='xlsx'?'xl':'word'}/media/`).test(entry.name)&&!entry.name.endsWith('/'));
  for(const entry of media) {
    if(imageBudget.remaining<=0){warning(record,'Не все встроенные изображения обработаны: предел 8 изображений на набор файлов.');break;}
    const data=await unzipEntry(bytes,entry,signal),mime=detectFormat(data,entry.name);
    if(!INPUT_IMAGES.has(mime)){warning(record,`Встроенное изображение ${entry.name.split('/').pop()} имеет неподдерживаемый формат.`);continue;}
    await addImage(new Blob([data],{type:mime}),record,imageBudget,{source:entry.name},signal);
  }
  if(media.length&&record.images.length)note(record,'Встроенные изображения сохранены локально для анализа ИИ.');
  if(entries.some(entry=>/^(xl|word)\/(charts|embeddings)\//.test(entry.name)))warning(record,'Диаграммы и вложенные документы Office не извлечены. Прикрепите их изображениями или отдельными файлами.');
  for(const entry of entries.filter(item=>/\.rels$/.test(item.name))) {
    const relations=await get(entry.name);
    if(Array.from(relations.documentElement.children).some(node=>node.getAttribute('TargetMode')==='External'&&/\/(image|oleObject|externalLinkPath)$/.test(node.getAttribute('Type')||''))){warning(record,'В документе есть внешние изображения или связанные файлы. Они не загружались; прикрепите их отдельно.');break;}
  }
}
function childrenNS(node,name){return Array.from(node.children).filter(child=>child.localName===name);}
async function readWorkbook(get,map,record) {
  const workbook=await get('xl/workbook.xml'),relations=await get('xl/_rels/workbook.xml.rels');
  const rels=new Map(Array.from(relations.documentElement.children).filter(node=>node.getAttribute('TargetMode')!=='External').map(node=>[node.getAttribute('Id'),node.getAttribute('Target')]));
  let strings=[];if(map.has('xl/sharedStrings.xml'))strings=Array.from((await get('xl/sharedStrings.xml')).getElementsByTagNameNS('*','si')).map(node=>Array.from(node.getElementsByTagNameNS('*','t')).map(t=>t.textContent).join(''));
  const date1904=['true','1'].includes(workbook.getElementsByTagNameNS('*','workbookPr')[0]?.getAttribute('date1904'));
  let formats=[];
  if(map.has('xl/styles.xml')) {
    const styles=await get('xl/styles.xml'),custom=new Map(Array.from(styles.getElementsByTagNameNS('*','numFmt')).map(node=>[Number(node.getAttribute('numFmtId')),node.getAttribute('formatCode')||'']));
    const xfs=styles.getElementsByTagNameNS('*','cellXfs')[0];
    formats=xfs?childrenNS(xfs,'xf').map(node=>{const id=Number(node.getAttribute('numFmtId')),pattern=(custom.get(id)||'').replace(/"[^"]*"|\\.|\[[^\]]*\]/g,'');return {date:[14,15,16,17,18,19,20,21,22,45,46,47].includes(id)||/[dy]/i.test(pattern),time:[18,19,20,21,45,46,47].includes(id)||!/[dy]/i.test(pattern)&&/[hs]/i.test(pattern),percent:id===9||id===10||pattern.includes('%')};}):[];
  }
  const sheets=Array.from(workbook.getElementsByTagNameNS('*','sheet'));if(sheets.length>30)warning(record,'Прочитаны первые 30 листов Excel. Остальные листы не обработаны.');
  let cells=0,chars=0,stop=false;const output=[];
  for(const sheet of sheets.slice(0,30)) {
    const relation=sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id')||sheet.getAttribute('r:id'),target=rels.get(relation);
    if(!target){warning(record,`Не удалось найти лист «${sheet.getAttribute('name')||'?'}».`);continue;}
    const path=target.startsWith('/')?target.slice(1):`xl/${target}`;
    if(path.includes('..')||!/^xl\/worksheets\//.test(path)){warning(record,'Лист Excel использует неподдерживаемый путь.');continue;}
    const document=await get(path),lines=[`[Лист: ${sheet.getAttribute('name')||'?'}]`];
    for(const row of document.getElementsByTagNameNS('*','row')) {
      const values=[];
      for(const cell of childrenNS(row,'c')) {
        if(++cells>20000){stop=true;break;}
        const type=cell.getAttribute('t'),v=childrenNS(cell,'v')[0]?.textContent??'';let value=v;
        if(type==='s'){const index=Number(v);if(!/^\d+$/.test(v)||!Number.isSafeInteger(index)||index>=strings.length)throw new Error('Таблица содержит неверную ссылку на строку.');value=strings[index];}
        else if(type==='inlineStr')value=Array.from(cell.getElementsByTagNameNS('*','t')).map(node=>node.textContent).join('');
        else if(type==='b')value=v==='1'?'TRUE':'FALSE';
        else if((!type||type==='n')&&v&&Number.isFinite(Number(v))) {
          const format=formats[Number(cell.getAttribute('s')||0)],number=Number(v);
          if(format?.date||format?.time)value=excelSerial(number,date1904,format.time,record);
          else if(format?.percent)value=`${Number((number*100).toPrecision(12))}%`;
        }
        if(childrenNS(cell,'f').length&&!v)warning(record,'Формулы без сохранённого результата не вычисляются. Пересохраните таблицу в Excel.');
        if(type==='e')warning(record,'В таблице есть ячейки с ошибками Excel.');
        if(value){const rendered=`${cell.getAttribute('r')||'?'}: ${value}`;values.push(rendered);chars+=rendered.length;if(chars>PRODUCT_FILE_LIMITS.textPerFile+1000){stop=true;break;}}
      }
      if(values.length)lines.push(values.join('\t'));if(stop)break;
    }
    output.push(lines.join('\n'));if(stop)break;
  }
  if(stop)warning(record,'Таблица извлечена частично: достигнут предел 20 000 ячеек или 50 000 символов. Разделите файл.');
  record.text=output.join('\n\n');
  note(record,'Прочитаны значения всех доступных ячеек, включая скрытые строки и листы. Макросы, формулы и внешние ссылки не выполнялись.');
}
function excelSerial(value,date1904,timeOnly,record) {
  if(value<0||value>2958465){warning(record,'В таблице есть дата вне поддерживаемого диапазона; сохранено исходное число.');return String(value);}
  if(timeOnly){const seconds=Math.round((value%1)*86400)%86400;return `${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
  if(!date1904&&Math.floor(value)===60){warning(record,'В таблице есть фиктивная дата Excel 29.02.1900. Проверьте значение.');return `1900-02-29 (Excel: ${value})`;}
  const base=date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,31),adjusted=!date1904&&value>=60?value-1:value;
  const date=new Date(base+Math.round(adjusted*86400000));return value%1?date.toISOString().replace('T',' ').replace(/\.\d+Z$/,''):date.toISOString().slice(0,10);
}

async function canvasBlob(canvas,type='image/jpeg',quality=0.88){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Изображение не удалось преобразовать.')),type,quality));}
export function inspectImage(bytes,mime) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let width=0,height=0,animated=false;
  if(mime==='image/png'&&bytes.length>=24){width=view.getUint32(16);height=view.getUint32(20);for(let at=8;at+12<=bytes.length;){const length=view.getUint32(at),type=textDecoder.decode(bytes.subarray(at+4,at+8));if(type==='acTL')animated=true;if(type==='IDAT'||length>bytes.length-at-12)break;at+=12+length;}}
  else if(mime==='image/gif'&&bytes.length>=13){width=view.getUint16(6,true);height=view.getUint16(8,true);let at=13+((bytes[10]&0x80)?3*(2**((bytes[10]&7)+1)):0),frames=0;const skip=()=>{while(at<bytes.length){const size=bytes[at++];if(!size)break;at+=size;}};while(at<bytes.length){const marker=bytes[at++];if(marker===0x3b)break;if(marker===0x21){at++;skip();}else if(marker===0x2c){if(++frames>1){animated=true;break;}if(at+9>bytes.length)break;const packed=bytes[at+8];at+=9+((packed&0x80)?3*(2**((packed&7)+1)):0);at++;skip();}else break;}}
  else if(mime==='image/jpeg'){for(let at=2;at+4<=bytes.length;){if(bytes[at]!==0xff)break;while(bytes[at]===0xff)at++;const marker=bytes[at++];if(marker===0xd9||marker===0xda)break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;if(at+2>bytes.length)break;const size=view.getUint16(at);if(size<2||at+size>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&size>=7){height=view.getUint16(at+3);width=view.getUint16(at+5);break;}at+=size;}}
  else if(mime==='image/webp'&&bytes.length>=25){const type=textDecoder.decode(bytes.subarray(12,16));if(type==='VP8X'&&bytes.length>=30){animated=Boolean(bytes[20]&2);width=1+bytes[24]+bytes[25]*256+bytes[26]*65536;height=1+bytes[27]+bytes[28]*256+bytes[29]*65536;}else if(type==='VP8 '&&bytes.length>=30){width=view.getUint16(26,true)&0x3fff;height=view.getUint16(28,true)&0x3fff;}else if(type==='VP8L'&&bytes.length>=25){const bits=view.getUint32(21,true);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}}
  if(!width||!height)throw new Error('Изображение имеет повреждённый или неподдерживаемый заголовок.');
  if(width*height>40000000||width>20000||height>20000)throw new Error('Изображение превышает предел 40 миллионов пикселей или 20 000 пикселей по стороне.');
  return {width,height,animated};
}
async function addImage(blob,record,budget,extra={},signal) {
  checkSignal(signal);
  if(budget.remaining<=0){warning(record,'Изображение не обработано: предел 8 изображений на набор файлов.');return;}
  const header=inspectImage(new Uint8Array(await cancellable(blob.arrayBuffer(),signal)),blob.type);checkSignal(signal);
  if(header.animated)warning(record,'У анимированного изображения прочитан только первый кадр. Прикрепите важные кадры отдельно.');
  let bitmap,canvas;
  try {bitmap=await cancellable(createImageBitmap(blob),signal,value=>value.close());checkSignal(signal);}catch(error){bitmap?.close();if(error?.name==='AbortError')throw error;throw new Error('Изображение повреждено или его формат не поддерживается браузером.');}
  try {
    if(bitmap.width<1||bitmap.height<1||bitmap.width*bitmap.height>40000000)throw new Error('Изображение превышает допустимый размер 40 миллионов пикселей.');
    const scale=Math.min(1,PRODUCT_FILE_LIMITS.imagePixels/Math.max(bitmap.width,bitmap.height)),width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
    canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('Изображение не удалось открыть.');context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(bitmap,0,0,width,height);
    let output=await cancellable(canvasBlob(canvas),signal);if(output.size>PRODUCT_FILE_LIMITS.imageBytes)output=await cancellable(canvasBlob(canvas,'image/jpeg',0.65),signal);
    canvas.width=canvas.height=1;
    if(output.size>PRODUCT_FILE_LIMITS.imageBytes)throw new Error('Изображение превышает предел после сжатия. Прикрепите уменьшенную копию.');
    const imageKey=`${record.id}:image:${record.images.length}`,descriptor={imageKey,mime:output.type,width,height,...extra};
    await storeRecords([{key:imageKey,owner:record.id,kind:'image',blob:output}],signal);record.images.push(descriptor);budget.remaining--;
  }finally{bitmap.close();if(canvas)canvas.width=canvas.height=1;}
}
let pdfModule;
async function readPdf(bytes,record,imageBudget,signal) {
  record.kind='text';
  if(!pdfModule)pdfModule=import('../vendor/pdfjs/build/pdf.min.mjs');
  const pdfjs=await cancellable(pdfModule,signal);checkSignal(signal);
  // chrome-extension URLs have an opaque URL.origin. Supplying our own local
  // module worker avoids PDF.js's blob/CDN wrapper and main-thread fallback.
  const worker=new Worker(new URL('../vendor/pdfjs/build/pdf.worker.min.mjs',import.meta.url),{type:'module'}),pdfWorker=new pdfjs.PDFWorker({port:worker});
  const pdfBase=new URL('../vendor/pdfjs/',import.meta.url).href;
  // These image codecs need WASM in current PDF.js. MV3's strict CSP remains unchanged.
  const unsupportedScans=/\/(?:JBIG2Decode|JPXDecode)\b/.test(new TextDecoder('latin1').decode(bytes));
  const loading=pdfjs.getDocument({data:bytes,worker:pdfWorker,isEvalSupported:false,useWasm:false,enableXfa:false,disableFontFace:true,useSystemFonts:false,stopAtErrors:true,verbosity:0,cMapUrl:`${pdfBase}cmaps/`,cMapPacked:true,standardFontDataUrl:`${pdfBase}standard_fonts/`,isOffscreenCanvasSupported:false,maxImageSize:40000000});
  let timedOut=false;const stop=new AbortController(),workSignal=stop.signal;
  const abort=()=>{stop.abort();worker.terminate();};
  const timer=setTimeout(()=>{timedOut=true;abort();},45000);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const visualOperators=new Set(['paintImageMaskXObject','paintImageMaskXObjectGroup','paintImageXObject','paintInlineImageXObject','paintInlineImageXObjectGroup','paintImageXObjectRepeat','paintImageMaskXObjectRepeat','shadingFill','constructPath'].map(name=>pdfjs.OPS[name]).filter(value=>value!==undefined));
  let pdf;
  try {
    pdf=await cancellable(loading.promise,workSignal);const pages=Math.min(pdf.numPages,PRODUCT_FILE_LIMITS.pdfPages);if(pdf.numPages>pages)warning(record,`PDF содержит ${pdf.numPages} страниц; обработаны первые ${pages}.`);
    const output=[];let total=0;
    for(let n=1;n<=pages;n++) {
      checkSignal(workSignal);
      const page=await cancellable(pdf.getPage(n),workSignal),textReader=page.streamTextContent().getReader(),lines=[];let lastY=null,line='',items=0,pageChars=0;
      try {while(true){const {done,value}=await cancellable(textReader.read(),workSignal);if(done)break;for(const item of value.items){if(typeof item.str!=='string')continue;if(++items>20000||pageChars>PRODUCT_FILE_LIMITS.textPerFile){warning(record,`Страница ${n}: текст извлечён частично, достигнут предел размера текста.`);break;}pageChars+=item.str.length;const y=item.transform?.[5];if(lastY!==null&&Number.isFinite(y)&&Math.abs(y-lastY)>3&&line){lines.push(line);line='';}line+=(line&&!line.endsWith(' ')?' ':'')+item.str;lastY=y;if(item.hasEOL){lines.push(line);line='';}}if(items>20000||pageChars>PRODUCT_FILE_LIMITS.textPerFile){await cancellable(textReader.cancel(),workSignal);break;}}}
      finally{try{textReader.releaseLock();}catch{}}
      if(line)lines.push(line);const text=cleanText(lines.join('\n'));output.push(`[Страница ${n}]\n${text}`);total+=text.length;
      const annotations=await cancellable(page.getAnnotations({intent:'display'}),workSignal),notes=annotations.map(item=>[item.fieldName,item.fieldValue,item.contentsObj?.str].filter(value=>typeof value==='string'&&value.trim()).join(': ')).filter(Boolean);
      if(notes.length){const annotationText=`[Примечания / поля страницы ${n}]\n${notes.join('\n')}`;output.push(annotationText);total+=annotationText.length;}
      const operators=unsupportedScans?{fnArray:[],argsArray:[]}:await cancellable(page.getOperatorList(),workSignal),hasVisual=unsupportedScans||operators.fnArray.some(operator=>visualOperators.has(operator));
      if(text.replace(/\s/g,'').length<20||hasVisual) {
        if(unsupportedScans)warning(record,`Страница ${n}: PDF содержит JBIG2/JPEG 2000. Сохраните скан как PNG/JPEG для визуального анализа.`);
        else if(imageBudget.remaining<=0)warning(record,`Страница ${n}: изображение или скан не обработан, достигнут предел 8 изображений.`);
        else {
          const natural=page.getViewport({scale:1}),scale=Math.min(2,PRODUCT_FILE_LIMITS.imagePixels/Math.max(natural.width,natural.height)),viewport=page.getViewport({scale}),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.ceil(viewport.width));canvas.height=Math.max(1,Math.ceil(viewport.height));
          try {
            await cancellable(page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport,background:'rgb(255,255,255)'}).promise,workSignal);
            // PDF.js can resolve a broken image to null instead of rejecting the
            // render promise. Treat that as unread, never as a successful scan.
            for(let index=0;index<operators.fnArray.length;index++) {
              if(![pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintImageXObjectRepeat].includes(operators.fnArray[index]))continue;
              const id=operators.argsArray[index]?.[0];if(typeof id!=='string')continue;
              const objects=page.objs?.has(id)?page.objs:page.commonObjs?.has(id)?page.commonObjs:null;
              if(!objects||!objects.get(id))warning(record,`Страница ${n}: одно из изображений PDF не удалось декодировать. Прикрепите его отдельно как JPEG или PNG.`);
            }
            await addImage(await cancellable(canvasBlob(canvas),workSignal),record,imageBudget,{page:n},workSignal);note(record,`Страница ${n} сохранена как изображение для анализа ИИ${text?'; текст страницы также извлечён':'; локальный текст не найден'}.`);
          }
          finally{canvas.width=canvas.height=1;}
        }
      }
      page.cleanup();if(total>PRODUCT_FILE_LIMITS.textPerFile){if(n<pages)warning(record,`PDF прочитан до страницы ${n}: достигнут предел 50 000 символов.`);break;}
    }
    record.text=output.join('\n\n');
  } catch(error){if(timedOut)throw new Error('PDF не удалось обработать за 45 секунд. Разделите его на меньшие файлы.');throw error;}
  finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);let cleanupTimer;
    try {const cleanup=loading.destroy().catch(()=>{});if(!workSignal.aborted)await Promise.race([cleanup,new Promise(resolve=>{cleanupTimer=setTimeout(resolve,1000);})]);}
    finally{clearTimeout(cleanupTimer);pdfWorker.destroy();worker.terminate();}
  }
}
