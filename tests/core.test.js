import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, migrateState, classify, parseList, WINDOW_MS, nextAllowed, makePlan, dueJob, scheduleText, reportText, activityText, validateSettings} from '../extension/lib/core.js';

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
test('interval applies only between neighboring visits of the same platform, not sends',()=>{
  const state=initialState(); const now=Date.now();
  state.slots=[{platform:'mic',kind:'visit',at:now},{platform:'alibaba',kind:'visit',at:now}];
  assert.equal(nextAllowed(state,'mic','visit',now),now);
  assert.equal(nextAllowed(state,'alibaba','visit',now),now+420000);
  assert.equal(nextAllowed(state,'1688','visit',now),now);
  assert.equal(nextAllowed(state,'mic','send',now),now);
  assert.equal(nextAllowed(state,'alibaba','send',now),now);
});
test('strict FIFO: a cooldown blocks later platforms in both scheduler and exported plan',()=>{
  const state=initialState(),now=1000000;
  state.slots=[{platform:'alibaba',kind:'visit',at:now}];
  state.queue=[{id:'a',url:'https://a.alibaba.com/',platform:'alibaba',status:'pending'}, {id:'b',url:'https://a.1688.com/',platform:'1688',status:'pending'}];
  assert.equal(dueJob(state,now).job.id,'a');
  const plan=makePlan(state,now);
  assert.equal(plan[0].plannedAt,now+420000); assert.equal(plan[1].plannedAt,now+420001);
  assert.match(scheduleText(state,now),/alibaba.com/);
});
test('clock rollback keeps previous reservations and therefore waits',()=>{
  const state=initialState();state.slots=[{platform:'alibaba',kind:'send',at:2000000}];
  assert.equal(nextAllowed(state,'alibaba','send',1000000),2001000);
});
test('Alibaba -> 1688 -> Alibaba has no configured interval between visits',()=>{
  const state=initialState(), now=1000000;
  state.queue=parseList('https://a.alibaba.com/\nhttps://b.1688.com/\nhttps://c.alibaba.com/',[],now).jobs;
  const plan=makePlan(state,now);
  assert.deepEqual(plan.map(job=>job.plannedAt),[now,now+1,now+2]);
});
test('same-platform interval is measured from the last actual visit even after an error',()=>{
  const state=initialState(), now=1000000;
  state.slots=[{kind:'visit',platform:'alibaba',at:now}];
  state.queue=parseList('https://a.alibaba.com/\nhttps://b.1688.com/',[],now).jobs;
  assert.equal(dueJob(state,now+1000).at,now+420000);
  assert.equal(dueJob(state,now+500000).at,now+500000);
});
test('hard quota permits another platform then returns to the first deferred row',()=>{
  const state=initialState(),now=1000000;
  state.slots=[0,1,2].map(i=>({platform:'alibaba',kind:'visit',at:now+i}));
  state.queue=parseList('https://a.alibaba.com/\nhttps://c.alibaba.com/\nhttps://b.1688.com/\nhttps://d.en.made-in-china.com/',[],now).jobs;
  const due=dueJob(state,now+4);
  assert.equal(due.job.platform,'1688');assert.equal(due.at,now+4);
  assert.match(due.deferred[0].reasons.join(' '),/Лимит/);
  state.queue[2].status='attempted';state.queue[3].status='attempted';
  assert.equal(dueJob(state,now+WINDOW_MS+1001).job.id,state.queue[0].id);
  const plan=makePlan({...state,queue:state.queue.map(job=>({...job,status:'pending'}))},now+4);
  assert.ok(plan[2].plannedAt<plan[0].plannedAt);assert.ok(plan[3].plannedAt<plan[0].plannedAt);assert.ok(plan[0].plannedAt<plan[1].plannedAt);
});
test('all exhausted platforms wake at the earliest eligible quota, preserving per-platform order',()=>{
 const state=initialState(),now=3000000;
 state.slots=[...Array.from({length:3},(_,i)=>({platform:'alibaba',kind:'visit',at:now-1000+i})),...Array.from({length:7},(_,i)=>({platform:'1688',kind:'visit',at:now-100000+i}))];
 state.queue=parseList('https://a.alibaba.com/\nhttps://b.1688.com/\nhttps://c.1688.com/',[],now).jobs;
 const due=dueJob(state,now);assert.equal(due.job.id,state.queue[1].id);assert.equal(due.at,now-100000+WINDOW_MS+1000);
 assert.equal(dueJob(state,due.at).job.id,state.queue[1].id);
});
test('send quota also defers new visits and previously prepared conversations',()=>{
 const state=initialState(),now=3000000;
 state.slots=[0,1,2].map(i=>({platform:'alibaba',kind:'send',at:now-1000+i}));
 state.queue=parseList('https://a.alibaba.com/\nhttps://b.1688.com/',[],now).jobs;
 assert.equal(dueJob(state,now).job.platform,'1688');
 state.queue[0].status='deferred_send';
 assert.equal(dueJob(state,now).job.platform,'1688');
 state.queue[1].status='attempted';assert.equal(dueJob(state,now+WINDOW_MS).job.status,'deferred_send');
});
test('mixed-platform plan respects rolling quotas for visits and sends through repeated bypasses',()=>{
 const state=initialState(),now=3000000;
 state.queue=Array.from({length:60},(_,i)=>({id:String(i),platform:['alibaba','alibaba','1688','mic'][i%4],status:'pending',requestedAt:now}));
 const plan=makePlan(state,now);
 for(const [platform,limit] of [['alibaba',3],['1688',7]]) {
   const same=plan.filter(job=>job.platform===platform);
   for(const job of same)assert.ok(same.filter(other=>other.plannedAt>job.plannedAt-WINDOW_MS && other.plannedAt<=job.plannedAt).length<=limit);
   assert.deepEqual([...same].sort((a,b)=>a.plannedAt-b.plannedAt).map(j=>j.id),same.map(j=>j.id));
 }
 assert.ok(plan[6].plannedAt<plan[5].plannedAt);
});
test('v3 migration keeps persisted lessons, chat routes and reservations and broadens named 1688 shops',()=>{
 const state=initialState();state.version=3;
 state.rules=[{id:'retained',platform:'1688',field:'contact',selector:'.service',scope:{host:'keyangjixie.1688.com',path:'/'}}];
 state.chatRoutes={'https://shop.1688.com/':{url:'saved'}};state.slots=[{platform:'1688',kind:'visit',at:123}];
 const upgraded=migrateState(JSON.parse(JSON.stringify(state)));
 assert.equal(upgraded.version,4);assert.equal(upgraded.rules[0].id,'retained');assert.equal(upgraded.rules[0].scope.host,'*.shop.1688.com');
 assert.deepEqual(upgraded.chatRoutes,state.chatRoutes);assert.deepEqual(upgraded.slots,state.slots);
 assert.deepEqual(migrateState(upgraded),upgraded);
});
test('explicit future time never allows later links to overtake',()=>{
  const state=initialState();
  state.queue=[{id:'a',platform:'alibaba',status:'pending',requestedAt:5000000},{id:'b',platform:'1688',status:'pending',requestedAt:1}];
  assert.equal(dueJob(state,1000000).job.id,'a');
  assert.deepEqual(makePlan(state,1000000).map(job=>job.plannedAt),[5000000,5000001]);
});
test('upgrade retains history and quotas, enables review and pauses old inquiry-capable tasks',()=>{
  const state=initialState();state.version=1;state.running=true;state.settings.review=false;
  state.activeId='active';state.queue=[{id:'active',status:'review',approved:true}];
  state.slots=[{kind:'send',platform:'alibaba',at:1000}];
  for(const p of Object.values(state.settings.profiles)) delete p.chat;
  const migrated=migrateState(state);
  assert.equal(migrated.running,false);assert.equal(migrated.settings.review,true);
  assert.equal(migrated.queue[0].status,'blocked');assert.equal(migrated.queue[0].approved,false);
  assert.deepEqual(migrated.slots,state.slots);assert.equal(migrated.events.at(-1).type,'upgrade');
});
test('activity log includes observable decisions, wait reasons and their timestamps',()=>{
  const state=initialState();state.events=[{at:1000,type:'wait',level:'wait',url:'https://a.alibaba.com/',detail:'Лимит 3 за 20 минут\nСледующая ссылка не обгоняет'}];
  const log=activityText(state);
  assert.match(log,/1970-01-01T00:00:01.000Z \[wait\] Ожидание/);assert.match(log,/Лимит 3/);
  assert.match(log,/минут Следующая/);
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
