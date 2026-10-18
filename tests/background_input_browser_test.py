"""Trusted input isolation in real hidden/minimized Chromium tabs.

Run with a graphical DISPLAY (Linux), Playwright >= 1.62 and CHROMIUM_PATH.
Unlike Playwright's normal launch, CDP no_defaults=True disables its automatic
focus emulation: visibilityState must really be hidden. All pages are local
fixtures, all extension SEND requests are forbidden, and no supplier is contacted.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MESSAGE = 'Hello supplier!\nWeChat: background test'
TRANSPORT = """
let listener;
window.chrome={runtime:{id:'background-test',onMessage:{addListener(fn){listener=fn}},
  sendMessage:async()=>({ok:true,canSend:false})}};
window.adapter=(type,extra={})=>{
  if(type==='SEND')throw new Error('Sending is forbidden in the background test');
  return new Promise(resolve=>listener({type,jobId:'background-test',profile:{},...extra},
    {id:'background-test'},resolve));
};
"""
NATIVE = """() => {
  window.commands=[];window.commandLog=[];window.attachCount=0;window.detachCount=0;
  chrome.debugger={attach:async()=>{attachCount++},detach:async()=>{detachCount++},
    sendCommand:(target,method,params)=>new Promise(resolve=>{
      commandLog.push({target,method});commands.push({method,params,resolve});
    })};
  window.prepare=async message=>{
    const draft=await adapter('PREPARE',{message});
    if(!draft.needsNativeInput)throw new Error('Fixture did not require trusted input');
    await activate1688({platform:'1688',tabId:71,frameId:0,inputUrl:draft.pageUrl},
      (job,frame,type,extra)=>adapter(type,{message,...extra}));
    return adapter('PREPARE',{message});
  };
}"""


def wait_file(path):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if path.exists():
            return path.read_text().splitlines()[0]
        time.sleep(.05)
    raise AssertionError('Chromium did not expose its private CDP port')


def prepare(work, cdp, personal):
    work.evaluate("message=>{window.result=null;prepare(message).then(value=>result={value},error=>result={error:error.message});}", MESSAGE)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        command = work.evaluate('commands[0] && {method:commands[0].method,params:commands[0].params}')
        if command:
            reply = cdp.send(command['method'], command['params'])
            work.evaluate('reply=>commands.shift().resolve(reply)', reply)
        # These checks run during the mouse/keyboard sequence, not just after it.
        assert work.evaluate('document.visibilityState') == 'hidden'
        assert personal.evaluate('document.visibilityState') == 'visible'
        assert personal.evaluate('document.hasFocus()')
        result = work.evaluate('result')
        if result:
            assert 'error' not in result, result
            assert result['value']['ok'], result
            return
        time.sleep(.01)
    raise AssertionError('Hidden-tab native input timed out')


def main():
    if os.name != 'nt' and not os.environ.get('DISPLAY'):
        raise SystemExit('A graphical DISPLAY is required; headless focus emulation is not a valid background test.')
    with tempfile.TemporaryDirectory(prefix='openlinks-background-') as profile:
        proc = subprocess.Popen([
            os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), '--no-sandbox',
            '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
            '--user-data-dir='+profile, 'about:blank',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            port = wait_file(Path(profile)/'DevToolsActivePort')
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp('http://127.0.0.1:'+port, no_defaults=True)
                context = browser.contexts[0]
                context.add_init_script(TRANSPORT)
                def route_fixture(route):
                    body = (ROOT/'tests/fixtures/rich-composer-1688.html').read_text() if route.request.url.startswith('https://air.1688.com/') else '<!doctype html><textarea id="personal">My personal document</textarea>'
                    route.fulfill(body=body, content_type='text/html')
                context.route('**/*', route_fixture)
                work = context.pages[0]
                work.goto('https://air.1688.com/background-fixture')
                work.add_script_tag(path=str(ROOT/'extension/content.js'))
                source = (ROOT/'extension/lib/native-input.js').read_text().replace('export async function activate1688(', 'window.activate1688 = async function (')
                work.add_script_tag(content=source)
                work.evaluate(NATIVE)
                assert work.evaluate("adapter('CHAT_READY')")['waiting']
                personal = context.new_page()
                personal.goto('https://example.com/personal-fixture')
                personal.locator('textarea').click()
                personal.evaluate("()=>{document.querySelector('textarea').setSelectionRange(3,8);window.inputEvents=0;document.addEventListener('input',()=>inputEvents++);}")
                personal.bring_to_front()
                context.grant_permissions(['clipboard-read', 'clipboard-write'], origin='https://example.com')
                personal.evaluate("navigator.clipboard.writeText('Personal clipboard sentinel')")
                cdp = context.new_cdp_session(work)
                control = browser.new_browser_cdp_session()
                work_id = cdp.send('Target.getTargetInfo')['targetInfo']['targetId']
                work_window = control.send('Browser.getWindowForTarget', {'targetId':work_id})['windowId']
                time.sleep(5.2)  # Production page/editor readiness gate.
                for mode in ['hidden tab', 'minimized work window']:
                    if mode == 'minimized work window':
                        # Keep a distinct foreground window when minimizing the
                        # window that contains the supplier tab.
                        with context.expect_page() as page_info:
                            control.send('Target.createTarget', {'url':'about:blank','newWindow':True})
                        other = page_info.value
                        other.goto('https://example.com/other-window')
                        personal = other
                        personal.locator('textarea').click()
                        personal.evaluate("()=>{document.querySelector('textarea').setSelectionRange(3,8);window.inputEvents=0;document.addEventListener('input',()=>inputEvents++);}")
                        personal.bring_to_front()
                        control.send('Browser.setWindowBounds', {'windowId':work_window,'bounds':{'windowState':'minimized'}})
                        deadline = time.monotonic() + 3
                        while time.monotonic() < deadline and control.send('Browser.getWindowBounds', {'windowId':work_window})['bounds']['windowState'] != 'minimized':
                            time.sleep(.05)
                        assert control.send('Browser.getWindowBounds', {'windowId':work_window})['bounds']['windowState']=='minimized'
                        work.evaluate("()=>{let e=document.querySelector('pre');e.textContent='';window.model='';window.clickedEditor=false;document.querySelector('button').setAttribute('aria-disabled','true');}")
                    prepare(work, cdp, personal)
                    assert work.locator('pre').inner_text() == MESSAGE
                    assert work.evaluate('model') == MESSAGE
                    assert work.evaluate('lastTrustedKey') == 'Backspace'
                    assert work.evaluate('sendClicks') == 0
                    assert personal.locator('textarea').input_value() == 'My personal document'
                    assert personal.evaluate('[document.querySelector("textarea").selectionStart,document.querySelector("textarea").selectionEnd,inputEvents]') == [3,8,0]
                    assert personal.evaluate('navigator.clipboard.readText()') == 'Personal clipboard sentinel'
                    assert work.evaluate('attachCount===detachCount')
                    assert work.evaluate("commandLog.every(item=>item.target.tabId===71 && !/bringToFront|activateTarget/.test(item.method))")
                    print(f'PASS {mode}: trusted click/Space/Backspace preserves foreground, personal text/selection and clipboard; no send', flush=True)
                cdp.detach()
                browser.close()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


if __name__ == '__main__':
    main()
