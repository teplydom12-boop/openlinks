"""Real Chromium DOM/UI tests with local fixtures. No supplier requests or messages.

The cloud Chromium policy blocks unpacked extensions, so the content script's
message transport and dashboard's Chrome API are replaced by explicit test doubles.
The actual core, content script, dashboard and file writer run unmodified.
"""
import functools
import http.server
import os
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / 'test-results'
RESULTS.mkdir(exist_ok=True)
checks = 0

def passed(name):
    global checks
    checks += 1
    print(f'PASS {name}', flush=True)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

handler = functools.partial(QuietHandler, directory=str(ROOT))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1050})
        errors = []
        context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
        ui = context.new_page()
        def dashboard_route(route):
            html = (ROOT/'extension/dashboard.html').read_text()
            html = html.replace('<script src="dashboard.js" type="module">', '<script src="/tests/ui-harness.js" type="module"></script><script src="dashboard.js" type="module">')
            route.fulfill(body=html, content_type='text/html')
        context.route('**/extension/dashboard.html', dashboard_route)
        ui.goto(BASE+'/extension/dashboard.html')
        expect(ui.locator('#queue-count')).to_have_text('0')
        ui.get_by_role('button', name='Сообщение и настройки').click()
        ui.locator('#message').fill('Hello! Please contact me on WeChat: demo-buyer')
        ui.get_by_role('button', name='Сохранить настройки').click()
        expect(ui.locator('#toast')).to_have_text('Настройки сохранены')
        ui.get_by_role('button', name='Очередь поставщиков').click()
        ui.locator('#examples').click()
        ui.wait_for_function("document.querySelector('#supplier-input').value.includes('yiyueda')")
        ui.locator('#add').click()
        expect(ui.locator('#queue-count')).to_have_text('12')
        expect(ui.locator('#queue-body tr')).to_have_count(12)
        passed('dashboard saves message and imports the 12 supplied stores')
        ui.locator('#supplier-input').fill('https://jcnyjxsb.en.alibaba.com/')
        ui.locator('#add').click()
        expect(ui.locator('#import-result')).to_contain_text('уже есть')
        expect(ui.locator('#queue-count')).to_have_text('12')
        passed('duplicate import is rejected by the UI')
        ui.locator('#start').click()
        expect(ui.locator('#run-state')).to_have_text('Очередь работает')
        ui.locator('#pause').click()
        expect(ui.locator('#run-state')).to_have_text('На паузе')
        passed('start and pause update dashboard state')
        ui.locator('#connect-folder').click()
        expect(ui.locator('#folder-status')).to_contain_text('сохранено')
        file_data = ui.evaluate("""async()=>{
          const directory=await navigator.storage.getDirectory();
          const read=async name=>await (await (await directory.getFileHandle(name)).getFile()).text();
          return {schedule:await read('schedule.txt'),report:await read('report.txt'),log:await read('activity.log')};
        }""")
        assert 'jcnyjxsb.en.alibaba.com' in file_data['schedule']
        assert 'Browser UI test' in file_data['report']
        assert 'Импорт' in file_data['log']
        passed('auto-write creates schedule.txt, report.txt and activity.log using File System Access')
        protection=ui.evaluate("""async()=>{
          const {writeLog,activityText}= {...await import('/extension/lib/files.js'),...await import('/extension/lib/core.js')};
          const folder=await navigator.storage.getDirectory();
          const handle=await folder.getFileHandle('activity.log');
          const writer=await handle.createWritable();await writer.write('My unrelated log');await writer.close();
          let rejected=false;try{await writeLog(folder,'# OpenLinks — activity.log\\nnew log');}catch{rejected=true;}
          const preserved=await (await handle.getFile()).text();
          await writeLog(folder,'# OpenLinks — activity.log\\nRestored browser test log',true);
          return {rejected,preserved};
        }""")
        assert protection=={'rejected':True,'preserved':'My unrelated log'}
        passed('new activity.log cannot silently overwrite an unrelated existing file')
        with ui.expect_download() as download:
            ui.locator('#export-schedule').click()
        assert download.value.suggested_filename == 'schedule.txt'
        passed('manual TXT download')
        ui.locator('#show-log').click()
        ui.locator('#log-filter').fill('неизвестное-событие')
        expect(ui.locator('#report-body tr')).to_have_count(0)
        ui.locator('#log-filter').fill('импорт')
        expect(ui.locator('#report-body tr')).to_have_count(2)
        with ui.expect_download() as log_download:
            ui.locator('#log-download').click()
        assert log_download.value.suggested_filename=='activity.log'
        ui.get_by_role('button', name='Очередь поставщиков').click()
        passed('detailed live log has search and downloadable activity.log')
        ui.screenshot(path=str(RESULTS/'dashboard.png'), full_page=True)
        ui.set_viewport_size({'width': 600, 'height': 850})
        assert ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        passed('responsive layout at 600px')
        ui.set_viewport_size({'width':1440,'height':1050})

        context.route('https://test.en.alibaba.com/**', lambda route: route.fulfill(
            body=(ROOT/'tests/fixtures'/('chat.html' if '/chat' in route.request.url else 'store.html')).read_text(), content_type='text/html'))
        supplier = context.new_page()
        adapter_transport="""
          let listener;
          window.lessonMessages=[];
          window.chrome={runtime:{id:'adapter-test',onMessage:{addListener(fn){listener=fn}},sendMessage:async message=>{if(message.type==='LEARN_PICK')lessonMessages.push(message);return {ok:true};}}};
          window.adapter=(type,extra={})=>new Promise(resolve=>listener({type,jobId:'test-job',profile:{},message:'Hello, WeChat: demo',...extra},{id:'adapter-test'},resolve));
        """
        supplier.add_init_script(adapter_transport)
        supplier.goto('https://test.en.alibaba.com/')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        result = supplier.evaluate("adapter('PROBE')")
        assert result['kind']=='contact' and result['href']=='https://test.en.alibaba.com/chat'
        passed('semantic contact discovery')
        supplier.goto('https://test.en.alibaba.com/chat')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        assert supplier.evaluate("adapter('PROBE')")['kind']=='chat'
        result = supplier.evaluate("adapter('PREPARE')")
        assert result['ok']
        expect(supplier.locator('#message')).to_have_value('Hello, WeChat: demo')
        passed('preparation fills React-style native input and enables initially disabled Send')
        assert supplier.evaluate("adapter('SEND', {expectedUrl:location.href})")['clicked']
        assert supplier.evaluate('clicks')==1
        assert not supplier.evaluate("adapter('SEND', {expectedUrl:location.href})")['clicked']
        passed('single send without result checks and duplicate-click prevention')
        supplier.evaluate("document.querySelector('#message').value='My existing draft'")
        assert not supplier.evaluate("adapter('PREPARE')")['ok']
        expect(supplier.locator('#message')).to_have_value('My existing draft')
        passed('existing unrelated draft is preserved')
        supplier.evaluate("document.body.insertAdjacentHTML('beforeend','<div id=fixture-captcha style=width:200px;height:60px>Check</div>')")
        assert 'CAPTCHA' in supplier.evaluate("adapter('PROBE')")['obstacle']
        assert not supplier.evaluate("adapter('SEND', {jobId:'another',expectedUrl:location.href})")['clicked']
        passed('visible CAPTCHA blocks preparation and sending')
        supplier.evaluate("document.querySelector('#fixture-captcha').remove();document.querySelector('#chat-panel').insertAdjacentHTML('beforeend','<textarea id=second></textarea>')")
        assert supplier.evaluate("adapter('PROBE')")['kind']=='ambiguous'
        passed('ambiguous editors stop automation')
        assert supplier.evaluate("adapter('PROBE',{profile:{editor:'['}})")['kind']=='ambiguous'
        passed('invalid CSS selector fails closed')
        supplier.evaluate("document.querySelector('#second').remove();document.querySelector('#message').value='';document.querySelector('form').insertAdjacentHTML('afterbegin','<input required type=email id=email>')")
        assert 'запрос' in supplier.evaluate("adapter('PREPARE')")['reason']
        passed('inquiry-like form with additional email field is rejected')
        supplier.evaluate("document.body.innerHTML='<form id=sendInquiry><textarea id=message></textarea><button id=send>Send inquiry</button></form>'")
        assert supplier.evaluate("adapter('PROBE')")['kind']=='inquiry'
        assert not supplier.evaluate("adapter('PREPARE')")['ok']
        expect(supplier.locator('#message')).to_have_value('')
        assert not supplier.evaluate("adapter('SEND',{jobId:'forbidden',expectedUrl:location.href,profile:{chat:'body',editor:'#message',send:'#send'}})")['clicked']
        passed('inquiry is neither filled nor sent, even with explicit selectors')
        supplier.evaluate("document.body.innerHTML='<a href=/sendInquiry id=contact>Send inquiry</a>'")
        assert not supplier.evaluate("adapter('CONTACT',{profile:{contact:'#contact'}})")['ok']
        passed('explicit contact selector cannot click Send inquiry')
        supplier.evaluate("document.body.innerHTML='<textarea id=message></textarea><button id=send>Send</button>'")
        assert supplier.evaluate("adapter('PROBE')")['kind']!='chat'
        assert not supplier.evaluate("adapter('PREPARE')")['ok']
        passed('generic textarea and Send without conversation context are not a chat')

        captures={
            'https://test.en.made-in-china.com/captured': 'captured-mic-store.html',
            'https://test.en.alibaba.com/captured': 'captured-alibaba.html',
            'https://test.1688.com/captured': 'captured-1688-store.html',
            'https://air.1688.com/captured-shell': 'captured-1688-shell.html',
        }
        # Every iframe/resource request is intercepted locally. No vendor request
        # or challenge is fetched, even though the fixtures preserve frame URLs.
        def capture_route(route):
            filename=captures.get(route.request.url)
            if filename:
                route.fulfill(body=(ROOT/'tests/fixtures'/filename).read_text(),content_type='text/html')
            else:
                route.fulfill(body='<!doctype html><title>Empty frame fixture</title>',content_type='text/html')
        context.route('**/*',capture_route)
        supplier.goto('https://test.en.made-in-china.com/captured')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        result=supplier.evaluate("adapter('PROBE')")
        assert result['kind']=='contact' and result['diagnostics']['adapter']=='mic'
        assert supplier.evaluate("adapter('CONTACT')")['ok']
        assert supplier.evaluate('headerClicks')==1 and supplier.evaluate('otherClicks')==0
        expect(supplier.locator('#inquiryContent')).to_have_value('')
        assert supplier.evaluate('inquiryClicks')==0
        passed('captured MIC structure: selects storefront chat and ignores repeated actions, stubs and inquiry')
        supplier.evaluate("document.querySelector('#inqueryForm').removeAttribute('action')")
        assert not supplier.evaluate("adapter('PREPARE',{profile:{chat:'body',editor:'#inquiryContent',send:'#inquirySend'}})")['ok']
        expect(supplier.locator('#inquiryContent')).to_have_value('')
        passed('MIC inqueryForm and inquiry markers stay blocked even when action URL is absent')
        supplier.evaluate("document.querySelector('.shop-sign__btns-wrap').insertAdjacentHTML('beforeend','<a class=J-open-tm href=javascript:;>Chat Now</a>')")
        assert supplier.evaluate("adapter('PROBE')")['kind']=='ambiguous'
        passed('competing header chat targets are still rejected rather than arbitrarily deduplicated')

        supplier.goto('https://test.en.alibaba.com/captured')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        assert supplier.evaluate("adapter('PROBE')")['kind']=='chat'
        assert supplier.evaluate("adapter('PREPARE')")['ok']
        expect(supplier.locator('textarea.send-textarea')).to_have_value('Hello, WeChat: demo')
        assert supplier.evaluate("adapter('SEND',{expectedUrl:location.href})")['clicked']
        assert supplier.evaluate('sendClicks')==1
        assert supplier.locator('.send-tool-button').evaluate("node=>node.classList.contains('gray')")
        passed('Alibaba gray button without disabled remains clickable')
        supplier.evaluate("document.querySelector('textarea.send-textarea').value='';document.querySelector('.send-tool-button').disabled=true")
        assert not supplier.evaluate("adapter('PREPARE')")['ok']
        supplier.evaluate("document.querySelector('.send-tool-button').disabled=false;document.querySelector('.send-tool-button').setAttribute('aria-disabled','true')")
        assert not supplier.evaluate("adapter('PREPARE')")['ok']
        passed('native disabled and aria-disabled still prevent Alibaba sending')
        supplier.evaluate("document.querySelector('.send-box-container').remove()")
        assert supplier.evaluate("adapter('PROBE')")['kind']=='contact'
        assert supplier.evaluate("adapter('CONTACT')")['ok']
        assert supplier.evaluate('headerClicks')==1 and supplier.evaluate('toolbarClicks')==0
        supplier.evaluate("document.querySelector('.shop-sign-container').remove()")
        assert supplier.evaluate("adapter('CONTACT')")['ok']
        assert supplier.evaluate('toolbarClicks')==1
        passed('captured Alibaba contacts: Russian storefront action first, Chat Now! toolbar fallback')

        supplier.goto('https://test.1688.com/captured')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        assert 'CAPTCHA' in supplier.evaluate("adapter('PROBE')")['obstacle']
        assert not supplier.evaluate("adapter('CONTACT')")['ok']
        assert supplier.evaluate('contactClicks')==0
        initial_overlay=supplier.evaluate("adapter('PROBE')")
        assert initial_overlay['canDismiss']
        supplier.evaluate("window.savedModal=document.querySelector('.J_MIDDLEWARE_FRAME_WIDGET')")
        assert supplier.evaluate("key=>adapter('DISMISS_CHALLENGE',{dismissKey:key})",initial_overlay['dismissKey'])['closed']
        assert supplier.evaluate("adapter('CONTACT')")['ok']
        assert supplier.evaluate('contactClicks')==1
        passed('1688 native close control dismisses the known overlay before customer-service click')
        for appearance in range(3):
            supplier.evaluate('document.body.append(savedModal)')
            repeated=supplier.evaluate("adapter('PROBE')")
            assert repeated['canDismiss'] and repeated['dismissKey']!=initial_overlay['dismissKey']
            assert not supplier.evaluate("key=>adapter('DISMISS_CHALLENGE',{dismissKey:key})",initial_overlay['dismissKey'])['clicked']
            assert supplier.evaluate("key=>adapter('DISMISS_CHALLENGE',{dismissKey:key})",repeated['dismissKey'])['closed']
            assert not supplier.evaluate("adapter('PROBE')").get('obstacle')
        passed('reused 1688 modal closes on every reappearance and rejects stale close commands')
        supplier.evaluate("document.body.innerHTML='<div id=application><div class=service-entry><span>客服</span></div></div>';window.serviceClicks=0;document.querySelector('.service-entry').addEventListener('click',()=>serviceClicks++)")
        assert supplier.evaluate("adapter('CONTACT')")['ok']
        assert supplier.evaluate('serviceClicks')==1
        passed('1688 customer-service text works without a specific id and preserves event bubbling')

        supplier.goto('https://air.1688.com/captured-shell')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        result=supplier.evaluate("adapter('PROBE')")
        assert result['kind']=='waiting' and result['diagnostics']['chatFrames']==1
        assert not supplier.evaluate("adapter('PREPARE')")['ok']
        passed('captured 1688 shell: waits for real iframe editor and ignores feedback textarea')

        supplier.goto('https://test.en.alibaba.com/captured')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        supplier.evaluate("""document.body.innerHTML='<div class=dm-compose><textarea class=dm-draft></textarea><button class=dm-submit><span>Deliver</span></button></div><button class=vendor-contact>Talk to our team</button>';window.unknownClicks=0;window.earlyPointerDown=0;document.querySelector('.dm-submit').addEventListener('pointerdown',()=>earlyPointerDown++);document.querySelector('.dm-submit').addEventListener('click',()=>unknownClicks++);document.querySelector('.dm-draft').value='Private draft must not be recorded';""")
        assert supplier.evaluate("adapter('PICK_START',{field:'editor',token:'editor-lesson'})")['ok']
        supplier.locator('textarea.dm-draft').click()
        supplier.wait_for_function('lessonMessages.length===1')
        editor_pick=supplier.evaluate('lessonMessages[0]')
        assert editor_pick['field']=='editor' and 'Private draft' not in str(editor_pick)
        supplier.evaluate("window.lessonRules=[OpenLinksRules.makeRule(lessonMessages[0],location.href,'alibaba')]")
        assert supplier.evaluate("adapter('PICK_START',{field:'send',token:'send-lesson',profile:{rules:lessonRules}})")['ok']
        supplier.locator('button.dm-submit span').click()
        supplier.wait_for_function('lessonMessages.length===2')
        send_pick=supplier.evaluate('lessonMessages[1]')
        assert send_pick['field']=='send' and send_pick['chatSelector']
        assert supplier.evaluate('unknownClicks')==0
        assert supplier.evaluate('earlyPointerDown')==0
        passed('trusted teaching click records editor/send and inferred chat root before any native send')
        supplier.evaluate("""const p=lessonMessages[1];lessonRules.push(OpenLinksRules.makeRule(p,location.href,'alibaba'),OpenLinksRules.makeRule({field:'chat',selector:p.chatSelector},location.href,'alibaba'));document.querySelector('.dm-draft').value='';""")
        assert supplier.evaluate("adapter('PREPARE',{profile:{rules:lessonRules}})")['ok']
        assert supplier.evaluate("adapter('SEND',{jobId:'learned-send',expectedUrl:location.href,profile:{rules:lessonRules}})")['clicked']
        assert supplier.evaluate('unknownClicks')==1
        passed('learned nonstandard composer is filled and clicked exactly once on replay')
        assert supplier.evaluate("adapter('PICK_START',{field:'contact',token:'cancel-lesson'})")['ok']
        supplier.locator('[data-openlinks-picker] button').click()
        assert supplier.evaluate("document.querySelector('[data-openlinks-picker]')===null")
        assert supplier.evaluate('lessonMessages.length')==2
        passed('cancel teaching removes the overlay and records no unrelated click')
        persisted_rules=supplier.evaluate('JSON.stringify(lessonRules)')
        fresh=browser.new_context()
        fresh.on('page',lambda page:page.on('pageerror',lambda error:errors.append(str(error))))
        # A new browser context has no picker or page globals from the lesson.
        # Restore serialized rules to a different supplier and changed root layout.
        fresh.route('**/*',lambda route:route.fulfill(body='<div class=new-wrapper><section><textarea class=dm-draft></textarea></section><button class=dm-submit>Deliver</button></div><script>window.replayed=0;document.querySelector("button").onclick=()=>replayed++;</script>',content_type='text/html'))
        restored=fresh.new_page()
        restored.add_init_script(adapter_transport)
        restored.goto('https://second.en.alibaba.com/')
        restored.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        restored.add_script_tag(path=str(ROOT/'extension/content.js'))
        restored.evaluate("rules=>{window.restoredRules=JSON.parse(rules);restoredRules.push(OpenLinksRules.makeRule({field:'send',selector:'.missing-template'},location.href,'alibaba'));}",persisted_rules)
        replay=restored.evaluate("adapter('PROBE',{profile:{rules:restoredRules}})")
        assert replay['kind']=='chat' and replay['diagnostics']['learning']['derivedRoot']
        assert any('.missing-template' in reason for reason in replay['diagnostics']['learning']['rejected'])
        assert restored.evaluate("adapter('PREPARE',{profile:{rules:restoredRules}})")['ok']
        assert restored.evaluate("adapter('SEND',{expectedUrl:location.href,profile:{rules:restoredRules}})")['clicked']
        assert restored.evaluate('replayed')==1
        passed('serialized lessons work in a fresh context on another Alibaba shop with changed chat wrapper and alternative templates')
        fresh.close()
        supplier.goto('https://first-named.1688.com/')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        supplier.evaluate("document.body.innerHTML='<button class=vendor-contact>Talk to our team</button>'")
        assert supplier.evaluate("adapter('PICK_START',{field:'contact',token:'named-shop'})")['ok']
        supplier.locator('.vendor-contact').click()
        supplier.wait_for_function('lessonMessages.length===1')
        named_rule=supplier.evaluate("JSON.stringify(OpenLinksRules.makeRule(lessonMessages[0],location.href,'1688'))")
        supplier.goto('https://second-named.1688.com/')
        supplier.add_script_tag(path=str(ROOT/'extension/rules-shared.js'))
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        supplier.evaluate("rule=>{window.namedRule=JSON.parse(rule);document.body.innerHTML='<button class=vendor-contact>Talk to our team</button>';window.namedClicks=0;document.querySelector('button').onclick=()=>namedClicks++;}",named_rule)
        result=supplier.evaluate("adapter('PROBE',{profile:{rules:[namedRule]}})")
        assert result['kind']=='contact' and result['diagnostics']['learning']['applied']
        assert supplier.evaluate("adapter('CONTACT',{profile:{rules:[namedRule]}})")['ok']
        assert supplier.evaluate('namedClicks')==1
        passed('trusted 1688 contact lesson transfers between different named subdomains after page reload')
        assert not errors, errors
        passed('no browser JavaScript errors')
        browser.close()
finally:
    server.shutdown()
print(f'{checks} browser checks passed. All contacts used local fixtures; no seller was contacted.')
