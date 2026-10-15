import test from 'node:test';
import assert from 'node:assert/strict';
import {activate1688} from '../extension/lib/native-input.js';
import {domReply} from './debugger-harness.js';

test('keyboard session releases on lost focus without deleting a character or pressing Enter',async()=>{
 const calls=[],keys=[],job={platform:'1688',tabId:7,frameId:4,inputUrl:'https://air.1688.com/chat'};
 const api={attach:async target=>calls.push(['attach',target]),detach:async target=>calls.push(['detach',target]),sendCommand:async(target,method,params)=>{keys.push(params);return domReply(method)}};
 const call=async(j,frame,type,data)=>{assert.equal(frame,4);return {ok:data.stage!=='space',reason:'Focus moved'};};
 await assert.rejects(activate1688(job,call,api),{message:'Focus moved',inputFailure:'editor',inputStage:'space'});
 assert.equal(calls[0][0],'attach');assert.equal(calls.at(-1)[0],'detach');
 assert.ok(keys.every(key=>key.key!=='Backspace' && key.key!=='Enter'));
});
test('an overlay over the editor prevents the mouse click and keyboard input',async()=>{
 const inputs=[],stages=[];let detached=false;
 const api={attach:async()=>{},detach:async()=>{detached=true},sendCommand:async(target,method,params)=>{
  if(method.startsWith('Input.'))inputs.push(params);
  return method==='DOM.getNodeForLocation'?{backendNodeId:999}:domReply(method);
 }};
 await assert.rejects(activate1688({platform:'1688',tabId:1,frameId:3},async(job,frame,type,data)=>{stages.push(data.stage);return {ok:true}},api),/перекрыто/);
 assert.deepEqual(inputs,[]);assert.equal(detached,true);assert.equal(stages.at(-1),'release');
});
test('input command errors release only our debugger session and do not retry',async()=>{
 let attached=0,detached=0,commands=0;
 const api={attach:async()=>{attached++},detach:async()=>{detached++},sendCommand:async()=>{commands++;throw new Error('Detached by user');}};
 await assert.rejects(activate1688({platform:'1688',tabId:1},async()=>({ok:true}),api),{message:'Detached by user',inputFailure:'transport'});
 assert.equal(attached,1);assert.equal(detached,1);assert.equal(commands,1);
 await assert.rejects(activate1688({platform:'alibaba'},()=>{},api),/только/);assert.equal(attached,1);
});
test('editor becoming unready before the click releases debugger and requests waiting without typing',async()=>{
 const stages=[];let detached=false,commands=0;
 const api={attach:async()=>{},detach:async()=>{detached=true},sendCommand:async()=>{commands++;}};
 await assert.rejects(activate1688({platform:'1688',tabId:1},async(job,frame,type,data)=>{
  stages.push(data.stage);return data.stage==='locate'?{ok:false,waiting:true,reason:'Editor loading'}:{ok:true};
 },api),{inputFailure:'waiting',inputStage:'locate'});
 assert.equal(commands,0);assert.equal(detached,true);assert.deepEqual(stages,['locate','release']);
});
