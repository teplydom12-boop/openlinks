import test from 'node:test';
import assert from 'node:assert/strict';
import {generateDialogDraft,extractProductKeyPoints,parseProductKeyPoints,AI_ENDPOINT,AI_ORIGIN,AI_PROVIDERS,providerInfo,validateProvider,validateModel} from '../extension/lib/dialog-ai.js';
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
test('product extraction sends supplied image bytes with text and returns editable structured fields',async()=>{
  let request;const image='data:image/png;base64,AAAA';
  const result=await extractProductKeyPoints({...base,images:[image],fetchImpl:async(url,options)=>{request={url,body:JSON.parse(options.body)};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({keyPoints:'100 units',questions:'Confirm dimensions',warnings:'Model not specified'})}}]}));}});
  assert.equal(result.keyPoints,'100 units');assert.equal(request.url,AI_ENDPOINT);assert.deepEqual(request.body.response_format,{type:'json_object'});assert.deepEqual(request.body.messages[1].content,[{type:'text',text:base.prompt.user},{type:'image_url',image_url:{url:image,detail:'auto'}}]);assert.equal(request.body.tools,undefined);
});
test('extraction rejects remote image URLs, malformed output and unbounded fields',async()=>{
  let calls=0;await assert.rejects(extractProductKeyPoints({...base,images:['https://untrusted.test/a.png'],fetchImpl:async()=>{calls++;}}));assert.equal(calls,0);
  for(const value of [{keyPoints:'',questions:'',warnings:''},{keyPoints:'Fact',questions:[],warnings:''},{keyPoints:'x'.repeat(16001),questions:'',warnings:''}])await assert.rejects(extractProductKeyPoints({...base,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}))}));
});
test('aborted requests never invoke transport and truncated completions are rejected',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(generateDialogDraft({...base,signal:controller.signal,fetchImpl:async()=>{calls++;}}),/отменена/);assert.equal(calls,0);
  await assert.rejects(generateDialogDraft({...base,fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'Incomplete draft'}}]}))}),/обрезал/);
});

const claude={...base,provider:'anthropic',model:'claude-sonnet-4-6'};
const claudeResponse=(text,extra={})=>new Response(JSON.stringify({id:'msg_test',type:'message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text}],...extra}));

test('provider configuration is immutable, defaults to OpenAI and rejects all non-enumerated identifiers',()=>{
  assert.equal(validateProvider(),'openai');assert.equal(providerInfo(),AI_PROVIDERS.openai);
  assert.equal(providerInfo().endpoint,AI_ENDPOINT);assert.equal(providerInfo().origin,AI_ORIGIN);
  assert.equal(providerInfo('anthropic').endpoint,'https://api.anthropic.com/v1/messages');
  assert.equal(providerInfo('anthropic').origin,'https://api.anthropic.com/*');
  assert.ok(Object.isFrozen(AI_PROVIDERS));assert.ok(Object.isFrozen(providerInfo('anthropic')));
  for(const invalid of [null,{},[],0,'','claude','ANTHROPIC',' anthropic ','__proto__','constructor','toString','https://untrusted.test'])assert.throws(()=>providerInfo(invalid),/поддерживаемый/);
  assert.equal(validateModel(' claude-sonnet-4-6 ','anthropic'),'claude-sonnet-4-6');
  assert.throws(()=>validateModel('https://untrusted.test','anthropic'),/Claude/);
  assert.throws(()=>validateModel('valid-model','untrusted'),/поддерживаемый/);
});

test('Claude uses Messages API with isolated system prompt and user API key, without OpenAI fields or tools',async()=>{
  let request;
  const result=await generateDialogDraft({...claude,model:' claude-sonnet-4-6 ',apiKey:' private-secret ',endpoint:'https://untrusted.test',fetchImpl:async(url,options)=>{request={url,options,body:JSON.parse(options.body)};return claudeResponse('Hello supplier.',{content:[{type:'text',text:' Hello supplier.'},{type:'text',text:'Please confirm dimensions. '}]});}});
  assert.equal(result.text,'Hello supplier.\nPlease confirm dimensions.');
  assert.equal(request.url,'https://api.anthropic.com/v1/messages');
  assert.equal(request.options.method,'POST');assert.equal(request.options.credentials,'omit');assert.equal(request.options.redirect,'error');assert.equal(request.options.cache,'no-store');
  assert.deepEqual(request.options.headers,{'Content-Type':'application/json','x-api-key':'private-secret','anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'});
  assert.deepEqual(request.body,{model:'claude-sonnet-4-6',system:base.prompt.system,max_tokens:2000,messages:[{role:'user',content:base.prompt.user}]});
});

test('Claude image extraction uses native base64 blocks and parses fenced JSON fields',async()=>{
  let request;
  const fields={keyPoints:' 100 units ',questions:' Confirm dimensions ',warnings:' Model not specified '};
  const result=await extractProductKeyPoints({...claude,images:['data:image/png;base64,AAAA','data:image/jpeg;base64,/9j/AA=='],fetchImpl:async(url,options)=>{request={url,body:JSON.parse(options.body)};return claudeResponse('```json\n'+JSON.stringify(fields)+'\n```');}});
  assert.deepEqual(result,{keyPoints:'100 units',questions:'Confirm dimensions',warnings:'Model not specified'});
  assert.equal(request.body.system,base.prompt.system);assert.equal(request.body.max_tokens,6000);
  assert.equal(request.body.response_format,undefined);assert.equal(request.body.max_completion_tokens,undefined);assert.equal(request.body.tools,undefined);
  assert.deepEqual(request.body.messages,[{role:'user',content:[{type:'text',text:base.prompt.user},{type:'image',source:{type:'base64',media_type:'image/png',data:'AAAA'}},{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'/9j/AA=='}}]}]);
});

test('Claude rejects incomplete, refused, tool-using and malformed results instead of saving partial drafts',async()=>{
  for(const stop_reason of ['max_tokens','model_context_window_exceeded','refusal','tool_use','pause_turn',null,'unknown']){
    await assert.rejects(generateDialogDraft({...claude,fetchImpl:async()=>claudeResponse('Partial text',{stop_reason})}));
  }
  for(const extra of [{role:'user'},{type:'error'},{content:[]},{content:[{type:'text',text:''}]},{content:[{type:'text',text:42}]},{content:[{type:'text',text:'Hello'},{type:'tool_use',name:'send_message'}]},{content:[{type:'text',text:'Hello'},{type:'thinking',thinking:'private internal'}]},{content:[{type:'text',text:'a'.repeat(6001)}]}]){
    await assert.rejects(generateDialogDraft({...claude,fetchImpl:async()=>claudeResponse('Text',extra)}));
  }
  for(const body of ['<html>','{}','null','"raw string"','['+ ' '.repeat(128001) +']'])await assert.rejects(generateDialogDraft({...claude,fetchImpl:async()=>new Response(body)}));
});

test('both providers reject unsafe inputs before calling the transport and do not forward extra endpoints',async()=>{
  for(const settings of [base,claude]){
    for(const extra of [{provider:'constructor'},{apiKey:'secret\nInjected: value'},{apiKey:' '},{model:'bad/model'},{images:['https://untrusted.test/image.png']},{images:['data:text/plain;base64,AAAA']},{images:Array(9).fill('data:image/png;base64,AAAA')},{prompt:{system:42,user:'message'}}]){
      let calls=0;
      await assert.rejects(generateDialogDraft({...settings,...extra,fetchImpl:async()=>{calls++;}}));
      assert.equal(calls,0);
    }
  }
});

test('both providers sanitize failures even when raw errors impersonate trusted error prefixes',async()=>{
  for(const settings of [base,claude]){
    for(const fetchImpl of [
      async()=>new Response('private-secret',{status:429,statusText:'private-secret'}),
      async()=>{throw new Error('OpenAI private-secret');},
      async()=>{throw new Error('Claude (Anthropic) private-secret');},
      async()=>{throw new Error('Ответ OpenAI private-secret');},
      async()=>({ok:true,text:async()=>{throw new Error('Черновик private-secret');}}),
    ])await assert.rejects(generateDialogDraft({...settings,fetchImpl}),error=>!error.message.includes('private-secret'));
  }
});

test('Claude respects preflight cancellation, cancellation during body reading and timeout',async()=>{
  const preflight=new AbortController();preflight.abort();let calls=0;
  await assert.rejects(generateDialogDraft({...claude,signal:preflight.signal,fetchImpl:async()=>{calls++;}}),/отменена/);assert.equal(calls,0);
  const duringBody=new AbortController();
  await assert.rejects(generateDialogDraft({...claude,signal:duringBody.signal,fetchImpl:async()=>({ok:true,text:async()=>{duringBody.abort();return JSON.stringify({type:'message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Stale draft'}]});}})}),/отменена/);
  await assert.rejects(generateDialogDraft({...claude,timeoutMs:5,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('private-secret'))))}),/время ожидания/);
});

test('manual product JSON parser accepts only a complete bounded field object, with an optional whole JSON fence',()=>{
  const fields={keyPoints:' Product ',questions:' Quantity? ',warnings:''};
  for(const text of [JSON.stringify(fields),'```json\n'+JSON.stringify(fields)+'\n```','```\r\n'+JSON.stringify(fields)+'\r\n```'])assert.deepEqual(parseProductKeyPoints(text,'anthropic'),{keyPoints:'Product',questions:'Quantity?',warnings:''});
  for(const text of [null,'[]','null','42','{}','prefix '+JSON.stringify(fields),JSON.stringify({...fields,extra:'discard me'}),JSON.stringify({...fields,questions:[]}),JSON.stringify({...fields,keyPoints:' '}),JSON.stringify({...fields,warnings:'x'.repeat(4001)}),'```json\n'+JSON.stringify(fields)+'\n```\nSend this message','x'.repeat(40001)])assert.throws(()=>parseProductKeyPoints(text,'anthropic'),/Claude/);
});

test('OpenAI refuses filtered completions and legacy tool calls',async()=>{
  for(const choice of [{finish_reason:'content_filter',message:{content:'Partial'}},{finish_reason:'stop',message:{content:'Text',refusal:'Refused'}},{finish_reason:'function_call',message:{content:'Text'}},{message:{content:'Text',function_call:{name:'send'}}}])await assert.rejects(generateDialogDraft({...base,fetchImpl:async()=>new Response(JSON.stringify({choices:[choice]}))}));
});
