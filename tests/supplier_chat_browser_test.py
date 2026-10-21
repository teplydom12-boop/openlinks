"""Reference-driven opener tests in real Chromium, with local pages and virtual time.
Chrome message transport is a test double; production content/engine code is unchanged.
"""
from pathlib import Path
import os
import json
import time
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
checks=0
TRANSPORT="""
let listener;
window.openerEvents=[];window.permitOpening=true;
window.chrome={runtime:{id:'supplier-test',onMessage:{addListener(fn){listener=fn}},sendMessage:async message=>{
  if(message.type==='CHAT_OPEN_EVENT'){
    openerEvents.push({...message,time:Date.now()});
    if(message.phase==='attempt'&&permitOpening){
      return adapter('CONTACT');
    }
    return {ok:permitOpening};
  }
  if(message.type==='OPENLINKS_TEST_SEND_GUARD')return {ok:true,canSend:true};
  return {ok:true};
}}};
window.contactCommands=[];
chrome.debugger={attach:async()=>{},detach:async()=>{},sendCommand:(target,method,params)=>new Promise(resolve=>contactCommands.push({method,params,resolve}))};
const rawAdapter=(type,extra={})=>new Promise(resolve=>listener({type,jobId:'fixture-job',profile:{},message:'Hello supplier',...extra},{id:'supplier-test'},resolve));
window.adapter=async(type,extra={})=>{
 const result=await rawAdapter(type,extra);
 return type==='CONTACT'&&result.ok?clickNativeContact({tabId:1},result):result;
};
"""
ALI='https://shop.en.alibaba.com/'
MIC='https://shop.en.made-in-china.com/'
ALIBABA="""<!doctype html><meta charset=utf-8>
<a class=icbu-alitalk href='https://shop.en.alibaba.com/wrong-navigation'>Chat now</a>
<iframe src='https://onetalk.alibaba.com/message/weblite.htm' style='width:1px;height:1px;border:0'></iframe>
<script>
window.openClicks=0;window.hovers=0;window.showOn=1;
const trigger=document.querySelector('a');trigger.onmouseover=()=>hovers++;
trigger.onclick=event=>{event.preventDefault();openClicks++;if(hovers && openClicks===showOn){document.querySelector('iframe').style.cssText='width:400px;height:450px;border:0';}};
</script>"""

def passed(name):
    global checks
    checks+=1
    print('PASS '+name,flush=True)

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,ignore_default_args=['--disable-popup-blocking'])
    context=browser.new_context(viewport={'width':1200,'height':900})
    page=context.new_page();page.clock.install();errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.add_init_script((ROOT/'extension/lib/native-contact.js').read_text().replace('export ','')+TRANSPORT)
    cdp=context.new_cdp_session(page)
    def raw_eval(expression):
        return cdp.send('Runtime.evaluate',{'expression':expression,'returnByValue':True,'userGesture':False})['result'].get('value')
    def pump():
        for _ in range(30):
            command=raw_eval('contactCommands[0]&&{method:contactCommands[0].method,params:contactCommands[0].params}')
            if not command:return
            reply=cdp.send(command['method'],command['params'])
            raw_eval('contactCommands.shift().resolve('+json.dumps(reply)+');void 0')
        raise AssertionError('Native contact command chain did not settle')
    def native_call(expression):
        raw_eval('window.contactResult=null;Promise.resolve('+expression+').then(value=>{contactResult={value}},error=>{contactResult={error:error.message}});void 0')
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            pump();result=raw_eval('contactResult')
            if result:
                assert 'error' not in result,result
                return result['value']
            page.wait_for_timeout(1)
        raise AssertionError('Native contact CDP bridge timed out')
    def tick(milliseconds):
        while milliseconds:
            step=min(milliseconds,250);milliseconds-=step
            page.clock.run_for(step);pump()

    def load(html,url=ALI):
        context.unroute('**/*')
        context.route('**/*',lambda route:route.fulfill(body=html if route.request.url==url else '<!doctype html><title>Local empty resource</title>',content_type='text/html'))
        page.goto(url)
        for name in ['rules-shared.js','routes-1688-shared.js','supplier-chat.js','content.js']:
            raw_eval((ROOT/'extension'/name).read_text()+';void 0')
    def start(extra=''):
        assert page.evaluate("adapter('OPEN_CHAT',{token:'open',at:Date.now(),attempts:0,lastClick:0"+extra+"})")['ok']
    def phases():return page.evaluate('openerEvents.map(event=>event.phase)')

    load(ALIBABA)
    before=page.evaluate("adapter('PROBE')")
    assert not before['opened'] and before['frames'][0]['visible'] is False
    start();tick(1500)
    assert page.evaluate('openClicks')==1 and page.evaluate('hovers')==1 and page.url==ALI
    assert page.evaluate("adapter('PROBE')")['opened'] and phases()==['attempt','opened']
    tick(15000);assert page.evaluate('openClicks')==1
    passed('Alibaba: collapsed preloaded iframe is closed; hover/native click preserves site handler and stops after visible opening')

    load(ALIBABA);page.evaluate('showOn=3');start();tick(14000)
    times=page.evaluate("openerEvents.filter(event=>event.phase==='attempt').map(event=>event.time)")
    assert len(times)==3 and all(b-a>=5000 for a,b in zip(times,times[1:]))
    assert page.evaluate('openClicks')==3 and phases()[-1]=='opened'
    passed('Alibaba: retries asynchronous handlers at least 5 seconds apart, stopping when the third click opens chat')

    load(ALIBABA);page.evaluate('showOn=99');start();tick(22000)
    assert page.evaluate('openClicks')==3 and phases()[-1]=='timeout'
    tick(20000);assert page.evaluate('openClicks')==3
    passed('20-second deadline ends opening after at most three clicks; no endless retry loop')

    for tag,selector,hidden in [('a','J-open-tm',True),('button','webtm-chat-now-tip-button',False),('a','tm-placeholder',False)]:
        html=f'''<!doctype html><{tag} class="{selector}" style="{'display:none' if hidden else ''}">Open</{tag}>
        <div id=pane style="display:none;width:400px;height:400px"></div><script>
        window.openClicks=0;document.querySelector('.{selector}').onclick=()=>{{openClicks++;const pane=document.querySelector('#pane');pane.className='webtm-lite-content-visible';pane.style.display='block';}};
        </script>'''
        load(html,MIC);start();tick(1500)
        assert page.evaluate('openClicks')==1 and phases()==['attempt','opened']
        assert page.evaluate('openerEvents[0].hidden')==hidden
        passed('MIC reference hook '+selector+(': hidden native button works' if hidden else ': visible trigger opens the widget'))

    load('''<!doctype html><div id=pane style="display:none;width:400px;height:400px"></div><script>
    window.openClicks=0;setTimeout(()=>{const button=document.createElement('a');button.className='J-open-tm';button.textContent='Late chat';button.onclick=()=>{openClicks++;pane.className='webtm-lite-content-visible';pane.style.display='block';};document.body.append(button);},2100);
    </script>''',MIC)
    start();tick(3600)
    assert page.evaluate('openClicks')==1 and phases()==['attempt','opened']
    passed('MIC button loaded later is discovered by the 700ms polling loop')

    load('''<!doctype html><a class=J-open-tm>Chat now</a><section class=webtm-lite-content-visible style="width:400px;height:400px">
    <textarea></textarea><button>Send</button></section><script>window.openClicks=0;document.querySelector('a').onclick=()=>openClicks++;</script>''',MIC)
    start();tick(800)
    assert phases()==['opened'] and page.evaluate('openClicks')==0
    assert page.evaluate("adapter('PROBE')")['kind']=='chat'
    passed('already open MIC widget advances directly to its editor without clicking its chat toggle')

    for block in ['<div class=mb-dialog><div class=login-panel>Sign in</div></div>', '<div id=captcha style="width:300px;height:100px">Check</div>']:
        load(ALIBABA+block);start();tick(800)
        assert phases()==['blocked'] and page.evaluate('openClicks')==0
    passed('login dialog and visible CAPTCHA stop the opener before any contact click')

    load(ALIBABA);page.evaluate('showOn=99');start();tick(800)
    assert page.evaluate('openClicks')==1
    assert page.evaluate("adapter('STOP_OPEN_CHAT',{token:'open'})")['ok']
    tick(22000);assert page.evaluate('openClicks')==1 and phases()==['attempt']
    passed('STOP_OPEN_CHAT cancels all remaining timer-driven clicks immediately')

    load(ALIBABA);page.evaluate('permitOpening=false');start();tick(22000)
    assert page.evaluate('openClicks')==0 and phases()==['attempt']
    passed('worker authorization is required before the native click')

    load(ALIBABA.replace("https://shop.en.alibaba.com/wrong-navigation","/relative-native-route").replace('event.preventDefault();openClicks++;','if(event.defaultPrevented)return;event.preventDefault();openClicks++;'))
    start();tick(1500)
    assert page.evaluate('openClicks')==1 and page.url==ALI and phases()==['attempt','opened']
    passed('relative anchor keeps native handler and its defaultPrevented semantics; wrong fallback URL never navigates')

    popup_url='https://webim.made-in-china.com/super-tm/#/chat/FixtureSeller_123'
    def native_click():
        return native_call("adapter('CONTACT')")
    # Unlike Playwright's default evaluate(), queue alarms have no transient
    # activation. Keep Chrome popup blocking enabled and prove that distinction.
    load('''<!doctype html><a class=J-open-tm href=javascript:;>Chat</a><script>
    window.nativeClicks=0;window.opened=false;document.querySelector('a').onclick=event=>{event.preventDefault();nativeClicks++;window.opened=!!window.open('''+repr(popup_url)+''');};</script>''',MIC)
    assert raw_eval('navigator.userActivation.isActive') is False
    raw_eval("document.querySelector('a').click();void 0")
    assert raw_eval('opened') is False and len(context.pages)==1
    assert raw_eval('navigator.userActivation.isActive') is False
    with context.expect_page() as opened:result=native_click()
    popup=opened.value;popup.wait_for_load_state()
    assert result['ok'] and popup.url==popup_url and raw_eval('nativeClicks')==2
    assert raw_eval('opened') is True
    popup.close()
    passed('normal popup policy blocks an alarm-style synthetic click; the production CDP user-gesture helper opens the exact native chat')

    for delay in [0,200]:
        html='''<!doctype html><a class=J-open-tm href=javascript:;>Chat</a><script>
        window.nativeClicks=0;document.querySelector('a').onclick=event=>{event.preventDefault();nativeClicks++;
        '''+("setTimeout(()=>window.open("+repr(popup_url)+"),200);" if delay else "window.open("+repr(popup_url)+");window.focus();")+'''};</script>'''
        load(html,MIC)
        with context.expect_page() as opened:
            result=native_click()
            if delay:tick(250)
        popup=opened.value;popup.wait_for_load_state()
        assert result['ok'] and popup.url==popup_url
        assert page.url==MIC and page.evaluate('nativeClicks')==1
        assert not page.evaluate("!!document.querySelector('[data-openlinks-contact]')")
        popup.close()
        passed(('delayed' if delay else 'synchronous')+' foreground native window.open creates the actual chat tab without interception')

    for base in [False,True]:
        html=('<!doctype html><base target=_blank>' if base else '<!doctype html>')+'<a class=J-open-tm '+('' if base else 'target=_blank ')+'href="'+popup_url+'">Chat</a><script>window.nativeClicks=0;document.querySelector("a").onclick=event=>{if(event.defaultPrevented)throw new Error("native cancellation changed");nativeClicks++;};</script>'
        load(html,MIC)
        with context.expect_page() as opened:result=native_click()
        popup=opened.value;popup.wait_for_load_state()
        assert result['ok'] and popup.url==popup_url and page.url==MIC and page.evaluate('nativeClicks')==1
        popup.close()
        passed(('inherited base target' if base else 'plain target=_blank')+' foreground anchor preserves its native handler and opens the chat tab')

    load('<!doctype html><a class=J-open-tm href=javascript:;>Chat</a><script>window.nativeClicks=0;document.querySelector("a").onclick=()=>nativeClicks++;</script>',MIC)
    raw_eval((ROOT/'extension/lib/outreach-chat-open.js').read_text().replace('export ','')+';void 0')
    assert cdp.send('Runtime.evaluate',{'expression':"controlledContact({action:'arm',pageUrl:location.href})",'returnByValue':True,'awaitPromise':True,'userGesture':False})['result']['value']['ok']
    stale_guard=native_click()
    assert not stale_guard['ok'] and stale_guard['reloadRequired'] is True
    assert raw_eval('nativeClicks')==0 and len(context.pages)==1
    passed('an old background guard surviving extension reload explicitly requires a page refresh before any native contact click')

    load(ALIBABA+'<button id=wrong>Wrong old action</button>')
    page.evaluate("()=>{window.oldRule={id:'old',platform:'alibaba',field:'contact',selector:'#wrong',tag:'button',scope:{host:'*.en.alibaba.com',path:'/'}};window.wrongClicks=0;document.querySelector('#wrong').onclick=()=>wrongClicks++;}")
    start(',profile:{rules:[oldRule]}');tick(1500)
    assert page.evaluate('openClicks')==1 and page.evaluate('wrongClicks')==0
    assert any('прежнего' in reason for reason in page.evaluate("adapter('PROBE',{profile:{rules:[oldRule]}})")['diagnostics']['learning']['rejected'])
    passed('legacy contact lessons remain stored but cannot override the rebuilt reference opener')

    load('''<!doctype html><form action=/sendInquiry><a id=inquiry class=J-open-tm href=/sendInquiry>Chat now</a><textarea></textarea><button>Send</button></form>
    <script>window.inquiryClicks=0;document.querySelector('a').onclick=e=>{e.preventDefault();inquiryClicks++;};document.querySelector('form').onsubmit=e=>{e.preventDefault();inquiryClicks++;};</script>''',MIC)
    start(',profile:{contact:"#inquiry"}');tick(22000)
    assert page.evaluate('inquiryClicks')==0 and phases()==['timeout']
    assert not page.evaluate("adapter('PREPARE')")['ok']
    passed('even an explicit contact selector cannot convert an inquiry form into a chat')

    for url in ['https://onetalk.alibaba.com/message/weblite.htm','https://webim.made-in-china.com/super-tm/']:
        load('''<!doctype html><div><textarea></textarea><button>Send</button></div><script>
        window.sent=0;window.received='';document.querySelector('button').onclick=()=>{sent++;received=document.querySelector('textarea').value;};</script>''',url)
        assert page.evaluate("adapter('PROBE')")['kind']=='chat'
        assert page.evaluate("adapter('PREPARE')")['ok']
        assert page.evaluate("adapter('SEND',{expectedUrl:location.href})")['clicked']
        assert page.evaluate('sent')==1 and page.evaluate('received')=='Hello supplier'
        assert not page.evaluate("adapter('SEND',{expectedUrl:location.href})")['clicked']
    passed('both real messenger URL patterns provide composer context without brittle container classes; send remains single-use')
    assert not errors,errors
    passed('no browser JavaScript errors')
    browser.close()
print(f'{checks} reference-opener browser checks passed; all vendor requests intercepted locally.')
