import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, classify, parseList, WINDOW_MS, nextAllowed, makePlan, dueJob, scheduleText, reportText, validateSettings} from '../extension/lib/core.js';

test('URL validation rejects lookalike domains, credential URLs and unsafe protocols',()=>{
  for(const url of ['http://a.1688.com','https://1688.com.evil.test','https://evil1688.com','javascript:alert(1)','https://user:secret@a.alibaba.com','https://a.alibaba.com:444/']) assert.throws(()=>classify(url));
  assert.equal(classify('https://jcnyjxsb.en.alibaba.com/?spm=abc&utm_source=x&sellerId=123#top').url,'https://jcnyjxsb.en.alibaba.com/?sellerId=123');
  assert.equal(classify('https://13153773601.1688.com/').platform,'1688');
  assert.equal(classify('https://yiyueda.en.made-in-china.com/').platform,'mic');
});
test('list import preserves explicit time and rejects duplicate URLs across completed history',()=>{
  const existing=[{url:'https://a.alibaba.com/',status:'sent'}];
  const result=parseList('# comment\n2026-11-01T09:00:00+08:00 https://b.alibaba.com/\nhttps://a.alibaba.com/\nhttps://b.alibaba.com/?spm=123\nhttps://evil.test/',existing,1);
  assert.equal(result.jobs.length,1); assert.equal(result.errors.length,3);
  assert.equal(result.jobs[0].requestedAt,Date.parse('2026-11-01T01:00:00Z'));
});
for(const [platform,limit] of [['1688',7],['alibaba',3]]) {
  test(`${platform}: rolling window enforced on both visit and send, including failed attempts`,()=>{
    const state=initialState(); state.settings.intervals[platform]=30;
    for(const kind of ['visit','send']) {
      for(let index=0;index<limit;index++) state.slots.push({platform,kind,at:1000000+index*30000});
      assert.equal(nextAllowed(state,platform,kind,1200000),1000000+WINDOW_MS+1000);
      assert.equal(nextAllowed(state,platform,kind,3000000),3000000);
    }
    state.queue=[]; // Clearing the queue does not reset reservations.
    assert.equal(nextAllowed(state,platform,'send',1200000),1000000+WINDOW_MS+1000);
  });
  test(`${platform}: schedule of 100 contacts never exceeds rolling window quota`,()=>{
    const state=initialState(); state.settings.intervals[platform]=30;
    state.queue=Array.from({length:100},(_,i)=>({id:String(i),platform,url:`https://a.${platform==='1688'?'1688':'alibaba'}.com/${i}`,status:'pending',requestedAt:0}));
    const plan=makePlan(state,1000000);
    for(const job of plan) assert.ok(plan.filter(other=>other.plannedAt>job.plannedAt-WINDOW_MS && other.plannedAt<=job.plannedAt).length<=limit);
  });
}
test('independent platform cooldown and minimum interval for Made-in-China',()=>{
  const state=initialState(); const now=Date.now();
  state.slots=[{platform:'mic',kind:'visit',at:now},{platform:'alibaba',kind:'visit',at:now}];
  assert.equal(nextAllowed(state,'mic','visit',now),now+60000);
  assert.equal(nextAllowed(state,'1688','visit',now),now);
  assert.equal(nextAllowed(state,'mic','send',now),now);
});
test('scheduler and exported plan choose available platforms before those on cooldown',()=>{
  const state=initialState(),now=1000000;
  state.slots=[{platform:'alibaba',kind:'visit',at:now}];
  state.queue=[{id:'a',url:'https://a.alibaba.com/',platform:'alibaba',status:'pending'}, {id:'b',url:'https://a.1688.com/',platform:'1688',status:'pending'}];
  assert.equal(dueJob(state,now).job.id,'b');
  const plan=makePlan(state,now);
  assert.equal(plan[1].plannedAt,now); assert.equal(plan[0].plannedAt,now+420000);
  assert.match(scheduleText(state,now),/alibaba.com/);
});
test('clock rollback keeps previous reservations and therefore waits',()=>{
  const state=initialState();state.slots=[{platform:'alibaba',kind:'send',at:2000000}];
  assert.equal(nextAllowed(state,'alibaba','send',1000000),2420000);
});
test('settings cannot bypass hard quotas through zero/invalid intervals',()=>{
  for(const interval of [0,-1,29,30.5,Infinity,86401]) {
    const settings=initialState().settings; settings.intervals.alibaba=interval;
    assert.throws(()=>validateSettings(settings));
  }
  assert.equal(validateSettings(initialState().settings).review,true);
});
test('report neutralizes embedded newlines in detail fields',()=>{
  const state=initialState();state.events=[{at:1000,type:'blocked',url:'https://a.alibaba.com/',detail:'a\nb\tc'}];
  assert.ok(reportText(state).includes('a b c'));
});
test('reimporting schedule never repeats sent or uncertain jobs',()=>{
  const state=initialState();
  state.queue=[
    {id:'1',platform:'alibaba',url:'https://a.alibaba.com/',status:'sent',visitAt:1000},
    {id:'2',platform:'alibaba',url:'https://b.alibaba.com/',status:'uncertain',visitAt:1000},
    {id:'3',platform:'1688',url:'https://c.1688.com/',status:'pending',requestedAt:1000},
  ];
  const parsed=parseList(scheduleText(state,1000));
  assert.equal(parsed.jobs.length,1);assert.equal(parsed.jobs[0].url,'https://c.1688.com/');
  assert.equal(parsed.errors.length,2);
});
