import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/rules-shared.js';
const {makeRule,matches,direct1688}=globalThis.OpenLinksRules;
test('learned storefront rule transfers across suppliers only within its platform',()=>{
 const rule=makeRule({field:'send',selector:'button.dm-submit',tag:'button',label:'Deliver'},'https://first.en.alibaba.com/','alibaba');
 assert.ok(matches(rule,'https://second.en.alibaba.com/'));
 assert.ok(!matches(rule,'https://second.en.made-in-china.com/'));
 assert.ok(!matches(rule,'https://onetalk.alibaba.com/message/weblite.htm'));
});
test('messenger rule is limited to the observed host and path directory',()=>{
 const rule=makeRule({field:'editor',selector:'textarea'},'https://onetalk.alibaba.com/message/weblite.htm','alibaba');
 assert.ok(matches(rule,'https://onetalk.alibaba.com/message/chat.htm'));
 assert.ok(!matches(rule,'https://onetalk.alibaba.com/login/'));
});
test('numeric 1688 storefront rule does not apply to frame or security hosts',()=>{
 const rule=makeRule({field:'contact',selector:'#pcV2WangWang'},'https://13153773601.1688.com/','1688');
 assert.ok(matches(rule,'https://999999.1688.com/'));
 assert.ok(!matches(rule,'https://air.1688.com/'));
 assert.ok(!matches(rule,'https://h5api.m.1688.com/'));
});
test('rules reject platform mismatch, unsupported fields, unsafe URLs and oversized selectors',()=>{
 for(const data of [{field:'success',selector:'a'},{field:'send',selector:'a'.repeat(501)},{field:'send',selector:''}])assert.throws(()=>makeRule(data,'https://a.en.alibaba.com/','alibaba'));
 assert.throws(()=>makeRule({field:'send',selector:'button'},'https://a.en.alibaba.com/','mic'));
 assert.throws(()=>makeRule({field:'send',selector:'button'},'https://user:secret@a.en.alibaba.com/','alibaba'));
});
test('direct chat retains recipient but never a buyer/session/challenge token',()=>{
 const base='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html';
 assert.equal(direct1688(base+'?touid=supplier&siteid=cnalichn&spm=tracking'),base+'?touid=supplier&siteid=cnalichn');
 for(const query of ['?touid=supplier&chatToken=secret','?touid=supplier&uid=buyer','?touid=supplier&x5secdata=secret',''])assert.equal(direct1688(base+query),null);
 assert.equal(direct1688('https://evil.test/?touid=supplier'),null);
});
