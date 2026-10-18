"""Read-only reader checks in real Chromium using synthetic pages only.
No vendor request, live session, or actual conversation is used in this suite.
"""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = (ROOT / 'tests/fixtures/dialogs-synthetic.html').read_text()
OBSERVED_1688 = (ROOT / 'tests/fixtures/dialogs-1688-observed-structure.html').read_text()
OBSERVED_ALIBABA = (ROOT / 'tests/fixtures/dialogs-alibaba-observed-structure.html').read_text()
OBSERVED_MIC = (ROOT / 'tests/fixtures/dialogs-mic-observed-structure.html').read_text()
READER = ROOT / 'extension/dialogs-content.js'
checks = 0
TRANSPORT = """
window.readerListeners=[];
window.chrome={runtime:{id:'dialogs-reader-test',onMessage:{addListener(listener){readerListeners.push(listener)}}}};
window.readerRequest=(sender='dialogs-reader-test')=>new Promise(resolve=>readerListeners.at(-1)({type:'DIALOGS_SNAPSHOT'},{id:sender},resolve));
"""

def passed(name):
    global checks
    checks += 1
    print('PASS '+name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True)
    context = browser.new_context(viewport={'width':1280,'height':1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    requests = []
    page.on('request', lambda request: requests.append(request.url))
    page.add_init_script(TRANSPORT)
    def load(html=FIXTURE,url='https://air.1688.com/chat'):
        context.unroute('**/*')
        context.route('**/*', lambda route: route.fulfill(body=html if route.request.url==url else '<!doctype html><title>Synthetic empty frame</title>', content_type='text/html'))
        page.goto(url)
        page.add_script_tag(path=str(READER))
    def snapshot(): return page.evaluate('OpenLinksDialogsReader.snapshot()')
    def active(result=None): return next(item for item in (result or snapshot())['conversations'] if item['active'])
    def set_history(html): page.evaluate('(html)=>document.querySelector("[data-message-history]").innerHTML=html',html)
    def observe_without_effects():
        before = page.evaluate('({html:document.documentElement.outerHTML,focus:document.activeElement.tagName,draft:document.querySelector("textarea")?.value,events:{...readerSideEffects}})')
        request_count=len(requests)
        page.evaluate('''() => { window.readerMutations=[];window.readerObserver=new MutationObserver(records=>readerMutations.push(...records.map(r=>r.type)));readerObserver.observe(document.documentElement,{childList:true,subtree:true,attributes:true,characterData:true}); }''')
        first=snapshot();second=page.evaluate('readerRequest()')
        page.wait_for_timeout(40)
        after=page.evaluate('({html:document.documentElement.outerHTML,focus:document.activeElement.tagName,draft:document.querySelector("textarea")?.value,events:{...readerSideEffects}})')
        mutations=page.evaluate('readerMutations');page.evaluate('readerObserver.disconnect()')
        assert first==second and before==after and not mutations and len(requests)==request_count
        return first

    for platform,url in [('1688','https://air.1688.com/chat'),('alibaba','https://onetalk.alibaba.com/message/weblite.htm'),('mic','https://webim.made-in-china.com/super-tm/')]:
        load(url=url)
        result=observe_without_effects();current=active(result)
        assert result['status']=='ready' and result['platform']==platform
        assert current['id']=='account:synthetic-buyer/thread:thread-active' and current['identityReliable']
        assert current['tailKnown'] and current['orderReliable'] and current['unread'] is False
        assert [m['direction'] for m in current['messages']]==['outbound','inbound']
        assert current['messages'][0]['at']==1792314000000 and current['messages'][-1]['text']=='We have stock.'
        assert len(result['conversations'])==2
        preview=next(item for item in result['conversations'] if not item['active'])
        assert preview['unread'] is True and preview['needsRead'] and preview['messages']==[] and not preview['tailKnown']
        assert preview['preview']=='Second supplier preview only.'
        assert preview['id']!=current['id'] and preview['title']==current['title']
        passed(platform+': stable thread/account IDs, explicit message directions, separate unread previews, no actions or mutations')

    load();before=snapshot()['documentToken'];page.add_script_tag(path=str(READER))
    assert snapshot()['documentToken']==before and page.evaluate('readerListeners.length')==1
    assert page.evaluate("readerRequest('untrusted-extension')")['status']=='error'
    load();assert snapshot()['documentToken']!=before
    passed('document token is stable until navigation; repeat injection and foreign sender cannot cause duplicate handling')

    load();page.evaluate('document.querySelectorAll("[data-message-preview]")[1].insertAdjacentHTML("beforeend", "<span hidden>Hidden metadata</span>")')
    assert next(row for row in snapshot()['conversations'] if not row['active'])['preview']=='Second supplier preview only.'
    passed('list preview captures visible text without hidden descendants')

    load();set_history('''<div data-message-id="one" class="message-item incoming">Supplier text <blockquote class="outgoing"><span data-message-id="quoted" class="message-item outgoing">Quoted buyer text</span></blockquote></div><div class="message-item" data-message-id="two"><span class="incoming">No direction on message row</span></div><div class="message-item incoming" data-direction="outbound" data-message-id="three">Conflicting attributes</div>''')
    messages=active()['messages'];assert len(messages)==3
    assert messages[0]['text']=='Supplier text' and [message['direction'] for message in messages]==['inbound','unknown','unknown']
    passed('quoted directions and nested messages cannot change sender; missing or conflicting direction stays unknown')

    load();set_history('<div class="message-item constructor" data-message-id="safe" data-direction="__proto__">Unrecognized metadata</div>')
    assert active()['messages'][0]['direction']=='unknown' and page.evaluate('readerRequest()')['status']=='ready'
    passed('prototype-like class/attribute values remain unknown strings and cannot poison serialized sender metadata')

    load();set_history('''<div class="message-item incoming" data-message-id="same">OK</div><div class="message-item incoming" data-message-id="same">OK</div><div class="message-item incoming" data-message-id="different">OK</div>''')
    assert len(active()['messages'])==2 and active()['orderReliable']
    page.evaluate('document.querySelectorAll(".message-item")[1].textContent="Changed"')
    assert not active()['orderReliable']
    passed('exact DOM duplicate message IDs deduplicate; identical text with different IDs remains; conflicting IDs block reliable ordering')

    load();set_history(''.join(f'<div class="message-item incoming" data-message-id="m{i}">Line {i}</div>' for i in range(12)))
    assert not active()['tailKnown']
    page.evaluate('const h=document.querySelector("[data-message-history]");h.scrollTop=h.scrollHeight')
    assert active()['tailKnown']
    page.evaluate('document.querySelector("[data-message-history]").insertAdjacentHTML("beforeend", "<div class=history-loading>Loading history</div>")')
    assert not active()['tailKnown']
    passed('scrolling above newest messages and visible history loaders cannot claim current tail')

    load();page.evaluate('document.querySelector("[data-message-history]").style.cssText="display:flex;flex-direction:column-reverse;height:400px"')
    assert not active()['orderReliable']
    load();page.evaluate('document.querySelector(".message-item").style.order="2"')
    assert not active()['orderReliable']
    passed('reverse flex and CSS reordering cannot masquerade as chronological message order')

    load();page.evaluate('document.querySelector("[data-chat-root]").insertAdjacentHTML("beforeend", "<div data-message-history style=display:none><div class=message-item data-direction=inbound>Hidden old history</div></div>");document.querySelector("[data-message-history]").insertAdjacentHTML("beforeend", "<div class=message-item data-message-id=hidden data-direction=inbound hidden>Hidden message</div>")')
    assert len(active()['messages'])==2 and active()['tailKnown']
    page.evaluate('document.querySelector("[data-chat-root]").style.opacity="0"')
    assert all(not row['active'] for row in snapshot()['conversations'])
    passed('hidden ancestors, messages and histories never count as visible conversation content')

    for html,status in [('<div id=captcha>Verify</div>','captcha'),('<input type=password>','login'),('<div data-login-required=true>Login</div>','login')]:
        load(FIXTURE+html);result=observe_without_effects();assert result['status']==status and result['conversations']==[]
    passed('CAPTCHA and login block readings and never click, type, or close overlays')

    load(FIXTURE,'https://webim.made-in-china.com/super-tm/#/login')
    assert snapshot()['status']=='login'
    passed('hash-based MIC login route blocks cached conversation content')

    load('<!doctype html><div class=messages-loading>Loading</div>')
    assert snapshot()['status']=='loading'
    load('<!doctype html><h1>Supplier title</h1><div role=log><div class="message-item incoming">No stable recipient ID</div></div>')
    assert snapshot()['status']=='unsupported' and snapshot()['conversations']==[]
    passed('loading and unidentified layouts are explicit states; names and message positions never become thread IDs')

    minimal='<!doctype html><div role=log><div class="message-item incoming" data-message-id=one>Recipient from URL</div></div>'
    load(minimal,'https://air.1688.com/chat?touid=cnSynthetic&access_token=private')
    assert active()['id'].endswith('/peer:cnSynthetic') and not active()['identityReliable'] and 'private' not in active()['url'] and snapshot()['url']==page.url and active()['tailKnown']
    unscoped_id=active()['id']
    load(minimal,'https://air.1688.com/chat?touid=cnSynthetic&access_token=private')
    assert active()['id']!=unscoped_id and not active()['identityReliable']
    load(minimal+'<div role=log><div class="message-item incoming">Another window</div></div>','https://air.1688.com/chat?touid=cnSynthetic')
    assert snapshot()['status']=='unsupported'
    passed('unscoped recipient query is document-local and cannot authorize replies; transport URL is exact and stored URL strips secrets')

    load(FIXTURE.replace('data-thread-id="thread-active"','data-thread-id="'+('x'*257)+'"'))
    assert all(not row['active'] for row in snapshot()['conversations'])
    load(FIXTURE.replace('data-thread-id="thread-active"','data-thread-id="bad&#10;id"'))
    assert all(not row['active'] for row in snapshot()['conversations'])
    passed('unbounded and control-character IDs are rejected instead of silently truncating/colliding')

    load();set_history('<div class="message-item incoming" data-message-id=attachment><img alt="Product attachment"></div>')
    assert not active()['orderReliable'] and active()['messages']==[]
    passed('unreadable attachment rows invalidate order rather than exposing an earlier message as last')

    load();page.evaluate('document.querySelector("[data-chat-root]").outerHTML+=document.querySelector("[data-chat-root]").outerHTML')
    assert len([row for row in snapshot()['conversations'] if row['active']])==1
    assert not active()['orderReliable'] and not active()['tailKnown']
    passed('duplicate histories for one recipient fail closed rather than merging ambiguous windows')

    load(FIXTURE+'<iframe src="https://air.1688.com/frame?channel=synthetic#active"></iframe><iframe hidden src="https://air.1688.com/hidden"></iframe><iframe src="https://unrelated.test/"></iframe>')
    result=snapshot();assert result['frames']==[{'url':'https://air.1688.com/frame?channel=synthetic#active','visible':True},{'url':'https://air.1688.com/hidden','visible':False}]
    passed('frame discovery reports visibility and accepts same-platform HTTPS URLs only')

    load();page.evaluate('document.querySelector("[data-message-history]").insertAdjacentHTML("beforeend", "<div class=unrecognized-bubble>New but unknown row</div>")')
    assert not active()['orderReliable']
    load();page.evaluate('document.querySelector("[data-message-history]").insertAdjacentHTML("beforeend", "<img alt=unknown-attachment>")')
    # A visible media box without message semantics also prevents claiming order.
    page.evaluate('document.querySelector("[data-message-history] img").style.cssText="display:block;width:50px;height:50px"')
    assert not active()['orderReliable']
    passed('partially matched transcript text and attachments cannot make an earlier recognized row the apparent newest message')

    load();set_history('<div class="message-item incoming" data-message-id="long">'+('x'*12001)+'</div>')
    assert len(active()['messages'][0]['text'])==12000 and not active()['orderReliable']
    passed('truncated message body is bounded and cannot become a reply target')

    load();set_history(''.join(f'<div class="message-item incoming" data-message-id="m{i}">Line {i}</div>' for i in range(505)))
    assert len(active()['messages'])==500 and not active()['orderReliable']
    passed('bounded message snapshot retains at most 500 rows and marks truncated order unreliable')

    def open_first(changes=None):
        row=next(item for item in snapshot()['conversations'] if item.get('canSelect') and item['unread'] is True)
        request={'conversationId':row['id'],'documentToken':snapshot()['documentToken'],'selectionToken':row['selectionToken']}
        request.update(changes or {})
        return page.evaluate('(request)=>OpenLinksDialogsReader.openConversation(request)',request),request

    load(OBSERVED_1688);result=observe_without_effects()
    assert len(result['conversations'])==2 and result['conversations'][0]['unread'] is True and result['conversations'][1]['unread'] is False
    assert all(row['identityReliable'] and row['needsRead'] and row['canSelect'] for row in result['conversations'])
    assert result['conversations'][0]['id']=='thread:900000001.1-900000002.1#11152@cntaobao'
    assert result['conversations'][0]['preview']=='Do you need a sample?'
    opened,request=open_first();assert opened['ok'] and opened['openedId']==request['conversationId']
    assert page.evaluate('selectedThreads')==['900000001.1-900000002.1#11152@cntaobao']
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.openConversation(request)',request)['ok']
    assert page.evaluate('readerSideEffects')=={'click':1,'input':0,'change':0,'submit':0,'focus':0}
    assert page.evaluate('document.querySelector("pre.edit").textContent')==''
    passed('observed 1688 inbox IDs/unread/previews grant one guarded sidebar click without editor or send interaction')

    for changes in [{'documentToken':'stale'},{'selectionToken':'forged'},{'conversationId':'thread:another'}]:
        load(OBSERVED_1688);opened,_=open_first(changes);assert not opened['ok'] and page.evaluate('selectedThreads')==[]
    load(FIXTURE);assert all(not row.get('canSelect') for row in snapshot()['conversations'])
    passed('stale tokens, mismatched recipient and generic unverified rows cannot authorize selection')

    for script in ['document.querySelector("pre.edit").textContent="Buyer draft"','document.querySelector("pre.edit").focus()']:
        load(OBSERVED_1688);page.evaluate(script);opened,_=open_first()
        assert not opened['ok'] and opened['busy'] and page.evaluate('selectedThreads')==[]
    load(OBSERVED_1688);page.mouse.click(800,800);opened,_=open_first()
    assert not opened['ok'] and opened['busy'] and snapshot()['busy']['recentUserInput']
    passed('existing draft, focused editor and recent trusted user interaction block automatic conversation changes')

    load(OBSERVED_1688);page.evaluate('document.querySelector(".conversation-item").outerHTML+=document.querySelector(".conversation-item").outerHTML')
    opened,_=open_first();assert not opened['ok'] and page.evaluate('selectedThreads')==[]
    load(OBSERVED_1688);row=snapshot()['conversations'][0];request={'conversationId':row['id'],'documentToken':snapshot()['documentToken'],'selectionToken':row['selectionToken']}
    page.evaluate('document.body.insertAdjacentHTML("beforeend","<div id=captcha>Verify</div>")')
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.openConversation(request)',request)['ok'] and page.evaluate('selectedThreads')==[]
    passed('duplicate sidebar rows and a CAPTCHA appearing after snapshot invalidate the selection')

    load(OBSERVED_1688);opened,old_request=open_first();assert opened['ok']
    page.evaluate('document.querySelector(".conversation-item").classList.remove("active");document.querySelector(".conversation-item .desc").textContent="New supplier reply"')
    renewed=snapshot()['conversations'][0];assert renewed['canSelect'] and renewed['selectionToken']!=old_request['selectionToken']
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.openConversation(request)',old_request)['ok']
    opened,new_request=open_first();assert opened['ok'] and new_request['selectionToken']!=old_request['selectionToken']
    assert len(page.evaluate('selectedThreads'))==2
    passed('new preview on the same DOM row renews one selection permit while the previous request remains invalid')

    load(OBSERVED_1688,'https://air.1688.com/chat?touid=oldRecipient')
    assert all(not row['active'] for row in snapshot()['conversations'])
    passed('full 1688 inbox never assigns the old touid URL to an unverified current transcript')

    history_1688='''<div class="message-item-line"><div class="message-item self"><div class="item self"><img class="headPic self" src="data:image/png;base64,c2VsZg=="><div><div class="first-line self"><div class="nick self">Synthetic buyer</div><div class=time>09:00</div></div><div class="content-row self"><div class="content self"><pre class=edit contenteditable=false>Do you have model A?</pre></div></div></div></div></div></div>
    <div class="message-item-line"><div class="content message-item-system">Chat system notice</div></div>
    <div class="message-item-line"><div class=message-item><div class=item><img class=headPic src="data:image/png;base64,c3ludGhldGlj"><div><div class=first-line><div class=nick>Synthetic supplier</div><div class=time>09:01</div></div><div class=content-row><div class=content><pre class=edit contenteditable=false>We have stock.</pre></div></div></div></div></div></div>'''
    def load_active1688(html=history_1688):
        load(OBSERVED_1688)
        page.evaluate('(html)=>{document.querySelector(".conversation-item").classList.add("active");document.querySelector(".message-list").innerHTML="<div class=rc-scrollbars-view>"+html+"</div>"}',html)
    load_active1688();current=active();assert not current['tailKnown'] and current['identityReliable']
    page.wait_for_timeout(1100);current=active();assert current['tailKnown'] and current['orderReliable']
    assert [message['direction'] for message in current['messages']]==['outbound','system','inbound']
    assert current['messages'][-1]['text']=='We have stock.' and not current.get('canSelect')
    assert snapshot()['busy']['hasDraft'] is False
    passed('observed 1688 active composite thread reads noneditable PRE text, system rows and layered sender evidence after stable history')

    page.evaluate('document.querySelector(".message-item:not(.self) .headPic").src="data:image/png;base64,b3RoZXI="')
    assert active()['messages'][-1]['direction']=='unknown'
    load_active1688();page.evaluate('document.querySelector(".message-item:not(.self) .nick").textContent="Someone else"')
    assert active()['messages'][-1]['direction']=='unknown'
    load_active1688();page.evaluate('document.querySelector(".first-line.self").classList.remove("self")')
    assert active()['messages'][0]['direction']=='unknown'
    passed('1688 mismatched avatar/name or incomplete self markers cannot infer incoming/outgoing direction')

    load_active1688(history_1688.replace('We have stock.','<span>Product information</span>').replace('<pre class=edit contenteditable=false><span>Product information</span></pre>','<div class=file-msg><div class=file-name>synthetic-specification.xlsx</div><div class=file-operation>Download</div></div>'))
    current=active();page.wait_for_timeout(1100);current=active()
    assert not current['tailKnown'] and current['messages'][-1]['direction']=='unknown' and 'содержимое не прочитано' in current['messages'][-1]['text']
    passed('1688 attachment records remain explicit unread-content placeholders and prevent drafting')

    load_active1688();page.evaluate('const history=document.querySelector(".message-list"),wrapper=document.createElement("div");wrapper.className="ww_message";history.parentElement.insertBefore(wrapper,history);wrapper.append(history);history.style.cssText="height:40px;overflow:hidden";document.querySelector(".rc-scrollbars-view").insertAdjacentHTML("afterbegin","<div><span>暂无更多消息</span></div>")')
    active();page.wait_for_timeout(1100);current=active();assert current['orderReliable'] and current['readComplete']
    page.evaluate('document.querySelector(".rc-scrollbars-view > div:first-child > span").textContent="Unrecognized new content"')
    assert not active()['orderReliable']
    passed('1688 exact observed history-boundary label is excluded, unknown boundary text is blocked, and only the real inner scroller gates tail')

    load_active1688();page.evaluate('const history=document.querySelector(".message-list"),wrapper=document.createElement("div");wrapper.className="ww_message";history.parentElement.insertBefore(wrapper,history);wrapper.append(history);document.querySelector(".rc-scrollbars-view").style.cssText="height:120px;overflow-y:auto";document.querySelector(".conversation-item").classList.remove("active")')
    opened,request=open_first();assert opened['ok']
    assert not active()['historyStable'] and not page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)['ok']
    page.wait_for_timeout(1100);current=active();assert current['historyStable'] and not current['readComplete']
    effects=page.evaluate('({...readerSideEffects})');request_count=len(requests)
    revealed=page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)
    assert revealed['ok'] and revealed['revealedId']==request['conversationId']
    assert active()['readComplete'] and active()['tailKnown'] and page.evaluate('document.querySelector(".rc-scrollbars-view").scrollTop')>0
    assert page.evaluate('readerSideEffects')==effects and len(requests)==request_count and page.evaluate('document.querySelector(".ww_input pre").textContent')==''
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)['ok']
    passed('authorized 1688 reveal waits for stable selected history and scrolls only its real inner viewer once without editor actions or requests')

    load(OBSERVED_ALIBABA,'https://message.alibaba.com/message/default.htm');result=observe_without_effects()
    assert len(result['conversations'])==2 and all(row['identityReliable'] and row['canSelect'] for row in result['conversations'])
    assert result['conversations'][0]['id']=='thread:910000001-910000009#11011@icbu'
    assert result['conversations'][0]['unread'] is True and result['conversations'][1]['unread'] is False
    assert result['conversations'][0]['preview']=='We can provide a sample.'
    opened,old_request=open_first();assert opened['ok'] and page.evaluate('selectedThreads')==['910000001-910000009#11011@icbu']
    assert page.evaluate('readerSideEffects')=={'click':1,'input':0,'change':0,'submit':0,'focus':0}
    page.evaluate('const row=document.querySelector(".contact-item-container");row.classList.remove("selected");row.setAttribute("data-lastmsg-id","920000003")')
    renewed=snapshot()['conversations'][0];assert renewed['canSelect'] and renewed['selectionToken']!=old_request['selectionToken']
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.openConversation(request)',old_request)['ok']
    passed('observed Alibaba composite IDs and unread count drive selection; supplier read receipt is excluded; new message ID renews token')

    load(OBSERVED_ALIBABA.replace('910000001-910000009#11011@icbu','invalid-cid'),'https://message.alibaba.com/message/default.htm')
    assert len(snapshot()['conversations'])==1
    load(OBSERVED_ALIBABA,'https://shop.1688.com/')
    assert snapshot()['status']=='unsupported' and snapshot()['conversations']==[]
    passed('invalid Alibaba composite IDs and cross-platform lookalike markup grant no identity or selection capability')

    load(OBSERVED_MIC,'https://webim.made-in-china.com/super-tm/');result=observe_without_effects()
    first=result['conversations'][0];assert first['id'].endswith('/peer:synthetic-peer-with-hyphens') and first['identityReliable'] and first['canSelect']
    assert first['unread'] is True and result['conversations'][1]['unread'] is False and first['preview']=='Which quantity do you need?'
    opened,_=open_first();assert opened['ok'] and page.evaluate('selectedThreads')==['friend-PERSON-synthetic-peer-with-hyphens']
    assert page.evaluate('closedThreads')==0 and page.evaluate('readerSideEffects')=={'click':1,'input':0,'change':0,'submit':0,'focus':0}
    old_id=first['id'];load(OBSERVED_MIC,'https://webim.made-in-china.com/super-tm/')
    assert snapshot()['conversations'][0]['id']!=old_id
    passed('observed MIC preserves complete peer suffix, uses document-local identity, and selects only the row without its close control')

    before=snapshot();row=before['conversations'][0];old_request={'conversationId':row['id'],'documentToken':before['documentToken'],'selectionToken':row['selectionToken']}
    page.evaluate('document.body.insertAdjacentHTML("beforeend", "<input id=test-login type=password>")')
    assert snapshot()['status']=='login'
    page.evaluate('document.querySelector("#test-login").remove()')
    after=snapshot();assert after['conversations'][0]['id']!=row['id'] and after['documentToken']==before['documentToken']
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.openConversation(request)',old_request)['ok'] and page.evaluate('selectedThreads')==[]
    passed('witnessed MIC logout/login in the same document starts a new identity epoch and invalidates old permits')

    load('<!doctype html><div class=conversation-lst><div class=ant-skeleton-active>Loading contacts</div></div>','https://webim.made-in-china.com/super-tm/')
    assert snapshot()['status']=='loading'
    passed('observed MIC skeleton contact placeholders are loading, never empty or invented conversations')

    load(OBSERVED_1688);page.evaluate('document.querySelector("pre.edit").focus();Object.defineProperty(document,"hasFocus",{value:()=>false})')
    assert snapshot()['busy']['userEditing'] is False
    opened,_=open_first();assert opened['ok']
    passed('background document retaining automatic editor focus can be monitored when there is no draft or user input')

    history_alibaba='''<div class="message-item-wrapper item-right messenger"><div class="item-content item-content-right"><p class=item-base-info>Buyer metadata</p><div class=user-content><div class="session-rich-content text">Do you have stock?</div><div class=session-translate><div class=target-content>Translation must not be read.</div></div></div><div class="message-flow-menu-box send" style="display:none">Copy</div></div></div>
    <div class="message-item-wrapper item-left-text messenger"><div class="item-content item-content-left"><p class=item-base-info>Supplier metadata</p><div class=user-content><div class="session-rich-content text">Yes, we have stock.</div><div class=session-translate><div class=target-content>Visible translated duplicate.</div></div></div><div class="message-flow-menu-box rec" style="display:none">Copy</div></div></div>
    <div class=message-item-wrapper><div class=session-security-content><span class=session-security-text>Platform security notice</span></div></div>'''
    def load_active_alibaba():
        load(OBSERVED_ALIBABA,'https://message.alibaba.com/message/default.htm')
        page.evaluate('(html)=>{document.querySelector(".contact-item-container").classList.add("selected");document.body.insertAdjacentHTML("beforeend","<div class=buyer-messenger-container><div class=message-box><div class=im-message-flow><div class=scroll-box>"+html+"</div></div></div></div>")}',history_alibaba)
    load_active_alibaba();assert not active()['readComplete'];page.wait_for_timeout(1100);current=active()
    assert current['readComplete'] and current['tailKnown'] and current['orderReliable'] and current['identityReliable']
    assert [message['direction'] for message in current['messages']]==['outbound','inbound','system']
    assert [message['text'] for message in current['messages']]==['Do you have stock?','Yes, we have stock.','Platform security notice']
    assert not current.get('canSelect')
    passed('observed Alibaba selected thread reads original content once, separates system notices, and uses explicit send/rec metadata')

    page.evaluate('document.querySelector(".message-flow-menu-box.rec").classList.add("send")')
    assert active()['messages'][1]['direction']=='unknown'
    load_active_alibaba();page.evaluate('document.querySelector(".item-left-text .message-flow-menu-box").remove()')
    assert active()['messages'][1]['direction']=='unknown'
    passed('Alibaba contradictory or missing send/rec markers cannot infer sender from visual alignment')

    load_active_alibaba();page.evaluate('const history=document.querySelector(".scroll-box");history.style.cssText="display:flex;flex-direction:column-reverse";for(const row of history.children)row.style.minHeight="100px"')
    active();page.wait_for_timeout(1100);current=active()
    assert current['orderReliable'] and [message['direction'] for message in current['messages']]==['system','inbound','outbound']
    assert current['messages'][-1]['text']=='Do you have stock?'
    passed('observed Alibaba column-reverse history is normalized to oldest-first only when row geometry confirms the reversed DOM order')

    load_active_alibaba();page.evaluate('const history=document.querySelector(".scroll-box"),scroller=document.createElement("div");scroller.className="common-load-more";scroller.style.cssText="overflow-y:auto;height:100px";history.parentElement.insertBefore(scroller,history);scroller.append(history);history.style.minHeight="450px";document.querySelector(".message-box").style.cssText="height:80px;overflow:hidden"')
    active();page.wait_for_timeout(1100);current=active()
    assert not current['readComplete'] and 'прокручена' in current['detail'] and page.evaluate('document.querySelector(".common-load-more").scrollTop')==0
    page.evaluate('const scroller=document.querySelector(".common-load-more");scroller.scrollTop=scroller.scrollHeight')
    assert active()['readComplete'] and active()['tailKnown']
    passed('Alibaba real history scroller gates completion; clipped outer panel is not mistaken for another scroll container and snapshot never scrolls')

    def prepare_alibaba_reveal(programmatic=True):
        load_active_alibaba()
        page.evaluate('document.querySelector(".contact-item-container").classList.remove("selected");const history=document.querySelector(".scroll-box"),scroller=document.createElement("div");scroller.className="common-load-more";scroller.style.cssText="overflow-y:auto;height:100px";history.parentElement.insertBefore(scroller,history);scroller.append(history);history.style.minHeight="450px"')
        if programmatic:
            opened,request=open_first();assert opened['ok']
        else:
            page.evaluate('document.querySelector(".contact-item-container").classList.add("selected")')
            current=active();request={'conversationId':current['id'],'documentToken':snapshot()['documentToken']}
        active();return request
    request=prepare_alibaba_reveal()
    assert not active()['historyStable'] and not page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)['ok']
    page.wait_for_timeout(1100);assert active()['historyStable'] and not active()['readComplete']
    effects=page.evaluate('({...readerSideEffects})')
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest({...request,documentToken:"stale"})',request)['ok']
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest({...request,conversationId:"wrong"})',request)['ok']
    result=page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)
    assert result['ok'] and result['revealedId']==request['conversationId'] and active()['readComplete']
    assert page.evaluate('document.querySelector(".common-load-more").scrollTop')>0 and page.evaluate('readerSideEffects')==effects
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)['ok']
    passed('one authorized Alibaba reveal waits for stable current history, rejects stale IDs/docs, scrolls only the transcript and never clicks or types')

    request=prepare_alibaba_reveal(False);page.wait_for_timeout(1100)
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)['ok'] and page.evaluate('document.querySelector(".common-load-more").scrollTop')==0
    request=prepare_alibaba_reveal();page.wait_for_timeout(1100);page.evaluate('document.querySelector("textarea").value="Buyer draft"')
    result=page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request);assert not result['ok'] and result['busy'] and page.evaluate('document.querySelector(".common-load-more").scrollTop')==0
    request=prepare_alibaba_reveal();page.wait_for_timeout(1100);page.mouse.click(1000,800)
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)['ok'] and page.evaluate('document.querySelector(".common-load-more").scrollTop')==0
    passed('manual-only history, existing draft and trusted user interaction cannot authorize an automatic Alibaba scroll')

    request=prepare_alibaba_reveal();page.evaluate('document.querySelector(".item-left-text .session-rich-content").outerHTML="<div class=unknown-file-card>Unreadable attachment</div>"')
    active();page.wait_for_timeout(1100);current=active();assert current['historyStable'] and not current['orderReliable'] and not current['readComplete']
    assert page.evaluate('(request)=>OpenLinksDialogsReader.revealLatest(request)',request)['ok']
    current=active();assert current['readComplete'] and not current['tailKnown'] and current['needsRead'] and not current['orderReliable']
    passed('confirmed Alibaba scroller can reveal unsupported attachment rows without granting message order or AI eligibility')

    load_active_alibaba();page.evaluate('document.querySelector(".item-left-text .session-rich-content").innerHTML="<img style=width:30px;height:30px alt=attachment>"')
    active();page.wait_for_timeout(1100);current=active()
    assert current['readComplete'] and not current['tailKnown'] and current['needsRead'] and 'содержимое не прочитано' in current['messages'][1]['text']
    passed('fully observed Alibaba media completes traversal while preserving the AI attachment block')

    history_mic='''<div class=msg-list-system-tip>System history notice</div><div class=chat-safe-tip-container>Platform safety notice</div>
    <div class=msg-box><div class=chatTime>09:00</div><div class=contact-chatInfo id=10000000-0000-0000-0000-000000000001><div class=avatar-cover-outer><div class=avatar><img src="data:image/png;base64,bWljcGVlcg=="></div></div><div class=chat-content-box><div class=fromUserName>Synthetic MIC supplier</div><div class=chat-content><div class=chat-txt><div class="en-format-text msg-text">Which quantity do you need?</div></div><div class=chat-operations-box>Translate</div></div></div></div></div>'''
    def load_active_mic():
        load(OBSERVED_MIC,'https://webim.made-in-china.com/super-tm/')
        page.evaluate('(html)=>{document.querySelector(".lst-item").classList.add("active");document.querySelector(".conversation-area").innerHTML="<div class=window-center-messages-main><div class=msg-list>"+html+"</div></div>"}',history_mic)
    load_active_mic();assert not active()['readComplete'];page.wait_for_timeout(1100);current=active()
    assert current['readComplete'] and current['tailKnown'] and current['orderReliable'] and current['identityReliable']
    assert [message['direction'] for message in current['messages']]==['system','system','inbound']
    assert current['messages'][-1]['text']=='Which quantity do you need?' and current['messages'][-1]['id']=='10000000-0000-0000-0000-000000000001'
    passed('observed MIC active thread captures UUID message, original text and positive contact/avatar/name evidence')

    page.evaluate('document.querySelector(".contact-chatInfo .fromUserName").textContent="Different sender"')
    assert active()['messages'][-1]['direction']=='unknown'
    load_active_mic();page.evaluate('document.querySelector(".contact-chatInfo .avatar img").src="data:image/png;base64,b3RoZXI="')
    assert active()['messages'][-1]['direction']=='unknown'
    passed('MIC mismatched sender name or avatar stays unknown despite contact-like row styling')

    assert not errors, errors
    browser.close()
print(f'{checks} read-only dialog browser checks passed', flush=True)
