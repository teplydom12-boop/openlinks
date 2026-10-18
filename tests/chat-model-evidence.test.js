import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../extension/chat-model-evidence.js',import.meta.url),'utf8');
const THREAD='900000001.1-900000002.1#11152@cntaobao';
const ACTIVE='.ww_conversation_list .conversation-list-panel .conversation-item.active[id]';
const HISTORY='.ww_box .message-list';
const ROWS='.rc-scrollbars-view > .message-item-line';
function fixture(){
  class Node {
    get parentElement(){return this._parent||null;}
    get isConnected(){return this._connected!==false;}
  }
  class Element extends Node {
    constructor(html='<div></div>'){super();this._html=html;this._queries={};this._style={display:'block',visibility:'visible',opacity:'1'};}
    get outerHTML(){return this._html;}
    get id(){return this._id||'';}
    querySelectorAll(selector){return this._queries[selector]||[];}
    getBoundingClientRect(){return {width:this._width??100,height:20};}
    closest(){return this._hidden?this:null;}
  }
  class Document {constructor(){this._queries={};}querySelectorAll(selector){return this._queries[selector]||[];}}
  class CSSStyleDeclaration {constructor(values){this.values=values;}getPropertyValue(key){return this.values[key]||'';}}
  const document=new Document(),active=new Element(),history=new Element(),scroller=new Element(),row=new Element('<div class="message-item-line">Synthetic body</div>');
  active._id=THREAD;row._parent=scroller;scroller._parent=history;
  document._queries[ACTIVE]=[active];document._queries[HISTORY]=[history];history._queries[ROWS]=[row];
  const context={document,Node,Element,Document,CSSStyleDeclaration,location:{href:'https://air.1688.com/app/inbox?test=1'},URL,getComputedStyle:node=>new CSSStyleDeclaration(node._style)};
  vm.createContext(context);
  return {context,active,history,scroller,row,Element,run(){return JSON.parse(JSON.stringify(vm.runInContext(source,context)));}};
}
function model(overrides={}){
  return {conversationCode:THREAD,code:{messageId:'synthetic-message'},sender:{targetId:'synthetic-peer',targetType:1},receiver:{targetId:'synthetic-buyer',targetType:1},ext:{senderUserId:'peer-staff',senderMainUserId:'synthetic-peer',receiverUserId:'synthetic-buyer',receiverMainUserId:'synthetic-buyer'},selfState:0,msgType:1,...overrides};
}
function signature(html){let a=2166136261,b=2246822507;for(let i=0;i<html.length;i++){const c=html.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,3266489909);}return `${(a>>>0).toString(16)}${(b>>>0).toString(16)}:${html.length}`;}

test('completion value includes only whitelisted bounded model fields and exact DOM signature',()=>{
  const f=fixture(),message=model();message.originalData={text:'MUST NOT LEAVE PAGE'};message.summary='MUST NOT LEAVE PAGE';message.ext.accessToken='MUST NOT LEAVE PAGE';
  f.row.__reactProps$synthetic={message};const result=f.run();
  assert.equal(result.status,'ready');assert.equal(result.platform,'1688');assert.equal(result.threadId,THREAD);assert.equal(result.url,f.context.location.href);assert.ok(Number.isSafeInteger(result.capturedAt));
  assert.deepEqual(result.rows,[{signature:signature(f.row._html),model:model()}]);assert.equal(result.limited,false);assert.ok(!JSON.stringify(result).includes('MUST NOT LEAVE PAGE'));
});

test('only exact HTTPS 1688 hosts and a unique visible active thread/history are supported',()=>{
  for(const url of ['https://1688.com.attacker.test/','https://fake1688.com/','http://air.1688.com/','https://alibaba.com/']){const f=fixture();f.context.location.href=url;assert.equal(f.run().status,'unsupported');}
  for(const url of ['https://1688.com/','https://air.1688.com/']){const f=fixture();f.context.location.href=url;assert.equal(f.run().status,'ready');}
  for(const mutate of [f=>f.active._id='unverified',f=>f.context.document._queries[ACTIVE].push(new f.Element()),f=>f.context.document._queries[HISTORY].push(new f.Element()),f=>f.active._hidden=true,f=>f.history._style.display='none']){const f=fixture();mutate(f);assert.equal(f.run().status,'unsupported');}
});

test('own getters and arbitrary page application methods are never invoked',()=>{
  const f=fixture(),message=model();let reads=0;
  const forbidden=()=>{reads++;throw new Error('Application code ran');};
  Object.defineProperty(message,'originalData',{get:forbidden});Object.defineProperty(message.ext,'senderUserId',{get:forbidden});
  Object.defineProperty(f.row,'__reactProps$getter',{get:forbidden});
  f.row.__reactFiber$synthetic={memoizedProps:{message},return:null};
  for(const key of ['outerHTML','parentElement','isConnected','id'])Object.defineProperty(f.row,key,{get:forbidden});
  f.row.getBoundingClientRect=forbidden;f.row.querySelectorAll=forbidden;f.row.closest=forbidden;
  f.context.fetch=forbidden;f.context.addEventListener=forbidden;f.context.chrome={runtime:{sendMessage:forbidden}};
  const before=Object.getOwnPropertyNames(f.context).sort(),result=f.run();
  assert.equal(result.status,'ready');assert.equal(reads,0);assert.equal(result.rows.length,1);assert.ok(!Object.hasOwn(result.rows[0].model.ext,'senderUserId'));assert.deepEqual(Object.getOwnPropertyNames(f.context).sort(),before);
});

test('prototype fields and accessors on props/fibers are ignored without calls',()=>{
  const f=fixture();let calls=0;const getter=()=>{calls++;return {message:model()};};
  f.row.__reactProps$prototype=Object.create({message:model()});
  const fiber={};Object.defineProperty(fiber,'memoizedProps',{get:getter});Object.defineProperty(fiber,'return',{get:getter});f.row.__reactFiber$synthetic=fiber;
  assert.deepEqual(f.run().rows,[]);assert.equal(calls,0);
});

test('equivalent hook candidates deduplicate; conflicts in a row or shared DOM signature reject evidence',()=>{
  const f=fixture();f.row.__reactProps$one={message:model()};f.row.__reactFiber$two={memoizedProps:{message:model()},return:null};assert.equal(f.run().rows.length,1);
  f.row.__reactFiber$two.memoizedProps.message=model({selfState:1});assert.deepEqual(f.run().rows,[]);
  const g=fixture(),second=new g.Element(g.row._html);g.row.__reactProps$one={message:model()};second.__reactProps$one={message:model({code:{messageId:'different'}})};g.history._queries[ROWS].push(second);assert.deepEqual(g.run().rows,[]);
});

test('only three row levels and seven fiber nodes are inspected; cycles stop safely',()=>{
  const f=fixture();f.history.__reactProps$level2={message:model()};assert.equal(f.run().rows.length,1);
  delete f.history.__reactProps$level2;const outside=new f.Element();outside.__reactProps$level3={message:model()};f.history._parent=outside;assert.deepEqual(f.run().rows,[]);
  const chain=Array.from({length:8},()=>({memoizedProps:{}}));chain.forEach((node,i)=>node.return=chain[i+1]);chain[7].memoizedProps={message:model()};f.row.__reactFiber$synthetic=chain[0];assert.deepEqual(f.run().rows,[]);
  chain[6].memoizedProps={message:model()};assert.equal(f.run().rows.length,1);chain[0].return=chain[0];assert.deepEqual(f.run().rows,[]);
});

test('oversized HTML and more than 500 visible rows are bounded and reported',()=>{
  const f=fixture();f.row._html='x'.repeat(100001);f.row.__reactProps$synthetic={message:model()};assert.equal(f.run().limited,true);assert.deepEqual(f.run().rows,[]);
  f.history._queries[ROWS]=Array.from({length:501},(_,i)=>{const row=new f.Element(`<div>${i}</div>`);row.__reactProps$synthetic={message:model({code:{messageId:`m${i}`}})};return row;});
  const result=f.run();assert.equal(result.limited,true);assert.equal(result.rows.length,500);assert.equal(result.rows[0].model.code.messageId,'m1');
});

test('invalid scalars are omitted without coercion and collector errors produce no partial rows',()=>{
  const f=fixture();let coercions=0;f.row.__reactProps$synthetic={message:model({conversationCode:'x'.repeat(257),selfState:Infinity,msgType:{toString(){coercions++;return '1';}},sender:{targetId:'unsafe\nvalue',targetType:Number.MAX_SAFE_INTEGER+1}})};
  const result=f.run();assert.equal(coercions,0);for(const key of ['conversationCode','selfState','msgType','sender'])assert.ok(!Object.hasOwn(result.rows[0].model,key));
  f.row.__reactProps$synthetic=new Proxy({}, {getOwnPropertyDescriptor(){throw new Error('Unavailable object');}});assert.equal(f.run().status,'error');assert.deepEqual(f.run().rows,[]);
});
