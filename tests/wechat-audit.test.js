import test from 'node:test';
import assert from 'node:assert/strict';
import {initialWechatAudit,normalizeWechatAudit,startWechatAudit,pauseWechatAudit,resumeWechatAudit,recordWechatAuditResult,assessWechatAuditConversation,wechatAuditSummary,wechatAuditHasResult,wechatContactFingerprint,textContainsWechatContact,WECHAT_AUDIT_LIMITS} from '../extension/lib/wechat-audit.js';
import {initialDialogs,normalizeDialogs,validateDialogSettings,setDialogSettings} from '../extension/lib/dialogs.js';
const now=Date.UTC(2026,9,19,12),contact='wx_Buyer42';
const run=()=>startWechatAudit(null,contact,now,'run-current');
const item=(extra={})=>({id:'chat1',key:'1688:chat1',platform:'1688',active:true,identityReliable:true,lastObservedAt:now,latestMessageAt:now-1000,latestMessageAtReliable:true,messages:[{key:'1',direction:'inbound',text:'Hello',at:now-1000}],historyComplete:true,historyStartKnown:true,tailKnown:true,orderReliable:true,needsRead:false,...extra});
const assess=(value,extra={})=>assessWechatAuditConversation(value,contact,{now,openedAt:now-100,runStartedAt:now-200,...extra});
const result=(extra={})=>({platform:'1688',id:'chat1',key:'1688:chat1',title:'Seller',url:'https://air.1688.com/app/chat?token=secret&touid=seller',position:0,status:'found',detail:'ID найден.',lastMessageAt:now-1000,...extra});
const record=(audit,value=result(),extra={})=>recordWechatAuditResult(audit,value,{runId:audit.runId,contact,...extra},now);
const proof=(extra={})=>({status:'not_found',conversationId:'chat1',observedAt:now,contactFingerprint:wechatContactFingerprint(contact),identityReliable:true,latestMessageAt:now-1000,latestMessageAtReliable:true,found:false,complete:true,fullHistory:true,...extra});

test('audit settings normalize independently and remain opt-in for existing model callers',()=>{
  assert.equal(initialDialogs().settings.wechatAudit,false);
  assert.equal(validateDialogSettings({wechatAudit:true}).wechatAudit,true);
  const state=initialDialogs();setDialogSettings(state,{wechatAudit:true},now);
  assert.equal(normalizeDialogs(state,now).settings.wechatAudit,true);
  assert.equal(normalizeDialogs(state,now).workflow.audit.phase,'idle');
});
test('fresh pass discards only prior audit results and gets distinct current scope',()=>{
  const old=run();record(old);old.phase='completed';
  const fresh=startWechatAudit(old,'different-ID',now+1,'next-run');
  assert.deepEqual(fresh.records,{});assert.equal(fresh.runId,'next-run');assert.equal(fresh.cursor,0);assert.equal(fresh.phase,'running');assert.equal(fresh.platforms['1688'].phase,'running');assert.notEqual(fresh.contactFingerprint,old.contactFingerprint);assert.equal(Object.keys(old.records).length,1);
  assert.throws(()=>startWechatAudit(old,'  ',now),/WeChat/);
});
test('pause and resume keep all current results and the read position',()=>{
  const audit=run();record(audit);audit.cursor=1;audit.progress.positioned=true;audit.progress.pending={key:'alibaba:next',id:'next',phase:'check'};
  pauseWechatAudit(audit,now);assert.equal(audit.phase,'paused');assert.equal(record(audit).reason,'not_running');
  resumeWechatAudit(audit,contact,now+1);assert.equal(audit.phase,'running');assert.equal(audit.cursor,1);assert.equal(audit.progress.pending.id,'next');assert.equal(Object.keys(audit.records).length,1);
});
test('changed contact and stale asynchronous run results cannot contaminate report',()=>{
  const audit=run();assert.equal(record(audit,result(),{runId:'old-run'}).reason,'stale_run');assert.equal(record(audit,result(),{contact:'other-id'}).reason,'changed_contact');assert.deepEqual(audit.records,{});
  pauseWechatAudit(audit);resumeWechatAudit(audit,'other-id');assert.equal(audit.phase,'blocked');assert.match(audit.blockedReason,/изменён/);
});
test('matching is case and Unicode tolerant but rejects larger IDs and empty contacts',()=>{
  assert.equal(textContainsWechatContact('WeChat: ＷＸ_Ｂｕｙｅｒ４２！',contact),true);
  assert.equal(textContainsWechatContact('hello wx_\u200bBuyer42',contact),true);
  assert.equal(textContainsWechatContact('wx_Buyer420',contact),false);
  assert.equal(textContainsWechatContact('prefix-wx_Buyer42',contact),false);
  assert.equal(textContainsWechatContact('anything',''),false);
  assert.equal(wechatContactFingerprint(' WX_Buyer42 '),wechatContactFingerprint(contact));
});
test('any actual message author can supply positive evidence regardless of draft eligibility',()=>{
  for(const direction of ['inbound','outbound','unknown','system']){
    const checked=assess(item({messages:[{key:'m',text:'My ID is '+contact,direction}],historyComplete:false,needsRead:true,orderReliable:false,takeover:true,paused:true}));
    assert.equal(checked.status,'found',direction);assert.equal(checked.matchDirection,direction);
  }
});
test('cached legacy evidence and unrelated drafts never establish current pass contact result',()=>{
  const checked=assess(item({historyComplete:false,wechatEvidence:[{contactFingerprint:wechatContactFingerprint(contact)}],draft:{text:contact},previousDraft:{text:contact},readScan:{status:'shared'}}));
  assert.equal(checked.status,'incomplete');
});
test('fresh opening and reliable chat identity are required even for a positive match',()=>{
  const positive=item({messages:[{key:'m',direction:'outbound',text:contact}]});
  for(const change of [{active:false},{identityReliable:false},{lastObservedAt:now-1000},{lastObservedAt:now+6000}])assert.equal(assess({...positive,...change}).status,'incomplete');
  assert.equal(assessWechatAuditConversation(positive,contact,{now}).status,'incomplete');
});
test('scope is last message within 24 hours, exactly boundary included',()=>{
  assert.equal(assess(item({latestMessageAt:now-86400000})).status,'not_found');
  assert.equal(assess(item({latestMessageAt:now-86400001,messages:[{text:contact}]})).status,'older');
  assert.equal(assess(item({latestMessageAt:now+300001})).status,'incomplete');
  assert.equal(assess(item({latestMessageAtReliable:false,tailKnown:false})).status,'incomplete');
  assert.equal(assess(item({latestMessageAtReliable:false})).status,'not_found');
});
test('absence requires complete readable history and not merely latest messages',()=>{
  assert.equal(assess(item()).status,'not_found');
  for(const change of [{historyComplete:false},{historyStartKnown:false},{tailKnown:false},{orderReliable:false},{needsRead:true},{coverage:{limited:true}},{coverage:{unreadAttachments:1}},{coverage:{unsupportedMessages:1}},{coverage:{unmatchedTextNodes:1}},{messages:[{text:'Hello',format:'unrecognized'}]},{messages:[{text:'Hello',attachments:[{contentReady:false}]}]}])assert.equal(assess(item(change)).status,'incomplete',JSON.stringify(change));
});
test('read-only audit does not need a product, seller reply or recognized sender for absence',()=>{
  assert.equal(assess(item({messages:[{direction:'unknown',text:'Hello'}],coverage:{unknownSenders:1},unanswered:false,firstBuyerMessage:null})).status,'not_found');
});
test('dedicated fresh full-history reader proves absence beyond bounded transcript cache',()=>{
  const bounded=item({messages:[],historyComplete:false,tailKnown:false,needsRead:true});
  assert.equal(assess(bounded,{proof:proof()}).status,'not_found');
  for(const change of [{complete:false},{fullHistory:false},{status:'incomplete'},{found:undefined}])assert.equal(assess(bounded,{proof:proof(change)}).status,'incomplete');
});
test('native positive reader proof survives partial history but is tied to chat/contact/time',()=>{
  const positive=proof({status:'found',found:true,complete:false,fullHistory:false,matchDirection:'inbound',matchMessageKey:'seller-1'});
  const checked=assess(item(),{proof:positive});assert.equal(checked.status,'found');assert.equal(checked.matchMessageKey,'seller-1');
  for(const change of [{conversationId:'different-chat'},{contactFingerprint:wechatContactFingerprint('other-id')},{observedAt:now-1000},{identityReliable:false}])assert.equal(assess(item(),{proof:{...positive,...change}}).status,'incomplete');
});
test('result report isolates current run, strips sensitive query values and counts separately',()=>{
  const audit=run(),saved=record(audit);assert.equal(saved.accepted,true);assert.equal(saved.record.url,'https://air.1688.com/app/chat?touid=seller');assert.equal(saved.record.checkedAt,now);
  record(audit,result({id:'c2',key:'1688:c2',status:'not_found',position:1}));record(audit,result({id:'c3',key:'1688:c3',status:'incomplete',position:2}));record(audit,result({id:'c4',key:'1688:c4',status:'error',position:3}));record(audit,result({id:'c5',key:'1688:c5',status:'older',position:4}));
  assert.deepEqual(wechatAuditSummary(audit),{total:5,found:1,not_found:1,older:1,incomplete:1,error:1});
  assert.equal(wechatAuditHasResult(audit,'1688:chat1',contact),true);assert.equal(wechatAuditHasResult(audit,'1688:chat1','different'),false);assert.equal(wechatAuditHasResult(audit,'1688:c3',contact),false);assert.equal(wechatAuditHasResult(audit,'1688:c4',contact),false);
});
test('result validation rejects malformed IDs/platforms and replaces one row instead of stacking text',()=>{
  const audit=run();assert.equal(record(audit,result({key:'1688:another'})).reason,'invalid_result');assert.equal(record(audit,result({platform:'invalid'})).reason,'invalid_result');assert.equal(record(audit,result({status:'sent'})).reason,'invalid_result');
  record(audit,result({status:'incomplete',detail:'Could not read.'}));record(audit,result({status:'found',detail:'Found.'}));assert.equal(Object.keys(audit.records).length,1);assert.equal(audit.records['1688:chat1'].detail,'Found.');
});
test('normalization preserves run/order/progress separately from legacy workflow visits',()=>{
  const state=initialDialogs(),audit=run();record(audit);audit.progress={positioned:true,nextAt:now+20,listProgress:'native-40',listStalls:2,startAttempts:1,startedAt:now,waitingSince:now,documentToken:'current-doc',frameId:3,sourceUrl:'https://air.1688.com/chat?token=secret',pending:{key:'1688:next',id:'next',title:'Next seller',url:'https://next.1688.com/',position:20,latestMessageAt:now-1000,latestMessageAtReliable:true,frameId:3,documentToken:'current-doc',sourceUrl:'https://air.1688.com/chat',startedAt:now,openedAt:now,attempts:1,phase:'history_start',historyAttempts:2,nextAt:now+20,lastProgress:'100 messages'}};
  state.workflow.audit=audit;state.workflow.visits={'1688:old':{status:'completed',at:now}};const restored=normalizeDialogs(state,now).workflow;
  assert.equal(restored.audit.records['1688:chat1'].status,'found');assert.equal(restored.audit.progress.pending.phase,'history_start');assert.equal(restored.audit.progress.pending.position,20);assert.equal(restored.audit.progress.sourceUrl,'https://air.1688.com/chat');assert.equal(restored.audit.progress.waitingSince,now);assert.ok(restored.visits['1688:old']);
});
test('restore discards stale-run records and never resurrects fake successful completion',()=>{
  const audit=run();record(audit);audit.records['1688:old']={...audit.records['1688:chat1'],key:'1688:old',id:'old',runId:'old'};audit.phase='completed';audit.cursor=3;
  const restored=normalizeWechatAudit(audit);assert.equal(Object.keys(restored.records).length,1);assert.equal(restored.phase,'blocked');assert.equal(restored.finishedAt,null);
  for(const platform of Object.keys(audit.platforms))audit.platforms[platform].phase='completed';assert.equal(normalizeWechatAudit(audit).phase,'completed');
  audit.records['1688:chat1'].status='incomplete';assert.equal(normalizeWechatAudit(audit).phase,'blocked');
});
test('record count limit stops explicitly without silently evicting earlier rows',()=>{
  const audit=run();for(let i=0;i<WECHAT_AUDIT_LIMITS.records;i++)assert.equal(record(audit,result({id:'c'+i,key:'1688:c'+i,title:'',detail:'',url:'',position:i})).accepted,true);
  assert.equal(record(audit,result({id:'one-more',key:'1688:one-more'})).reason,'capacity');assert.equal(audit.phase,'blocked');assert.equal(audit.saturated,true);assert.equal(Object.keys(audit.records).length,2000);assert.ok(audit.records['1688:c0']);assert.ok(audit.records['1688:c1999']);resumeWechatAudit(audit,contact);assert.equal(audit.phase,'blocked');
});
test('byte budget stops explicitly with prior records intact',()=>{
  const audit=run();let accepted=0;for(let i=0;i<2000;i++){const saved=record(audit,result({id:'c'+i,key:'1688:c'+i,title:'Ж'.repeat(300),detail:'Ж'.repeat(1200),position:i}));if(!saved.accepted){assert.equal(saved.reason,'capacity');break;}accepted++;}
  assert.ok(accepted>0&&accepted<2000);assert.equal(Object.keys(audit.records).length,accepted);assert.ok(audit.bytes<=WECHAT_AUDIT_LIMITS.bytes);assert.equal(audit.saturated,true);
  const restored=normalizeWechatAudit(audit);assert.equal(restored.phase,'blocked');assert.equal(Object.keys(restored.records).length,accepted);
});
test('oversized persisted report is explicitly marked truncated rather than complete',()=>{
  const audit=run();for(let i=0;i<2001;i++)audit.records['1688:c'+i]={...result({id:'c'+i,key:'1688:c'+i}),runId:audit.runId,checkedAt:now};
  const restored=normalizeWechatAudit(audit);assert.equal(Object.keys(restored.records).length,2000);assert.equal(restored.discardedRecords,1);assert.equal(restored.phase,'blocked');assert.equal(restored.saturated,true);assert.match(restored.blockedReason,/предел отчёта/);
});
test('explicit blocked retry restarts only current platform and retains conclusive report rows',()=>{
  const audit=run();record(audit);record(audit,result({id:'retry',key:'1688:retry',status:'incomplete'}));record(audit,result({platform:'alibaba',id:'later',key:'alibaba:later',url:'https://message.alibaba.com/',status:'error'}));audit.phase='blocked';audit.progress.positioned=true;audit.progress.pending={key:'1688:retry',id:'retry',phase:'check'};audit.platforms['1688'].phase='blocked';
  resumeWechatAudit(audit,contact,now+1);assert.equal(audit.phase,'running');assert.equal(audit.records['1688:retry'],undefined);assert.ok(audit.records['1688:chat1']);assert.ok(audit.records['alibaba:later']);assert.equal(audit.progress.positioned,false);assert.equal(audit.progress.pending,null);assert.equal(audit.platforms['1688'].phase,'running');assert.equal(normalizeWechatAudit(audit).bytes,audit.bytes);
});
test('long pause preserves remaining reader and list deadlines through serialization',()=>{
  let audit=run();audit.progress.startedAt=now-30000;audit.progress.waitingSince=now-10000;audit.progress.nextAt=now+1000;
  audit.progress.pending={key:'1688:chat1',id:'chat1',startedAt:now-45000,openedAt:now-44000,nextAt:now+500,phase:'check',historyAttempts:2};
  pauseWechatAudit(audit,now);assert.equal(audit.pausedAt,now);audit=normalizeWechatAudit(audit);
  const resumedAt=now+600000;resumeWechatAudit(audit,contact,resumedAt);
  assert.equal(audit.phase,'running');assert.equal(audit.pausedAt,null);assert.equal(audit.startedAt,now);
  assert.equal(resumedAt-audit.progress.pending.startedAt,45000);assert.equal(audit.progress.pending.openedAt,now-44000);assert.equal(audit.progress.pending.nextAt,resumedAt+500);
  assert.equal(resumedAt-audit.progress.startedAt,30000);assert.equal(resumedAt-audit.progress.waitingSince,10000);assert.equal(audit.progress.nextAt,resumedAt+1000);assert.equal(audit.progress.pending.historyAttempts,2);
});
test('repeated pauses preserve consumed timeout budget and do not create zero-sentinel waits',()=>{
  const audit=run();audit.progress.pending={startedAt:now-119000,nextAt:0};audit.progress.nextAt=0;
  pauseWechatAudit(audit,now);pauseWechatAudit(audit,now+1000);assert.equal(audit.pausedAt,now);
  resumeWechatAudit(audit,contact,now+120000);assert.equal(now+120000-audit.progress.pending.startedAt,119000);assert.equal(audit.progress.pending.nextAt,0);assert.equal(audit.progress.nextAt,0);
  pauseWechatAudit(audit,now+120500);resumeWechatAudit(audit,contact,now+999000);assert.equal(now+999000-audit.progress.pending.startedAt,119500);
});
