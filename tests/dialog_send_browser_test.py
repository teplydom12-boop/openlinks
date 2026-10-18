"""Guarded replies on synthetic pages only; no live sellers or network calls."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = (ROOT / 'tests/fixtures/dialogs-synthetic.html').read_text().replace('Untouched buyer draft', '')
TRANSPORT = """
window.testListeners=[];
window.testSendAllowed=true;
window.chrome={runtime:{id:'reply-test',onMessage:{addListener(fn){testListeners.push(fn)}},sendMessage:async message=>message.type==='OPENLINKS_TEST_SEND_GUARD'?{ok:true,canSend:testSendAllowed}:{ok:true}}};
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
    def preview():
        page.evaluate("window.cleanupToken={operation:guard.operation,platform:guard.platform,id:guard.id,documentToken:guard.documentToken,sourceUrl:guard.sourceUrl,text:'We need 100 units.'}")
        return page.evaluate("command('PREPARE',{dialogGuard:guard,dialogPreview:true})")
    def clear_preview():
        return page.evaluate("command('DIALOGS_CLEAR_PREVIEW',{token:cleanupToken})")
    def prepare_1688():
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
    def suppress_page_timers():
        # Reproduce background timer throttling without slowing this test or
        # relying on headless Chromium's platform-specific occlusion behavior.
        page.evaluate("""()=>{
          window.timerRequests=0;window.pendingTimers=new Map();
          window.setTimeout=(fn,ms)=>{const id=++timerRequests;pendingTimers.set(id,{fn,ms});return id};
          window.clearTimeout=id=>pendingTimers.delete(id);
          window.observerCount=0;
          const NativeObserver=MutationObserver;
          window.MutationObserver=class extends NativeObserver {
            observe(...args){if(!this.counted){observerCount++;this.counted=true}return super.observe(...args)}
            disconnect(){if(this.counted){observerCount--;this.counted=false}return super.disconnect()}
          };
        }""")
    def begin_send():
        page.evaluate("()=>{window.sendResult=null;window.sending=command('SEND',{dialogGuard:guard,expectedUrl:location.href,attemptId:guard.operation}).then(result=>window.sendResult=result)}")
        page.wait_for_function('syntheticClicks===1',timeout=2000)
    def completed_send():
        page.wait_for_function('sendResult!==null',timeout=2000)
        assert page.evaluate('observerCount===0 && pendingTimers.size===0')
        return page.evaluate('sendResult')

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

    prepare_1688()
    result=send()
    assert result['clicked'] and result['accepted'] and page.evaluate('syntheticClicks') == 1, result
    passed('1688 Space/Backspace activation preserves guarded editor ownership through sending')

    prepare_1688();suppress_page_timers();begin_send()
    result=completed_send()
    assert result['clicked'] and result['accepted'],result
    assert page.evaluate('timerRequests===0')
    assert send()['clicked'] is False and page.evaluate('syntheticClicks')==1
    passed('1688 synchronous composer consumption completes without any page timer and still rejects duplicate SEND')

    prepare_1688()
    page.evaluate('()=>{document.querySelector("#send").onclick=()=>syntheticClicks++}')
    suppress_page_timers();begin_send()
    assert page.evaluate('sendResult===null && observerCount===1 && timerRequests===1')
    page.evaluate("document.querySelector('pre.edit').textContent=''")
    result=completed_send()
    assert result['clicked'] and result['accepted'],result
    assert send()['clicked'] is False and page.evaluate('syntheticClicks')==1
    passed('1688 asynchronous DOM consumption completes and disconnects observers even when every page timer is blocked')

    for event_type in ['input','change']:
        prepare_1688()
        # A value-backed editor can clear without changing its DOM tree.
        page.evaluate("()=>{const editor=document.querySelector('pre.edit');editor.value=editor.innerText;document.querySelector('#send').onclick=()=>syntheticClicks++}")
        suppress_page_timers();begin_send()
        page.evaluate("type=>{const editor=document.querySelector('pre.edit');editor.value='';editor.dispatchEvent(new Event(type,{bubbles:true}))}",event_type)
        result=completed_send()
        assert result['clicked'] and result['accepted'],result
    passed('input and change events confirm value-only consumption without DOM mutation or timer callbacks')

    for invalidation in ['detached','hidden','captcha','recipient','navigation','pagehide']:
        prepare_1688()
        page.evaluate('()=>{document.querySelector("#send").onclick=()=>syntheticClicks++}')
        suppress_page_timers();begin_send()
        page.evaluate("""kind=>{
          const editor=document.querySelector('pre.edit');editor.textContent='';
          if(kind==='detached')editor.remove();
          if(kind==='hidden')editor.style.display='none';
          if(kind==='captcha')document.body.insertAdjacentHTML('beforeend','<div id=captcha style="width:200px;height:80px">Check</div>');
          if(kind==='recipient')document.querySelector('[data-chat-root]').dataset.threadId='different-supplier';
          if(kind==='navigation')location.hash='another-chat';
          if(kind==='pagehide')dispatchEvent(new Event('pagehide'));
        }""",invalidation)
        result=completed_send()
        assert result['clicked'] and result['accepted'] is False,(invalidation,result)
        assert send()['clicked'] is False and page.evaluate('syntheticClicks')==1
    passed('emptying a changed, hidden, detached, blocked or navigating chat remains an unknown outcome without automatic retries')

    prepare_1688()
    page.evaluate('()=>{document.querySelector("#send").onclick=()=>syntheticClicks++}')
    suppress_page_timers();begin_send()
    page.evaluate('()=>{window.afterDeadline=performance.now()+1500;performance.now=()=>afterDeadline;document.querySelector("pre.edit").textContent=""}')
    result=completed_send()
    assert result['clicked'] and result['accepted'] is False,result
    assert send()['clicked'] is False and page.evaluate('syntheticClicks')==1
    passed('a delayed mutation cannot extend the bounded confirmation window when timeout callbacks are throttled')

    prepare_1688()
    page.evaluate('()=>{document.querySelector("#send").onclick=()=>syntheticClicks++}')
    result=send()
    assert result['clicked'] and result['accepted'] is False,result
    assert send()['clicked'] is False and page.evaluate('syntheticClicks')==1
    passed('an unchanged 1688 draft times out locally and cannot trigger a second send')

    for platform in ['alibaba','mic']:
        load(platform)
        result=preview();assert result['ok'] and result['preview'],result
        assert page.locator('textarea').input_value()=='We need 100 units.'
        assert send()['clicked'] is False
        assert page.evaluate("command('SEND',{jobId:'different-operation',attemptId:'different-operation',expectedUrl:location.href})")['clicked'] is False
        assert page.evaluate("command('PREPARE',{jobId:'different-operation'})")['ok'] is False
        assert page.evaluate('syntheticClicks')==0
        assert clear_preview()['cleared']
        assert page.locator('textarea').input_value()==''
        assert clear_preview()['cleared']
        assert send()['clicked'] is False
    passed('test previews fill real synthetic composers, permanently forbid SEND and clean only owned text on both platforms')

    load();assert preview()['ok']
    page.evaluate("document.querySelector('[data-message-history]').insertAdjacentHTML('beforeend','<div class=message-item data-direction=inbound data-message-id=new><span data-message-text>New supplier reply</span></div>')")
    assert clear_preview()['cleared'] and page.locator('textarea').input_value()==''
    assert page.evaluate('syntheticClicks')==0
    passed('new inbound history does not prevent safe cleanup of the same owned preview')

    for change in ['different text','same text restored','space']:
        load();assert preview()['ok']
        page.locator('textarea').fill('My manual draft' if change!='space' else 'We need 100 units. ')
        if change=='same text restored':page.locator('textarea').fill('We need 100 units.')
        expected=page.locator('textarea').input_value()
        assert clear_preview()['cleared'] is False
        assert page.locator('textarea').input_value()==expected
        assert page.evaluate('syntheticClicks')==0
        page.locator('textarea').fill('')
        assert clear_preview()['cleared']
    passed('manual edits, even restored text, are never erased; manually emptying the field allows recovery')

    for change in ['recipient','document','editor','attachment']:
        load();assert preview()['ok']
        if change=='recipient':page.evaluate("document.querySelector('[data-chat-root]').dataset.threadId='another-supplier'")
        elif change=='document':page.evaluate("cleanupToken.documentToken='old-document'")
        elif change=='editor':page.evaluate("const old=document.querySelector('textarea'),replacement=old.cloneNode(true);replacement.value=old.value;old.replaceWith(replacement)")
        else:page.evaluate("document.querySelector('[data-chat-root]').insertAdjacentHTML('beforeend','<div class=attachment-preview>Manual file</div>')")
        assert clear_preview()['cleared'] is False,change
        assert page.locator('textarea').input_value()=='We need 100 units.'
    passed('changed recipient, document, composer or added attachment blocks preview cleanup')

    load();assert preview()['ok']
    page.evaluate('window.testListeners=[];window.__openlinksInstalled=false')
    page.add_script_tag(path=str(ROOT/'extension/content.js'))
    assert clear_preview()['cleared'] is False
    assert page.locator('textarea').input_value()=='We need 100 units.'
    page.locator('textarea').fill('')
    assert clear_preview()['cleared']
    passed('lost content-script ownership cannot erase text; manual empty-field recovery remains available')

    for platform in ['alibaba','mic','1688']:
        load(platform)
        old_guard=page.evaluate('guard')
        load(platform)
        page.evaluate('(old)=>window.cleanupToken={...old,text:"We need 100 units."}',old_guard)
        assert page.evaluate('guard.documentToken!==cleanupToken.documentToken')
        assert clear_preview()['cleared'] is False
        page.evaluate("()=>{window.recoveryEvents=[];for(const type of ['input','change','focus','keydown','click'])document.addEventListener(type,()=>recoveryEvents.push(type),true);window.beforeFocus=document.activeElement}")
        result=page.evaluate("command('DIALOGS_CHECK_PREVIEW_EMPTY',{guard})")
        assert result['empty'],result
        assert page.evaluate('document.activeElement===beforeFocus && recoveryEvents.length===0 && syntheticClicks===0')
        assert page.evaluate("command('DIALOGS_CHECK_PREVIEW_EMPTY',{guard:cleanupToken})")['empty'] is False
        assert page.evaluate("command('DIALOGS_CHECK_PREVIEW_EMPTY',{guard:{...guard,id:'different-recipient'}})")['empty'] is False
    passed('reloaded empty composers recover only through a fresh exact-recipient guard without focus, keys, input or clicks')

    for platform in ['alibaba','mic','1688']:
        for draft in ['My restored manual draft','We need 100 units.','   ']:
            load(platform)
            page.evaluate("value=>{const editor=document.querySelector('textarea,pre.edit');if('value' in editor)editor.value=value;else editor.textContent=value}",draft)
            assert page.evaluate("command('DIALOGS_CHECK_PREVIEW_EMPTY',{guard})")['empty'] is False
            assert page.evaluate("()=>{const editor=document.querySelector('textarea,pre.edit');return 'value' in editor?editor.value:editor.textContent}")==draft
            assert page.evaluate('syntheticClicks')==0
    passed('read-only recovery preserves every nonempty restored draft, including exact preview text and whitespace')

    for attachment in ['file','preview','media']:
        load('1688' if attachment=='media' else 'alibaba')
        if attachment=='file':
            page.evaluate("document.querySelector('[data-chat-root]').insertAdjacentHTML('beforeend','<input type=file hidden id=recovery-file>')")
            page.locator('#recovery-file').set_input_files({'name':'manual.txt','mimeType':'text/plain','buffer':b'Manual attachment'})
        elif attachment=='preview':
            page.evaluate("document.querySelector('[data-chat-root]').insertAdjacentHTML('beforeend','<div class=attachment-preview>Manual file</div>')")
        else:
            page.evaluate("document.querySelector('pre.edit').innerHTML='<img data-attachment src=data:,>'")
        assert page.evaluate("command('DIALOGS_CHECK_PREVIEW_EMPTY',{guard})")['empty'] is False
        assert page.evaluate('syntheticClicks')==0
    passed('empty text cannot conceal queued files, visible uploads or rich-editor attachments during recovery')

    load();page.evaluate("document.querySelector('#send').disabled=true")
    result=preview();assert result['ok'] is False
    assert page.locator('textarea').input_value()=='We need 100 units.'
    assert clear_preview()['cleared']
    passed('a preview that filled text but failed Send readiness still retains safe cleanup ownership')

    load();assert prepare()['ok'];page.evaluate('testSendAllowed=false')
    assert send()['clicked'] is False and page.evaluate('syntheticClicks')==0
    load();assert prepare()['ok'];page.evaluate("()=>{chrome.runtime.sendMessage=async()=>{throw Error('worker unavailable')}}")
    assert send()['clicked'] is False and page.evaluate('syntheticClicks')==0
    passed('global test mode and unavailable mode guard fail closed for legacy and guarded SEND')

    load();assert prepare()['ok']
    page.evaluate("()=>{chrome.runtime.sendMessage=()=>new Promise(resolve=>window.releaseGuard=resolve);window.pendingSend=command('SEND',{dialogGuard:guard,expectedUrl:location.href,attemptId:guard.operation})}")
    page.wait_for_function('typeof releaseGuard==="function"')
    page.evaluate("document.querySelector('[data-message-text]').textContent='History changed while guard awaited';releaseGuard({ok:true,canSend:true})")
    assert page.evaluate('pendingSend')['clicked'] is False and page.evaluate('syntheticClicks')==0
    passed('final recipient/history checks run after the asynchronous global test guard')

    load('1688')
    page.evaluate("()=>{window.testClock=Date.now();Date.now=()=>testClock;window.enterEvents=0;document.addEventListener('keydown',event=>{if(event.key==='Enter')enterEvents++},true)}")
    assert page.evaluate("command('CHAT_READY')")['waiting'];page.evaluate('testClock+=6000')
    assert preview()['needsNativeInput']
    for stage in ['locate','focus']:
        assert page.evaluate("stage=>command('NATIVE_INPUT',{dialogGuard:guard,dialogPreview:true,expectedUrl:location.href,token:'native-preview',stage})",stage)['ok']
    page.keyboard.press('Space')
    assert page.evaluate("command('NATIVE_INPUT',{dialogGuard:guard,dialogPreview:true,expectedUrl:location.href,token:'native-preview',stage:'space'})")['ok']
    page.keyboard.press('Backspace')
    for stage in ['done','release']:
        assert page.evaluate("stage=>command('NATIVE_INPUT',{dialogGuard:guard,dialogPreview:true,expectedUrl:location.href,token:'native-preview',stage})",stage)['ok']
    assert preview()['ok']
    assert send()['clicked'] is False
    assert clear_preview()['cleared']
    assert page.locator('pre.edit').inner_text()==''
    assert page.evaluate('syntheticClicks')==0 and page.evaluate('enterEvents')==0
    passed('1688 preview permits only Space/Backspace activation, never sends and safely clears owned rich-editor text')

    assert not errors, errors
    browser.close()
print(f'{checks} guarded reply browser checks passed', flush=True)
