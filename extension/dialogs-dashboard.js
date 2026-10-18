import {displayTime} from './lib/time.js';
import {setupProductUI} from './dialogs-product.js';
import {canPrepareDraft} from './lib/dialogs.js';
import {providerInfo} from './lib/dialog-ai.js';

const $=selector=>document.querySelector(selector);
const PLATFORMS={'1688':'1688',alibaba:'Alibaba',mic:'Made-in-China'};
const STATUS={unbound:['Не выбрана',''],ready:['Чат доступен','good'],ok:['Чат доступен','good'],observing:['Мониторинг','good'],scanning:['Проверка…',''],loading:['Загрузка…',''],unsupported:['Страница не распознана','warn'],partial:['Прочитана часть данных','warn'],closed:['Вкладка закрыта','bad'],missing:['Вкладка не найдена','bad'],error:['Ошибка проверки','bad'],blocked:['Нужно вмешательство','warn'],login:['Нужен вход','warn'],captcha:['Проверка площадки','warn'],paused:['Мониторинг остановлен',''],stale:['Данные устарели','warn'],idle:['Ожидает проверки','']};
const FOLDER_STATUS={disabled:['Выключено',''],idle:['Ожидание задания',''],ready:['Подключено','good'],connected:['Подключено','good'],waiting:['Обработчик не запущен','warn'],claude_missing:['Claude Code не найден','warn'],pending:['В очереди',''],preparing:['Подготовка задания',''],queued:['В очереди',''],running:['Claude обрабатывает',''],paused:['Приостановлено','warn'],offline:['Нет соединения с Claude','warn'],needslogin:['Нужен вход в Claude Code','warn'],needs_login:['Нужен вход в Claude Code','warn'],authentication_required:['Нужен вход в Claude Code','warn'],subscription_auth_required:['Нужен вход через подписку Claude','warn'],subscription_auth_unverified:['Не удалось проверить вход в Claude Code','warn'],usage_limit:['Достигнут лимит Claude','warn'],missing:['Локальный модуль не найден','warn'],unavailable:['Обработчик недоступен','warn'],error:['Ошибка','bad'],stale:['Контекст изменился','warn'],done:['Обработано','good'],accepted:['Результат принят','good'],cancelled:['Отменено',''],awaiting_limit:['Ответ готов · ожидание лимита площадки','warn'],sending:['Отправка поставщику','warn'],sent:['Кнопка отправки нажата','good'],send_unknown:['Отправка не подтверждена — проверьте чат','warn'],unknown:['Результат операции неизвестен','warn']};
const FOLDER_PAUSE={offline:'Нет соединения с Claude. Подключите интернет и нажмите «Возобновить обработку».',authentication_required:'Войдите в Claude Code через вашу подписку, затем нажмите «Возобновить обработку».',subscription_auth_required:'Войдите в Claude Code через аккаунт с подпиской Claude, затем нажмите «Возобновить обработку».',subscription_auth_unverified:'Не удалось проверить вход в Claude Code. Проверьте его установку и авторизацию, затем нажмите «Возобновить обработку».',usage_limit:'Достигнут лимит подписки Claude. Возобновите обработку после восстановления лимита.',claude_update_required:'Обновите Claude Code, затем возобновите обработку.',claude_failed:'Claude завершил задание с ошибкой. Проверьте журнал обработчика перед возобновлением.',invalid_claude_output:'Ответ Claude не удалось прочитать. Проверьте журнал обработчика перед возобновлением.'};
let folderState={enabled:false,auto:false,autoSend:false,model:'sonnet',status:'disabled',jobs:[]},folderDirty=false,folderPausing=false;
let state=null, ai={provider:'openai',model:'',keyStored:false}, productFingerprint='', productUI, tabs=[], selectedKey=null, settingsDirty=false, settingsProvider='openai', readUnreadDirty=false, loading=false, generating=new Set(), historySignature='', manualExport=null;
const tabChoices=new Map(), edits=new Map(), busy=new Set(), manualRequests=new Map();

function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function feedback(text,error=false){const el=$('#dialogs-feedback');el.textContent=text;el.classList.toggle('error',error);el.hidden=!text;}
function chosen(){return state?.conversations?.[selectedKey]||null;}
function providerProfile(provider){return ai.providers?.[provider]||(provider===(ai.provider||'openai')?ai:{model:'',keyStored:false});}
function manualRequestStale(item,request){return !!request&&(request.revision!==item.revision||request.fingerprint!==item.fingerprint||request.productFingerprint!==productFingerprint);}
function date(at){return at==null?'Время не указано':displayTime(at);}
function safeUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(^|\.)(1688\.com|alibaba\.com|made-in-china\.com)$/.test(u.hostname)?u.href:null;}catch{return null;}}
async function command(type,payload={}){const result=await chrome.runtime.sendMessage({type:'DIALOGS_'+type,...payload});if(!result?.ok)throw new Error(result?.error||'Расширение не ответило. Перезагрузите эту страницу.');return result;}
function adopt(result){if(result.state)state=result.state;if(result.folder)folderState=result.folder;if(result.ai)ai=result.ai;if(typeof result.productFingerprint==='string')productFingerprint=result.productFingerprint;else if(result.state?.product?.fingerprint)productFingerprint=result.state.product.fingerprint;render();}
async function refresh(){if(loading)return;loading=true;try{adopt(await command('GET'));}catch(error){feedback(error.message,true);}finally{loading=false;}}
async function act(name,payload={},message=''){const result=await command(name,payload);if(result.state)adopt(result);else await refresh();if(message)feedback(message);return result;}
function action(selector,handler){$(selector).addEventListener('click',async()=>{if(busy.has(selector))return;busy.add(selector);$(selector).disabled=true;try{await handler();}catch(error){feedback(error.message,true);}finally{busy.delete(selector);$(selector).disabled=false;if(state)render();}});}
function makeButton(label,handler,className='button secondary'){const button=node('button',label,className);button.type='button';button.addEventListener('click',async()=>{button.disabled=true;try{await handler();}catch(error){feedback(error.message,true);}finally{if(button.isConnected)button.disabled=false;}});return button;}
function threadFlags(conversation){const result=[];if(conversation.takeover)result.push(['Под вашим управлением','']);if(conversation.paused)result.push(['На паузе','']);if(conversation.unanswered)result.push(['Требует ответа','warn']);if(conversation.unread===true||Number(conversation.unread)>0)result.push(['Непрочитано на площадке','warn']);if(conversation.needsRead)result.push([conversation.messages?.length||readerDetail(conversation)?'Нужна проверка истории':'Нужно открыть историю','']);if(conversation.autoDraft?.status==='pending')result.push(['ИИ готовит черновик','']);if(conversation.autoDraft?.status==='error')result.push(['Ошибка черновика','warn']);if(conversation.draft)result.push([conversation.draft.status==='stale'?'Черновик устарел':'Есть черновик',conversation.draft.status==='stale'?'warn':'good']);return result;}
function canDraft(conversation){return !!conversation&&conversation.unanswered&&conversation.identityReliable&&conversation.orderReliable&&conversation.tailKnown&&conversation.contentReady!==false&&!conversation.needsRead&&!conversation.paused&&!conversation.takeover;}
function readerDetail(conversation){return typeof conversation?.detail==='string'?conversation.detail.trim().slice(0,1200):'';}
function draftBlockReason(conversation){
  if(!conversation)return 'Выберите переписку.';
  if(conversation.takeover)return 'Вы взяли разговор на себя. Подготовка ответа с ИИ приостановлена.';
  if(conversation.paused)return 'Переписка на паузе.';
  if(!conversation.identityReliable)return readerDetail(conversation)||'Пока не удалось надёжно определить поставщика.';
  if(conversation.contentReady===false)return readerDetail(conversation)||'Не все сообщения или вложения прочитаны. Причины показаны в истории переписки.';
  if(!conversation.orderReliable||!conversation.tailKnown||conversation.needsRead)return readerDetail(conversation)||'Нужна достоверная последняя часть переписки. Откройте её в выбранной вкладке и повторите проверку.';
  if(!conversation.unanswered)return 'В доступной истории нет подтверждённого сообщения продавца, требующего ответа.';
  if(!productUI?.isApproved())return 'Сохраните и согласуйте информацию о товаре в блоке выше. Она применяется ко всем наблюдаемым поставщикам.';
  if(settingsDirty)return 'Сначала сохраните изменения настроек.';
  if(!ai.model?.trim()||!ai.keyStored)return 'Для API укажите модель и сохраните ключ '+providerInfo(ai.provider).label+'. Без ключа используйте промпт TXT или папку Claude.';
  return 'По нажатию история этой переписки и согласованные сведения о товаре будут переданы в '+providerInfo(ai.provider).label+'. Ответ останется здесь как черновик.';
}

function renderPrompt(){
  if(!manualExport)return;
  const product=manualExport.kind==='product',request=manualExport.request;
  const stale=product&&(request.revision!==state?.product?.revision||request.fingerprint!==productFingerprint);
  const dirty=productUI?.isDirty(),images=manualExport.requiredImages||[];
  $('#dialogs-prompt-import-note').textContent=stale?'Товар или задание изменились после создания промпта. Сформируйте новый промпт и получите новый ответ Claude.':dirty?'Есть несохранённые изменения. Сохраните их и сформируйте новый промпт.':images.length&&!$('#dialogs-prompt-images').checked?'Подтвердите, что приложили все перечисленные изображения к запросу в Claude.':'Импорт связан с версией товара, для которой создан этот промпт.';
  $('#dialogs-prompt-apply').disabled=!product||stale||dirty||!$('#dialogs-prompt-response').value.trim()||!!images.length&&!$('#dialogs-prompt-images').checked||busy.has('#dialogs-prompt-apply');
}
function exportPrompt(value,{kind,key}={}){
  if(!value||typeof value.text!=='string'||!value.request)throw new Error('Не удалось получить промпт. Повторите формирование.');
  manualExport={...value,kind,key};
  const product=kind==='product';
  $('#dialogs-prompt-heading').textContent=product?'Промпт для Claude · сведения о товаре':'Промпт для Claude · '+(PLATFORMS[state?.conversations?.[key]?.platform]||'')+' · '+(state?.conversations?.[key]?.title||'Выбранный поставщик');
  $('#dialogs-prompt-text').value=value.text;
  $('#dialogs-prompt-note').textContent=product?'Перенесите запрос в Claude. Полученный JSON вставьте ниже и примените к этой версии товара.':'Перенесите запрос в Claude. Затем вставьте полученный текст в черновик этой переписки и сохраните его. Продавцу ничего не отправляется.';
  const warnings=[...(value.warnings||[]),...(value.requiredImages||[]).map(item=>'Приложите изображение: '+(typeof item==='string'?item:item.name||item.label||item.imageKey||'Изображение'))];
  $('#dialogs-prompt-warnings').textContent=warnings.join('\n');$('#dialogs-prompt-warnings').hidden=!warnings.length;
  $('#dialogs-prompt-import').hidden=!product;
  $('#dialogs-prompt-images-label').hidden=!value.requiredImages?.length;
  $('#dialogs-prompt-images').checked=false;$('#dialogs-prompt-response').value='';
  $('#dialogs-prompt-panel').hidden=false;renderPrompt();$('#dialogs-prompt-panel').scrollIntoView({behavior:'smooth',block:'start'});
}

function renderBindings(){const container=$('#dialogs-bindings');container.replaceChildren();for(const [platform,label] of Object.entries(PLATFORMS)){const binding=state?.bindings?.[platform]||{},card=node('section',undefined,'panel dialogs-platform'),heading=node('div',undefined,'panel-heading');card.dataset.platform=platform;const [status,tone]=STATUS[binding.status]||['Статус проверки: '+(binding.status||'ожидание'),'warn'];heading.append(node('h3',label),node('span',status,'dialogs-status '+tone));const select=node('select');select.id='dialogs-tab-'+platform;select.setAttribute('aria-label','Вкладка '+label);select.append(new Option('Выберите открытую вкладку',''));const options=tabs.filter(tab=>tab.platform===platform);if(binding.tabId!=null&&!options.some(tab=>tab.id===binding.tabId))options.unshift({id:binding.tabId,title:'Сохранённая вкладка',url:binding.url});for(const tab of options)select.append(new Option((tab.title||tab.url||'Вкладка')+' · '+(tab.url||''),String(tab.id)));const choice=tabChoices.get(platform);select.value=choice!=null&&options.some(tab=>String(tab.id)===choice)?choice:(binding.tabId==null?'':String(binding.tabId));select.addEventListener('change',()=>tabChoices.set(platform,select.value));const controls=node('div',undefined,'actions');const bind=makeButton('Выбрать',async()=>{const value=select.value;if(!value)throw new Error('Сначала выберите открытую вкладку '+label+'.');await act('BIND_TAB',{platform,tabId:Number(value)},'Вкладка '+label+' выбрана.');});const scan=makeButton('Проверить',()=>act('SCAN',{platform},'Проверка '+label+' завершена.'));const remove=makeButton('Отвязать',async()=>{tabChoices.delete(platform);await act('UNBIND_TAB',{platform},'Вкладка '+label+' отключена от мониторинга.');},'link-button');bind.disabled=!state;scan.disabled=!state||binding.tabId==null;remove.disabled=binding.tabId==null;controls.append(bind,scan,remove);card.append(heading,select,controls,node('p',binding.detail||(binding.tabId==null?'Выберите вкладку центра сообщений.':'Ожидание проверки выбранной вкладки.'),'hint'),node('p','Последняя проверка: '+(binding.checkedAt==null?'ещё не выполнялась':date(binding.checkedAt)),'hint'));container.append(card);}}
function filteredConversations(){const query=$('#dialogs-search').value.trim().toLocaleLowerCase(),filter=$('#dialogs-filter').value;return Object.values(state?.conversations||{}).filter(item=>{if(filter==='unanswered'&&!item.unanswered)return false;if(filter==='unread'&&!(item.unread===true||Number(item.unread)>0))return false;if(filter==='takeover'&&!item.takeover)return false;if(filter==='paused'&&!item.paused)return false;const haystack=[item.title,item.platform,PLATFORMS[item.platform],item.url,item.preview,...(item.messages||[]).map(m=>m.text)].filter(Boolean).join(' ').toLocaleLowerCase();return !query||haystack.includes(query);}).sort((a,b)=>Number(b.unanswered)-Number(a.unanswered)||(b.updatedAt||0)-(a.updatedAt||0)||a.key.localeCompare(b.key));}
function renderList(){const conversations=filteredConversations(),all=Object.values(state?.conversations||{}),list=$('#dialogs-list');$('#dialogs-count').textContent=all.length+' · требуют ответа: '+all.filter(c=>c.unanswered).length;list.replaceChildren();for(const conversation of conversations){const button=node('button',undefined,'dialogs-thread'+(conversation.key===selectedKey?' selected':''));button.type='button';button.dataset.key=conversation.key;button.setAttribute('aria-pressed',String(conversation.key===selectedKey));button.append(node('strong',conversation.title||'Поставщик не определён'),node('p',(PLATFORMS[conversation.platform]||conversation.platform)+' · '+date(conversation.updatedAt),'hint'));const last=(conversation.messages||[]).at(-1);button.append(node('div',last?.text||conversation.preview||'История ещё не прочитана','dialogs-preview'));const flags=node('div',undefined,'dialogs-thread-flags');for(const [label,tone] of threadFlags(conversation))flags.append(node('span',label,'dialogs-status '+tone));button.append(flags);button.addEventListener('click',()=>{if(manualExport?.kind==='draft'&&manualExport.key!==conversation.key){manualExport=null;$('#dialogs-prompt-panel').hidden=true;}selectedKey=conversation.key;historySignature='';renderList();renderDetail();});list.append(button);}$('#dialogs-empty').hidden=conversations.length>0;$('#dialogs-empty').textContent=all.length?'Переписок с такими условиями нет.':'Выберите вкладки и запустите проверку. Здесь появятся прочитанные переписки и доступный список чатов.';}
function renderHistory(conversation){
  const signature=JSON.stringify([conversation.key,conversation.messages,conversation.archivedMessages,readerDetail(conversation)]);
  if(signature===historySignature)return;
  const previousArchive=$('#dialogs-history .dialogs-history-archive'),archiveOpen=previousArchive?.dataset.key===conversation.key&&previousArchive.open;
  historySignature=signature;const history=$('#dialogs-history');history.replaceChildren();
  for(const message of conversation.messages||[]){
    const block=node('div',undefined,'dialogs-message '+message.direction),label={inbound:'Поставщик',outbound:'Вы',unknown:'Автор не определён',system:'Система'}[message.direction]||'Автор не определён';
    block.append(node('p',label+' · '+date(message.at),'dialogs-message-meta'),node('p',message.text||''));
    if(message.format==='unrecognized')block.append(node('p','Формат сообщения не распознан полностью.','hint'));
    for(const attachment of message.attachments||[]){
      const file=node('div',undefined,'dialogs-attachment'),resolution=attachment.resolution||{},kind={image:'Изображение',file:'Файл',audio:'Аудио',video:'Видео',link:'Ссылка',unknown:'Вложение'}[attachment.type]||'Вложение';
      file.append(node('strong',kind+(attachment.name?' · '+attachment.name:'')));
      const status=resolution.status==='ready'?(resolution.images?.length?'Доступно для анализа ИИ':'Содержимое прочитано'):resolution.status==='partial'?'Вложение прочитано частично':resolution.status==='unsupported'?'Формат вложения не поддерживается':resolution.status==='error'?'Ошибка чтения вложения':attachment.type==='link'?'Ссылка из сообщения. Целевая страница не загружалась.':attachment.contentRead?'Содержимое прочитано':attachment.contentReady?'Доступно для анализа ИИ':'Вложение ещё не обработано';
      file.append(node('p',status,'hint'));
      if(resolution.warnings?.length)file.append(node('p',resolution.warnings.join('\n'),'hint'));
      if(resolution.retryAt)file.append(node('p','Повторная проверка: '+date(resolution.retryAt),'hint'));
      const readableText=resolution.text||(attachment.contentRead?attachment.text:'');
      if(readableText){const details=node('details'),summary=node('summary','Прочитанный текст вложения');details.append(summary,node('pre',readableText));file.append(details);}
      if(resolution.images?.length)file.append(node('p','Локально подготовлено изображений: '+resolution.images.length+'. Анализ ИИ выполняется только при подготовке ответа.','hint'));
      block.append(file);
    }
    history.append(block);
  }
  if(!conversation.messages?.length)history.append(node('p',readerDetail(conversation)||'Список чатов обнаружен, но история этой переписки ещё не прочитана. Откройте её на площадке и нажмите «Проверить».','hint'));
  const archived=conversation.archivedMessages||[];
  if(archived.length){
    const archive=node('details',undefined,'dialogs-history-archive');archive.dataset.key=conversation.key;archive.open=!!archiveOpen;
    archive.append(node('summary','Исправленные записи истории ('+archived.length+')'),node('p','Предыдущие версии наблюдений сохранены для проверки. Они не используются для подготовки ответов с ИИ.','hint'));
    for(const message of archived){
      const entry=node('div',undefined,'dialogs-message'),label={inbound:'Поставщик',outbound:'Вы',unknown:'Автор не определён',system:'Система'}[message.direction]||'Автор не определён';
      entry.append(node('p',label+' · '+date(message.at),'dialogs-message-meta'),node('p',message.text||''),node('p','Исправлено при чтении: '+date(message.archivedAt),'dialogs-message-meta'));
      for(const attachment of message.attachments||[])entry.append(node('p','Вложение: '+(attachment.name||attachment.type||'Без имени'),'hint'));
      archive.append(entry);
    }
    history.append(archive);
  }
  history.scrollTop=history.scrollHeight;
}
function renderDetail(){
  const conversation=chosen();
  $('#dialogs-detail').hidden=!conversation;
  $('#dialogs-select-hint').hidden=!!conversation;
  if(!conversation)return;
  $('#dialogs-supplier').textContent=conversation.title||'Поставщик не определён';
  $('#dialogs-conversation-status').textContent=[PLATFORMS[conversation.platform],...threadFlags(conversation).map(([label])=>label)].filter(Boolean).join(' · ');
  const url=safeUrl(conversation.url),link=$('#dialogs-source');
  link.hidden=!url;
  if(url)link.href=url;else link.removeAttribute('href');
  $('#dialogs-takeover').textContent=conversation.takeover?'Вернуть подготовку черновиков':'Взять разговор на себя';
  $('#dialogs-mute').textContent=conversation.paused?'Снять паузу переписки':'Пауза для этой переписки';
  const detail=readerDetail(conversation);
  $('#dialogs-reader-detail').textContent=detail;
  $('#dialogs-reader-detail').hidden=!detail;
  const coverage=conversation.coverage;
  $('#dialogs-coverage').hidden=!coverage;
  $('#dialogs-coverage').textContent=coverage?['Распознано сообщений: '+(coverage.capturedMessages??0)+' из '+(coverage.totalRows??0)+' строк.',coverage.unknownSenders?'Не определён автор: '+coverage.unknownSenders+'.':'',coverage.attachments?'Вложений: '+coverage.attachments+'.':'',coverage.unreadAttachments?'Недоступных вложений: '+coverage.unreadAttachments+'.':'',coverage.unsupportedMessages?'Нераспознанных сообщений: '+coverage.unsupportedMessages+'.':'',coverage.unmatchedTextNodes?'Не разобрано элементов истории: '+coverage.unmatchedTextNodes+'.':'',coverage.limited?'Объём чтения ограничен.':''].filter(Boolean).join(' '):'';
  $('#dialogs-history-note').hidden=!!detail;
  $('#dialogs-history-note').textContent=conversation.orderReliable&&conversation.tailKnown&&!conversation.needsRead?'Показана доступная на странице история. Последнее сообщение определено.':'История неполная или порядок сообщений не подтверждён. По одному значку «непрочитано» ответ не создаётся.';
  renderHistory(conversation);
  const edit=edits.get(conversation.key),draft=conversation.draft;
  $('#dialogs-draft-text').value=edit?edit.text:(draft?.text||'');
  $('#dialogs-draft-reason').hidden=!draft?.reason;
  $('#dialogs-draft-reason').textContent=draft?.reason||'';
  const auto=conversation.autoDraft;
  const willRetry=state.running&&state.settings?.autoDraft&&productUI?.isApproved()&&!conversation.paused&&!conversation.takeover;
  const retryNote=auto?.retryAt?(willRetry?'Следующая попытка: '+date(auto.retryAt):'Повтор возможен с '+date(auto.retryAt)+' при включённых мониторинге и автоматических черновиках.'):'';
  $('#dialogs-auto-status').hidden=!auto?.status;
  $('#dialogs-auto-status').textContent=auto?.status==='pending'?'ИИ готовит черновик.':auto?.status==='error'?[auto.error||'Черновик не подготовлен.',retryNote].filter(Boolean).join(' '):auto?.status==='done'?'Черновик подготовлен: '+date(auto.at):'';
  const manualStale=manualRequestStale(conversation,manualRequests.get(conversation.key));
  const stale=manualStale||edit&&(edit.revision!==conversation.revision||edit.fingerprint!==conversation.fingerprint);
  $('#dialogs-draft-status').textContent=manualStale?'Переписка или товар изменились после создания промпта. Сформируйте новый промпт и получите новый ответ Claude.':stale?'Переписка изменилась после начала редактирования. Проверьте новые сообщения; устаревший черновик не будет сохранён.':edit?'Есть несохранённые изменения.':draft?.status==='stale'?'Черновик устарел: в переписке появились изменения.':draft?'Сохранён локально: '+date(draft.createdAt):manualRequests.has(conversation.key)?'Промпт сформирован. Вставьте ответ Claude в поле выше.':'Черновик ещё не создан.';
  const ready=canDraft(conversation);
  $('#dialogs-generate-hint').textContent=draftBlockReason(conversation);
  $('#dialogs-generate').textContent=generating.has(conversation.key)?'Подготовка ответа…':'Подготовить ответ через API';
  $('#dialogs-generate').disabled=!ready||!productUI?.isApproved()||!canPrepareDraft(state,conversation.key)||!ai.model?.trim()||!ai.keyStored||generating.has(conversation.key)||auto?.status==='pending';
  $('#dialogs-export-draft').disabled=!ready||!productUI?.isApproved()||!canPrepareDraft(state,conversation.key)||generating.has(conversation.key)||auto?.status==='pending';
  $('#dialogs-folder-draft').disabled=!ready||!productUI?.isApproved()||!canPrepareDraft(state,conversation.key)||!folderState.enabled||folderPausing||generating.has(conversation.key)||auto?.status==='pending';
  $('#dialogs-folder-draft').title=folderState.autoSend?'После обработки ответ может быть отправлен автоматически, если контекст не изменился.':'Ответ будет сохранён черновиком.';
  $('#dialogs-save-draft').disabled=!ready||!productUI?.isApproved()||!canPrepareDraft(state,conversation.key)||!edit?.text.trim()||!!stale||generating.has(conversation.key);
  $('#dialogs-discard-draft').disabled=(!edit&&!draft)||generating.has(conversation.key);
  $('#dialogs-draft-text').disabled=!ready||generating.has(conversation.key);
  for(const id of busy)if($(id))$(id).disabled=true;
}
function renderSettings(){if(!settingsDirty){$('#dialogs-brief').value=state.settings?.brief||'';$('#dialogs-wechat').value=state.settings?.wechat||'';$('#dialogs-language').value=state.settings?.language||'';settingsProvider=ai.provider||'openai';$('#dialogs-provider').value=settingsProvider;$('#dialogs-model').value=providerProfile(settingsProvider).model||'';}const info=providerInfo(settingsProvider),profile=providerProfile(settingsProvider);$('#dialogs-model-label').textContent='Модель '+info.label+' API';$('#dialogs-api-key-label').textContent='API-ключ '+info.label;$('#dialogs-key-status').textContent=profile.keyStored?'Ключ сохранён. Его значение не показывается.':'Ключ не сохранён.';$('#dialogs-save-settings').disabled=busy.has('#dialogs-save-settings');}
function renderEvents(){const events=state.events||[],list=$('#dialogs-events');list.replaceChildren();for(const event of [...events].slice(-100).reverse()){const item=node('li'),at=event.at??event.time;item.append(node('time',date(at)),node('span',[(PLATFORMS[event.platform]||event.platform),event.detail||event.message||event.type||event.event].filter(Boolean).join(' · ')));list.append(item);}$('#dialogs-events-empty').hidden=events.length>0;}
function folderSettings(){return {model:$('#dialogs-folder-model').value.trim(),auto:$('#dialogs-folder-auto').checked,autoSend:$('#dialogs-folder-send').checked};}
function renderFolder(){
  const folder=folderState,enabled=folder.enabled===true,approved=productUI?.isApproved(),worker=folder.worker||{};
  if(!folderDirty){$('#dialogs-folder-model').value=folder.model||'sonnet';$('#dialogs-folder-auto').checked=folder.auto===true;$('#dialogs-folder-send').checked=folder.autoSend===true;}
  const effectiveStatus=enabled&&worker.status==='paused'?(FOLDER_STATUS[worker.pauseReason]?worker.pauseReason:'paused'):folder.status;
  const [label,tone]=FOLDER_STATUS[effectiveStatus]||[effectiveStatus||'Выключено',''];
  $('#dialogs-folder-status').textContent=folderPausing?'Останавливаю обработку…':label;$('#dialogs-folder-status').className='dialogs-status '+tone;
  $('#dialogs-folder-detail').textContent=folder.detail||(!enabled?'Подключите локальный модуль, чтобы сохранять задания в папку.':'Обработка подключена. Состояние Claude обновляется при выполнении заданий.');
  $('#dialogs-folder-path').textContent=folder.folder?'Папка заданий: '+folder.folder:'Путь к папке появится после подключения локального модуля.';
  $('#dialogs-folder-worker').textContent=[worker.running?'Локальный обработчик запущен.':enabled?'Локальный обработчик пока не сообщил о работе.':'',worker.heartbeat?'Последний сигнал: '+date(worker.heartbeat)+'.':'',worker.status==='paused'?(FOLDER_PAUSE[worker.pauseReason]||'Обработчик приостановлен. Проверьте его журнал и нажмите «Возобновить обработку».'):'',folder.status==='claude_missing'?'Claude Code не найден. Установите его по инструкции ниже.':''].filter(Boolean).join(' ');
  $('#dialogs-folder-connect').textContent=enabled?(worker.status==='paused'?'Возобновить обработку':'Переподключить папку'):'Подключить / возобновить';
  $('#dialogs-folder-connect').disabled=folderPausing;
  $('#dialogs-folder-save').disabled=!folderDirty||folderPausing;
  $('#dialogs-folder-stop').disabled=!enabled||folderPausing;
  $('#dialogs-folder-poll').disabled=!enabled||folderPausing;
  $('#dialogs-folder-auto').disabled=!approved&&!$('#dialogs-folder-auto').checked;$('#dialogs-folder-send').disabled=!approved&&!$('#dialogs-folder-send').checked;
  $('#dialogs-folder-send-note').textContent=folder.autoSend&&enabled?'Автоотправка включена: ответы Claude будут отправляться поставщикам после проверки согласованного товара и актуальности переписки. Чтобы оставить только черновики, снимите отметку и сохраните настройки.':'Отправка выключена. Полученные ответы остаются черновиками для проверки. Для автообработки и отправки сначала согласуйте товар.';
  $('#dialogs-folder-edits').hidden=!folderDirty;$('#dialogs-folder-edits').textContent=folderDirty?'Настройки папки изменены, но ещё не сохранены. Действует сохранённый режим.':'';
  const list=$('#dialogs-folder-jobs');list.replaceChildren();const jobs=Array.isArray(folder.jobs)?folder.jobs:[];
  for(const job of [...jobs].sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,50)){
    const row=node('li');row.dataset.jobId=job.id;const heading=node('div',undefined,'panel-heading'),[status,color]=FOLDER_STATUS[job.status]||[job.status||'Ожидание',''];
    const conversation=state.conversations?.[job.key];heading.append(node('strong',job.kind==='product'?'Сведения о товаре':conversation?(PLATFORMS[conversation.platform]||conversation.platform)+' · '+(conversation.title||job.key):job.key||'Ответ поставщику'),node('span',status,'dialogs-status '+color));
    row.append(heading,node('p',date(job.at)+' · '+String(job.id||''),'hint'));if(job.detail)row.append(node('p',job.detail,'hint'));
    const controls=node('div',undefined,'actions');
    if(['error','offline','needslogin','needs_login','unknown'].includes(job.status)){const retry=makeButton('Повторить',()=>act('FOLDER_RETRY',{id:job.id},'Повтор задания запрошен.'),'link-button');retry.disabled=!enabled||folderPausing||!!productUI?.isDirty();controls.append(retry);}
    if(['preparing','queued','pending','running','done','awaiting_limit','error','offline','needslogin','needs_login','unknown'].includes(job.status))controls.append(makeButton('Отменить',()=>act('FOLDER_CANCEL',{id:job.id},'Задание отменено.'),'link-button'));
    if(controls.childNodes.length)row.append(controls);list.append(row);
  }
  $('#dialogs-folder-empty').hidden=jobs.length>0;
}
async function pauseFolderOnEdit(draftChanged=false){
  if((!draftChanged&&!productUI?.isDirty())||!folderState.enabled||folderPausing)return;
  folderPausing=true;renderFolder();
  try{adopt(await command('FOLDER_SETTINGS',{enabled:false,auto:false,autoSend:false}));feedback(draftChanged?'Обработка через папку остановлена, пока вы редактируете черновик. Сохраните изменения перед возобновлением.':'Обработка через папку остановлена после изменения товара или задания. Сохраните данные, согласуйте их и возобновите обработку.');}catch(error){feedback('Не удалось остановить обработку через папку: '+error.message,true);}finally{folderPausing=false;render();}
}
function render(){if(!state)return;productUI?.render(state,ai,productFingerprint);const bound=Object.values(state.bindings||{}).some(binding=>binding.tabId!=null);$('#dialogs-run-state').textContent=state.running?'Мониторинг работает':'Мониторинг остановлен';$('#dialogs-run-state').classList.toggle('running',!!state.running);$('#dialogs-start').disabled=!!state.running||!bound;$('#dialogs-stop').disabled=!state.running;$('#dialogs-scan').disabled=!bound;if(state.running||!readUnreadDirty)$('#dialogs-read-unread').checked=state.readUnread!==false;$('#dialogs-read-unread').disabled=!!state.running;renderBindings();renderList();renderDetail();renderSettings();renderEvents();renderPrompt();renderFolder();for(const id of busy)if($(id))$(id).disabled=true;}
async function refreshTabs(){const result=await command('LIST_TABS');tabs=result.tabs||[];renderBindings();}

action('#dialogs-refresh-tabs',refreshTabs);
action('#dialogs-start',async()=>{await act('START',{readUnread:$('#dialogs-read-unread').checked},folderState.enabled&&folderState.autoSend?'Мониторинг запущен. Автоотправка через папку включена.':'Мониторинг запущен. Отправка сообщений отключена.');readUnreadDirty=false;});
$('#dialogs-read-unread').addEventListener('change',()=>{readUnreadDirty=true;});
action('#dialogs-stop',()=>act('STOP',{},'Мониторинг остановлен.'));
action('#dialogs-scan',()=>act('SCAN',{},'Проверка выбранных вкладок завершена.'));
action('#dialogs-takeover',()=>{const item=chosen();return act('CONTROL',{key:item.key,takeover:!item.takeover},item.takeover?'Подготовка черновиков снова доступна.':'Разговор под вашим управлением. ИИ-черновики для него приостановлены.');});
action('#dialogs-mute',()=>{const item=chosen();return act('CONTROL',{key:item.key,paused:!item.paused},item.paused?'Пауза переписки снята.':'Переписка поставлена на паузу.');});
action('#dialogs-save-draft',async()=>{const item=chosen(),edit=edits.get(item.key);if(!edit)return;const request=manualRequests.get(item.key);await act('SAVE_DRAFT',{key:item.key,text:edit.text,revision:edit.revision,fingerprint:edit.fingerprint,...(request?{request}:{})},'Черновик сохранён локально.');edits.delete(item.key);manualRequests.delete(item.key);});
action('#dialogs-discard-draft',async()=>{const item=chosen();await act('DISCARD_DRAFT',{key:item.key},'Черновик удалён.');edits.delete(item.key);manualRequests.delete(item.key);});
action('#dialogs-export-draft',async()=>{const item=chosen(),previousEdit=edits.get(item.key);if(previousEdit&&!window.confirm('В черновике есть несохранённый текст. Сбросить его и сформировать новый промпт для текущей переписки?'))return;$('#dialogs-prompt-panel').hidden=true;const result=await command('EXPORT_DRAFT_PROMPT',{key:item.key});if(result.state)adopt(result);manualRequests.set(item.key,result.promptExport.request);if(edits.get(item.key)===previousEdit)edits.delete(item.key);exportPrompt(result.promptExport,{kind:'draft',key:item.key});feedback('Промпт готов. Ответ Claude можно вставить в черновик этой переписки.');});
action('#dialogs-folder-draft',async()=>{const item=chosen();if(!item||!productUI?.isApproved()||!canDraft(item)||!folderState.enabled)throw new Error('Сначала согласуйте товар, подключите папку и прочитайте актуальную переписку.');if(edits.has(item.key))throw new Error('Сначала сохраните или удалите несохранённый черновик этой переписки.');await act('FOLDER_DRAFT',{key:item.key},folderState.autoSend?'Задание добавлено в папку. Автоотправка включена; статус появится в списке заданий.':'Задание добавлено в папку. Полученный ответ будет сохранён черновиком.');});
$('#dialogs-folder-form').addEventListener('input',()=>{folderDirty=true;renderFolder();});
action('#dialogs-folder-connect',async()=>{const permission=chrome.permissions.request({permissions:['nativeMessaging']});const settings=folderSettings();if(!await permission)throw new Error('Доступ к локальному модулю не разрешён. Папка не подключена.');if((settings.auto||settings.autoSend)&&!productUI?.isApproved())throw new Error('Сначала сохраните и согласуйте сведения о товаре.');if(settings.autoSend&&edits.size)throw new Error('Сохраните или удалите несохранённые черновики перед включением автоотправки.');const result=await command('FOLDER_SETTINGS',{...settings,enabled:true});folderDirty=false;adopt(result);feedback(result.folder?.detail||'Папка подключена. Состояние обработки показано в блоке Claude через папку.');});
$('#dialogs-folder-form').addEventListener('submit',async event=>{event.preventDefault();if(busy.has('#dialogs-folder-save'))return;busy.add('#dialogs-folder-save');renderFolder();try{const settings=folderSettings();if((settings.auto||settings.autoSend)&&!productUI?.isApproved())throw new Error('Сначала сохраните и согласуйте сведения о товаре.');if(settings.autoSend&&edits.size)throw new Error('Сохраните или удалите несохранённые черновики перед включением автоотправки.');const result=await command('FOLDER_SETTINGS',settings);folderDirty=false;adopt(result);feedback('Настройки папки сохранены.');}catch(error){feedback(error.message,true);}finally{busy.delete('#dialogs-folder-save');render();}});
action('#dialogs-folder-stop',async()=>{const result=await command('FOLDER_SETTINGS',{enabled:false,auto:false,autoSend:false});folderDirty=false;adopt(result);feedback('Обработка через папку остановлена. Новые ответы поставщикам не отправляются.');});
action('#dialogs-folder-poll',()=>act('FOLDER_POLL',{},'Состояние заданий и доступные результаты обновлены.'));
// Manual generation obtains optional API access in this click's user gesture.
$('#dialogs-generate').addEventListener('click',async()=>{const item=chosen();if(!canDraft(item)||!productUI?.isApproved()||!canPrepareDraft(state,item.key)||generating.has(item.key)||item.autoDraft?.status==='pending')return;const key=item.key;generating.add(key);renderDetail();try{const provider=providerInfo(ai.provider),granted=await chrome.permissions.request({origins:[provider.origin]});if(!granted)throw new Error('Доступ к '+provider.label+' API не разрешён. Мониторинг продолжает работать.');await act('GENERATE_DRAFT',{key},'Черновик подготовлен. Проверьте его перед дальнейшим использованием.');edits.delete(key);manualRequests.delete(key);}catch(error){feedback(error.message,true);}finally{generating.delete(key);renderDetail();}});
$('#dialogs-draft-text').addEventListener('input',()=>{const item=chosen();if(!item)return;const previous=edits.get(item.key);edits.set(item.key,{text:$('#dialogs-draft-text').value,revision:previous?.revision??item.revision,fingerprint:previous?.fingerprint??item.fingerprint});renderDetail();if(folderState.autoSend)pauseFolderOnEdit(true);});
$('#dialogs-filter').addEventListener('change',renderList);$('#dialogs-search').addEventListener('input',renderList);
$('#dialogs-settings-form').addEventListener('input',()=>{settingsDirty=true;productUI?.setSettingsDirty(true);});
$('#dialogs-settings-form').addEventListener('submit',async event=>{event.preventDefault();if(busy.has('#dialogs-save-settings'))return;busy.add('#dialogs-save-settings');$('#dialogs-save-settings').disabled=true;try{const apiKey=$('#dialogs-api-key').value.trim(),clearApiKey=$('#dialogs-clear-key').checked;if(apiKey&&clearApiKey)throw new Error('Для замены ключа снимите отметку «Удалить сохранённый ключ».');const payload={settings:{brief:$('#dialogs-brief').value,wechat:$('#dialogs-wechat').value,language:$('#dialogs-language').value,autoDraft:false},provider:settingsProvider,model:$('#dialogs-model').value.trim()};if(apiKey)payload.apiKey=apiKey;if(clearApiKey)payload.clearApiKey=true;const result=await command('SETTINGS',payload);settingsDirty=false;productUI?.setSettingsDirty(false);$('#dialogs-api-key').value='';$('#dialogs-clear-key').checked=false;adopt(result);feedback('Задание и настройки сохранены.');}catch(error){feedback(error.message,true);}finally{busy.delete('#dialogs-save-settings');if(state)render();}});
$('#dialogs-provider').addEventListener('change',()=>{
  const next=$('#dialogs-provider').value;
  if(next===settingsProvider)return;
  const changed=$('#dialogs-api-key').value||$('#dialogs-clear-key').checked||$('#dialogs-model').value.trim()!==(providerProfile(settingsProvider).model||'');
  if(changed&&!window.confirm('Несохранённые модель и ключ '+providerInfo(settingsProvider).label+' будут сброшены при переключении сервиса. Продолжить?')){$('#dialogs-provider').value=settingsProvider;return;}
  settingsProvider=next;$('#dialogs-model').value=providerProfile(next).model||'';$('#dialogs-api-key').value='';$('#dialogs-clear-key').checked=false;settingsDirty=true;productUI?.setSettingsDirty(true);renderSettings();
});
action('#dialogs-prompt-copy',async()=>{if(!manualExport)return;try{await navigator.clipboard.writeText(manualExport.text);}catch{throw new Error('Не удалось скопировать автоматически. Выделите текст промпта и скопируйте вручную или скачайте TXT.');}feedback('Промпт скопирован. Перенесите его в Claude.');});
action('#dialogs-prompt-download',()=>{if(!manualExport)return;const url=URL.createObjectURL(new Blob(['\uFEFF',manualExport.text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=String(manualExport.filename||'openlinks-claude-prompt.txt').replace(/[\\/\x00-\x1f]/g,'_');link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);feedback('TXT-файл подготовлен для скачивания.');});
$('#dialogs-prompt-close').addEventListener('click',()=>{$('#dialogs-prompt-panel').hidden=true;});
$('#dialogs-prompt-response').addEventListener('input',renderPrompt);$('#dialogs-prompt-images').addEventListener('change',renderPrompt);
action('#dialogs-prompt-apply',async()=>{if(!manualExport||manualExport.kind!=='product')return;const applied=await productUI.importResult(manualExport.request,$('#dialogs-prompt-response').value,$('#dialogs-prompt-images').checked);if(applied){manualExport=null;$('#dialogs-prompt-panel').hidden=true;$('#dialogs-prompt-response').value='';}});
productUI=setupProductUI({command,adopt,feedback,exportPrompt,getFolderState:()=>folderState,onDirty:()=>{if(state){renderDetail();renderPrompt();renderFolder();pauseFolderOnEdit();}}});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&Object.keys(changes).some(key=>/dialog|claudeFolder/i.test(key)))refresh();});
Promise.allSettled([refresh(),refreshTabs()]).then(results=>{for(const result of results)if(result.status==='rejected')feedback(result.reason?.message||'Не удалось получить список вкладок.',true);});
setInterval(()=>{if(!document.hidden)refresh();},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
