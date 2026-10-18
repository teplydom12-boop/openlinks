"""Exercise the shared joint-mode controller against both production page layouts.

Only a local server and synthetic Chrome transport are used. No suppliers or Claude.
"""
import functools
import http.server
import os
from pathlib import Path
import re
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
checks = 0

def passed(name):
    global checks
    checks += 1
    print('PASS ' + name, flush=True)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

HARNESS = r"""
(() => {
  const listeners=[];
  let joint={enabled:false,phase:'independent',allowDialogs:true,detail:'Раздельная работа',nextAt:null,pending:3,quotaPlatforms:[]};
  window.calls=[];window.failJointGet=false;window.failJointStart='';window.deferJointStart=false;window.unsaved=false;window.afterJointChanges=0;
  const announce=()=>listeners.forEach(listener=>listener({openlinksWorkCoordinator:{newValue:{enabled:joint.enabled}}},'local'));
  window.changeJoint=patch=>{Object.assign(joint,patch);announce();};
  window.chrome={storage:{onChanged:{addListener:fn=>listeners.push(fn)}},runtime:{sendMessage:async request=>{
    calls.push(structuredClone(request));
    if(request.type==='DIALOGS_JOINT_GET'&&failJointGet)return {ok:false,error:'Связь с расширением потеряна.'};
    if(request.type==='DIALOGS_JOINT_START'){
      if(failJointStart)return {ok:false,error:failJointStart};
      if(deferJointStart)await new Promise(resolve=>window.resolveJointStart=resolve);
      Object.assign(joint,{enabled:true,phase:'outreach',allowDialogs:false,detail:'Обрабатываю первичные обращения.'});
    }
    if(request.type==='DIALOGS_JOINT_PAUSE')Object.assign(joint,{enabled:false,phase:'independent',detail:'Оба блока остановлены.'});
    return {ok:true,joint:structuredClone(joint)};
  }}};
})();
"""

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True)
        context=browser.new_context(viewport={'width':1440,'height':1050},timezone_id='Asia/Irkutsk')
        errors=[]
        for page_name in ['dashboard','dialogs']:
            page=context.new_page()
            page.on('pageerror',lambda error:errors.append(str(error)))
            html=(ROOT/'extension'/f'{page_name}.html').read_text()
            html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
            page.route('**/extension/'+page_name+'.html',lambda route,request,body=html:route.fulfill(body=body,content_type='text/html'))
            page.add_init_script(HARNESS)
            page.goto(base+'/extension/'+page_name+'.html')
            page.evaluate("""async()=>{const {setupJointModeUI}=await import('./joint-mode-ui.js');window.jointUI=setupJointModeUI({beforeStart:async()=>{if(unsaved)throw new Error('Сохраните изменения.');},afterChange:async()=>{afterJointChanges++;}});} """)
            expect(page.locator('#joint-mode-status')).to_have_text('Раздельная работа')
            expect(page.locator('#joint-mode-start')).to_be_enabled()
            expect(page.locator('#joint-mode-pause')).to_be_disabled()
            expect(page.locator('#joint-mode-note')).to_contain_text('только после ответа продавца')
            assert page.evaluate("calls.every(c=>c.type==='DIALOGS_JOINT_GET')")
            expect(page.locator('#start' if page_name=='dashboard' else '#dialogs-start')).to_have_count(1)
            passed(page_name+': shared panel reads status without starting work and keeps separate controls')

            page.evaluate("changeJoint({testMode:true,phase:'test_paused',detail:'Тест без отправки: совместный запуск недоступен.'})")
            expect(page.locator('#joint-mode-status')).to_have_text('Тестовый режим')
            expect(page.locator('#joint-mode-start')).to_be_disabled()
            page.locator('#joint-mode-start').dispatch_event('click')
            expect(page.locator('#joint-mode-feedback')).to_contain_text('Сейчас тест включён')
            assert not page.evaluate("calls.some(c=>c.type==='DIALOGS_JOINT_START')")
            page.evaluate("changeJoint({testMode:false,phase:'independent',detail:'Раздельная работа'})")
            expect(page.locator('#joint-mode-start')).to_be_enabled()
            passed(page_name+': persisted test mode blocks shared launch even under a forced click')

            page.evaluate('window.unsaved=true')
            page.locator('#joint-mode-start').click()
            expect(page.locator('#joint-mode-feedback')).to_have_text('Сохраните изменения.')
            assert not page.evaluate("calls.some(c=>c.type==='DIALOGS_JOINT_START')")
            page.evaluate("window.unsaved=false;window.failJointStart='Сейчас включён тест без отправки. Для совместного запуска нужен рабочий режим.'")
            page.locator('#joint-mode-start').click()
            expect(page.locator('#joint-mode-feedback')).to_contain_text('тест без отправки')
            expect(page.locator('#joint-mode-status')).to_have_text('Раздельная работа')
            assert not page.evaluate("calls.some(c=>/SETTINGS|SEND_DRAFT|FOLDER/.test(c.type))")
            passed(page_name+': unsaved work and backend test-mode rejection never change sending preferences')

            page.evaluate("window.failJointStart='';window.deferJointStart=true;window.calls=[]")
            page.locator('#joint-mode-start').click()
            page.wait_for_function('typeof resolveJointStart===\'function\'')
            expect(page.locator('#joint-mode-start')).to_be_disabled()
            page.locator('#joint-mode-start').dispatch_event('click')
            assert page.evaluate("calls.filter(c=>c.type==='DIALOGS_JOINT_START').length")==1
            page.evaluate('resolveJointStart()')
            expect(page.locator('#joint-mode-status')).to_have_text('Первичные обращения')
            expect(page.locator('#joint-mode-pause')).to_be_enabled()
            assert page.evaluate('afterJointChanges')==1
            passed(page_name+': shared start is single-flight and reports primary-queue priority')

            page.evaluate("changeJoint({phase:'dialogs_quota_wait',allowDialogs:true,nextAt:Date.UTC(2026,9,18,12),detail:'Очередь ждёт квоты; доступны диалоги.'})")
            expect(page.locator('#joint-mode-status')).to_have_text('Диалоги · ожидание квот')
            expect(page.locator('#joint-mode-next')).to_contain_text('20:00')
            expect(page.locator('#joint-mode-detail')).to_contain_text('доступны диалоги')
            page.evaluate("changeJoint({phase:'outreach',allowDialogs:false,nextAt:null,detail:'Квота восстановлена, продолжаю очередь.'})")
            expect(page.locator('#joint-mode-status')).to_have_text('Первичные обращения')
            expect(page.locator('#joint-mode-next')).to_be_hidden()
            page.evaluate("changeJoint({phase:'dialogs_queue_complete',allowDialogs:true,detail:'Очередь завершена, работают диалоги.'})")
            expect(page.locator('#joint-mode-status')).to_have_text('Диалоги · очередь завершена')
            page.evaluate("changeJoint({phase:'needs_attention',allowDialogs:false,detail:'Проверьте текущего поставщика.'})")
            expect(page.locator('#joint-mode-status')).to_have_text('Нужно вмешательство')
            passed(page_name+': cross-window phase changes, local-time wake-up and attention reasons stay visible')

            page.locator('#joint-mode-pause').click()
            expect(page.locator('#joint-mode-status')).to_have_text('Раздельная работа')
            expect(page.locator('#joint-mode-feedback')).to_have_text('Оба блока остановлены.')
            expect(page.locator('#joint-mode-start')).to_be_enabled()
            assert page.evaluate("calls.filter(c=>c.type==='DIALOGS_JOINT_PAUSE')")==[{'type':'DIALOGS_JOINT_PAUSE'}]
            page.evaluate('window.failJointGet=true;jointUI.refresh()')
            expect(page.locator('#joint-mode-status')).to_have_text('Статус недоступен')
            expect(page.locator('#joint-mode-start')).to_be_disabled()
            expect(page.locator('#joint-mode-feedback')).to_contain_text('Связь с расширением потеряна')
            passed(page_name+': pause addresses both blocks and unknown state prevents a new shared start')

            page.set_viewport_size({'width':600,'height':850})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            passed(page_name+': shared controls fit a 600-pixel window')
            page.close()
        assert not errors,errors
        browser.close()
finally:
    server.shutdown()
print(f'{checks} joint-mode UI checks passed.')
