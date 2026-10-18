import {displayTime} from './lib/time.js';
import {PRODUCT_FILE_LIMITS, readProductFiles, readProductOriginal, deleteProductFile} from './lib/product-files.js';
import {productApprovalError} from './lib/dialogs.js';
import {providerInfo} from './lib/dialog-ai.js';

const $=selector=>document.querySelector(selector);
const FIELDS={sourceUrl:'url',cardText:'card',characteristics:'characteristics',keyPoints:'points',questions:'questions',rules:'rules',warnings:'warnings'};
const FILE_STATUS={ready:['Прочитан','good'],partial:['Прочитан частично','warn'],unsupported:['Формат не поддерживается','bad'],error:['Ошибка чтения','bad']};
const clone=value=>structuredClone(value);
const element=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
const emptyProduct=()=>({revision:0,files:[],sourceUrl:'',cardText:'',characteristics:'',keyPoints:'',questions:'',rules:'',warnings:'',approval:null,extraction:null});

export function setupProductUI({command,adopt,feedback,exportPrompt,onDirty=()=>{}}){
  let state=null,ai={},fingerprint='',baseFingerprint='',baseRevision=0,files=[],dirty=false,settingsDirty=false;
  let operation='',autoBusy=false,pendingFiles=[],retryId=null,disablePromise=null;
  const originals=new Map(),removed=new Set(),expanded=new Set();
  const product=()=>state?.product||emptyProduct();
  const isApproved=()=>!dirty&&!settingsDirty&&!!product().approval&&product().approval.revision===product().revision&&product().approval.fingerprint===fingerprint;
  const configurationReady=()=>!!ai.keyStored&&!!ai.model?.trim();
  const sourceReady=()=>$('#dialogs-product-card').value.trim()||$('#dialogs-product-characteristics').value.trim()||files.some(file=>!file.excluded&&['ready','partial'].includes(file.status)&&(file.text?.trim()||file.images?.length||file.imageKey));
  function patch(){const result={files:clone(files)};for(const [key,suffix] of Object.entries(FIELDS))result[key]=$('#dialogs-product-'+suffix).value;return result;}
  function hydrate(){const saved=product();for(const [key,suffix] of Object.entries(FIELDS))$('#dialogs-product-'+suffix).value=saved[key]||'';files=clone(saved.files||[]);baseRevision=saved.revision||0;baseFingerprint=fingerprint;}
  async function pauseAutomatic(){
    if(!state?.settings?.autoDraft||disablePromise)return disablePromise;
    disablePromise=command('AUTODRAFT',{enabled:false}).then(result=>adopt(result)).catch(error=>feedback('Не удалось выключить автоматические черновики: '+error.message,true)).finally(()=>{disablePromise=null;render();});
    return disablePromise;
  }
  function markDirty(){dirty=true;pauseAutomatic();render();onDirty();}
  function fileButton(label,handler){const button=element('button',label,'link-button');button.type='button';button.disabled=!!operation;button.addEventListener('click',()=>Promise.resolve().then(handler).catch(error=>feedback(error.message,true)));return button;}
  async function forgetFile(id){try{await deleteProductFile(id);}catch{feedback('Не удалось удалить локальный исходный файл. Повторите удаление после обновления страницы.',true);}}
  async function removeFile(id){
    files=files.filter(file=>file.id!==id);originals.delete(id);
    if((product().files||[]).some(file=>file.id===id))removed.add(id);else await forgetFile(id);
    markDirty();
  }
  async function retryFile(record){
    if(operation)return;
    let original=originals.get(record.id);
    if(!original){const blob=await readProductOriginal(record.id);if(blob)original=new File([blob],record.name,{type:record.mime||blob.type,lastModified:record.lastModified||Date.now()});}
    if(original)return addFiles([original],record.id);
    retryId=record.id;$('#dialogs-product-file-retry').value='';$('#dialogs-product-file-retry').click();
    feedback('Выберите исходный файл повторно: его локальная копия недоступна.');
  }
  function renderFiles(){
    const list=$('#dialogs-product-file-list');list.replaceChildren();
    for(const file of files){
      const row=element('div',undefined,'dialogs-product-file');row.dataset.fileId=file.id;
      const info=element('div'),heading=element('div'),[label,tone]=FILE_STATUS[file.status]||['Результат чтения неизвестен','warn'];
      const preparedLabel=file.status==='ready'&&file.images?.length?'Готов к анализу':label;
      heading.append(element('strong',file.name||'Файл без имени'),element('span',file.excluded?'Исключён из задания':preparedLabel,'dialogs-status '+(file.excluded?'':tone)));
      info.append(heading,element('p',[(file.format||file.mime||'Файл'),Number.isFinite(file.size)?(file.size/1024).toFixed(1)+' КБ':'',file.text?.length?'Текст: '+file.text.length+' символов':'',file.images?.length?'Изображений: '+file.images.length:''].filter(Boolean).join(' · '),'hint'));
      const issues=[file.error,file.note,...(file.warnings||[])].filter(Boolean);
      if(issues.length)info.append(element('p',[...new Set(issues)].join('\n'),'hint'));
      const exclude=element('label',undefined,'check'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=!!file.excluded;checkbox.disabled=!!operation;checkbox.setAttribute('aria-label','Исключить '+file.name+' из задания');
      checkbox.addEventListener('change',()=>{file.excluded=checkbox.checked;markDirty();});exclude.append(checkbox,document.createTextNode('Исключить из задания'));info.append(exclude);
      const actions=element('div',undefined,'actions');actions.append(fileButton('Повторить чтение',()=>retryFile(file)),fileButton('Удалить',()=>removeFile(file.id)));
      row.append(info,actions);
      if(file.text){const details=element('details'),summary=element('summary','Прочитанный текст'),preview=element('pre',file.text);details.open=expanded.has(file.id);details.addEventListener('toggle',()=>details.open?expanded.add(file.id):expanded.delete(file.id));details.append(summary,preview);row.append(details);}
      list.append(row);
    }
    for(const name of pendingFiles)list.append(element('p','Читаю файл: '+name,'hint'));
    $('#dialogs-product-files-empty').hidden=!!files.length||!!pendingFiles.length;
  }
  function render(){
    if(!state)return;
    const saved=product();
    if(!dirty&&!operation)hydrate();
    const approved=isApproved(),invalidFiles=files.some(file=>!file.excluded&&file.status!=='ready'),approvalIssue=productApprovalError(state);
    const conflict=dirty&&(baseRevision!==(saved.revision||0)||baseFingerprint!==fingerprint);
    const status=$('#dialogs-product-status');status.textContent=dirty?'Есть несохранённые изменения':approved?'Согласовано · версия '+saved.revision:'Нужно согласование · версия '+(saved.revision||0);status.className='dialogs-status '+(approved?'good':'warn');
    $('#dialogs-product-conflict').hidden=!conflict;$('#dialogs-product-conflict').textContent=conflict?'Сохранённая версия изменилась в другом окне или после обновления настроек. Скопируйте нужные правки и загрузите сохранённую версию кнопкой сброса; устаревшие данные не будут перезаписаны.':'';
    $('#dialogs-product-approval-note').textContent=settingsDirty?'Сохраните изменения настроек подключения и задания перед согласованием.':dirty?'Изменения ещё не применены. Сохраните их, затем согласуйте новую версию. Автоматические черновики при редактировании выключаются.':approved?'Согласовано '+displayTime(saved.approval.approvedAt)+'. Эта версия используется для ответов всем наблюдаемым поставщикам. Любое изменение материалов, правил, задания, WeChat или языка требует нового согласования.':invalidFiles?'Есть частично прочитанные, неподдерживаемые или ошибочные файлы. Повторите чтение, исключите их из задания или удалите перед согласованием.':approvalIssue||'Проверьте факты и вопросы. Согласование разрешает использовать сохранённую версию при подготовке черновиков.';
    for(const el of $('#dialogs-product-form').querySelectorAll('input,textarea'))el.disabled=!!operation;
    $('#dialogs-product-save').disabled=!!operation||!dirty;
    $('#dialogs-product-extract').disabled=!!operation||!configurationReady()||!sourceReady()||settingsDirty;
    $('#dialogs-product-export').disabled=!!operation||!sourceReady()||settingsDirty;
    $('#dialogs-product-approve').disabled=!!operation||dirty||settingsDirty||!!approvalIssue||approved;
    $('#dialogs-product-approve').textContent=approved?'Версия '+saved.revision+' согласована':'Согласовать версию '+(saved.revision||0);
    $('#dialogs-product-reset').disabled=!!operation||!dirty;
    $('#dialogs-product-extraction-state').textContent=operation==='extract'?'Извлекаю информацию…':operation==='export'?'Формирую промпт…':operation==='import'?'Применяю ответ Claude…':operation==='files'?'Читаю выбранные файлы…':operation==='save'?'Сохраняю…':operation==='approve'?'Согласование…':saved.extraction?'Информация извлечена. Проверьте её перед согласованием.':!configurationReady()?'Без API-ключа используйте «Промпт для Claude · TXT».':'';
    const auto=!!state.settings?.autoDraft;
    $('#dialogs-auto-draft').checked=auto;$('#dialogs-auto-draft').disabled=autoBusy||(!auto&&(!approved||!configurationReady()));
    $('#dialogs-auto-draft-state').textContent=disablePromise?'Выключаю автоматические черновики после изменения данных…':autoBusy?'Изменяю режим…':auto?(state.running?'Автоматические черновики включены для всех выбранных вкладок. Отправка сообщений отключена.':'Автоматические черновики включены. Начните мониторинг, чтобы обрабатывать новые сообщения.') :!approved?'Автоматические черновики выключены. Сохраните и согласуйте сведения о товаре.':!configurationReady()?'Автоматические черновики выключены. Укажите модель и API-ключ в настройках ниже.':'Автоматические черновики выключены. Можно готовить ответы вручную или включить этот режим.';
    renderFiles();
  }
  async function save(){
    if(!dirty)return;
    const result=await command('PRODUCT_SAVE',{product:patch(),revision:baseRevision,fingerprint:baseFingerprint});
    dirty=false;adopt(result);hydrate();
    for(const id of removed)await forgetFile(id);removed.clear();
  }
  async function withOperation(kind,run){if(operation)return;operation=kind;render();try{await run();}catch(error){feedback(error.message,true);}finally{operation='';render();onDirty();}}
  async function addFiles(selected,replacingId=null){
    if(operation||!selected.length)return;
    if(files.length-(replacingId?1:0)+selected.length>8){feedback('Можно прикрепить до 8 файлов. Новые файлы не добавлены; удалите лишние и повторите выбор.',true);return;}
    dirty=true;pauseAutomatic();pendingFiles=selected.map(file=>file.name);
    await withOperation('files',async()=>{
      let records;
      const remaining=files.filter(file=>file.id!==replacingId),textBudget=Math.max(0,PRODUCT_FILE_LIMITS.textTotal-remaining.reduce((sum,file)=>sum+(file.text?.length||0),0)),imageBudget=Math.max(0,PRODUCT_FILE_LIMITS.images-remaining.reduce((sum,file)=>sum+(file.images?.length||0),0));
      try{records=await readProductFiles(selected,{textBudget,imageBudget});}catch(error){records=selected.map(file=>({id:crypto.randomUUID(),name:file.name,mime:file.type,size:file.size,lastModified:file.lastModified,kind:'unsupported',format:'',status:'error',text:'',note:'Чтение не завершено.',warnings:[],error:error.message||'Ошибка чтения файла.',contentHash:'',images:[]}));}
      if(!Array.isArray(records)||records.length!==selected.length)throw new Error('Обработчик файлов вернул неполный результат. Повторите выбор файлов.');
      records=records.map((record,index)=>{originals.set(record.id,selected[index]);return {...record,excluded:false};});
      if(replacingId){const index=files.findIndex(file=>file.id===replacingId);if(index>=0)files.splice(index,1,...records);else files.push(...records);if((product().files||[]).some(file=>file.id===replacingId))removed.add(replacingId);else await forgetFile(replacingId);originals.delete(replacingId);}
      else files.push(...records);
      feedback('Файлы обработаны. Проверьте состояние каждого файла и сохраните изменения.');
    });
    pendingFiles=[];render();onDirty();
  }
  $('#dialogs-product-form').addEventListener('input',event=>{if(event.target.matches('textarea,input[type=url]'))markDirty();});
  $('#dialogs-product-form').addEventListener('submit',event=>{event.preventDefault();withOperation('save',async()=>{await save();feedback('Сведения о товаре сохранены. Проверьте и согласуйте текущую версию.');});});
  $('#dialogs-product-files').addEventListener('change',event=>{const selected=[...event.target.files];event.target.value='';addFiles(selected);});
  $('#dialogs-product-file-retry').addEventListener('change',event=>{const selected=[...event.target.files],id=retryId;retryId=null;event.target.value='';addFiles(selected,id);});
  $('#dialogs-product-reset').addEventListener('click',()=>withOperation('reset',async()=>{for(const file of files)if(!(product().files||[]).some(saved=>saved.id===file.id))await forgetFile(file.id);removed.clear();dirty=false;hydrate();feedback('Загружена сохранённая версия. Несохранённые правки сброшены.');}));
  $('#dialogs-product-extract').addEventListener('click',()=>{
    // Keep permission request in the original user gesture, before any storage awaits.
    const provider=providerInfo(ai.provider),permission=chrome.permissions.request({origins:[provider.origin]});
    withOperation('extract',async()=>{if(!await permission)throw new Error('Доступ к '+provider.label+' API не разрешён. Материалы не передавались.');await save();const result=await command('PRODUCT_EXTRACT',{revision:product().revision||0,fingerprint});dirty=false;adopt(result);hydrate();feedback('Важная информация извлечена. Проверьте факты и вопросы, затем согласуйте версию.');});
  });
  $('#dialogs-product-export').addEventListener('click',()=>withOperation('export',async()=>{$('#dialogs-prompt-panel').hidden=true;if(settingsDirty)throw new Error('Сначала сохраните настройки задания.');await save();const result=await command('EXPORT_PRODUCT_PROMPT',{revision:product().revision||0,fingerprint});if(result.state)adopt(result);exportPrompt(result.promptExport,{kind:'product'});feedback('Промпт готов. Скопируйте его или скачайте TXT и перенесите в Claude.');}));
  $('#dialogs-product-approve').addEventListener('click',()=>withOperation('approve',async()=>{if(dirty||settingsDirty)throw new Error('Сначала сохраните изменения.');const result=await command('PRODUCT_APPROVE',{revision:product().revision||0,fingerprint});adopt(result);feedback('Информация согласована. Можно готовить черновики ответов.');}));
  $('#dialogs-auto-draft').addEventListener('change',async()=>{
    const enabled=$('#dialogs-auto-draft').checked;
    const provider=providerInfo(ai.provider),permission=enabled?chrome.permissions.request({origins:[provider.origin]}):Promise.resolve(true);
    autoBusy=true;render();
    try{if(!await permission)throw new Error('Доступ к '+provider.label+' API не разрешён. Автоматические черновики не включены.');if(enabled&&(!isApproved()||!configurationReady()))throw new Error('Сначала согласуйте сведения о товаре и сохраните настройки '+provider.label+'.');adopt(await command('AUTODRAFT',{enabled}));feedback(enabled?'Автоматические черновики включены. Сообщения не отправляются.':'Автоматические черновики выключены.');}catch(error){feedback(error.message,true);}finally{autoBusy=false;render();}
  });
  return {
    render(nextState,nextAI,nextFingerprint){state=nextState;ai=nextAI;fingerprint=nextFingerprint||nextState?.product?.fingerprint||'';if(!dirty&&!operation)hydrate();render();},
    isDirty:()=>dirty||settingsDirty,
    isApproved,
    async importResult(request,text,imagesAttached){
      let applied=false;
      await withOperation('import',async()=>{if(dirty||settingsDirty)throw new Error('Сначала сохраните изменения и сформируйте новый промпт.');const result=await command('IMPORT_PRODUCT_RESULT',{request,text,imagesAttached});dirty=false;adopt(result);hydrate();applied=true;feedback('Ответ Claude применён. Проверьте факты и вопросы, затем согласуйте новую версию.');});
      return applied;
    },
    setSettingsDirty(value){settingsDirty=value;if(value)pauseAutomatic();render();onDirty();},
  };
}
