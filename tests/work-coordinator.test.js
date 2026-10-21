import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,WINDOW_MS} from '../extension/lib/core.js';
import {normalizeWorkCoordinator,assessWorkCoordination} from '../extension/lib/work-coordinator.js';

const now=2_000_000;
const joint={enabled:true,dialogsRunning:true};
function queue(...platforms) {
  const state=initialState();state.running=true;
  state.queue=platforms.map((platform,index)=>({id:String(index),platform,status:'pending'}));return state;
}
function exhaust(state,platform,kind='send',at=now-10_000) {
  const count=platform==='1688'?7:3;
  state.slots.push(...Array.from({length:count},(_,i)=>({platform,kind,at:at+i,jobId:'prior'+i})));
}

test('coordination is explicit opt-in and preserves independent blocks',()=>{
  assert.deepEqual(normalizeWorkCoordinator({enabled:'yes',startedAt:'no'}),{version:1,enabled:false,startedAt:null});
  const result=assessWorkCoordination(queue('alibaba'),{},now);
  assert.equal(result.enabled,false);assert.equal(result.phase,'independent');assert.equal(result.allowDialogs,true);
});
test('test status blocks joint startup without blocking independent test cycles',()=>{
  const result=assessWorkCoordination(queue('alibaba'),{testMode:true},now);
  assert.equal(result.enabled,false);assert.equal(result.testMode,true);assert.equal(result.phase,'test_paused');assert.equal(result.allowDialogs,true);
});
test('all remaining platforms must exhaust hard quota before inbox gets its turn',()=>{
  const state=queue('alibaba','alibaba','1688');exhaust(state,'alibaba');
  assert.equal(assessWorkCoordination(state,joint,now).phase,'outreach');
  exhaust(state,'1688','visit',now-20_000);
  const result=assessWorkCoordination(state,joint,now);
  assert.equal(result.phase,'dialogs_quota_wait');assert.equal(result.allowDialogs,true);
  assert.deepEqual(result.quotaPlatforms,['alibaba','1688']);
  assert.equal(result.nextAt,now-20_000+WINDOW_MS+1000);
  assert.equal(assessWorkCoordination(state,joint,result.nextAt).phase,'outreach');
});
test('Made-in-China prevents a quota handoff while its rows remain available',()=>{
  const state=queue('alibaba','mic');exhaust(state,'alibaba');
  assert.equal(assessWorkCoordination(state,joint,now).phase,'outreach');
  state.queue[1].status='attempted';
  assert.equal(assessWorkCoordination(state,joint,now).phase,'dialogs_quota_wait');
});
test('intervals and explicit dates preserve outreach priority',()=>{
  const state=queue('alibaba');
  state.slots=[{kind:'visit',platform:'alibaba',at:now-1000}];
  const interval=assessWorkCoordination(state,joint,now);
  assert.equal(interval.phase,'outreach');assert.equal(interval.allowDialogs,false);assert.ok(interval.nextAt>now);
  state.slots=[];state.queue[0].requestedAt=now+30_000;
  const scheduled=assessWorkCoordination(state,joint,now);
  assert.equal(scheduled.phase,'outreach');assert.equal(scheduled.nextAt,now+30_000);
});
test('a ready alternative retains immediate outreach priority during another platform interval or scheduled wait',()=>{
  for(const scheduled of [false,true]) {
    const state=queue('1688','alibaba','mic');
    if(scheduled)state.queue[0].requestedAt=now+90000;
    else state.slots=[{kind:'visit',platform:'1688',at:now}];
    const result=assessWorkCoordination(state,joint,now);
    assert.equal(result.phase,'outreach');assert.equal(result.allowDialogs,false);assert.equal(result.nextAt,null);
    assert.match(result.detail,/доступная площадка/);
  }
});
test('ready platform retains priority even if an earlier quota will clear before its scheduled visit',()=>{
  const state=queue('alibaba','mic');exhaust(state,'alibaba', 'send',now-WINDOW_MS+1000);
  state.queue[1].requestedAt=now+50_000;
  const result=assessWorkCoordination(state,joint,now);
  assert.equal(result.phase,'outreach');assert.equal(result.allowDialogs,false);
});
test('active preparation, approval, and retries finish before handing off',()=>{
  const state=queue('alibaba','1688');exhaust(state,'alibaba');exhaust(state,'1688');state.activeId='0';
  for(const status of ['visiting','contacting','drafting','review','retry_wait','sending']) {
    state.queue[0].status=status;
    assert.equal(assessWorkCoordination(state,joint,now).phase,'outreach',status);
  }
  state.queue[0].status='blocked';
  assert.equal(assessWorkCoordination(state,joint,now).phase,'needs_attention');
});
test('paused primary or inbox does not silently fall back to the other block',()=>{
  const state=queue('alibaba');exhaust(state,'alibaba');state.running=false;
  assert.equal(assessWorkCoordination(state,joint,now).phase,'needs_attention');
  state.running=true;
  assert.equal(assessWorkCoordination(state,{...joint,dialogsRunning:false},now).phase,'needs_attention');
});
test('completed queue leaves inbox working, including after its running flag is cleared',()=>{
  const state=queue('alibaba');state.queue[0].status='attempted';state.running=false;
  assert.equal(assessWorkCoordination(state,joint,now).phase,'dialogs_queue_complete');
  assert.equal(assessWorkCoordination(state,joint,now).allowDialogs,true);
});
test('test mode always stops a persisted joint run and deferred sends use send quota only',()=>{
  const state=queue('alibaba');exhaust(state,'alibaba','visit');state.queue[0].status='deferred_send';
  assert.equal(assessWorkCoordination(state,joint,now).phase,'outreach');
  exhaust(state,'alibaba');
  assert.equal(assessWorkCoordination(state,joint,now).phase,'dialogs_quota_wait');
  assert.equal(assessWorkCoordination(state,{...joint,testMode:true},now).phase,'test_paused');
  assert.equal(assessWorkCoordination(state,{...joint,testMode:true},now).allowDialogs,false);
});
test('unclaimed unfinished row and unsupported platform fail closed',()=>{
  const state=queue('alibaba');state.queue[0].status='contacting';
  assert.equal(assessWorkCoordination(state,joint,now).phase,'needs_attention');
  state.queue[0].status='pending';state.queue[0].platform='foreign';
  assert.equal(assessWorkCoordination(state,joint,now).phase,'needs_attention');
});
