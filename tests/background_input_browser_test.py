"""Trusted input isolation in real hidden/minimized Chromium tabs.

Run with a graphical DISPLAY (Linux), Playwright >= 1.62 and CHROMIUM_PATH.
Unlike Playwright's normal launch, CDP no_defaults=True disables its automatic
focus emulation: visibilityState must really be hidden. All pages are local
fixtures. SEND is denied except during an explicit local-fixture phase, which
uses the production adapter and never contacts a supplier.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MESSAGE = 'Hello supplier!\nWeChat: background test'
FIXTURE_URLS = {
    '1688':'https://air.1688.com/background-fixture',
    'Alibaba':'https://onetalk.alibaba.com/message/background-fixture',
    'Made-in-China':'https://webim.made-in-china.com/super-tm/background-fixture',
}
TRANSPORT = """
let listener;
let localFixtureSend = false;
const localFixtureUrls = new Set(__LOCAL_FIXTURE_URLS__);
window.chrome={runtime:{id:'background-test',onMessage:{addListener(fn){listener=fn}},
  sendMessage:async request=>({ok:true,canSend:
    request.type==='OPENLINKS_TEST_SEND_GUARD' && localFixtureSend && localFixtureUrls.has(location.href)})}};
window.adapter=(type,extra={})=>{
  if(type==='SEND' && (!localFixtureSend || !localFixtureUrls.has(location.href)))
    throw new Error('Sending is forbidden outside the explicit local-fixture phase');
  return new Promise(resolve=>listener({type,jobId:'background-test',profile:{},...extra},
    {id:'background-test'},resolve));
};
window.sendLocalFixture=async extra=>{
  if(!localFixtureUrls.has(location.href))throw new Error('Not the intercepted local fixture');
  localFixtureSend=true;
  try{return await adapter('SEND',{...extra,expectedUrl:location.href});}
  finally{localFixtureSend=false;}
};
""".replace('__LOCAL_FIXTURE_URLS__', json.dumps(list(FIXTURE_URLS.values())))
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


def composer_fixture(platform):
    # Synthetic public editor hooks, never a captured account or conversation.
    # Exercise Alibaba's native textarea setter and MIC's rich-editor path.
    editor = '<textarea id="editor" class="send-textarea"></textarea>' if platform == 'Alibaba' else '<div id="editor" class="webtm-input" contenteditable="true"></div>'
    return """<!doctype html><meta charset="utf-8">
<style>#editor{display:block;width:400px;min-height:100px;white-space:pre-wrap;border:1px solid}</style>
<section class="send-box-container webtm-content" data-chat-root>__EDITOR__
<button class="send-tool-button webtm-send-button" disabled>Send</button><div id="history"></div></section>
<script>
const editor=document.querySelector('#editor'),send=document.querySelector('button');
window.sendClicks=0;window.model='';
window.fixtureDraft=()=>('value' in editor?editor.value:editor.innerText);
editor.addEventListener('input',()=>{model=fixtureDraft();send.disabled=!model.trim();});
send.onclick=()=>{
  sendClicks++;
  if(send.disabled)return;
  const row=document.createElement('p');row.className='outgoing';row.textContent=model;
  document.querySelector('#history').append(row);
  if('value' in editor)editor.value='';else editor.replaceChildren();
  model='';send.disabled=true;
};
</script>""".replace('__EDITOR__', editor)


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


def watch_isolation(work, personal):
    personal.evaluate("()=>{window.foregroundLosses=0;if(!window.watchingForeground){window.watchingForeground=true;window.addEventListener('blur',()=>foregroundLosses++);document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')foregroundLosses++;});}}")
    work.evaluate("()=>{window.foregroundActivations=0;if(!window.watchingVisibility){window.watchingVisibility=true;document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')foregroundActivations++;});}}")


def assert_isolation(work, personal, control, work_window, mode):
    assert work.evaluate('document.visibilityState') == 'hidden'
    assert personal.evaluate('document.visibilityState') == 'visible'
    assert personal.evaluate('document.hasFocus()')
    assert personal.locator('textarea').input_value() == 'My personal document'
    assert personal.evaluate('[document.querySelector("textarea").selectionStart,document.querySelector("textarea").selectionEnd,inputEvents]') == [3,8,0]
    assert personal.evaluate('navigator.clipboard.readText()') == 'Personal clipboard sentinel'
    # Event counters also catch a temporary focus theft that a final snapshot
    # alone would miss.
    assert personal.evaluate('foregroundLosses') == 0
    assert work.evaluate('foregroundActivations') == 0
    if mode == 'minimized work window':
        assert control.send('Browser.getWindowBounds', {'windowId':work_window})['bounds']['windowState'] == 'minimized'


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
                fixtures = {
                    FIXTURE_URLS['1688']:(ROOT/'tests/fixtures/rich-composer-1688.html').read_text(),
                    **{FIXTURE_URLS[platform]:composer_fixture(platform) for platform in ['Alibaba','Made-in-China']},
                }
                def route_fixture(route):
                    body = fixtures.get(route.request.url, '<!doctype html><textarea id="personal">My personal document</textarea>')
                    route.fulfill(body=body, content_type='text/html')
                context.route('**/*', route_fixture)
                work = context.pages[0]
                work.goto(FIXTURE_URLS['1688'])
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
                for completed_sends, mode in enumerate(['hidden tab', 'minimized work window']):
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
                    watch_isolation(work, personal)
                    prepare(work, cdp, personal)
                    assert work.locator('pre').inner_text() == MESSAGE
                    assert work.evaluate('model') == MESSAGE
                    assert work.evaluate('lastTrustedKey') == 'Backspace'
                    assert work.evaluate('sendClicks') == completed_sends
                    assert_isolation(work, personal, control, work_window, mode)
                    assert work.evaluate('attachCount===detachCount')
                    assert work.evaluate("commandLog.every(item=>item.target.tabId===71 && !/bringToFront|activateTarget/.test(item.method))")
                    print(f'PASS {mode}: trusted click/Space/Backspace preserves foreground, personal text/selection and clipboard; no send', flush=True)
                    # Only this local-fixture entry point grants the worker's
                    # test-mode guard. Exercise the real content SEND handler,
                    # including 1688's composer-consumed check and deduplication.
                    operation = {'attemptId':f'local-send-{completed_sends}', 'message':MESSAGE}
                    sent = work.evaluate('extra=>sendLocalFixture(extra)', operation)
                    assert sent == {'clicked':True, 'accepted':True}, sent
                    assert work.evaluate('sendClicks') == completed_sends + 1
                    assert work.locator('pre').inner_text() == ''
                    assert work.evaluate('model') == ''
                    assert work.locator('#history .outgoing').all_text_contents() == [MESSAGE] * (completed_sends + 1)
                    duplicate = work.evaluate('extra=>sendLocalFixture(extra)', operation)
                    assert duplicate['clicked'] is False, duplicate
                    assert work.evaluate('sendClicks') == completed_sends + 1
                    assert work.evaluate("chrome.runtime.sendMessage({type:'OPENLINKS_TEST_SEND_GUARD'})")['canSend'] is False
                    assert_isolation(work, personal, control, work_window, mode)
                    print(f'PASS {mode}: production SEND accepts one local message, clears the editor, rejects replay and preserves foreground/personal state', flush=True)
                for platform in ['Alibaba', 'Made-in-China']:
                    work.goto(FIXTURE_URLS[platform])
                    for script in ['supplier-chat.js', 'content.js']:
                        work.add_script_tag(path=str(ROOT/'extension'/script))
                    probe = work.evaluate("adapter('PROBE')")
                    assert probe['kind'] == 'chat' and probe['engine'] == 'supplier-chat-v2', probe
                    for completed_sends, mode in enumerate(['hidden tab', 'minimized work window']):
                        window_state = 'minimized' if mode == 'minimized work window' else 'normal'
                        control.send('Browser.setWindowBounds', {'windowId':work_window,'bounds':{'windowState':window_state}})
                        deadline = time.monotonic() + 3
                        while time.monotonic() < deadline and control.send('Browser.getWindowBounds', {'windowId':work_window})['bounds']['windowState'] != window_state:
                            time.sleep(.05)
                        assert control.send('Browser.getWindowBounds', {'windowId':work_window})['bounds']['windowState'] == window_state
                        personal.bring_to_front()
                        personal.evaluate("()=>{const editor=document.querySelector('textarea');editor.focus();editor.setSelectionRange(3,8);}")
                        watch_isolation(work, personal)
                        assert_isolation(work, personal, control, work_window, mode)
                        prepared = work.evaluate("message=>adapter('PREPARE',{message})", MESSAGE)
                        assert prepared['ok'], prepared
                        assert prepared['inputMethod'] == ('native-value' if platform == 'Alibaba' else 'native-insertText'), prepared
                        assert work.evaluate('fixtureDraft()') == MESSAGE
                        assert work.evaluate('model') == MESSAGE
                        assert work.evaluate('sendClicks') == completed_sends
                        assert_isolation(work, personal, control, work_window, mode)
                        operation = {'attemptId':f'local-send-{platform}-{completed_sends}', 'message':MESSAGE}
                        sent = work.evaluate('extra=>sendLocalFixture(extra)', operation)
                        assert sent == {'clicked':True}, sent
                        assert work.evaluate('sendClicks') == completed_sends + 1
                        assert work.evaluate('fixtureDraft()') == ''
                        assert work.evaluate('model') == ''
                        assert work.locator('#history .outgoing').all_text_contents() == [MESSAGE] * (completed_sends + 1)
                        duplicate = work.evaluate('extra=>sendLocalFixture(extra)', operation)
                        assert duplicate['clicked'] is False, duplicate
                        assert work.evaluate('sendClicks') == completed_sends + 1
                        assert work.evaluate("chrome.runtime.sendMessage({type:'OPENLINKS_TEST_SEND_GUARD'})")['canSend'] is False
                        assert_isolation(work, personal, control, work_window, mode)
                        print(f'PASS {platform} {mode}: production PREPARE/SEND fills and submits once, rejects replay and preserves foreground/personal state', flush=True)
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
