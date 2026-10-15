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
        supplier.add_init_script("""
          let listener;
          window.chrome={runtime:{id:'adapter-test',onMessage:{addListener(fn){listener=fn}},sendMessage:async()=>({ok:true})}};
          window.adapter=(type,extra={})=>new Promise(resolve=>listener({type,jobId:'test-job',profile:{},message:'Hello, WeChat: demo',...extra},{id:'adapter-test'},resolve));
        """)
        supplier.goto('https://test.en.alibaba.com/')
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        result = supplier.evaluate("adapter('PROBE')")
        assert result['kind']=='contact' and result['href']=='https://test.en.alibaba.com/chat'
        passed('semantic contact discovery')
        supplier.goto('https://test.en.alibaba.com/chat')
        supplier.add_script_tag(path=str(ROOT/'extension/content.js'))
        assert supplier.evaluate("adapter('PROBE')")['kind']=='chat'
        result = supplier.evaluate("adapter('PREPARE')")
        assert result['ok']
        expect(supplier.locator('#message')).to_have_value('Hello, WeChat: demo')
        passed('preparation fills React-style native input and enables initially disabled Send')
        assert not supplier.evaluate("adapter('CHECK_SENT', {evidence:{successes:[],outgoing:0}})")['confirmed']
        assert supplier.evaluate("adapter('SEND', {expectedUrl:location.href})")['clicked']
        assert supplier.evaluate("adapter('CHECK_SENT', {evidence:{successes:[],outgoing:0}})")['confirmed']
        assert supplier.evaluate('clicks')==1
        assert not supplier.evaluate("adapter('SEND', {expectedUrl:location.href})")['clicked']
        passed('single send, new success evidence, and duplicate-click prevention')
        assert not supplier.evaluate("adapter('CHECK_SENT', {evidence:{successes:['Message sent'],outgoing:1}})")['confirmed']
        passed('old success banner cannot confirm a new attempt')
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
        assert not errors, errors
        passed('no browser JavaScript errors')
        browser.close()
finally:
    server.shutdown()
print(f'{checks} browser checks passed. All contacts used local fixtures; no seller was contacted.')
