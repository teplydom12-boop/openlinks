import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAT_CENTERS,managedChatRoute,normalizeManagedChat,CHAT_LAUNCH_TIMEOUT_MS,validMICBootstrapURL} from '../extension/lib/chat-launch.js';

test('managed chat routes recognize public centers and same-platform login without accepting stores or unrelated origins',()=>{
  for(const [name,url] of Object.entries(CHAT_CENTERS))assert.equal(managedChatRoute(name,url),true);
  assert.equal(managedChatRoute('alibaba','https://message.alibaba.com/message/default.htm'),true);
  assert.equal(managedChatRoute('mic','https://webim.made-in-china.com/super-tm/#/login'),true);
  assert.equal(managedChatRoute('alibaba','https://login.alibaba.com/login.htm'),true);
  for(const [name,url] of [
    ['1688','https://shop123.1688.com/'],['1688','https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im_core/index.html'],
    ['mic','https://webim.made-in-china.com/other'],['mic','https://membercenter.made-in-china.com/other'],
    ['alibaba','https://message.alibaba.com.evil.test/message/messenger.htm'],['alibaba','http://message.alibaba.com/message/messenger.htm'],
    ['alibaba','https://user@message.alibaba.com/message/messenger.htm'],['alibaba','https://message.alibaba.com:444/message/messenger.htm'],
    ['alibaba','https://foreign.test/login.htm'],['other',CHAT_CENTERS.alibaba],
  ])assert.equal(managedChatRoute(name,url),false,url);
});
test('managed launch normalization preserves a bounded session-owned retry and rejects malformed authority',()=>{
  const valid={windowId:2,openedAt:100,deadlineAt:100+CHAT_LAUNCH_TIMEOUT_MS,token:crypto.randomUUID(),pending:true};
  assert.deepEqual(normalizeManagedChat(valid),valid);
  for(const patch of [{windowId:-1},{windowId:'2'},{openedAt:NaN},{deadlineAt:99},{deadlineAt:100+CHAT_LAUNCH_TIMEOUT_MS+1},{token:'------------------------------------'}])assert.equal(normalizeManagedChat({...valid,...patch}),null);
  assert.deepEqual(normalizeManagedChat({...valid,launcherClicks:2}),valid,'obsolete launcher state is not carried into direct-center navigation');
});
test('MIC native bootstrap URL requires the known full-inbox hash without exposing authentication data',()=>{
  const good='https://webim.made-in-china.com/super-tm/#/opaque-account-route?data=synthetic-test-only&refer=&isLiteTM=false&isSAChat=false';
  assert.equal(validMICBootstrapURL(good),true);
  for(const bad of [good.replace('https:','http:'),good.replace('.com/super-tm/','.com:443/super-tm/'),good.replace('#/opaque-account-route?','#/%6cogin?'),good.replace('webim.','webim.evil.'),good.replace('/super-tm/','/other/'),good.replace('webim.','user@webim.'),good.replace('/super-tm/','/super-tm/?redirect=evil'),good.replace('isLiteTM=false','isLiteTM=true'),good.replace('isSAChat=false','isSAChat=true'),good.replace('data=synthetic-test-only','data='),good.replace('refer=','refer=someone'),good+'&data=duplicate',good+'&extra=unknown','https://webim.made-in-china.com/super-tm/','https://webim.made-in-china.com/super-tm/#/login',good.replace('#/opaque-account-route?','#/login?')])assert.equal(validMICBootstrapURL(bad),false);
});
