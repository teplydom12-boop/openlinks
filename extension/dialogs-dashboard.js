import {displayTime} from './lib/time.js';
import {setupProductUI} from './dialogs-product.js';
import {canPrepareDraft, contactAssessment, draftRequest, supplierReplyAssessment} from './lib/dialogs.js';
import {setupJointModeUI} from './joint-mode-ui.js';

const $=selector=>document.querySelector(selector);
const PLATFORMS={'1688':'1688',alibaba:'Alibaba',mic:'Made-in-China'};
const STATUS={unbound:['Чат не открыт',''],ready:['Чат доступен','good'],ok:['Чат доступен','good'],observing:['Мониторинг','good'],scanning:['Проверка…',''],loading:['Загрузка…',''],unsupported:['Страница не распознана','warn'],partial:['Прочитана часть данных','warn'],closed:['Вкладка закрыта','bad'],missing:['Вкладка не найдена','bad'],error:['Ошибка проверки','bad'],blocked:['Нужно вмешательство','warn'],login:['Нужен вход','warn'],captcha:['Проверка площадки','warn'],paused:['Мониторинг остановлен',''],stale:['Данные устарели','warn'],idle:['Ожидает проверки','']};
const FOLDER_STATUS={disabled:['Выключено',''],idle:['Ожидание задания',''],ready:['Подключено','good'],connected:['Подключено','good'],waiting:['Обработчик не запущен','warn'],claude_missing:['Claude Code не найден','warn'],pending:['В очереди',''],preparing:['Подготовка задания',''],queued:['В очереди',''],running:['Claude обрабатывает',''],paused:['Приостановлено','warn'],offline:['Нет соединения с Claude','warn'],needslogin:['Нужен вход в Claude Code','warn'],needs_login:['Нужен вход в Claude Code','warn'],authentication_required:['Нужен вход в Claude Code','warn'],subscription_auth_required:['Нужен вход через подписку Claude','warn'],subscription_auth_unverified:['Не удалось проверить вход в Claude Code','warn'],usage_limit:['Достигнут лимит Claude','warn'],missing:['Локальный модуль не найден','warn'],unavailable:['Обработчик недоступен','warn'],error:['Ошибка','bad'],stale:['Контекст изменился','warn'],done:['Обработано','good'],accepted:['Результат принят','good'],cancelled:['Отменено',''],awaiting_limit:['Ответ готов · ожидание лимита площадки','warn'],sending:['Отправка поставщику','warn'],sent:['Кнопка отправки нажата','good'],send_unknown:['Отправка не подтверждена — проверьте чат','warn'],unknown:['Результат операции неизвестен','warn'],previewed:['Тест завершён · без отправки','test'],test_completed:['Тест завершён · без отправки','test']};
const FOLDER_PAUSE={offline:'Нет соединения с Claude. Подключите интернет и нажмите «Возобновить обработку».',authentication_required:'Войдите в Claude Code через вашу подписку, затем нажмите «Возобновить обработку».',subscription_auth_required:'Войдите в Claude Code через аккаунт с подпиской Claude, затем нажмите «Возобновить обработку».',subscription_auth_unverified:'Не удалось проверить вход в Claude Code. Проверьте его установку и авторизацию, затем нажмите «Возобновить обработку».',usage_limit:'Достигнут лимит подписки Claude. Возобновите обработку после восстановления лимита.',claude_update_required:'Обновите Claude Code, затем возобновите обработку.',claude_failed:'Claude завершил задание с ошибкой. Проверьте журнал обработчика перед возобновлением.',invalid_claude_output:'Ответ Claude не удалось прочитать. Проверьте журнал обработчика перед возобновлением.'};
let folderState={enabled:false,auto:false,autoSend:false,model:'haiku',status:'disabled',jobs:[]},folderDirty=false,folderPausing=false,folderPausePromise=null,modeBusy=false,modeRequested=null,testRequested=null;
let state=null, productFingerprint='', productUI, openingChats=false, openingPlatform=null, selectedKey=null, settingsDirty=false, readUnreadDirty=false, scanReadBusy=false, scanReadRequested=null, loading=false, historySignature='', reviewEpoch=0;
const edits=new Map(), busy=new Set(), sending=new Set(), draftEditingPending=new Map();

function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function feedback(text,error=false){const el=$('#dialogs-feedback');el.textContent=text;el.classList.toggle('error',error);el.hidden=!text;}
function chosen(){return state?.conversations?.[selectedKey]||null;}
function testState(){return folderState.test||{enabled:false,phase:'off',sessionId:'',cycleId:'',key:'',text:'',at:null,completed:[]};}
function testInProgress(){return testState().enabled&&['ready','generating','preparing'].includes(testState().phase);}
function testModeIntent(){const test=testState();return test.enabled?{testMode:true,testSessionId:test.sessionId,testCycleId:test.cycleId}:{testMode:false};}
function sameTestIntent(intent){const current=testModeIntent();return intent.testMode===current.testMode&&(!intent.testMode||intent.testSessionId===current.testSessionId&&intent.testCycleId===current.testCycleId);}
function date(at){return at==null?'Время не указано':displayTime(at);}
function safeUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(^|\.)(1688\.com|alibaba\.com|made-in-china\.com)$/.test(u.hostname)?u.href:null;}catch{return null;}}
async function command(type,payload={}){const result=await chrome.runtime.sendMessage({type:'DIALOGS_'+type,...payload});if(!result?.ok)throw new Error(result?.error||'Расширение не ответило. Перезагрузите эту страницу.');return result;}
function adopt(result){if(result.state)state=result.state;if(result.folder)folderState=result.folder;if(typeof result.productFingerprint==='string')productFingerprint=result.productFingerprint;else if(result.state?.product?.fingerprint)productFingerprint=result.state.product.fingerprint;render();}
async function refresh(){if(loading)return;loading=true;try{adopt(await command('GET'));}catch(error){feedback(error.message,true);}finally{loading=false;}}
async function act(name,payload={},message=''){const result=await command(name,payload);if(result.state||result.folder)adopt(result);else await refresh();if(message)feedback(message);return result;}
function action(selector,handler){$(selector).addEventListener('click',async()=>{if(busy.has(selector))return;busy.add(selector);$(selector).disabled=true;try{await handler();}catch(error){feedback(error.message,true);}finally{busy.delete(selector);$(selector).disabled=false;if(state)render();}});}
function makeButton(label,handler,className='button secondary'){const button=node('button',label,className);button.type='button';button.addEventListener('click',async()=>{button.disabled=true;try{await handler();}catch(error){feedback(error.message,true);}finally{if(button.isConnected)button.disabled=false;}});return button;}
function threadFlags(conversation){const result=[];const test=testState();if(test.enabled&&((test.key===conversation.key&&test.phase==='completed')||(test.completed||[]).some(item=>item.key===conversation.key)))result.push(['Тест: без отправки','test']);if(conversation.takeover)result.push(['Под вашим управлением','']);if(conversation.paused)result.push(['На паузе','']);const reply=supplierReplyAssessment(state,conversation);if(reply.allowed)result.push(['Требует ответа','warn']);else if(reply.status==='waiting_supplier')result.push(['Ждём ответа поставщика','']);else if(reply.status==='no_initial_outreach')result.push(['Первичное обращение не найдено','warn']);if(conversation.unread===true||Number(conversation.unread)>0)result.push(['Непрочитано на площадке','warn']);if(conversation.needsRead)result.push([conversation.messages?.length||readerDetail(conversation)?'Нужна проверка истории':'Нужно открыть историю','']);if(state.settings?.scanRead){const contact=contactAssessment(state,conversation);if(contact.status==='shared')result.push(['WeChat уже передан','good']);else if(contact.status==='blocked_capacity')result.push(['WeChat: память проверок заполнена','warn']);}if(conversation.autoDraft?.status==='pending')result.push(['ИИ готовит черновик','']);if(conversation.autoDraft?.status==='error')result.push(['Ошибка черновика','warn']);if(conversation.draft)result.push([conversation.draft.status==='stale'?'Черновик устарел':'Есть черновик',conversation.draft.status==='stale'?'warn':'good']);return result;}
function isWechatDraft(conversation){return conversation?.draft?.purpose==='wechat';}
function canDraft(conversation){return !!conversation&&!isWechatDraft(conversation)&&supplierReplyAssessment(state,conversation).allowed;}
function wechatAssessmentText(conversation){
  const assessment=contactAssessment(state,conversation);
  if(assessment.status==='shared')return 'Ваш WeChat найден в исходящем сообщении. Повторное приглашение не требуется.';
  if(assessment.status==='blocked_capacity')return assessment.detail||'Память проверок WeChat заполнена; сохранённые подтверждения не удаляются.';
  if(assessment.status==='not_found')return 'В доступной истории WeChat не найден. Более ранние сообщения могут быть недоступны. Контакт можно предложить в ответе поставщику по вашим правилам.';
  if(assessment.status==='no_contact')return 'Сохраните ваш WeChat в разделе «Контекст переговоров и WeChat» в шаге 2.';
  return assessment.detail||'Пока нельзя проверить, передавался ли ваш WeChat: история не прочитана полностью или автор сообщения не определён.';
}
function readerDetail(conversation){return typeof conversation?.detail==='string'?conversation.detail.trim().slice(0,1200):'';}
function draftBlockReason(conversation){
  if(!conversation)return 'Выберите переписку.';
  if(conversation.takeover)return 'Вы взяли разговор на себя. Подготовка ответа с ИИ приостановлена.';
  if(conversation.paused)return 'Переписка на паузе.';
  if(!conversation.identityReliable)return readerDetail(conversation)||'Пока не удалось надёжно определить поставщика.';
  if(conversation.contentReady===false)return readerDetail(conversation)||'Не все сообщения или вложения прочитаны. Причины показаны в истории переписки.';
  if(!conversation.orderReliable||!conversation.tailKnown||conversation.needsRead)return readerDetail(conversation)||'Нужна достоверная последняя часть переписки. Откройте её во вкладке мониторинга и повторите проверку.';
  if(isWechatDraft(conversation))return 'Это старый черновик приглашения. Удалите его; новый ответ возможен после сообщения поставщика на ваше первичное обращение.';
  const reply=supplierReplyAssessment(state,conversation);if(!reply.allowed)return reply.detail;
  if(testState().enabled&&testState().phase==='completed')return 'Цикл выполнен — сообщение не отправлено. Для продолжения нажмите «Проверить следующий цикл» в шаге 3.';
  if(testState().enabled&&['paused','blocked'].includes(testState().phase))return testState().phase==='blocked'?'Тест приостановлен. Проверьте причину в шаге 3.':'Запустите первый тестовый цикл в шаге 3.';
  if(!productUI?.isApproved())return 'Сохраните и согласуйте информацию о товаре в блоке выше. Она применяется ко всем наблюдаемым поставщикам.';
  if(settingsDirty)return 'Сначала сохраните контекст переговоров.';
  if(testState().enabled)return 'Тестовый цикл читает переписку, получает ответ Claude и вводит текст в чат. Сообщение поставщику не отправляется.';
  if(conversation.draft?.testSessionId)return 'Это ответ из тестового сеанса. Для настоящей отправки удалите тестовый черновик и подготовьте новый ответ.';
  if(conversation.draft)return conversation.draft.status==='stale'?'Черновик устарел. Сохраните нужные правки отдельно и удалите его перед подготовкой нового ответа.':'Ответ готов. Проверьте текст, при необходимости отредактируйте и нажмите «Отправить».';
  if(!folderState.enabled)return 'Подключите Claude в шаге 1.';
  if(folderDirty)return 'Сохраните выбранную модель Claude.';
  return folderState.autoSend?'Claude подготовит и отправит ответ при актуальной истории и доступном лимите площадки.':'Claude подготовит ответ. Проверьте текст и нажмите «Отправить», когда он вас устроит.';
}

async function openChats(platform){
  if(openingChats)return;
  openingChats=true;openingPlatform=platform||null;reviewEpoch++;render();
  feedback(platform?'Открываю чат '+PLATFORMS[platform]+'…':'Последовательно открываю чаты площадок…');
  try{
    const result=await command('OPEN_CHATS',platform?{platform}:{});
    adopt(result);
    const failures=(result.launchErrors||[]).map(item=>(PLATFORMS[item.platform]||item.platform)+': '+item.error);
    feedback(failures.length?'Не все чаты удалось открыть. '+failures.join(' '):'Чаты открываются в фоне. Готовность и запросы на вход показаны в карточках площадок.',failures.length>0);
  }finally{openingChats=false;openingPlatform=null;render();}
}
function renderBindings(){
  const container=$('#dialogs-bindings');container.replaceChildren();
  const bindings=Object.values(state?.bindings||{}),ready=bindings.filter(binding=>binding.tabId!=null&&['ready','ok','observing'].includes(binding.status)).length,pending=bindings.some(binding=>binding.managed?.pending);
  $('#dialogs-open-chats').disabled=!state||openingChats||modeBusy||testInProgress();
  $('#dialogs-open-chats').textContent=openingChats?'Открываю чаты…':'Открыть чаты площадок';
  $('#dialogs-open-status').textContent=openingChats?(openingPlatform?'Открываю чат '+PLATFORMS[openingPlatform]+'…':'Последовательно открываю 1688, Alibaba и Made-in-China…'):(pending?'Чаты загружаются. ':'')+'Чаты готовы к чтению: '+ready+' из 3. При запросе входа нажмите «Показать чат» и войдите в аккаунт.';
  container.setAttribute('aria-busy',String(openingChats||pending));
  for(const [platform,label] of Object.entries(PLATFORMS)){
    const binding=state?.bindings?.[platform]||{},card=node('section',undefined,'panel dialogs-platform'),heading=node('div',undefined,'panel-heading');
    card.dataset.platform=platform;
    const [status,tone]=STATUS[binding.status||'unbound']||['Статус проверки: '+binding.status,'warn'];
    heading.append(node('h3',label),node('span',status,'dialogs-status '+tone));
    const controls=node('div',undefined,'actions');
    const open=makeButton(binding.managed&&binding.tabId!=null?'Проверить подключение':'Открыть чат',()=>openChats(platform));
    open.dataset.action='open-chat';open.disabled=!state||openingChats||modeBusy||testInProgress();
    const show=makeButton('Показать чат',()=>act('SHOW_CHAT',{platform}),'link-button');
    show.dataset.action='show-chat';show.disabled=!binding.managed||binding.tabId==null||openingChats;
    const remove=makeButton('Отключить',async()=>{if(openingChats)return;reviewEpoch++;await act('UNBIND_TAB',{platform},'Чат '+label+' отключён от мониторинга.');},'link-button');
    remove.dataset.action='disconnect-chat';remove.disabled=binding.tabId==null||openingChats||testInProgress();
    controls.append(open,show,remove);
    card.append(heading,controls,node('p',binding.detail||(binding.tabId==null?'Расширение откроет сайт площадки и её центр сообщений.':'Проверяю доступность центра сообщений…'),'hint'),node('p','Последняя проверка: '+(binding.checkedAt==null?'ещё не выполнялась':date(binding.checkedAt)),'hint'));
    container.append(card);
  }
}
function filteredConversations(){const query=$('#dialogs-search').value.trim().toLocaleLowerCase(),filter=$('#dialogs-filter').value;return Object.values(state?.conversations||{}).filter(item=>{if(filter==='unanswered'&&!supplierReplyAssessment(state,item).allowed)return false;if(filter==='unread'&&!(item.unread===true||Number(item.unread)>0))return false;if(filter==='takeover'&&!item.takeover)return false;if(filter==='paused'&&!item.paused)return false;const haystack=[item.title,item.platform,PLATFORMS[item.platform],item.url,item.preview,...(item.messages||[]).map(m=>m.text)].filter(Boolean).join(' ').toLocaleLowerCase();return !query||haystack.includes(query);}).sort((a,b)=>Number(b.unanswered)-Number(a.unanswered)||(b.updatedAt||0)-(a.updatedAt||0)||a.key.localeCompare(b.key));}
function renderList(){const conversations=filteredConversations(),all=Object.values(state?.conversations||{}),list=$('#dialogs-list');$('#dialogs-count').textContent=all.length+' · требуют ответа: '+all.filter(c=>supplierReplyAssessment(state,c).allowed).length;list.replaceChildren();for(const conversation of conversations){const button=node('button',undefined,'dialogs-thread'+(conversation.key===selectedKey?' selected':''));button.type='button';button.dataset.key=conversation.key;button.setAttribute('aria-pressed',String(conversation.key===selectedKey));button.append(node('strong',conversation.title||'Поставщик не определён'),node('p',(PLATFORMS[conversation.platform]||conversation.platform)+' · '+date(conversation.updatedAt),'hint'));const last=(conversation.messages||[]).at(-1);button.append(node('div',last?.text||conversation.preview||'История ещё не прочитана','dialogs-preview'));const flags=node('div',undefined,'dialogs-thread-flags');for(const [label,tone] of threadFlags(conversation))flags.append(node('span',label,'dialogs-status '+tone));button.append(flags);button.addEventListener('click',()=>{selectedKey=conversation.key;historySignature='';renderList();renderDetail();});list.append(button);}$('#dialogs-empty').hidden=conversations.length>0;$('#dialogs-empty').textContent=all.length?'Переписок с такими условиями нет.':'Откройте чаты площадок и запустите мониторинг. Здесь появятся прочитанные переписки и доступный список чатов.';}
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
  $('#dialogs-wechat-assessment').hidden=!state.settings?.scanRead;
  $('#dialogs-wechat-assessment').textContent=state.settings?.scanRead?wechatAssessmentText(conversation):'';
  renderHistory(conversation);
  const test=testState(),testRecord=(test.completed||[]).find(entry=>entry.key===conversation.key),currentTest=test.key===conversation.key&&test.phase==='completed';
  $('#dialogs-conversation-test-note').hidden=!test.enabled||(!currentTest&&!testRecord);
  $('#dialogs-conversation-test-note').textContent=currentTest?'Цикл выполнен — сообщение не отправлено. Текст оставлен в поле чата для проверки.':testRecord?'Эта переписка уже участвовала в тесте: '+date(testRecord.at)+'. Ответ учтён только в тестовом режиме; сообщение не отправлялось.':'';
  const edit=edits.get(conversation.key),draft=conversation.draft,testOriginBlocked=!test.enabled&&!!(edit?.testSessionId||draft?.testSessionId);
  const text=edit?edit.text:(draft?.text||'');
  if($('#dialogs-draft-text').value!==text)$('#dialogs-draft-text').value=text;
  $('#dialogs-draft-reason').hidden=!draft?.reason;
  $('#dialogs-draft-reason').textContent=draft?.reason||'';
  const jobs=(folderState.jobs||[]).filter(job=>job.key===conversation.key);
  const job=[...jobs].sort((a,b)=>(b.at||0)-(a.at||0))[0];
  const pending=jobs.some(job=>['preparing','queued','pending','running','done','awaiting_limit','sending'].includes(job.status));
  const receipt=(folderState.sendReceipts||[]).find(receipt=>receipt.key===conversation.key&&receipt.fingerprint===conversation.fingerprint&&['sent','unknown'].includes(receipt.status));
  $('#dialogs-auto-status').hidden=!job;
  $('#dialogs-auto-status').textContent=job?[FOLDER_STATUS[job.status]?.[0]||job.status,job.detail].filter(Boolean).join(' · '):'';
  let currentRequest;try{currentRequest=draftRequest(state,conversation.key);}catch{}
  const stale=!!edit&&(edit.revision!==conversation.revision||edit.fingerprint!==conversation.fingerprint||edit.productFingerprint!==productFingerprint||edit.request?.settingsFingerprint&&edit.request.settingsFingerprint!==currentRequest?.settingsFingerprint||(edit.request?.purpose||'reply')!==(currentRequest?.purpose||'reply'));
  $('#dialogs-draft-status').textContent=stale?'Переписка, настройки или товар изменились после начала редактирования. Скопируйте нужные правки и подготовьте актуальный ответ.':edit?(test.enabled?'Есть несохранённые изменения. В тестовом режиме текст проверяется без отправки.':'Есть несохранённые изменения. «Отправить» сохранит и отправит именно этот текст.'):draft?.status==='stale'?'Черновик устарел: изменились переписка или сведения о товаре.':draft?'Черновик сохранён: '+date(draft.createdAt):'Claude ещё не подготовил ответ.';
  const ready=canDraft(conversation)&&!!productUI?.isApproved()&&canPrepareDraft(state,conversation.key);
  const isSending=sending.has(conversation.key);
  $('#dialogs-generate-hint').textContent=draftBlockReason(conversation);
  $('#dialogs-folder-draft').disabled=scanReadBusy||!ready||!folderState.enabled||folderDirty||folderPausing||pending||isSending||!!edit||!!draft||test.enabled&&test.phase!=='ready';
  $('#dialogs-folder-draft').textContent='Подготовить ответ';
  $('#dialogs-folder-draft').title=test.enabled?'Ответ будет введён в чат без отправки. Один тестовый цикл, затем пауза.':folderState.autoSend?'Ответ может быть отправлен автоматически после проверки контекста.':'Ответ будет сохранён для вашего одобрения.';
  $('#dialogs-save-draft').disabled=!ready||!edit?.text.trim()||stale||isSending;
  $('#dialogs-discard-draft').disabled=(!edit&&!draft)||isSending;
  $('#dialogs-draft-text').disabled=!canDraft(conversation)||isSending;
  const unsafeWechat=isWechatDraft(conversation);
  $('#dialogs-send-draft').disabled=scanReadBusy||!ready||!state.running||!text.trim()||stale||!edit&&draft?.status==='stale'||!!receipt||folderPausing||modeBusy||isSending||testOriginBlocked||unsafeWechat||test.enabled&&test.phase!=='ready';
  $('#dialogs-send-draft').textContent=isSending?(test.enabled?'Проверка…':'Отправка…'):test.enabled?'Проверить без отправки':'Отправить';
  $('#dialogs-send-note').textContent=testOriginBlocked?'Тестовый ответ нельзя отправить настоящему поставщику. Удалите этот черновик и подготовьте новый ответ после выхода из тестового режима.':test.enabled?(test.phase==='completed'?'Проверка завершена. Переход к следующему циклу доступен в шаге 3.':test.phase==='blocked'?'Тест приостановлен. Проверьте причину в шаге 3.':test.phase==='paused'?'Сначала нажмите «Проверить первый цикл» в шаге 3.':'Кнопка проверит адресата и введёт этот текст в поле чата. Отправка не выполняется.') :receipt?(receipt.status==='unknown'?'Исход предыдущей отправки неизвестен. Проверьте чат: повторная отправка заблокирована.':receipt.status==='sending'?'Отправка уже выполняется.':'Кнопка отправки уже нажата. Повторная отправка этого ответа заблокирована.'):!state.running?'Для отправки запустите мониторинг и откройте эту переписку во вкладке мониторинга.':'Откройте эту переписку во вкладке площадки и нажмите «Проверить сейчас». «Отправить» одобряет показанный текст; адресат и новые сообщения проверяются повторно.';
  if(unsafeWechat&&!testOriginBlocked)$('#dialogs-send-note').textContent='Старый черновик приглашения недоступен для отправки. Удалите его и дождитесь ответа поставщика на первичное обращение.';
  for(const id of busy)if($(id))$(id).disabled=true;
}
function renderSettings(){
  if(!settingsDirty){$('#dialogs-brief').value=state.settings?.brief||'';$('#dialogs-wechat').value=state.settings?.wechat||'';$('#dialogs-language').value=state.settings?.language||'';}
  $('#dialogs-save-settings').disabled=!settingsDirty||busy.has('#dialogs-save-settings');
  $('#dialogs-scan-read').checked=scanReadRequested??state.settings?.scanRead===true;
  $('#dialogs-scan-read').disabled=scanReadBusy||modeBusy||folderPausing||settingsDirty||testInProgress();
  $('#dialogs-scan-read-note').textContent=scanReadBusy?'Сохраняю настройку чтения ответов…':state.settings?.scanRead?'Проверка включена: расширение открывает также прочитанные ответы. Ответ готовится только после вашего первичного сообщения и последующего сообщения поставщика в доступной истории. Если WeChat сохранён, учитывается его предыдущая передача.':'При включении проверяются также прочитанные ответы поставщиков на ваши первичные обращения. Отсутствие WeChat не запускает отдельное сообщение.';
}

function renderEvents(){const events=state.events||[],list=$('#dialogs-events');list.replaceChildren();for(const event of [...events].slice(-100).reverse()){const item=node('li'),at=event.at??event.time;item.append(node('time',date(at)),node('span',[(PLATFORMS[event.platform]||event.platform),event.detail||event.message||event.type||event.event].filter(Boolean).join(' · ')));list.append(item);}$('#dialogs-events-empty').hidden=events.length>0;}
function folderSettings(){return {model:$('#dialogs-folder-model').value};}
function boundTabs(){return Object.values(state?.bindings||{}).some(binding=>binding.tabId!=null);}
function renderFolder(){
  const test=testState();
  const folder=folderState,enabled=folder.enabled===true,approved=productUI?.isApproved(),worker=folder.worker||{};
  if(!folderDirty){
    const model=folder.model||'haiku',select=$('#dialogs-folder-model');
    if(![...select.options].some(option=>option.value===model))select.add(new Option('Текущая модель · '+model,model));
    select.value=model;
  }
  $('#dialogs-folder-send').checked=test.enabled?false:modeRequested??(folder.autoSend===true);
  $('#dialogs-test-mode').checked=testRequested??test.enabled;
  $('#dialogs-test-mode').disabled=scanReadBusy||modeBusy||folderPausing;
  const effectiveStatus=enabled&&worker.status==='paused'?(FOLDER_STATUS[worker.pauseReason]?worker.pauseReason:'paused'):folder.status;
  const [label,tone]=FOLDER_STATUS[effectiveStatus]||[effectiveStatus||'Выключено',''];
  $('#dialogs-folder-status').textContent=folderPausing?'Приостанавливаю ответы…':label;
  $('#dialogs-folder-status').className='dialogs-status '+tone;
  $('#dialogs-folder-detail').textContent=folder.detail||(!enabled?'Подключите Claude, чтобы обрабатывать товар и готовить ответы.':'Claude подключён. Подготовьте и согласуйте товар в шаге 2.');
  $('#dialogs-folder-path').textContent=folder.folder?'Папка заданий: '+folder.folder:'Путь появится после подключения.';
  $('#dialogs-folder-worker').textContent=[worker.running?'Обработчик запущен.':enabled?'Ожидание сигнала обработчика.':'',worker.heartbeat?'Последний сигнал: '+date(worker.heartbeat)+'.':'',worker.status==='paused'?(FOLDER_PAUSE[worker.pauseReason]||'Обработчик приостановлен. Проверьте журнал и возобновите обработку.'):'',folder.status==='claude_missing'?'Claude Code не найден. Установите его по инструкции.':''].filter(Boolean).join(' ');
  $('#dialogs-folder-connect').textContent=enabled?(worker.status==='paused'?'Возобновить обработку':'Проверить подключение'):'Подключить Claude';
  $('#dialogs-folder-connect').disabled=folderPausing||modeBusy;
  $('#dialogs-folder-save').disabled=!folderDirty||folderPausing||modeBusy;
  $('#dialogs-folder-stop').disabled=!enabled||folderPausing||modeBusy;
  $('#dialogs-folder-poll').disabled=!enabled||folderPausing;
  $('#dialogs-folder-send').disabled=scanReadBusy||test.enabled||modeBusy||folderPausing||(!folder.autoSend&&(openingChats||!enabled||!approved||!boundTabs()||folderDirty||edits.size>0));
  $('#dialogs-mode').classList.toggle('automatic',!test.enabled&&!!folder.autoSend);
  $('#dialogs-mode').classList.toggle('test-mode',!!test.enabled);
  $('#dialogs-mode-label').textContent=modeBusy?'Меняю режим…':test.enabled?'Тестовый режим':folder.autoSend?'Автоматический режим':'С вашим одобрением';
  $('#dialogs-folder-send-note').textContent=test.enabled?'Настоящие чаты и ответы Claude. Текст вводится в поле сообщения; отправка выключена на всех площадках.':folder.autoSend?'Claude читает новые сообщения, готовит и отправляет ответы по согласованным правилам. Снимите галочку, чтобы проверять каждый ответ.':'Claude готовит черновики. Вы проверяете текст, при необходимости редактируете и нажимаете «Отправить».';
  $('#dialogs-monitor-note').textContent=test.enabled?'Один цикл проверяет один ответ поставщику. Следующий цикл запускается только вашей кнопкой.':!boundTabs()?'Сначала откройте хотя бы один чат площадки.':!enabled?'Подключите Claude в шаге 1. Пока доступно только чтение сообщений.':!approved?'Согласуйте товар в шаге 2. Пока доступно только чтение сообщений.':folderDirty?'Сохраните модель в шаге 1.':edits.size?'Есть несохранённые черновики. Сохраните или удалите их перед включением автоматической отправки.':state.running&&folder.auto?'Мониторинг включён. Новые сообщения обрабатываются автоматически.':state.running?'Чтение работает. Нажмите «Начать мониторинг», чтобы возобновить подготовку ответов.':'Начните мониторинг для подготовки черновиков. Галочка автоматической отправки также запускает мониторинг.';
  $('#dialogs-folder-edits').hidden=!folderDirty;
  $('#dialogs-folder-edits').textContent=folderDirty?'Модель изменена. Сохраните выбор, чтобы применять его к новым заданиям.':'';
  const list=$('#dialogs-folder-jobs');list.replaceChildren();const jobs=Array.isArray(folder.jobs)?folder.jobs:[];
  for(const job of [...jobs].sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,50)){
    const row=node('li');row.dataset.jobId=job.id;const heading=node('div',undefined,'panel-heading'),[status,color]=FOLDER_STATUS[job.status]||[job.status||'Ожидание',''];
    const conversation=state.conversations?.[job.key];heading.append(node('strong',job.kind==='product'?'Сведения о товаре':conversation?(PLATFORMS[conversation.platform]||conversation.platform)+' · '+(conversation.title||job.key):job.key||'Ответ поставщику'),node('span',status,'dialogs-status '+color));
    row.append(heading,node('p',date(job.at)+' · '+String(job.id||''),'hint'));if(job.detail)row.append(node('p',job.detail,'hint'));
    const controls=node('div',undefined,'actions');
    if(job.test&&['error','offline','needslogin','needs_login','unknown'].includes(job.status))row.append(node('p','Для повторной проверки начните новый сеанс через переключатель «Тестовый режим».','hint'));
    if(!job.test&&['error','offline','needslogin','needs_login','unknown'].includes(job.status)){const retry=makeButton('Повторить',()=>act('FOLDER_RETRY',{id:job.id},'Повтор задания запрошен.'),'link-button');retry.disabled=!enabled||folderPausing||!!productUI?.isDirty();controls.append(retry);}
    if(['preparing','queued','pending','running','done','awaiting_limit','error','offline','needslogin','needs_login','unknown'].includes(job.status))controls.append(makeButton('Отменить',()=>act('FOLDER_CANCEL',{id:job.id},'Задание отменено.'),'link-button'));
    if(controls.childNodes.length)row.append(controls);list.append(row);
  }
  $('#dialogs-folder-empty').hidden=jobs.length>0;
  renderTestMode();
}
function renderTestMode(){
  const test=testState(),active=test.enabled===true;
  $('#dialogs-test-panel').hidden=!active;
  if(!active)return;
  const labels={paused:'Готов к проверке',ready:state.settings?.scanRead?'Ищу чат для одного цикла':'Ищу сообщение для одного цикла',generating:'Claude готовит тестовый ответ',preparing:'Ввожу текст в чат без отправки',completed:'Цикл выполнен — сообщение не отправлено',blocked:'Тест приостановлен'};
  $('#dialogs-test-status').textContent=labels[test.phase]||'Тест приостановлен';
  let issue=!folderState.enabled?'Подключите Claude в шаге 1.':!productUI?.isApproved()?'Сохраните и согласуйте товар в шаге 2.':!boundTabs()?'Откройте чаты площадок.':folderDirty?'Сохраните модель Claude.':edits.size?'Сохраните или удалите несохранённые черновики.':'';
  $('#dialogs-test-detail').textContent=[test.detail,issue,test.phase==='blocked'?'Проверьте чат. Если тестовый текст мешает сбросу, удалите его вручную; затем выключите и снова включите тестовый режим для нового цикла.':''].filter(Boolean).join(' ');
  $('#dialogs-test-next').textContent=test.phase==='completed'?'Проверить следующий цикл':test.phase==='paused'?'Проверить первый цикл':test.phase==='blocked'?'Проверка приостановлена':'Цикл выполняется…';
  $('#dialogs-test-next').disabled=scanReadBusy||openingChats||!!issue||modeBusy||folderPausing||!['paused','completed'].includes(test.phase)||busy.has('#dialogs-test-next');
  $('#dialogs-test-result').hidden=!test.text;
  $('#dialogs-test-result-note').textContent=test.phase==='completed'?'Текст введён в чат для проверки. Записи об отправке в истории переписки нет.':'Сохранённый текст теста. Проверьте поле чата перед продолжением; сообщение не отправлялось.';
  const conversation=state?.conversations?.[test.key];
  $('#dialogs-test-recipient').textContent=[PLATFORMS[conversation?.platform]||'',conversation?.title||test.key||''].filter(Boolean).join(' · ');
  $('#dialogs-test-time').textContent=test.at?'Проверено: '+date(test.at):'';
  $('#dialogs-test-text').textContent=test.text||'';
  const count=(test.completed||[]).length;
  $('#dialogs-test-count').textContent=count?'Учтено только в тесте: '+count:'';
}
async function disableLegacyDrafts(){
  if(state?.settings?.autoDraft)adopt(await command('AUTODRAFT',{enabled:false}));
}
async function enableAutomaticDrafts(){
  if(folderPausePromise)await folderPausePromise;
  if(!folderState.enabled||!productUI?.isApproved())return;
  await disableLegacyDrafts();
  if(!folderState.auto)adopt(await command('FOLDER_SETTINGS',{enabled:true,auto:true,autoSend:false}));
}
async function pauseFolderOnEdit(draftChanged=false,force=false){
  if(!draftChanged&&!force&&!productUI?.isDirty())return folderPausePromise;
  if(draftChanged&&!folderState.autoSend)return;
  folderPausing=true;renderFolder();
  const pending=(async()=>{
    try{adopt(await command(draftChanged?'FOLDER_SETTINGS':'CONTEXT_EDITING',draftChanged?{autoSend:false}:{}));}
    catch(error){feedback('Не удалось приостановить ответы: '+error.message,true);}
    finally{if(folderPausePromise===pending){folderPausing=false;folderPausePromise=null;}render();}
  })();
  folderPausePromise=pending;
  return pending;
}
function render(){
  if(!state)return;
  productUI?.render(state,{},productFingerprint);
  const bound=boundTabs();
  $('#dialogs-run-state').textContent=testState().enabled?(testInProgress()?'Тест · один цикл':'Тест · ожидание'):state.running?(folderState.enabled&&folderState.auto?folderState.autoSend?'Автоматические ответы':'Черновики на проверку':'Только чтение'):'Мониторинг остановлен';
  $('#dialogs-run-state').classList.toggle('running',!!state.running);
  $('#dialogs-start').hidden=testState().enabled;
  $('#dialogs-scan').hidden=testState().enabled;
  $('#dialogs-start').disabled=scanReadBusy||openingChats||!bound||!!state.running&&(!folderState.enabled||!productUI?.isApproved()||folderState.auto)||folderPausing||modeBusy;
  $('#dialogs-stop').disabled=!state.running;
  $('#dialogs-scan').disabled=scanReadBusy||openingChats||!bound;
  if(state.running||!readUnreadDirty)$('#dialogs-read-unread').checked=state.readUnread!==false;
  $('#dialogs-read-unread').disabled=!!state.running;
  renderBindings();renderList();renderDetail();renderSettings();renderEvents();renderFolder();
  for(const id of busy)if($(id))$(id).disabled=true;
}

// Starting monitoring always enables Claude drafts once the task is approved.
action('#dialogs-open-chats',()=>openChats());
action('#dialogs-start',async()=>{
  if(folderDirty)throw new Error('Сначала сохраните выбранную модель Claude.');
  await disableLegacyDrafts();await enableAutomaticDrafts();
  await act('START',{readUnread:$('#dialogs-read-unread').checked},folderState.enabled&&folderState.auto?(folderState.autoSend?'Мониторинг и автоматические ответы включены.':'Мониторинг включён. Черновики будут появляться для вашего одобрения.'):'Мониторинг читает сообщения. Подключите Claude и согласуйте товар для подготовки ответов.');
  readUnreadDirty=false;
});
$('#dialogs-read-unread').addEventListener('change',()=>{readUnreadDirty=true;});
$('#dialogs-scan-read').addEventListener('change',async()=>{
  if(scanReadBusy)return;
  const enabled=$('#dialogs-scan-read').checked;
  reviewEpoch++;scanReadBusy=true;scanReadRequested=enabled;render();
  try{
    if(settingsDirty)throw new Error('Сначала сохраните контекст переговоров в шаге 2.');
    await pauseFolderOnEdit(false,true);
    adopt(await command('SETTINGS',{settings:{scanRead:enabled,autoDraft:false}}));
    feedback(enabled?'Проверка прочитанных ответов включена. Ответ готовится после первичного обращения и сообщения поставщика. Запуск выполняется отдельно.':'Проверка прочитанных чатов выключена. Настройка чтения новых сообщений сохранена.');
  }catch(error){feedback(error.message,true);}finally{scanReadBusy=false;scanReadRequested=null;render();}
});
action('#dialogs-stop',()=>{reviewEpoch++;return act('STOP',{},'Мониторинг остановлен.');});
action('#dialogs-scan',()=>act('SCAN',{},'Проверка чатов площадок завершена.'));
action('#dialogs-takeover',()=>{reviewEpoch++;const item=chosen();return act('CONTROL',{key:item.key,takeover:!item.takeover},item.takeover?'Подготовка ответов снова доступна.':'Разговор под вашим управлением. Ответы Claude приостановлены.');});
action('#dialogs-mute',()=>{reviewEpoch++;const item=chosen();return act('CONTROL',{key:item.key,paused:!item.paused},item.paused?'Пауза переписки снята.':'Переписка поставлена на паузу.');});
function reviewedDraft(item){
  if(!item)throw new Error('Выберите переписку.');
  const edit=edits.get(item.key),text=(edit?.text??item.draft?.text??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim();
  const current=draftRequest(state,item.key),request=edit?.request||current;
  if(!productUI?.isApproved()||request.settingsFingerprint!==current.settingsFingerprint||(request.purpose||'reply')!==(current.purpose||'reply')||edit&&(edit.productFingerprint!==productFingerprint||edit.revision!==item.revision||edit.fingerprint!==item.fingerprint))throw new Error('Переписка, настройки или товар изменились. Проверьте актуальный контекст и подготовьте новый ответ.');
  if(!text.trim())throw new Error('Введите текст ответа.');
  return {key:item.key,text,revision:request.revision,fingerprint:request.fingerprint,settingsFingerprint:request.settingsFingerprint,productFingerprint:request.productFingerprint,...(request.purpose?{purpose:request.purpose}:{}),...(edit?.testSessionId||item.draft?.testSessionId?{draftTestSessionId:edit?.testSessionId||item.draft.testSessionId}:{}),request};
}
async function saveEditedDraft(item){
  const edit=edits.get(item.key);if(!edit)return;
  const reviewed=reviewedDraft(item);
  const {request,...payload}=reviewed;
  const result=await command('SAVE_DRAFT',payload);
  if(edits.get(item.key)===edit)edits.delete(item.key);
  adopt(result);
}
action('#dialogs-save-draft',async()=>{await saveEditedDraft(chosen());feedback(testState().enabled?'Черновик сохранён. Тестовый режим не отправляет сообщения.':'Черновик сохранён. Отправка выполняется отдельной кнопкой.');});
action('#dialogs-send-draft',async()=>{
  const item=chosen();
  if(!testState().enabled&&(edits.get(item?.key)?.testSessionId||item?.draft?.testSessionId))throw new Error('Удалите тестовый черновик и подготовьте новый ответ для настоящей отправки.');
  if(isWechatDraft(item))throw new Error('Удалите старый черновик приглашения. Ответ доступен только после сообщения поставщика на первичное обращение.');
  const reviewed=reviewedDraft(item),intent=reviewEpoch,modeIntent=testModeIntent();
  if(sending.has(item.key))return;
  sending.add(item.key);renderDetail();
  try{
    if(folderPausePromise)await folderPausePromise;
    if(draftEditingPending.has(item.key))await draftEditingPending.get(item.key);
    if(intent!==reviewEpoch||!sameTestIntent(modeIntent)||!productUI?.isApproved()||!state.running||!canDraft(state.conversations[item.key]))throw new Error('Отправка отменена после изменения режима или задания. Проверьте текст и нажмите «Отправить» снова.');
    await saveEditedDraft(item);
    if(intent!==reviewEpoch||!sameTestIntent(modeIntent)||!productUI?.isApproved()||!state.running||!canDraft(state.conversations[item.key]))throw new Error('Отправка отменена после изменения режима или задания. Проверьте текст и нажмите «Отправить» снова.');
    // Keep the exact reviewed text and context even if storage refreshes during saving.
    const {request,...payload}=reviewed;
    const result=await command('SEND_DRAFT',{...payload,...modeIntent});adopt(result);
    feedback(result.send?.detail||'Результат отправки записан в журнал.',!['attempted','previewed'].includes(result.send?.status));
  }finally{sending.delete(item.key);renderDetail();}
});
action('#dialogs-discard-draft',async()=>{reviewEpoch++;const item=chosen();await act('DISCARD_DRAFT',{key:item.key},'Черновик удалён.');edits.delete(item.key);});
action('#dialogs-folder-draft',async()=>{
  const item=chosen();if(!item||!productUI?.isApproved()||!canDraft(item)||!folderState.enabled)throw new Error('Согласуйте товар, подключите Claude и прочитайте актуальную переписку.');
  if(edits.has(item.key))throw new Error('Сохраните или удалите несохранённый черновик.');
  await act('FOLDER_DRAFT',{key:item.key},testState().enabled?'Claude готовит ответ для теста без отправки.':folderState.autoSend?'Claude готовит ответ. Включена автоматическая отправка.':'Claude готовит черновик для вашего одобрения.');
});
$('#dialogs-folder-model').addEventListener('change',()=>{reviewEpoch++;folderDirty=true;render();if(testState().enabled)pauseFolderOnEdit(false,true);});
action('#dialogs-folder-connect',async()=>{
  const permission=chrome.permissions.request({permissions:['nativeMessaging']});
  const settings=folderSettings();
  if(!await permission)throw new Error('Доступ к локальному модулю не разрешён. Claude не подключён.');
  if(folderPausePromise)await folderPausePromise;
  await disableLegacyDrafts();
  const result=await command('FOLDER_SETTINGS',{...settings,resume:true,enabled:true,auto:!!productUI?.isApproved()&&!!state.running,autoSend:!testState().enabled&&!!folderState.autoSend&&!!productUI?.isApproved()});
  folderDirty=false;adopt(result);adopt(await command('FOLDER_STATUS'));
  feedback(folderState.detail||'Состояние Claude обновлено.');
});
$('#dialogs-folder-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy.has('#dialogs-folder-save'))return;
  busy.add('#dialogs-folder-save');renderFolder();
  try{const result=await command('FOLDER_SETTINGS',folderSettings());folderDirty=false;adopt(result);feedback('Модель Claude сохранена.');}
  catch(error){feedback(error.message,true);}finally{busy.delete('#dialogs-folder-save');render();}
});
$('#dialogs-folder-send').addEventListener('change',async()=>{
  const enabled=$('#dialogs-folder-send').checked;
  reviewEpoch++;
  modeBusy=true;modeRequested=enabled;render();
  try{
    if(enabled&&testState().enabled)throw new Error('Сначала выключите тестовый режим. Автоматическая отправка включается отдельно.');
    if(enabled&&(!productUI?.isApproved()||!folderState.enabled||!boundTabs()||folderDirty||edits.size))throw new Error('Подключите Claude, согласуйте товар, откройте чаты и сохраните черновики.');
    if(enabled)await disableLegacyDrafts();
    adopt(await command('FOLDER_SETTINGS',enabled?{enabled:true,auto:true,autoSend:true}:{autoSend:false}));
    if(enabled&&!state.running){await act('START',{readUnread:$('#dialogs-read-unread').checked});readUnreadDirty=false;}
    feedback(enabled?'Автоматический режим включён. Claude будет готовить и отправлять ответы.':'Каждый ответ теперь требует вашего одобрения. Подготовка черновиков продолжается.');
  }catch(error){feedback(error.message,true);}finally{modeBusy=false;modeRequested=null;render();}
});
$('#dialogs-test-mode').addEventListener('change',async()=>{
  const enabled=$('#dialogs-test-mode').checked;
  reviewEpoch++;modeBusy=true;testRequested=enabled;render();
  try{
    const result=await command('FOLDER_SETTINGS',{testMode:enabled,autoSend:false});
    adopt(result);
    feedback(enabled?'Тестовый режим включён. Нажмите «Проверить первый цикл», чтобы проверить один ответ без отправки.':'Тестовый режим выключен. Автоматическая отправка остаётся выключенной.');
  }catch(error){feedback(error.message,true);}finally{modeBusy=false;testRequested=null;render();}
});
action('#dialogs-test-next',async()=>{
  const test=testState(),request={sessionId:test.sessionId,cycleId:test.cycleId},intent=reviewEpoch;
  if(!test.enabled||!['paused','completed'].includes(test.phase))throw new Error('Тестовый цикл уже выполняется или требует проверки причины остановки.');
  if(!folderState.enabled||!productUI?.isApproved()||!boundTabs()||folderDirty||edits.size)throw new Error('Подключите Claude, согласуйте товар, откройте чаты и сохраните изменения.');
  if(folderPausePromise)await folderPausePromise;
  if(intent!==reviewEpoch||!testState().enabled||request.sessionId!==testState().sessionId||request.cycleId!==testState().cycleId||!productUI?.isApproved())throw new Error('Режим или задание изменились. Проверьте настройки перед запуском цикла.');
  const result=await command('TEST_NEXT',request);readUnreadDirty=false;adopt(result);
  feedback(testState().detail||'Запущен один тестовый цикл. Сообщение не будет отправлено.');
});
action('#dialogs-folder-stop',async()=>{reviewEpoch++;adopt(await command('FOLDER_SETTINGS',{enabled:false,auto:false,autoSend:false}));feedback('Claude отключён. Мониторинг может продолжать читать сообщения.');});
action('#dialogs-folder-poll',()=>act('FOLDER_POLL',{},'Задания Claude обновлены.'));
$('#dialogs-draft-text').addEventListener('input',()=>{
  const item=chosen();if(!item)return;
  const previous=edits.get(item.key);
  reviewEpoch++;
  const pending=command('DRAFT_EDITING',{key:item.key}).then(result=>adopt(result)).catch(error=>{feedback('Не удалось приостановить обработку этого ответа: '+error.message,true);throw error;}).finally(()=>{if(draftEditingPending.get(item.key)===pending)draftEditingPending.delete(item.key);});
  draftEditingPending.set(item.key,pending);pending.catch(()=>{});
  let request=previous?.request;try{request||=draftRequest(state,item.key);}catch{}
  edits.set(item.key,{text:$('#dialogs-draft-text').value,revision:previous?.revision??item.revision,fingerprint:previous?.fingerprint??item.fingerprint,productFingerprint:previous?.productFingerprint??productFingerprint,testSessionId:previous?.testSessionId||item.draft?.testSessionId||(testState().enabled?testState().sessionId:''),request});
  renderDetail();renderFolder();if(folderState.autoSend)pauseFolderOnEdit(true);
});
$('#dialogs-filter').addEventListener('change',renderList);$('#dialogs-search').addEventListener('input',renderList);
$('#dialogs-settings-form').addEventListener('input',()=>{settingsDirty=true;productUI?.setSettingsDirty(true);renderSettings();});
$('#dialogs-settings-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy.has('#dialogs-save-settings'))return;
  busy.add('#dialogs-save-settings');renderSettings();
  try{
    if(folderPausePromise)await folderPausePromise;
    const result=await command('SETTINGS',{settings:{brief:$('#dialogs-brief').value,wechat:$('#dialogs-wechat').value,language:$('#dialogs-language').value,autoDraft:false}});
    settingsDirty=false;productUI?.setSettingsDirty(false);adopt(result);feedback('Контекст сохранён. Согласуйте сведения о товаре заново.');
  }catch(error){feedback(error.message,true);}finally{busy.delete('#dialogs-save-settings');if(state)render();}
});
productUI=setupProductUI({command,adopt,feedback,getFolderState:()=>({...folderState,dirty:folderDirty}),onApproved:async()=>{if(state?.running)await enableAutomaticDrafts();},onDirty:()=>{if(state){if(productUI?.isDirty())reviewEpoch++;renderDetail();renderFolder();pauseFolderOnEdit();}}});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&Object.keys(changes).some(key=>/dialog|claudeFolder/i.test(key)))refresh();});
refresh();
setInterval(()=>{if(!document.hidden)refresh();},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setupJointModeUI({beforeStart:async()=>{
  if(settingsDirty||productUI?.isDirty())throw new Error('Сначала сохраните изменения товара и контекста.');
  if(folderDirty)throw new Error('Сначала сохраните выбранную модель Claude.');
  if(edits.size)throw new Error('Сначала сохраните или удалите несохранённые черновики.');
  if(testState().enabled)throw new Error('Совместная работа запускает первичную очередь с настоящими сообщениями. Сейчас включён тест без отправки. Для общего запуска требуется рабочий режим; тестовый режим автоматически не отключается.');
  if(openingChats||modeBusy||folderPausing||scanReadBusy)throw new Error('Дождитесь завершения изменения режима или подключения чатов.');
  reviewEpoch++;
},afterChange:refresh});
