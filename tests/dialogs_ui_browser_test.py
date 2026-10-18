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
  let state=null,core=null,ai={provider:'openai',keyStored:false,model:'',providers:{openai:{keyStored:false,model:''},anthropic:{keyStored:false,model:''}}};
  const coreModule=()=>import('/extension/lib/dialogs.js');
  window.calls=[];window.permissionCalls=[];window.allowPermission=true;window.failGet=false;
  const tabs=[{id:11,platform:'1688',title:'1688 chat',url:'https://air.1688.com/chat/'},{id:22,platform:'alibaba',title:'Alibaba messages',url:'https://message.alibaba.com/'},{id:33,platform:'mic',title:'Made-in-China messages',url:'https://webim.made-in-china.com/'}];
  const publicState=()=>({ok:true,state:structuredClone(state),ai:structuredClone(ai),productFingerprint:core.productFingerprint(state)});
  window.chrome={storage:{onChanged:{addListener:f=>listeners.push(f)}},permissions:{request:async data=>{permissionCalls.push(data);return allowPermission;}},runtime:{sendMessage:async message=>{
    calls.push(structuredClone(message));const t=message.type;core=await coreModule();state??=core.initialDialogs();
    try {
    if(t==='DIALOGS_GET')return failGet?{ok:false,error:'Временная ошибка чтения'}:publicState();
    if(t==='DIALOGS_LIST_TABS')return {ok:true,tabs};
    if(t==='DIALOGS_BIND_TAB'){const tab=tabs.find(tab=>tab.id===message.tabId);state.bindings[message.platform]={tabId:tab.id,url:tab.url,status:'loading',checkedAt:null,detail:'Ожидает проверки'};}
    else if(t==='DIALOGS_UNBIND_TAB')state.bindings[message.platform]={tabId:null,url:'',status:'unbound',checkedAt:null,detail:''};
    else if(t==='DIALOGS_START'){state.running=true;state.readUnread=message.readUnread===true;}
    else if(t==='DIALOGS_STOP')state.running=false;
    else if(t==='DIALOGS_SCAN'){for(const [platform,binding] of Object.entries(state.bindings))if(binding.tabId!==null&&(!message.platform||message.platform===platform)){binding.status='ready';binding.checkedAt=now;binding.detail='Прочитан открытый чат';}}
    else if(t==='DIALOGS_SETTINGS'){core.setDialogSettings(state,{...state.settings,...message.settings},now);ai.provider=message.provider||'openai';const profile=ai.providers[ai.provider];profile.model=message.model;if(message.apiKey)profile.keyStored=true;if(message.clearApiKey)profile.keyStored=false;ai.model=profile.model;ai.keyStored=profile.keyStored;}
    else if(t==='DIALOGS_PRODUCT_SAVE'){if(message.revision!==state.product.revision||message.fingerprint!==core.productFingerprint(state))throw new Error('Версия товара изменилась');core.saveProduct(state,message.product,now);}
    else if(t==='DIALOGS_PRODUCT_EXTRACT'){if(message.revision!==state.product.revision||message.fingerprint!==core.productFingerprint(state))throw new Error('Версия товара изменилась');core.acceptProductExtraction(state,core.productExtractionRequest(state),{keyPoints:'Model A. Quantity: 10. Stainless steel.',questions:'What is the minimum order?\nWhat is the lead time?',warnings:'Price has not been confirmed.',processedImageKeys:state.product.files.filter(file=>!file.excluded).flatMap(file=>(file.images||[]).map(image=>image.imageKey))},now);}
    else if(t==='DIALOGS_EXPORT_PRODUCT_PROMPT'){const request={revision:message.revision,fingerprint:message.fingerprint};return {...publicState(),promptExport:(await import('/extension/lib/manual-prompts.js')).buildManualProductPrompt(state,request,{now})};}
    else if(t==='DIALOGS_EXPORT_DRAFT_PROMPT'){return {...publicState(),promptExport:(await import('/extension/lib/manual-prompts.js')).buildManualDialogPrompt(state,core.draftRequest(state,message.key),{now})};}
    else if(t==='DIALOGS_IMPORT_PRODUCT_RESULT'){const manual=(await import('/extension/lib/manual-prompts.js')).buildManualProductPrompt(state,message.request,{now});if(manual.requiredImages.length&&!message.imagesAttached)throw new Error('Приложите изображения');const parsed=(await import('/extension/lib/dialog-ai.js')).parseProductKeyPoints(message.text,'anthropic');core.acceptProductExtraction(state,message.request,{...parsed,processedImageKeys:manual.requiredImages.map(image=>image.imageKey)},now);state.settings.autoDraft=false;}
    else if(t==='DIALOGS_PRODUCT_APPROVE'){if(message.revision!==state.product.revision)throw new Error('Версия товара изменилась');core.approveProduct(state,message.fingerprint,now);}
    else if(t==='DIALOGS_AUTODRAFT'){if(message.enabled&&(!state.product.approval||!ai.keyStored||!ai.model||!allowPermission))throw new Error('Сначала согласуйте товар и настройте OpenAI');core.setDialogSettings(state,{...state.settings,autoDraft:message.enabled===true},now);}
    else if(t==='DIALOGS_CONTROL')core.setConversationControl(state,message.key,message,now);
    else if(t==='DIALOGS_SAVE_DRAFT'){const request=message.request||core.draftRequest(state,message.key);core.buildDraftPrompt(state,request);if(request.revision!==message.revision||request.fingerprint!==message.fingerprint)return {ok:false,error:'Переписка изменилась'};core.acceptDraft(state,request,{text:message.text},now);}
    else if(t==='DIALOGS_DISCARD_DRAFT')state.conversations[message.key].draft=null;
    else if(t==='DIALOGS_GENERATE_DRAFT')core.acceptDraft(state,core.draftRequest(state,message.key),{text:'Could you confirm the minimum order?',reason:'Нужно уточнить MOQ.'},now);
    else return {ok:false,error:'Unknown test action '+t};
    return publicState();
    } catch(error) {return {ok:false,error:error.message};}
  }}};
  function announce(){for(const listener of listeners)listener({openlinksDialogs:{newValue:structuredClone(state)}},'local');}
  const thread=(id,platform,extra={})=>({key:platform+':'+id,id,platform,title:'Supplier '+id,url:platform==='1688'?'https://air.1688.com/chat/':'https://message.alibaba.com/',identityReliable:true,unread:false,needsRead:false,messages:[{key:'m1',id:'m1',direction:'outbound',text:'Hello, I need a machine.',at:now-60000},{key:'m2',id:'m2',direction:'inbound',text:'What quantity do you need?',at:now}],orderReliable:true,tailKnown:true,revision:1,fingerprint:'fp1',unanswered:true,paused:false,takeover:false,draft:null,updatedAt:now,lastObservedAt:now,...extra});
  window.seedDialogs=()=>{state.conversations={'alibaba:alpha':thread('alpha','alibaba'), '1688:list':thread('list','1688',{title:'Only unread badge',unread:3,needsRead:true,messages:[],orderReliable:false,tailKnown:false,unanswered:false,preview:'A list preview'}), 'mic:uncertain':thread('uncertain','mic',{title:'Uncertain order',orderReliable:false,messages:[{key:'m3',direction:'unknown',text:'Ambiguous author',at:null}]})};state.events=[{at:now,type:'scan',platform:'1688',detail:'Проверка завершена'}];announce();};
  window.changeDialog=patch=>{Object.assign(state.conversations['alibaba:alpha'],patch);announce();};
  window.changeProduct=patch=>{core.saveProduct(state,patch,now);announce();};
  window.dialogAI=()=>structuredClone(ai);
  window.dialogState=()=>structuredClone(state);
  window.announceDialogs=announce;
})();
"""


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True)
        context = browser.new_context(viewport={'width': 1500, 'height': 1100}, timezone_id='Asia/Irkutsk')
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
        expect(ui.locator('#dialogs-empty')).to_contain_text('Выберите вкладки')
        assert ui.evaluate('calls.every(c=>c.type===\'DIALOGS_GET\'||c.type===\'DIALOGS_LIST_TABS\')')
        assert ui.evaluate('permissionCalls.length') == 0
        passed('empty UI reads state and tabs without AI requests or permissions')
        expect(ui.locator('#dialogs-diagnostics')).to_have_attribute('href','diagnostics.html')
        expect(ui.locator('#dialogs-diagnostics')).to_have_attribute('target','_blank')
        assert not ui.evaluate("calls.some(c=>/DIAGNOSTIC/.test(c.type))")
        passed('advanced diagnostics link opens a page without automatically collecting or exporting conversations')

        expect(ui.locator('#dialogs-tab-alibaba option')).to_have_count(2)
        expect(ui.locator('#dialogs-tab-alibaba')).not_to_contain_text('1688 chat')
        ui.locator('#dialogs-tab-alibaba').select_option('22')
        ui.locator('[data-platform="alibaba"]').get_by_role('button', name='Выбрать', exact=True).click()
        expect(ui.locator('#dialogs-start')).to_be_enabled()
        ui.locator('#dialogs-start').click()
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг работает')
        expect(ui.locator('#dialogs-read-unread')).to_be_disabled()
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_START').at(-1)") == {'type':'DIALOGS_START','readUnread':True}
        ui.locator('#dialogs-scan').click()
        expect(ui.locator('[data-platform="alibaba"]')).to_contain_text('Чат доступен')
        expect(ui.locator('[data-platform="alibaba"]')).to_contain_text('09:10:00')
        ui.locator('#dialogs-stop').click()
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг остановлен')
        passed('platform-specific binding, start/scan/stop, and PC-local check time')

        expect(ui.locator('#dialogs-read-unread')).to_be_enabled()
        ui.locator('#dialogs-read-unread').uncheck()
        ui.evaluate('announceDialogs()')
        expect(ui.locator('#dialogs-read-unread')).not_to_be_checked()
        ui.locator('#dialogs-start').click()
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг работает')
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_START').at(-1)") == {'type':'DIALOGS_START','readUnread':False}
        expect(ui.locator('#dialogs-read-unread')).not_to_be_checked()
        expect(ui.locator('#dialogs-read-unread')).to_be_disabled()
        ui.locator('#dialogs-stop').click()
        expect(ui.locator('#dialogs-read-unread')).not_to_be_checked()
        expect(ui.locator('.dialogs-monitor-controls')).to_contain_text('может снять отметку «непрочитано»')
        passed('explicit start selects optional unread traversal; edits survive refresh and setting stays fixed while running')

        ui.evaluate('seedDialogs()')
        expect(ui.locator('.dialogs-thread')).to_have_count(3)
        ui.locator('#dialogs-filter').select_option('unread')
        expect(ui.locator('.dialogs-thread')).to_have_count(1)
        ui.locator('.dialogs-thread').click()
        expect(ui.locator('#dialogs-history')).to_contain_text('история этой переписки ещё не прочитана')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        expect(ui.locator('#dialogs-conversation-status')).not_to_contain_text('Требует ответа')
        passed('unread inbox preview never masquerades as a confirmed unanswered history')

        ui.locator('#dialogs-filter').select_option('all')
        ui.locator('#dialogs-search').fill('Ambiguous author')
        expect(ui.locator('.dialogs-thread')).to_have_count(1)
        ui.locator('.dialogs-thread').click()
        expect(ui.locator('#dialogs-history')).to_contain_text('Автор не определён')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        passed('search covers message text and uncertain authors cannot generate a reply')

        ui.locator('#dialogs-search').fill('')
        ui.locator('[data-key="alibaba:alpha"]').click()
        detail = 'Содержимое вложения не прочитано; подготовка ответа заблокирована. <img src=x onerror=alert(1)>'
        ui.evaluate('(detail)=>changeDialog({detail,needsRead:true,orderReliable:false})',detail)
        expect(ui.locator('#dialogs-reader-detail')).to_have_text(detail)
        expect(ui.locator('#dialogs-history-note')).to_be_hidden()
        expect(ui.locator('#dialogs-generate-hint')).to_have_text(detail)
        expect(ui.locator('#dialogs-conversation-status')).to_contain_text('Нужна проверка истории')
        expect(ui.locator('#dialogs-conversation-status')).not_to_contain_text('Нужно открыть историю')
        assert ui.locator('#dialogs-reader-detail img, #dialogs-generate-hint img').count() == 0
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        ui.evaluate("changeDialog({detail:'',needsRead:false,orderReliable:true})")
        expect(ui.locator('#dialogs-reader-detail')).to_be_hidden()
        expect(ui.locator('#dialogs-history-note')).to_be_visible()
        passed('specific adapter failure reason replaces generic reopen guidance and is rendered as plain text')
        expect(ui.locator('#dialogs-history')).to_contain_text('What quantity do you need?')
        expect(ui.locator('#dialogs-history .outbound')).to_contain_text('Вы')
        expect(ui.locator('#dialogs-history .inbound')).to_contain_text('Поставщик')
        expect(ui.locator('#dialogs-generate-hint')).to_contain_text('Сохраните и согласуйте информацию о товаре')
        ui.locator('#dialogs-brief').fill('We need 10 machines. Ask the minimum order. Do not agree on price.')
        ui.locator('#dialogs-wechat').fill('demo-buyer')
        ui.locator('#dialogs-language').fill('English')
        ui.locator('#dialogs-model').fill('test-model')
        ui.locator('#dialogs-api-key').fill('synthetic-test-key')
        ui.locator('#dialogs-save-settings').click()
        expect(ui.locator('#dialogs-feedback')).to_have_text('Задание и настройки сохранены.')
        expect(ui.locator('#dialogs-api-key')).to_have_value('')
        expect(ui.locator('#dialogs-key-status')).to_contain_text('Ключ сохранён')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        expect(ui.locator('#dialogs-auto-draft')).to_be_disabled()
        assert 'synthetic-test-key' not in ui.locator('body').inner_text()
        assert ui.evaluate('permissionCalls.length') == 0
        passed('brief/model/key explicitly saved, key input cleared, monitoring does not trigger AI')

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
        expect(ui.locator('#dialogs-product-save')).to_be_disabled()
        expect(ui.locator('#dialogs-product-approve')).to_be_disabled()
        expect(ui.locator('#dialogs-product-approval-note')).to_contain_text('исключите их из задания')
        assert len(ui.evaluate('dialogState().product.files')) == 2
        assert 'data:' not in ui.evaluate('JSON.stringify(dialogState().product.files)')
        passed('multiple actual local files retain ready/unsupported states, safe text previews and approval blocking')

        bad_file = ui.locator('.dialogs-product-file').filter(has_text='unsupported.bin')
        old_id = bad_file.get_attribute('data-file-id')
        bad_file.get_by_role('button',name='Повторить чтение').click()
        ui.wait_for_function('(oldId)=>!document.querySelector(`[data-file-id="${oldId}"]`)',arg=old_id)
        expect(ui.locator('.dialogs-product-file')).to_have_count(2)
        bad_file = ui.locator('.dialogs-product-file').filter(has_text='unsupported.bin')
        expect(bad_file).to_contain_text('Формат не поддерживается')
        bad_file.get_by_role('checkbox').check()
        ui.locator('#dialogs-product-save').click()
        expect(ui.locator('#dialogs-product-approve')).to_be_enabled()
        assert next(file for file in ui.evaluate('dialogState().product.files') if file['name']=='unsupported.bin')['excluded'] is True
        passed('failed attachment can be retried from local storage and explicitly excluded without disappearing')

        ui.evaluate('allowPermission=false')
        ui.locator('#dialogs-product-extract').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('Материалы не передавались')
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_PRODUCT_EXTRACT').length") == 0
        ui.evaluate('allowPermission=true')
        ui.locator('#dialogs-product-extract').click()
        expect(ui.locator('#dialogs-product-points')).to_have_value('Model A. Quantity: 10. Stainless steel.')
        expect(ui.locator('#dialogs-product-questions')).to_have_value('What is the minimum order?\nWhat is the lead time?')
        expect(ui.locator('#dialogs-product-status')).to_contain_text('Нужно согласование')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        ui.locator('#dialogs-product-points').fill('Model A. Quantity: 10. Stainless steel. Include spare parts.')
        ui.locator('#dialogs-product-save').click()
        ui.locator('#dialogs-product-approve').click()
        expect(ui.locator('#dialogs-product-status')).to_contain_text('Согласовано')
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        approval_request = ui.evaluate("calls.filter(c=>c.type==='DIALOGS_PRODUCT_APPROVE').at(-1)")
        assert approval_request['revision'] == ui.evaluate('dialogState().product.revision')
        assert approval_request['fingerprint'] == ui.evaluate('dialogState().product.approval.fingerprint')
        expect(ui.locator('.dialogs-product-scope')).to_contain_text('ко всем поставщикам')
        passed('extraction needs explicit permission; editable facts must be saved and approved with a matching revision')

        image_bytes = base64.b64decode(ui.evaluate("(()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;canvas.getContext('2d').fillRect(0,0,32,32);return canvas.toDataURL('image/png').split(',')[1];})()"))
        ui.locator('#dialogs-product-files').set_input_files({'name':'machine.png','mimeType':'image/png','buffer':image_bytes})
        image_file = ui.locator('.dialogs-product-file').filter(has_text='machine.png')
        expect(image_file).to_contain_text('Готов к анализу')
        ui.locator('#dialogs-product-save').click()
        expect(ui.locator('#dialogs-product-approve')).to_be_disabled()
        expect(ui.locator('#dialogs-product-approval-note')).to_contain_text('изображений товара')
        ui.locator('#dialogs-product-extract').click()
        expect(ui.locator('#dialogs-product-approve')).to_be_enabled()
        ui.locator('#dialogs-product-approve').click()
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        image_id = image_file.get_attribute('data-file-id')
        image_file.get_by_role('button',name='Удалить',exact=True).click()
        expect(ui.locator('.dialogs-product-file')).to_have_count(2)
        assert ui.evaluate("async id=>!!await (await import('/extension/lib/product-files.js')).readProductOriginal(id)",image_id)
        ui.locator('#dialogs-product-save').click()
        ui.wait_for_function("async id=>!await (await import('/extension/lib/product-files.js')).readProductOriginal(id)",arg=image_id)
        ui.locator('#dialogs-product-approve').click()
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        passed('prepared images require explicit AI analysis before approval; removal cleans local bytes only after saving')

        original_messages = ui.evaluate("dialogState().conversations['alibaba:alpha'].messages")
        attachment = {'type':'image','name':'photo <img src=x>','url':'https://tracker.example/image.png','contentReady':False,'contentRead':False,'resolution':{'status':'error','warnings':['Image unavailable <img src=x onerror=alert(1)>'],'images':[]}}
        ui.evaluate('(attachment)=>changeDialog({contentReady:false,needsRead:true,detail:"Не удалось прочитать вложение",coverage:{attachments:1,unreadAttachments:1,unknownSenders:0,unsupportedMessages:0,unmatchedTextNodes:0,limited:false},messages:[{key:"attachment",direction:"inbound",text:"See image",attachments:[attachment]}]})',attachment)
        expect(ui.locator('#dialogs-coverage')).to_contain_text('Недоступных вложений: 1')
        expect(ui.locator('#dialogs-history')).to_contain_text('Image unavailable <img src=x onerror=alert(1)>')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        assert ui.locator('#dialogs-history img, #dialogs-history a').count() == 0
        attachment.update({'contentReady':True,'resolution':{'status':'ready','warnings':[],'text':'','images':[{'imageKey':'synthetic-local-key','mime':'image/png'}]}})
        ui.evaluate('(attachment)=>changeDialog({contentReady:true,needsRead:false,detail:"",coverage:{attachments:1,unreadAttachments:0},messages:[{key:"attachment",direction:"inbound",text:"See image",attachments:[attachment]}]})',attachment)
        expect(ui.locator('#dialogs-history')).to_contain_text('Доступно для анализа ИИ')
        expect(ui.locator('#dialogs-history')).to_contain_text('Локально подготовлено изображений: 1')
        assert ui.locator('#dialogs-history img, #dialogs-history a').count() == 0
        ui.evaluate('(messages)=>changeDialog({messages,contentReady:true,needsRead:false,detail:"",coverage:null})',original_messages)
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        passed('supplier attachments expose coverage and failures as safe text; ready images are not labelled as already read')

        archived = {'key':'old-wrapper','direction':'unknown','text':'Old observation <img src=x onerror=alert(1)>','at':None,'archivedAt':1792314600000,'reason':'reader-correction','attachments':[{'name':'Old <script>file</script>','type':'image','url':'https://tracker.example/old.png'}]}
        calls_before_archive = ui.evaluate("calls.filter(call=>call.type!=='DIALOGS_GET').length")
        ui.evaluate('(message)=>changeDialog({archivedMessages:[message]})',archived)
        archive = ui.locator('.dialogs-history-archive')
        expect(archive.locator('summary')).to_have_text('Исправленные записи истории (1)')
        assert archive.get_attribute('open') is None
        archive.locator('summary').click()
        expect(archive).to_contain_text('Old observation <img src=x onerror=alert(1)>')
        expect(archive).to_contain_text('не используются для подготовки ответов с ИИ')
        expect(archive).to_contain_text('Old <script>file</script>')
        assert archive.locator('button,input,textarea,img,script,a').count() == 0
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        ui.evaluate('(message)=>changeDialog({archivedMessages:[message,{...message,key:"second",text:"Another corrected observation"}]})',archived)
        expect(archive.locator('summary')).to_have_text('Исправленные записи истории (2)')
        expect(archive).to_have_attribute('open','')
        expect(archive).to_contain_text('Another corrected observation')
        assert ui.evaluate("calls.filter(call=>call.type!=='DIALOGS_GET').length") == calls_before_archive
        ui.evaluate('changeDialog({archivedMessages:[]})')
        expect(archive).to_have_count(0)
        passed('corrected observations remain inspectable in a safe read-only archive and update without draft or network commands')

        ui.evaluate('allowPermission=false')
        ui.locator('#dialogs-auto-draft').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('Автоматические черновики не включены')
        expect(ui.locator('#dialogs-auto-draft')).not_to_be_checked()
        ui.evaluate('allowPermission=true')
        ui.locator('#dialogs-auto-draft').click()
        expect(ui.locator('#dialogs-auto-draft')).to_be_checked()
        assert ui.evaluate('dialogState().settings.autoDraft') is True
        ui.locator('#dialogs-product-rules').fill('Ask MOQ and lead time. Do not agree to payment.')
        expect(ui.locator('#dialogs-auto-draft')).not_to_be_checked()
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        assert ui.evaluate('dialogState().settings.autoDraft') is False
        ui.locator('#dialogs-product-save').click()
        expect(ui.locator('#dialogs-product-status')).to_contain_text('Нужно согласование')
        assert ui.evaluate('dialogState().product.approval') is None
        ui.locator('#dialogs-product-approve').click()
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        passed('automatic drafts require approval and API permission; editing pauses them immediately and invalidates saved approval')

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
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        passed('concurrent product revision rejects stale saves without losing local edits and offers an explicit reset')

        ui.evaluate("changeDialog({autoDraft:{status:'pending',at:1792314600000,fingerprint:'auto-test'}})")
        expect(ui.locator('#dialogs-auto-status')).to_have_text('ИИ готовит черновик.')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        ui.evaluate("changeDialog({autoDraft:{status:'error',at:1792314600000,fingerprint:'auto-test',error:'Временная ошибка сервиса',retryAt:1792314660000}})")
        expect(ui.locator('#dialogs-auto-status')).to_contain_text('Временная ошибка сервиса')
        expect(ui.locator('#dialogs-auto-status')).to_contain_text('Повтор возможен')
        ui.evaluate("changeDialog({autoDraft:null})")
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        passed('per-conversation automatic generation progress and retry errors are visible without duplicate manual requests')

        ui.evaluate('allowPermission=false')
        ui.locator('#dialogs-generate').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('Доступ к OpenAI API не разрешён')
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_GENERATE_DRAFT').length") == 0
        ui.evaluate('allowPermission=true')
        ui.locator('#dialogs-generate').click()
        expect(ui.locator('#dialogs-draft-text')).to_have_value('Could you confirm the minimum order?')
        assert ui.evaluate('permissionCalls.at(-1).origins') == ['https://api.openai.com/*']
        passed('AI draft needs an explicit click and optional official-API permission')

        ui.locator('#dialogs-draft-text').fill('Please confirm MOQ and lead time.')
        ui.locator('#dialogs-save-draft').click()
        expect(ui.locator('#dialogs-draft-status')).to_contain_text('Сохранён локально')
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_SAVE_DRAFT').at(-1)") == {'type':'DIALOGS_SAVE_DRAFT','key':'alibaba:alpha','text':'Please confirm MOQ and lead time.','revision':1,'fingerprint':'fp1'}
        passed('edited drafts save locally with viewed conversation revision and fingerprint')

        ui.locator('#dialogs-draft-text').fill('A local unsaved edit')
        ui.evaluate("changeDialog({revision:2,fingerprint:'fp2'})")
        expect(ui.locator('#dialogs-draft-text')).to_have_value('A local unsaved edit')
        expect(ui.locator('#dialogs-draft-status')).to_contain_text('Переписка изменилась')
        expect(ui.locator('#dialogs-save-draft')).to_be_disabled()
        ui.locator('#dialogs-discard-draft').click()
        expect(ui.locator('#dialogs-draft-text')).to_have_value('')
        passed('refresh preserves local edits and prevents stale drafts from being saved')

        ui.locator('#dialogs-takeover').click()
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        expect(ui.locator('#dialogs-conversation-status')).to_contain_text('Под вашим управлением')
        ui.locator('#dialogs-takeover').click()
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        ui.locator('#dialogs-mute').click()
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        ui.locator('#dialogs-filter').select_option('paused')
        expect(ui.locator('.dialogs-thread')).to_have_count(1)
        ui.locator('#dialogs-mute').click()
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        passed('takeover and per-conversation pause stop draft generation and can be resumed')

        ui.locator('#dialogs-brief').fill('Unsaved procurement brief')
        ui.evaluate('announceDialogs()')
        expect(ui.locator('#dialogs-brief')).to_have_value('Unsaved procurement brief')
        ui.locator('#dialogs-clear-key').check()
        ui.locator('#dialogs-save-settings').click()
        expect(ui.locator('#dialogs-key-status')).to_have_text('Ключ не сохранён.')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        passed('background refresh preserves settings edits and saved API key can be removed')

        ui.evaluate("changeDialog({url:'javascript:alert(1)',title:'<img src=x onerror=alert(1)>'})")
        expect(ui.locator('#dialogs-source')).to_be_hidden()
        expect(ui.locator('#dialogs-supplier')).to_have_text('<img src=x onerror=alert(1)>')
        assert ui.locator('#dialogs-supplier img').count() == 0
        passed('supplier content is text-only and non-marketplace or script URLs cannot become links')


        manual = context.new_page()
        manual.on('pageerror', lambda error: errors.append(str(error)))
        manual.goto(f'http://127.0.0.1:{server.server_port}/extension/dialogs.html')
        expect(manual.locator('#dialogs-provider')).to_have_value('openai')
        manual.evaluate('seedDialogs()')
        manual.locator('[data-key="alibaba:alpha"]').click()
        manual.locator('#dialogs-product-card').fill('Машина для упаковки. Нужно 20 штук.')
        expect(manual.locator('#dialogs-product-extract')).to_be_disabled()
        expect(manual.locator('#dialogs-product-export')).to_be_enabled()
        manual.locator('#dialogs-product-export').click()
        expect(manual.locator('#dialogs-prompt-panel')).to_be_visible()
        expect(manual.locator('#dialogs-product-save')).to_be_disabled()
        prompt_text = manual.locator('#dialogs-prompt-text').input_value()
        assert 'Машина для упаковки' in prompt_text and 'keyPoints' in prompt_text
        assert manual.evaluate('permissionCalls.length') == 0
        assert manual.evaluate("calls.filter(c=>c.type==='DIALOGS_PRODUCT_SAVE').length") == 1
        assert manual.evaluate("calls.every(c=>!['DIALOGS_PRODUCT_EXTRACT','DIALOGS_GENERATE_DRAFT'].includes(c.type))")
        manual.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedPrompt=text;}}})")
        manual.locator('#dialogs-prompt-copy').click()
        assert manual.evaluate('window.copiedPrompt') == prompt_text
        with manual.expect_download() as download_info:
            manual.locator('#dialogs-prompt-download').click()
        download = download_info.value
        assert download.suggested_filename.endswith('.txt')
        downloaded = Path(download.path()).read_bytes()
        assert downloaded[:3] == b'\xef\xbb\xbf'.decode('unicode_escape').encode('latin1')
        assert downloaded.decode('utf-8-sig') == prompt_text
        passed('keyless product export saves edits and copies/downloads complete UTF-8 TXT locally without API permission')

        manual.locator('#dialogs-prompt-response').fill('not JSON')
        manual.locator('#dialogs-prompt-apply').click()
        expect(manual.locator('#dialogs-feedback')).to_contain_text('некорректный')
        expect(manual.locator('#dialogs-prompt-response')).to_have_value('not JSON')
        manual.locator('#dialogs-prompt-response').fill('{"keyPoints":"20 упаковочных машин","questions":"Уточните цену и срок","warnings":"Цена неизвестна"}')
        manual.evaluate("changeProduct({characteristics:'Требование изменено в другом окне'})")
        expect(manual.locator('#dialogs-prompt-apply')).to_be_disabled()
        expect(manual.locator('#dialogs-prompt-import-note')).to_contain_text('изменились')
        manual.locator('#dialogs-product-export').click()
        manual.locator('#dialogs-prompt-response').fill('{"keyPoints":"20 упаковочных машин","questions":"Уточните цену и срок","warnings":"Цена неизвестна"}')
        manual.locator('#dialogs-prompt-apply').click()
        expect(manual.locator('#dialogs-prompt-panel')).to_be_hidden()
        expect(manual.locator('#dialogs-product-points')).to_have_value('20 упаковочных машин')
        expect(manual.locator('#dialogs-product-status')).to_contain_text('Нужно согласование')
        assert manual.evaluate('dialogState().product.approval') is None
        manual.locator('#dialogs-product-approve').click()
        expect(manual.locator('#dialogs-export-draft')).to_be_enabled()
        expect(manual.locator('#dialogs-generate')).to_be_disabled()
        passed('manual product import rejects malformed or stale responses and requires explicit approval after applying JSON')

        manual.locator('#dialogs-export-draft').click()
        expect(manual.locator('#dialogs-prompt-panel')).to_be_visible()
        expect(manual.locator('#dialogs-prompt-heading')).to_contain_text('Alibaba · Supplier alpha')
        manual.locator('[data-key="1688:list"]').click()
        expect(manual.locator('#dialogs-prompt-panel')).to_be_hidden()
        manual.locator('[data-key="alibaba:alpha"]').click()
        manual.locator('#dialogs-export-draft').click()
        expect(manual.locator('#dialogs-prompt-panel')).to_be_visible()
        draft_prompt = manual.locator('#dialogs-prompt-text').input_value()
        assert 'What quantity do you need?' in draft_prompt and '20 упаковочных машин' in draft_prompt
        expect(manual.locator('#dialogs-prompt-import')).to_be_hidden()
        manual.locator('#dialogs-draft-text').fill('We need 20 units. What is the lead time?')
        manual.locator('#dialogs-save-draft').click()
        expect(manual.locator('#dialogs-draft-status')).to_contain_text('Сохранён локально')
        saved_manual = manual.evaluate("calls.filter(c=>c.type==='DIALOGS_SAVE_DRAFT').at(-1)")
        assert saved_manual['request']['key'] == 'alibaba:alpha'
        assert saved_manual['request']['productFingerprint']
        assert saved_manual['request']['settingsFingerprint']
        assert manual.evaluate('permissionCalls.length') == 0
        manual.locator('#dialogs-export-draft').click()
        manual.locator('#dialogs-draft-text').fill('An answer prepared for the old context')
        manual.evaluate("changeProduct({rules:'New rule after export'})")
        manual.locator('#dialogs-product-approve').click()
        expect(manual.locator('#dialogs-save-draft')).to_be_disabled()
        expect(manual.locator('#dialogs-draft-status')).to_contain_text('после создания промпта')
        manual.locator('#dialogs-discard-draft').click()
        passed('keyless reply export contains approved context, binds pasted drafts to export snapshot and rejects changed context')

        manual.locator('#dialogs-product-files').set_input_files({'name':'machine.png','mimeType':'image/png','buffer':image_bytes})
        expect(manual.locator('.dialogs-product-file')).to_have_count(1)
        manual.locator('#dialogs-product-export').click()
        expect(manual.locator('#dialogs-prompt-warnings')).to_contain_text('machine.png')
        expect(manual.locator('#dialogs-prompt-images-label')).to_be_visible()
        manual.locator('#dialogs-prompt-response').fill('{"keyPoints":"20 машин; изображение приложено","questions":"Срок изготовления?","warnings":"Цена неизвестна"}')
        expect(manual.locator('#dialogs-prompt-apply')).to_be_disabled()
        manual.locator('#dialogs-prompt-images').check()
        expect(manual.locator('#dialogs-prompt-apply')).to_be_enabled()
        manual.locator('#dialogs-prompt-apply').click()
        expect(manual.locator('#dialogs-product-approve')).to_be_enabled()
        assert manual.evaluate("calls.filter(c=>c.type==='DIALOGS_IMPORT_PRODUCT_RESULT').at(-1).imagesAttached") is True
        manual.locator('#dialogs-product-approve').click()
        passed('manual image analysis lists required files and requires explicit attachment confirmation before import')

        manual.locator('#dialogs-provider').select_option('anthropic')
        expect(manual.locator('#dialogs-model-label')).to_contain_text('Claude')
        expect(manual.locator('#dialogs-api-key')).to_have_value('')
        manual.locator('#dialogs-model').fill('claude-test-model')
        manual.locator('#dialogs-api-key').fill('synthetic-claude-key')
        manual.once('dialog',lambda dialog: dialog.dismiss())
        manual.locator('#dialogs-provider').select_option('openai')
        expect(manual.locator('#dialogs-provider')).to_have_value('anthropic')
        expect(manual.locator('#dialogs-api-key')).to_have_value('synthetic-claude-key')
        manual.locator('#dialogs-save-settings').click()
        expect(manual.locator('#dialogs-key-status')).to_contain_text('Ключ сохранён')
        claude_settings = manual.evaluate("calls.filter(c=>c.type==='DIALOGS_SETTINGS').at(-1)")
        assert claude_settings['provider'] == 'anthropic'
        assert claude_settings['apiKey'] == 'synthetic-claude-key'
        assert manual.evaluate('dialogAI().providers.openai.keyStored') is False
        expect(manual.locator('#dialogs-api-key')).to_have_value('')
        manual.locator('#dialogs-provider').select_option('openai')
        expect(manual.locator('#dialogs-model')).to_have_value('')
        expect(manual.locator('#dialogs-key-status')).to_have_text('Ключ не сохранён.')
        manual.locator('#dialogs-model').fill('openai-other-model')
        manual.locator('#dialogs-api-key').fill('synthetic-openai-key')
        manual.locator('#dialogs-save-settings').click()
        expect(manual.locator('#dialogs-key-status')).to_contain_text('Ключ сохранён')
        manual.locator('#dialogs-clear-key').check()
        manual.locator('#dialogs-save-settings').click()
        expect(manual.locator('#dialogs-key-status')).to_have_text('Ключ не сохранён.')
        assert manual.evaluate('dialogAI().providers.anthropic.keyStored') is True
        manual.locator('#dialogs-provider').select_option('anthropic')
        expect(manual.locator('#dialogs-model')).to_have_value('claude-test-model')
        expect(manual.locator('#dialogs-key-status')).to_contain_text('Ключ сохранён')
        manual.locator('#dialogs-save-settings').click()
        expect(manual.locator('#dialogs-generate')).to_be_enabled()
        passed('Claude and OpenAI maintain separate credentials/models; switching confirms unsaved credentials and clear affects selected provider only')

        manual.locator('#dialogs-product-extract').click()
        expect(manual.locator('#dialogs-product-points')).to_have_value('Model A. Quantity: 10. Stainless steel.')
        assert manual.evaluate('permissionCalls.at(-1).origins') == ['https://api.anthropic.com/*']
        manual.locator('#dialogs-product-approve').click()
        manual.locator('#dialogs-generate').click()
        expect(manual.locator('#dialogs-draft-text')).to_have_value('Could you confirm the minimum order?')
        assert manual.evaluate('permissionCalls.at(-1).origins') == ['https://api.anthropic.com/*']
        manual.locator('#dialogs-auto-draft').click()
        expect(manual.locator('#dialogs-auto-draft')).to_be_checked()
        assert manual.evaluate('permissionCalls.at(-1).origins') == ['https://api.anthropic.com/*']
        assert manual.evaluate("permissionCalls.every(call=>call.origins.length===1&&call.origins[0]==='https://api.anthropic.com/*')")
        assert 'synthetic-claude-key' not in manual.locator('body').inner_text()
        assert 'synthetic-openai-key' not in manual.locator('body').inner_text()
        assert manual.evaluate("calls.every(c=>!/(SEND|FILL|CLICK)/.test(c.type))")
        passed('Claude extraction, reply drafts and automatic drafting request only Anthropic permission and never send supplier messages')
        manual.close()

        ui.set_viewport_size({'width':600,'height':850})
        assert ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        passed('dialogs page fits a 600px viewport')
        ui.evaluate('failGet=true;announceDialogs()')
        expect(ui.locator('#dialogs-feedback')).to_have_text('Временная ошибка чтения')
        assert not errors, errors
        assert not external, external
        assert ui.evaluate("calls.every(c=>c.type.startsWith('DIALOGS_'))")
        assert ui.evaluate("calls.every(c=>!/(SEND|FILL|CLICK)/.test(c.type))")
        passed('errors are visible; the entire UI makes no send/fill/click commands or external requests')
        browser.close()
finally:
    server.shutdown()
print(f'{checks} dialogs UI browser checks passed', flush=True)
