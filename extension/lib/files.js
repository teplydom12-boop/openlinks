import {WORKBOOK_MARKER} from './excel.js';
const DB='openlinks-files';
async function database() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('handles');
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
}
export async function getFolder() {
  const db=await database();
  try { return await new Promise((resolve,reject)=>{
    const tx=db.transaction('handles'); const request=tx.objectStore('handles').get('reports');
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  }); } finally { db.close(); }
}
export async function rememberFolder(handle) {
  const db=await database();
  try { await new Promise((resolve,reject)=>{
    const tx=db.transaction('handles','readwrite'); tx.objectStore('handles').put(handle,'reports');
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
  }); } finally { db.close(); }
}
export async function writeFile(folder,name,text) {
  const handle=await folder.getFileHandle(name,{create:true});
  const writer=await handle.createWritable();
  try { await writer.write(text); await writer.close(); }
  catch(error) { await writer.abort().catch(()=>{}); throw error; }
}
export async function writeLog(folder,text,allowReplace=false) {
  try {
    const handle=await folder.getFileHandle('activity.log');
    const prefix=await (await handle.getFile()).slice(0,96).text();
    if(!allowReplace && !prefix.startsWith('# OpenLinks — activity.log\n')) {
      throw new Error('activity.log уже существует и не принадлежит OpenLinks. Выберите папку заново и подтвердите замену или укажите другую папку.');
    }
  } catch(error) { if(error.name!=='NotFoundError') throw error; }
  await writeFile(folder,'activity.log',text);
}
export async function writeExcel(folder,bytes,allowReplace=false) {
  try {
    const file=await (await folder.getFileHandle('report.xlsx')).getFile();
    const tail=new Uint8Array(await file.slice(-(22+WORKBOOK_MARKER.length)).arrayBuffer());
    const owned=tail.length===22+WORKBOOK_MARKER.length && new DataView(tail.buffer).getUint32(0,true)===0x06054b50 &&
      new DataView(tail.buffer).getUint16(20,true)===WORKBOOK_MARKER.length && new TextDecoder().decode(tail.slice(22))===WORKBOOK_MARKER;
    if(!allowReplace && !owned)throw new Error('report.xlsx уже существует и не принадлежит OpenLinks. Выберите папку заново и подтвердите замену или укажите другую папку.');
  } catch(error) {if(error.name!=='NotFoundError')throw error;}
  await writeFile(folder,'report.xlsx',bytes);
}
export function download(name,content,type='text/plain;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const anchor=document.createElement('a'); anchor.href=url; anchor.download=name; anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
