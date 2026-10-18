"""Exercise the MAIN-world MIC launcher with synthetic native widget handlers.

All URLs are fulfilled locally. Authentication material is a fixture sentinel.
These tests prove synchronous interception and guards, not live MIC authentication.
"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
CENTER='https://membercenter.made-in-china.com/message/index.html'
CHAT='https://webim.made-in-china.com/super-tm/#/fixture?data=fixture-auth-token&refer=&isLiteTM=false&isSAChat=false'
SOURCE=(ROOT/'extension/lib/mic-chat-launch.js').read_text().replace('export function captureMICChat()', 'window.captureMICChat=function captureMICChat()')
HTML='''<!doctype html><meta charset=utf-8>
<style>button,[role=button],input,textarea{min-width:100px;min-height:30px}[hidden]{display:none!important}</style>
<input id=personal value="Personal draft">
<div id=webtm-wrapper><div class=webtm-min-box role=button aria-label=tm>Open</div>
<div class=webtm-min-task-expanded hidden><div class=webtm-lite-content-visible><button type=button class=webtm-full-btn>Expand</button></div></div></div>
<script>
window.nativeCalls=0;window.bubbleClicks=0;window.expandClicks=0;window.inputEvents=0;window.focusEvents=0;window.submitEvents=0;
window.open=function(){nativeCalls++;return null;};
window.fixtureURL='https://webim.made-in-china.com/super-tm/#/fixture?data=fixture-auth-token&refer=&isLiteTM=false&isSAChat=false';
document.querySelector('.webtm-min-box').onclick=()=>{bubbleClicks++;document.querySelector('.webtm-min-task-expanded').hidden=false;document.querySelector('.webtm-min-box').hidden=true;};
document.querySelector('.webtm-full-btn').onclick=()=>{expandClicks++;window.open(fixtureURL,'_blank');};
for(const type of ['input','change'])document.addEventListener(type,()=>inputEvents++,true);
document.addEventListener('focus',()=>focusEvents++,true);
document.addEventListener('submit',()=>submitEvents++,true);
</script>'''
checks=0


def passed(label):
    global checks
    checks+=1
    print('PASS '+label,flush=True)


with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True)
    context=browser.new_context(viewport={'width':1200,'height':900})
    context.route('**/*',lambda route:route.fulfill(body=HTML,content_type='text/html'))
    page=context.new_page()
    page.clock.install()
    page.on('dialog',lambda dialog:dialog.dismiss())

    def load(expanded=True,url=CENTER):
        page.goto(url)
        page.add_script_tag(content=SOURCE)
        if expanded:
            page.evaluate("document.querySelector('.webtm-min-task-expanded').hidden=false;document.querySelector('.webtm-min-box').hidden=true")
        page.evaluate("window.beforeOpen=Object.getOwnPropertyDescriptor(window,'open');window.beforeActive=document.activeElement")

    def run():
        return page.evaluate('captureMICChat()')

    def restored():
        return page.evaluate("(()=>{const a=beforeOpen,b=Object.getOwnPropertyDescriptor(window,'open');return a?b&&['value','get','set','enumerable','writable','configurable'].every(k=>a[k]===b[k]):!b;})()")

    def no_input():
        assert page.evaluate('inputEvents===0&&focusEvents===0&&submitEvents===0&&document.activeElement===beforeActive')
        assert page.locator('#personal').input_value()=='Personal draft'
        assert len(context.pages)==1

    load(expanded=False)
    assert run()['reason']=='widget_expanding'
    assert page.evaluate('bubbleClicks===1&&expandClicks===0&&nativeCalls===0')
    assert run()=={'ok':True,'url':CHAT}
    assert page.evaluate('bubbleClicks===1&&expandClicks===1&&nativeCalls===0')
    assert restored()
    assert run()['reason']=='attempt_consumed'
    assert page.evaluate('expandClicks===1')
    assert page.evaluate("Object.getOwnPropertySymbols(document).map(k=>document[k]).filter(v=>v&&typeof v==='object'&&'expand'in v).every(v=>Object.values(v).every(x=>typeof x==='boolean'))")
    no_input()
    passed('bubble expands once, next call captures one synchronous auth URL without real popup, input or focus; result is consumed')

    load()
    before=page.content()
    assert run()=={'ok':True,'url':CHAT}
    assert page.content()==before
    assert restored()
    no_input()
    passed('already expanded widget opens directly and does not persist the captured URL in DOM')

    for url in ['https://www.made-in-china.com/','https://membercenter.made-in-china.com/message/index.html?other=1','https://membercenter.made-in-china.com/message/index.html#other','https://membercenter.made-in-china.com/elsewhere/','https://shop.en.made-in-china.com/message/index.html']:
        load(url=url)
        assert run()['reason']=='wrong_page'
        assert page.evaluate('bubbleClicks===0&&expandClicks===0&&nativeCalls===0')
    load()
    page.evaluate("Object.defineProperty(document,'readyState',{value:'interactive',configurable:true})")
    assert run()['reason']=='page_loading'
    assert page.evaluate('expandClicks===0')
    passed('only exact complete member center page is eligible')

    load()
    page.evaluate("document.body.insertAdjacentHTML('beforeend','<iframe src=\"'+location.href+'\"></iframe>')")
    frame=page.frame(url=CENTER)  # Main frame; wait for the separately created child.
    page.wait_for_function('document.querySelector("iframe").contentDocument?.readyState==="complete"')
    frame=page.frames[1]
    frame.add_script_tag(content=SOURCE)
    assert frame.evaluate('captureMICChat()')['reason']=='wrong_page'
    assert frame.evaluate('bubbleClicks===0&&expandClicks===0&&nativeCalls===0')
    page.locator('iframe').evaluate('(node)=>node.remove()')
    passed('same-origin child frame cannot run the top-frame launcher')

    for addition,reason in [('<div id=captcha style="width:200px;height:100px">Check</div>','captcha'),('<input type=password>','login')]:
        load()
        page.evaluate('(html)=>document.body.insertAdjacentHTML("beforeend",html)',addition)
        assert run()['reason']==reason
        assert page.evaluate('expandClicks===0&&nativeCalls===0')
    load()
    page.evaluate("document.body.insertAdjacentHTML('beforeend','<div id=captcha hidden>Hidden</div><input type=password hidden>')")
    assert run()['ok']
    passed('visible CAPTCHA and login block opening; hidden placeholders do not')

    load()
    page.locator('#personal').focus()
    page.evaluate('window.beforeActive=document.activeElement;focusEvents=0')
    assert run()['reason']=='user_editing'
    assert page.evaluate('expandClicks===0&&nativeCalls===0')
    no_input()
    for field in ['<textarea>Unsent draft</textarea>','<div contenteditable=true>Unsent draft</div>','<input value="Unsent draft">','<div role=textbox>Unsent draft</div>','<textarea hidden>Unsent draft</textarea>']:
        load()
        page.evaluate('(html)=>document.querySelector("#webtm-wrapper").insertAdjacentHTML("beforeend",html)',field)
        assert run()['reason']=='widget_draft'
        assert page.evaluate('expandClicks===0&&nativeCalls===0')
    passed('active user editor and visible or hidden widget drafts are preserved without clicks')

    for expanded,selector,reason in [(True,'#webtm-wrapper','ambiguous_widget'),(True,'.webtm-full-btn','ambiguous_expand'),(False,'.webtm-min-box','ambiguous_bubble')]:
        load(expanded=expanded)
        page.evaluate('(selector)=>{const n=document.querySelector(selector);n.after(n.cloneNode(true));}',selector)
        assert run()['reason']==reason
        assert page.evaluate('bubbleClicks===0&&expandClicks===0&&nativeCalls===0')
    passed('duplicate widget, full-chat button or bubble cannot select an ambiguous target')

    for expanded,patch in [(True,"document.querySelector('.webtm-full-btn').disabled=true"),(False,"document.querySelector('.webtm-min-box').setAttribute('aria-disabled','true')"),(True,"document.querySelector('.webtm-full-btn').style.pointerEvents='none'")]:
        load(expanded=expanded)
        page.evaluate(patch)
        assert run()['reason']=='disabled_control'
        assert page.evaluate('bubbleClicks===0&&expandClicks===0&&nativeCalls===0')
    for expanded in [False,True]:
        load(expanded=expanded)
        page.evaluate("const w=document.querySelector('#webtm-wrapper'),f=document.createElement('form');w.before(f);f.append(w)")
        assert run()['reason']=='form_control'
        assert page.evaluate('bubbleClicks===0&&expandClicks===0&&nativeCalls===0&&submitEvents===0')
    passed('disabled controls and controls inside forms never click or submit')

    load(expanded=False)
    page.evaluate("document.querySelector('.webtm-min-box').onclick=()=>bubbleClicks++;undefined")
    for _ in range(3):
        assert run()['reason']=='widget_expanding'
    assert page.evaluate('bubbleClicks===1&&expandClicks===0&&nativeCalls===0'),page.evaluate('({bubbleClicks,expandClicks,nativeCalls})')
    load(expanded=False)
    page.evaluate("document.querySelector('.webtm-min-box').hidden=true")
    assert run()['reason']=='launcher_loading'
    assert page.evaluate('bubbleClicks===0&&nativeCalls===0')
    passed('slow or unavailable launcher is not repeatedly clicked')

    for patch in ["delete window.open", "Object.defineProperty(window,'open',{configurable:true,enumerable:false,get(){window.getterReads=(window.getterReads||0)+1;return function(){nativeCalls++}},set(value){window.setterWrites=(window.setterWrites||0)+1}})", "Object.defineProperty(window,'open',{configurable:false,enumerable:false,writable:true,value:window.open})", "Object.defineProperty(window,'open',{configurable:true,enumerable:false,writable:false,value:window.open})"]:
        load()
        page.evaluate(patch+";window.beforeOpen=Object.getOwnPropertyDescriptor(window,'open')")
        assert run()['ok']
        assert restored()
        assert page.evaluate('nativeCalls===0&&!(window.getterReads||window.setterWrites)')
    load()
    page.evaluate("Object.defineProperty(window,'open',{configurable:false,writable:false,value:window.open});window.beforeOpen=Object.getOwnPropertyDescriptor(window,'open')")
    assert run()['reason']=='open_not_interceptable'
    assert restored()
    assert page.evaluate('expandClicks===0&&nativeCalls===0')
    passed('exact data, accessor and absent open descriptors are restored; immutable descriptors fail before click')

    for handler,reason in [
        ("expandClicks++;window.open(fixtureURL);window.open(fixtureURL)",'ambiguous_open'),
        ("expandClicks++",'no_capture'),
        ("expandClicks++;window.open(fixtureURL);throw new Error('Synthetic handler failure')",'expand_failed'),
        ("expandClicks++;window.open({toString(){window.coerced=true;return fixtureURL}})",'no_capture'),
    ]:
        load()
        page.evaluate('(body)=>document.querySelector(".webtm-full-btn").onclick=new Function(body)',handler)
        result=run()
        assert result['reason']==reason,result
        assert 'fixture-auth-token' not in str(result)
        assert restored()
        assert page.evaluate('expandClicks===1&&nativeCalls===0&&!window.coerced')
        assert run()['reason']=='attempt_consumed'
        assert page.evaluate('expandClicks===1')
    passed('multiple opens, missing open, thrown handler and non-string URL fail generically and consume the attempt')

    invalid=[
        'https://attacker.example/super-tm/#fixture-auth-token',
        'https://webim.made-in-china.com.attacker.example/super-tm/#fixture-auth-token',
        'http://webim.made-in-china.com/super-tm/#fixture-auth-token',
        'https://user:pass@webim.made-in-china.com/super-tm/#fixture-auth-token',
        'https://webim.made-in-china.com:443/super-tm/#fixture-auth-token',
        'https://webim.made-in-china.com:8443/super-tm/#fixture-auth-token',
        '/super-tm/#fixture-auth-token',
        'https://webim.made-in-china.com/other/#fixture-auth-token',
        'https://webim.made-in-china.com/super-tm/',
        'https://webim.made-in-china.com/super-tm/#/',
        'https://webim.made-in-china.com/super-tm/#/login',
        'https://webim.made-in-china.com/super-tm/#/%6cogin?data=fixture-auth-token',
        'https://webim.made-in-china.com/super-tm/#/LOGIN?data=fixture-auth-token',
        'https://webim.made-in-china.com/super-tm/#%E0%A4%A',
        'https://webim.made-in-china.com/super-tm/#fixture-auth-token\n',
        'https://webim.made-in-china.com/super-tm/#'+'x'*4096,
    ]
    for url in invalid:
        load()
        page.evaluate('(url)=>fixtureURL=url',url)
        result=run()
        assert result['ok'] is False and result['status']=='blocked',result
        assert 'fixture-auth-token' not in str(result)
        assert 'url' not in result
        assert restored()
        assert page.evaluate('nativeCalls===0')
    passed('wrong origins, paths, credentials, ports, login/empty/malformed fragments and oversized URLs fail without leaking captured values')

    load()
    page.evaluate("document.querySelector('.webtm-full-btn').onclick=()=>{expandClicks++;queueMicrotask(()=>window.open(fixtureURL));};undefined")
    result=run()
    assert result['reason']=='no_capture'
    assert restored()
    assert run()['reason']=='attempt_consumed'
    # The fixture's delayed site callback runs after restoration. No real window
    # opens because the original is a local spy. Production requires a verified
    # synchronous site handler; this function must not retain a global hook.
    assert page.evaluate('expandClicks===1&&nativeCalls===1')
    passed('asynchronous-only site handler is rejected without retry or a lingering global open hook')

    assert len(context.pages)==1
    browser.close()

print(f'{checks} MIC chat launch browser checks passed')
