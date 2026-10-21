import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/rules-shared.js';
import '../extension/routes-1688-shared.js';
import {capturedContactURL} from '../extension/lib/outreach-chat-open.js';

const store='https://supplier.en.made-in-china.com/';
const mic='https://webim.made-in-china.com/super-tm/#/chat/FixtureAccount_12345?data=fixture-only&refer='+encodeURIComponent(store+'?bv_id=fixture')+'&isLiteTM=true&isSAChat=false';
test('MIC observed recipient route preserves the native bootstrap only for the current storefront',()=>{
  assert.equal(capturedContactURL(mic,'mic',store),mic);
  assert.equal(capturedContactURL(mic.replace('isLiteTM=true','isLiteTM=false'),'mic',store),mic.replace('isLiteTM=true','isLiteTM=false'));
  for(const value of [mic.replace('FixtureAccount_12345',''),mic.replace('/chat/','/login/'),mic.replace('data=fixture-only','data='),mic+'&data=duplicate',mic.replace('isSAChat=false','isSAChat=true'),mic.replace('https:','http:'),mic.replace('.com/super','.com:443/super'),mic.replace('webim.','user@webim.'),mic.replace('/super-tm/','/super-tm/?redirect=bad'),mic.replace('supplier.en.','other.en.'),mic+'\n'])assert.equal(capturedContactURL(value,'mic',store),null,value);
  assert.equal(capturedContactURL(mic,'mic','https://another.en.made-in-china.com/'),null);
});
test('1688 captured route needs an explicit recipient and uses existing route normalization',()=>{
  const base='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html';
  assert.ok(capturedContactURL(base+'?touid=cnalichnfixture&siteid=cnalichn','1688','https://supplier.1688.com/'));
  for(const value of [base,base+'?touid=',base.replace('air.1688.com','unrelated.invalid')+'?touid=seller','about:blank'])assert.equal(capturedContactURL(value,'1688','https://supplier.1688.com/'),null);
});
test('Alibaba generic messenger cannot prove a supplier; inquiry and invented recipient keys are rejected',()=>{
  for(const value of ['https://onetalk.alibaba.com/message/weblite.htm','https://onetalk.alibaba.com/message/weblite.htm?shop=one','https://message.alibaba.com/msgsend/contact.htm?chatToken=fixture'])assert.equal(capturedContactURL(value,'alibaba','https://supplier.en.alibaba.com/'),null);
});
