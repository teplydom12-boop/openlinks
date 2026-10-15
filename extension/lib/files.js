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
export function download(name,content,type='text/plain;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const anchor=document.createElement('a'); anchor.href=url; anchor.download=name; anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
