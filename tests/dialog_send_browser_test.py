"""Guarded replies on synthetic pages only; no live sellers or network calls."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = (ROOT / 'tests/fixtures/dialogs-synthetic.html').read_text().replace('Untouched buyer draft', '')
TRANSPORT = """
window.testListeners=[];
window.chrome={runtime:{id:'reply-test',onMessage:{addListener(fn){testListeners.push(fn)}},sendMessage:async()=>({ok:true})}};
window.command=(type,extra={})=>new Promise(resolve=>{
  const message={type,profile:{},message:'We need 100 units.',jobId:'reply-operation',...extra};
  for(const listener of testListeners)listener(message,{id:'reply-test'},resolve);
});
"""
checks = 0
def passed(name):
    global checks
    checks += 1
    print('PASS ' + name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True)
    context = browser.new_context(viewport={'width':1280,'height':1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(TRANSPORT)
    context.route('**/*', lambda route: route.fulfill(body=FIXTURE, content_type='text/html'))
    def load(platform='alibaba'):
        page.goto({'alibaba':'https://message.alibaba.com/message/messenger.htm','1688':'https://air.1688.com/chat','mic':'https://webim.made-in-china.com/super-tm/'}[platform])
        if platform == '1688':
            page.evaluate("document.querySelector('textarea').outerHTML='<pre contenteditable=true class=edit style=height:70px;width:350px;border:1px solid></pre>'")
        for script in ['rules-shared.js', 'routes-1688-shared.js', 'supplier-chat.js', 'content.js', 'dialogs-content.js']:
            page.add_script_tag(path=str(ROOT/'extension'/script))
        page.evaluate("()=>{window.syntheticClicks=0; document.querySelector('#send').onclick=()=>{syntheticClicks++;const pre=document.querySelector('pre.edit');if(pre)pre.textContent='';};}")
        page.evaluate("""()=>{
          const snapshot=OpenLinksDialogsReader.snapshot(),row=snapshot.conversations.find(item=>item.active);
          window.guard={platform:snapshot.platform,id:row.id,documentToken:snapshot.documentToken,sourceUrl:snapshot.url,replyFingerprint:row.replyFingerprint,operation:'reply-operation'};
        }""")
    def prepare():
        return page.evaluate("command('PREPARE',{dialogGuard:guard})")
    def send():
        return page.evaluate("command('SEND',{dialogGuard:guard,expectedUrl:location.href,attemptId:guard.operation})")

    load()
    assert page.evaluate('OpenLinksDialogsReader.guardReply(guard).ok')
    assert prepare()['ok']
    result=send(); assert result['clicked'] and page.evaluate('syntheticClicks') == 1, (result,page.evaluate('syntheticClicks'))
    assert send()['clicked'] is False and page.evaluate('syntheticClicks') == 1
    passed('exact guarded reply fills once, clicks once and rejects a duplicate attempt')

    for draft in ['A human draft', '   ']:
        load()
        page.evaluate('(value)=>document.querySelector("textarea").value=value', draft)
        assert not prepare()['ok']
        assert page.locator('textarea').input_value() == draft
        assert page.evaluate('syntheticClicks') == 0
    passed('manual drafts including whitespace are never overwritten')

    load()
    page.evaluate("document.querySelector('textarea').value='Legacy draft'")
    assert page.evaluate("command('PREPARE')")['ok']
    assert page.locator('textarea').input_value() == 'We need 100 units.'
    passed('existing outreach draft replacement behavior stays unchanged')

    load()
    page.evaluate("document.querySelector('[data-message-history]').insertAdjacentHTML('beforeend','<div class=message-item data-direction=inbound data-message-id=new><span data-message-text>Changed quantity</span></div>')")
    assert not prepare()['ok'] and page.locator('textarea').input_value() == ''
    passed('a changed incoming message invalidates the reply token before insertion')

    load()
    assert prepare()['ok']
    page.evaluate("document.querySelector('[data-chat-root]').setAttribute('data-thread-id','different-supplier')")
    assert send()['clicked'] is False and page.evaluate('syntheticClicks') == 0
    passed('changing the selected recipient after preparation blocks the click')

    load()
    assert prepare()['ok']
    page.evaluate("document.querySelector('[data-message-text]').textContent='Changed previous history'")
    assert send()['clicked'] is False and page.evaluate('syntheticClicks') == 0
    passed('the final content-side guard catches history changes after the worker check')

    load()
    page.evaluate("document.querySelector('textarea').addEventListener('input',()=>{if(document.querySelector('textarea').value)document.querySelector('[data-message-text]').textContent='History changed during input';})")
    assert not prepare()['ok'] and page.evaluate('syntheticClicks') == 0
    passed('history changes during asynchronous preparation cancel the operation')

    load()
    assert prepare()['ok']
    page.evaluate("document.querySelector('textarea').value='My edited reply'")
    assert not prepare()['ok'] and send()['clicked'] is False
    assert page.locator('textarea').input_value() == 'My edited reply'
    passed('manual changes to an owned draft are preserved and prevent sending')

    load()
    assert prepare()['ok']
    page.evaluate("document.querySelector('textarea').value+=' '")
    assert send()['clicked'] is False and page.evaluate('syntheticClicks') == 0
    assert page.locator('textarea').input_value() == 'We need 100 units. '
    passed('even a manual trailing space is preserved and invalidates the final reply text')

    load()
    page.evaluate("document.querySelector('[data-chat-root]').insertAdjacentHTML('beforeend','<input type=file hidden id=pending-file>')")
    page.locator('#pending-file').set_input_files({'name':'manual.txt','mimeType':'text/plain','buffer':b'Manual attachment'})
    assert not prepare()['ok'] and page.locator('textarea').input_value() == ''
    passed('queued hidden file inputs cannot hitchhike on an automatic text reply')

    load()
    assert prepare()['ok']
    page.evaluate("document.querySelector('[data-chat-root]').insertAdjacentHTML('beforeend','<div class=attachment-preview>Manual upload</div>')")
    assert send()['clicked'] is False and page.evaluate('syntheticClicks') == 0
    passed('an attachment added after preparation blocks the final click')

    load()
    assert prepare()['ok']
    page.evaluate("document.querySelector('#send').replaceWith(document.querySelector('#send').cloneNode(true))")
    assert send()['clicked'] is False
    passed('a replaced Send element invalidates composer ownership')

    load()
    assert prepare()['ok']
    page.evaluate("document.body.insertAdjacentHTML('beforeend','<div id=captcha style=width:200px;height:80px>Security check</div>')")
    assert send()['clicked'] is False and page.evaluate('syntheticClicks') == 0
    passed('CAPTCHA blocks sending and is never dismissed by the reply module')

    load()
    page.evaluate("guard.documentToken='old-document'")
    assert not prepare()['ok'] and page.locator('textarea').input_value() == ''
    passed('a navigation token from an old document cannot authorize editing')

    load('mic')
    assert prepare()['ok'] and send()['clicked'] and page.evaluate('syntheticClicks') == 1
    passed('the same recipient guard works inside the Made-in-China messenger')

    load('1688')
    page.evaluate("()=>{window.testClock=Date.now();Date.now=()=>testClock;}")
    assert page.evaluate("command('CHAT_READY')")['waiting']
    page.evaluate('testClock+=6000')
    assert prepare()['needsNativeInput']
    for stage in ['locate', 'focus']:
        assert page.evaluate("stage=>command('NATIVE_INPUT',{dialogGuard:guard,expectedUrl:location.href,token:'native-test',stage})",stage)['ok']
    page.keyboard.press('Space')
    assert page.evaluate("command('NATIVE_INPUT',{dialogGuard:guard,expectedUrl:location.href,token:'native-test',stage:'space'})")['ok']
    page.keyboard.press('Backspace')
    assert page.evaluate("command('NATIVE_INPUT',{dialogGuard:guard,expectedUrl:location.href,token:'native-test',stage:'done'})")['ok']
    assert prepare()['ok']
    result=send()
    assert result['clicked'] and result['accepted'] and page.evaluate('syntheticClicks') == 1, result
    passed('1688 Space/Backspace activation preserves guarded editor ownership through sending')

    assert not errors, errors
    browser.close()
print(f'{checks} guarded reply browser checks passed', flush=True)
