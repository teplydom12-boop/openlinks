#!/usr/bin/env python3
"""Read-only WeChat audit UI: commands, report clarity, and mode isolation."""
import functools
import http.server
import os
import pathlib
import threading
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[1]
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

HARNESS = r"""
(() => {
  const listeners=[];let state,core,auditCore;
  const folder={enabled:false,auto:true,autoSend:true,status:'disabled',jobs:[],test:{enabled:true,phase:'ready',sessionId:'previous-test',cycleId:'previous-cycle',completed:[]},review:{phase:'prepared',operationId:'old-review',key:'1688:old',text:'Never send this'}};
  window.calls=[];
  const result=()=>({ok:true,state:structuredClone(state),folder:structuredClone(folder),workflowActivity:state.workflow?.current});
  const announce=()=>listeners.forEach(fn=>fn({openlinksDialogs:{}},'local'));
  window.snapshot=()=>structuredClone(state);
  window.chrome={storage:{onChanged:{addListener:fn=>listeners.push(fn)}},permissions:{request:async()=>{throw new Error('Audit must not ask native permissions');}},runtime:{sendMessage:async message=>{
    window.calls.push(structuredClone(message));core=await import('/extension/lib/dialogs.js');auditCore=await import('/extension/lib/wechat-audit.js');
    if(!state){state=core.initialDialogs();state.settings.wechatAudit=true;state.settings.workflow24h=true;state.settings.wechat='wx_test_42';state.settings.showWorkingTab=true;state.running=false;state.workflow.audit={version:1,runId:'',phase:'idle',cursor:0,records:{},platforms:{}};for(const [platform,tabId,url] of [['1688',11,'https://air.1688.com/'],['alibaba',22,'https://message.alibaba.com/'],['mic',33,'https://webim.made-in-china.com/super-tm/']])state.bindings[platform]={tabId,status:'ready',url,managed:{windowId:1,pending:false}};}
    if(message.type==='DIALOGS_JOINT_GET')return {ok:true,joint:{enabled:false,phase:'independent',testMode:true}};
    if(message.type==='DIALOGS_GET')return result();
    if(message.type==='DIALOGS_SETTINGS'){Object.assign(state.settings,message.settings);if(Object.hasOwn(message.settings,'wechat')){state.running=false;state.workflow.audit.phase='blocked';state.workflow.audit.blockedReason='WeChat ID изменён. Начните проверку заново.';}return result();}
    if(message.type==='DIALOGS_AUDIT_START'){state.running=true;state.workflow.audit={version:1,runId:'audit-1',contactFingerprint:auditCore.wechatContactFingerprint(state.settings.wechat),phase:'running',cursor:0,startedAt:Date.now(),records:{},platforms:{'1688':{phase:'running'},alibaba:{phase:'pending'},mic:{phase:'pending'}}};state.workflow.current={phase:'audit_opening',platform:'1688',detail:'Открываю первый чат сверху.',at:Date.now()};return result();}
    if(message.type==='DIALOGS_START'){state.running=true;state.workflow.audit.phase='running';return result();}
    if(message.type==='DIALOGS_STOP'){state.running=false;state.workflow.audit.phase='paused';return result();}
    if(message.type==='DIALOGS_OPEN_CHATS'||message.type==='DIALOGS_SHOW_CHAT')return result();
    return {ok:false,error:'Forbidden audit command: '+message.type};
  }}};
  window.seedReport=()=>{
    const a=state.workflow.audit,now=Date.UTC(2026,9,19,1,2,3);a.runId='audit-report';a.contactFingerprint=auditCore.wechatContactFingerprint(state.settings.wechat);a.phase='running';a.cursor=0;a.records={};state.running=true;
    const add=(key,title,status,detail,index,extra={})=>{a.records[key]={runId:a.runId,key,id:key,platform:key.split(':')[0],position:index,title,status,detail,checkedAt:now-index*1000,lastMessageAt:now-60000,url:key.startsWith('1688:')?'https://air.1688.com/chat':key.startsWith('alibaba:')?'https://message.alibaba.com/':'https://webim.made-in-china.com/super-tm/',...extra};};
    add('1688:one','Первая фабрика','found','ID найден в обычном сообщении.',1,{matchDirection:'inbound'});
    add('1688:two','Вторая фабрика','not_found','История прочитана полностью. ID не найден.',2);
    add('1688:incomplete','ДлинноеНазваниеПоставщика'.repeat(8),'incomplete','Начало истории не загрузилось. '.repeat(30),3,{lastMessageAt:null});
    add('1688:error','Ошибка чтения','error','Не удалось открыть переписку.',4,{url:'javascript:alert(1)'});
    add('1688:old','Старая переписка','older','Последнее сообщение старше 24 часов.',5);
    add('alibaba:six','<img src=x onerror=alert(1)>','found','<script>window.injected=true</script>',6);
    for(let i=7;i<=62;i++)add('mic:'+i,'Поставщик '+i,'not_found','История прочитана полностью.',i);
    a.records['mic:stale']={runId:'older-run',key:'mic:stale',platform:'mic',status:'found',title:'Старый отчёт'};
    const first=a.records['1688:one'];delete a.records['1688:one'];a.records['1688:one']=first;
    state.workflow.visits={'1688:legacy':{title:'Не выводить результат старой логики',status:'completed'}};
    state.conversations={'1688:unvisited':{title:'Не проверялся в этом запуске'}};
    a.platforms={'1688':{phase:'running'},alibaba:{phase:'pending'},mic:{phase:'pending'}};announce();
  };
  window.block=()=>{state.running=false;state.workflow.audit.phase='blocked';state.workflow.audit.blockedReason='Конец списка 1688 не подтверждён. Alibaba ещё не проверялась.';state.workflow.audit.platforms['1688']={phase:'blocked',detail:'Не удалось подгрузить следующие чаты.'};announce();};
  window.complete=()=>{state.running=false;state.workflow.audit.phase='completed';state.workflow.audit.blockedReason='';for(const platform of ['1688','alibaba','mic'])state.workflow.audit.platforms[platform]={phase:'completed'};state.workflow.current={phase:'audit_completed',detail:'Обход трёх площадок завершён.',at:Date.now()};announce();};
  window.announce=announce;
})();
"""
checks = 0
def passed(name):
    global checks
    checks += 1
    print('PASS '+name, flush=True)

server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True)
        context=browser.new_context(viewport={'width':1450,'height':1000},timezone_id='Asia/Irkutsk')
        context.set_default_timeout(8000);context.add_init_script(HARNESS)
        external=[]
        def local_only(route):
            if route.request.url.startswith('http://127.0.0.1:'):
                route.continue_()
            else:
                external.append(route.request.url);route.abort()
        context.route('**/*',local_only)
        ui=context.new_page();errors=[];ui.on('pageerror',lambda e:errors.append(str(e)))
        ui.goto(f'http://127.0.0.1:{server.server_port}/extension/dialogs.html')
        expect(ui.locator('#dialogs-audit')).to_be_visible()
        expect(ui.locator('#dialogs-audit-start')).to_be_enabled()
        expect(ui.locator('#dialogs-audit-wechat')).to_have_value('wx_test_42')
        expect(ui.locator('#dialogs-audit-resume')).to_be_disabled()
        for id in ['dialogs-folder','dialogs-product','dialogs-mode','joint-mode','dialogs-conversations','dialogs-review-panel','dialogs-test-panel','dialogs-results']:
            expect(ui.locator('#'+id)).to_be_hidden()
        assert not any('FOLDER' in c['type'] or 'TEST' in c['type'] for c in ui.evaluate('calls'))
        expect(ui.locator('#dialogs-audit')).to_contain_text('Фото, QR-коды и файлы не распознаются')
        passed('audit starts without product, Claude, or old test/review state')
        ui.locator('#dialogs-audit-start').click()
        expect(ui.locator('#dialogs-audit-action')).to_have_text('Открываю чат')
        expect(ui.locator('#dialogs-audit-pause')).to_be_enabled()
        assert ui.evaluate('calls.at(-1).type')=='DIALOGS_AUDIT_START'
        passed('fresh run issues only AUDIT_START')
        ui.locator('#dialogs-audit-pause').click();expect(ui.locator('#dialogs-audit-status')).to_have_text('На паузе')
        ui.locator('#dialogs-audit-resume').click();expect(ui.locator('#dialogs-audit-status')).to_have_text('Проверка идёт')
        assert [c['type'] for c in ui.evaluate('calls')][-2:]==['DIALOGS_STOP','DIALOGS_START']
        passed('pause and continue use reading commands without folder settings')
        ui.locator('#dialogs-audit-show-working-tab').uncheck()
        assert ui.evaluate('snapshot().settings.showWorkingTab') is False
        passed('working tab preference remains available in audit')
        ui.locator('#dialogs-audit-wechat').fill('new_wx_123')
        expect(ui.locator('#dialogs-audit-start')).to_be_disabled()
        ui.locator('#dialogs-audit-save').click();expect(ui.locator('#dialogs-audit-wechat')).to_have_value('new_wx_123')
        expect(ui.locator('#dialogs-audit-detail')).to_contain_text('ID изменён')
        expect(ui.locator('#dialogs-audit-resume')).to_be_disabled()
        expect(ui.locator('#dialogs-audit-report-note')).to_be_visible()
        assert ui.evaluate('calls.at(-1)')=={'type':'DIALOGS_SETTINGS','settings':{'wechat':'new_wx_123'}}
        passed('WeChat ID save is independent of product approval')
        ui.evaluate('seedReport()')
        expect(ui.locator('#dialogs-audit-count')).to_have_text('62 чатов')
        expect(ui.locator('#dialogs-audit-body tr')).to_have_count(50)
        assert ui.locator('#dialogs-audit-body tr').evaluate_all('(rows)=>rows.slice(0,6).map(r=>r.dataset.auditKey)')==['1688:one','1688:two','1688:incomplete','1688:error','1688:old','alibaba:six']
        assert 'Старый отчёт' not in ui.locator('#dialogs-audit-results').inner_text()
        assert 'старой логики' not in ui.locator('#dialogs-audit-results').inner_text()
        assert 'Не проверялся' not in ui.locator('#dialogs-audit-results').inner_text()
        passed('table only uses current audit records and keeps native order after retries')
        expect(ui.locator('[data-audit-key="1688:one"] td:nth-child(6)')).to_contain_text('09:02:02')
        expect(ui.locator('[data-audit-key="1688:incomplete"] td:nth-child(4)')).to_have_text('Не определено')
        passed('report uses PC local time and unknown dates stay explicit')
        row=ui.locator('tr[data-audit-key="1688:incomplete"]');expect(row.locator('details')).not_to_have_attribute('open','')
        assert ui.locator('#dialogs-audit-body .dialogs-audit-result').count()==50
        row.locator('summary').click();expect(row.locator('details p')).to_be_visible()
        ui.evaluate('announce()');expect(row.locator('details')).to_have_attribute('open','')
        passed('one concise result per row; long details expand and survive refresh')
        assert ui.locator('#dialogs-audit-body img, #dialogs-audit-body script').count()==0
        assert ui.locator('tr[data-audit-key="1688:error"] a').count()==0
        passed('seller text is escaped and unsafe URLs are rejected')
        ui.locator('#dialogs-audit-filter').select_option('incomplete');expect(ui.locator('#dialogs-audit-body tr')).to_have_count(2)
        ui.locator('#dialogs-audit-filter').select_option('found');expect(ui.locator('#dialogs-audit-body tr')).to_have_count(2)
        ui.locator('#dialogs-audit-platform').select_option('1688');expect(ui.locator('#dialogs-audit-body tr')).to_have_count(1)
        ui.locator('#dialogs-audit-search').fill('нет такого');expect(ui.locator('#dialogs-audit-empty')).to_be_visible()
        passed('results can be filtered by outcome/platform/text including failures')
        ui.locator('#dialogs-audit-search').fill('');ui.locator('#dialogs-audit-platform').select_option('all');ui.locator('#dialogs-audit-filter').select_option('all')
        ui.locator('#dialogs-audit-next').click();expect(ui.locator('#dialogs-audit-body tr')).to_have_count(12)
        expect(ui.locator('#dialogs-audit-page')).to_have_text('51–62 из 62')
        ui.locator('#dialogs-audit-prev').click()
        passed('large reports paginate with stable original ordinals')
        for width in [1450,980,650]:
            ui.set_viewport_size({'width':width,'height':1000})
            result=ui.locator('.dialogs-audit-table').evaluate('''table=>({nowrap:getComputedStyle(table).whiteSpace,small:[...table.querySelectorAll('th,td,summary')].some(e=>parseFloat(getComputedStyle(e).fontSize)<13),overflow:[...table.querySelectorAll('td')].some(e=>e.scrollWidth>e.clientWidth+1),pageOverflow:document.documentElement.scrollWidth>innerWidth+1})''')
            assert result=={'nowrap':'normal','small':False,'overflow':False,'pageOverflow':False},(width,result)
        passed('desktop and narrow views wrap text at >=13px without overlapping cells')
        ui.evaluate('block()');expect(ui.locator('#dialogs-audit-action')).to_have_text('Проверка остановлена')
        expect(ui.locator('#dialogs-audit-detail')).to_contain_text('Alibaba ещё не проверялась')
        expect(ui.locator('#dialogs-audit-platform-progress [data-platform="1688"]')).to_contain_text('Обход не завершён')
        expect(ui.locator('#dialogs-audit-platform-progress [data-platform="alibaba"]')).to_contain_text('Ожидает')
        expect(ui.locator('#dialogs-audit-resume')).to_be_enabled()
        passed('incomplete platform cannot appear as completed')
        ui.evaluate('complete()');expect(ui.locator('#dialogs-audit-status')).to_have_text('Обход завершён')
        expect(ui.locator('#dialogs-audit-resume')).to_be_disabled();expect(ui.locator('#dialogs-audit-start')).to_be_enabled()
        passed('finite completed run offers a new check instead of silently restarting')
        assert not errors,errors
        assert not external,external
        assert all(c['type'] in ['DIALOGS_GET','DIALOGS_JOINT_GET','DIALOGS_AUDIT_START','DIALOGS_START','DIALOGS_STOP','DIALOGS_SETTINGS'] for c in ui.evaluate('calls'))
        passed('no external requests, page errors, Claude jobs, or send commands')
        browser.close()
finally:
    server.shutdown()
print(f'{checks} audit UI browser checks passed')
