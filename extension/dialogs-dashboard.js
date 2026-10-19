import {displayTime} from './lib/time.js';
import {setupProductUI} from './dialogs-product.js';
import {canPrepareDraft, contactAssessment, draftRequest, supplierReplyAssessment, workflowAssessment} from './lib/dialogs.js';
import {setupJointModeUI} from './joint-mode-ui.js';
import {setupAuditUI} from './dialogs-audit-ui.js';

const $=selector=>document.querySelector(selector);
const PLATFORMS={'1688':'1688',alibaba:'Alibaba',mic:'Made-in-China'};
const STATUS={unbound:['Чат не открыт',''],ready:['Чат доступен','good'],ok:['Чат доступен','good'],observing:['Мониторинг','good'],scanning:['Проверка…',''],loading:['Загрузка…',''],unsupported:['Страница не распознана','warn'],partial:['Прочитана часть данных','warn'],closed:['Вкладка закрыта','bad'],missing:['Вкладка не найдена','bad'],error:['Ошибка проверки','bad'],blocked:['Нужно вмешательство','warn'],login:['Нужен вход','warn'],captcha:['Проверка площадки','warn'],paused:['Мониторинг остановлен',''],stale:['Данные устарели','warn'],idle:['Ожидает проверки','']};
const FOLDER_STATUS={disabled:['Выключено',''],idle:['Ожидание задания',''],ready:['Подключено','good'],connected:['Подключено','good'],waiting:['Обработчик не запущен','warn'],claude_missing:['Claude Code не найден','warn'],pending:['В очереди',''],preparing:['Подготовка задания',''],queued:['В очереди',''],running:['Claude обрабатывает',''],paused:['Приостановлено','warn'],offline:['Нет соединения с Claude','warn'],needslogin:['Нужен вход в Claude Code','warn'],needs_login:['Нужен вход в Claude Code','warn'],authentication_required:['Нужен вход в Claude Code','warn'],subscription_auth_required:['Нужен вход через подписку Claude','warn'],subscription_auth_unverified:['Не удалось проверить вход в Claude Code','warn'],usage_limit:['Достигнут лимит Claude','warn'],missing:['Локальный модуль не найден','warn'],unavailable:['Обработчик недоступен','warn'],error:['Ошибка','bad'],stale:['Контекст изменился','warn'],done:['Обработано','good'],accepted:['Результат принят','good'],cancelled:['Отменено',''],awaiting_limit:['Ответ готов · ожидание лимита площадки','warn'],sending:['Отправка поставщику','warn'],sent:['Кнопка отправки нажата','good'],send_unknown:['Отправка не подтверждена — проверьте чат','warn'],unknown:['Результат операции неизвестен','warn'],previewed:['Тест завершён · без отправки','test'],test_completed:['Тест завершён · без отправки','test']};
const OUTCOME_STATUS={
  unvisited:['Ещё не проверен','','pending'],completed:['WeChat найден — диалог завершён','good','completed'],
  awaiting_approval:['Ожидает вашего решения','warn','review'],test_preview:['Тест: ответ в поле — не отправлен','test','test'],test_completed:['Тест завершён — не отправлено','test','test'],previewed:['Тест: ответ в поле — не отправлен','test','test'],
  sent:['Кнопка отправки нажата','good','sent'],attempted:['Кнопка отправки нажата','good','sent'],waiting_supplier:['Ожидает ответа поставщика','','sent'],
  send_unknown:['Исход отправки неизвестен','bad','issue'],attempt_unknown:['Исход отправки неизвестен','bad','issue'],unknown:['Результат операции неизвестен','warn','issue'],
  skipped:['Чат пропущен','','skipped'],expired:['Пропущен: сообщение старше суток','','skipped'],
  failed:['Ошибка обработки','bad','issue'],error:['Ошибка обработки','bad','issue'],blocked:['Нужно вмешательство','warn','issue'],history_unavailable:['Начало истории недоступно','warn','issue'],first_message_unknown:['Первое ваше сообщение не подтверждено','warn','issue'],
  date_unknown:['Дата сообщения неизвестна','warn','issue'],future_date:['Нужно проверить дату сообщения','warn','issue'],product_not_found:['Товар не найден в памяти','warn','issue'],no_product_memory:['Нет сохранённого товара','warn','issue'],product_ambiguous:['Найдено несколько товаров','warn','issue'],no_initial_outreach:['Первичное обращение не найдено','warn','issue'],
  unavailable:['Диалог пока недоступен','warn','issue'],unreadable:['История прочитана не полностью','warn','issue'],stale:['Контекст изменился','warn','issue'],paused:['На паузе','','pending'],takeover:['Под вашим управлением','','pending'],
  ready:['Готов к подготовке ответа','','pending'],matched:['Товар определён','','pending'],preparing_reply:['Подготовка ответа','','pending'],waiting_claude:['Claude готовит ответ','','pending'],generating:['Claude готовит ответ','','pending'],preparing:['Подготовка ответа','','pending'],pending:['В очереди на обработку','','pending'],queued:['В очереди на обработку','','pending'],awaiting_limit:['Ответ готов — ожидание лимита','warn','pending'],accepted:['Ответ подготовлен','','review'],done:['Ответ подготовлен','','review'],reading_first:['Чтение первого сообщения','','pending'],reading_latest:['Чтение последних сообщений','','pending'],opening:['Открытие переписки','','pending']
};
const FOLDER_PAUSE={offline:'Нет соединения с Claude. Подключите интернет и нажмите «Возобновить обработку».',authentication_required:'Войдите в Claude Code через вашу подписку, затем нажмите «Возобновить обработку».',subscription_auth_required:'Войдите в Claude Code через аккаунт с подпиской Claude, затем нажмите «Возобновить обработку».',subscription_auth_unverified:'Не удалось проверить вход в Claude Code. Проверьте его установку и авторизацию, затем нажмите «Возобновить обработку».',usage_limit:'Достигнут лимит подписки Claude. Возобновите обработку после восстановления лимита.',claude_update_required:'Обновите Claude Code, затем возобновите обработку.',claude_failed:'Claude завершил задание с ошибкой. Проверьте журнал обработчика перед возобновлением.',invalid_claude_output:'Ответ Claude не удалось прочитать. Проверьте журнал обработчика перед возобновлением.'};
let folderState={enabled:false,auto:false,autoSend:false,model:'haiku',status:'disabled',jobs:[]},folderDirty=false,folderPausing=false,folderPausePromise=null,modeBusy=false,modeRequested=null,testRequested=null;
let state=null, productFingerprint='', productUI, openingChats=false, openingPlatform=null, selectedKey=null, settingsDirty=false, readUnreadDirty=false, scanReadBusy=false, scanReadRequested=null, loading=false, viewModeBusy=false, viewModeRequested=null, historySignature='', reviewEpoch=0;
const edits=new Map(), busy=new Set(), sending=new Set(), draftEditingPending=new Map();
let assessmentCache=new WeakMap(),assessmentAt=Date.now(),reviewEdit=null,testPlatformChoice=null,testPlatformSession='',testPlatformSwitching=false,resultsPage=0;

function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function feedback(text,error=false){const el=$('#dialogs-feedback');el.textContent=text;el.classList.toggle('error',error);el.hidden=!text;}
function auditMode(){return state?.settings?.wechatAudit===true;}
function workflowMode(){return state?.settings?.workflow24h===true;}
function hasReplyContext(){return workflowMode()?productUI?.hasMemories():productUI?.isApproved();}
function assessment(conversation){if(!conversation||typeof conversation!=='object')return workflowMode()?workflowAssessment(state,conversation,assessmentAt):supplierReplyAssessment(state,conversation);if(!assessmentCache.has(conversation))assessmentCache.set(conversation,workflowMode()?workflowAssessment(state,conversation,assessmentAt):supplierReplyAssessment(state,conversation));return assessmentCache.get(conversation);}
function resetAssessments(){assessmentCache=new WeakMap();assessmentAt=Date.now();}
function contextInstruction(){return workflowMode()?'Сохраните хотя бы один согласованный товар в память в шаге 2.':'Сохраните и согласуйте товар в шаге 2.';}
function chosen(){return state?.conversations?.[selectedKey]||null;}
function reviewState(){return folderState.review||{phase:'none',operationId:'',key:'',text:'',context:'',request:null};}
function reviewActive(){return reviewState().phase!=='none'&&!!reviewState().operationId;}
function reviewSignature(review){const request=review.request||{};return JSON.stringify([review.operationId,review.key,review.context,review.text,request.revision,request.fingerprint,request.productFingerprint,request.settingsFingerprint]);}
function testState(){return folderState.test||{enabled:false,phase:'off',sessionId:'',cycleId:'',key:'',text:'',at:null,completed:[]};}
function testInProgress(){return !auditMode()&&state?.running===true&&testState().enabled&&['ready','generating','preparing'].includes(testState().phase);}
function resumableTest(){return workflowMode()&&!state?.running&&testState().enabled&&['ready','generating','preparing'].includes(testState().phase);}
function testModeIntent(){const test=testState();return test.enabled?{testMode:true,testSessionId:test.sessionId,testCycleId:test.cycleId}:{testMode:false};}
function sameTestIntent(intent){const current=testModeIntent();return intent.testMode===current.testMode&&(!intent.testMode||intent.testSessionId===current.testSessionId&&intent.testCycleId===current.testCycleId);}
function date(at){return at==null?'Время не указано':displayTime(at);}
function safeUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(^|\.)(1688\.com|alibaba\.com|made-in-china\.com)$/.test(u.hostname)?u.href:null;}catch{return null;}}
async function command(type,payload={}){const result=await chrome.runtime.sendMessage({type:'DIALOGS_'+type,...payload});if(!result?.ok)throw new Error(result?.error||'Расширение не ответило. Перезагрузите эту страницу.');return result;}
function adopt(result){if(result.state)state=result.state;if(state&&Object.hasOwn(result,'workflowActivity'))state.workflowActivity=result.workflowActivity;if(state&&Object.hasOwn(result,'workflowActivityHistory'))state.workflowActivityHistory=result.workflowActivityHistory;if(result.folder)folderState=result.folder;if(typeof result.productFingerprint==='string')productFingerprint=result.productFingerprint;else if(result.state?.product?.fingerprint)productFingerprint=result.state.product.fingerprint;render();}
async function refresh(){if(loading)return;loading=true;try{adopt(await command('GET'));}catch(error){feedback(error.message,true);}finally{loading=false;}}
async function act(name,payload={},message=''){const result=await command(name,payload);if(result.state||result.folder)adopt(result);else await refresh();if(message)feedback(message);return result;}
function action(selector,handler){$(selector).addEventListener('click',async()=>{if(busy.has(selector))return;busy.add(selector);$(selector).disabled=true;try{await handler();}catch(error){feedback(error.message,true);}finally{busy.delete(selector);$(selector).disabled=false;if(state)render();}});}
function makeButton(label,handler,className='button secondary'){const button=node('button',label,className);button.type='button';button.addEventListener('click',async()=>{button.disabled=true;try{await handler();}catch(error){feedback(error.message,true);}finally{if(button.isConnected)button.disabled=false;}});return button;}
function threadFlags(conversation){const result=[];const test=testState();if(test.enabled&&((test.key===conversation.key&&test.phase==='completed')||(test.completed||[]).some(item=>item.key===conversation.key)))result.push(['Тест: без отправки','test']);if(conversation.takeover)result.push(['Под вашим управлением','']);if(conversation.paused)result.push(['На паузе','']);const reply=assessment(conversation),outcome=workflowMode()?chatOutcome(conversation.key):null,hasOutcome=outcome&&outcomeApplies(conversation,outcome);if(hasOutcome)result.push([outcome.label,outcome.tone]);if(reply.allowed&&!hasOutcome)result.push(['Требует ответа','warn']);else if(!hasOutcome&&reply.status==='waiting_supplier')result.push(['Ждём ответа поставщика','']);else if(!hasOutcome&&reply.status==='no_initial_outreach')result.push(['Первичное обращение не найдено','warn']);if(workflowMode()){if(!hasOutcome&&reply.status==='completed')result.push(['Завершён · WeChat найден','good']);else if(!hasOutcome&&!reply.allowed&&!['completed','waiting_supplier','no_initial_outreach','paused','takeover'].includes(reply.status))result.push([reply.detail||'Нужна проверка','warn']);if(reply.memoryName)result.push([reply.memoryName,'']);}if(conversation.unread===true||Number(conversation.unread)>0)result.push(['Непрочитано на площадке','warn']);if(conversation.needsRead)result.push([conversation.messages?.length||readerDetail(conversation)?'Нужна проверка истории':'Нужно открыть историю','']);if(!workflowMode()&&state.settings?.scanRead){const contact=contactAssessment(state,conversation);if(contact.status==='shared')result.push(['WeChat уже передан','good']);else if(contact.status==='blocked_capacity')result.push(['WeChat: память проверок заполнена','warn']);}if(conversation.autoDraft?.status==='pending')result.push(['ИИ готовит черновик','']);if(conversation.autoDraft?.status==='error')result.push(['Ошибка черновика','warn']);if(conversation.draft)result.push([conversation.draft.status==='stale'?'Черновик устарел':'Есть черновик',conversation.draft.status==='stale'?'warn':'good']);return result;}
function chatOutcome(key){
  const item=state?.conversations?.[key],visit=state?.workflow?.visits?.[key],record=visit?.lastResult||visit;
  const status=record?.status||'unvisited',[label,tone,group]=OUTCOME_STATUS[status]||['Нужна проверка','warn','issue'];
  const name=typeof visit?.title==='string'&&visit.title.trim()?visit.title:item?.title;
  const platform=Object.hasOwn(PLATFORMS,visit?.platform)?visit.platform:Object.hasOwn(PLATFORMS,item?.platform)?item.platform:Object.keys(PLATFORMS).find(name=>key.startsWith(name+':'))||'';
  return {key,status,label,tone,group,platform,title:name?.trim()||'Имя поставщика не прочитано',at:Number.isFinite(record?.at)?record.at:null,detail:record?.detail||(status==='unvisited'?'Обработка этого чата ещё не выполнялась.':'Подробности результата не сохранены.'),fingerprint:record?.fingerprint||visit?.fingerprint||'',cached:!!item,visited:!!record};
}
function outcomeApplies(item,outcome){return outcome.visited&&(!outcome.fingerprint||outcome.fingerprint===item.fingerprint);}
function renderOutcome(item){
  const result=chatOutcome(item.key);
  $('#dialogs-outcome-status').textContent=result.label;$('#dialogs-outcome-status').className='dialogs-status '+result.tone;
  $('#dialogs-outcome-detail').textContent=result.detail;
  $('#dialogs-outcome-time').textContent=result.at===null?'Обработка ещё не зафиксирована.':'Последняя обработка: '+date(result.at);
}
function renderResults(){
  const query=$('#dialogs-results-search').value.trim().toLocaleLowerCase(),filter=$('#dialogs-results-filter').value,platform=$('#dialogs-results-platform').value;
  const keys=[...new Set([...Object.keys(state.workflow?.visits||{}),...Object.keys(state.conversations||{})])];
  const all=keys.map(chatOutcome),rows=all.filter(row=>(filter==='all'||row.group===filter)&&(platform==='all'||row.platform===platform)&&(!query||[row.title,PLATFORMS[row.platform],row.label,row.detail].join(' ').toLocaleLowerCase().includes(query))).sort((a,b)=>(b.at??-1)-(a.at??-1)||a.title.localeCompare(b.title));
  const pageSize=50,pages=Math.max(1,Math.ceil(rows.length/pageSize));resultsPage=Math.min(resultsPage,pages-1);
  const body=$('#dialogs-results-body');body.replaceChildren();
  for(const row of rows.slice(resultsPage*pageSize,(resultsPage+1)*pageSize)){
    const line=node('tr');line.dataset.resultKey=row.key;line.dataset.resultStatus=row.status;
    const status=node('td'),action=node('td');status.append(node('span',row.label,'dialogs-status '+row.tone));
    if(row.cached){const button=makeButton('История',()=>{selectedKey=row.key;historySignature='';renderList();renderDetail();$('#dialogs-detail').scrollIntoView({block:'start'});},'link-button');button.setAttribute('aria-label','Открыть историю: '+row.title);action.append(button);}
    else action.append(node('span','История не загружена','hint'));
    line.append(node('td',PLATFORMS[row.platform]||'Площадка не определена'),node('td',row.title),status,node('td',row.detail),node('td',row.at===null?'Ещё не проверен':date(row.at)),action);body.append(line);
  }
  $('#dialogs-results-count').textContent=all.filter(row=>row.visited).length+' результатов · '+all.length+' чатов';
  $('#dialogs-results-empty').hidden=rows.length>0;$('#dialogs-results-empty').textContent=all.length?'Нет результатов с выбранными условиями.':'История обработки пока пуста. Откройте чаты и запустите проверку.';
  $('#dialogs-results-prev').disabled=resultsPage===0;$('#dialogs-results-next').disabled=resultsPage>=pages-1;
  $('#dialogs-results-page').textContent=rows.length?(resultsPage*pageSize+1)+'–'+Math.min((resultsPage+1)*pageSize,rows.length)+' из '+rows.length:'0 результатов';
}
function isWechatDraft(conversation){return conversation?.draft?.purpose==='wechat';}
function canDraft(conversation){return !!conversation&&!isWechatDraft(conversation)&&assessment(conversation).allowed;}
function wechatAssessmentText(conversation){
  if(workflowMode()){const result=assessment(conversation);return result.status==='completed'?'Ваш точный WeChat ID найден в переписке. Диалог завершён; новые ответы не готовятся.':'Диалог завершается, когда ваш точный WeChat ID найден в любом сообщении. Частичные совпадения не учитываются.';}
  const contact=contactAssessment(state,conversation);
  if(contact.status==='shared')return 'Ваш WeChat найден в исходящем сообщении. Повторное приглашение не требуется.';
  if(contact.status==='blocked_capacity')return contact.detail||'Память проверок WeChat заполнена; сохранённые подтверждения не удаляются.';
  if(contact.status==='not_found')return 'В доступной истории WeChat не найден. Более ранние сообщения могут быть недоступны. Контакт можно предложить в ответе поставщику по вашим правилам.';
  if(contact.status==='no_contact')return 'Сохраните ваш WeChat в разделе «Контекст переговоров и WeChat» в шаге 2.';
  return contact.detail||'Пока нельзя проверить, передавался ли ваш WeChat: история не прочитана полностью или автор сообщения не определён.';
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
  const reply=assessment(conversation);if(!reply.allowed)return reply.detail;
  if(testState().enabled&&testState().phase==='completed')return workflowMode()?'Ответ введён в чат без отправки. В окне проверки наверху завершите тест или пропустите чат.':'Цикл выполнен — сообщение не отправлено. Для продолжения нажмите «Проверить следующий цикл» в шаге 3.';
  if(testState().enabled&&['paused','blocked'].includes(testState().phase))return workflowMode()?'Управление тестом и причина остановки показаны в окне проверки наверху.':testState().phase==='blocked'?'Тест приостановлен. Проверьте причину в шаге 3.':'Запустите первый тестовый цикл в шаге 3.';
  if(!hasReplyContext())return contextInstruction();
  if(settingsDirty)return 'Сначала сохраните контекст переговоров.';
  if(testState().enabled)return workflowMode()?'Точный ответ Claude появится здесь и будет введён в поле чата. После проверки завершите тест или пропустите чат. Отправка выключена.':'Тестовый цикл читает переписку, получает ответ Claude и вводит текст в чат. Сообщение поставщику не отправляется.';
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
function displayReplyNeeded(item){const reply=assessment(item);if(!reply.allowed)return false;if(!workflowMode())return true;const outcome=chatOutcome(item.key);return !outcomeApplies(item,outcome)||['ready','matched','unvisited'].includes(outcome.status);}
function filteredConversations(){const query=$('#dialogs-search').value.trim().toLocaleLowerCase(),filter=$('#dialogs-filter').value;return Object.values(state?.conversations||{}).filter(item=>{if(filter==='unanswered'&&!displayReplyNeeded(item))return false;if(filter==='completed'&&assessment(item).status!=='completed')return false;if(filter==='waiting'&&assessment(item).status!=='waiting_supplier')return false;if(filter==='blocked'&&(assessment(item).allowed||['completed','waiting_supplier','expired'].includes(assessment(item).status)))return false;if(filter==='unread'&&!(item.unread===true||Number(item.unread)>0))return false;if(filter==='takeover'&&!item.takeover)return false;if(filter==='paused'&&!item.paused)return false;const haystack=[item.title,item.platform,PLATFORMS[item.platform],item.url,item.preview,...(item.messages||[]).map(m=>m.text)].filter(Boolean).join(' ').toLocaleLowerCase();return !query||haystack.includes(query);}).sort((a,b)=>Number(b.unanswered)-Number(a.unanswered)||(b.updatedAt||0)-(a.updatedAt||0)||a.key.localeCompare(b.key));}
function renderList(){resetAssessments();const conversations=filteredConversations(),all=Object.values(state?.conversations||{}),list=$('#dialogs-list');$('#dialogs-count').textContent=all.length+' · требуют ответа: '+all.filter(displayReplyNeeded).length;list.replaceChildren();for(const conversation of conversations){const button=node('button',undefined,'dialogs-thread'+(conversation.key===selectedKey?' selected':''));button.type='button';button.dataset.key=conversation.key;button.setAttribute('aria-pressed',String(conversation.key===selectedKey));button.append(node('strong',conversation.title||'Поставщик не определён'),node('p',(PLATFORMS[conversation.platform]||conversation.platform)+' · '+date(workflowMode()?(assessment(conversation).latestMessageAt??conversation.latestMessageAt):conversation.updatedAt),'hint'));const last=(conversation.messages||[]).at(-1);button.append(node('div',last?.text||conversation.preview||'История ещё не прочитана','dialogs-preview'));const flags=node('div',undefined,'dialogs-thread-flags');for(const [label,tone] of threadFlags(conversation))flags.append(node('span',label,'dialogs-status '+tone));button.append(flags);button.addEventListener('click',()=>{selectedKey=conversation.key;historySignature='';renderList();renderDetail();});list.append(button);}$('#dialogs-empty').hidden=conversations.length>0;$('#dialogs-empty').textContent=all.length?'Переписок с такими условиями нет.':'Откройте чаты площадок и запустите мониторинг. Здесь появятся прочитанные переписки и доступный список чатов.';}
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
  renderOutcome(conversation);
  $('#dialogs-supplier').textContent=conversation.title||'Поставщик не определён';
  $('#dialogs-conversation-status').textContent=[PLATFORMS[conversation.platform],...threadFlags(conversation).map(([label])=>label)].filter(Boolean).join(' · ');
  const url=safeUrl(conversation.url),link=$('#dialogs-source');
  link.hidden=!url;
  if(url)link.href=url;else link.removeAttribute('href');
  $('#dialogs-takeover').textContent=conversation.takeover?'Вернуть подготовку черновиков':'Взять разговор на себя';
  $('#dialogs-mute').textContent=conversation.paused?'Снять паузу переписки':'Пауза для этой переписки';
  const workflow=workflowMode()?assessment(conversation):null;
  $('#dialogs-workflow-assessment').hidden=!workflow;
  $('#dialogs-workflow-assessment').textContent=workflow?['Текущая проверка:',workflow.memoryName?'Товар: '+workflow.memoryName:'',workflow.detail,(workflow.latestMessageAt??conversation.latestMessageAt)?'Последнее сообщение: '+date(workflow.latestMessageAt??conversation.latestMessageAt):'Дата последнего сообщения не подтверждена.'].filter(Boolean).join(' · '):'';
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
  const previousDraft=conversation.previousDraft;
  $('#dialogs-previous-draft').hidden=!previousDraft?.text;
  $('#dialogs-previous-draft-text').textContent=previousDraft?.text||'';
  $('#dialogs-previous-draft-note').textContent=previousDraft?[previousDraft.detail,previousDraft.createdAt?'Подготовлен: '+date(previousDraft.createdAt):''].filter(Boolean).join(' '):'';
  renderHistory(conversation);
  const test=testState(),testRecord=(test.completed||[]).find(entry=>entry.key===conversation.key),currentTest=test.key===conversation.key&&test.phase==='completed';
  $('#dialogs-conversation-test-note').hidden=!test.enabled||(!currentTest&&!testRecord);
  $('#dialogs-conversation-test-note').textContent=currentTest?(workflowMode()?'Тестовый ответ введён в поле чата, но не отправлен. Завершите тест или пропустите чат в окне проверки наверху.':'Цикл выполнен — сообщение не отправлено. Текст оставлен в поле чата для проверки.'):testRecord?'Эта переписка уже участвовала в тесте: '+date(testRecord.at)+'. Ответ учтён только в тестовом режиме; сообщение не отправлялось.':'';
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
  const stale=!!edit&&(edit.revision!==conversation.revision||edit.fingerprint!==conversation.fingerprint||edit.productFingerprint!==currentRequest?.productFingerprint||edit.request?.settingsFingerprint&&edit.request.settingsFingerprint!==currentRequest?.settingsFingerprint||(edit.request?.purpose||'reply')!==(currentRequest?.purpose||'reply'));
  $('#dialogs-draft-status').textContent=stale?'Переписка, настройки или товар изменились после начала редактирования. Скопируйте нужные правки и подготовьте актуальный ответ.':edit?(test.enabled?'Есть несохранённые изменения. В тестовом режиме текст проверяется без отправки.':'Есть несохранённые изменения. «Отправить» сохранит и отправит именно этот текст.'):draft?.status==='stale'?'Черновик устарел: изменились переписка или сведения о товаре.':draft?'Черновик сохранён: '+date(draft.createdAt):'Claude ещё не подготовил ответ.';
  const ready=canDraft(conversation)&&!!hasReplyContext()&&canPrepareDraft(state,conversation.key);
  const isSending=sending.has(conversation.key);
  $('#dialogs-generate-hint').textContent=draftBlockReason(conversation);
  $('#dialogs-folder-draft').disabled=scanReadBusy||!ready||!folderState.enabled||folderDirty||folderPausing||pending||isSending||!!edit||!!draft||test.enabled&&test.phase!=='ready';
  $('#dialogs-folder-draft').textContent='Подготовить ответ';
  $('#dialogs-folder-draft').title=test.enabled?(workflowMode()?'Ответ будет введён в поле чата без отправки; затем расширение дождётся вашего решения.':'Ответ будет введён в чат без отправки. Один тестовый цикл, затем пауза.'):folderState.autoSend?'Ответ может быть отправлен автоматически после проверки контекста.':'Ответ будет сохранён для вашего одобрения.';
  $('#dialogs-save-draft').disabled=!ready||!edit?.text.trim()||stale||isSending;
  $('#dialogs-discard-draft').disabled=(!edit&&!draft)||isSending;
  $('#dialogs-draft-text').disabled=!canDraft(conversation)||isSending;
  const unsafeWechat=isWechatDraft(conversation),ownsReview=reviewActive()&&reviewState().key===conversation.key;
  $('#dialogs-send-draft').disabled=ownsReview||scanReadBusy||!ready||!state.running||!text.trim()||stale||!edit&&draft?.status==='stale'||!!receipt||folderPausing||modeBusy||isSending||testOriginBlocked||unsafeWechat||test.enabled&&test.phase!=='ready';
  $('#dialogs-send-draft').textContent=isSending?(test.enabled?'Проверка…':'Отправка…'):test.enabled?'Проверить без отправки':'Отправить';
  $('#dialogs-send-note').textContent=testOriginBlocked?'Тестовый ответ нельзя отправить настоящему поставщику. Удалите этот черновик и подготовьте новый ответ после выхода из тестового режима.':test.enabled?(test.phase==='completed'?(workflowMode()?'Ответ введён без отправки. Завершите тест или пропустите чат в окне наверху.':'Проверка завершена. Переход к следующему циклу доступен в шаге 3.'):test.phase==='blocked'?'Тест приостановлен. Проверьте причину в шаге 3.':test.phase==='paused'?'Сначала нажмите «Проверить первый цикл» в шаге 3.':workflowMode()?'Кнопка проверит контекст и введёт этот текст в поле чата без отправки.':'Кнопка проверит адресата и введёт этот текст в поле чата. Отправка не выполняется.') :receipt?(receipt.status==='unknown'?'Исход предыдущей отправки неизвестен. Проверьте чат: повторная отправка заблокирована.':receipt.status==='sending'?'Отправка уже выполняется.':'Кнопка отправки уже нажата. Повторная отправка этого ответа заблокирована.'):!state.running?'Для отправки запустите мониторинг и откройте эту переписку во вкладке мониторинга.':'Откройте эту переписку во вкладке площадки и нажмите «Проверить сейчас». «Отправить» одобряет показанный текст; адресат и новые сообщения проверяются повторно.';
  if(ownsReview)$('#dialogs-send-note').textContent='Ответ уже находится в поле чата. Используйте окно проверки наверху: «Отправить» или «Пропустить и перейти дальше».';
  if(unsafeWechat&&!testOriginBlocked)$('#dialogs-send-note').textContent='Старый черновик приглашения недоступен для отправки. Удалите его и дождитесь ответа поставщика на первичное обращение.';
  for(const id of busy)if($(id))$(id).disabled=true;
}
function renderSettings(){
  if(!settingsDirty){$('#dialogs-brief').value=state.settings?.brief||'';$('#dialogs-wechat').value=state.settings?.wechat||'';$('#dialogs-language').value=state.settings?.language||'';}
  $('#dialogs-save-settings').disabled=!settingsDirty||busy.has('#dialogs-save-settings');
  $('#dialogs-scan-read-control').hidden=workflowMode();$('#dialogs-read-options').hidden=workflowMode();
  $('#dialogs-scan-read').checked=scanReadRequested??state.settings?.scanRead===true;
  $('#dialogs-scan-read').disabled=scanReadBusy||modeBusy||folderPausing||settingsDirty||testInProgress();
  $('#dialogs-scan-read-note').textContent=workflowMode()?'Проверяются все доступные чаты с последним сообщением за 24 часа. Для ответа нужны подтверждённое начало переписки, первый ваш запрос, сохранённый товар и последующее сообщение поставщика. Неопределённые даты и неполная история показываются как причина остановки.':scanReadBusy?'Сохраняю настройку чтения ответов…':state.settings?.scanRead?'Проверка включена: расширение открывает также прочитанные ответы. Ответ готовится только после вашего первичного сообщения и последующего сообщения поставщика в доступной истории. Если WeChat сохранён, учитывается его предыдущая передача.':'При включении проверяются также прочитанные ответы поставщиков на ваши первичные обращения. Отсутствие WeChat не запускает отдельное сообщение.';
}

function renderEvents(){const events=state.events||[],list=$('#dialogs-events');list.replaceChildren();for(const event of [...events].slice(-100).reverse()){const item=node('li'),at=event.at??event.time;item.append(node('time',date(at)),node('span',[(PLATFORMS[event.platform]||event.platform),event.detail||event.message||event.type||event.event].filter(Boolean).join(' · ')));list.append(item);}$('#dialogs-events-empty').hidden=events.length>0;}
function renderActivity(){
  $('#dialogs-show-working-tab').checked=viewModeRequested??state.settings?.showWorkingTab===true;
  $('#dialogs-show-working-tab').disabled=viewModeBusy;
  const activity=state.workflowActivity||{},test=testState(),phase=activity.phase||activity.action||'idle';
  const labels={awaiting_approval:'Ожидаю ваше решение: отправить или пропустить',reading_list:'Проверяю список чатов',reading_first:'Читаю первое ваше сообщение',reading_latest:'Читаю последние сообщения',preparing_reply:'Готовлю ответ по выбранному товару',waiting_claude:'Claude готовит ответ',waiting_queue:'Ожидаю очередь первичных обращений',user_busy:'Перехожу дальше: чат занят',history_retry:'Повторно проверю историю',memory_saved:'Товар сохранён в память',memory_deleted:'Товар удалён из памяти',running:'Обход чатов запущен',test_preview:'Тестовый ответ готов',idle:'Ожидание следующего обхода',paused:'Работа на паузе',scanning:'Проверяю список чатов',scan:'Проверяю список чатов',opening:'Открываю переписку',reading:'Читаю сообщения',history:'Проверяю начало переписки',matching:'Определяю товар',generating:'Claude готовит ответ',drafting:'Claude готовит ответ',preview:'Точный ответ готов к проверке',previewed:'Тестовый ответ готов',completed:'Проверка завершена',waiting_supplier:'Перехожу дальше: ожидаю ответ продавца',waiting:'Ожидаю новые сообщения',blocked:'Нужна проверка',error:'Не удалось завершить действие',sending:'Отправляю согласованный ответ'};
  const current=state.running&&(test.enabled?testInProgress():true);
  $('#dialogs-activity-status').textContent=current?(test.enabled?'Тест · без отправки':'В работе'):'На паузе';
  $('#dialogs-activity-status').className='dialogs-status '+(current?(test.enabled?'test':'good'):'');
  $('#dialogs-activity-action').textContent=!current&&!['completed','test_preview'].includes(phase)?'Работа на паузе':labels[phase]||'Проверяю чат';
  const conversation=state.conversations?.[activity.conversationKey||activity.key];
  $('#dialogs-activity-target').textContent=[PLATFORMS[activity.platform]||activity.platform,conversation?.title||activity.conversationKey||activity.key].filter(Boolean).join(' · ');
  $('#dialogs-activity-detail').textContent=activity.detail||(!hasReplyContext()?contextInstruction():current?'Ожидаю актуальное состояние площадок.':'Продолжите обход или запустите один тестовый цикл.');
  $('#dialogs-activity-time').textContent=activity.at?'Последнее действие: '+date(activity.at):'';
  const next=$('#dialogs-test-next'),start=$('#dialogs-start');
  $('#dialogs-activity-resume').disabled=test.enabled?next.disabled:start.disabled;
  $('#dialogs-activity-resume').textContent=test.enabled?next.textContent:'Продолжить блок 2';
  $('#dialogs-activity-pause').disabled=$('#dialogs-stop').disabled||busy.has('#dialogs-activity-pause');
  const events=state.workflowActivityHistory||[...(state.events||[])].filter(event=>event.type?.startsWith('workflow_')).reverse(),list=$('#dialogs-activity-events');
  list.replaceChildren();
  for(const event of events.slice(0,12)){const item=node('li');item.append(node('time',date(event.at)),node('span',[(PLATFORMS[event.platform]||event.platform),event.detail||event.message||labels[event.phase]||event.type].filter(Boolean).join(' · ')));list.append(item);}
  $('#dialogs-activity-empty').hidden=events.length>0;
}
function folderSettings(){return {model:$('#dialogs-folder-model').value};}
function boundTabs(){return Object.values(state?.bindings||{}).some(binding=>binding.tabId!=null);}
function renderFolder(){
  const test=testState();
  const folder=folderState,enabled=folder.enabled===true,approved=hasReplyContext(),worker=folder.worker||{};
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
  $('#dialogs-folder-send').disabled=scanReadBusy||test.enabled||modeBusy||folderPausing||(!folder.autoSend&&(openingChats||!enabled||!approved||!boundTabs()||folderDirty||edits.size>0||reviewActive()));
  $('#dialogs-mode').classList.toggle('automatic',!test.enabled&&!!folder.autoSend);
  $('#dialogs-mode').classList.toggle('test-mode',!!test.enabled);
  $('#dialogs-mode-label').textContent=modeBusy?'Меняю режим…':test.enabled?'Тестовый режим':folder.autoSend?'Автоматический режим':'С вашим одобрением';
  $('#dialogs-folder-send-note').textContent=test.enabled?(workflowMode()?'Claude вводит ответ в поле чата и ждёт вашего решения. Отправка выключена на всех площадках.':'Настоящие чаты и ответы Claude. Текст вводится в поле сообщения; отправка выключена на всех площадках.'):folder.autoSend?'Claude читает новые сообщения, готовит и отправляет ответы по согласованным правилам. Снимите галочку, чтобы проверять каждый ответ.':workflowMode()?'Claude готовит ответ, вводит его в поле чата и ждёт: «Отправить» или «Пропустить и перейти дальше». Текст можно изменить здесь перед отправкой.':'Claude готовит черновики. Вы проверяете текст, при необходимости редактируете и нажимаете «Отправить».';
  $('#dialogs-monitor-note').textContent=test.enabled?'Один цикл проверяет один ответ поставщику. Следующий цикл запускается только вашей кнопкой.':!boundTabs()?'Сначала откройте хотя бы один чат площадки.':!enabled?'Подключите Claude в шаге 1. Пока доступно только чтение сообщений.':!approved?contextInstruction()+' Пока доступно только чтение сообщений.':folderDirty?'Сохраните модель в шаге 1.':edits.size?'Есть несохранённые черновики. Сохраните или удалите их перед включением автоматической отправки.':state.running&&folder.auto?'Мониторинг включён. Новые сообщения обрабатываются автоматически.':state.running?'Чтение работает. Нажмите «Начать мониторинг», чтобы возобновить подготовку ответов.':'Начните мониторинг для подготовки черновиков. Галочка автоматической отправки также запускает мониторинг.';
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
function renderReview(){
  const review=reviewState(),active=reviewActive(),editStale=!!reviewEdit&&(!active||reviewEdit.signature!==reviewSignature(review));
  $('#dialogs-review-panel').hidden=!active&&!reviewEdit;
  if(!active&&!reviewEdit)return;
  const key=active?review.key:reviewEdit.key,item=state.conversations?.[key],context=item?assessment(item):null;
  let request;try{if(active)request=draftRequest(state,key);}catch{}
  const requestStale=active&&(!request||['revision','fingerprint','productFingerprint','settingsFingerprint'].some(field=>request[field]!==review.request?.[field])),stale=editStale||requestStale;
  const text=reviewEdit?reviewEdit.text:review.text||'',busyReview=busy.has('#dialogs-review-send')||busy.has('#dialogs-review-skip');
  $('#dialogs-review-status').textContent=review.phase==='preparing'?'Ввожу ответ в чат':stale?'Контекст изменился':review.phase==='blocked'?'Нужна проверка':'Ожидает вашего решения';
  $('#dialogs-review-status').className='dialogs-status '+(review.phase==='blocked'||stale?'warn':'good');
  $('#dialogs-review-recipient').textContent=[PLATFORMS[item?.platform]||'',item?.title||key].filter(Boolean).join(' · ');
  $('#dialogs-review-product').textContent=context?.memoryName?'Товар: '+context.memoryName:'';
  $('#dialogs-review-time').textContent=review.at?'Подготовлен: '+date(review.at):'';
  if($('#dialogs-review-text').value!==text)$('#dialogs-review-text').value=text;
  $('#dialogs-review-text').disabled=!active||review.phase==='preparing'||busyReview;
  $('#dialogs-review-detail').textContent=[review.detail||'Ответ введён в поле чата. Дальнейшие действия ждут вашего решения.',context&&!context.allowed?context.detail:''].filter(Boolean).join(' ');
  $('#dialogs-review-conflict').hidden=!stale;
  $('#dialogs-review-conflict').textContent=requestStale?'Переписка или сведения о товаре изменились после подготовки ответа. Скопируйте нужные правки и пропустите этот вариант; для отправки нужен новый ответ.':editStale?'Подготовленный вариант изменился в другом окне. Ваши правки оставлены здесь для копирования. Загрузите текущий вариант перед отправкой.':'';
  $('#dialogs-review-reset').hidden=!editStale;$('#dialogs-review-reset').textContent=active?'Загрузить текущий вариант':'Закрыть прежний вариант';
  $('#dialogs-review-send').disabled=!active||review.phase!=='prepared'||stale||busyReview||testState().enabled||!state.running||!text.trim()||!context?.allowed||!hasReplyContext()||modeBusy||folderPausing;
  $('#dialogs-review-skip').disabled=!active||review.phase==='preparing'||editStale||busyReview||modeBusy;
  $('#dialogs-review-note').textContent=review.phase==='blocked'?'Если вы изменили текст прямо на площадке, расширение не сотрёт его автоматически. Проверьте причину выше; пропуск продолжится только после безопасной очистки собственного черновика.':!state.running?'Блок 2 на паузе. Продолжите его, чтобы отправить ответ, или пропустите текущий чат.':reviewEdit?'При отправке расширение заменит свой исходный черновик именно этим текстом, повторно проверит адресата и отправит ответ.':'Ответ уже введён в поле чата. «Отправить» одобряет этот текст. «Пропустить» очищает только собственный неизменённый черновик и переводит приложение дальше.';
}
function renderTestMode(){
  const test=testState(),active=test.enabled===true;
  $('#dialogs-test-panel').hidden=!active;
  if(!active)return;
  const labels={paused:'Готов к проверке',ready:state.settings?.scanRead?'Ищу чат для одного цикла':'Ищу сообщение для одного цикла',generating:'Claude готовит тестовый ответ',preparing:'Ввожу текст в чат без отправки',completed:workflowMode()?'Ответ введён — завершите тест или пропустите':'Цикл выполнен — сообщение не отправлено',blocked:'Тест приостановлен'};
  $('#dialogs-test-status').textContent=resumableTest()?'Текущий цикл на паузе':labels[test.phase]||'Тест приостановлен';
  let issue=!folderState.enabled?'Подключите Claude в шаге 1.':!hasReplyContext()?contextInstruction():!boundTabs()?'Откройте чаты площадок.':folderDirty?'Сохраните модель Claude.':edits.size?'Сохраните или удалите несохранённые черновики.':'';
  $('#dialogs-test-detail').textContent=[test.detail,issue,test.phase==='blocked'?(workflowMode()?'Устраните указанную причину, затем начните новый тестовый сеанс переключателем режима.':'Проверьте чат. Если тестовый текст мешает сбросу, удалите его вручную; затем выключите и снова включите тестовый режим для нового цикла.'):''].filter(Boolean).join(' ');
  $('#dialogs-test-next').textContent=resumableTest()?'Продолжить текущий цикл':test.phase==='completed'?(workflowMode()?'Завершить тест и перейти дальше':'Проверить следующий цикл'):test.phase==='paused'?'Проверить первый цикл':test.phase==='blocked'?'Проверка приостановлена':'Цикл выполняется…';
  $('#dialogs-test-skip').hidden=!workflowMode();
  $('#dialogs-test-skip').disabled=testPlatformSwitching||!['completed','blocked'].includes(test.phase)||!test.key||modeBusy||folderPausing||busy.has('#dialogs-test-skip');
  $('#dialogs-test-next').disabled=testPlatformSwitching||scanReadBusy||openingChats||!!issue||modeBusy||folderPausing||!resumableTest()&&!['paused','completed'].includes(test.phase)||busy.has('#dialogs-test-next');
  if(testPlatformSession!==test.sessionId){testPlatformSession=test.sessionId;testPlatformChoice=null;}
  const activePlatform=Object.hasOwn(PLATFORMS,test.platform)?test.platform:'all',selectedPlatform=testPlatformChoice??activePlatform,canSwitch=['paused','ready','completed'].includes(test.phase),platformBusy=testPlatformSwitching||busy.has('#dialogs-test-next')||busy.has('#dialogs-test-skip'),targetBound=selectedPlatform==='all'?boundTabs():Number.isInteger(state.bindings?.[selectedPlatform]?.tabId);
  $('#dialogs-test-platform').value=selectedPlatform;
  $('#dialogs-test-platform').disabled=platformBusy||!canSwitch||modeBusy||folderPausing;
  $('#dialogs-test-platform-start').disabled=platformBusy||!canSwitch||!targetBound||!!issue||modeBusy||folderPausing||openingChats||scanReadBusy;
  $('#dialogs-test-platform-start').textContent=testPlatformSwitching?'Переключаю площадку…':selectedPlatform==='all'?'Проверить все площадки':'Проверить '+PLATFORMS[selectedPlatform];
  $('#dialogs-test-platform-note').textContent=testPlatformSwitching?'Очищаю собственный тестовый черновик и переключаю площадку. Отправка выключена.':!targetBound?'Чат выбранной площадки ещё не открыт. Нажмите «Открыть чаты площадок» в шаге 3, затем запустите её тест.':!canSwitch?'Смена площадки доступна до подготовки ответа или после его завершения. При ошибке сначала проверьте черновик.':'Сейчас в тесте: '+(activePlatform==='all'?'все площадки':PLATFORMS[activePlatform])+'. '+(test.phase==='completed'?'Подготовленный цикл будет учтён только в тесте, собственный неизменённый черновик будет очищен. ':'')+'Другие чаты не будут отмечены обработанными. Выбор в списке применяется кнопкой.';
  $('#dialogs-test-result').hidden=!test.text;
  $('#dialogs-test-result-note').textContent=workflowMode()?(test.phase==='completed'?'Этот точный текст введён в поле чата без отправки. Завершите тест или пропустите чат. Перед переходом расширение очищает только свой неизменённый черновик.':'Подготовленный текст теста. Проверьте причину остановки и поле чата: ввод мог не завершиться. Отправка не выполнялась.'):test.phase==='completed'?'Текст введён в чат для проверки. Записи об отправке в истории переписки нет.':'Сохранённый текст теста. Проверьте поле чата перед продолжением; сообщение не отправлялось.';
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
  if(auditMode())return;
  if(folderPausePromise)await folderPausePromise;
  if(!folderState.enabled||!hasReplyContext())return;
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
const auditOriginalText=new Map(['#dialogs-page-eyebrow','#dialogs-page-title','#dialogs-page-subtitle','#dialogs-monitor-step','#dialogs-tabs-heading','#dialogs-monitor-explanation','#dialogs-footer'].map(id=>[id,$(id).textContent]));
function renderAuditShell(){
  const audit=auditMode();document.body.classList.toggle('wechat-audit',audit);
  for(const el of document.querySelectorAll('[data-dialog-reply-only]'))el.hidden=audit;
  $('#dialogs-audit').hidden=!audit;$('#dialogs-audit-results').hidden=!audit;
  $('#dialogs-sidebar-note').hidden=audit;
  const text={'#dialogs-page-eyebrow':'OPENLINKS · БЛОК 2','#dialogs-page-title':'Проверка WeChat в чатах','#dialogs-page-subtitle':'1688 → Alibaba → Made-in-China. Читаем чаты за последние сутки и сохраняем результат по каждому.','#dialogs-monitor-step':'ПЛОЩАДКИ','#dialogs-tabs-heading':'Чаты для проверки','#dialogs-monitor-explanation':'Расширение откроет центры сообщений в вашем аккаунте. При необходимости войдите на площадку. Проверка идёт строго по порядку: 1688, Alibaba, Made-in-China.','#dialogs-footer':'OpenLinks · Проверка WeChat и отчёт'};
  for(const [id,value] of auditOriginalText)$(id).textContent=audit?text[id]:value;
}
function render(){
  if(!state)return;resetAssessments();renderAuditShell();
  if(auditMode()){
    const phase=state.workflow?.audit?.phase||'idle';
    $('#dialogs-run-state').textContent={idle:'Не запущено',running:'Проверка WeChat',paused:'На паузе',blocked:'Проверка остановлена',completed:'Обход завершён'}[phase]||'Проверка WeChat';
    $('#dialogs-run-state').classList.toggle('running',!!state.running);
    renderBindings();renderEvents();auditUI.render();
    for(const id of busy)if($(id))$(id).disabled=true;
    return;
  }
  productUI?.render(state,{},productFingerprint);
  const bound=boundTabs();
  $('#dialogs-run-state').textContent=reviewActive()?'Ожидает вашего решения':testState().enabled?(testInProgress()?'Тест · один цикл':'Тест · ожидание'):state.running?(folderState.enabled&&folderState.auto?folderState.autoSend?'Автоматические ответы':'Черновики на проверку':'Только чтение'):'Мониторинг остановлен';
  $('#dialogs-run-state').classList.toggle('running',!!state.running);
  $('#dialogs-start').hidden=testState().enabled;
  $('#dialogs-scan').hidden=testState().enabled;
  $('#dialogs-start').disabled=scanReadBusy||openingChats||!bound||!!state.running&&(!folderState.enabled||!hasReplyContext()||folderState.auto)||folderPausing||modeBusy;
  $('#dialogs-start').textContent=workflowMode()?'Продолжить обход чатов':'Начать мониторинг';
  $('#dialogs-stop').textContent=workflowMode()?'Пауза блока 2':'Остановить мониторинг';
  $('#dialogs-stop').disabled=!state.running;
  $('#dialogs-scan').disabled=scanReadBusy||openingChats||!bound;
  if(state.running||!readUnreadDirty)$('#dialogs-read-unread').checked=state.readUnread!==false;
  $('#dialogs-read-unread').disabled=!!state.running;
  renderBindings();renderList();renderDetail();renderResults();renderSettings();renderEvents();renderFolder();renderReview();renderActivity();
  for(const id of busy)if($(id))$(id).disabled=true;
}

$('#dialogs-show-working-tab').addEventListener('change',async()=>{
  if(viewModeBusy)return;const enabled=$('#dialogs-show-working-tab').checked;viewModeBusy=true;viewModeRequested=enabled;renderActivity();
  try{await act('SETTINGS',{settings:{showWorkingTab:enabled}},enabled?'Рабочая вкладка будет выбираться при обходе чатов.':'Обход чатов продолжится в фоне.');}
  catch(error){feedback(error.message,true);}finally{viewModeBusy=false;viewModeRequested=null;renderActivity();}
});
action('#dialogs-activity-pause',()=>{reviewEpoch++;return act('STOP',{},'Блок 2 на паузе. Чаты, память товаров и ответы сохранены.');});
action('#dialogs-activity-resume',()=>{const button=$(testState().enabled?'#dialogs-test-next':'#dialogs-start');if(!button.disabled)button.click();});

// Starting monitoring enables Claude drafts when the saved context is ready.
action('#dialogs-open-chats',()=>openChats());
action('#dialogs-start',async()=>{
  if(auditMode()){await act('START',{},'Проверка WeChat продолжена.');return;}
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
action('#dialogs-stop',()=>{reviewEpoch++;return act('STOP',{},workflowMode()?'Блок 2 на паузе. Чаты, память товаров и ответы сохранены.':'Мониторинг остановлен.');});
action('#dialogs-scan',()=>act('SCAN',{},'Проверка чатов площадок завершена.'));
action('#dialogs-takeover',()=>{reviewEpoch++;const item=chosen();return act('CONTROL',{key:item.key,takeover:!item.takeover},item.takeover?'Подготовка ответов снова доступна.':'Разговор под вашим управлением. Ответы Claude приостановлены.');});
action('#dialogs-mute',()=>{reviewEpoch++;const item=chosen();return act('CONTROL',{key:item.key,paused:!item.paused},item.paused?'Пауза переписки снята.':'Переписка поставлена на паузу.');});
function reviewedDraft(item){
  if(!item)throw new Error('Выберите переписку.');
  const edit=edits.get(item.key),text=(edit?.text??item.draft?.text??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim();
  const current=draftRequest(state,item.key),request=edit?.request||current;
  if(!hasReplyContext()||request.settingsFingerprint!==current.settingsFingerprint||(request.purpose||'reply')!==(current.purpose||'reply')||edit&&(edit.productFingerprint!==current.productFingerprint||edit.revision!==item.revision||edit.fingerprint!==item.fingerprint))throw new Error('Переписка, настройки или товар изменились. Проверьте актуальный контекст и подготовьте новый ответ.');
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
    if(intent!==reviewEpoch||!sameTestIntent(modeIntent)||!hasReplyContext()||!state.running||!canDraft(state.conversations[item.key]))throw new Error('Отправка отменена после изменения режима или задания. Проверьте текст и нажмите «Отправить» снова.');
    await saveEditedDraft(item);
    if(intent!==reviewEpoch||!sameTestIntent(modeIntent)||!hasReplyContext()||!state.running||!canDraft(state.conversations[item.key]))throw new Error('Отправка отменена после изменения режима или задания. Проверьте текст и нажмите «Отправить» снова.');
    // Keep the exact reviewed text and context even if storage refreshes during saving.
    const {request,...payload}=reviewed;
    const result=await command('SEND_DRAFT',{...payload,...modeIntent});adopt(result);
    feedback(result.send?.detail||'Результат отправки записан в журнал.',!['attempted','previewed'].includes(result.send?.status));
  }finally{sending.delete(item.key);renderDetail();}
});
action('#dialogs-discard-draft',async()=>{reviewEpoch++;const item=chosen();await act('DISCARD_DRAFT',{key:item.key},'Черновик удалён.');edits.delete(item.key);});
action('#dialogs-folder-draft',async()=>{
  const item=chosen();if(!item||!hasReplyContext()||!canDraft(item)||!folderState.enabled)throw new Error('Согласуйте товар, подключите Claude и прочитайте актуальную переписку.');
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
  const result=await command('FOLDER_SETTINGS',{...settings,resume:true,enabled:true,auto:!!hasReplyContext()&&!!state.running,autoSend:!testState().enabled&&!!folderState.autoSend&&!!hasReplyContext()});
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
    if(enabled&&(!hasReplyContext()||!folderState.enabled||!boundTabs()||folderDirty||edits.size))throw new Error('Подключите Claude, согласуйте товар, откройте чаты и сохраните черновики.');
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
$('#dialogs-review-text').addEventListener('input',()=>{
  const review=reviewState();if(!reviewActive())return;
  reviewEdit={...(reviewEdit||{signature:reviewSignature(review),key:review.key}),text:$('#dialogs-review-text').value};renderReview();
});
action('#dialogs-review-reset',()=>{reviewEdit=null;renderReview();});
action('#dialogs-review-send',async()=>{
  const review=reviewState(),signature=reviewSignature(review),text=(reviewEdit?.text??review.text??'').trim();
  if(testState().enabled)throw new Error('Тестовый режим запрещает настоящую отправку.');
  if(!reviewActive()||review.phase!=='prepared'||!state.running||reviewEdit&&reviewEdit.signature!==signature)throw new Error('Подготовленный ответ изменился или находится на паузе. Проверьте актуальный вариант.');
  if(!text)throw new Error('Введите текст ответа.');
  const intent=reviewEpoch;
  if(folderPausePromise)await folderPausePromise;
  if(intent!==reviewEpoch||testState().enabled||signature!==reviewSignature(reviewState()))throw new Error('Режим или ответ изменились. Отправка отменена.');
  const result=await command('REVIEW_SEND',{operationId:review.operationId,context:review.context,text,request:review.request});
  if(result.folder?.review?.operationId!==review.operationId||result.folder?.review?.phase==='none')reviewEdit=null;
  adopt(result);feedback(result.send?.detail||result.send?.reason||reviewState().detail||'Результат записан в журнал.',result.send&& !['attempted','sent'].includes(result.send.status));
});
action('#dialogs-review-skip',async()=>{
  const review=reviewState();if(!reviewActive()||reviewEdit&&reviewEdit.signature!==reviewSignature(review))throw new Error('Состояние ответа изменилось. Загрузите текущий вариант.');
  const result=await command('REVIEW_SKIP',{operationId:review.operationId,context:review.context,request:review.request});
  if(result.folder?.review?.operationId!==review.operationId||result.folder?.review?.phase==='none')reviewEdit=null;
  adopt(result);feedback(reviewActive()?reviewState().detail:state.running?'Чат пропущен без отправки. Перехожу дальше.':'Чат пропущен без отправки. Блок 2 остаётся на паузе.',reviewActive()&&reviewState().phase==='blocked');
});
$('#dialogs-test-platform').addEventListener('change',()=>{testPlatformChoice=$('#dialogs-test-platform').value;renderTestMode();});
action('#dialogs-test-platform-start',async()=>{
  const test=testState(),platform=$('#dialogs-test-platform').value;
  if(!test.enabled||!['paused','ready','completed'].includes(test.phase)||!(platform==='all'||Object.hasOwn(PLATFORMS,platform)))throw new Error('Дождитесь завершения подготовки текущего ответа перед переключением площадки.');
  if(!folderState.enabled||!hasReplyContext()||folderDirty||settingsDirty||productUI?.isDirty()||edits.size)throw new Error('Сохраните контекст и изменения перед переключением площадки.');
  testPlatformSwitching=true;render();
  try{const result=await command('TEST_PLATFORM',{platform,sessionId:test.sessionId,cycleId:test.cycleId});testPlatformChoice=null;adopt(result);feedback(testState().detail||'Площадка для следующего тестового цикла выбрана. Отправка выключена.');}
  finally{testPlatformSwitching=false;render();}
});
action('#dialogs-test-skip',async()=>{
  const test=testState();if(!test.enabled||!test.key||!['completed','blocked'].includes(test.phase))throw new Error('Нет подготовленного тестового ответа для пропуска.');
  adopt(await command('TEST_SKIP',{sessionId:test.sessionId,cycleId:test.cycleId}));feedback(testState().detail||'Тестовый чат пропущен без отправки.');
});
action('#dialogs-test-next',async()=>{
  const test=testState(),request={sessionId:test.sessionId,cycleId:test.cycleId},intent=reviewEpoch;
  if(resumableTest()){if(folderDirty||settingsDirty||productUI?.isDirty()||edits.size)throw new Error('Сохраните изменения перед продолжением цикла.');await enableAutomaticDrafts();await act('START',{readUnread:true},'Продолжен текущий тестовый цикл. Отправка выключена.');return;}
  if(!test.enabled||!['paused','completed'].includes(test.phase))throw new Error('Тестовый цикл уже выполняется или требует проверки причины остановки.');
  if(!folderState.enabled||!hasReplyContext()||!boundTabs()||folderDirty||edits.size)throw new Error('Подключите Claude, согласуйте товар, откройте чаты и сохраните изменения.');
  if(folderPausePromise)await folderPausePromise;
  if(intent!==reviewEpoch||!testState().enabled||request.sessionId!==testState().sessionId||request.cycleId!==testState().cycleId||!hasReplyContext())throw new Error('Режим или задание изменились. Проверьте настройки перед запуском цикла.');
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
  edits.set(item.key,{text:$('#dialogs-draft-text').value,revision:previous?.revision??item.revision,fingerprint:previous?.fingerprint??item.fingerprint,productFingerprint:previous?.productFingerprint??request?.productFingerprint??productFingerprint,testSessionId:previous?.testSessionId||item.draft?.testSessionId||(testState().enabled?testState().sessionId:''),request});
  renderDetail();renderFolder();if(folderState.autoSend)pauseFolderOnEdit(true);
});
$('#dialogs-results-filter').addEventListener('change',()=>{resultsPage=0;renderResults();});
$('#dialogs-results-platform').addEventListener('change',()=>{resultsPage=0;renderResults();});
$('#dialogs-results-search').addEventListener('input',()=>{resultsPage=0;renderResults();});
$('#dialogs-results-prev').addEventListener('click',()=>{resultsPage=Math.max(0,resultsPage-1);renderResults();});
$('#dialogs-results-next').addEventListener('click',()=>{resultsPage++;renderResults();});
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
const auditUI=setupAuditUI({command,adopt,feedback,getState:()=>state,isOpening:()=>openingChats});
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
