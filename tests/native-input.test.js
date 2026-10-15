import test from 'node:test';
import assert from 'node:assert/strict';
import {activate1688} from '../extension/lib/native-input.js';

test('keyboard session releases on lost focus without deleting a character or pressing Enter',async()=>{
 const calls=[],keys=[],job={platform:'1688',tabId:7,frameId:4,inputUrl:'https://air.1688.com/chat'};
 const api={attach:async target=>calls.push(['attach',target]),detach:async target=>calls.push(['detach',target]),sendCommand:async(target,method,params)=>keys.push(params)};
 const call=async(j,frame,type,data)=>{assert.equal(frame,4);return {ok:data.stage!=='space',reason:'Focus moved'};};
 await assert.rejects(activate1688(job,call,api),{message:'Focus moved',inputFailure:'editor',inputStage:'space'});
 assert.equal(calls[0][0],'attach');assert.equal(calls.at(-1)[0],'detach');
 assert.ok(keys.every(key=>key.key!=='Backspace' && key.key!=='Enter'));
});
test('input command errors release only our debugger session and do not retry',async()=>{
 let attached=0,detached=0,commands=0;
 const api={attach:async()=>{attached++},detach:async()=>{detached++},sendCommand:async()=>{commands++;throw new Error('Detached by user');}};
 await assert.rejects(activate1688({platform:'1688',tabId:1},async()=>({ok:true}),api),{message:'Detached by user',inputFailure:'transport'});
 assert.equal(attached,1);assert.equal(detached,1);assert.equal(commands,1);
 await assert.rejects(activate1688({platform:'alibaba'},()=>{},api),/только/);assert.equal(attached,1);
});
