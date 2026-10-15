// Browser-only test transport. This file is never shipped inside the extension.
const corePromise=import('/extension/lib/core.js');
let state;
const storageListeners=[];
window.chrome={
  runtime:{async sendMessage(message) {
    const {initialState,parseList,validateSettings}=await corePromise;
    state ||= initialState();
    if(message.type==='GET') return {ok:true,state:structuredClone(state)};
    let result={ok:true};
    if(message.type==='SETTINGS') state.settings=validateSettings(message.settings);
    if(message.type==='IMPORT') {
      const parsed=parseList(message.text,state.queue);state.queue.push(...parsed.jobs);
      result={ok:true,added:parsed.jobs.length,errors:parsed.errors};
      state.events.push({at:Date.now(),type:'import',detail:'Browser UI test'});
    }
    if(message.type==='START') state.running=true;
    if(message.type==='PAUSE') state.running=false;
    if(message.type==='REMOVE_PENDING') state.queue=state.queue.filter(j=>j.status!=='pending');
    const snapshot=structuredClone(state);
    queueMicrotask(()=>storageListeners.forEach(listener=>listener({openlinksState:{newValue:snapshot}},'local')));
    return result;
  }},storage:{onChanged:{addListener:fn=>storageListeners.push(fn)}},
};
window.showDirectoryPicker=()=>navigator.storage.getDirectory();
