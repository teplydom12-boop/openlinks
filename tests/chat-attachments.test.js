import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedChatAttachmentURL,resolveChatAttachments} from '../extension/lib/chat-attachments.js';
import {initialDialogs,mergeDialogSnapshot,conversationKey,normalizeDialogs,canPrepareDraft,saveProduct,approveProduct,productFingerprint} from '../extension/lib/dialogs.js';
function fixture({type='file',direction='inbound',attachments}={}){
  const state=initialDialogs(),raw={id:'account:me/thread:supplier',active:true,identityReliable:true,historyTailKnown:true,historyOrderReliable:true,tailKnown:false,orderReliable:false,needsRead:true,messages:[{id:'initial-request',direction:'outbound',text:'Please send the specification for model A.'},{id:'message-1',direction,text:'Attached specification',attachments:attachments||[{type,name:'spec.pdf',url:'https://files.alibaba.com/spec.pdf?signature=private&id=1'}]}],coverage:{attachments:1,unreadAttachments:1}};
  let snapshot={platform:'alibaba',status:'ready',url:'https://message.alibaba.com/chat',documentToken:'document-1',busy:{},conversations:[raw]};
  mergeDialogSnapshot(state,snapshot,100);saveProduct(state,{keyPoints:'Model A'},100);approveProduct(state,productFingerprint(state),100);
  const key=conversationKey('alibaba',raw.id),calls={cached:0,fetched:0,parsed:0,deleted:[],snapshots:0};
  const api={tabs:{get:async()=>({id:1,url:snapshot.url,status:'complete'}),sendMessage:async()=>{calls.snapshots++;return structuredClone(snapshot);}}};
  const context={api,state,key,rawConversation:raw,tabId:1,frameId:0,sourceUrl:snapshot.url,documentToken:snapshot.documentToken,now:1000};
  const dependencies={cachedBytes:async()=>{calls.cached++;return {base64:'c3BlYw==',mime:'application/pdf'};},fetchedBytes:async()=>{calls.fetched++;return {base64:'c3BlYw==',mime:'application/pdf'};},parseBytes:async()=>{calls.parsed++;return {id:'local-owner',status:'ready',text:'Model A: 220 V',images:[],warnings:[]};},deleteFile:async id=>{calls.deleted.push(id);}};
  return {state,key,raw,calls,api,context,dependencies,get snapshot(){return snapshot;},setSnapshot:value=>{snapshot=value;}};
}
test('attachment URLs require exact recognized HTTPS marketplace/CDN origins without credentials or ports',()=>{
  assert.ok(allowedChatAttachmentURL('https://files.alibaba.com/spec.pdf?token=signed','alibaba'));
  assert.ok(allowedChatAttachmentURL('https://img.alicdn.com/photo.png','1688'));
  assert.ok(allowedChatAttachmentURL('https://image.micstatic.com/photo.png','mic'));
  for(const url of ['https://alibaba.com.evil.test/spec.pdf','http://files.alibaba.com/spec.pdf','https://user:password@files.alibaba.com/spec.pdf','https://files.alibaba.com:8443/spec.pdf','https://localhost/spec.pdf','file:///tmp/file.pdf','data:application/pdf;base64,AA=='])assert.equal(allowedChatAttachmentURL(url,'alibaba'),'');
  assert.equal(allowedChatAttachmentURL('https://image.micstatic.com/photo.png','alibaba'),'');
});
test('exact live attachment is parsed locally, preserves readiness on polling, and never persists its signed URL',async()=>{
  const h=fixture(),result=await resolveChatAttachments(h.context,h.dependencies);
  assert.deepEqual(result,{changed:true,resolved:1,failed:0});assert.equal(h.calls.cached,1);assert.equal(h.calls.parsed,1);assert.equal(h.calls.snapshots,3);assert.equal(canPrepareDraft(h.state,h.key),true);
  const item=h.state.conversations[h.key],revision=item.revision;assert.equal(item.messages[1].attachments[0].resolution.text,'Model A: 220 V');assert.equal(JSON.stringify(h.state).includes('private'),false);
  mergeDialogSnapshot(h.state,h.snapshot,2000);assert.equal(item.revision,revision);assert.equal(canPrepareDraft(h.state,h.key),true);
  const restored=normalizeDialogs(h.state);await resolveChatAttachments({...h.context,state:restored,now:3000},h.dependencies);assert.equal(h.calls.parsed,1);assert.equal(restored.conversations[h.key].messages[1].attachments[0].resolution.ownerId,'local-owner');
});
test('a missing cache entry uses the bounded downloader dependency, never a chat interaction',async()=>{
  const h=fixture();h.dependencies.cachedBytes=async()=>{h.calls.cached++;throw new Error('Cache unavailable');};await resolveChatAttachments(h.context,h.dependencies);assert.equal(h.calls.fetched,1);assert.equal(h.calls.parsed,1);
});
test('changed document or selected supplier rejects results and removes newly parsed local assets',async()=>{
  for(const change of ['document','supplier']){
    const h=fixture();h.dependencies.parseBytes=async()=>{h.calls.parsed++;const next=structuredClone(h.snapshot);if(change==='document')next.documentToken='other-document';else next.conversations[0].id='another-supplier';h.setSnapshot(next);return {id:'temporary-owner',status:'ready',text:'Parsed before navigation',images:[]};};
    const result=await resolveChatAttachments(h.context,h.dependencies);assert.equal(result.resolved,0);assert.equal(result.failed,1);assert.deepEqual(h.calls.deleted,['temporary-owner']);assert.equal(canPrepareDraft(h.state,h.key),false);assert.equal(h.state.conversations[h.key].messages[1].attachments[0].contentReady,false);
  }
});
test('ambiguous raw message matches and altered attachment identities cannot be guessed',async()=>{
  for(const change of ['duplicate','changed-source']){
    const h=fixture();if(change==='duplicate')h.raw.messages.push(structuredClone(h.raw.messages[1]));else h.raw.messages[1].attachments[0].url='https://files.alibaba.com/different.pdf';
    const result=await resolveChatAttachments(h.context,h.dependencies);assert.equal(result.resolved,0);assert.equal(h.calls.cached,0);assert.equal(h.calls.parsed,0);
  }
});
test('unsupported audio/video never downloads or parses and retries are throttled across state reload',async()=>{
  for(const type of ['audio','video']){
    const h=fixture({type});const result=await resolveChatAttachments(h.context,h.dependencies);assert.equal(result.failed,1);assert.equal(h.calls.cached,0);assert.equal(h.calls.fetched,0);assert.equal(h.calls.parsed,0);
    const attachment=h.state.conversations[h.key].messages[1].attachments[0];assert.equal(attachment.resolution.retryAt,301000);
    const restored=normalizeDialogs(h.state),second=await resolveChatAttachments({...h.context,state:restored,now:300999},h.dependencies);assert.equal(second.changed,false);assert.equal(canPrepareDraft(restored,h.key),false);
  }
});
test('partial file coverage remains blocked and temporary originals are removed',async()=>{
  const h=fixture();h.dependencies.parseBytes=async()=>({id:'partial-owner',status:'partial',text:'First page only',images:[],warnings:['Часть страниц не прочитана.']});
  const result=await resolveChatAttachments(h.context,h.dependencies);assert.equal(result.failed,1);assert.equal(canPrepareDraft(h.state,h.key),false);assert.deepEqual(h.calls.deleted,['partial-owner']);
});
test('reading an attachment cannot establish a sender identity absent in the transcript',async()=>{
  const h=fixture({direction:'unknown'});const result=await resolveChatAttachments(h.context,h.dependencies);assert.equal(result.resolved,1);assert.equal(h.state.conversations[h.key].contentReady,false);assert.equal(canPrepareDraft(h.state,h.key),false);assert.equal(h.state.conversations[h.key].messages[1].direction,'unknown');
});
test('unapproved third-party attachment URLs never reach resource cache or network dependencies',async()=>{
  const h=fixture({attachments:[{type:'file',name:'spec.pdf',url:'https://outside.example/spec.pdf'}]});const result=await resolveChatAttachments(h.context,h.dependencies);assert.equal(result.failed,1);assert.equal(h.calls.cached,0);assert.equal(h.calls.fetched,0);assert.equal(h.calls.parsed,0);
});
test('a new reply or edited source message during parsing rejects stale file results',async()=>{
  for(const change of ['new-message','edited-message']){
    const h=fixture();h.dependencies.parseBytes=async()=>{const next=structuredClone(h.snapshot);if(change==='new-message')next.conversations[0].messages.push({id:'later',direction:'inbound',text:'Changed specification'});else next.conversations[0].messages[1].text='Different source message';h.setSnapshot(next);return {id:'temporary-owner',status:'ready',text:'Old specification',images:[]};};
    const result=await resolveChatAttachments(h.context,h.dependencies);assert.equal(result.resolved,0);assert.equal(result.failed,1);assert.deepEqual(h.calls.deleted,['temporary-owner']);assert.equal(canPrepareDraft(h.state,h.key),false);
  }
});
test('external exception details cannot expose document content or signed addresses in stored warnings',async()=>{
  const h=fixture();h.dependencies.parseBytes=async()=>{throw new Error('Ошибка: private supplier details https://files.alibaba.com/x?token=private');};await resolveChatAttachments(h.context,h.dependencies);
  assert.equal(JSON.stringify(h.state).includes('private'),false);assert.equal(canPrepareDraft(h.state,h.key),false);
});
test('different signed resource identities do not reuse a cached file even if their visible paths match',async()=>{
  const h=fixture();await resolveChatAttachments(h.context,h.dependencies);assert.equal(h.state.conversations[h.key].contentReady,true);
  const next=structuredClone(h.snapshot);next.conversations[0].messages[1].attachments[0].url='https://files.alibaba.com/spec.pdf?signature=another-resource&id=1';mergeDialogSnapshot(h.state,next,2000);
  assert.equal(h.state.conversations[h.key].contentReady,false);assert.equal(h.state.conversations[h.key].messages[1].attachments[0].resolution,null);assert.equal(canPrepareDraft(h.state,h.key),false);
});
