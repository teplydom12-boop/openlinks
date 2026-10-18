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
MODEL_EVIDENCE = (ROOT / 'extension/chat-model-evidence.js').read_text()
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
        assert current['historyStartKnown'] is False and current['historyComplete'] is False
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
    current=active();assert not current['tailKnown'] and len(current['messages'])==1 and current['coverage']['unreadAttachments']==1
    assert current['messages'][0]['direction']=='inbound' and current['messages'][0]['attachments'][0]['name']=='Product attachment'
    passed('attachment-only message is retained with its proven sender and unread attachment metadata instead of disappearing')

    load();page.evaluate('document.querySelector("[data-chat-root]").outerHTML+=document.querySelector("[data-chat-root]").outerHTML')
    assert len([row for row in snapshot()['conversations'] if row['active']])==1
    assert not active()['orderReliable'] and not active()['tailKnown']
    passed('duplicate histories for one recipient fail closed rather than merging ambiguous windows')

    load(FIXTURE+'<iframe src="https://air.1688.com/frame?channel=synthetic#active"></iframe><iframe hidden src="https://air.1688.com/hidden"></iframe><iframe src="https://unrelated.test/"></iframe>')
    result=snapshot();assert result['frames']==[{'url':'https://air.1688.com/frame?channel=synthetic#active','visible':True},{'url':'https://air.1688.com/hidden','visible':False}]
    passed('frame discovery reports visibility and accepts same-platform HTTPS URLs only')

    load();page.evaluate('document.querySelector("[data-message-history]").insertAdjacentHTML("beforeend", "<div class=unrecognized-bubble>New but unknown row</div>")')
    current=active();assert not current['orderReliable'] and current['messages'][-1]['text']=='New but unknown row' and current['messages'][-1]['direction']=='unknown'
    assert current['coverage']['unmatchedTextNodes']==1 and current['coverage']['unsupportedMessages']==1
    load();page.evaluate('document.querySelector("[data-message-history]").insertAdjacentHTML("beforeend", "<img alt=unknown-attachment>")')
    # A visible media box without message semantics also prevents claiming order.
    page.evaluate('document.querySelector("[data-message-history] img").style.cssText="display:block;width:50px;height:50px"')
    current=active();assert not current['orderReliable'] and current['messages'][-1]['attachments'][0]['type']=='image' and current['coverage']['unreadAttachments']==1
    passed('unmatched transcript text and orphan attachments are retained explicitly with coverage gaps rather than silently omitted')

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
    assert current['historyStartKnown'] is False and current['historyComplete'] is False
    passed('observed 1688 active composite thread reads noneditable PRE text, system rows and layered sender evidence after stable history')

    page.evaluate('document.querySelector(".message-item:not(.self) .headPic").src="data:image/png;base64,b3RoZXI="')
    assert active()['messages'][-1]['direction']=='unknown'
    load_active1688();page.evaluate('document.querySelector(".message-item:not(.self) .nick").textContent="Someone else"')
    assert active()['messages'][-1]['direction']=='unknown'
    load_active1688();page.evaluate('document.querySelector(".first-line.self").classList.remove("self")')
    assert active()['messages'][0]['direction']=='unknown'
    passed('1688 mismatched avatar/name or incomplete self markers cannot infer incoming/outgoing direction')

    def prepare_staff_evidence():
        load_active1688()
        page.evaluate('''() => {
          document.querySelector('.message-item:not(.self) .nick').textContent='Synthetic supplier:Synthetic staff';
          const rows=[...document.querySelectorAll('.message-item-line')],threadId=document.querySelector('.conversation-item.active').id;
          const model=(incoming,id)=>({conversationCode:threadId,code:{messageId:id},sender:{targetId:incoming?'900000009':'900000001',targetType:'8'},receiver:{targetId:incoming?'900000001':'900000002',targetType:'8'},ext:{senderUserId:incoming?'900000009':'900000001',senderMainUserId:incoming?'900000002':'900000001',receiverUserId:incoming?'900000001':'900000009',receiverMainUserId:incoming?'900000001':'900000002'},selfState:1,msgType:101});
          Object.defineProperty(rows[0],'__reactProps$synthetic',{value:{message:model(false,'server-outgoing')},configurable:true});
          Object.defineProperty(rows[2],'__reactProps$synthetic',{value:{message:model(true,'server-staff')},configurable:true});
        }''')
        before=snapshot();assert active(before)['messages'][-1]['direction']=='unknown' and before['modelEvidenceToken']
        evidence=page.evaluate(MODEL_EVIDENCE)
        return {'documentToken':before['documentToken'],'modelEvidenceToken':before['modelEvidenceToken'],'evidence':evidence}

    request=prepare_staff_evidence();effects=page.evaluate('({...readerSideEffects})');request_count=len(requests)
    reply=page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence(request)',request)
    assert reply['ok'] and reply['applied']==2
    current=active();assert current['messages'][-1]['direction']=='inbound' and current['messages'][-1]['id']=='server-staff' and current['messages'][0]['id']=='server-outgoing'
    assert current['messages'][-1]['legacyAliases']==[{'text':'We have stock.','direction':'unknown','kind':'model-direction'},{'text':'We have stock.','direction':'inbound','kind':'model-direction'}]
    assert current['coverage']['unknownSenders']==0 and page.evaluate('readerSideEffects')==effects and len(requests)==request_count
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence(request)',request)['ok']
    page.evaluate('document.querySelector(".message-item:not(.self) pre").textContent="New text before fresh model evidence"')
    assert active()['messages'][-1]['direction']=='unknown' and 'id' not in active()['messages'][-1]
    passed('1688 MAIN metadata proves staff sender through exact main-account pair and self-row anchor, applies stable IDs once, and invalidates on DOM change')

    request=prepare_staff_evidence()
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence({...request,documentToken:"wrong"})',request)['ok']
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence({...request,modelEvidenceToken:"wrong"})',request)['ok']
    page.evaluate('document.querySelector(".message-item:not(.self) pre").textContent="Changed after model capture"')
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence(request)',request)['ok']
    request=prepare_staff_evidence();request['evidence']['threadId']='900000001.1-900000099.1#11152@cntaobao'
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence(request)',request)['ok']
    request=prepare_staff_evidence();request['evidence']['rows'][0]['model']['ext']['senderMainUserId']='900000099'
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence(request)',request)['ok']
    assert active()['messages'][-1]['direction']=='unknown'
    passed('model metadata from stale documents/nonces, changed DOM, another thread or an unrelated account never proves staff identity')

    request=prepare_staff_evidence();page.evaluate('document.querySelector(".rc-scrollbars-view").append(document.querySelectorAll(".message-item-line")[2].cloneNode(true))')
    before=snapshot();request['modelEvidenceToken']=before['modelEvidenceToken'];request['evidence']=page.evaluate(MODEL_EVIDENCE)
    reply=page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence(request)',request)
    current=active();assert reply['ok'] and len(current['messages'])==4 and current['messages'][-1]['direction']=='unknown' and current['messages'][-2]['direction']=='unknown'
    assert all('id' not in message for message in current['messages'][-2:])
    passed('identical DOM signatures are ambiguous and cannot collapse two staff messages into one server ID')

    request=prepare_staff_evidence();page.evaluate('document.querySelector(".message-item:not(.self) .nick").textContent="Synthetic supplier"')
    before=snapshot();assert 'modelEvidenceToken' not in before
    # Keep another staff row unknown so collection is requested while one known
    # incoming row contains deliberately contradictory account evidence.
    page.evaluate('document.querySelector(".message-item:not(.self)").setAttribute("data-direction","unknown")')
    before=snapshot();request['modelEvidenceToken']=before['modelEvidenceToken'];request['evidence']=page.evaluate(MODEL_EVIDENCE)
    assert page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence(request)',request)['ok']
    current=active();assert current['messages'][-1]['direction']=='unknown' and 'id' not in current['messages'][-1] and not current['historyOrderReliable']
    passed('explicit ambiguous or conflicting sender metadata cannot be overridden by MAIN evidence or borrow its server ID')

    request=prepare_staff_evidence();page.evaluate('const self=document.querySelector(".message-item.self");self.closest(".message-item-line").remove();const incoming=document.querySelector(".message-item:not(.self)");incoming.insertAdjacentHTML("beforeend","<blockquote class=quoted-message>"+self.outerHTML+"</blockquote>")')
    before=snapshot();request['modelEvidenceToken']=before['modelEvidenceToken'];request['evidence']=page.evaluate(MODEL_EVIDENCE)
    assert not page.evaluate('(request)=>OpenLinksDialogsReader.applyModelEvidence(request)',request)['ok'] and active()['messages'][-1]['direction']=='unknown'
    passed('a quoted nested self message cannot establish the buyer account or reverse staff directions')

    load_active1688(history_1688.replace('We have stock.','<span>Product information</span>').replace('<pre class=edit contenteditable=false><span>Product information</span></pre>','<div class=file-msg><div class=file-name>synthetic-specification.xlsx</div><div class=file-operation>Download</div></div>'))
    current=active();page.wait_for_timeout(1100);current=active()
    assert not current['tailKnown'] and current['messages'][-1]['direction']=='inbound' and 'содержимое не прочитано' in current['messages'][-1]['text']
    assert current['messages'][-1]['attachments']==[{'type':'file','name':'synthetic-specification.xlsx','url':'','text':'','contentRead':False}]
    assert current['coverage']['unreadAttachments']==1 and current['coverage']['unknownSenders']==0
    passed('1688 attachment records retain filename and proven sender independently of unread file contents')

    survey_1688='''<div class=message-item-line><div class="im-template-msg dx-msg-wrap"><div class=tpl-wrapper><div class=FrameLayout_0><div class=FrameLayout_56><div class=LinearLayout_57><div class=LinearLayout_58><div class=FastTextView_59><span>期待您的真实反馈</span></div><div class=LinearLayout_60>'''+''.join('<div class=list-item><div class=LinearLayout_61><div class=FastTextView_63><span>'+label+'</span></div></div></div>' for label in ['很不满','不满','一般','满意','很满意'])+'''</div></div></div></div></div></div></div></div>'''
    load_active1688(history_1688+survey_1688);active();page.wait_for_timeout(1100);current=active()
    assert current['orderReliable'] and current['tailKnown'] and len(current['messages'])==4 and current['messages'][-1]['direction']=='system'
    assert current['messages'][-1]['text']=='期待您的真实反馈 很不满 不满 一般 满意 很满意' and current['coverage']['unsupportedMessages']==0
    page.evaluate('document.querySelector(".FastTextView_59").insertAdjacentHTML("beforeend","<span>Unrecognized additional content</span>")')
    current=active();assert not current['orderReliable'] and current['messages'][-1]['direction']=='unknown' and 'Unrecognized additional content' in current['messages'][-1]['text']
    passed('exact observed 1688 satisfaction survey is preserved as system content; altered or additional content is retained as unknown')

    load_active1688(history_1688+survey_1688);page.evaluate('for(const node of document.querySelectorAll(".im-template-msg,.list-item"))node.style.display="contents"')
    current=active();assert current['messages'][-1]['direction']=='system' and current['coverage']['unsupportedMessages']==0
    assert current['messages'][-1]['legacyAliases'][1]['text']=='暂不支持的消息类型 [Нераспознанный формат сообщения; доступный текст сохранён]'
    passed('1688 survey recognition supports layout wrappers without their own boxes while retaining exact visible labels and narrow correction aliases')

    load_active1688(history_1688+'<div class=message-item-line><div><span>暂不支持的消息类型</span></div></div>');active();page.wait_for_timeout(1100);current=active()
    assert current['historyStable'] and not current['readComplete'] and not current['historyTailKnown'] and 'повторная проверка' in current['detail']
    page.evaluate('(html)=>document.querySelector(".message-item-line:last-child").outerHTML=html',survey_1688)
    active();page.wait_for_timeout(1100);current=active();assert current['readComplete'] and current['messages'][-1]['direction']=='system'
    passed('exact temporary 1688 unsupported-type placeholder keeps traversal pending until the real supported card has loaded and stabilized')

    load_active1688(history_1688+'<div class=message-item-line><div class="im-template-msg dx-msg-wrap"><span>Unrecognized supplier card text</span></div></div>')
    current=active();assert len(current['messages'])==4 and current['messages'][-1]['direction']=='unknown' and 'Unrecognized supplier card text' in current['messages'][-1]['text']
    assert current['messages'][-1]['format']=='unrecognized' and current['coverage']['unsupportedMessages']==1
    passed('new 1688 native card formats are kept as messages with explicit coverage gaps instead of dropped or classified as surveys')

    load_active1688(history_1688+survey_1688);page.evaluate('document.querySelector(".message-item-line:last-child").insertAdjacentHTML("beforeend","<span>Supplier content beside survey</span><img alt=product style=width:30px;height:30px>")')
    current=active();assert current['messages'][-1]['direction']=='unknown' and 'Supplier content beside survey' in current['messages'][-1]['text']
    assert current['coverage']['unreadAttachments']==1 and current['coverage']['unsupportedMessages']==1
    passed('survey recognition cannot swallow adjacent supplier text or product media into a system message')

    load_active1688();page.evaluate('document.querySelector(".message-item:not(.self) .content-row > .content").innerHTML="<div class=file-msg><div class=file-name title=synthetic-catalog.pdf>Catalog</div><div class=file-size>12 KB</div><a class=download-file href=\\\"https://cdn.example.test/catalog.pdf?version=1\\\">Download</a></div>"')
    current=active();attachment=current['messages'][-1]['attachments'][0]
    assert attachment=={'type':'file','name':'synthetic-catalog.pdf','url':'https://cdn.example.test/catalog.pdf?version=1','text':'12 KB','contentRead':False}
    request_count=len(requests);effects=page.evaluate('({...readerSideEffects})');snapshot();snapshot()
    assert len(requests)==request_count and page.evaluate('readerSideEffects')==effects
    passed('1688 file reference preserves name, size and HTTPS URL without clicking download or fetching its contents')

    load_active1688();page.evaluate('const history=document.querySelector(".message-list"),wrapper=document.createElement("div");wrapper.className="ww_message";history.parentElement.insertBefore(wrapper,history);wrapper.append(history);history.style.cssText="height:40px;overflow:hidden";document.querySelector(".rc-scrollbars-view").insertAdjacentHTML("afterbegin","<div><span>暂无更多消息</span></div>")')
    current=active();assert current['historyStartKnown'] and not current['historyComplete']
    page.wait_for_timeout(1100);current=active();assert current['orderReliable'] and current['readComplete'] and current['historyComplete']
    old_fingerprint=current['replyFingerprint']
    page.evaluate('document.querySelector(".rc-scrollbars-view > div:first-child > span").textContent="Unrecognized new content"')
    current=active();assert not current['orderReliable'] and not current['historyStartKnown'] and not current['historyComplete'] and current['replyFingerprint']!=old_fingerprint
    passed('1688 exact observed history-boundary label is excluded, unknown boundary text is blocked, and only the real inner scroller gates tail')

    def complete_1688():
        load_active1688()
        page.evaluate('const history=document.querySelector(".message-list"),wrapper=document.createElement("div");wrapper.className="ww_message";history.parentElement.insertBefore(wrapper,history);wrapper.append(history);document.querySelector(".rc-scrollbars-view").insertAdjacentHTML("afterbegin","<div><span>暂无更多消息</span></div>")')
        active();page.wait_for_timeout(1100)
        assert active()['historyComplete']
    complete_1688()
    page.evaluate('document.querySelector(".rc-scrollbars-view > div:first-child").remove();document.body.insertAdjacentHTML("beforeend","<div class=rc-scrollbars-view><div><span>暂无更多消息</span></div></div>")')
    current=active();assert not current['historyStartKnown'] and not current['historyComplete']
    complete_1688()
    page.evaluate('document.querySelector(".rc-scrollbars-view > div:first-child > span").hidden=true')
    assert not active()['historyStartKnown'] and not active()['historyComplete']
    complete_1688()
    page.evaluate('document.querySelector(".message-item:not(.self) .nick").textContent="Unknown sender"')
    active();page.wait_for_timeout(1100);current=active()
    assert current['historyStartKnown'] and current['readComplete'] and not current['historyComplete']
    complete_1688()
    page.evaluate('document.querySelector(".message-item:not(.self) .content-row > .content").insertAdjacentHTML("beforeend","<img alt=unread-image style=width:32px;height:32px>")')
    active();page.wait_for_timeout(1100);current=active()
    assert current['historyStartKnown'] and current['readComplete'] and not current['historyComplete']
    complete_1688()
    page.evaluate('const body=document.querySelector(".message-item.self .content-row > .content");for(let i=0;i<3001;i++)body.append(document.createElement("span"))')
    current=active();assert current['historyStartKnown'] and current['readComplete'] and not current['historyComplete']
    passed('whole-history proof is scoped to the active native boundary and fails for hidden/foreign markers, unknown senders, unread attachments and DOM traversal bounds')

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

    for html,url in [(OBSERVED_1688,'https://air.1688.com/chat'),(OBSERVED_ALIBABA,'https://message.alibaba.com/message/default.htm'),(OBSERVED_MIC,'https://webim.made-in-china.com/super-tm/')]:
        load(html,url);before=snapshot()
        row=next(item for item in before['conversations'] if item['unread'] is False and item.get('canSelect'))
        request={'conversationId':row['id'],'documentToken':before['documentToken'],'selectionToken':row['selectionToken']}
        result=page.evaluate('(request)=>OpenLinksDialogsReader.openConversation(request)',request)
        assert result['ok'] and result['openedId']==row['id'] and len(page.evaluate('selectedThreads'))==1
        assert page.evaluate('readerSideEffects')=={'click':1,'input':0,'change':0,'submit':0,'focus':0}
    passed('all three native readers may select already-read sidebar rows without composer, send or focus actions')

    load(OBSERVED_MIC,'https://webim.made-in-china.com/super-tm/')
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
    assert current['historyStartKnown'] is False and current['historyComplete'] is False
    assert [message['direction'] for message in current['messages']]==['outbound','inbound','system']
    assert [message['text'] for message in current['messages']]==['Do you have stock?','Yes, we have stock.','Platform security notice']
    assert not current.get('canSelect')
    passed('observed Alibaba selected thread reads original content once, separates system notices, and uses explicit send/rec metadata')

    load_active_alibaba();page.evaluate('document.querySelector(".scroll-box").insertAdjacentHTML("beforeend","<div class=message-item-wrapper><div class=item-content-wrap><div class=\\\"item-system-notice level-1\\\"><div class=notice-container><div class=notice-main><div class=notice-content><span class=notice-text>Synthetic platform notice</span></div></div></div></div></div></div>");document.querySelector(".item-left-text .user-content").insertAdjacentHTML("beforeend","<div class=session-translate><div class=translate-result><p class=target-content>Translated text</p><img class=translate-icon-small style=width:30px;height:30px src=\\\"https://cdn.example.test/platform-translate.png\\\"></div></div>")')
    current=active();assert current['messages'][-1]['direction']=='system' and current['messages'][-1]['text']=='Synthetic platform notice'
    assert current['coverage']['unsupportedMessages']==0 and current['coverage']['attachments']==0 and current['coverage']['unknownSenders']==0
    assert current['messages'][-1]['legacyAliases']==[{'text':'Synthetic platform notice [Нераспознанный формат сообщения; доступный текст сохранён]','direction':'unknown','kind':'platform-ui'}]
    assert current['messages'][1]['legacyAliases']==[{'text':current['messages'][1]['text']+' [Вложение: содержимое не прочитано]','direction':'inbound','kind':'platform-ui','ignoredAttachments':[{'type':'image','name':'','url':'https://cdn.example.test/platform-translate.png'}]},{'text':'[Вложение: содержимое не прочитано]','direction':'unknown','kind':'reader-placeholder'}]
    page.wait_for_timeout(1100);assert active()['tailKnown'] and active()['orderReliable']
    page.evaluate('document.querySelector(".item-left-text .user-content").insertAdjacentHTML("beforeend","<img alt=Actual-product-photo style=width:30px;height:30px src=\\\"https://cdn.example.test/product.png\\\">")')
    current=active();assert current['coverage']['attachments']==1 and current['messages'][1]['attachments'][0]['name']=='Actual-product-photo'
    assert 'legacyAliases' not in current['messages'][1]
    passed('observed Alibaba platform notices remain system messages and translation controls are excluded while real sibling product images are preserved')

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
    assert current['historyStartKnown'] is False and current['historyComplete'] is False
    assert [message['direction'] for message in current['messages']]==['system','system','inbound']
    assert current['messages'][-1]['text']=='Which quantity do you need?' and current['messages'][-1]['id']=='10000000-0000-0000-0000-000000000001'
    passed('observed MIC active thread captures UUID message, original text and positive contact/avatar/name evidence')

    page.evaluate('document.querySelector(".contact-chatInfo .fromUserName").textContent="Different sender"')
    assert active()['messages'][-1]['direction']=='unknown'
    load_active_mic();page.evaluate('document.querySelector(".contact-chatInfo .avatar img").src="data:image/png;base64,b3RoZXI="')
    assert active()['messages'][-1]['direction']=='unknown'
    passed('MIC mismatched sender name or avatar stays unknown despite contact-like row styling')

    load_active_mic();page.evaluate('document.querySelector(".msg-list").insertAdjacentHTML("beforeend","<div class=msg-box><div class=msg-system-box><div class=\\\"msg-inquiry-assign iAmBuyer\\\"><div class=content-inquiry-assign><div class=title-inquiry-assign>Chat assigned to <span class=name>Synthetic colleague</span></div><div>Platform assignment notice</div></div></div></div></div>")')
    current=active();assert current['messages'][-1]['direction']=='system' and 'Synthetic colleague' in current['messages'][-1]['text']
    assert current['coverage']['unsupportedMessages']==0 and current['coverage']['unknownSenders']==0
    assert current['messages'][-1]['legacyAliases'][0]['text']==current['messages'][-1]['text']+' [Нераспознанный формат сообщения; доступный текст сохранён]'
    passed('observed MIC inquiry assignment is retained as platform system content with an exact bounded alias for its former unread-format representation')

    load_active_mic();page.evaluate('document.querySelector(".msg-text").innerHTML="Before <img class=chat-text-sys-emotion title=\\\"[Love]\\\" style=width:24px;height:24px src=\\\"https://webim.made-in-china.com/super-tm/8ede13664ff6b499fc82099056f055fc.gif\\\"><img class=chat-text-sys-emotion title=\\\"[Love]\\\" style=width:24px;height:24px src=\\\"https://webim.made-in-china.com/super-tm/8ede13664ff6b499fc82099056f055fc.gif\\\"> after"')
    current=active();message=current['messages'][-1];assert message['text']=='Before [Love] [Love] after' and 'attachments' not in message and current['coverage']['unreadAttachments']==0
    assert message['legacyAliases'][0]['text']=='Before after [Вложение: содержимое не прочитано]'
    assert message['legacyAliases'][0]['ignoredAttachments']==[{'type':'image','name':'[Love]','url':'https://webim.made-in-china.com/super-tm/8ede13664ff6b499fc82099056f055fc.gif'}]
    page.evaluate('document.querySelector(".chat-text-sys-emotion").src="https://cdn.example.test/unknown.gif"')
    current=active();assert current['coverage']['unreadAttachments']==1 and 'legacyAliases' not in current['messages'][-1]
    passed('MIC official native emoji labels are preserved in message order without OCR claims; unverified images remain unread attachments and have no cleanup alias')

    load_active_mic();page.evaluate('const row=document.querySelector(".contact-chatInfo");row.className="mine-chatInfo";row.querySelector(".fromUserName").textContent="Synthetic buyer";row.parentElement.insertAdjacentHTML("beforeend","<div class=msg-system>Platform system notice</div><div class=diversion-enhanced-reminder>Platform reminder</div>")')
    current=active();assert current['messages'][2]['direction']=='outbound' and current['messages'][2]['id']=='10000000-0000-0000-0000-000000000001'
    assert [m['direction'] for m in current['messages'][-2:]]==['system','system'] and current['messages'][-1]['text']=='Platform reminder'
    assert current['coverage']['unknownSenders']==0 and current['coverage']['capturedMessages']==5
    page.evaluate('document.querySelector(".mine-chatInfo").classList.add("contact-chatInfo")')
    assert active()['messages'][2]['direction']=='unknown'
    passed('observed MIC mine-chatInfo identifies outbound UUID messages; attached platform notices are separately retained and conflicting markers stay unknown')

    load_active_mic();page.evaluate('document.querySelector(".chat-txt .msg-text").innerHTML="<span>Photo of model A</span><img alt=Model-A style=width:30px;height:30px src=\\\"https://cdn.example.test/model-a.png\\\">"')
    current=active();message=current['messages'][-1]
    assert message['direction']=='inbound' and 'Photo of model A' in message['text'] and message['attachments'][0]['type']=='image'
    assert message['attachments'][0]['url']=='https://cdn.example.test/model-a.png' and not message['attachments'][0]['contentRead'] and current['coverage']['unreadAttachments']==1
    request_count=len(requests);effects=page.evaluate('({...readerSideEffects})');snapshot();snapshot()
    assert len(requests)==request_count and page.evaluate('readerSideEffects')==effects
    passed('MIC image preserves caption, source reference and sender while explicitly reporting that image contents remain unread')

    load_active_mic();page.evaluate('document.querySelector(".chat-content").insertAdjacentHTML("beforeend","<img alt=Sibling-photo style=width:30px;height:30px src=\\\"https://cdn.example.test/sibling.png\\\">")')
    current=active();assert current['messages'][-1]['attachments'][0]['name']=='Sibling-photo' and current['coverage']['unreadAttachments']==1
    active();page.wait_for_timeout(1100);current=active();assert current['historyTailKnown'] and current['historyOrderReliable'] and not current['tailKnown']
    passed('MIC media beside the text body is retained and structural history readiness remains separate from unread image contents')

    load_active_mic();page.evaluate('document.querySelector(".chat-content").insertAdjacentHTML("beforeend",Array.from({length:31},(_,i)=>"<img alt=Picture-"+i+" style=width:30px;height:30px>").join(""))')
    current=active();assert len(current['messages'][-1]['attachments'])==30 and current['coverage']['limited'] and not current['historyOrderReliable']
    passed('attachment limits are explicit coverage gaps and cannot silently authorize content-complete history')

    load_active_mic();page.evaluate('const template=document.querySelector(".msg-box"),history=document.querySelector(".msg-list"),rows=[];for(let i=0;i<500;i++){const row=template.cloneNode(true);row.querySelector(".contact-chatInfo").id="10000000-0000-0000-0000-"+String(i).padStart(12,"0");row.insertAdjacentHTML("beforeend","<div class=msg-system>Platform notice</div>");rows.push(row)}history.replaceChildren(...rows)')
    current=active();assert len(current['messages'])<=500 and current['coverage']['limited'] and current['coverage']['totalRows']>500 and not current['historyOrderReliable']
    passed('MIC message plus system-notice expansion respects the 500-message bound and reports omitted history explicitly')

    load();set_history('<div class="message-item outgoing" data-message-id="last-outbound">Previous buyer message.</div>')
    current=active();expected={'platform':'1688','sourceUrl':page.url,'documentToken':snapshot()['documentToken'],'id':current['id'],'replyFingerprint':current['replyFingerprint'],'purpose':'wechat'}
    assert not page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e)',expected)['ok']
    assert not page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e,{preview:false})',expected)['ok']
    assert page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e,{preview:true})',expected)['ok']
    normal={key:value for key,value in expected.items() if key!='purpose'}
    assert not page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e,{preview:true})',normal)['ok']
    page.evaluate('document.querySelector(".message-item").textContent="Changed buyer message."')
    assert not page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e,{preview:true})',expected)['ok']
    current=active();expected['replyFingerprint']=current['replyFingerprint']
    assert page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e,{preview:true})',expected)['ok']
    page.evaluate('document.querySelector("[data-chat-root]").setAttribute("data-thread-id","other-recipient")')
    assert not page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e,{preview:true})',expected)['ok']
    passed('WeChat purpose permits a last-outbound TEST preview only; purpose alone, normal replies, changed history and recipient remain blocked')

    load();current=active();expected={'platform':'1688','sourceUrl':page.url,'documentToken':snapshot()['documentToken'],'id':current['id'],'replyFingerprint':current['replyFingerprint'],'purpose':'wechat'}
    assert not page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e)',expected)['ok']
    assert page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e,{preview:true})',expected)['ok']
    normal={key:value for key,value in expected.items() if key!='purpose'}
    assert page.evaluate('(e)=>OpenLinksDialogsReader.guardReply(e)',normal)['ok']
    passed('WeChat is preview-only even with last inbound; ordinary inbound reply guard retains its existing contract')

    assert not errors, errors
    browser.close()
print(f'{checks} read-only dialog browser checks passed', flush=True)
