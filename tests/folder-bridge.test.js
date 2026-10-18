import test from 'node:test';
import assert from 'node:assert/strict';
import {FOLDER_HOST,FOLDER_LIMITS,normalizeFolder,publicFolder,folderDigest,folderImages,createFolderBridge,folderModel,reserveFolderJob,finishFolderJob,renderFolderPrompt} from '../extension/lib/folder-bridge.js';
const id='e237362b-0f41-4d51-a301-d1b2cc4e7e01';
const job=()=>({id,kind:'dialog',key:'1688:shop',status:'queued',signature:'a'.repeat(64),request:{key:'1688:shop',revision:1,fingerprint:'current'},at:100,createdAt:90,attempts:1,prompt:'PRIVATE',text:'PRIVATE'});
test('folder settings start off and public status never exposes request, prompt or reply',()=>{
  const empty=normalizeFolder();assert.equal(empty.enabled,false);assert.equal(empty.auto,false);assert.equal(empty.autoSend,false);
  const state=normalizeFolder({jobs:[job()],model:'sonnet'}),value=publicFolder(state);
  assert.equal(state.jobs.length,1);assert.equal(value.jobs[0].id,id);assert.equal(JSON.stringify(value).includes('PRIVATE'),false);assert.equal('request' in value.jobs[0],false);assert.equal('prompt' in state.jobs[0],false);
  assert.equal(normalizeFolder({model:'--dangerous'}).model,'sonnet');assert.throws(()=>folderModel('sonnet; rm x'));assert.equal(folderModel('claude-sonnet-4-6'),'claude-sonnet-4-6');
});
test('native transport is permission gated, fixed-host, bounded and uses action envelope',async()=>{
  let calls=0,allowed=false,last;
  const api={permissions:{contains:async value=>{assert.deepEqual(value,{permissions:['nativeMessaging']});return allowed;}},runtime:{sendNativeMessage:async(host,message)=>{calls++;assert.equal(host,FOLDER_HOST);last=message;return {ok:true};}}};
  const bridge=createFolderBridge({api,timeoutMs:10});await assert.rejects(()=>bridge.call('status'),/Разрешите/);assert.equal(calls,0);
  allowed=true;await bridge.call('poll',{ids:[id]});assert.deepEqual(last,{action:'poll',ids:[id]});
  api.runtime.sendNativeMessage=()=>new Promise(()=>{});await assert.rejects(()=>bridge.call('submit',{job:job()}),/тот же идентификатор/);
});
test('images include actual local bytes and missing or oversize images fail closed',async()=>{
  const images=await folderImages([{imageKey:'img:1',name:'drawing.png'},{imageKey:'img:1'}],async()=> 'data:image/png;base64,aGVsbG8=');
  assert.equal(images.length,1);assert.equal(images[0].data,'aGVsbG8=');assert.equal(images[0].mime,'image/png');
  await assert.rejects(()=>folderImages([{imageKey:'img'}],async()=> 'https://supplier.example/image.png'),/Изображение/);
  await assert.rejects(()=>folderImages(Array.from({length:9},(_,i)=>({imageKey:'img:'+i})),async()=>''),/восьми/);
});
test('durable reservation is bounded, keeps active jobs and remembers accepted outcomes',()=>{
  const state=normalizeFolder();for(let i=0;i<FOLDER_LIMITS.pending;i++)reserveFolderJob(state,{...job(),id:String(i)});
  assert.throws(()=>reserveFolderJob(state,job()),/заполнена/);
  finishFolderJob(state,state.jobs[0],'accepted','Draft saved',200);assert.deepEqual(state.completed,['a'.repeat(64)]);
  reserveFolderJob(state,job());assert.equal(state.jobs.length,FOLDER_LIMITS.pending+1);
});
test('context fingerprints use sha256 and prompts include both instructions and data',async()=>{
  assert.notEqual(await folderDigest({text:'first'}),await folderDigest({text:'second'}));
  const prompt=renderFolderPrompt({system:'SYSTEM',user:'{"messages":[]}'});assert.match(prompt,/SYSTEM/);assert.match(prompt,/messages/);
  assert.throws(()=>renderFolderPrompt({system:'',user:'x'.repeat(FOLDER_LIMITS.promptChars)}),/слишком большой/);
});
