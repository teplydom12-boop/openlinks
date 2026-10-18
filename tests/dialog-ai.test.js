import test from 'node:test';
import assert from 'node:assert/strict';
import {generateDialogDraft,AI_ENDPOINT,validateModel} from '../extension/lib/dialog-ai.js';
const base={apiKey:'private-secret',model:'gpt-4.1-mini',prompt:{system:'Draft only.',user:'{"messages":[]}'}};
test('draft provider uses fixed endpoint with no tools, credentials or redirect forwarding',async()=>{
  let request;const result=await generateDialogDraft({...base,fetchImpl:async(url,options)=>{request={url,options};return new Response(JSON.stringify({choices:[{message:{content:' Hello supplier. '}}]}));}});
  assert.equal(result.text,'Hello supplier.');assert.equal(request.url,AI_ENDPOINT);assert.equal(request.options.credentials,'omit');assert.equal(request.options.redirect,'error');
  const body=JSON.parse(request.options.body);assert.equal(body.tools,undefined);assert.deepEqual(body.messages,[{role:'system',content:base.prompt.system},{role:'user',content:base.prompt.user}]);
});
test('provider failures never echo raw server bodies or transport errors containing credentials',async()=>{
  for(const fetchImpl of [async()=>new Response('private-secret',{status:401}),async()=>{throw new Error('private-secret');}]){
    await assert.rejects(generateDialogDraft({...base,fetchImpl}),error=>!error.message.includes('private-secret'));
  }
});
test('provider rejects malformed responses, oversized text and tool calls',async()=>{
  for(const payload of ['<html>',JSON.stringify({choices:[{message:{content:'a'.repeat(6001)}}]}),JSON.stringify({choices:[{message:{content:'hello',tool_calls:[{}]}}]})]){
    await assert.rejects(generateDialogDraft({...base,fetchImpl:async()=>new Response(payload)}));
  }
});
test('provider timeout aborts network request and reports a bounded failure',async()=>{
  await assert.rejects(generateDialogDraft({...base,timeoutMs:5,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))}),/время ожидания/);
});
test('model validation permits empty configuration but rejects URL and header injection',()=>{
  assert.equal(validateModel(''),'');assert.equal(validateModel(' gpt-4.1-mini '),'gpt-4.1-mini');
  assert.throws(()=>validateModel('https://example.com'));assert.throws(()=>validateModel('model\nAuthorization: key'));
});
