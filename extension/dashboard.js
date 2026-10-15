import {PLATFORMS, STATUS, FINAL, makePlan, WINDOW_MS, scheduleText, reportText, nextAllowed} from './lib/core.js';
import {getFolder,rememberFolder,writeFile,download} from './lib/files.js';
const $=selector=>document.querySelector(selector);
let state, folder, settingsDirty=false, fileWrites=Promise.resolve(), toastTimer;
const time=at=>at ? new Date(at).toLocaleString('ru-RU',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
function toast(text,error=false) {
  $('#toast').textContent=text; $('#toast').classList.toggle('error',error); $('#toast').hidden=false;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').hidden=true,9000);
}
async function command(type,extra={}) {
  const result=await chrome.runtime.sendMessage({type,...extra});
  if(!result?.ok) throw new Error(result?.error || 'Нет ответа от расширения');
  return result;
}
function button(id,handler) {
  $(id).addEventListener('click',()=>Promise.resolve().then(handler).catch(error=>toast(error.message,true)));
}
function element(tag,text,className) {
  const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(className) node.className=className; return node;
}
function showView(view) {
  for(const node of document.querySelectorAll('.view')) node.hidden=node.id!==view+'-view';
  for(const node of document.querySelectorAll('.nav')) node.classList.toggle('active',node.dataset.view===view);
  $('#view-title').textContent={queue:'Очередь поставщиков',settings:'Сообщение и настройки',report:'Журнал работы'}[view];
}
for(const node of document.querySelectorAll('.nav')) node.addEventListener('click',()=>showView(node.dataset.view));
function initSettings() {
  for(const [key,platform] of Object.entries(PLATFORMS)) {
    const block=element('div'); const label=element('label',platform.label+' · секунд'); label.htmlFor='interval-'+key;
    const input=element('input'); Object.assign(input,{id:'interval-'+key,type:'number',min:'30',max:'86400',required:true});
    block.append(label,input); $('#interval-fields').append(block);
    const profile=element('div',undefined,'profile'); profile.append(element('h3',platform.label));
    const grid=element('div',undefined,'profile-grid');
    for(const [field,title] of Object.entries({contact:'Кнопка контакта',editor:'Поле сообщения',send:'Кнопка отправки',success:'Новое подтверждение успеха'})) {
      const item=element('div'); const label=element('label',title); label.htmlFor=`profile-${key}-${field}`;
      const input=element('input'); Object.assign(input,{type:'text',id:`profile-${key}-${field}`,maxLength:500,placeholder:'Автопоиск по смыслу',spellcheck:false});
      item.append(label,input); grid.append(item);
    }
    profile.append(grid); $('#profile-fields').append(profile);
  }
  $('#settings-form').addEventListener('input',()=>settingsDirty=true);
}
function fillSettings() {
  if(settingsDirty) return;
  $('#message').value=state.settings.message; $('#review').checked=state.settings.review;
  for(const key of Object.keys(PLATFORMS)) {
    $('#interval-'+key).value=state.settings.intervals[key];
    for(const field of ['contact','editor','send','success']) $(`#profile-${key}-${field}`).value=state.settings.profiles[key][field];
  }
}
function render() {
  if(!state) return;
  const now=Date.now(), active=state.queue.find(j=>j.id===state.activeId);
  $('#run-state').textContent=state.running ? (active?.status==='review'&&!active.approved?'Ждёт подтверждения':'Очередь работает') : 'На паузе';
  $('#run-state').classList.toggle('running',state.running);
  $('#start').disabled=state.running; $('#pause').disabled=!state.running;
  $('#nav-count').textContent=state.queue.filter(j=>!FINAL.has(j.status)).length;
  $('#queue-count').textContent=state.queue.length;
  const cards=$('#platform-cards'); cards.replaceChildren();
  for(const [key,p] of Object.entries(PLATFORMS)) {
    const count=kind=>state.slots.filter(s=>s.platform===key && s.kind===kind && s.at>now-WINDOW_MS).length;
    const visits=count('visit'), sends=count('send');
    const card=element('article',undefined,'platform-card'), head=element('div',undefined,'platform-heading');
    head.append(element('span',key==='1688'?'1688':key==='mic'?'M':'a', 'platform-mark'),element('span',p.label));
    const quota=element('div',String(sends),'quota'); quota.append(element('span',p.limit ? ` / ${p.limit} за 20 мин` : ' отправок за 20 мин'));
    const meter=element('div',undefined,'meter'),fill=element('div',undefined,'meter-fill');
    fill.style.width=(p.limit?Math.min(100,sends/p.limit*100):0)+'%'; meter.append(fill);
    const next=nextAllowed(state,key,'visit',now);
    card.append(head,quota,meter,element('p',`Посещений: ${visits}${p.limit?' / '+p.limit:''} · пауза ${state.settings.intervals[key]} с`),element('p',next>now?'Следующее посещение: '+time(next):'Готово к следующему обращению'));
    cards.append(card);
  }
  $('#active-card').hidden=!active;
  if(active) {
    $('#active-url').textContent=active.url; $('#active-url').href=active.url;
    $('#active-reason').textContent=`${STATUS[active.status]}${active.reason?' · '+active.reason:''}`;
    $('#active-message').textContent=active.message || '';
    $('#approve').hidden=active.status!=='review' || active.approved===true;
    $('#recheck').hidden=active.status!=='blocked'; $('#mark-sent').hidden=active.status!=='uncertain';
    $('#skip-active').disabled=active.status==='sending';
  }
  const body=$('#queue-body'); body.replaceChildren();
  for(const job of makePlan(state,now)) {
    const row=element('tr'), urlCell=element('td'),link=element('a',new URL(job.url).hostname);
    link.href=job.url; link.target='_blank'; link.rel='noreferrer'; link.title=job.url; urlCell.append(link);
    const status=element('td'); status.append(element('span',STATUS[job.status] || job.status,'badge '+job.status));
    const action=element('td');
    if(job.status==='pending') {
      const skip=element('button','Пропустить','link-button');
      skip.addEventListener('click',()=>command('SKIP',{id:job.id}).catch(e=>toast(e.message,true))); action.append(skip);
    }
    row.append(urlCell,element('td',PLATFORMS[job.platform].label),element('td',time(job.plannedAt)),status,action); body.append(row);
  }
  $('#empty').hidden=state.queue.length>0;
  const report=$('#report-body'); report.replaceChildren();
  for(const entry of [...state.events].reverse().slice(0,500)) {
    const row=element('tr'); row.append(element('td',time(entry.at)),element('td',STATUS[entry.type] || ({visit:'Посещение',send_attempt:'Попытка отправки',draft_ready:'Черновик готов',start:'Запуск',pause:'Пауза',import:'Импорт',complete:'Завершено',recheck:'Повторная проверка',chat_tab:'Вкладка чата',remove_pending:'Очистка очереди'}[entry.type] || entry.type)),element('td',[entry.url,entry.detail].filter(Boolean).join(' · '))); report.append(row);
  }
  fillSettings();
}
function syncFiles() {
  if(!folder || !state) return;
  const snapshot=structuredClone(state), target=folder;
  fileWrites=fileWrites.catch(()=>{}).then(async()=>{
    if(await target.queryPermission({mode:'readwrite'})!=='granted') {
      $('#folder-status').textContent='Нужно разрешение папки. Нажмите кнопку выбора папки ещё раз.'; return;
    }
    await writeFile(target,'schedule.txt',scheduleText(snapshot));
    await writeFile(target,'report.txt',reportText(snapshot));
    $('#folder-status').textContent=`Папка «${target.name}» · сохранено ${new Date().toLocaleTimeString('ru-RU')}. Оставьте это окно открытым.`;
  }).catch(error=>{
    $('#folder-status').textContent='Ошибка записи: '+error.message;
    toast('Автозапись не выполнена: '+error.message,true);
  });
}
initSettings();
$('#settings-form').addEventListener('submit',async event=>{
  event.preventDefault();
  try {
    const settings={message:$('#message').value,review:$('#review').checked,intervals:{},profiles:{}};
    for(const key of Object.keys(PLATFORMS)) {
      settings.intervals[key]=Number($('#interval-'+key).value); settings.profiles[key]={};
      for(const field of ['contact','editor','send','success']) {
        const selector=$(`#profile-${key}-${field}`).value.trim();
        if(selector) document.createDocumentFragment().querySelector(selector); // Validate syntax only.
        settings.profiles[key][field]=selector;
      }
    }
    await command('SETTINGS',{settings}); settingsDirty=false;
    state=(await command('GET')).state; render(); toast('Настройки сохранены');
  } catch(error) { toast(error.message,true); }
});
button('#start',async()=>{
  if(settingsDirty) throw new Error('Сначала сохраните изменения настроек');
  if(!state.settings.review && !confirm('Будут автоматически отправляться сообщения поставщикам из очереди. Проверьте текст, селекторы и получателей. Запустить?')) return;
  await command('START');
});
button('#pause',()=>command('PAUSE'));
button('#add',async()=>{
  const result=await command('IMPORT',{text:$('#supplier-input').value});
  $('#import-result').textContent=`Добавлено: ${result.added}.\n`+result.errors.join('\n');
  if(!result.errors.length) $('#supplier-input').value='';
});
$('#import-file').addEventListener('change',async event=>{
  try {
    const file=event.target.files[0]; if(!file) return;
    if(file.size>2000000) throw new Error('Файл должен быть меньше 2 МБ');
    $('#supplier-input').value=await file.text(); toast('Файл загружен. Нажмите «Добавить в очередь».');
  } catch(error) { toast(error.message,true); }
  event.target.value='';
});
button('#examples',async()=>{ $('#supplier-input').value=await (await fetch('examples.txt')).text(); });
button('#approve',()=>command('APPROVE'));
button('#recheck',()=>command('RECHECK'));
button('#mark-sent',async()=>{
  if(confirm('Вы проверили чат и видите отправленное сообщение этому поставщику?')) await command('MARK_SENT');
});
button('#skip-active',()=>command('SKIP',{id:state.activeId}));
button('#open-tab',async()=>{
  const active=state.queue.find(j=>j.id===state.activeId);
  if(!active?.tabId) throw new Error('Нет вкладки. Пропустите задачу и добавьте её позднее.');
  const tab=await chrome.tabs.update(active.tabId,{active:true}); await chrome.windows.update(tab.windowId,{focused:true});
});
button('#clear-pending',async()=>{if(confirm('Удалить ожидающие задачи? История и счётчики лимитов останутся.')) await command('REMOVE_PENDING');});
button('#connect-folder',async()=>{
  if(!window.showDirectoryPicker) throw new Error('Выбор папки не поддерживается. Используйте скачивание файлов.');
  const handle=await showDirectoryPicker({id:'openlinks-reports',mode:'readwrite'});
  let exists=false;
  for(const name of ['schedule.txt','report.txt']) {
    try { await handle.getFileHandle(name); exists=true; } catch(error) { if(error.name!=='NotFoundError') throw error; }
  }
  if(exists && !confirm('В папке уже есть schedule.txt или report.txt. Заменять их данными текущей очереди?')) return;
  folder=handle; await rememberFolder(handle); syncFiles();
});
button('#export-schedule',()=>download('schedule.txt',scheduleText(state)));
button('#export-report',()=>download('report.txt',reportText(state)));
button('#report-download',()=>download('report.txt',reportText(state)));
button('#export-json',()=>download('openlinks-snapshot.json',JSON.stringify(state,null,2),'application/json'));
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local' && changes.openlinksState?.newValue) {
    state=changes.openlinksState.newValue; render(); syncFiles();
  }
});
try {
  state=(await command('GET')).state; render();
  folder=await getFolder(); if(folder) syncFiles();
} catch(error) { toast(error.message,true); }
setInterval(()=>{render();syncFiles();},30000);
