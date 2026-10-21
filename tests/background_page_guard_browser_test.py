"""Test the production navigation preload before real page startup scripts.

Every URL is fulfilled by local fixtures. CDP runs in the page's normal MAIN
world; adding a script after load would not exercise the startup-popup race.
This test checks suppression of popup creation, not native OS focus behavior.
"""
import os
from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
STORE='https://shop.1688.com/'
CHILD='https://air.1688.com/child-fixture'
FOREIGN='https://foreign.example/frame'
CHAT='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?touid=synthetic'
SOURCE=subprocess.check_output(['node','--input-type=module','-e',
    "import {backgroundGuardSource} from './extension/lib/background-page-guard.js';process.stdout.write(backgroundGuardSource('1688.com'));"],cwd=ROOT,text=True)
GUARD="document[Symbol.for('openlinks.outreach.popup-guard.v1')]"


with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--site-per-process'])
    context=browser.new_context()
    held=[]
    def fixture(route):
        if route.request.url=='https://pending.1688.com/':
            held.append(route)
            return
        if route.request.url==FOREIGN:
            body='<script>window.foreignReady=true;</script>'
        else:
            body=f'''<!doctype html><script>
            window.guardedBeforeFirstScript=!!{GUARD};
            window.popupResult=window.open({CHAT!r},'_blank');
            window.focus();
            </script>'''
            if route.request.url==STORE:
                body+=f'<iframe src="{CHILD}"></iframe><iframe src="{FOREIGN}"></iframe>'
        route.fulfill(body=body,content_type='text/html')
    context.route('**/*',fixture)
    page=context.new_page()
    cdp=context.new_cdp_session(page)
    cdp.send('Page.enable')
    result=cdp.send('Page.addScriptToEvaluateOnNewDocument',{'source':SOURCE})
    page.goto(STORE)
    page.wait_for_function('frames.length===2')
    child=next(frame for frame in page.frames if frame.url==CHILD)
    foreign=next(frame for frame in page.frames if frame.url==FOREIGN)
    for frame in [page,child]:
        assert frame.evaluate('guardedBeforeFirstScript===true&&popupResult===null')
        assert frame.evaluate(f'{GUARD}.urls')==[CHAT]
    assert foreign.evaluate('foreignReady&&'+GUARD+'===undefined')
    assert len(context.pages)==1
    print('PASS initial storefront and same-platform iframe popups are intercepted before their first script; unrelated frame is untouched',flush=True)

    # The preload remains effective through another same-tab navigation, so a
    # redirect/new document cannot run its first popup before the guard.
    page.goto('https://another.1688.com/')
    assert page.evaluate('guardedBeforeFirstScript&&popupResult===null')
    assert len(context.pages)==1
    print('PASS subsequent same-tab navigation is guarded before startup scripts',flush=True)

    # The worker releases CDP before native-input.js needs its own attachment.
    # Removing the registration must not erase the current document's guard or
    # the popup URL which the worker will drain after readiness verification.
    cdp.send('Page.removeScriptToEvaluateOnNewDocument',{'identifier':result['identifier']})
    cdp.detach()
    assert page.evaluate(f'{GUARD}.urls')==[CHAT]
    page.evaluate(f"setTimeout(()=>{{window.delayedResult=window.open({CHAT!r},'_blank');window.delayedDone=true;}},20)")
    page.wait_for_function('window.delayedDone===true')
    assert page.evaluate('delayedResult===null')
    assert page.evaluate(f'{GUARD}.urls')==[CHAT]
    assert len(context.pages)==1
    print('PASS debugger detachment retains current-document captures and blocks delayed popup creation',flush=True)

    cdp=context.new_cdp_session(page)
    cdp.send('Page.enable')
    registration=cdp.send('Page.addScriptToEvaluateOnNewDocument',{'source':SOURCE})
    with page.expect_request('https://pending.1688.com/'):
        page.evaluate("location.href='https://pending.1688.com/'")
    page.wait_for_timeout(30)
    assert held
    cdp.send('Page.stopLoading')
    cdp.send('Page.removeScriptToEvaluateOnNewDocument',{'identifier':registration['identifier']})
    cdp.detach()
    try:
        held[0].fulfill(body='<script>window.lateNavigationRan=true;window.open("https://air.1688.com/late-popup");</script>',content_type='text/html')
    except Exception:
        pass  # Chrome may already have discarded the cancelled request.
    page.wait_for_timeout(50)
    assert page.url=='https://another.1688.com/'
    assert page.evaluate('window.lateNavigationRan!==true')
    assert len(context.pages)==1
    print('PASS cancellation stops pending navigation before removing preload and detaching; late response cannot run an unguarded startup popup',flush=True)
    browser.close()
