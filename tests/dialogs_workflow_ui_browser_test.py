#!/usr/bin/env python3
"""Product-memory workflow UI, with an in-process Chrome API mock and no network."""
import functools
import http.server
import os
import pathlib
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[1]

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

HARNESS = r"""
(() => {
  const listeners=[];let state,core;
  let folder={enabled:true,auto:false,autoSend:false,model:'haiku',status:'ready',jobs:[],sendReceipts:[],test:{enabled:true,phase:'paused',sessionId:'test-1',cycleId:'cycle-1',completed:[],text:'',key:'',at:null}};
  window.calls=[];window.chatComposer='';window.actualSends=[];window.reviewChecks=0;window.deferPlatform=false;
  const result=()=>({ok:true,state:structuredClone(state),folder:structuredClone(folder),productFingerprint:core.productFingerprint(state),workflowActivity:state.workflow?.current,workflowActivityHistory:[...state.events].filter(e=>e.type.startsWith('workflow_')).reverse()});
  const announce=()=>listeners.forEach(fn=>fn({openlinksDialogs:{}},'local'));
  window.snapshot=()=>structuredClone({state,folder});
  window.chrome={storage:{onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{request:async()=>true},runtime:{sendMessage:async message=>{
    window.calls.push(structuredClone(message));core=await import('/extension/lib/dialogs.js');
    if(!state){state=core.initialDialogs();state.settings.workflow24h=true;state.settings.showWorkingTab=true;state.settings.scanRead=true;state.settings.wechat='wx_test_42';state.bindings.alibaba={tabId:22,status:'ready',url:'https://message.alibaba.com/',managed:{windowId:1,pending:false}};state.bindings['1688']={tabId:11,status:'ready',url:'https://air.1688.com/',managed:{windowId:1,pending:false}};state.bindings.mic={tabId:33,status:'ready',url:'https://webim.made-in-china.com/',managed:{windowId:1,pending:false}};}
    try {
      if(message.type==='DIALOGS_JOINT_GET')return {ok:true,joint:{enabled:false,phase:'test_paused',testMode:true,allowDialogs:true,detail:'Тест без отправки'}};
      if(message.type==='DIALOGS_GET')return result();
      if(message.type==='DIALOGS_SETTINGS')Object.assign(state.settings,message.settings);
      else if(message.type==='DIALOGS_MEMORY_SAVE')core.saveProductMemory(state,message);
      else if(message.type==='DIALOGS_MEMORY_LOAD')core.loadProductMemory(state,message.id);
      else if(message.type==='DIALOGS_MEMORY_DELETE')core.deleteProductMemory(state,message.id);
      else if(message.type==='DIALOGS_PRODUCT_SAVE')core.saveProduct(state,message.product);
      else if(message.type==='DIALOGS_PRODUCT_APPROVE')core.approveProduct(state,message.fingerprint);
      else if(message.type==='DIALOGS_START')state.running=true;
      else if(message.type==='DIALOGS_STOP'){state.running=false;folder.auto=false;folder.autoSend=false;state.workflow={current:{phase:'paused',detail:'Пауза сохраняет текущий цикл и подготовленные ответы.',at:Date.now()}};}
      else if(message.type==='DIALOGS_CONTEXT_EDITING'){state.running=false;folder.auto=false;folder.autoSend=false;}
      else if(message.type==='DIALOGS_DRAFT_EDITING'){}
      else if(message.type==='DIALOGS_SAVE_DRAFT'){
        const current=core.draftRequest(state,message.key);
        if(message.productFingerprint!==current.productFingerprint)throw new Error('Перепутан контекст товара');
        core.acceptDraft(state,current,{text:message.text,testSessionId:folder.test.enabled?folder.test.sessionId:''});
      }
      else if(message.type==='DIALOGS_REVIEW_SEND'||message.type==='DIALOGS_REVIEW_SKIP'){
        window.reviewChecks++;const review=folder.review;
        if(!review?.operationId||message.operationId!==review.operationId)throw new Error('Подготовленный ответ изменился');
        if(window.chatComposer!==review.text){review.phase='blocked';review.detail='Текст в поле изменён вручную. Собственный черновик не очищен; отправка не выполнялась.';return result();}
        window.chatComposer='';
        if(message.type==='DIALOGS_REVIEW_SEND'){if(folder.test.enabled)throw new Error('Тест запрещает отправку');window.chatComposer=message.text;window.actualSends.push(message.text);window.chatComposer='';}
        folder.review={phase:'none',operationId:'',key:'',text:''};return {...result(),send:{status:message.type==='DIALOGS_REVIEW_SEND'?'attempted':'skipped'}};
      }
      else if(message.type==='DIALOGS_TEST_PLATFORM'){
        if(!folder.test.enabled||message.sessionId!==folder.test.sessionId||message.cycleId!==folder.test.cycleId||!['paused','ready','completed'].includes(folder.test.phase))throw new Error('Тестовый цикл занят или изменился');
        if(window.deferPlatform)await new Promise(resolve=>window.resolvePlatform=resolve);
        if(folder.test.phase==='completed'){
          if(window.chatComposer!==folder.test.text)throw new Error('Текст в поле изменён вручную. Площадка не переключена.');
          window.chatComposer='';folder.test.completed.push({key:folder.test.key,at:Date.now()});
        }
        Object.assign(folder.test,{platform:message.platform,phase:'ready',cycleId:'platform-'+Date.now(),text:'',key:'',at:null,detail:'Проверяю выбранную площадку. Отправка выключена.'});state.running=true;
      }
      else if(message.type==='DIALOGS_TEST_SKIP'){
        if(!folder.test.enabled||message.sessionId!==folder.test.sessionId||message.cycleId!==folder.test.cycleId)throw new Error('Тестовый цикл изменился');
        if(window.chatComposer!==folder.test.text){folder.test.phase='blocked';folder.test.detail='Текст в поле изменён вручную. Проверьте черновик.';return result();}
        window.chatComposer='';Object.assign(folder.test,{phase:'ready',cycleId:'skip-'+Date.now(),text:'',key:'',at:null,detail:'Тестовый чат пропущен без отправки.'});state.running=true;
      }
      else if(message.type==='DIALOGS_TEST_NEXT'){
        if(!folder.test.enabled||!['paused','completed'].includes(folder.test.phase))throw new Error('Неверный тестовый цикл');
        if(folder.test.phase==='completed'){if(window.chatComposer!==folder.test.text)throw new Error('Текст чата изменён');window.chatComposer='';folder.test.completed.push({key:folder.test.key,at:Date.now()});}
        Object.assign(folder.test,{phase:'ready',cycleId:'cycle-'+Date.now(),text:'',key:'',at:null});state.running=true;folder.auto=true;folder.autoSend=false;
      }
      else if(message.type==='DIALOGS_FOLDER_SETTINGS'){
        for(const key of ['enabled','auto','autoSend'])if(Object.hasOwn(message,key))folder[key]=message[key];
        if(folder.test.enabled)folder.autoSend=false;
      }
      else if(message.type==='DIALOGS_DISCARD_DRAFT')state.conversations[message.key].draft=null;
      else throw new Error('Unexpected command '+message.type);
      return result();
    }catch(error){return {ok:false,error:error.message};}
  }}};
  window.seedProduct=(points='Hydraulic splitter, 20 ton.')=>{core.saveProduct(state,{cardText:'Log splitter model A',keyPoints:points,questions:'Confirm motor voltage.',rules:'Use supplier language.'});core.approveProduct(state,core.productFingerprint(state));announce();};
  const thread=(id,text,extra={})=>{const at=Date.now()-60000,first={key:'first-'+id,id:'first-'+id,direction:'outbound',text:'Hello, I need a log splitter.',at:at-60000};return {key:'alibaba:'+id,id,platform:'alibaba',title:'Supplier '+id,identityReliable:true,orderReliable:true,tailKnown:true,contentReady:true,needsRead:false,unread:false,paused:false,takeover:false,url:'https://message.alibaba.com/',messages:[first,{key:'last-'+id,id:'last-'+id,direction:'inbound',text,at}],revision:1,fingerprint:'fingerprint-'+id,firstBuyerMessage:first,firstBuyerMessageReliable:true,historyStartKnown:true,historyComplete:true,latestMessageAt:at,latestMessageAtReliable:true,updatedAt:at,lastObservedAt:at,draft:null,...extra};};
  window.seedChats=()=>{state.conversations={
    'alibaba:ready':thread('ready','How many units?'),
    'alibaba:done':thread('done','I found your WeChat: wx_test_42'),
    'alibaba:waiting':thread('waiting','Waiting',{messages:[{key:'initial',direction:'outbound',text:'Hello, I need a log splitter.',at:Date.now()-60000}]}),
    'alibaba:unknown':thread('unknown','Which product?',{firstBuyerMessage:null,firstBuyerMessageReliable:false,historyStartKnown:false,historyComplete:false}),
    'alibaba:undated':thread('undated','Which quantity?',{latestMessageAt:null,latestMessageAtReliable:false,messages:[{key:'first',direction:'outbound',text:'Hello, I need a log splitter.',at:null},{key:'last',direction:'inbound',text:'Which quantity?',at:null}]})
  };announce();};
  window.activity=()=>{state.running=true;const at=Date.now();state.workflow={current:{phase:'reading',platform:'alibaba',conversationKey:'alibaba:ready',detail:'Читаю первое ваше сообщение и проверяю название товара.',at}};state.events.push({type:'workflow_reading',platform:'alibaba',detail:'Открыта переписка для чтения.',at});announce();};
  window.seedResults=()=>{
    const now=Date.now(),ready=state.conversations['alibaba:ready'];
    state.workflow ||= {};state.workflow.visits={
      'alibaba:ready':{platform:'alibaba',title:ready.title,at:now,status:'expired',detail:'Последняя проверка: дата устарела.',fingerprint:ready.fingerprint,lastResult:{status:'send_unknown',detail:'Связь потеряна после попытки отправки; проверьте чат.',at:now-10000,fingerprint:ready.fingerprint}},
      'alibaba:done':{platform:'alibaba',title:'Supplier done',at:now-20000,status:'completed',detail:'Ваш WeChat найден в сообщении поставщика.'},
      'alibaba:waiting':{platform:'alibaba',title:'Supplier waiting',at:now-30000,status:'waiting_supplier',detail:'Первичное обращение осталось без ответа.'},
      'alibaba:archived':{platform:'alibaba',title:'Archived Supplier <img src=x onerror=alert(1)>',at:Date.UTC(2026,9,19,1,2,3),status:'test_completed',detail:'Пробный цикл завершён. Поставщику ничего не отправлено.'},
      'mic:skipped':{platform:'mic',title:'Skipped Supplier',at:now-40000,status:'skipped',detail:'Пропущено пользователем, черновик очищен.'},
      '1688:failed':{platform:'1688',title:'Failed Supplier',at:now-50000,status:'failed',detail:'Кнопка отправки недоступна; отправка не выполнялась.'},
      'mic:opaque-key-do-not-show':{platform:'mic',at:now-60000,status:'date_unknown',detail:'Дата последнего сообщения не распознана.'}
    };
    for(let index=0;index<130;index++)state.workflow.visits['1688:old-'+index]={platform:'1688',title:'Earlier Supplier '+index,at:now-100000-index,status:'ready',detail:'Товар определён. Ожидает обработки.'};
    announce();
  };
  window.testPhase=phase=>{folder.test.phase=phase;announce();};
  window.announceState=announce;
  window.finishPreview=text=>{window.chatComposer=text;Object.assign(folder.test,{phase:'completed',text,key:'alibaba:ready',at:Date.now()});state.running=false;state.workflow={current:{phase:'completed',detail:'Точный ответ введён в поле чата. Отправка не выполнялась.',at:Date.now()}};announce();};
  window.editorUnapproved=()=>{core.saveProduct(state,{keyPoints:'Editor changed, not approved.'});announce();};
  window.deliverDraft=()=>{const request=core.draftRequest(state,'alibaba:ready');core.acceptDraft(state,request,{text:'Please confirm 220 V.',testSessionId:folder.test.sessionId});announce();};
  window.prepareReview=(text='Please confirm 220 V and delivery date.')=>{folder.test.enabled=false;folder.test.phase='off';folder.autoSend=false;state.running=true;const request=core.draftRequest(state,'alibaba:ready');folder.review={phase:'prepared',operationId:crypto.randomUUID(),key:'alibaba:ready',text,request,context:'c'.repeat(64),at:Date.now(),detail:'Ответ введён в поле чата. Ожидаю решения.'};window.chatComposer=text;announce();};
  window.archivedDraft=()=>{state.conversations['alibaba:ready'].previousDraft={text:'Previous unsent proposal: 220 V and 50 Hz.',status:'stale',createdAt:Date.now()-60000,detail:'Прежний черновик сохранён для просмотра.'};announce();};
  window.replaceMemory=()=>{const id=state.productMemories.entries[0].id;core.saveProduct(state,{keyPoints:'Updated memory facts.'});core.approveProduct(state,core.productFingerprint(state));core.saveProductMemory(state,{id,name:'Дровоколы',aliases:['log splitter']});announce();};
})();
"""

checks = 0
def passed(name):
    global checks
    checks += 1
    print('PASS ' + name, flush=True)

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True)
        context = browser.new_context(viewport={'width': 1450, 'height': 1000}, timezone_id='Asia/Irkutsk')
        context.set_default_timeout(8000)
        context.add_init_script(HARNESS)
        external=[]
        def local_only(route):
            if route.request.url.startswith('http://127.0.0.1:'):
                route.continue_()
            else:
                external.append(route.request.url)
                route.abort()
        context.route('**/*',local_only)
        ui=context.new_page();errors=[]
        ui.on('pageerror',lambda error:errors.append(str(error)))
        ui.goto(f'http://127.0.0.1:{server.server_port}/extension/dialogs.html')
        expect(ui.locator('#dialogs-memory-empty')).to_be_visible()
        expect(ui.locator('#dialogs-test-next')).to_be_disabled()
        assert ui.locator('#dialogs-test-platform option').evaluate_all('(options)=>options.map(option=>option.value)') == ['all','1688','alibaba','mic']
        expect(ui.locator('#dialogs-scan-read-control')).to_be_hidden()
        expect(ui.locator('#dialogs-test-detail')).to_contain_text('в память')
        passed('workflow requires named saved memory and always includes read chats')

        ui.evaluate('seedProduct()')
        ui.locator('#dialogs-memory-name').fill('Дровоколы')
        ui.locator('#dialogs-memory-aliases').fill('log splitter\n劈木机')
        ui.locator('#dialogs-memory-save').click()
        expect(ui.locator('.dialogs-memory')).to_have_count(1)
        expect(ui.locator('#dialogs-memory-count')).to_have_text('1 / 20')
        expect(ui.locator('#dialogs-test-next')).to_be_enabled()
        assert ui.evaluate("snapshot().state.productMemories.entries[0].aliases.includes('劈木机')")
        passed('approved product is saved as named multilingual memory without starting work')

        ui.locator('.dialogs-memory button').filter(has_text='Открыть').click()
        expect(ui.locator('#dialogs-memory-name')).to_have_value('Дровоколы')
        expect(ui.locator('#dialogs-memory-save')).to_have_text('Обновить выбранный товар в памяти')
        ui.locator('#dialogs-memory-aliases').fill('log splitter\nwood splitter\n劈木机')
        ui.locator('#dialogs-memory-save').click()
        expect(ui.locator('.dialogs-memory')).to_have_count(1)
        ui.wait_for_function('snapshot().state.productMemories.entries[0].revision === 2')
        passed('load and update replace only the selected memory')

        ui.evaluate('seedChats()')
        expect(ui.locator('#dialogs-list .dialogs-thread')).to_have_count(5)
        ui.locator('[data-key="alibaba:ready"]').click()
        expect(ui.locator('#dialogs-workflow-assessment')).to_contain_text('Товар: Дровоколы')
        expect(ui.locator('#dialogs-workflow-assessment')).not_to_contain_text('Дата последнего сообщения не подтверждена')
        ui.locator('#dialogs-filter').select_option('completed')
        expect(ui.locator('#dialogs-list .dialogs-thread')).to_have_count(1)
        expect(ui.locator('#dialogs-list')).to_contain_text('Supplier done')
        passed('matched context and completion from supplier WeChat mention are visible')

        ui.locator('#dialogs-filter').select_option('waiting')
        expect(ui.locator('#dialogs-list .dialogs-thread')).to_have_count(1)
        expect(ui.locator('#dialogs-list')).to_contain_text('Supplier waiting')
        ui.locator('#dialogs-filter').select_option('blocked')
        expect(ui.locator('#dialogs-list .dialogs-thread')).to_have_count(2)
        expect(ui.locator('#dialogs-list')).to_contain_text('Дата последнего сообщения не прочитана')
        expect(ui.locator('#dialogs-list')).to_contain_text('Начало переписки не подтверждено')
        passed('waiting, missing dates and missing true first message have separate explanations')

        ui.evaluate('editorUnapproved()')
        expect(ui.locator('#dialogs-product-status')).to_contain_text('Нужно согласование')
        expect(ui.locator('#dialogs-test-next')).to_be_enabled()
        passed('saved memory readiness is independent of the currently unapproved editor')

        ui.locator('#dialogs-activity-resume').click()
        expect(ui.locator('#dialogs-test-next')).to_be_disabled()
        expect(ui.locator('#dialogs-activity-pause')).to_be_enabled()
        ui.evaluate('activity()')
        expect(ui.locator('#dialogs-activity-action')).to_have_text('Читаю сообщения')
        expect(ui.locator('#dialogs-activity-target')).to_contain_text('Supplier ready')
        expect(ui.locator('#dialogs-activity-events')).to_contain_text('Открыта переписка')
        assert ui.evaluate('snapshot().folder.autoSend') is False
        passed('top control starts a single no-send cycle and shows current action and recipient')

        expect(ui.locator('#dialogs-show-working-tab')).to_be_checked()
        cycle_before_view=ui.evaluate('snapshot().folder.test.cycleId')
        ui.locator('#dialogs-show-working-tab').uncheck()
        ui.wait_for_function('snapshot().state.settings.showWorkingTab === false')
        ui.locator('#dialogs-show-working-tab').check()
        ui.wait_for_function('snapshot().state.settings.showWorkingTab === true')
        assert ui.evaluate('snapshot().folder.test.cycleId') == cycle_before_view
        assert ui.evaluate('snapshot().state.running') is True
        assert ui.evaluate('snapshot().folder.autoSend') is False
        passed('visible working-tab option saves independently without changing the running test or sending')

        exact='Hello! Confirm 220 V & 50 Hz.\n型号 A <draft>\nPlease add WeChat: wx_test_42.'
        ui.evaluate('(text)=>finishPreview(text)',exact)
        expect(ui.locator('#dialogs-test-result')).to_be_visible()
        assert ui.locator('#dialogs-test-text').text_content() == exact
        expect(ui.locator('#dialogs-test-result-note')).to_contain_text('введён в поле чата без отправки')
        expect(ui.locator('#dialogs-activity-resume')).to_have_text('Завершить тест и перейти дальше')
        assert not ui.evaluate("calls.some(call=>call.type==='DIALOGS_SEND_DRAFT')")
        assert ui.evaluate("snapshot().state.conversations['alibaba:ready'].messages.length") == 2
        assert ui.evaluate('chatComposer') == exact
        assert ui.evaluate('actualSends.length') == 0
        passed('exact multiline reply is shown as escaped text and composer preview is labelled unsent')

        ui.locator('#dialogs-activity-resume').click()
        expect(ui.locator('#dialogs-test-count')).to_have_text('Учтено только в тесте: 1')
        ui.locator('#dialogs-activity-pause').click()
        expect(ui.locator('#dialogs-activity-status')).to_have_text('На паузе')
        assert ui.evaluate('snapshot().state.productMemories.entries.length') == 1
        assert ui.evaluate('snapshot().folder.test.completed.length') == 1
        assert ui.evaluate('snapshot().folder.autoSend') is False
        paused_cycle=ui.evaluate('snapshot().folder.test.cycleId')
        expect(ui.locator('#dialogs-activity-resume')).to_have_text('Продолжить текущий цикл')
        passed('pause preserves product memory and simulated completion and never enables sending')

        ui.locator('#dialogs-activity-resume').click()
        ui.wait_for_function('snapshot().state.running === true')
        assert ui.evaluate('snapshot().folder.test.cycleId') == paused_cycle
        assert ui.evaluate("calls.some(call=>call.type==='DIALOGS_START')")
        passed('resume uses START to continue the same paused cycle without consuming another cycle')
        ui.evaluate('(text)=>finishPreview(text)','Skip this synthetic preview.')
        ui.locator('#dialogs-test-skip').click()
        ui.wait_for_function("snapshot().folder.test.phase === 'ready'")
        assert ui.evaluate('snapshot().folder.test.completed.length') == 1
        assert ui.evaluate('chatComposer') == ''
        assert ui.evaluate('actualSends.length') == 0
        passed('test Skip clears the owned preview and advances without simulated send completion')
        platform_calls=ui.evaluate("calls.filter(call=>call.type==='DIALOGS_TEST_PLATFORM').length")
        ui.locator('#dialogs-test-platform').select_option('alibaba')
        assert ui.evaluate("calls.filter(call=>call.type==='DIALOGS_TEST_PLATFORM').length") == platform_calls
        ui.evaluate('deferPlatform=true')
        ui.locator('#dialogs-test-platform-start').click()
        ui.wait_for_function('typeof resolvePlatform === "function"')
        expect(ui.locator('#dialogs-test-platform-start')).to_be_disabled()
        expect(ui.locator('#dialogs-test-platform')).to_be_disabled()
        expect(ui.locator('#dialogs-test-next')).to_be_disabled()
        expect(ui.locator('#dialogs-test-skip')).to_be_disabled()
        request=ui.evaluate("calls.findLast(call=>call.type==='DIALOGS_TEST_PLATFORM')")
        assert request['platform'] == 'alibaba' and request['sessionId'] == 'test-1'
        assert request['cycleId'] == ui.evaluate('snapshot().folder.test.cycleId')
        ui.evaluate('deferPlatform=false;resolvePlatform()')
        ui.wait_for_function("snapshot().folder.test.platform === 'alibaba'")
        expect(ui.locator('#dialogs-test-platform')).to_have_value('alibaba')
        expect(ui.locator('#dialogs-test-platform-note')).to_contain_text('Сейчас в тесте: Alibaba')
        assert ui.evaluate('snapshot().folder.test.completed.length') == 1
        passed('explicit target button sends platform and cycle identity once; all cycle controls wait for acknowledgment')

        ui.evaluate("testPhase('generating')")
        expect(ui.locator('#dialogs-test-platform')).to_be_disabled()
        expect(ui.locator('#dialogs-test-platform-start')).to_be_disabled()
        pending_calls=ui.evaluate("calls.filter(call=>call.type==='DIALOGS_TEST_PLATFORM').length")
        ui.locator('#dialogs-test-platform-start').dispatch_event('click')
        expect(ui.locator('#dialogs-feedback')).to_contain_text('Дождитесь завершения подготовки')
        assert ui.evaluate("calls.filter(call=>call.type==='DIALOGS_TEST_PLATFORM').length") == pending_calls
        ui.evaluate("testPhase('ready')")
        passed('generating cycle cannot switch platforms even through a synthetic click')

        untouched=ui.evaluate('JSON.stringify(snapshot().state.conversations)')
        ui.evaluate("finishPreview('Owned platform-switch preview.')")
        ui.locator('#dialogs-test-platform').select_option('mic')
        ui.evaluate("chatComposer='Manually changed preview'")
        ui.locator('#dialogs-test-platform-start').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('изменён вручную')
        expect(ui.locator('#dialogs-test-text')).to_have_text('Owned platform-switch preview.')
        assert ui.evaluate('snapshot().folder.test.platform') == 'alibaba'
        assert ui.evaluate('chatComposer') == 'Manually changed preview'
        assert ui.evaluate('snapshot().folder.test.completed.length') == 1
        ui.evaluate("chatComposer='Owned platform-switch preview.'")
        ui.locator('#dialogs-test-platform-start').click()
        ui.wait_for_function("snapshot().folder.test.platform === 'mic'")
        expect(ui.locator('#dialogs-test-platform')).to_have_value('mic')
        assert ui.evaluate('snapshot().folder.test.completed.length') == 2
        assert ui.evaluate('chatComposer') == ''
        assert ui.evaluate('JSON.stringify(snapshot().state.conversations)') == untouched
        assert ui.evaluate('actualSends.length') == 0
        passed('manual composer edit blocks target switch; successful retry clears only owned preview and leaves other chats untouched')

        ui.locator('#dialogs-test-platform').select_option('all')
        ui.locator('#dialogs-test-platform-start').click()
        ui.wait_for_function("snapshot().folder.test.platform === 'all'")
        ui.evaluate('announceState()')
        expect(ui.locator('#dialogs-test-platform')).to_have_value('all')
        assert ui.evaluate('snapshot().folder.test.completed.length') == 2
        assert ui.evaluate('actualSends.length') == 0
        passed('all-platform mode restores explicitly and survives a state refresh without marking extra chats complete')

        ui.locator('#dialogs-filter').select_option('all')
        ui.locator('[data-key="alibaba:ready"]').click()
        ui.evaluate('deliverDraft()')
        ui.locator('#dialogs-draft-text').fill('Please confirm 220 V and 50 Hz.')
        expect(ui.locator('#dialogs-save-draft')).to_be_enabled()
        ui.locator('#dialogs-save-draft').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('Черновик сохранён')
        assert ui.evaluate("calls.findLast(call=>call.type==='DIALOGS_SAVE_DRAFT').productFingerprint !== snapshot().state.product.fingerprint")
        passed('editing and saving use the matched memory fingerprint rather than unrelated editor')

        ui.locator('#dialogs-draft-text').fill('Unsaved old-memory text')
        ui.evaluate('replaceMemory()')
        expect(ui.locator('#dialogs-save-draft')).to_be_disabled()
        expect(ui.locator('#dialogs-draft-status')).to_contain_text('товар изменились')
        ui.evaluate('archivedDraft()')
        expect(ui.locator('#dialogs-previous-draft')).to_be_visible()
        ui.locator('#dialogs-previous-draft summary').click()
        expect(ui.locator('#dialogs-previous-draft-text')).to_contain_text('220 V and 50 Hz')
        passed('memory replacement invalidates edits and retains the old draft as read-only evidence')

        ui.locator('#dialogs-discard-draft').click()
        ui.evaluate('prepareReview()')
        expect(ui.locator('#dialogs-review-panel')).to_be_visible()
        expect(ui.locator('#dialogs-review-product')).to_contain_text('Дровоколы')
        expect(ui.locator('#dialogs-review-recipient')).to_contain_text('Supplier ready')
        expect(ui.locator('#dialogs-review-send')).to_be_enabled()
        expect(ui.locator('#dialogs-send-draft')).to_be_disabled()
        assert ui.evaluate('actualSends.length') == 0
        passed('manual review shows filled-chat recipient, product and explicit Send/Skip before any send')

        ui.locator('#dialogs-review-text').fill('Edited approval: please confirm 230 V.')
        ui.locator('#dialogs-review-send').click()
        expect(ui.locator('#dialogs-review-panel')).to_be_hidden()
        assert ui.evaluate('actualSends') == ['Edited approval: please confirm 230 V.']
        assert ui.evaluate("calls.findLast(call=>call.type==='DIALOGS_REVIEW_SEND').text") == 'Edited approval: please confirm 230 V.'
        passed('only explicit manual Send approves the exact edited text and current preview operation')

        ui.evaluate("prepareReview('Do not send this preview.')")
        ui.locator('#dialogs-review-text').fill('Unsaved alternative')
        ui.locator('#dialogs-review-skip').click()
        expect(ui.locator('#dialogs-review-panel')).to_be_hidden()
        assert ui.evaluate('chatComposer') == ''
        assert len(ui.evaluate('actualSends')) == 1
        passed('manual Skip clears only the original owned preview and does not send UI edits')

        ui.evaluate("prepareReview('Owned original preview.')")
        ui.evaluate("chatComposer='User edited the marketplace composer' ")
        ui.locator('#dialogs-review-send').click()
        expect(ui.locator('#dialogs-review-status')).to_have_text('Нужна проверка')
        expect(ui.locator('#dialogs-review-send')).to_be_disabled()
        expect(ui.locator('#dialogs-review-detail')).to_contain_text('изменён вручную')
        assert ui.evaluate('chatComposer') == 'User edited the marketplace composer'
        assert len(ui.evaluate('actualSends')) == 1
        checks_before=ui.evaluate('reviewChecks')
        ui.locator('#dialogs-review-skip').click()
        ui.wait_for_function('(before)=>reviewChecks > before',arg=checks_before)
        expect(ui.locator('#dialogs-review-panel')).to_be_visible()
        expect(ui.locator('#dialogs-review-skip')).to_be_enabled()
        assert ui.evaluate('chatComposer') == 'User edited the marketplace composer'
        ui.evaluate("chatComposer='Owned original preview.'")
        ui.locator('#dialogs-review-skip').click()
        expect(ui.locator('#dialogs-review-panel')).to_be_hidden()
        passed('changed marketplace draft blocks Send and Skip until owned preview can be safely cleared')

        ui.evaluate("prepareReview('First review version')")
        ui.locator('#dialogs-review-text').fill('Local edit for old operation')
        ui.evaluate("prepareReview('New operation from another window')")
        expect(ui.locator('#dialogs-review-conflict')).to_be_visible()
        expect(ui.locator('#dialogs-review-text')).to_have_value('Local edit for old operation')
        expect(ui.locator('#dialogs-review-send')).to_be_disabled()
        ui.locator('#dialogs-review-reset').click()
        expect(ui.locator('#dialogs-review-text')).to_have_value('New operation from another window')
        ui.locator('#dialogs-review-skip').click()
        passed('external review replacement retains local edits and requires loading current operation')

        ui.locator('.dialogs-memory button').filter(has_text='Удалить').click()
        expect(ui.locator('.dialogs-memory')).to_have_count(0)
        expect(ui.locator('#dialogs-test-next')).to_be_disabled()
        expect(ui.locator('#dialogs-workflow-assessment')).to_contain_text('Сохраните утверждённый товар')
        ui.evaluate('seedResults()')
        expect(ui.locator('#dialogs-results-count')).to_contain_text('137 результатов')
        expect(ui.locator('#dialogs-results-body tr')).to_have_count(50)
        expect(ui.locator('#dialogs-results-page')).to_contain_text('1–50')
        ui.locator('#dialogs-results-next').click()
        expect(ui.locator('#dialogs-results-page')).to_contain_text('51–100')
        expect(ui.locator('#dialogs-results-body tr')).to_have_count(50)
        passed('per-chat history lists persisted results beyond live conversation cache with pagination')

        ui.locator('#dialogs-results-search').fill('Supplier ready')
        expect(ui.locator('#dialogs-results-body tr')).to_have_count(1)
        expect(ui.locator('#dialogs-results-body')).to_contain_text('Исход отправки неизвестен')
        expect(ui.locator('#dialogs-results-body')).not_to_contain_text('Пропущен: сообщение старше суток')
        ui.locator('#dialogs-results-body button').click()
        expect(ui.locator('#dialogs-outcome-status')).to_have_text('Исход отправки неизвестен')
        expect(ui.locator('#dialogs-outcome-detail')).to_contain_text('Связь потеряна')
        expect(ui.locator('[data-key="alibaba:ready"]')).not_to_contain_text('Требует ответа')
        passed('factual unknown-send outcome remains separate from later eligibility and opens cached chat history')

        ui.locator('#dialogs-results-search').fill('Archived Supplier')
        expect(ui.locator('#dialogs-results-body tr')).to_have_count(1)
        expect(ui.locator('#dialogs-results-body')).to_contain_text('Тест завершён — не отправлено')
        expect(ui.locator('#dialogs-results-body')).to_contain_text('09:02:03')
        expect(ui.locator('#dialogs-results-body')).to_contain_text('<img src=x onerror=alert(1)>')
        expect(ui.locator('#dialogs-results-body img')).to_have_count(0)
        expect(ui.locator('#dialogs-results-body button,#dialogs-results-body a')).to_have_count(0)
        expect(ui.locator('#dialogs-results-body')).to_contain_text('История не загружена')
        passed('evicted chat retains named no-send test result and local time, escapes markup and offers no false history link')

        ui.locator('#dialogs-results-search').fill('')
        ui.locator('#dialogs-results-filter').select_option('completed')
        expect(ui.locator('#dialogs-results-body tr')).to_have_count(1)
        expect(ui.locator('#dialogs-results-body')).to_contain_text('WeChat найден — диалог завершён')
        expect(ui.locator('#dialogs-results-body')).not_to_contain_text('доставлено')
        ui.locator('#dialogs-results-filter').select_option('skipped')
        expect(ui.locator('#dialogs-results-body')).to_contain_text('Skipped Supplier')
        ui.locator('#dialogs-results-platform').select_option('1688')
        expect(ui.locator('#dialogs-results-body tr')).to_have_count(0)
        ui.locator('#dialogs-results-filter').select_option('issue')
        expect(ui.locator('#dialogs-results-body')).to_contain_text('Failed Supplier')
        expect(ui.locator('#dialogs-results-body')).to_contain_text('отправка не выполнялась')
        passed('result and platform filters distinguish WeChat completion, skip and failed processing')

        ui.locator('#dialogs-results-platform').select_option('mic')
        expect(ui.locator('#dialogs-results-body')).to_contain_text('Имя поставщика не прочитано')
        expect(ui.locator('#dialogs-results-body')).not_to_contain_text('opaque-key-do-not-show')
        ui.locator('#dialogs-results-platform').select_option('all')
        ui.locator('#dialogs-results-filter').select_option('pending')
        ui.locator('#dialogs-results-search').fill('Supplier undated')
        expect(ui.locator('#dialogs-results-body')).to_contain_text('Ещё не проверен')
        ui.set_viewport_size({'width':600,'height':850})
        assert ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        passed('unvisited chats are explicit and unavailable names never expose technical conversation identifiers')
        assert external == []
        assert errors == [], errors
        passed('deleting memory blocks context-dependent actions; no external network or browser errors')
        browser.close()
finally:
    server.shutdown()
print(f'{checks} product-memory workflow UI checks passed.')
