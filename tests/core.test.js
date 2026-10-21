import test from 'node:test';
import assert from 'node:assert/strict';
import {localTimestamp} from '../extension/lib/time.js';
import {initialState, migrateState, classify, parseList, WINDOW_MS, nextAllowed, makePlan, dueJob, scheduleText, reportText, activityText, validateSettings, linkResults} from '../extension/lib/core.js';
test('v4 migration upgrades TrustPass learning and keeps an interrupted 1688 send unresolved',()=>{
 const saved=initialState();saved.version=4;saved.activeId='send';saved.running=true;
 saved.rules=[{id:'lesson',platform:'alibaba',field:'contact',selector:'a.action-alitalk',scope:{host:'first.trustpass.alibaba.com',path:'/'}}];
 saved.queue=[{id:'send',platform:'1688',status:'sending',profile:{rules:[]}}];
 saved.slots=[{platform:'1688',kind:'send',at:123}];
 const state=migrateState(saved);
 assert.equal(state.version,5);assert.equal(state.rules[0].id,'lesson');assert.equal(state.rules[0].scope.host,'*.trustpass.alibaba.com');
 assert.equal(state.queue[0].status,'uncertain');assert.equal(state.activeId,'send');assert.equal(state.running,false);assert.ok(state.queue[0].needsTabCheck);assert.deepEqual(state.slots,saved.slots);
});

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
test('a cooldown yields to the first ready platform in both scheduler and exported plan',()=>{
  const state=initialState(),now=1000000;
  state.slots=[{platform:'alibaba',kind:'visit',at:now}];
  state.queue=[{id:'a',url:'https://a.alibaba.com/',platform:'alibaba',status:'pending'}, {id:'b',url:'https://a.1688.com/',platform:'1688',status:'pending'}];
  const due=dueJob(state,now);
  assert.equal(due.job.id,'b');assert.equal(due.at,now);
  assert.deepEqual(due.deferred.map(item=>item.job.id),['a']);
  const plan=makePlan(state,now);
  assert.equal(plan[0].plannedAt,now+1); assert.equal(plan[1].plannedAt,now);
  assert.ok(scheduleText(state,now).includes(localTimestamp(now+1)+'\tAlibaba\tpending\thttps://a.alibaba.com/'));
});
test('each platform cooldown permits another platform while preserving its own first pending row',()=>{
  for(const [waiting,ready] of [['1688','alibaba'],['1688','mic'],['alibaba','1688'],['alibaba','mic'],['mic','1688']]) {
    const state=initialState(),now=1000000;
    state.slots=[{platform:waiting,kind:'visit',at:now}];
    state.queue=[{id:'first',platform:waiting,status:'pending'},{id:'second',platform:waiting,status:'pending'},{id:'other',platform:ready,status:'pending'}];
    const before=structuredClone(state),due=dueJob(state,now);
    assert.equal(due.job.id,'other',waiting+' -> '+ready);assert.equal(due.at,now);
    assert.deepEqual(due.deferred.map(item=>item.job.id),['first']);assert.deepEqual(state,before);
    state.queue[2].status='attempted';state.slots.push({platform:ready,kind:'visit',at:now+1});
    assert.equal(dueJob(state,now+2).job.id,'first');assert.equal(dueJob(state,now+2).at,now+2);
  }
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
  state.queue=parseList('https://a.alibaba.com/\nhttps://b.alibaba.com/',[],now).jobs;
  assert.equal(dueJob(state,now+1000).at,now+420000);
  assert.equal(dueJob(state,now+500000).at,now+500000);
});
test('when every platform waits, the earliest full eligibility wins across interval, quota and scheduled time',()=>{
  const now=3000000;
  for(const {quotaWait,requestedWait,selected,wait} of [
    {quotaWait:20000,requestedWait:45000,selected:'quota',wait:20000},
    {quotaWait:90000,requestedWait:10000,selected:'scheduled',wait:10000},
    {quotaWait:90000,requestedWait:100000,selected:'interval',wait:60000},
  ]) {
    const state=initialState();
    state.slots=[...Array.from({length:3},(_,i)=>({platform:'alibaba',kind:'send',at:now-WINDOW_MS+quotaWait-1000+i})),{platform:'mic',kind:'visit',at:now}];
    state.queue=[{id:'interval',platform:'mic',status:'pending'},{id:'quota',platform:'alibaba',status:'pending'},{id:'scheduled',platform:'1688',status:'pending',requestedAt:now+requestedWait}];
    const due=dueJob(state,now);
    assert.equal(due.job.id,selected);assert.equal(due.at,now+wait);
    assert.equal(dueJob(state,due.at).job.id,selected);
  }
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
 const chronological=[...plan].sort((a,b)=>a.plannedAt-b.plannedAt);
 for(let index=1;index<chronological.length;index++) {
   const prior=chronological[index-1],job=chronological[index];
   assert.ok(job.plannedAt>prior.plannedAt);
   if(job.platform===prior.platform)assert.ok(job.plannedAt-prior.plannedAt>=state.settings.intervals[job.platform]*1000);
 }
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
 assert.equal(upgraded.version,5);assert.equal(upgraded.rules[0].id,'retained');assert.equal(upgraded.rules[0].scope.host,'*.shop.1688.com');
 assert.deepEqual(upgraded.chatRoutes,state.chatRoutes);assert.deepEqual(upgraded.slots,state.slots);
 assert.deepEqual(migrateState(upgraded),upgraded);
});
test('explicit future time is honored without holding up another ready platform or reordering its own platform',()=>{
  const state=initialState();
  state.queue=[{id:'a',platform:'alibaba',status:'pending',requestedAt:5000000},{id:'same',platform:'alibaba',status:'pending',requestedAt:1},{id:'b',platform:'1688',status:'pending',requestedAt:1}];
  assert.equal(dueJob(state,1000000).job.id,'b');
  assert.deepEqual(makePlan(state,1000000).map(job=>job.plannedAt),[5000000,5420000,1000000]);
  state.queue[2].status='attempted';
  assert.equal(dueJob(state,1000000).job.id,'a');assert.equal(dueJob(state,1000000).at,5000000);
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
  assert.ok(log.includes(localTimestamp(1000)+' [wait] Ожидание'));assert.match(log,/Лимит 3/);
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

test('link journal preserves removed results, separates re-added URLs and counts errors before a successful retry',()=>{
 const state=initialState(),url='https://a.alibaba.com/';
 state.events=[
  {at:1,jobId:'old',url,type:'job_error',jobStatus:'contacting',errorCount:1,detail:'Inactive button'},
  {at:2,jobId:'old',url,type:'attempted',jobStatus:'attempted',errorCount:1,detail:'Clicked once'},
  {at:3,jobId:'old',url,type:'remove_job',jobStatus:'attempted',errorCount:1,detail:'Removed'},
  {at:4,jobId:'failed',url:'https://b.1688.com/',type:'failed',jobStatus:'failed',errorCount:3,detail:'Skipped after three errors'},
  {at:5,jobId:'removed',url:'https://c.1688.com/',type:'remove_job',jobStatus:'pending',errorCount:0,detail:'Removed before visit'},
 ];
 state.queue=[{id:'new',url,status:'retry_wait',errorCount:1,reason:'Button inactive',createdAt:6}];
 const rows=linkResults(state);assert.equal(rows.length,4);
 assert.equal(rows.find(r=>r.id==='old').group,'worked');assert.equal(rows.find(r=>r.id==='old').errorCount,1);
 assert.equal(rows.find(r=>r.id==='failed').group,'errors');assert.equal(rows.find(r=>r.id==='removed').group,'skipped');
 assert.equal(rows.find(r=>r.id==='new').group,'pending');assert.equal(rows.find(r=>r.id==='new').reason,'Button inactive');
 const report=reportText(state);assert.match(report,/РЕЗУЛЬТАТЫ ПО ССЫЛКАМ/);assert.match(report,/failed\t3/);assert.match(report,/СОБЫТИЯ/);
});
test('legacy event-only history and unknown clicks are never presented as successful sends',()=>{
 const state=initialState();state.events=[{jobId:'legacy',url:'https://a.1688.com/',at:10,type:'attempt_unknown',detail:'No reply'}];
 const row=linkResults(state)[0];assert.equal(row.group,'errors');assert.match(row.label,/без повтора/);assert.equal(row.reason,'No reply');
});
