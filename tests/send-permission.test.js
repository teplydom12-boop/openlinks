import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../extension/lib/core.js';
import {folderDigest} from '../extension/lib/folder-bridge.js';
import {checkSendDocument,evaluateSendPermission} from '../extension/lib/send-permission.js';

const URL='https://onetalk.alibaba.com/message/weblite.htm#/';
function fixture(url=URL,platform='alibaba') {
  const state=initialState();
  const job={id:'job-1',platform,tabId:7,frameId:1012,sendDocumentId:'prepared-document',reviewUrl:url,
    message:'Hello supplier',status:'sending',approved:true,attemptId:'attempt-1',sendAt:1234};
  state.running=true;state.activeId=job.id;state.queue=[job];
  state.slots=[{kind:'send',platform,jobId:job.id,at:job.sendAt}];
  const message={scope:'outreach',jobId:job.id,attemptId:job.attemptId,expectedUrl:url,message:job.message};
  const sender={id:'extension',tab:{id:job.tabId},frameId:job.frameId,documentId:job.sendDocumentId,url:url.split('#')[0]};
  const frame={frameId:job.frameId,documentId:job.sendDocumentId,url};
  const args={state,message,sender,runtimeId:'extension',folder:{test:{enabled:true}},dialogs:undefined,
    getCurrentFrame:async(tabId,frameId)=>{assert.equal(tabId,7);assert.equal(frameId,1012);return frame;},
    isMonitoredTab:async()=>false};
  return {args,state,job,message,sender,frame,run:()=>evaluateSendPermission(args)};
}
async function denied(f,code,ok=true) {
  assert.deepEqual(await f.run(),{ok,canSend:false,reasonCode:code});
}

test('Alibaba runtime sender may omit #/ only when current and prepared documents prove the complete URL',async()=>{
  const f=fixture(),before=structuredClone({state:f.state,message:f.message,sender:f.sender,frame:f.frame});
  assert.notEqual(f.sender.url,f.message.expectedUrl);
  assert.deepEqual(await f.run(),{ok:true,canSend:true});
  assert.deepEqual({state:f.state,message:f.message,sender:f.sender,frame:f.frame},before,'The permission check does not alter the reservation or draft');
  f.sender.url=f.message.expectedUrl;
  assert.deepEqual(await f.run(),{ok:true,canSend:true});
});

test('read-only document evidence does not authorize a paused queue',async()=>{
  const f=fixture();f.state.running=false;
  assert.equal(checkSendDocument({expectedUrl:f.message.expectedUrl,sender:f.sender,frame:f.frame,preparedDocumentId:f.job.sendDocumentId}),null);
  await denied(f,'outreach_not_approved');
});

test('the document check works for the other platforms without weakening their URL checks',async()=>{
  for(const [platform,url] of [
    ['1688','https://air.1688.com/app/chat/index.html?touid=seller#/'],
    ['mic','https://membercenter.made-in-china.com/message.do'],
  ])assert.deepEqual(await fixture(url,platform).run(),{ok:true,canSend:true});
});

test('an omitted fragment never permits a changed live SPA recipient or frame URL',async()=>{
  for(const current of [
    'https://onetalk.alibaba.com/message/weblite.htm#/other-seller',
    'https://onetalk.alibaba.com/message/weblite.htm',
    'https://onetalk.alibaba.com/message/weblite.htm?recipient=other#/',
    'https://onetalk.alibaba.com/message/other.htm#/',
    'https://other.alibaba.com/message/weblite.htm#/',
  ]) {
    const f=fixture();f.frame.url=current;await denied(f,'frame_url_changed');
  }
});

test('only a wholly omitted sender fragment is a transport exception; origin, query and path remain exact',async()=>{
  for(const senderUrl of [
    'https://onetalk.alibaba.com/message/weblite.htm#/other-seller',
    'https://onetalk.alibaba.com/message/weblite.htm#',
    'https://onetalk.alibaba.com/message/weblite.htm?recipient=other',
    'https://onetalk.alibaba.com/message/other.htm',
    'https://other.alibaba.com/message/weblite.htm',
    'https://onetalk.alibaba.com/message/%77eblite.htm',
  ]) {
    const f=fixture();f.sender.url=senderUrl;await denied(f,'sender_url_mismatch');
  }
});

test('replacing an iframe at the same URL never inherits an approved send',async()=>{
  const oldSender=fixture();oldSender.frame.documentId='replacement';await denied(oldSender,'frame_document_changed');
  const newSender=fixture();newSender.sender.documentId=newSender.frame.documentId='replacement';await denied(newSender,'prepared_document_changed');
  const noPrepared=fixture();delete noPrepared.job.sendDocumentId;await denied(noPrepared,'prepared_document_missing');
  const noSender=fixture();delete noSender.sender.documentId;await denied(noSender,'sender_document_missing');
  const noFrame=fixture();delete noFrame.frame.documentId;await denied(noFrame,'frame_document_changed');
});

test('frame disappearance, lookup failure and inconsistent frame IDs all fail closed',async()=>{
  const missing=fixture();missing.args.getCurrentFrame=async()=>null;await denied(missing,'frame_unavailable');
  const lookup=fixture();lookup.args.getCurrentFrame=async()=>{throw new Error('Browser gone');};await denied(lookup,'frame_unavailable',false);
  const other=fixture();other.frame.frameId++;await denied(other,'frame_unavailable');
});

test('frame validation happens after asynchronous ownership checks so intervening navigation is denied',async()=>{
  const f=fixture(),order=[];
  f.args.isMonitoredTab=async()=>{order.push('ownership');f.frame.url=URL+'other';return false;};
  f.args.getCurrentFrame=async()=>{order.push('frame');return f.frame;};
  await denied(f,'frame_url_changed');assert.deepEqual(order,['ownership','frame']);
});

test('hash transport correction does not bypass scope, job, approval, message, tab, frame or quota',async()=>{
  const cases=[
    [f=>{f.message.scope='diagnostic';},'invalid_scope'],
    [f=>{f.state.running=false;},'outreach_not_approved'],
    [f=>{f.state.learning={};},'outreach_not_approved'],
    [f=>{f.state.activeId=null;},'outreach_not_approved'],
    [f=>{f.job.status='review';},'outreach_not_approved'],
    [f=>{f.job.approved=false;},'outreach_not_approved'],
    [f=>{f.message.jobId='another';},'job_mismatch'],
    [f=>{f.message.attemptId='another';},'attempt_mismatch'],
    [f=>{f.sender.tab.id++;},'tab_mismatch'],
    [f=>{f.sender.frameId++;},'frame_mismatch'],
    [f=>{f.job.platform='1688';},'platform_mismatch'],
    [f=>{f.job.reviewUrl=URL+'other';},'review_url_changed'],
    [f=>{f.message.message+=' altered';},'message_changed'],
    [f=>{f.state.slots=[];},'reservation_missing'],
    [f=>{f.state.slots[0].kind='visit';},'reservation_missing'],
    [f=>{f.state.slots[0].at++;},'reservation_missing'],
    [f=>{f.state.slots[0].jobId='another';},'reservation_missing'],
    [f=>{f.state.slots[0].platform='1688';},'reservation_missing'],
    [f=>{f.args.isMonitoredTab=async()=>true;},'tab_monitored'],
  ];
  for(const [change,code] of cases){const f=fixture();change(f);await denied(f,code);}
});

test('denial codes contain no message, URL, account or arbitrary exception data',async()=>{
  const f=fixture();f.message.message='Private supplier message';
  const reply=await f.run();assert.deepEqual(reply,{ok:true,canSend:false,reasonCode:'message_changed'});
  assert.match(reply.reasonCode,/^[a-z_]+$/);
});

test('only an authenticated extension content frame on a supported HTTPS origin can request a send',async()=>{
  for(const change of [
    f=>{f.sender.id='other-extension';},f=>{delete f.sender.tab;},f=>{f.sender.frameId=-1;},
    f=>{f.sender.url='https://example.org/';},f=>{f.sender.url='http://onetalk.alibaba.com/message/weblite.htm';},
    f=>{f.sender.url='https://user:password@onetalk.alibaba.com/message/weblite.htm';},
  ]){const f=fixture();change(f);await denied(f,'invalid_sender',false);}
});

test('legacy dialogue sends retain receipt, preview, hash, quota and live document protections',async()=>{
  const f=fixture();f.message.scope='dialog';f.message.jobId=f.message.attemptId;
  f.message.dialogId='seller-chat';f.message.dialogOperation=f.message.attemptId;
  f.args.dialogs={running:true,settings:{wechatAudit:false},bindings:{alibaba:{tabId:7}}};
  f.args.folder={test:{enabled:false},sendReceipts:[{id:f.message.attemptId,jobId:'reply-1',status:'reserved',key:'alibaba:seller-chat',textHash:await folderDigest(f.message.message)}]};
  f.state.slots=[{kind:'send',platform:'alibaba',dialogAttemptId:f.message.attemptId,jobId:'dialog:reply-1'}];
  assert.deepEqual(await f.run(),{ok:true,canSend:true});
  f.args.folder.test.enabled=true;await denied(f,'dialog_mode_blocked');f.args.folder.test.enabled=false;
  f.args.dialogs.settings.wechatAudit=true;await denied(f,'dialog_mode_blocked');f.args.dialogs.settings.wechatAudit=false;
  f.args.folder.sendReceipts[0].status='sent';await denied(f,'dialog_receipt_missing');f.args.folder.sendReceipts[0].status='reserved';
  f.message.message+=' changed';await denied(f,'message_changed');f.message.message=f.job.message;
  f.frame.documentId='replacement';await denied(f,'frame_document_changed');f.frame.documentId=f.sender.documentId;
  f.frame.url=URL+'other';await denied(f,'frame_url_changed');f.frame.url=URL;
  f.state.slots=[];await denied(f,'reservation_missing');
});
