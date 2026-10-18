// An extension-owned offscreen document supplies DOM, canvas and PDF workers.
// It accepts bytes from our worker, never URLs or executable document content.
import {readProductFiles,deleteProductFile} from './lib/product-files.js';
const PORT='openlinks-chat-parser-v1',MAX_BYTES=10*1024*1024;
chrome.runtime.onConnect.addListener(port=>{
  if(port.name!==PORT || port.sender?.id!==chrome.runtime.id || port.sender?.tab || (port.sender?.url && port.sender.url!==chrome.runtime.getURL('background.js')))return;
  let used=false,disconnected=false;const controller=new AbortController();
  port.onDisconnect.addListener(()=>{disconnected=true;controller.abort();});
  port.onMessage.addListener(async request=>{
    if(used)return;used=true;
    let record;
    try {
      if(request?.type!=='PARSE' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.ownerId||'') || typeof request.base64!=='string' || request.base64.length>Math.ceil(MAX_BYTES/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.base64))throw new Error('Invalid bytes');
      const binary=atob(request.base64);if(!binary.length||binary.length>MAX_BYTES)throw new Error('Invalid size');
      const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
      const name=String(request.name||'attachment').slice(0,240),mime=String(request.mime||'application/octet-stream').slice(0,100);
      [record]=await readProductFiles([new File([bytes],name,{type:mime})],{textBudget:50000,imageBudget:8,ownerId:request.ownerId,signal:controller.signal});
      if(disconnected)throw new Error('Cancelled parser');
      // Keep only useful parsed assets. Unsupported originals can be read on the
      // marketplace itself; failed retries must not accumulate binary copies.
      if(record.status!=='ready'){await deleteProductFile(record.id);record={...record,id:'',images:[],imageKey:''};}
      port.postMessage({ok:true,record});
    }catch{if(record?.id)await deleteProductFile(record.id).catch(()=>{});try{port.postMessage({ok:false,error:'Не удалось обработать вложение локально.'});}catch{}}
  });
});
