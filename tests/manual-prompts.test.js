import test from 'node:test';
import assert from 'node:assert/strict';
import {initialDialogs,saveProduct,approveProduct,productFingerprint,productExtractionRequest,buildProductExtractionPrompt,buildDraftPrompt,mergeDialogSnapshot,conversationKey,draftRequest,resolveConversationAttachments,attachmentSourceFingerprint,setDialogSettings} from '../extension/lib/dialogs.js';
import {buildManualProductPrompt,buildManualDialogPrompt} from '../extension/lib/manual-prompts.js';

const now=Date.UTC(2026,9,18,11,42,3),id='buyer:me/supplier:private',key=conversationKey('alibaba',id);
function product(){
  const state=initialDialogs();
  saveProduct(state,{cardText:'Model X, 220 V, 2.5 kW.',characteristics:'Нужно 50 шт.; питание 220 V.',keyPoints:'Покупатель требует 50 шт. модели X. Подтвердить 220 V и 2.5 kW.',questions:'MOQ и срок?',rules:'Не соглашаться на оплату.'},1);
  return state;
}
function observe(state,messages,extra={}){
  mergeDialogSnapshot(state,{platform:'alibaba',status:'ready',conversations:[{id,title:'私密 supplier name',identityReliable:true,orderReliable:true,tailKnown:true,messages,...extra}]},2);
}
function dialog(){
  const state=product();approveProduct(state,productFingerprint(state),2);
  observe(state,[{id:'buyer-1',direction:'outbound',text:'Нужно 50 шт. 220 V.'},{id:'seller-1',direction:'inbound',text:'MOQ 20 units. Do you need 220 V?'}]);
  return state;
}
function file(patch={}){return {id:'spec-1',name:'specifications.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',status:'ready',text:'Sheet1\nModel\tPower\tVoltage\nX\t2.5 kW\t220 V',...patch};}

test('product TXT preserves the API prompt context, units, text files and strict JSON response format',()=>{
  const state=product();saveProduct(state,{files:[file()]});
  const request=productExtractionRequest(state),before=structuredClone(state),result=buildManualProductPrompt(state,request,{now}),api=buildProductExtractionPrompt(state,request);
  assert.ok(result.text.includes(api.system));assert.ok(result.text.includes(JSON.stringify(JSON.parse(api.user),null,2)));
  assert.match(result.text,/2\.5 kW/);assert.match(result.text,/220 V/);assert.match(result.text,/50 шт\./);assert.match(result.text,/keyPoints.*questions.*warnings/);
  assert.match(result.text,/Верните только JSON-объект/);assert.equal(result.filename,'openlinks-claude-product-2026-10-18T11-42-03-000Z.txt');
  assert.deepEqual(result.request,request);assert.notEqual(result.request,request);assert.deepEqual(result.requiredImages,[]);assert.deepEqual(state,before);
});

test('manual exports exclude provider credentials and arbitrary request extras',()=>{
  const state=dialog();
  state.settings.apiKey='SECRET_API_CREDENTIAL';state.settings.endpoint='https://private-provider.invalid/v1';state.settings.model='PRIVATE_MODEL_VALUE';
  state.provider={apiKey:'OTHER_PROVIDER_SECRET',endpoint:'PRIVATE_ENDPOINT'};
  const request=draftRequest(state,key),result=buildManualDialogPrompt(state,{...request,apiKey:'EXTRA_REQUEST_SECRET'},{now});
  const productResult=buildManualProductPrompt(state,{...productExtractionRequest(state),endpoint:'EXTRA_REQUEST_ENDPOINT'},{now});
  const all=JSON.stringify([result,productResult]);
  for(const value of ['SECRET_API_CREDENTIAL','private-provider.invalid','PRIVATE_MODEL_VALUE','OTHER_PROVIDER_SECRET','PRIVATE_ENDPOINT','EXTRA_REQUEST_SECRET','EXTRA_REQUEST_ENDPOINT'])assert.equal(all.includes(value),false);
  assert.deepEqual(result.request,request);
});

test('product images are listed as manual attachments without claiming the TXT includes their content',()=>{
  const state=product();saveProduct(state,{sourceUrl:'https://example.com/product?token=SECRET&id=1',files:[file({id:'photo',name:'drawing.pdf',text:'',mime:'application/pdf',images:[{imageKey:'page-one',mime:'image/png',page:1,width:800,height:1200,dataUrl:'data:image/png;base64,SECRET'}]}),file({id:'excluded',excluded:true,name:'excluded.png',images:[{imageKey:'excluded-image',mime:'image/png'}]})]});
  const before=structuredClone(state),result=buildManualProductPrompt(state,productExtractionRequest(state),{now});
  assert.deepEqual(result.requiredImages,[{imageKey:'page-one',fileId:'photo',name:'drawing.pdf',mime:'image/png',page:1,width:800,height:1200}]);
  assert.match(result.warnings.join('\n'),/Изображения не включены в TXT/);assert.match(result.warnings.join('\n'),/drawing\.pdf.*страница 1/);assert.match(result.text,/Ссылка на товар не загружалась/);
  assert.equal(result.text.includes('SECRET'),false);assert.equal(result.text.includes('base64'),false);assert.equal(result.text.includes('excluded-image'),false);assert.deepEqual(state,before);assert.equal(state.product.extraction,null);
});

test('partial product files stay explicitly incomplete and are never approved by exporting',()=>{
  const state=product();saveProduct(state,{files:[file({status:'partial',warnings:['Прочитаны только 2 из 5 листов.']})]});
  const result=buildManualProductPrompt(state,productExtractionRequest(state),{now});
  assert.match(result.warnings.join('\n'),/не полностью/);assert.match(result.text,/2 из 5 листов/);assert.equal(state.product.approval,null);assert.equal(state.product.extraction,null);
});

test('manual product export rejects stale revisions and URL-only inputs like API extraction',()=>{
  const state=product(),request=productExtractionRequest(state);saveProduct(state,{characteristics:'Now 100 units'});
  assert.throws(()=>buildManualProductPrompt(state,request,{now}),/изменились/);
  const urlOnly=initialDialogs();saveProduct(urlOnly,{sourceUrl:'https://example.com/item'});
  assert.throws(()=>buildManualProductPrompt(urlOnly,productExtractionRequest(urlOnly),{now}),/Одна ссылка/);
});

test('dialog TXT keeps the full approved context, recipient language rules and observed history',()=>{
  const state=dialog();setDialogSettings(state,{brief:'Need model X',wechat:'buyer-contact',language:'Chinese'});approveProduct(state,productFingerprint(state),3);
  const request=draftRequest(state,key),before=structuredClone(state),result=buildManualDialogPrompt(state,request,{now}),api=buildDraftPrompt(state,request);
  assert.ok(result.text.includes(api.system));assert.ok(result.text.includes(JSON.stringify(JSON.parse(api.user),null,2)));
  assert.match(result.text,/Верните только текст сообщения/);assert.match(result.text,/MOQ 20 units/);assert.match(result.text,/buyer-contact/);assert.match(result.text,/Chinese/);assert.match(result.text,/Не соглашаться на оплату/);
  assert.equal(result.filename,'openlinks-claude-dialog-alibaba-2026-10-18T11-42-03-000Z.txt');assert.equal(result.filename.includes('supplier'),false);
  assert.deepEqual(result.request,request);assert.deepEqual(state,before);
});

test('manual dialog export preserves approval, stale context and unread-history guards',()=>{
  const unapproved=dialog(),request=draftRequest(unapproved,key);saveProduct(unapproved,{rules:'Updated rule'});
  assert.throws(()=>buildManualDialogPrompt(unapproved,request,{now}),/утвердите/);
  const changed=dialog(),oldRequest=draftRequest(changed,key);observe(changed,[...changed.conversations[key].messages,{id:'seller-2',direction:'inbound',text:'New offer'}]);
  assert.throws(()=>buildManualDialogPrompt(changed,oldRequest,{now}),/изменились/);
  const unread=dialog(),readRequest=draftRequest(unread,key);observe(unread,[],{needsRead:true,tailKnown:false});
  assert.throws(()=>buildManualDialogPrompt(unread,readRequest,{now}),/прочитанного диалога/);
});

test('dialog attachments require actual resolution and include extracted text after it succeeds',()=>{
  const state=dialog(),request=draftRequest(state,key),attachment={type:'file',name:'offer.pdf',url:'https://cdn.example.com/offer.pdf?signature=PRIVATE'};
  observe(state,[...state.conversations[key].messages,{id:'file-message',direction:'inbound',text:'Offer attached',attachments:[attachment]}],{historyOrderReliable:true,historyTailKnown:true,tailKnown:false,needsRead:true,coverage:{attachments:1,unreadAttachments:1}});
  assert.throws(()=>buildManualDialogPrompt(state,request,{now}),/прочитанного диалога/);
  const message=state.conversations[key].messages.find(message=>message.id==='file-message');
  resolveConversationAttachments(state,key,[{messageKey:message.key,sourceFingerprint:attachmentSourceFingerprint(attachment),status:'ready',text:'Model X, EUR 250 per unit, 220 V.'}],4);
  const result=buildManualDialogPrompt(state,draftRequest(state,key),{now});
  assert.match(result.text,/EUR 250 per unit/);assert.equal(result.text.includes('signature=PRIVATE'),false);assert.deepEqual(result.requiredImages,[]);
});

test('resolved conversation images must still be attached by the user and exporting never marks them read',()=>{
  const state=dialog(),attachment={type:'image',name:'supplier-photo.png',url:'https://cdn.example.com/photo.png'};
  observe(state,[...state.conversations[key].messages,{id:'picture',direction:'inbound',text:'See this model',attachments:[attachment]}],{historyOrderReliable:true,historyTailKnown:true,tailKnown:false,needsRead:true,coverage:{attachments:1,unreadAttachments:1}});
  const message=state.conversations[key].messages.find(message=>message.id==='picture');
  resolveConversationAttachments(state,key,[{messageKey:message.key,sourceFingerprint:attachmentSourceFingerprint(attachment),status:'ready',images:[{imageKey:'supplier-image',mime:'image/png'}]}],4);
  const before=structuredClone(state),result=buildManualDialogPrompt(state,draftRequest(state,key),{now});
  assert.deepEqual(result.requiredImages,[{imageKey:'supplier-image',messageKey:message.key,name:'supplier-photo.png',mime:'image/png'}]);
  assert.match(result.text,/supplier-photo\.png/);assert.match(result.text,/Изображения не включены в TXT/);assert.match(result.text,/сначала попросите пользователя приложить/);
  assert.deepEqual(state,before);assert.equal(message.attachments[0].contentRead,false);assert.equal(state.conversations[key].draft,null);
});
