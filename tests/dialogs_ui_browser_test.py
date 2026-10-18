"""Exercise the production dialogs UI with synthetic conversations and Chrome transport.

No accounts, external requests, marketplace interaction or real API calls are used.
"""
import functools
import http.server
import os
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
checks = 0


def passed(name):
    global checks
    checks += 1
    print('PASS ' + name, flush=True)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


HARNESS = r"""
(() => {
  const now=Date.UTC(2026,9,18,1,10),listeners=[];
  const blank=()=>({version:1,running:false,mode:'observe',settings:{brief:'',wechat:'',language:'',autoDraft:false},bindings:Object.fromEntries(['1688','alibaba','mic'].map(platform=>[platform,{tabId:null,url:'',status:'unbound',checkedAt:null,detail:''}])),conversations:{},events:[]});
  let state=blank(),ai={keyStored:false,model:''};
  window.calls=[];window.permissionCalls=[];window.allowPermission=true;window.failGet=false;
  const tabs=[{id:11,platform:'1688',title:'1688 chat',url:'https://air.1688.com/chat/'},{id:22,platform:'alibaba',title:'Alibaba messages',url:'https://message.alibaba.com/'},{id:33,platform:'mic',title:'Made-in-China messages',url:'https://webim.made-in-china.com/'}];
  const publicState=()=>({ok:true,state:structuredClone(state),ai:{...ai}});
  window.chrome={storage:{onChanged:{addListener:f=>listeners.push(f)}},permissions:{request:async data=>{permissionCalls.push(data);return allowPermission;}},runtime:{sendMessage:async message=>{
    calls.push(structuredClone(message));const t=message.type;
    if(t==='DIALOGS_GET')return failGet?{ok:false,error:'Временная ошибка чтения'}:publicState();
    if(t==='DIALOGS_LIST_TABS')return {ok:true,tabs};
    if(t==='DIALOGS_BIND_TAB'){const tab=tabs.find(tab=>tab.id===message.tabId);state.bindings[message.platform]={tabId:tab.id,url:tab.url,status:'loading',checkedAt:null,detail:'Ожидает проверки'};}
    else if(t==='DIALOGS_UNBIND_TAB')state.bindings[message.platform]={tabId:null,url:'',status:'unbound',checkedAt:null,detail:''};
    else if(t==='DIALOGS_START'){state.running=true;state.readUnread=message.readUnread===true;}
    else if(t==='DIALOGS_STOP')state.running=false;
    else if(t==='DIALOGS_SCAN'){for(const [platform,binding] of Object.entries(state.bindings))if(binding.tabId!==null&&(!message.platform||message.platform===platform)){binding.status='ready';binding.checkedAt=now;binding.detail='Прочитан открытый чат';}}
    else if(t==='DIALOGS_SETTINGS'){state.settings={...state.settings,...message.settings};ai.model=message.model;if(message.apiKey)ai.keyStored=true;if(message.clearApiKey)ai.keyStored=false;}
    else if(t==='DIALOGS_CONTROL'){for(const field of ['paused','takeover'])if(typeof message[field]==='boolean')state.conversations[message.key][field]=message[field];}
    else if(t==='DIALOGS_SAVE_DRAFT'){const item=state.conversations[message.key];if(item.revision!==message.revision||item.fingerprint!==message.fingerprint)return {ok:false,error:'Переписка изменилась'};item.draft={text:message.text,createdAt:now,status:'draft',revision:item.revision,fingerprint:item.fingerprint};}
    else if(t==='DIALOGS_DISCARD_DRAFT')state.conversations[message.key].draft=null;
    else if(t==='DIALOGS_GENERATE_DRAFT'){const item=state.conversations[message.key];item.draft={text:'Could you confirm the minimum order?',reason:'Нужно уточнить MOQ.',createdAt:now,status:'draft',revision:item.revision,fingerprint:item.fingerprint};}
    else return {ok:false,error:'Unknown test action '+t};
    return publicState();
  }}};
  function announce(){for(const listener of listeners)listener({openlinksDialogs:{newValue:structuredClone(state)}},'local');}
  const thread=(id,platform,extra={})=>({key:platform+':'+id,id,platform,title:'Supplier '+id,url:platform==='1688'?'https://air.1688.com/chat/':'https://message.alibaba.com/',identityReliable:true,unread:false,needsRead:false,messages:[{key:'m1',id:'m1',direction:'outbound',text:'Hello, I need a machine.',at:now-60000},{key:'m2',id:'m2',direction:'inbound',text:'What quantity do you need?',at:now}],orderReliable:true,tailKnown:true,revision:1,fingerprint:'fp1',unanswered:true,paused:false,takeover:false,draft:null,updatedAt:now,lastObservedAt:now,...extra});
  window.seedDialogs=()=>{state.conversations={'alibaba:alpha':thread('alpha','alibaba'), '1688:list':thread('list','1688',{title:'Only unread badge',unread:3,needsRead:true,messages:[],orderReliable:false,tailKnown:false,unanswered:false,preview:'A list preview'}), 'mic:uncertain':thread('uncertain','mic',{title:'Uncertain order',orderReliable:false,messages:[{key:'m3',direction:'unknown',text:'Ambiguous author',at:null}]})};state.events=[{at:now,type:'scan',platform:'1688',detail:'Проверка завершена'}];announce();};
  window.changeDialog=patch=>{Object.assign(state.conversations['alibaba:alpha'],patch);announce();};
  window.dialogState=()=>structuredClone(state);
  window.announceDialogs=announce;
})();
"""


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True)
        context = browser.new_context(viewport={'width': 1500, 'height': 1100}, timezone_id='Asia/Irkutsk')
        context.add_init_script(HARNESS)
        external = []

        def local_only(route):
            if route.request.url.startswith('http://127.0.0.1:'):
                route.continue_()
            else:
                external.append(route.request.url)
                route.abort()

        context.route('**/*', local_only)
        ui = context.new_page()
        errors = []
        ui.on('pageerror', lambda error: errors.append(str(error)))
        ui.goto(f'http://127.0.0.1:{server.server_port}/extension/dialogs.html')
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг остановлен')
        expect(ui.locator('.dialogs-platform')).to_have_count(3)
        expect(ui.locator('#dialogs-start')).to_be_disabled()
        expect(ui.locator('#dialogs-read-unread')).to_be_checked()
        expect(ui.locator('#dialogs-empty')).to_contain_text('Выберите вкладки')
        assert ui.evaluate('calls.every(c=>c.type===\'DIALOGS_GET\'||c.type===\'DIALOGS_LIST_TABS\')')
        assert ui.evaluate('permissionCalls.length') == 0
        passed('empty UI reads state and tabs without AI requests or permissions')
        expect(ui.locator('#dialogs-diagnostics')).to_have_attribute('href','diagnostics.html')
        expect(ui.locator('#dialogs-diagnostics')).to_have_attribute('target','_blank')
        assert not ui.evaluate("calls.some(c=>/DIAGNOSTIC/.test(c.type))")
        passed('advanced diagnostics link opens a page without automatically collecting or exporting conversations')

        expect(ui.locator('#dialogs-tab-alibaba option')).to_have_count(2)
        expect(ui.locator('#dialogs-tab-alibaba')).not_to_contain_text('1688 chat')
        ui.locator('#dialogs-tab-alibaba').select_option('22')
        ui.locator('[data-platform="alibaba"]').get_by_role('button', name='Выбрать', exact=True).click()
        expect(ui.locator('#dialogs-start')).to_be_enabled()
        ui.locator('#dialogs-start').click()
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг работает')
        expect(ui.locator('#dialogs-read-unread')).to_be_disabled()
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_START').at(-1)") == {'type':'DIALOGS_START','readUnread':True}
        ui.locator('#dialogs-scan').click()
        expect(ui.locator('[data-platform="alibaba"]')).to_contain_text('Чат доступен')
        expect(ui.locator('[data-platform="alibaba"]')).to_contain_text('09:10:00')
        ui.locator('#dialogs-stop').click()
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг остановлен')
        passed('platform-specific binding, start/scan/stop, and PC-local check time')

        expect(ui.locator('#dialogs-read-unread')).to_be_enabled()
        ui.locator('#dialogs-read-unread').uncheck()
        ui.evaluate('announceDialogs()')
        expect(ui.locator('#dialogs-read-unread')).not_to_be_checked()
        ui.locator('#dialogs-start').click()
        expect(ui.locator('#dialogs-run-state')).to_have_text('Мониторинг работает')
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_START').at(-1)") == {'type':'DIALOGS_START','readUnread':False}
        expect(ui.locator('#dialogs-read-unread')).not_to_be_checked()
        expect(ui.locator('#dialogs-read-unread')).to_be_disabled()
        ui.locator('#dialogs-stop').click()
        expect(ui.locator('#dialogs-read-unread')).not_to_be_checked()
        expect(ui.locator('.dialogs-monitor-controls')).to_contain_text('может снять отметку «непрочитано»')
        passed('explicit start selects optional unread traversal; edits survive refresh and setting stays fixed while running')

        ui.evaluate('seedDialogs()')
        expect(ui.locator('.dialogs-thread')).to_have_count(3)
        ui.locator('#dialogs-filter').select_option('unread')
        expect(ui.locator('.dialogs-thread')).to_have_count(1)
        ui.locator('.dialogs-thread').click()
        expect(ui.locator('#dialogs-history')).to_contain_text('история этой переписки ещё не прочитана')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        expect(ui.locator('#dialogs-conversation-status')).not_to_contain_text('Требует ответа')
        passed('unread inbox preview never masquerades as a confirmed unanswered history')

        ui.locator('#dialogs-filter').select_option('all')
        ui.locator('#dialogs-search').fill('Ambiguous author')
        expect(ui.locator('.dialogs-thread')).to_have_count(1)
        ui.locator('.dialogs-thread').click()
        expect(ui.locator('#dialogs-history')).to_contain_text('Автор не определён')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        passed('search covers message text and uncertain authors cannot generate a reply')

        ui.locator('#dialogs-search').fill('')
        ui.locator('[data-key="alibaba:alpha"]').click()
        detail = 'Содержимое вложения не прочитано; подготовка ответа заблокирована. <img src=x onerror=alert(1)>'
        ui.evaluate('(detail)=>changeDialog({detail,needsRead:true,orderReliable:false})',detail)
        expect(ui.locator('#dialogs-reader-detail')).to_have_text(detail)
        expect(ui.locator('#dialogs-history-note')).to_be_hidden()
        expect(ui.locator('#dialogs-generate-hint')).to_have_text(detail)
        expect(ui.locator('#dialogs-conversation-status')).to_contain_text('Нужна проверка истории')
        expect(ui.locator('#dialogs-conversation-status')).not_to_contain_text('Нужно открыть историю')
        assert ui.locator('#dialogs-reader-detail img, #dialogs-generate-hint img').count() == 0
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        ui.evaluate("changeDialog({detail:'',needsRead:false,orderReliable:true})")
        expect(ui.locator('#dialogs-reader-detail')).to_be_hidden()
        expect(ui.locator('#dialogs-history-note')).to_be_visible()
        passed('specific adapter failure reason replaces generic reopen guidance and is rendered as plain text')
        expect(ui.locator('#dialogs-history')).to_contain_text('What quantity do you need?')
        expect(ui.locator('#dialogs-history .outbound')).to_contain_text('Вы')
        expect(ui.locator('#dialogs-history .inbound')).to_contain_text('Поставщик')
        expect(ui.locator('#dialogs-generate-hint')).to_contain_text('Сохраните задание')
        ui.locator('#dialogs-brief').fill('We need 10 machines. Ask the minimum order. Do not agree on price.')
        ui.locator('#dialogs-wechat').fill('demo-buyer')
        ui.locator('#dialogs-language').fill('English')
        ui.locator('#dialogs-model').fill('test-model')
        ui.locator('#dialogs-api-key').fill('synthetic-test-key')
        ui.locator('#dialogs-save-settings').click()
        expect(ui.locator('#dialogs-feedback')).to_have_text('Задание и настройки сохранены.')
        expect(ui.locator('#dialogs-api-key')).to_have_value('')
        expect(ui.locator('#dialogs-key-status')).to_contain_text('Ключ сохранён')
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        assert 'synthetic-test-key' not in ui.locator('body').inner_text()
        assert ui.evaluate('permissionCalls.length') == 0
        passed('brief/model/key explicitly saved, key input cleared, monitoring does not trigger AI')

        ui.evaluate('allowPermission=false')
        ui.locator('#dialogs-generate').click()
        expect(ui.locator('#dialogs-feedback')).to_contain_text('Доступ к OpenAI API не разрешён')
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_GENERATE_DRAFT').length") == 0
        ui.evaluate('allowPermission=true')
        ui.locator('#dialogs-generate').click()
        expect(ui.locator('#dialogs-draft-text')).to_have_value('Could you confirm the minimum order?')
        assert ui.evaluate('permissionCalls.at(-1).origins') == ['https://api.openai.com/*']
        passed('AI draft needs an explicit click and optional official-API permission')

        ui.locator('#dialogs-draft-text').fill('Please confirm MOQ and lead time.')
        ui.locator('#dialogs-save-draft').click()
        expect(ui.locator('#dialogs-draft-status')).to_contain_text('Сохранён локально')
        assert ui.evaluate("calls.filter(c=>c.type==='DIALOGS_SAVE_DRAFT').at(-1)") == {'type':'DIALOGS_SAVE_DRAFT','key':'alibaba:alpha','text':'Please confirm MOQ and lead time.','revision':1,'fingerprint':'fp1'}
        passed('edited drafts save locally with viewed conversation revision and fingerprint')

        ui.locator('#dialogs-draft-text').fill('A local unsaved edit')
        ui.evaluate("changeDialog({revision:2,fingerprint:'fp2'})")
        expect(ui.locator('#dialogs-draft-text')).to_have_value('A local unsaved edit')
        expect(ui.locator('#dialogs-draft-status')).to_contain_text('Переписка изменилась')
        expect(ui.locator('#dialogs-save-draft')).to_be_disabled()
        ui.locator('#dialogs-discard-draft').click()
        expect(ui.locator('#dialogs-draft-text')).to_have_value('')
        passed('refresh preserves local edits and prevents stale drafts from being saved')

        ui.locator('#dialogs-takeover').click()
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        expect(ui.locator('#dialogs-conversation-status')).to_contain_text('Под вашим управлением')
        ui.locator('#dialogs-takeover').click()
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        ui.locator('#dialogs-mute').click()
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        ui.locator('#dialogs-filter').select_option('paused')
        expect(ui.locator('.dialogs-thread')).to_have_count(1)
        ui.locator('#dialogs-mute').click()
        expect(ui.locator('#dialogs-generate')).to_be_enabled()
        passed('takeover and per-conversation pause stop draft generation and can be resumed')

        ui.locator('#dialogs-brief').fill('Unsaved procurement brief')
        ui.evaluate('announceDialogs()')
        expect(ui.locator('#dialogs-brief')).to_have_value('Unsaved procurement brief')
        ui.locator('#dialogs-clear-key').check()
        ui.locator('#dialogs-save-settings').click()
        expect(ui.locator('#dialogs-key-status')).to_have_text('Ключ не сохранён.')
        expect(ui.locator('#dialogs-generate')).to_be_disabled()
        passed('background refresh preserves settings edits and saved API key can be removed')

        ui.evaluate("changeDialog({url:'javascript:alert(1)',title:'<img src=x onerror=alert(1)>'})")
        expect(ui.locator('#dialogs-source')).to_be_hidden()
        expect(ui.locator('#dialogs-supplier')).to_have_text('<img src=x onerror=alert(1)>')
        assert ui.locator('#dialogs-supplier img').count() == 0
        passed('supplier content is text-only and non-marketplace or script URLs cannot become links')

        ui.set_viewport_size({'width':600,'height':850})
        assert ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        passed('dialogs page fits a 600px viewport')
        ui.evaluate('failGet=true;announceDialogs()')
        expect(ui.locator('#dialogs-feedback')).to_have_text('Временная ошибка чтения')
        assert not errors, errors
        assert not external, external
        assert ui.evaluate("calls.every(c=>c.type.startsWith('DIALOGS_'))")
        assert ui.evaluate("calls.every(c=>!/(SEND|FILL|CLICK)/.test(c.type))")
        passed('errors are visible; the entire UI makes no send/fill/click commands or external requests')
        browser.close()
finally:
    server.shutdown()
print(f'{checks} dialogs UI browser checks passed', flush=True)
