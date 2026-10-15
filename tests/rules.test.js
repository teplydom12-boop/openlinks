import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/rules-shared.js';
const {makeRule,matches,direct1688,upgradeRule,mergeRule}=globalThis.OpenLinksRules;
test('TrustPass supplier scopes migrate and transfer without including login or messenger hosts',()=>{
 const rule=makeRule({field:'contact',selector:'a.action-item.action-alitalk'},'https://first.trustpass.alibaba.com/','alibaba');
 assert.equal(rule.scope.host,'*.trustpass.alibaba.com');
 assert.ok(matches(rule,'https://second.trustpass.alibaba.com/store.html'));
 for(const host of ['login.alibaba.com','onetalk.alibaba.com','trustpass.alibaba.com','first.en.alibaba.com','first.trustpass.alibaba.com.evil.test'])assert.ok(!matches(rule,'https://'+host+'/'));
 const old={...rule,scope:{host:'first.trustpass.alibaba.com',path:'/'}};
 const migrated=upgradeRule(old);assert.equal(migrated.id,rule.id);assert.ok(matches(migrated,'https://second.trustpass.alibaba.com/'));
});
test('alternative selectors survive serialization and reject unbounded input',()=>{
 const rule=makeRule({field:'editor',selector:'textarea[name="draft"]',selectors:['textarea[name="draft"]','textarea.compose',null,'a'.repeat(501)]},'https://webim.made-in-china.com/super-tm/','mic');
 assert.deepEqual(JSON.parse(JSON.stringify(rule)).selectors,['textarea[name="draft"]','textarea.compose']);
});
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
test('numeric and named 1688 storefronts share learning but not messenger or security hosts',()=>{
 const rule=makeRule({field:'contact',selector:'#pcV2WangWang'},'https://13153773601.1688.com/','1688');
 assert.ok(matches(rule,'https://999999.1688.com/'));
 assert.ok(matches(rule,'https://keyangjixie.1688.com/'));
 const named=makeRule({field:'contact',selector:'.service'},'https://keyangjixie.1688.com/','1688');
 assert.ok(matches(named,'https://other-shop.1688.com/'));
 for(const host of ['air','login','passport','detail','my','security','h5api.m'])assert.ok(!matches(named,'https://'+host+'.1688.com/'));
});
test('legacy exact scopes migrate without losing rule identity or messenger boundaries',()=>{
 const rule=makeRule({field:'contact',selector:'.service'},'https://keyangjixie.1688.com/','1688');
 rule.scope={host:'keyangjixie.1688.com',path:'/'};
 const migrated=upgradeRule(rule);
 assert.equal(migrated.id,rule.id);assert.ok(matches(migrated,'https://next.1688.com/'));
 const messenger=makeRule({field:'editor',selector:'textarea'},'https://air.1688.com/app/chat/index.html','1688');
 assert.deepEqual(upgradeRule(messenger),messenger);
});
test('teaching another template retains older alternatives and deduplicates identical lessons',()=>{
 const a=makeRule({field:'send',selector:'.send-a',tag:'button',label:'Send'},'https://first.en.alibaba.com/','alibaba');
 const b=makeRule({field:'send',selector:'.send-b',tag:'button',label:'Deliver'},'https://second.en.alibaba.com/','alibaba');
 let rules=mergeRule([a],b);assert.equal(rules.length,2);
 rules=mergeRule(rules,{...a,id:'new'});assert.deepEqual(rules.map(r=>r.id),[b.id,'new']);
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
