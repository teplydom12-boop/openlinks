import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {localTimestamp,excelDate,displayTime} from '../extension/lib/time.js';

for(const [zone,expected,offset] of [['Asia/Irkutsk','2026-10-16T08:15:30.123+08:00',8],['UTC','2026-10-16T00:15:30.123+00:00',0],['America/New_York','2026-10-15T20:15:30.123-04:00',-4]]) {
 test(`all exports use computer timezone ${zone}, preserving instants on schedule reimport`,()=>{
  const script=`import {localTimestamp,excelDate} from './extension/lib/time.js';
   import {initialState,reportText,scheduleText,activityText,parseList} from './extension/lib/core.js';
   const at=Date.parse('2026-10-16T00:15:30.123Z'),s=initialState();
   s.queue=[{id:'one',url:'https://shop.1688.com/',platform:'1688',status:'pending',requestedAt:at}];
   s.events=[{at,type:'visit',jobId:'one',url:s.queue[0].url,detail:'Example'}];
   console.log(JSON.stringify({time:localTimestamp(at),excel:excelDate(at),report:reportText(s),log:activityText(s),plan:scheduleText(s,at),parsed:parseList(scheduleText(s,at),[],at).jobs[0].requestedAt}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,TZ:zone},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);
  assert.equal(data.time,expected);assert.ok(data.report.includes(expected));assert.ok(data.log.includes(expected));assert.ok(data.plan.includes(expected));
  assert.ok(data.report.includes(zone));assert.equal(data.parsed,Date.parse(expected));
  assert.equal(data.excel,(Date.parse('2026-10-16T00:15:30.123Z')+offset*3600000)/86400000+25569);
 });
}
test('local timestamp round-trips epoch zero and missing dates stay empty',()=>{
 assert.equal(Date.parse(localTimestamp(0)),0);assert.equal(localTimestamp(undefined),'—');assert.equal(excelDate(null),null);assert.equal(displayTime(undefined),'—');
});
test('local UTC offset follows daylight-saving changes rather than a fixed shift',()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {offsetText} from './extension/lib/time.js';console.log(offsetText(Date.parse('2026-01-01T00:00:00Z')),offsetText(Date.parse('2026-07-01T00:00:00Z')));`],{cwd:new URL('..',import.meta.url),env:{...process.env,TZ:'America/New_York'},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'-05:00 -04:00');
});
