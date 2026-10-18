"""Exercise the production parser port and resolver with real browser/IDB parsing.

Chrome runtime/offscreen transport is simulated: managed cloud Chrome prohibits
loading unpacked extensions. No policy is bypassed and no marketplace is visited.
"""
import base64
import functools
import http.server
import io
import os
from pathlib import Path
import threading
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
checks=0
def passed(name):
    global checks
    checks+=1
    print('PASS '+name,flush=True)
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
    def end_headers(self):
        self.send_header('Content-Security-Policy',"script-src 'self'; object-src 'none'")
        super().end_headers()

HARNESS=r"""
(()=>{
  const id='synthetic-extension-id',listeners=[];
  const event=()=>{const callbacks=[];return {addListener:fn=>callbacks.push(fn),emit:value=>{for(const fn of callbacks)fn(value);},get count(){return callbacks.length;}};};window.fakeEvent=event;
  window.rpcCalls={created:0,closed:0,messages:[],ports:[]};window.offscreenExists=false;
  const runtime={id,getURL:path=>new URL('/extension/'+path,location.origin).href,onConnect:{addListener:fn=>listeners.push(fn)},getContexts:async()=>offscreenExists?[{documentUrl:runtime.getURL('attachment-parser.html')}]:[],connect:({name})=>{
    const serverMessages=event(),clientMessages=event(),serverDisconnect=event(),clientDisconnect=event();let disconnected=false;
    const client={name,onMessage:clientMessages,onDisconnect:clientDisconnect,postMessage:message=>{if(disconnected)throw new Error('Disconnected');rpcCalls.messages.push(structuredClone(message));serverMessages.emit(structuredClone(message));},disconnect:()=>{if(disconnected)return;disconnected=true;serverDisconnect.emit();clientDisconnect.emit();}};
    const server={name,sender:{id,url:runtime.getURL('background.js')},onMessage:serverMessages,onDisconnect:serverDisconnect,postMessage:reply=>{if(disconnected)throw new Error('Disconnected');clientMessages.emit(structuredClone(reply));}};
    rpcCalls.ports.push({client,server});for(const listener of listeners)listener(server);return client;
  }};
  window.chrome={runtime,offscreen:{createDocument:async options=>{rpcCalls.created++;offscreenExists=true;rpcCalls.options=options;},closeDocument:async()=>{rpcCalls.closed++;offscreenExists=false;}}};
  window.probePort=sender=>{const port={name:'openlinks-chat-parser-v1',sender,onMessage:event(),onDisconnect:event(),postMessage:()=>{}};for(const listener of listeners)listener(port);return port.onMessage.count;};
  window.directRPC=async request=>{const port=runtime.connect({name:'openlinks-chat-parser-v1'});return new Promise(resolve=>{port.onMessage.addListener(reply=>{port.disconnect();resolve(reply);});port.postMessage(request);});};
})();
"""

server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
image=Image.new('RGB',(32,24),(20,110,90));stream=io.BytesIO();image.save(stream,format='PNG');png=base64.b64encode(stream.getvalue()).decode()
try:
  with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True)
    context=browser.new_context();context.add_init_script(HARNESS);external=[];errors=[]
    def local_only(route):
        if route.request.url.startswith('http://127.0.0.1:'):route.continue_()
        else:external.append(route.request.url);route.abort()
    context.route('**/*',local_only);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(f'http://127.0.0.1:{server.server_port}/extension/attachment-parser.html')
    page.evaluate("async()=>{window.files=await import('/extension/lib/product-files.js');window.dialogs=await import('/extension/lib/dialogs.js');window.attachments=await import('/extension/lib/chat-attachments.js');await import('/extension/attachment-parser.js');}")
    result=page.evaluate("()=>[probePort({id:'outside'}),probePort({id:chrome.runtime.id,tab:{id:1}}),probePort({id:chrome.runtime.id,url:chrome.runtime.getURL('dialogs.html')}),probePort({id:chrome.runtime.id,url:chrome.runtime.getURL('background.js')}),probePort({id:chrome.runtime.id})]")
    assert result==[0,0,0,1,1],result
    passed('offscreen parser rejects content/UI/foreign senders and accepts worker URL or omitted sender URL')
    result=page.evaluate("()=>directRPC({type:'PARSE',ownerId:crypto.randomUUID(),name:'quote.txt',mime:'text/plain',base64:btoa('Steel pump 220 V')})")
    assert result['ok'] and result['record']['status']=='ready' and result['record']['text']=='Steel pump 220 V',result
    assert page.evaluate('id=>files.readProductOriginal(id).then(Boolean)',result['record']['id'])
    passed('real parser RPC stores a readable document with the caller-owned UUID')
    result=page.evaluate("data=>directRPC({type:'PARSE',ownerId:crypto.randomUUID(),name:'photo.png',mime:'image/png',base64:data})",png)
    assert result['record']['status']=='ready' and result['record']['images'][0]['width']==32,result
    assert page.evaluate('key=>files.loadProductImage(key).then(s=>s.startsWith("data:image/jpeg;base64,"))',result['record']['images'][0]['imageKey'])
    passed('image RPC returns vision asset keys, with actual image bytes retained only in IndexedDB')
    result=page.evaluate("async()=>{const ownerId=crypto.randomUUID();const reply=await directRPC({type:'PARSE',ownerId,name:'old.xls',mime:'application/vnd.ms-excel',base64:btoa(String.fromCharCode(0xd0,0xcf,0x11,0xe0)+'old')});return {reply,exists:Boolean(await files.readProductOriginal(ownerId))};}")
    assert result['reply']['ok'] and result['reply']['record']['status']=='unsupported' and not result['reply']['record']['id'] and not result['exists'],result
    result=page.evaluate("()=>directRPC({type:'PARSE',ownerId:crypto.randomUUID(),name:'bad.txt',base64:'!not-base64!'})")
    assert result['ok'] is False,result
    passed('unsupported attachments are reported without accumulating originals; malformed RPC bytes are rejected')
    page.evaluate(r"""()=>{
      window.fixture=({mime='text/plain',name='quote.txt',data=btoa('Steel pump 220 V')}={})=>{
        const state=dialogs.initialDialogs(),raw={id:'account:buyer/thread:supplier',active:true,identityReliable:true,historyTailKnown:true,historyOrderReliable:true,tailKnown:false,orderReliable:false,needsRead:true,messages:[{id:'message-1',direction:'inbound',text:'Attached specification',attachments:[{type:mime.startsWith('image/')?'image':'file',name,url:'https://files.alibaba.com/'+name+'?signed=private'}]}],coverage:{attachments:1,unreadAttachments:1}};
        const snapshot={platform:'alibaba',status:'ready',url:'https://message.alibaba.com/chat',documentToken:'document-1',busy:{},conversations:[raw]};
        dialogs.mergeDialogSnapshot(state,snapshot,100);const key=dialogs.conversationKey('alibaba',raw.id);
        const api={runtime:chrome.runtime,offscreen:chrome.offscreen,tabs:{get:async()=>({id:1,status:'complete'}),sendMessage:async()=>structuredClone(snapshot)}};
        const context={api,state,key,rawConversation:raw,tabId:1,frameId:0,sourceUrl:snapshot.url,documentToken:snapshot.documentToken,now:1000};
        return {state,key,run:()=>attachments.resolveChatAttachments(context,{cachedBytes:async()=>({base64:data,mime})})};
      };
    }""")
    result=page.evaluate("async()=>{offscreenExists=false;const h=fixture();const result=await h.run();return {result,resolution:h.state.conversations[h.key].messages[0].attachments[0].resolution,calls:{created:rpcCalls.created,closed:rpcCalls.closed,options:rpcCalls.options}};}")
    assert result['result']['resolved']==1 and result['resolution']['text']=='Steel pump 220 V',result
    assert result['calls']['created']==1 and result['calls']['closed']==1 and set(result['calls']['options']['reasons'])=={'DOM_PARSER','BLOBS','WORKERS'},result
    assert 'private' not in str(result['resolution'])
    passed('production resolver creates and closes its parser document while preserving successful parsed assets')
    result=page.evaluate("async()=>{offscreenExists=true;const before=rpcCalls.closed,h=fixture();const result=await h.run();return {result,closed:rpcCalls.closed-before};}")
    assert result['result']['resolved']==1 and result['closed']==0,result
    passed('production resolver reuses an existing parser without closing another owner’s document')
    # Hold a real decode after its original has been stored, then fire only the
    # resolver's long timeout. This exercises cleanup without a 20-second sleep.
    page.evaluate("""data=>{
      window.imageNative=createImageBitmap;window.timeoutNative=setTimeout;window.slowStarted=false;
      window.createImageBitmap=blob=>{window.slowStarted=true;return new Promise(resolve=>{window.releaseSlow=async()=>{const bitmap=await imageNative(blob);resolve(bitmap);return bitmap;};});};
      window.setTimeout=(fn,ms,...args)=>{if(ms>10000&&ms<=22000){window.fireParserTimeout=()=>fn(...args);return timeoutNative(()=>{},60000);}return timeoutNative(fn,ms,...args);};
      offscreenExists=false;window.slow=fixture({mime:'image/png',name:'slow.png',data});window.slowResult=slow.run();
    }""",png)
    page.wait_for_function('() => window.slowStarted === true && typeof window.fireParserTimeout === "function"')
    owner=page.evaluate('rpcCalls.messages.at(-1).ownerId')
    assert page.evaluate('id=>files.readProductOriginal(id).then(Boolean)',owner)
    result=page.evaluate('async()=>{fireParserTimeout();return await slowResult;}')
    assert result['failed']==1 and result['resolved']==0,result
    assert not page.evaluate('id=>files.readProductOriginal(id).then(Boolean)',owner)
    assert page.evaluate('async()=>{window.createImageBitmap=imageNative;window.setTimeout=timeoutNative;const bitmap=await releaseSlow();await Promise.resolve();return bitmap.width;}')==0
    passed('RPC timeout disconnects parsing and removes the known owner’s original before returning a visible failure')
    assert not external,external
    assert not errors,errors
    passed('port workflow uses only local resources and produces no unhandled browser errors')
    browser.close()
finally:server.shutdown();server.server_close()
print(f'{checks} parser transport browser checks passed (Chrome transport simulated)',flush=True)
