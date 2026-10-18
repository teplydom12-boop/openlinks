"""Exercise the production dialogs UI with synthetic conversations and Chrome transport.

No accounts, external requests, marketplace interaction or real API calls are used.
"""
import functools
import base64
import http.server
import os
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
checks = 0


def passed(name):
    global checks
    checks += 1
    print('PASS ' + name, flush=True)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


HARNESS = r"""
(() => {
  const now=Date.UTC(2026,9,18,1,10),listeners=[];
  let state=null,core=null;
  const ai={provider:'openai',keyStored:false,model:'',providers:{openai:{keyStored:false,model:''},anthropic:{keyStored:false,model:''}}};
  let folder={enabled:false,auto:false,autoSend:false,model:'haiku',status:'disabled',detail:'',folder:'',worker:{running:false},claude:{available:true},jobs:[],sendReceipts:[]};
  const coreModule=()=>import('/extension/lib/dialogs.js');
  window.calls=[];window.permissionCalls=[];window.allowPermission=true;window.failGet=false;window.failFolder=false;
  window.deferSend=false;window.deferDraftEditing=false;window.sendOutcome='attempted';window.sentTexts=[];
  const tabs=[{id:11,platform:'1688',title:'1688 chat',url:'https://air.1688.com/chat/'},{id:22,platform:'alibaba',title:'Alibaba messages',url:'https://message.alibaba.com/'},{id:33,platform:'mic',title:'Made-in-China messages',url:'https://webim.made-in-china.com/'}];
  const publicState=()=>({ok:true,state:structuredClone(state),ai:structuredClone(ai),folder:structuredClone(folder),productFingerprint:core.productFingerprint(state)});
  function announce(){for(const listener of listeners)listener({openlinksDialogs:{newValue:structuredClone(state)},openlinksClaudeFolder:{newValue:structuredClone(folder)}},'local');}
  window.chrome={storage:{onChanged:{addListener:f=>listeners.push(f)}},permissions:{request:async data=>{permissionCalls.push(structuredClone(data));return allowPermission;}},runtime:{sendMessage:async message=>{
    calls.push(structuredClone(message));const t=message.type;core=await coreModule();state??=core.initialDialogs();
    try {
      if(t==='DIALOGS_GET')return failGet?{ok:false,error:'Временная ошибка чтения'}:publicState();
      if(t==='DIALOGS_LIST_TABS')return {ok:true,tabs};
      if(t==='DIALOGS_BIND_TAB'){const tab=tabs.find(tab=>tab.id===message.tabId);state.bindings[message.platform]={tabId:tab.id,url:tab.url,status:'loading',checkedAt:null,detail:'Ожидает проверки'};}
      else if(t==='DIALOGS_UNBIND_TAB')state.bindings[message.platform]={tabId:null,url:'',status:'unbound',checkedAt:null,detail:''};
      else if(t==='DIALOGS_START'){state.running=true;state.readUnread=message.readUnread===true;}
      else if(t==='DIALOGS_STOP')state.running=false;
      else if(t==='DIALOGS_SCAN'){for(const [platform,binding] of Object.entries(state.bindings))if(binding.tabId!==null&&(!message.platform||message.platform===platform)){binding.status='ready';binding.checkedAt=now;binding.detail='Прочитан открытый чат';}}
      else if(t==='DIALOGS_SETTINGS')core.setDialogSettings(state,{...state.settings,...message.settings},now);
      else if(t==='DIALOGS_AUTODRAFT'){if(message.enabled)throw new Error('API drafting must not be enabled by folder-only UI');core.setDialogSettings(state,{...state.settings,autoDraft:false},now);}
      else if(t==='DIALOGS_PRODUCT_SAVE'){if(message.revision!==state.product.revision||message.fingerprint!==core.productFingerprint(state))throw new Error('Версия товара изменилась');core.saveProduct(state,message.product,now);}
      else if(t==='DIALOGS_PRODUCT_APPROVE'){if(message.revision!==state.product.revision)throw new Error('Версия товара изменилась');core.approveProduct(state,message.fingerprint,now);}
      else if(t==='DIALOGS_CONTROL')core.setConversationControl(state,message.key,message,now);
      else if(t==='DIALOGS_SAVE_DRAFT'){const request=core.draftRequest(state,message.key);core.buildDraftPrompt(state,request);if(request.revision!==message.revision||request.fingerprint!==message.fingerprint)throw new Error('Переписка изменилась');core.acceptDraft(state,request,{text:message.text},now);}
      else if(t==='DIALOGS_CONTEXT_EDITING'){folder.auto=false;folder.autoSend=false;state.settings.autoDraft=false;for(const job of folder.jobs)if(['preparing','queued','running','done','awaiting_limit'].includes(job.status))job.status='cancelled';}
      else if(t==='DIALOGS_DRAFT_EDITING'){for(const job of folder.jobs)if(job.key===message.key&&['queued','running','done','awaiting_limit'].includes(job.status))job.status='cancelled';if(window.deferDraftEditing)await new Promise(resolve=>{window.resolveDraftEditing=resolve;});}
      else if(t==='DIALOGS_DISCARD_DRAFT')state.conversations[message.key].draft=null;
      else if(t==='DIALOGS_SEND_DRAFT'){
        const current=core.draftRequest(state,message.key),item=state.conversations[message.key];
        if(!item?.draft||message.text!==item.draft.text||message.revision!==current.revision||message.fingerprint!==current.fingerprint||message.productFingerprint!==current.productFingerprint||item.draft.productFingerprint!==current.productFingerprint)throw new Error('Черновик или контекст изменились');
        if(folder.jobs.some(job=>job.key===message.key&&['sent','send_unknown'].includes(job.status)))throw new Error('Попытка отправки уже зарегистрирована');
        if(window.deferSend)await new Promise(resolve=>{window.resolveSend=resolve;});
        const status=window.sendOutcome;
        if(['attempted','unknown'].includes(status)){window.sentTexts.push(message.text);folder.sendReceipts.push({key:message.key,fingerprint:current.fingerprint,status:status==='unknown'?'unknown':'sent',at:now});folder.jobs.push({id:'manual-send-'+folder.jobs.length,kind:'dialog',key:message.key,status:status==='unknown'?'send_unknown':'sent',request:structuredClone(current),at:now,detail:'Синтетическая квитанция отправки'});}
        return {...publicState(),send:{status,detail:status==='deferred'?'Лимит площадки; повторите вручную позже.':status==='unknown'?'Результат отправки неизвестен; проверьте чат.':status==='blocked'?'Отправка заблокирована.':'Кнопка отправки нажата.',...(status==='deferred'?{retryAt:now+60000}:{})}};
      }
      else if(t==='DIALOGS_FOLDER_STATUS')return publicState();
      else if(t==='DIALOGS_FOLDER_SETTINGS'){
        if(failFolder)throw new Error('Локальный модуль не найден. Установите обработчик Claude Code.');
        if((message.auto||message.autoSend)&&(!state.product.approval||state.product.approval.fingerprint!==core.productFingerprint(state)))throw new Error('Сначала сохраните и согласуйте сведения о товаре.');
        for(const key of ['enabled','auto','autoSend','model'])if(Object.hasOwn(message,key))folder[key]=message[key];
        if(!folder.enabled){folder.status='paused';folder.auto=false;folder.autoSend=false;for(const job of folder.jobs)if(['queued','running'].includes(job.status))job.status='cancelled';}
        else {folder.status='offline';folder.detail='Claude недоступен: задания ждут подключения к интернету.';folder.folder='C:\\Users\\Test\\Desktop\\OpenLinks Claude';folder.worker={running:true,heartbeat:now,status:'offline'};}
      }
      else if(t==='DIALOGS_FOLDER_PRODUCT'){if(!folder.enabled)throw new Error('Папка выключена');if(message.revision!==state.product.revision||message.fingerprint!==core.productFingerprint(state))throw new Error('Версия товара изменилась');folder.jobs.push({id:'job-product-'+folder.jobs.length,kind:'product',status:'queued',at:now,request:core.productExtractionRequest(state)});}
      else if(t==='DIALOGS_FOLDER_DRAFT'){if(!folder.enabled)throw new Error('Папка выключена');core.buildDraftPrompt(state,core.draftRequest(state,message.key));folder.jobs.push({id:'job-draft-'+folder.jobs.length,kind:'dialog',key:message.key,status:'queued',at:now});}
      else if(t==='DIALOGS_FOLDER_POLL')return publicState();
      else if(t==='DIALOGS_FOLDER_RETRY')folder.jobs.find(job=>job.id===message.id).status='queued';
      else if(t==='DIALOGS_FOLDER_CANCEL')folder.jobs.find(job=>job.id===message.id).status='cancelled';
      else return {ok:false,error:'Unknown test action '+t};
      return publicState();
    }catch(error){return {ok:false,error:error.message};}
  }}};
  const thread=(id,platform,extra={})=>({key:platform+':'+id,id,platform,title:'Supplier '+id,url:platform==='1688'?'https://air.1688.com/chat/':'https://message.alibaba.com/',identityReliable:true,unread:false,needsRead:false,messages:[{key:'m1',id:'m1',direction:'outbound',text:'Hello, I need a machine.',at:now-60000},{key:'m2',id:'m2',direction:'inbound',text:'What quantity do you need?',at:now}],orderReliable:true,tailKnown:true,revision:1,fingerprint:'fp1',unanswered:true,paused:false,takeover:false,draft:null,updatedAt:now,lastObservedAt:now,...extra});
  window.seedDialogs=()=>{state.conversations={'alibaba:alpha':thread('alpha','alibaba'),'1688:list':thread('list','1688',{title:'Only unread badge',unread:3,needsRead:true,messages:[],orderReliable:false,tailKnown:false,unanswered:false,preview:'A list preview'}),'mic:uncertain':thread('uncertain','mic',{title:'Uncertain order',orderReliable:false,messages:[{key:'m3',direction:'unknown',text:'Ambiguous author',at:null}]})};state.events=[{at:now,type:'scan',platform:'1688',detail:'Проверка завершена'}];announce();};
  window.changeDialog=patch=>{Object.assign(state.conversations['alibaba:alpha'],patch);announce();};
  window.changeProduct=patch=>{core.saveProduct(state,patch,now);announce();};
  window.dialogAI=()=>structuredClone(ai);window.dialogState=()=>structuredClone(state);window.folderState=()=>structuredClone(folder);
  window.changeFolder=patch=>{Object.assign(folder,patch);announce();};
  window.finishProductJob=()=>{const job=[...folder.jobs].reverse().find(job=>job.kind==='product'&&job.status==='queued');if(!job)throw new Error('No product job');core.acceptProductExtraction(state,job.request,{keyPoints:'Model A. Quantity: 10. Stainless steel.',questions:'What is the minimum order?\nWhat is the lead time?',warnings:'Price has not been confirmed.',processedImageKeys:state.product.files.filter(file=>!file.excluded).flatMap(file=>(file.images||[]).map(image=>image.imageKey))},now);job.status='accepted';announce();};
  window.deliverDraft=(text='Could you confirm the minimum order?')=>{core.acceptDraft(state,core.draftRequest(state,'alibaba:alpha'),{text,reason:'Ответ Claude из папки'},now);const job=[...folder.jobs].reverse().find(job=>job.key==='alibaba:alpha'&&job.status==='queued');if(job)job.status='accepted';announce();};
  window.announceDialogs=announce;
})();
"""


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True)
        context = browser.new_context(viewport={'width': 1500, 'height': 1100}, timezone_id='Asia/Irkutsk')
        context.set_default_timeout(8000)
        context.add_init_script(HARNESS)
        external = []

        def local_only(route):
            if route.request.url.startswith('http://127.0.0.1:'):
                route.continue_()
            else:
                external.append(route.request.url)
                route.abort()

        context.route('**/*', local_only)
        ui = context.new_page()
        errors = []
        ui.on('pageerror', lambda error: errors.append(str(error)))
        ui.goto(f'http://127.0.0.1:{server.server_port}/extension/dialogs.html')
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг остановлен')
        expect(ui.locator('.dialogs-platform')).to_have_count(3)
        expect(ui.locator('#dialogs-start')).to_be_disabled()
        expect(ui.locator('#dialogs-read-unread')).to_be_checked()
        assert ui.evaluate("calls.every(c=>['DIALOGS_GET','DIALOGS_LIST_TABS'].includes(c.type))")
        assert ui.evaluate('permissionCalls.length') == 0
        removed = '#dialogs-provider,#dialogs-api-key,#dialogs-model,#dialogs-clear-key,#dialogs-auto-draft,#dialogs-folder-auto,#dialogs-product-extract,#dialogs-product-export,#dialogs-generate,#dialogs-export-draft,#dialogs-prompt-panel'
        expect(ui.locator(removed)).to_have_count(0)
        expect(ui.locator('select#dialogs-folder-model')).to_have_count(1)
        assert ui.locator('#dialogs-folder-model option').evaluate_all('(options)=>options.map(o=>o.value)') == ['haiku','sonnet','opus']
        expect(ui.locator('#dialogs-folder-model')).to_have_value('haiku')
        expect(ui.locator('input[id^=dialogs-folder-][type=checkbox]')).to_have_count(1)
        expect(ui.locator('#dialogs-folder-send')).not_to_be_checked()
        passed('folder-only UI exposes model choices and one send-mode checkbox; render requests no permissions or AI')
        expect(ui.locator('#dialogs-diagnostics')).to_have_attribute('href','diagnostics.html')
        expect(ui.locator('#dialogs-diagnostics')).to_have_attribute('target','_blank')
        assert not ui.evaluate("calls.some(c=>/DIAGNOSTIC/.test(c.type))")
        passed('diagnostics is an explicit link with no automatic conversation collection')

        ui.locator('#dialogs-tab-alibaba').select_option('22')
        ui.locator('[data-platform="alibaba"]').get_by_role('button', name='Выбрать', exact=True).click()
        ui.locator('#dialogs-start').click()
        expect(ui.locator('#dialogs-run-state')).to_have_text('Только чтение')
        assert ui.evaluate('folderState().auto') is False
        assert ui.evaluate('folderState().autoSend') is False
        assert not ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        ui.locator('#dialogs-scan').click()
        expect(ui.locator('[data-platform="alibaba"]')).to_contain_text('09:10:00')
        ui.locator('#dialogs-stop').click()
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг остановлен')
        ui.locator('#dialogs-monitor summary').click()
        ui.locator('#dialogs-read-unread').uncheck()
        ui.evaluate('announceDialogs()')
        expect(ui.locator('#dialogs-read-unread')).not_to_be_checked()
        ui.locator('#dialogs-start').click()
        expect(ui.locator('#dialogs-read-unread')).to_be_disabled()
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_START').at(-1).readUnread") is False
        ui.locator('#dialogs-stop').click()
        passed('unapproved product permits read-only monitoring, preserves traversal choice and displays PC-local time')

        ui.evaluate('allowPermission=false')
        ui.locator('#dialogs-folder-connect').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('не разрешён')
        assert not ui.evaluate("calls.some(c=>c.type==='DIALOGS_FOLDER_SETTINGS')")
        ui.evaluate('allowPermission=true;failFolder=true')
        ui.locator('#dialogs-folder-connect').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('Установите обработчик Claude Code')
        ui.evaluate('failFolder=false')
        ui.locator('#dialogs-folder-connect').click()
        expect(ui.locator('#dialogs-folder-path')).to_contain_text('Desktop\\OpenLinks Claude')
        assert ui.evaluate('permissionCalls.at(-1)') == {'permissions':['nativeMessaging']}
        assert ui.evaluate('folderState().auto') is False
        assert ui.evaluate('folderState().autoSend') is False
        expect(ui.locator('#dialogs-folder-send')).to_be_disabled()
        passed('connect requests only Native Messaging; denied permission/missing host are visible and unapproved auto sending stays disabled')

        ui.locator('#dialogs-folder-model').select_option('sonnet')
        ui.evaluate('announceDialogs()')
        expect(ui.locator('#dialogs-folder-model')).to_have_value('sonnet')
        assert ui.evaluate('folderState().model') == 'haiku'
        ui.locator('#dialogs-folder-save').click()
        expect(ui.locator('#dialogs-folder-edits')).to_be_hidden()
        assert ui.evaluate('folderState().model') == 'sonnet'
        assert not ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        passed('unsaved model choice survives refresh and is saved without sending messages')

        ui.evaluate('seedDialogs()')
        ui.locator('#dialogs-filter').select_option('unread')
        expect(ui.locator('.dialogs-thread')).to_have_count(1)
        ui.locator('.dialogs-thread').click()
        expect(ui.locator('#dialogs-history')).to_contain_text('история этой переписки ещё не прочитана')
        expect(ui.locator('#dialogs-folder-draft')).to_be_disabled()
        expect(ui.locator('#dialogs-send-draft')).to_be_disabled()
        expect(ui.locator('#dialogs-conversation-status')).not_to_contain_text('Требует ответа')
        ui.locator('#dialogs-filter').select_option('all')
        ui.locator('#dialogs-search').fill('Ambiguous author')
        expect(ui.locator('.dialogs-thread')).to_have_count(1)
        ui.locator('.dialogs-thread').click()
        expect(ui.locator('#dialogs-history')).to_contain_text('Автор не определён')
        expect(ui.locator('#dialogs-folder-draft')).to_be_disabled()
        expect(ui.locator('#dialogs-send-draft')).to_be_disabled()
        ui.locator('#dialogs-search').fill('')
        ui.locator('[data-key="alibaba:alpha"]').click()
        passed('unread badge and uncertain message authors cannot enable draft creation or sending')

        detail = 'Содержимое вложения не прочитано; подготовка ответа заблокирована. <img src=x onerror=alert(1)>'
        ui.evaluate('(detail)=>changeDialog({detail,needsRead:true,orderReliable:false})',detail)
        expect(ui.locator('#dialogs-reader-detail')).to_have_text(detail)
        assert ui.locator('#dialogs-reader-detail img').count() == 0
        expect(ui.locator('#dialogs-folder-draft')).to_be_disabled()
        expect(ui.locator('#dialogs-send-draft')).to_be_disabled()
        ui.evaluate("changeDialog({detail:'',needsRead:false,orderReliable:true})")
        expect(ui.locator('#dialogs-history .outbound')).to_contain_text('Вы')
        expect(ui.locator('#dialogs-history .inbound')).to_contain_text('Поставщик')
        passed('specific reader failures and sender labels remain visible and supplier markup is rendered as text')

        ui.locator('.dialogs-settings > summary').click()
        ui.locator('#dialogs-brief').fill('We need 10 machines. Ask the minimum order.')
        ui.locator('#dialogs-wechat').fill('demo-buyer')
        ui.locator('#dialogs-language').fill('English')
        ui.evaluate('announceDialogs()')
        expect(ui.locator('#dialogs-brief')).to_have_value('We need 10 machines. Ask the minimum order.')
        ui.locator('#dialogs-save-settings').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('сохран')
        payload = ui.evaluate("calls.filter(c=>c.type==='DIALOGS_SETTINGS').at(-1)")
        assert payload['settings']['wechat'] == 'demo-buyer'
        assert not any(field in payload for field in ['provider','model','apiKey','clearApiKey'])
        passed('buyer context survives refresh and saves independently of removed API profiles')

        ui.locator('#dialogs-product-card').fill('Model A machine, stainless steel. Buyer requires ten units.')
        ui.locator('#dialogs-product-characteristics').fill('10 units, stainless steel, spare parts included.')
        ui.locator('#dialogs-product-rules').fill('Ask MOQ. Do not agree to payment or a final price.')
        ui.locator('#dialogs-product-points').fill('Manual draft of the product facts.')
        ui.locator('#dialogs-product-files').set_input_files([
            {'name':'specification.txt','mimeType':'text/plain','buffer':b'Material: stainless steel. <img src=x onerror=alert(1)>'},
            {'name':'unsupported.bin','mimeType':'application/octet-stream','buffer':b'\x00\xff\x00\x80\x00'},
        ])
        expect(ui.locator('.dialogs-product-file')).to_have_count(2)
        expect(ui.locator('#dialogs-product-file-list')).to_contain_text('Формат не поддерживается')
        expect(ui.locator('#dialogs-product-file-list')).to_contain_text('Прочитан')
        assert ui.locator('#dialogs-product-file-list img').count() == 0
        ui.locator('#dialogs-product-save').click()
        expect(ui.locator('#dialogs-product-approve')).to_be_disabled()
        assert 'data:' not in ui.evaluate('JSON.stringify(dialogState().product.files)')
        bad_file = ui.locator('.dialogs-product-file').filter(has_text='unsupported.bin')
        old_id = bad_file.get_attribute('data-file-id')
        bad_file.get_by_role('button',name='Повторить чтение').click()
        ui.wait_for_function('(oldId)=>!document.querySelector(`[data-file-id="${oldId}"]`)',arg=old_id)
        bad_file = ui.locator('.dialogs-product-file').filter(has_text='unsupported.bin')
        bad_file.get_by_role('checkbox').check()
        ui.locator('#dialogs-product-save').click()
        expect(ui.locator('#dialogs-product-approve')).to_be_enabled()
        assert next(file for file in ui.evaluate('dialogState().product.files') if file['name']=='unsupported.bin')['excluded'] is True
        passed('real file import/retry/exclusion preserves content status and blocks approval of unread materials')

        ui.locator('#dialogs-folder-connect').click()
        ui.locator('#dialogs-product-questions').fill('Please confirm delivery lead time.')
        # Editing pauses automatic replies but keeps extraction available.
        expect(ui.locator('#dialogs-product-save')).to_be_enabled()
        expect(ui.locator('#dialogs-product-folder')).to_be_enabled()
        ui.locator('#dialogs-product-folder').click()
        expect(ui.locator('#dialogs-folder-jobs')).to_contain_text('Сведения о товаре')
        expect(ui.locator('#dialogs-product-save')).to_be_disabled()
        queued = ui.evaluate("calls.filter(c=>c.type==='DIALOGS_FOLDER_PRODUCT').at(-1)")
        assert queued['revision'] == ui.evaluate('dialogState().product.revision')
        assert queued['fingerprint']
        ui.wait_for_function("folderState().jobs.some(job=>job.kind==='product'&&job.status==='queued')")
        ui.evaluate('finishProductJob()')
        expect(ui.locator('#dialogs-product-points')).to_have_value('Model A. Quantity: 10. Stainless steel.')
        expect(ui.locator('#dialogs-product-status')).to_contain_text('Нужно согласование')
        assert ui.evaluate('dialogState().product.approval') is None
        ui.locator('#dialogs-product-points').fill('Model A. Quantity: 10. Stainless steel. Include spare parts.')
        ui.locator('#dialogs-product-save').click()
        ui.locator('#dialogs-product-approve').click()
        expect(ui.locator('#dialogs-product-status')).to_contain_text('Согласовано')
        approval = ui.evaluate("calls.filter(c=>c.type==='DIALOGS_PRODUCT_APPROVE').at(-1)")
        assert approval['fingerprint'] == ui.evaluate('dialogState().product.approval.fingerprint')
        passed('folder extraction saves pending edits with exact revision and leaves returned facts for explicit editable approval')

        image_bytes = base64.b64decode(ui.evaluate("(()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;canvas.getContext('2d').fillRect(0,0,32,32);return canvas.toDataURL('image/png').split(',')[1];})()"))
        ui.locator('#dialogs-product-files').set_input_files({'name':'machine.png','mimeType':'image/png','buffer':image_bytes})
        image_file = ui.locator('.dialogs-product-file').filter(has_text='machine.png')
        expect(image_file).to_contain_text('Готов к анализу')
        ui.locator('#dialogs-product-save').click()
        expect(ui.locator('#dialogs-product-approve')).to_be_disabled()
        ui.locator('#dialogs-folder-connect').click()
        ui.locator('#dialogs-product-folder').click()
        ui.wait_for_function("folderState().jobs.some(job=>job.kind==='product'&&job.status==='queued')")
        ui.evaluate('finishProductJob()')
        expect(ui.locator('#dialogs-product-approve')).to_be_enabled()
        ui.locator('#dialogs-product-approve').click()
        image_id = image_file.get_attribute('data-file-id')
        image_file.get_by_role('button', name='Удалить', exact=True).click()
        assert ui.evaluate("async id=>!!await (await import('/extension/lib/product-files.js')).readProductOriginal(id)",image_id)
        ui.locator('#dialogs-product-save').click()
        ui.wait_for_function("async id=>!await (await import('/extension/lib/product-files.js')).readProductOriginal(id)",arg=image_id)
        ui.locator('#dialogs-product-approve').click()
        passed('image materials require returned analysis before approval and local original bytes are removed only after save')

        ui.locator('#dialogs-product-questions').fill('Unsaved local question')
        ui.evaluate("changeProduct({rules:'Changed from another window'})")
        expect(ui.locator('#dialogs-product-conflict')).to_be_visible()
        ui.locator('#dialogs-product-save').click()
        expect(ui.locator('#dialogs-feedback')).to_have_text('Версия товара изменилась')
        expect(ui.locator('#dialogs-product-questions')).to_have_value('Unsaved local question')
        ui.locator('#dialogs-product-reset').click()
        expect(ui.locator('#dialogs-product-rules')).to_have_value('Changed from another window')
        expect(ui.locator('#dialogs-product-conflict')).to_be_hidden()
        ui.locator('#dialogs-product-approve').click()
        passed('concurrent product revision rejects stale save without losing unsaved local text')

        original_messages = ui.evaluate("dialogState().conversations['alibaba:alpha'].messages")
        attachment = {'type':'image','name':'photo <img src=x>','url':'https://tracker.example/image.png','contentReady':False,'resolution':{'status':'error','warnings':['Image unavailable <img src=x onerror=alert(1)>'],'images':[]}}
        ui.evaluate('(attachment)=>changeDialog({contentReady:false,needsRead:true,detail:"Не удалось прочитать вложение",coverage:{attachments:1,unreadAttachments:1},messages:[{key:"attachment",direction:"inbound",text:"See image",attachments:[attachment]}]})',attachment)
        expect(ui.locator('#dialogs-coverage')).to_contain_text('Недоступных вложений: 1')
        expect(ui.locator('#dialogs-history')).to_contain_text('Image unavailable <img src=x onerror=alert(1)>')
        expect(ui.locator('#dialogs-folder-draft')).to_be_disabled()
        expect(ui.locator('#dialogs-send-draft')).to_be_disabled()
        assert ui.locator('#dialogs-history img,#dialogs-history a').count() == 0
        ui.evaluate('(messages)=>changeDialog({messages,contentReady:true,needsRead:false,detail:"",coverage:null})',original_messages)
        archived = {'key':'old-wrapper','direction':'unknown','text':'Old observation <img src=x onerror=alert(1)>','at':None,'archivedAt':1792314600000,'reason':'reader-correction','attachments':[]}
        nonread_before = ui.evaluate("calls.filter(c=>c.type!=='DIALOGS_GET').length")
        ui.evaluate('(message)=>changeDialog({archivedMessages:[message]})',archived)
        archive = ui.locator('.dialogs-history-archive')
        expect(archive.locator('summary')).to_have_text('Исправленные записи истории (1)')
        archive.locator('summary').click()
        expect(archive).to_contain_text('не используются для подготовки ответов с ИИ')
        assert archive.locator('button,input,textarea,img,script,a').count() == 0
        ui.evaluate('(message)=>changeDialog({archivedMessages:[message,{...message,key:"second",text:"Another corrected observation"}]})',archived)
        expect(archive).to_have_attribute('open','')
        expect(archive.locator('summary')).to_have_text('Исправленные записи истории (2)')
        assert ui.evaluate("calls.filter(c=>c.type!=='DIALOGS_GET').length") == nonread_before
        passed('attachment failures and corrected-history archive remain safe read-only evidence without network or generation')

        ui.evaluate("changeDialog({url:'javascript:alert(1)',title:'<img src=x onerror=alert(1)>'})")
        expect(ui.locator('#dialogs-source')).to_be_hidden()
        expect(ui.locator('#dialogs-supplier')).to_have_text('<img src=x onerror=alert(1)>')
        assert ui.locator('#dialogs-supplier img').count() == 0
        ui.set_viewport_size({'width':600,'height':850})
        assert ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        passed('supplier names and URLs cannot inject markup; folder-only layout fits a 600px viewport')

        def prepared_page():
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}/extension/dialogs.html')
            expect(page.locator('#dialogs-run-state')).to_have_text('Мониторинг остановлен')
            page.evaluate('seedDialogs()')
            page.locator('[data-key="alibaba:alpha"]').click()
            page.locator('#dialogs-tab-alibaba').select_option('22')
            page.locator('[data-platform="alibaba"]').get_by_role('button',name='Выбрать',exact=True).click()
            page.locator('#dialogs-product-card').fill('Model A, 10 units, stainless steel.')
            page.locator('#dialogs-product-points').fill('Model A. Quantity: 10. Stainless steel.')
            page.locator('#dialogs-product-rules').fill('Ask MOQ and lead time; no payment commitments.')
            page.locator('#dialogs-product-save').click()
            page.locator('#dialogs-product-approve').click()
            expect(page.locator('#dialogs-product-status')).to_contain_text('Согласовано')
            page.locator('#dialogs-folder-connect').click()
            return page

        send_ui = prepared_page()
        send_ui.locator('#dialogs-start').click()
        send_ui.wait_for_function('dialogState().running===true')
        assert send_ui.evaluate('folderState().auto') is True
        assert send_ui.evaluate('folderState().autoSend') is False
        assert send_ui.evaluate('dialogState().settings.autoDraft') is False
        assert not send_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        passed('starting approved connected monitoring automatically enables folder drafts without sending or a second auto checkbox')

        send_ui.locator('#dialogs-folder-send').check()
        expect(send_ui.locator('#dialogs-folder-send')).to_be_checked()
        send_ui.wait_for_function('folderState().autoSend===true')
        assert send_ui.evaluate('folderState().auto') is True
        assert not send_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        changes = send_ui.evaluate("calls.filter(c=>c.type==='DIALOGS_FOLDER_SETTINGS').length")
        send_ui.evaluate('announceDialogs()')
        expect(send_ui.locator('#dialogs-folder-send')).to_be_checked()
        assert send_ui.evaluate("calls.filter(c=>c.type==='DIALOGS_FOLDER_SETTINGS').length") == changes
        send_ui.locator('#dialogs-folder-send').uncheck()
        send_ui.wait_for_function('folderState().autoSend===false')
        assert send_ui.evaluate('folderState().auto') is True
        assert not send_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        passed('one checkbox immediately switches sending mode; unchecking retains automatic drafts and render/toggle never sends')

        send_ui.locator('#dialogs-folder-draft').click()
        expect(send_ui.locator('#dialogs-folder-jobs')).to_contain_text('Alibaba · Supplier alpha')
        send_ui.evaluate('deliverDraft()')
        expect(send_ui.locator('#dialogs-draft-text')).to_have_value('Could you confirm the minimum order?')
        expect(send_ui.locator('#dialogs-send-draft')).to_be_enabled()
        expect(send_ui.locator('#dialogs-folder-draft')).to_be_disabled()
        assert not send_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        artifact_dir = Path(os.environ['OPENLINKS_UI_ARTIFACT_DIR']) if os.environ.get('OPENLINKS_UI_ARTIFACT_DIR') else None
        if artifact_dir:
            artifact_dir.mkdir(parents=True,exist_ok=True)
            send_ui.screenshot(path=str(artifact_dir/'dialogs-desktop.png'),full_page=True)
        send_ui.locator('#dialogs-draft-text').fill('  We need 10 units. Please confirm MOQ and lead time.\n')
        send_ui.evaluate('announceDialogs()')
        expect(send_ui.locator('#dialogs-draft-text')).to_have_value('  We need 10 units. Please confirm MOQ and lead time.\n')
        expect(send_ui.locator('#dialogs-send-draft')).to_be_enabled()
        send_ui.evaluate('deferSend=true')
        send_ui.locator('#dialogs-send-draft').click()
        send_ui.wait_for_function("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        expect(send_ui.locator('#dialogs-send-draft')).to_be_disabled()
        sent = send_ui.evaluate("calls.filter(c=>c.type==='DIALOGS_SEND_DRAFT').at(-1)")
        assert sent == {'type':'DIALOGS_SEND_DRAFT','key':'alibaba:alpha','text':'We need 10 units. Please confirm MOQ and lead time.','revision':1,'fingerprint':'fp1','productFingerprint':send_ui.evaluate('dialogState().product.approval.fingerprint')}
        preceding = send_ui.evaluate("calls.slice(0,calls.findIndex(c=>c.type==='DIALOGS_SEND_DRAFT')).filter(c=>c.type==='DIALOGS_SAVE_DRAFT').at(-1)")
        assert preceding['text'] == sent['text']
        send_ui.evaluate('resolveSend()')
        send_ui.wait_for_function('sentTexts.length===1')
        send_ui.evaluate('announceDialogs()')
        expect(send_ui.locator('#dialogs-send-draft')).to_be_disabled()
        assert send_ui.evaluate("calls.filter(c=>c.type==='DIALOGS_SEND_DRAFT').length") == 1
        passed('explicit Send saves the latest edited text first, sends exact reviewed context once and blocks pending/duplicate clicks')

        stale_ui = prepared_page()
        stale_ui.locator('#dialogs-start').click()
        stale_ui.evaluate('deliverDraft()')
        expect(stale_ui.locator('#dialogs-draft-text')).to_have_value('Could you confirm the minimum order?')
        stale_ui.locator('#dialogs-draft-text').fill('Keep this edited reply for the original context.')
        stale_ui.evaluate("changeDialog({revision:2,fingerprint:'fp2'})")
        expect(stale_ui.locator('#dialogs-draft-text')).to_have_value('Keep this edited reply for the original context.')
        expect(stale_ui.locator('#dialogs-save-draft')).to_be_disabled()
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_disabled()
        assert not stale_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        stale_ui.locator('#dialogs-discard-draft').click()
        expect(stale_ui.locator('#dialogs-draft-text')).to_have_value('')
        stale_ui.evaluate('deliverDraft()')
        expect(stale_ui.locator('#dialogs-draft-text')).to_have_value('Could you confirm the minimum order?')
        stale_ui.locator('#dialogs-draft-text').fill('A reply reviewed against the previous product.')
        stale_ui.evaluate("changeProduct({rules:'New product rule in another window'})")
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_disabled()
        stale_ui.locator('#dialogs-product-approve').click()
        expect(stale_ui.locator('#dialogs-draft-text')).to_have_value('A reply reviewed against the previous product.')
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_disabled()
        assert not stale_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        passed('history or product changes preserve local reply edits while blocking sending even after a later product approval')

        stale_ui.locator('#dialogs-discard-draft').click()
        expect(stale_ui.locator('#dialogs-draft-text')).to_have_value('')
        stale_ui.evaluate('deliverDraft()')
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_enabled()
        stale_ui.locator('#dialogs-takeover').click()
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_disabled()
        stale_ui.locator('#dialogs-takeover').click()
        stale_ui.wait_for_function("dialogState().conversations['alibaba:alpha'].takeover===false")
        stale_ui.evaluate('deliverDraft()')
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_enabled()
        stale_ui.locator('#dialogs-mute').click()
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_disabled()
        stale_ui.locator('#dialogs-mute').click()
        stale_ui.wait_for_function("dialogState().conversations['alibaba:alpha'].paused===false")
        stale_ui.evaluate('deliverDraft()')
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_enabled()
        passed('takeover and per-conversation pause also block explicit sending until resumed')

        stale_ui.evaluate("sendOutcome='deferred'")
        stale_ui.locator('#dialogs-send-draft').click()
        expect(stale_ui.locator('#dialogs-feedback')).to_contain_text('Лимит')
        assert stale_ui.evaluate('sentTexts.length') == 0
        stale_ui.evaluate('announceDialogs()')
        assert stale_ui.evaluate("calls.filter(c=>c.type==='DIALOGS_SEND_DRAFT').length") == 1
        stale_ui.evaluate("sendOutcome='unknown'")
        stale_ui.locator('#dialogs-send-draft').click()
        expect(stale_ui.locator('#dialogs-feedback')).to_contain_text('неизвестен')
        expect(stale_ui.locator('#dialogs-send-draft')).to_be_disabled()
        stale_ui.evaluate('announceDialogs()')
        assert stale_ui.evaluate("calls.filter(c=>c.type==='DIALOGS_SEND_DRAFT').length") == 2
        passed('quota deferral does not send/retry automatically and an unknown result blocks a duplicate manual attempt')

        race_ui = prepared_page()
        race_ui.locator('#dialogs-start').click()
        race_ui.evaluate('deliverDraft();deferDraftEditing=true')
        expect(race_ui.locator('#dialogs-draft-text')).to_have_value('Could you confirm the minimum order?')
        race_ui.locator('#dialogs-draft-text').fill('This reply is awaiting edit acknowledgment.')
        race_ui.locator('#dialogs-send-draft').click()
        race_ui.wait_for_function('typeof resolveDraftEditing==="function"')
        race_ui.locator('#dialogs-product-rules').fill('A new unsaved rule while Send is waiting.')
        race_ui.evaluate('resolveDraftEditing()')
        expect(race_ui.locator('#dialogs-feedback')).to_contain_text('Отправка отменена')
        assert not race_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        expect(race_ui.locator('#dialogs-draft-text')).to_have_value('This reply is awaiting edit acknowledgment.')
        passed('product changes while manual Send awaits edit acknowledgment cancel the intent without a send command')

        mode_ui = prepared_page()
        mode_ui.locator('#dialogs-folder-send').check()
        mode_ui.wait_for_function('folderState().autoSend===true')
        assert mode_ui.evaluate('dialogState().running') is True
        mode_ui.locator('#dialogs-folder-model').select_option('sonnet')
        mode_ui.locator('#dialogs-folder-send').uncheck()
        mode_ui.wait_for_function('folderState().autoSend===false')
        assert mode_ui.evaluate('folderState().auto') is True
        assert mode_ui.evaluate('folderState().model') == 'haiku'
        expect(mode_ui.locator('#dialogs-folder-model')).to_have_value('sonnet')
        mode_ui.locator('#dialogs-folder-save').click()
        mode_ui.wait_for_function('folderState().model==="sonnet"')
        mode_ui.locator('#dialogs-folder-send').check()
        mode_ui.wait_for_function('folderState().autoSend===true')
        assert not mode_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        passed('automatic sending can be switched off with an unsaved model choice without overwriting that choice or stopping drafts')
        mode_ui.locator('#dialogs-product-rules').fill('Unsaved new procurement restriction.')
        mode_ui.wait_for_function('folderState().autoSend===false')
        expect(mode_ui.locator('#dialogs-folder-send')).not_to_be_checked()
        assert mode_ui.evaluate('folderState().enabled') is True
        assert mode_ui.evaluate('folderState().auto') is False
        expect(mode_ui.locator('#dialogs-folder-draft')).to_be_disabled()
        assert not mode_ui.evaluate("calls.some(c=>c.type==='DIALOGS_SEND_DRAFT')")
        mode_ui.locator('#dialogs-product-save').click()
        expect(mode_ui.locator('#dialogs-product-status')).to_contain_text('Нужно согласование')
        mode_ui.locator('#dialogs-folder-connect').click()
        assert mode_ui.evaluate('folderState().auto') is False
        mode_ui.locator('#dialogs-product-approve').click()
        mode_ui.wait_for_function('folderState().auto===true')
        assert mode_ui.evaluate('folderState().autoSend') is False
        passed('unsaved product edits halt automatic sending; approval resumes draft-only monitoring without restoring send permission')

        mode_ui.evaluate("changeFolder({jobs:[{id:'failed-job',kind:'dialog',key:'alibaba:alpha',status:'error',at:1792314600000,detail:'Offline <img src=x onerror=alert(1)>'},{id:'uncertain-send',kind:'dialog',key:'alibaba:alpha',status:'send_unknown',at:1792314600000},{id:'limit-job',kind:'dialog',key:'alibaba:alpha',status:'awaiting_limit',at:1792314600000}]})")
        mode_ui.get_by_text('Задания Claude',exact=True).click()
        failed = mode_ui.locator('[data-job-id="failed-job"]')
        expect(failed).to_contain_text('Offline <img src=x onerror=alert(1)>')
        assert failed.locator('img,script').count() == 0
        assert mode_ui.locator('[data-job-id="uncertain-send"] button').count() == 0
        limited = mode_ui.locator('[data-job-id="limit-job"]')
        assert limited.get_by_role('button',name='Повторить',exact=True).count() == 0
        limited.get_by_role('button',name='Отменить',exact=True).click()
        expect(limited).to_contain_text('Отменено')
        failed.get_by_role('button',name='Повторить',exact=True).click()
        expect(failed).to_contain_text('В очереди')
        failed.get_by_role('button',name='Отменить',exact=True).click()
        expect(failed).to_contain_text('Отменено')
        mode_ui.locator('#dialogs-folder-poll').click()
        assert mode_ui.evaluate("calls.filter(c=>c.type==='DIALOGS_FOLDER_POLL').length") == 1
        passed('queue diagnostics escape supplier text and expose retry/cancel only for appropriate states')

        mode_ui.set_viewport_size({'width':600,'height':850})
        assert mode_ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        if artifact_dir:
            mode_ui.screenshot(path=str(artifact_dir/'dialogs-mobile.png'),full_page=True)
        ui.evaluate('failGet=true;announceDialogs()')
        expect(ui.locator('#dialogs-feedback')).to_have_text('Временная ошибка чтения')
        for page in [ui,send_ui,stale_ui,race_ui,mode_ui]:
            assert page.evaluate("permissionCalls.every(c=>c.permissions?.join(',')==='nativeMessaging'&&!c.origins)")
            assert page.evaluate("calls.every(c=>!['DIALOGS_PRODUCT_EXTRACT','DIALOGS_GENERATE_DRAFT','DIALOGS_EXPORT_PRODUCT_PROMPT','DIALOGS_EXPORT_DRAFT_PROMPT','DIALOGS_IMPORT_PRODUCT_RESULT'].includes(c.type))")
            assert page.evaluate("calls.every(c=>!/(FILL|CLICK)/.test(c.type))")
        assert not errors, errors
        assert not external, external
        passed('errors remain visible and folder-only flows make no API/manual export calls or external network requests')
        browser.close()
finally:
    server.shutdown()
print(f'{checks} dialogs UI browser checks passed', flush=True)
