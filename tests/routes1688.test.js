import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import '../extension/rules-shared.js';
import '../extension/routes-1688-shared.js';
const {storeKey,route,fromPage,cached,lookup}=globalThis.OpenLinks1688;
const fixture=readFileSync(new URL('./fixtures/1688-metadata.html',import.meta.url),'utf8');
const store='https://example-shop.1688.com/';
const chat='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html';
test('store identity is the supplier origin across paths and query parameters',()=>{
 assert.equal(storeKey(store+'page/offer.htm?ref=one#products'),store);
 for(const bad of ['https://air.1688.com/','https://login.1688.com/','https://h5api.m.1688.com/','https://example-shop.1688.com.evil.test/','https://user:secret@example-shop.1688.com/'])assert.equal(storeKey(bad),null);
});
test('extracts actual recipient from supplied page structure independently of the shop subdomain',()=>{
 for(const host of ['example-shop','completely-different-name','999998']) {
  const result=fromPage(fixture.replaceAll('example-shop.1688.com',host+'.1688.com'),'https://'+host+'.1688.com/page/contact.htm');
  assert.equal(new URL(result.url).searchParams.get('touid'),'cnalichn示例供应商甲');assert.match(result.source,/wangWangUrl/);
 }
 assert.equal(globalThis.unrelatedScriptWouldRun,undefined);
});
test('derives the public messenger URL from sellerLoginId when no ready link is present',()=>{
 const page='window.pageData = '+JSON.stringify({globalData:{domain:'example-shop.1688.com',sellerLoginId:'另一个供应商'},components:{}})+';';
 const result=fromPage(page,store);assert.equal(new URL(result.url).searchParams.get('touid'),'cnalichn另一个供应商');assert.match(result.source,/sellerLoginId/);
});
test('different domain, buyer/recommendation IDs, conflicting recipients and executable data are not guessed',()=>{
 assert.equal(fromPage(fixture,'https://another.1688.com/').url,null);
 for(const data of [
  {globalData:{domain:'example-shop.1688.com',loginId:'buyer'},recommendations:[{sellerLoginId:'other'}]},
  {globalData:{domain:'example-shop.1688.com',sellerLoginId:'different'},components:{a:{moduleData:{commonUrl:{wangWangUrl:chat+'?touid=wrong'}}}}},
 ])assert.equal(fromPage('window.pageData = '+JSON.stringify(data),store).url,null);
 assert.equal(fromPage('window.pageData = (() => {throw new Error("must not execute")})();',store).url,null);
 assert.equal(fromPage('window.pageData = {"bad":',store).url,null);
});
test('JSON extraction handles escaped quotes and braces without evaluating surrounding scripts',()=>{
 const page='window.pageData = '+JSON.stringify({globalData:{domain:'example-shop.1688.com',sellerLoginId:'商家{"甲"}'}})+';throw new Error("ignored");';
 assert.equal(new URL(fromPage(page,store).url).searchParams.get('touid'),'cnalichn商家{"甲"}');
});
test('normalizes an inner chat iframe to the full messenger and removes tracking',()=>{
 const target=new URL(route(chat.replace('def_cbu_web_im/','def_cbu_web_im_core/')+'?touid=cnalichn%E5%95%86%E5%AE%B6&siteid=cnalichn&spm=tracking'));
 assert.ok(target.pathname.endsWith('/def_cbu_web_im/index.html'));assert.equal(target.searchParams.get('touid'),'cnalichn商家');assert.equal(target.hash,'#/');assert.equal(target.searchParams.has('spm'),false);
 assert.equal(route(chat+'?touid=supplier&chatToken=secret'),null);
});
test('persistent cache reuses legacy path entries only for the same supplier and picks a newer observation',()=>{
 const routes={[store+'page/offer.htm?old=1']:{url:chat+'?touid=first',at:1}};
 assert.equal(new URL(cached(JSON.parse(JSON.stringify(routes)),store)).searchParams.get('touid'),'first');
 assert.equal(cached(routes,'https://another.1688.com/'),null);
 routes[store]={url:chat+'?touid=second',at:2};assert.equal(new URL(cached(routes,store+'?new=1')).searchParams.get('touid'),'second');
});
test('unknown supplier metadata is fetched once with account cookies and parsed without a tab',async()=>{
 let calls=0;
 const result=await lookup(store+'page/products.htm',async(url,options)=>{
  calls++;assert.equal(url,store);assert.equal(options.credentials,'include');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  return new Response(fixture,{headers:{'content-type':'text/html; charset=utf-8'}});
 });
 assert.equal(calls,1);assert.equal(new URL(result.url).searchParams.get('touid'),'cnalichn示例供应商甲');
});
test('HTTP errors, redirected identity, wrong formats, oversized data and network failures fall back',async()=>{
 for(const response of [new Response('denied',{status:403}),new Response('{}',{headers:{'content-type':'application/json'}}),new Response(fixture,{headers:{'content-type':'text/html','content-length':String(3*1024*1024)}})])assert.equal((await lookup(store,async()=>response)).url,null);
 const redirected=new Response(fixture,{headers:{'content-type':'text/html'}});Object.defineProperty(redirected,'url',{value:'https://other.1688.com/'});
 assert.equal((await lookup(store,async()=>redirected)).url,null);
 assert.equal((await lookup(store,async()=>{throw new Error('network');})).url,null);
});
