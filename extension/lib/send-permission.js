import {classify} from './core.js';
import {folderDigest} from './folder-bridge.js';

const deny=(reasonCode,ok=true)=>({ok,canSend:false,reasonCode});

// Chromium's runtime MessageSender.url may omit a document's fragment. The
// exception below is only for that transport field: the live frame must still
// match the complete reviewed URL and the exact document that requests SEND.
function senderUrlMatches(expectedUrl,senderUrl) {
  return senderUrl===expectedUrl || (expectedUrl.includes('#') && senderUrl===expectedUrl.slice(0,expectedUrl.indexOf('#')));
}

// This is only document identity evidence, not permission to send. Keeping it
// separate also allows read-only diagnostics while the real queue is paused.
export function checkSendDocument({expectedUrl,sender,frame,preparedDocumentId}) {
  if(typeof expectedUrl!=='string')return 'expected_url_missing';
  if(!senderUrlMatches(expectedUrl,sender?.url))return 'sender_url_mismatch';
  if(typeof sender?.documentId!=='string' || !sender.documentId)return 'sender_document_missing';
  if(preparedDocumentId && preparedDocumentId!==sender.documentId)return 'prepared_document_changed';
  if(!frame || frame.frameId!==sender.frameId)return 'frame_unavailable';
  if(frame.url!==expectedUrl)return 'frame_url_changed';
  if(!frame.documentId || frame.documentId!==sender.documentId)return 'frame_document_changed';
  return null;
}

// Deliberately read-only and independent of either worker's action serializer:
// the caller may be awaiting the content script that requests this permission.
export async function evaluateSendPermission({message,sender,runtimeId,state,dialogs,folder,getCurrentFrame,isMonitoredTab}) {
  let platform;
  try {
    if(sender?.id!==runtimeId || !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId) || sender.frameId<0)return deny('invalid_sender',false);
    platform=classify(sender.url).platform;
    if(!platform)return deny('invalid_sender',false);
  } catch {return deny('invalid_sender',false);}
  if(typeof message.expectedUrl!=='string')return deny('expected_url_missing');
  try {if(classify(message.expectedUrl).platform!==platform)return deny('sender_url_mismatch');}
  catch {return deny('expected_url_invalid');}
  if(!senderUrlMatches(message.expectedUrl,sender.url))return deny('sender_url_mismatch');

  let preparedDocumentId;
  if(message.scope==='outreach') {
    const job=state.queue.find(item=>item.id===state.activeId);
    if(!state.running || state.learning || !job || job.status!=='sending' || job.approved!==true)return deny('outreach_not_approved');
    if(job.id!==message.jobId)return deny('job_mismatch');
    if(!job.attemptId || job.attemptId!==message.attemptId)return deny('attempt_mismatch');
    if(job.tabId!==sender.tab.id)return deny('tab_mismatch');
    if(job.frameId!==sender.frameId)return deny('frame_mismatch');
    if(job.platform!==platform)return deny('platform_mismatch');
    if(job.reviewUrl!==message.expectedUrl)return deny('review_url_changed');
    if(job.message!==message.message)return deny('message_changed');
    if(!state.slots.some(slot=>slot.kind==='send' && slot.jobId===job.id && slot.platform===platform && slot.at===job.sendAt))return deny('reservation_missing');
    if(typeof job.sendDocumentId!=='string' || !job.sendDocumentId)return deny('prepared_document_missing');
    preparedDocumentId=job.sendDocumentId;
    if(await isMonitoredTab(job.tabId))return deny('tab_monitored');
  } else if(message.scope==='dialog') {
    if(folder?.test?.enabled===true || dialogs?.running!==true || dialogs.settings?.wechatAudit===true)return deny('dialog_mode_blocked');
    if(dialogs.bindings?.[platform]?.tabId!==sender.tab.id)return deny('tab_mismatch');
    if(message.jobId!==message.attemptId || message.dialogOperation!==message.attemptId || typeof message.dialogId!=='string')return deny('attempt_mismatch');
    const receipt=folder?.sendReceipts?.find(item=>item.id===message.attemptId && item.status==='reserved' && item.key===platform+':'+message.dialogId);
    if(!receipt)return deny('dialog_receipt_missing');
    if(typeof message.message!=='string' || receipt.textHash!==await folderDigest(message.message))return deny('message_changed');
    if(!state.slots.some(slot=>slot.kind==='send' && slot.platform===platform && slot.dialogAttemptId===message.attemptId && slot.jobId==='dialog:'+receipt.jobId))return deny('reservation_missing');
  } else return deny('invalid_scope');

  // Read the live frame last, after all other asynchronous checks. A matching
  // sender URL alone cannot prove that an iframe or its SPA recipient survived.
  let frame;
  try {frame=await getCurrentFrame(sender.tab.id,sender.frameId);}
  catch {return deny('frame_unavailable',false);}
  const documentReason=checkSendDocument({expectedUrl:message.expectedUrl,sender,frame,preparedDocumentId});
  if(documentReason)return deny(documentReason);
  return {ok:true,canSend:true};
}
