import test from 'node:test';
import assert from 'node:assert/strict';
import {createWechatAuditRunner} from '../extension/wechat-audit-runner.js';
import {initialDialogs,conversationKey} from '../extension/lib/dialogs.js';
import {startWechatAudit,normalizeWechatAudit,pauseWechatAudit,resumeWechatAudit,wechatContactFingerprint} from '../extension/lib/wechat-audit.js';

const names=['1688','alibaba','mic'];
const urls={'1688':'https://air.1688.com/chat/',alibaba:'https://message.alibaba.com/chat/',mic:'https://webim.made-in-china.com/super-tm/'};
function harness(){
  let time=1800000000000,cancelled=false,handler=null;
  const state=initialDialogs();state.settings.wechat='Buyer_ID';state.running=true;state.workflow.audit=startWechatAudit(null,state.settings.wechat,time,'run-one');
  const pages={},calls=[],scans=[],activities=[],activations=[],saves=[];
  for(const [index,name] of names.entries()){
    state.bindings[name]={tabId:index+1,url:urls[name],status:'ready'};
    pages[name]={rows:[],source:{frameId:0,documentToken:'doc-'+name,sourceUrl:urls[name],busy:false,listCoverage:{token:'list-'+name,progressToken:'page-0',atStart:true,hasMore:false,complete:true,status:'end_visible'}}};
  }
  const row=(name,id,position=0,extra={})=>({id,title:id,url:urls[name],frameId:0,documentToken:'doc-'+name,sourceUrl:urls[name],listOrder:position,identityReliable:true,canSelect:true,selectionToken:'select-'+id,active:false,historyStable:true,latestMessageAt:time-3600000,latestMessageAtReliable:true,...extra});
  const proof=(name,id,extra={})=>({ok:true,status:'not_found',observedAt:time,conversationId:id,documentToken:'doc-'+name,sourceUrl:urls[name],contactFingerprint:wechatContactFingerprint(state.settings.wechat),identityReliable:true,latestMessageAt:time-3600000,latestMessageAtReliable:true,found:false,complete:true,fullHistory:true,checkedMessages:5,reason:'complete_history',...extra});
  const api={tabs:{sendMessage:async(id,message,options)=>{
    const name=names[id-1];calls.push({platform:name,...structuredClone(message),...options});
    if(handler){const reply=await handler(name,message);if(reply!==undefined)return reply;}
    if(message.type==='DIALOGS_OPEN_CONVERSATION'){for(const item of pages[name].rows)item.active=item.id===message.conversationId;return {ok:true,openedId:message.conversationId};}
    if(message.type==='DIALOGS_CHECK_WECHAT')return proof(name,message.conversationId);
    if(message.type==='DIALOGS_ADVANCE_LIST'){if(message.direction==='start')pages[name].source.listCoverage.atStart=true;return {ok:true};}
    return {ok:true};
  }}};
  const runner=createWechatAuditRunner({api,now:()=>time,cancelled:()=>cancelled,scanPlatform:async(s,name)=>{scans.push(name);return Object.assign([],{rows:structuredClone(pages[name].rows),sources:[structuredClone(pages[name].source)]});},activateWorkingTab:async(s,name)=>{activations.push(name);},activity:(s,phase,detail,meta)=>activities.push({phase,detail,...meta}),save:async s=>saves.push(structuredClone(s.workflow.audit))});
  const step=async()=>{const result=await runner.step(state);if(result?.delay)time+=result.delay;return result;};
  const drain=async(limit=1000)=>{for(let n=0;n<limit&&state.running;n++)await step();assert.equal(state.running,false,'runner stopped within bounded test steps');};
  return {state,pages,row,proof,calls,scans,activities,activations,saves,step,drain,get now(){return time;},advance(ms){time+=ms;},set cancelled(value){cancelled=value;},set handler(value){handler=value;}};
}
const results=h=>Object.values(h.state.workflow.audit.records);
const actions=(h,type)=>h.calls.filter(call=>call.type===type);

test('finite pass checks each recent chat in visual order, then the next platform, without reply or product eligibility',async()=>{
  const h=harness();
  h.pages['1688'].rows=[h.row('1688','lower',2,{active:true}),h.row('1688','first',0),h.row('1688','second',1)];
  h.pages.alibaba.rows=[h.row('alibaba','ali')];h.pages.mic.rows=[h.row('mic','mic')];
  h.state.conversations[conversationKey('1688','first')]={draft:{text:'old draft'},paused:true,unanswered:false,wechatEvidence:[{old:true}]};
  await h.drain();
  assert.deepEqual(actions(h,'DIALOGS_CHECK_WECHAT').map(call=>call.conversationId),['first','second','lower','ali','mic']);
  assert.deepEqual(results(h).map(row=>row.id),['first','second','lower','ali','mic']);
  assert.equal(h.state.workflow.audit.phase,'completed');assert.equal(h.state.workflow.audit.cursor,3);
  assert.ok(h.calls.every(call=>['DIALOGS_OPEN_CONVERSATION','DIALOGS_CHECK_WECHAT'].includes(call.type)));
  assert.ok(h.scans.lastIndexOf('1688')<h.scans.indexOf('alibaba'));assert.ok(h.scans.lastIndexOf('alibaba')<h.scans.indexOf('mic'));
});
test('a fresh pass returns to a proven list top before opening or checking any chat',async()=>{
  const h=harness();h.pages['1688'].source.listCoverage.atStart=false;h.pages['1688'].rows=[h.row('1688','middle',20,{active:true})];
  h.handler=(name,message)=>{if(message.type==='DIALOGS_ADVANCE_LIST'&&message.direction==='start'){h.pages[name].source.listCoverage.atStart=true;h.pages[name].rows=[h.row(name,'top',0),h.row(name,'middle',20,{active:true})];return {ok:true};}};
  await h.drain();assert.equal(h.calls[0].direction,'start');assert.equal(actions(h,'DIALOGS_CHECK_WECHAT')[0].conversationId,'top');
});
test('failed top proof blocks the current platform rather than scanning from the middle or moving on',async()=>{
  const h=harness();h.pages['1688'].source.listCoverage.atStart=false;h.pages['1688'].rows=[h.row('1688','middle',20)];h.handler=(name,message)=>message.type==='DIALOGS_ADVANCE_LIST'?{ok:true}:undefined;
  await h.drain();assert.equal(h.state.workflow.audit.phase,'blocked');assert.equal(actions(h,'DIALOGS_ADVANCE_LIST').length,3);assert.deepEqual([...new Set(h.scans)],['1688']);assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,0);
});
test('metadata may skip reliably old rows, but unknown dates are opened and freshly checked',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','old',0,{latestMessageAt:h.now-86400001}),h.row('1688','unknown',1,{latestMessageAt:null,latestMessageAtReliable:false})];
  await h.drain();assert.deepEqual(results(h).map(row=>[row.id,row.status]),[['old','older'],['unknown','not_found']]);assert.deepEqual(actions(h,'DIALOGS_OPEN_CONVERSATION').map(call=>call.conversationId),['unknown']);
});
test('cached positives never satisfy the new run, including a currently active first row',async()=>{
  const h=harness(),key=conversationKey('1688','selected');h.pages['1688'].rows=[h.row('1688','selected',0,{active:true,canSelect:false,selectionToken:undefined})];
  h.state.workflow.visits[key]={status:'completed'};h.state.contactLedger.records[key]={wechatEvidence:[{contactFingerprint:wechatContactFingerprint('Buyer_ID')}]};
  await h.drain();assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,1);assert.equal(results(h)[0].status,'not_found');
});
test('fresh match is enough in any participant message, even when earlier history is unavailable',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','supplier')];h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?h.proof(name,message.conversationId,{status:'found',found:true,complete:false,fullHistory:false,matchDirection:'inbound'}):undefined;
  await h.drain();assert.equal(results(h)[0].status,'found');assert.equal(results(h)[0].matchDirection,'inbound');assert.equal(actions(h,'DIALOGS_LOAD_HISTORY_START').length,0);
});
test('negative result requires full history; loads older pages and latest tail before reporting absence',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','supplier')];let phase=0;
  h.handler=(name,message)=>{
    if(message.type==='DIALOGS_CHECK_WECHAT')return h.proof(name,message.conversationId,phase===0?{status:'incomplete',complete:false,fullHistory:false,reason:'history_start_missing'}:phase===1?{status:'incomplete',complete:false,fullHistory:false,reason:'history_tail_missing'}:{});
    if(message.type==='DIALOGS_LOAD_HISTORY_START'){assert.equal(message.purpose,'wechat-audit');phase=1;return {ok:true,status:'complete'};}
    if(message.type==='DIALOGS_REVEAL_LATEST'){phase=2;return {ok:true};}
  };
  await h.drain();assert.equal(results(h)[0].status,'not_found');assert.equal(actions(h,'DIALOGS_LOAD_HISTORY_START').length,1);assert.equal(actions(h,'DIALOGS_REVEAL_LATEST').length,1);assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,3);
});
test('unreadable history is reported once and remaining chats are checked; platform then blocks instead of claiming completion',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','bad',0),h.row('1688','good',1)];
  h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'&&message.conversationId==='bad'?h.proof(name,'bad',{status:'incomplete',complete:false,fullHistory:false,reason:'history_unreadable'}):undefined;
  await h.drain();assert.deepEqual(results(h).map(row=>[row.id,row.status]),[['bad','incomplete'],['good','not_found']]);assert.equal(h.state.workflow.audit.phase,'blocked');assert.deepEqual([...new Set(h.scans)],['1688']);
});
test('absence without fullHistory cannot masquerade as complete',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','bad')];h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?h.proof(name,'bad',{fullHistory:false}):undefined;
  await h.drain();assert.equal(results(h)[0].status,'incomplete');assert.equal(h.state.workflow.audit.phase,'blocked');
});
test('stale document, contact, thread or time proofs never produce a result of found or not found',async()=>{
  for(const override of [{documentToken:'old'},{contactFingerprint:'bad'},{conversationId:'wrong'},{sourceUrl:'https://evil.test/'},{observedAt:0}]){
    const h=harness();h.pages['1688'].rows=[h.row('1688','bad')];h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?h.proof(name,'bad',override):undefined;
    await h.drain();assert.equal(results(h)[0].status,'incomplete');assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,8);
  }
});
test('busy draft or user input pauses current platform and never skips to Alibaba',async()=>{
  const h=harness();h.pages['1688'].source.busy={hasDraft:true};await h.drain();assert.equal(h.state.workflow.audit.phase,'blocked');assert.deepEqual(h.scans,['1688']);assert.equal(h.calls.length,0);
});
test('native list loading waits without exhausting attempts, and unconfirmed exhaustion blocks',async()=>{
  const h=harness();h.pages['1688'].source.listCoverage={token:'t',atStart:true,hasMore:false,complete:false};await h.drain();assert.equal(h.state.workflow.audit.phase,'blocked');assert.deepEqual(h.scans,['1688']);
  const loading=harness();loading.pages['1688'].source.listCoverage.loading=true;
  for(let i=0;i<12;i++)await loading.step();assert.equal(loading.state.running,true);assert.equal(loading.state.workflow.audit.progress.listStalls,0);assert.equal(loading.calls.length,0);
  loading.advance(120000);await loading.step();assert.equal(loading.state.workflow.audit.phase,'blocked');
});
test('virtual pagination covers every loaded page before moving to another platform',async()=>{
  const h=harness();let page=0;h.pages['1688'].rows=[h.row('1688','row-0',0)];Object.assign(h.pages['1688'].source.listCoverage,{complete:false,hasMore:true});
  h.handler=(name,message)=>{if(message.type==='DIALOGS_ADVANCE_LIST'){page++;h.pages[name].rows=[h.row(name,'row-'+page,page)];Object.assign(h.pages[name].source.listCoverage,{progressToken:'page-'+page,complete:page===70,hasMore:page<70});return {ok:true};}};
  await h.drain();assert.equal(results(h).length,71);assert.equal(actions(h,'DIALOGS_ADVANCE_LIST').length,70);assert.equal(h.state.workflow.audit.phase,'completed');
});
test('cosmetic list action tokens do not reset bounded no-progress detection',async()=>{
  const h=harness();Object.assign(h.pages['1688'].source.listCoverage,{complete:false,hasMore:true});let index=0;
  h.handler=(name,message)=>{if(message.type==='DIALOGS_ADVANCE_LIST'){h.pages[name].source.listCoverage.token='cosmetic-'+(++index);return {ok:true};}};
  await h.drain();assert.equal(h.state.workflow.audit.phase,'blocked');assert.equal(actions(h,'DIALOGS_ADVANCE_LIST').length,8);assert.deepEqual([...new Set(h.scans)],['1688']);
});
test('history loading does not spend retry budget; repeated unchanged history does',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','bad')];h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?h.proof(name,'bad',{status:'incomplete',complete:false,fullHistory:false,reason:'history_start_missing'}):message.type==='DIALOGS_LOAD_HISTORY_START'?{ok:true}:undefined;
  await h.drain();assert.equal(results(h)[0].status,'incomplete');assert.equal(actions(h,'DIALOGS_LOAD_HISTORY_START').length,8);
  const loading=harness();loading.pages['1688'].rows=[loading.row('1688','wait')];loading.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?loading.proof(name,'wait',{status:'loading',complete:false,fullHistory:false}):undefined;
  for(let i=0;i<20;i++)await loading.step();assert.equal(loading.state.running,true);assert.equal(loading.state.workflow.audit.progress.pending.attempts,0);loading.advance(120000);await loading.drain();assert.equal(results(loading)[0].status,'incomplete');
});
test('pause and serialized reload preserve position while fresh restart returns to first chat',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','first',0),h.row('1688','second',1)];
  while(!results(h).length)await h.step();pauseWechatAudit(h.state.workflow.audit);h.state.running=false;h.state.workflow.audit=normalizeWechatAudit(h.state.workflow.audit);
  const before=h.calls.length;await h.step();assert.equal(h.calls.length,before);resumeWechatAudit(h.state.workflow.audit,h.state.settings.wechat,h.now);h.state.running=true;await h.drain();assert.deepEqual(actions(h,'DIALOGS_CHECK_WECHAT').map(call=>call.conversationId),['first','second']);
  h.state.workflow.audit=startWechatAudit(h.state.workflow.audit,h.state.settings.wechat,h.now,'second-run');h.state.running=true;await h.drain();assert.deepEqual(actions(h,'DIALOGS_CHECK_WECHAT').map(call=>call.conversationId),['first','second','first','second']);
});
test('contact change blocks the run and cancellation between scan and action prevents mutations',async()=>{
  const h=harness();h.state.settings.wechat='Different';await h.drain();assert.equal(h.state.workflow.audit.phase,'blocked');assert.equal(h.scans.length,0);
  const cancelled=harness();cancelled.cancelled=true;await cancelled.step();assert.equal(cancelled.calls.length,0);assert.equal(cancelled.scans.length,0);
});
test('a changed page after positioning blocks traversal instead of reusing old pending evidence',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','first')];await h.step();h.pages['1688'].source.documentToken='new-document';await h.step();assert.equal(h.state.workflow.audit.phase,'blocked');assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,0);
});
test('serialized state strips tracking URLs without losing current document and recipient proofs',async()=>{
  const h=harness();
  for(const name of names){const url=urls[name]+'?spm=tracking&bootstrap=secret#/messenger?tab=chat';h.pages[name].source.sourceUrl=url;h.pages[name].rows=[h.row(name,name,0,{sourceUrl:url})];}
  h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?h.proof(name,message.conversationId,{sourceUrl:h.pages[name].source.sourceUrl}):undefined;
  for(let i=0;i<100&&h.state.running;i++){await h.step();h.state.workflow.audit=normalizeWechatAudit(h.state.workflow.audit);}
  assert.equal(h.state.workflow.audit.phase,'completed');assert.deepEqual(results(h).map(row=>row.status),['not_found','not_found','not_found']);
});
test('cancelled response does not record a result or dispatch another reader action',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','first',0,{active:true})];
  h.handler=(name,message)=>{if(message.type==='DIALOGS_CHECK_WECHAT'){h.cancelled=true;return h.proof(name,'first');}};
  await h.step();await h.step();assert.equal(results(h).length,0);assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,1);
});
test('a long explicit pause does not spend the pending chat read timeout',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','first')];await h.step();
  const pendingBefore=structuredClone(h.state.workflow.audit.progress.pending);
  pauseWechatAudit(h.state.workflow.audit,h.now);h.state.running=false;h.advance(5*60000);
  h.state.workflow.audit=normalizeWechatAudit(h.state.workflow.audit);resumeWechatAudit(h.state.workflow.audit,h.state.settings.wechat,h.now);h.state.running=true;
  assert.equal(h.state.workflow.audit.progress.pending.id,pendingBefore.id);await h.drain();assert.equal(results(h)[0].status,'not_found');assert.equal(actions(h,'DIALOGS_OPEN_CONVERSATION').length,1);
});
test('fixed-size history windows continue beyond eight pages when their actual content changes',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','long-history')];let page=0;
  h.handler=(name,message)=>{
    if(message.type==='DIALOGS_CHECK_WECHAT')return h.proof(name,message.conversationId,{checkedMessages:100,historyProgress:wechatContactFingerprint('history-content-'+page),...(page<12?{status:'incomplete',complete:false,fullHistory:false,reason:'history_start_missing'}:{})});
    if(message.type==='DIALOGS_LOAD_HISTORY_START'){page++;return {ok:true};}
  };
  await h.drain();assert.equal(results(h)[0].status,'not_found');assert.equal(actions(h,'DIALOGS_LOAD_HISTORY_START').length,12);
});
test('fresh observation times do not hide a stalled history with unchanged content digest',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','stalled-history')];
  h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?h.proof(name,message.conversationId,{status:'incomplete',complete:false,fullHistory:false,reason:'history_start_missing',historyProgress:wechatContactFingerprint('same-history')}):undefined;
  await h.drain();assert.equal(results(h)[0].status,'incomplete');assert.equal(actions(h,'DIALOGS_LOAD_HISTORY_START').length,8);
});
test('unknown latest date above the tail reveals latest messages before recording a fresh WeChat match',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','above-tail',0,{active:true,latestMessageAt:null,latestMessageAtReliable:false})];let revealed=false;
  h.handler=(name,message)=>{
    if(message.type==='DIALOGS_CHECK_WECHAT')return h.proof(name,message.conversationId,revealed?{status:'found',found:true,fullHistory:false,complete:false,reason:'contact_found',matchDirection:'outbound'}:{status:'incomplete',found:false,fullHistory:false,complete:false,reason:'history_tail_missing',latestMessageAt:null,latestMessageAtReliable:false});
    if(message.type==='DIALOGS_REVEAL_LATEST'){revealed=true;return {ok:true};}
  };
  await h.step();await h.step();assert.equal(results(h).length,0);assert.equal(h.state.workflow.audit.progress.pending.phase,'history_tail');
  await h.step();assert.equal(results(h).length,0);await h.drain();
  assert.equal(results(h)[0].status,'found');assert.equal(actions(h,'DIALOGS_REVEAL_LATEST').length,1);assert.equal(actions(h,'DIALOGS_LOAD_HISTORY_START').length,0);assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,2);
});
test('an actual pending native latest-time proof is awaited without recording a premature incomplete row',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','date-pending',0,{active:true,latestMessageAt:null,latestMessageAtReliable:false})];let checks=0;
  h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?h.proof(name,message.conversationId,++checks<=2?{status:'loading',reason:'latest_time_pending',found:false,complete:false,fullHistory:false,latestMessageAt:null,latestMessageAtReliable:false,retryAfterMs:1000}:{status:'found',reason:'contact_found',found:true}):undefined;
  await h.step();await h.step();await h.step();assert.equal(results(h).length,0);assert.equal(h.state.running,true);await h.drain();
  assert.equal(results(h)[0].status,'found');assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,3);assert.equal(actions(h,'DIALOGS_REVEAL_LATEST').length,0);
});
test('unknown date after native proof is unavailable stays incomplete even if contact text was visible',async()=>{
  const h=harness();h.pages['1688'].rows=[h.row('1688','date-unavailable',0,{active:true,latestMessageAt:null,latestMessageAtReliable:false})];
  h.handler=(name,message)=>message.type==='DIALOGS_CHECK_WECHAT'?h.proof(name,message.conversationId,{status:'incomplete',reason:'latest_time_unknown',found:false,complete:false,fullHistory:false,latestMessageAt:null,latestMessageAtReliable:false}):undefined;
  await h.drain();assert.equal(results(h)[0].status,'incomplete');assert.equal(h.state.workflow.audit.phase,'blocked');assert.equal(actions(h,'DIALOGS_CHECK_WECHAT').length,1);
});
