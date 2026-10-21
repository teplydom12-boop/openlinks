import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {clickNativeContact,invokeNativeContact} from '../extension/lib/native-contact.js';

const token='12345678-1234-1234-1234-123456789abc',pageUrl='https://supplier.en.alibaba.com/';
const marked={ok:true,contactToken:token,pageUrl,key:'chat-control'},job={tabId:41};
function transport(overrides={}) {
  const commands=[],responses={
    'DOM.performSearch':{searchId:'search-1',resultCount:1},
    'DOM.getSearchResults':{nodeIds:[7]},
    'DOM.resolveNode':{object:{objectId:'node-7'}},
    'Runtime.callFunctionOn':{result:{value:{ok:true}}},...overrides,
  };
  const api={
    async attach(target,version){commands.push({method:'attach',target,version});if(overrides.attach)throw Error('busy');},
    async detach(target){commands.push({method:'detach',target});if(overrides.detach)throw Error('still busy');},
    async sendCommand(target,method,params){commands.push({method,target,params});const value=responses[method];if(value instanceof Error)throw value;return value||{};},
  };
  return {api,commands};
}
function page(options={}) {
  const actions=[],document={},location={href:options.url||pageUrl};
  class HTMLElement {
    constructor(){this.ownerDocument=document;this.isConnected=true;this.attrs=new Map([['data-openlinks-contact',token]]);}
    getAttribute(name){return this.attrs.get(name)??null;}
    removeAttribute(name){actions.push('remove:'+name);this.attrs.delete(name);}
    closest(selector){return selector==='form'&&options.form||selector==='[inert]'&&options.inert||null;}
    matches(selector){return selector===':disabled'&&!!options.disabled;}
    scrollIntoView(){actions.push('scroll');options.scroll?.(this,location);}
    dispatchEvent(event){actions.push(event.type);options.hover?.(this,location);}
    click(){actions.push('click');}
  }
  const contact=new HTMLElement();
  if(options.detached)contact.isConnected=false;
  if(options.foreignDocument)contact.ownerDocument={};
  if(options.marker!==undefined)contact.attrs.set('data-openlinks-contact',options.marker);
  if(options.ariaDisabled)contact.attrs.set('aria-disabled','true');
  if(options.formProperty)contact.form={};
  if(options.href)contact.attrs.set('href',options.href);
  if(options.guard)document[Symbol.for('openlinks.outreach.popup-guard.v1')]={};
  const window={};window.top=options.topGuard?{document:{[Symbol.for('openlinks.outreach.popup-guard.v1')]:{}}}:window;
  class MouseEvent {constructor(type){this.type=type;}}
  const context={document,location,window,HTMLElement,MouseEvent,contact,request:options.request||{token,pageUrl}};
  const result=vm.runInNewContext('('+invokeNativeContact.toString()+').call(contact,request)',context);
  return {result:JSON.parse(JSON.stringify(result)),actions,contact};
}

test('native contact targets the unique marked node with a Chrome user gesture and releases resources',async()=>{
  const {api,commands}=transport(),result=await clickNativeContact(job,marked,api);
  assert.deepEqual(result,{ok:true,key:marked.key,pageUrl});
  assert.deepEqual(commands.map(item=>item.method),['attach','DOM.getDocument','DOM.performSearch','DOM.getSearchResults','DOM.resolveNode','Runtime.callFunctionOn','DOM.discardSearchResults','Runtime.releaseObject','detach']);
  assert.ok(commands.every(item=>item.target.tabId===job.tabId));
  const call=commands.find(item=>item.method==='Runtime.callFunctionOn').params;
  assert.equal(call.userGesture,true);assert.equal(call.objectId,'node-7');assert.equal(call.returnByValue,true);
  assert.deepEqual(call.arguments,[{value:{token,pageUrl}}]);assert.equal(call.functionDeclaration,invokeNativeContact.toString());
  assert.equal(commands.find(item=>item.method==='DOM.performSearch').params.query,`[data-openlinks-contact="${token}"]`);
  assert.ok(!commands.some(item=>item.method.startsWith('Input.')));
});
test('invalid tab, token, URL or unconfirmed marker never attaches Chrome debugger',async()=>{
  for(const [target,reply] of [[{tabId:-1},marked],[{tabId:'41'},marked],[job,{...marked,ok:false}],[job,{...marked,contactToken:'bad" onclick="send()'}],[job,{...marked,pageUrl:'javascript:send()'}]]) {
    const {api,commands}=transport();assert.equal((await clickNativeContact(target,reply,api)).ok,false);assert.equal(commands.length,0);
  }
});
test('missing or ambiguous markers never execute the page handler and still detach',async()=>{
  for(const resultCount of [0,2]) {
    const {api,commands}=transport({'DOM.performSearch':{searchId:'search-1',resultCount}});
    assert.equal((await clickNativeContact(job,marked,api)).ok,false);
    assert.ok(!commands.some(item=>item.method==='Runtime.callFunctionOn'));
    assert.equal(commands.at(-2).method,'DOM.discardSearchResults');assert.equal(commands.at(-1).method,'detach');
  }
});
test('stale resolved node and transport exceptions never fall back to an untrusted click',async()=>{
  for(const overrides of [
    {'DOM.getSearchResults':{nodeIds:[]}},
    {'DOM.resolveNode':{object:{}}},
    {'Runtime.callFunctionOn':new Error('context destroyed')},
    {'Runtime.callFunctionOn':{exceptionDetails:{text:'handler threw'}}},
  ]) {
    const {api,commands}=transport(overrides),result=await clickNativeContact(job,marked,api);
    assert.equal(result.ok,false);assert.equal(commands.at(-1).method,'detach');
    assert.ok(commands.filter(item=>item.method==='Runtime.callFunctionOn').length<=1);
  }
});
test('attach failure leaves other debugger owners intact and cleanup failure still attempts detach',async()=>{
  const blocked=transport({attach:true});assert.equal((await clickNativeContact(job,marked,blocked.api)).ok,false);assert.deepEqual(blocked.commands.map(item=>item.method),['attach']);
  const cleanup=transport({'DOM.discardSearchResults':new Error('navigated'),'Runtime.releaseObject':new Error('gone')});
  assert.equal((await clickNativeContact(job,marked,cleanup.api)).ok,true);assert.equal(cleanup.commands.at(-1).method,'detach');
});
test('detach failure after a successful native click reports its side effect instead of permitting a blind retry',async()=>{
  const {api,commands}=transport({detach:true}),result=await clickNativeContact(job,marked,api);
  assert.equal(result.ok,false);assert.equal(result.contactClicked,true);assert.equal(result.contactAttempted,true);assert.match(result.reason,/освободил/);
  assert.equal(commands.filter(item=>item.method==='Runtime.callFunctionOn').length,1);
});
test('the exact native node is clicked once after marker validation and mouseover',()=>{
  const {result,actions,contact}=page();assert.deepEqual(result,{ok:true});
  assert.deepEqual(actions,['remove:data-openlinks-contact','scroll','mouseover','click']);assert.equal(contact.getAttribute('data-openlinks-contact'),null);
});
test('wrong document, token, form, disabled or inert control is never clicked or unmarked',()=>{
  for(const options of [{url:pageUrl+'changed'},{foreignDocument:true},{marker:'different'},{detached:true},{form:true},{formProperty:true},{disabled:true},{ariaDisabled:true},{inert:true},{href:'aliim:open'}]) {
    const {result,actions,contact}=page(options);assert.equal(result.ok,false,JSON.stringify(options));assert.deepEqual(actions,[]);
    assert.notEqual(contact.getAttribute('data-openlinks-contact'),null);
  }
});
test('old popup guards on either accessible document require reload before any contact action',async()=>{
  for(const options of [{guard:true},{topGuard:true}]) {
    const {result,actions}=page(options);assert.deepEqual(result,{ok:false,reason:'reload_required',reloadRequired:true});assert.deepEqual(actions,[]);
    const {api}=transport({'Runtime.callFunctionOn':{result:{value:result}}});
    const reply=await clickNativeContact(job,marked,api);assert.equal(reply.ok,false);assert.equal(reply.reloadRequired,true);assert.match(reply.reason,/Обновите вкладку/);
  }
});
test('mouseover cannot turn a validated contact into a form submission or a different document',()=>{
  for(const hover of [(node)=>{node.form={};},(node,location)=>{location.href=pageUrl+'other';},node=>{node.isConnected=false;},node=>{node.ownerDocument={};},node=>{node.attrs.set('href','aliim:open');}]) {
    const {result,actions}=page({hover});assert.equal(result.ok,false);assert.ok(!actions.includes('click'));
  }
});
