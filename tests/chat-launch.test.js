import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAT_CENTERS,managedChatRoute,normalizeManagedChat,CHAT_LAUNCH_TIMEOUT_MS,validMICBootstrapURL,isMICBootstrapPage,isMICMessengerPage} from '../extension/lib/chat-launch.js';

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
test('MIC mailbox URL suffixes still require bootstrap and can never prove a full messenger',()=>{
  for(const suffix of ['', '?from=messages', '#all', '?from=messages#all']) {
    const url=CHAT_CENTERS.mic+suffix;
    assert.equal(isMICBootstrapPage(url),true,url);
    assert.equal(isMICMessengerPage(url),false,url);
    assert.equal(managedChatRoute('mic',url),true,url);
  }
  for(const url of ['https://membercenter.made-in-china.com/other','https://membercenter.made-in-china.com.evil.test/message/index.html','http://membercenter.made-in-china.com/message/index.html','https://user@membercenter.made-in-china.com/message/index.html','https://membercenter.made-in-china.com:444/message/index.html',null,'not a URL'])assert.equal(isMICBootstrapPage(url),false,String(url));
});
test('MIC readiness accepts only full messenger routes, never login or lite widgets',()=>{
  const full='https://webim.made-in-china.com/super-tm/';
  for(const suffix of ['', '#/chat', '#/chat?data=fixture&isLiteTM=false&isSAChat=false'])assert.equal(isMICMessengerPage(full+suffix),true,suffix);
  for(const suffix of ['#/login', '#/%6cogin?data=fixture', '#/sign-in/', '#/SIGNIN', '#/chat?isLiteTM=true', '#/chat?isLiteTM=false&isLiteTM=true', '#/chat?isSAChat=true', '?isLiteTM=true#/chat', '#%E0%A4%A'])assert.equal(isMICMessengerPage(full+suffix),false,suffix);
  for(const url of [CHAT_CENTERS.mic,full.replace('https:','http:'),full.replace('.com/','.com:444/'),full.replace('webim.','user@webim.'),full.replace('/super-tm/','/other/'),full.replace('.com/','.com.evil.test/')])assert.equal(isMICMessengerPage(url),false,url);
});
test('MIC native bootstrap URL requires the known full-inbox hash without exposing authentication data',()=>{
  const good='https://webim.made-in-china.com/super-tm/#/opaque-account-route?data=synthetic-test-only&refer=&isLiteTM=false&isSAChat=false';
  assert.equal(validMICBootstrapURL(good),true);
  for(const bad of [good.replace('https:','http:'),good.replace('.com/super-tm/','.com:443/super-tm/'),good.replace('#/opaque-account-route?','#/%6cogin?'),good.replace('webim.','webim.evil.'),good.replace('/super-tm/','/other/'),good.replace('webim.','user@webim.'),good.replace('/super-tm/','/super-tm/?redirect=evil'),good.replace('isLiteTM=false','isLiteTM=true'),good.replace('isSAChat=false','isSAChat=true'),good.replace('data=synthetic-test-only','data='),good.replace('refer=','refer=someone'),good+'&data=duplicate',good+'&extra=unknown','https://webim.made-in-china.com/super-tm/','https://webim.made-in-china.com/super-tm/#/login',good.replace('#/opaque-account-route?','#/login?')])assert.equal(validMICBootstrapURL(bad),false);
});
