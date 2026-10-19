import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/inbox-model-evidence.js', import.meta.url), 'utf8');
const id = index => `900000001.1-${900000002 + index}.1#11152@cntaobao`;
function fixture() {
  class Node {
    get parentElement() { return this._parent || null; }
    get isConnected() { return true; }
    contains(other) { for (let node = other; node; node = node._parent) if (node === this) return true; return false; }
  }
  class Element extends Node {
    constructor() { super(); this._queries = {}; this._style = {}; this._top = 0; this._height = 100; }
    get outerHTML() { return '<div>synthetic sidebar; never returned</div>'; }
    get scrollTop() { return this._scrollTop || 0; }
    get scrollHeight() { return 2426; }
    get clientHeight() { return 100; }
    getAttribute(name) { return name === 'id' ? this._id : name === 'style' ? this._styleText || null : null; }
    querySelectorAll(selector) { return this._queries[selector] || []; }
    getBoundingClientRect() { return {top:this._top, bottom:this._top + this._height, width:200, height:this._height}; }
    closest() { return null; }
  }
  class Document {
    constructor() { this._queries = {}; }
    querySelectorAll(selector) { return this._queries[selector] || []; }
  }
  class CSSStyleDeclaration {
    constructor(values) { this.values = values; }
    getPropertyValue(key) { return this.values[key] || ({display:'block', visibility:'visible', opacity:'1'}[key] || ''); }
  }
  const document = new Document(), sidebar = new Element(), scroller = new Element();
  scroller._parent = sidebar; scroller._scrollTop = 600;
  const rows = [], wrappers = [], spacer = new Element(); spacer._parent = scroller;
  document._queries['.ww_conversation_list'] = [sidebar];
  sidebar._queries['.conversation-list-scroll'] = [scroller];
  sidebar._queries['.conversation-list-panel .conversation-item[id]'] = rows;
  scroller._queries[':scope > *'] = [spacer]; spacer._queries[':scope > *'] = wrappers;
  const ids = Array.from({length:40}, (_, index) => id(index));
  const ownerState = {dataStore:{conversationIdList:[...ids], conversationFetchLoading:false},
    filterConversationList:[...ids], searchListVisible:false, firstScreenRequestEnds:true, hasMore:true};
  const root = {memoizedProps:{}, memoizedState:null, return:null}; root.stateNode = {current:root};
  const owner = {memoizedProps:{}, memoizedState:ownerState, return:root};
  const list = {memoizedProps:{conversationIdList:[...ids], firstScreenRequestEnds:true}, memoizedState:null, return:owner};
  const widget = {memoizedProps:{itemCount:41}, memoizedState:{scrollOffset:600}, return:list};
  const host = {memoizedProps:{}, memoizedState:null, return:widget}; scroller.__reactFiber$test = host;
  function setSlots(spec, offset) {
    rows.length = 0; wrappers.length = 0; scroller._scrollTop = offset; spacer._top = -offset; spacer._height = 2426; widget.memoizedState.scrollOffset = offset;
    for (const slot of spec) {
      const top = slot.index === 0 ? 0 : 26 + (slot.index - 1) * 60, height = slot.index === 0 ? 26 : 60;
      const wrapper = new Element(); wrapper._parent = spacer; wrapper._top = top - offset; wrapper._height = height; wrapper._styleText = `top:${top}px;height:${height}px`;
      const renderer = {memoizedProps:{index:slot.index,style:{top,height}}, return:widget};
      wrapper.__reactFiber$test = {stateNode:wrapper, return:renderer};
      wrapper._queries['.conversation-item[id]'] = [];
      if (slot.id) {
        const row = new Element(); row._id = slot.id; row._top = wrapper._top; row._height = height; row._parent = wrapper;
        rows.push(row); wrapper._queries['.conversation-item[id]'].push(row);
      }
      wrappers.push(wrapper);
    }
  }
  setSlots([10,11,12].map(index => ({index:index+1,id:id(index)})), 600);
  const context = {document, Node, Element, Document, CSSStyleDeclaration,
    location:{href:'https://air.1688.com/app/inbox'}, URL,
    getComputedStyle:node => new CSSStyleDeclaration(node._style)};
  vm.createContext(context);
  return {context, sidebar, scroller, rows, ownerState, owner, list, widget, host, root, Element, wrappers, spacer, setSlots,
    run() { return JSON.parse(JSON.stringify(vm.runInContext(source, context))); }};
}

test('native virtual page returns all loaded count and global ranks without messages or hidden IDs', () => {
  const f = fixture(); f.ownerState.sendText = 'PRIVATE DRAFT'; f.ownerState.dataStore.messageListMap = {secret:'PRIVATE MESSAGE'};
  const result = f.run();
  assert.equal(result.status, 'ready'); assert.equal(result.platform, '1688');
  assert.equal(result.schema, '1688-inbox-pagination-v1'); assert.equal(result.loadedCount, 40);
  assert.equal(result.hasMore, true); assert.equal(result.loading, false);
  assert.equal(result.diagnostic.stage, 'ready'); assert.equal(result.diagnostic.branchCount, 1);
  assert.equal(result.diagnostic.nativeOrderMatch, 1); assert.equal(result.diagnostic.firstRank, 11);
  assert.equal(result.diagnostic.lastRank, 13);
  assert.equal(result.itemCount, 41); assert.equal(result.scrollOffset, 600);
  assert.deepEqual(result.rowRanks, [10,11,12].map(index => ({id:id(index), index:index+1})));
  assert.match(result.domSignature, /^[\da-f]+:\d+$/); assert.ok(Number.isSafeInteger(result.capturedAt));
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!JSON.stringify(result).includes(id(39)));
  f.ownerState.hasMore = false; f.ownerState.dataStore.conversationFetchLoading = true;
  assert.equal(f.run().hasMore, false); assert.equal(f.run().loading, true);
});

test('different lists, filtered search, missing flags and foreign rows cannot prove pagination', () => {
  const mutations = [
    f => f.ownerState.filterConversationList.reverse(),
    f => f.ownerState.dataStore.conversationIdList.pop(),
    f => f.list.memoizedProps.conversationIdList.reverse(),
    f => f.ownerState.searchListVisible = true,
    f => delete f.ownerState.searchListVisible,
    f => f.ownerState.firstScreenRequestEnds = false,
    f => f.list.memoizedProps.firstScreenRequestEnds = false,
    f => f.ownerState.hasMore = 'false',
    f => f.ownerState.dataStore.conversationFetchLoading = undefined,
    f => f.rows[0]._id = id(100),
    f => f.rows[0]._id = f.rows[1]._id,
    f => f.rows[0]._parent = f.sidebar,
    f => f.widget.memoizedProps.itemCount = 400
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.equal(f.run().status, 'unsupported'); }
});

test('stale virtual offsets, detached viewport and stale root branch are unsupported', () => {
  for (const mutate of [f => f.widget.memoizedState.scrollOffset = 40,
    f => f.scroller._scrollTop = 40, f => f.rows.forEach(row => row._top += 1000),
    f => f.root.stateNode.current = {}, f => f.root.return = f.host]) {
    const f = fixture(); mutate(f); assert.equal(f.run().status, 'unsupported');
  }
  const f = fixture(); f.widget.memoizedState.scrollOffset = 602.5; assert.equal(f.run().status, 'ready');
});

test('physical start and end require observed native boundary slots, including the zero-row header', () => {
  const start = fixture(); start.scroller._scrollTop = 0; start.widget.memoizedState.scrollOffset = 0; start.spacer._top = 0;
  assert.equal(start.run().status, 'unsupported');
  start.setSlots([{index:0},{index:1,id:id(4)},{index:2,id:id(9)}], 0);
  assert.equal(start.run().status, 'ready'); assert.equal(start.run().startVerified, true);
  assert.equal(start.run().endVerified, false);
  const end = fixture(); end.setSlots([{index:38,id:id(37)},{index:39,id:id(38)},{index:40,id:id(39)}], 2326);
  assert.equal(end.run().status, 'ready'); assert.equal(end.run().endVerified, true);
  end.setSlots([{index:37,id:id(36)},{index:38,id:id(37)},{index:39,id:id(38)}], 2324);
  assert.equal(end.run().status, 'unsupported');
});

test('actual renderer order survives unordered cache and DOM order, while gaps and conflicting layout fail closed', () => {
  const f = fixture(); f.rows.reverse(); f.wrappers.reverse();
  assert.equal(f.run().status, 'ready'); assert.deepEqual(f.run().rowRanks.map(row => row.index), [13,12,11]);
  f.ownerState.filterConversationList.reverse(); f.ownerState.dataStore.conversationIdList.reverse(); f.list.memoizedProps.conversationIdList.reverse();
  assert.equal(f.run().status, 'ready'); assert.deepEqual(f.run().rowRanks.map(row => row.index), [13,12,11]);
  const g = fixture(); g.setSlots([{index:11,id:id(0)},{index:13,id:id(1)}],600); assert.equal(g.run().status,'unsupported');
  const h = fixture(); h.wrappers[1].__reactFiber$test.return.memoizedProps.index=11; assert.equal(h.run().status,'unsupported');
  const j = fixture(); j.wrappers[0].__reactFiber$test.return.return={...j.widget}; assert.equal(j.run().status,'unsupported');
  const k = fixture(); k.wrappers[0].__reactFiber$test.return.memoizedProps.style.top+=1; assert.equal(k.run().status,'unsupported');
});

test('safe diagnostic stages distinguish stale root, model mismatch and row ordering', () => {
  const f = fixture(); f.root.stateNode.current = {};
  assert.equal(f.run().diagnostic.stage, 'react-current-branch'); assert.equal(f.run().diagnostic.currentRejected, 1);
  const g = fixture(); g.ownerState.searchListVisible = true;
  assert.equal(g.run().diagnostic.stage, 'native-owner'); assert.equal(g.run().diagnostic.ownerCount, 0);
  const h = fixture(); h.list.memoizedProps.conversationIdList.reverse();
  assert.equal(h.run().diagnostic.stage, 'native-list-match');
  const j = fixture(); j.wrappers[0].__reactFiber$test.return.memoizedProps.index = 30;
  assert.equal(j.run().diagnostic.stage, 'native-row-order'); assert.equal(j.run().diagnostic.nativeOrderMatch, 0);
});

test('native owner may have a deep React root; stale alternate limits cannot poison a proven current branch', () => {
  const f = fixture();
  let parent = f.root;
  for (let index = 0; index < 45; index++) parent = {return:parent};
  f.owner.return = parent;
  assert.equal(f.run().status, 'ready'); assert.equal(f.run().fiberDepth, 50);
  const stale = {memoizedProps:{}, memoizedState:null}; stale.return = stale; f.host.alternate = stale;
  assert.equal(f.run().status, 'ready'); assert.equal(f.run().limited, false);
  delete f.root.stateNode.current;
  assert.equal(f.run().status, 'unsupported'); assert.equal(f.run().limitReason, 'react-fiber-cycle');
  const g = fixture(); parent = g.root;
  for (let index = 0; index < 128; index++) parent = {return:parent};
  g.owner.return = parent;
  assert.equal(g.run().status, 'unsupported'); assert.equal(g.run().fiberDepth, 128);
  assert.equal(g.run().limitReason, 'react-fiber-depth');
});

test('own application getters, methods, editor content and network are never invoked', () => {
  const f = fixture(); let calls = 0;
  const forbidden = () => { calls++; throw new Error('Application code ran'); };
  for (const object of [f.sidebar, f.scroller, ...f.rows]) {
    for (const key of ['outerHTML','scrollTop','scrollHeight','clientHeight','parentElement','isConnected']) Object.defineProperty(object, key, {get:forbidden});
    for (const key of ['getAttribute','getBoundingClientRect','querySelectorAll','closest','contains']) object[key] = forbidden;
  }
  Object.defineProperty(f.ownerState, 'sendText', {get:forbidden});
  Object.defineProperty(f.ownerState.dataStore, 'messageListMap', {get:forbidden});
  f.list.memoizedProps.loadMore = forbidden; f.widget.memoizedProps.itemSize = forbidden;
  f.context.fetch = forbidden; f.context.chrome = {runtime:{sendMessage:forbidden}};
  assert.equal(f.run().status, 'ready'); assert.equal(calls, 0);
  Object.defineProperty(f.ownerState, 'hasMore', {get:forbidden});
  assert.equal(f.run().status, 'unsupported'); assert.equal(calls, 0);
});

test('prototype model values and sparse/accessor arrays do not become native evidence', () => {
  const f = fixture(); f.owner.memoizedState = Object.create(f.ownerState); assert.equal(f.run().status, 'unsupported');
  const g = fixture(); let calls = 0;
  Object.defineProperty(g.ownerState.filterConversationList, '10', {get() { calls++; return id(10); }});
  assert.equal(g.run().status, 'unsupported'); assert.equal(calls, 0);
  const h = fixture(); delete h.list.memoizedProps.conversationIdList[10]; assert.equal(h.run().status, 'unsupported');
});

test('collector has bounded native arrays and requires a unique HTTPS 1688 sidebar', () => {
  for (const url of ['https://1688.com.attacker.test/', 'https://alibaba.com/', 'http://air.1688.com/', 'https://user@air.1688.com/']) {
    const f = fixture(); f.context.location.href = url; assert.equal(f.run().status, 'unsupported');
  }
  const f = fixture(); f.context.document._queries['.ww_conversation_list'].push(new f.Element()); assert.equal(f.run().status, 'unsupported');
  const g = fixture(); g.ownerState.dataStore.conversationIdList.length = 10001;
  assert.equal(g.run().status, 'unsupported'); assert.equal(g.run().limited, true);
});
