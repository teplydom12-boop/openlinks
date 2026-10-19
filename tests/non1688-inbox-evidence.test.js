import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../extension/non1688-inbox-evidence.js',import.meta.url),'utf8');
const cid=index=>`900000001-${900000100+index}#11011@icbu`;
function fixture(){
  class Node{
    get parentElement(){return this._parent||null;}get isConnected(){return true;}
    contains(other){for(let n=other;n;n=n._parent)if(n===this)return true;return false;}
  }
  class Element extends Node{
    constructor(){super();this._queries={};this._style={};this._top=0;this._height=200;this._attrs={};}
    get outerHTML(){return '<div>synthetic-sidebar</div>';}get scrollTop(){return this._scrollTop||0;}get scrollHeight(){return this._scrollHeight||1000;}get clientHeight(){return this._clientHeight||200;}
    querySelectorAll(selector){return this._queries[selector]||[];}getAttribute(name){return this._attrs[name]??null;}
    getBoundingClientRect(){return {top:this._top,bottom:this._top+this._height,width:300,height:this._height};}closest(selector){return this._closest?.[selector]||null;}
  }
  class Document{constructor(){this._queries={};}querySelectorAll(selector){return this._queries[selector]||[];}}
  class CSSStyleDeclaration{constructor(values){this.values=values;}getPropertyValue(key){return this.values[key]||({display:'block',visibility:'visible',opacity:'1'}[key]||'');}}
  const document=new Document(),sidebar=new Element(),scroller=new Element(),spacer=new Element();scroller._parent=sidebar;spacer._parent=scroller;scroller._style['overflow-y']='auto';
  const models=Array.from({length:20},(_,i)=>({cid:cid(i)})),keys=models.map((_,i)=>`account-${i}`),map=Object.fromEntries(keys.map((key,i)=>[key,models[i]]));
  const store={list:keys,filterResultList:[...keys],listMap:map,conversationPaginationDone:true,listDataFetched:true,queueFetchContactParams:null,orderedFilter:false,projectFilter:[],companyFilter:[],stayTopFoldedList:[],archiveListVisable:false};
  const root={return:null};root.stateNode={current:root};
  const owner={memoizedState:{memoizedState:store,next:null},return:root},list={memoizedProps:{list:[...keys]},return:owner},widget={memoizedProps:{itemCount:20,itemData:models},memoizedState:{scrollOffset:0},return:list};
  scroller.__reactFiber$test={stateNode:scroller,return:widget};root.child=owner;owner.child=list;list.child=widget;widget.child=scroller.__reactFiber$test;
  const rows=[];document._queries['.buyer-conversation-list']=[sidebar];sidebar._queries['.contact-item-container[data-cid]']=rows;sidebar._queries['.normal-list-container']=[scroller];scroller._queries[':scope > *']=[spacer];
  function setRows(indices,offset){rows.length=0;scroller.__reactFiber$test.child=null;let previous=null;scroller._scrollTop=offset;spacer._top=-offset;spacer._height=1000;widget.memoizedState.scrollOffset=offset;for(const index of indices){const row=new Element();row._parent=spacer;row._top=index*50-offset;row._height=50;row._attrs['data-cid']=cid(index);const renderer={memoizedProps:{index,data:models,style:{top:index*50}},return:widget},item={memoizedProps:{index,item:models[index],RWStyle:{top:index*50}},return:renderer};row.__reactFiber$test={stateNode:row,return:item};renderer.child=item;item.child=row.__reactFiber$test;if(previous)previous.sibling=renderer;else scroller.__reactFiber$test.child=renderer;previous=renderer;rows.push(row);}}
  setRows([0,1,2,3,4,5],0);
  const context={Node,Element,Document,CSSStyleDeclaration,document,location:{href:'https://message.alibaba.com/message/'},URL,getComputedStyle:node=>new CSSStyleDeclaration(node._style)};vm.createContext(context);
  return {context,sidebar,scroller,spacer,models,keys,map,store,root,owner,list,widget,rows,setRows,Element,run(){return JSON.parse(JSON.stringify(vm.runInContext(source,context)));}};
}

test('Alibaba proves the full native list and actual rendered ranks, not virtual spacer completion',()=>{
  const f=fixture(),r=f.run();assert.equal(r.status,'ready');assert.equal(r.schema,'alibaba-inbox-pagination-v1');assert.equal(r.loadedCount,20);assert.equal(r.itemCount,20);assert.equal(r.hasMore,false);assert.equal(r.startVerified,true);assert.equal(r.endVerified,false);assert.deepEqual(r.rowRanks.map(row=>row.index),[0,1,2,3,4,5]);
  f.setRows([16,17,18,19],800);assert.equal(f.run().endVerified,true);assert.equal(f.run().startVerified,false);
  f.store.conversationPaginationDone=false;assert.equal(f.run().hasMore,true);assert.equal(f.run().endVerified,true);
});

test('Alibaba native pagination and loading state never derive from geometry alone',()=>{
  for(const mutate of [f=>delete f.store.conversationPaginationDone,f=>f.store.conversationPaginationDone='true',f=>delete f.store.listDataFetched,f=>delete f.store.queueFetchContactParams]){const f=fixture();f.setRows([16,17,18,19],800);mutate(f);assert.equal(f.run().status,'unsupported');}
  const f=fixture();f.store.listDataFetched=false;assert.equal(f.run().loading,true);f.store.listDataFetched=true;f.store.queueFetchContactParams={};assert.equal(f.run().loading,true);
});

test('Alibaba incomplete native membership, active filters and folded rows cannot count as all chats',()=>{
  for(const mutate of [f=>f.store.filterResultList.pop(),f=>f.store.filterResultList.reverse(),f=>f.store.orderedFilter=true,f=>f.store.projectFilter.push('test'),f=>f.store.companyFilter.push('test'),f=>f.store.stayTopFoldedList.push('test'),f=>f.store.archiveListVisable=true,f=>delete f.map[f.keys[0]],f=>f.list.memoizedProps.list.reverse(),f=>f.widget.memoizedProps.itemCount=19]){const f=fixture();mutate(f);assert.equal(f.run().status,'unsupported');}
});

test('Alibaba binds row models, current React tree, native offset and rendered geometry',()=>{
  for(const mutate of [f=>f.widget.memoizedState.scrollOffset=50,f=>f.rows[1]._top+=30,f=>f.rows[1].__reactFiber$test.return.memoizedProps.index=0,f=>f.rows[1].__reactFiber$test.return.memoizedProps.item={cid:cid(19)},f=>f.root.stateNode.current={},f=>f.scroller.__reactFiber$test.child={stateNode:f.rows[0],return:f.widget},f=>f.rows[0]._attrs['data-cid']=cid(19)]){const f=fixture();mutate(f);assert.equal(f.run().status,'unsupported');}
  const f=fixture();f.rows.reverse();assert.equal(f.run().status,'ready');assert.deepEqual(f.run().rowRanks.map(row=>row.index),[5,4,3,2,1,0]);
  f.setRows([1,2,3,4],0);assert.equal(f.run().status,'unsupported');f.setRows([15,16,17,18],800);assert.equal(f.run().status,'unsupported');
});

test('native application getters, handlers, editor contents and network are never evaluated',()=>{
  const f=fixture();let calls=0;const forbidden=()=>{calls++;throw new Error('Application code ran');};
  for(const node of [f.sidebar,f.scroller,f.spacer,...f.rows]){for(const key of ['outerHTML','scrollTop','scrollHeight','clientHeight','parentElement','isConnected'])Object.defineProperty(node,key,{get:forbidden});for(const key of ['querySelectorAll','getAttribute','getBoundingClientRect','contains','closest'])node[key]=forbidden;}
  f.widget.memoizedProps.itemSize=forbidden;f.store.loadMore=forbidden;Object.defineProperty(f.store,'draft',{get:forbidden});f.context.fetch=forbidden;f.context.chrome={runtime:{sendMessage:forbidden}};
  assert.equal(f.run().status,'ready');assert.equal(calls,0);Object.defineProperty(f.store,'conversationPaginationDone',{get:forbidden});assert.equal(f.run().status,'unsupported');assert.equal(calls,0);
});

test('prototype data, sparse lists, duplicate IDs and unsupported or ambiguous pages fail closed',()=>{
  for(const mutate of [f=>f.owner.memoizedState.memoizedState=Object.create(f.store),f=>delete f.models[0],f=>f.models[1]={cid:cid(0)},f=>f.context.location.href='http://message.alibaba.com/',f=>f.context.location.href='https://alibaba.com.attacker.test/',f=>f.context.location.href='https://user@message.alibaba.com/',f=>f.context.document._queries['.buyer-conversation-list'].push(new f.Element())]){const f=fixture();mutate(f);assert.equal(f.run().status,'unsupported');}
  const f=fixture();let calls=0;Object.defineProperty(f.models,'0',{get(){calls++;return {cid:cid(0)};}});assert.equal(f.run().status,'unsupported');assert.equal(calls,0);
  const g=fixture();g.models.length=10001;assert.equal(g.run().limited,true);
});

test('current committed child tree wins when reused fibers still return to an old root',()=>{
  const f=fixture(),current={return:null,stateNode:f.root.stateNode},owner={memoizedState:{memoizedState:{...f.store,conversationPaginationDone:false},next:null},return:current,child:f.list};
  current.child=owner;f.root.stateNode.current=current;
  // The committed root owns the reused list even though its old return link
  // still leads to the previous owner/root. This occurs in live React trees.
  const r=f.run();assert.equal(r.status,'ready');assert.equal(r.hasMore,true);assert.equal(r.startVerified,true);
  owner.memoizedState.memoizedState.conversationPaginationDone=true;assert.equal(f.run().hasMore,false);
  // A host detached from the current child tree cannot borrow stale evidence.
  owner.child={return:owner};assert.equal(f.run().status,'unsupported');
});

test('bounded current-tree traversal refuses cycles and excessive depth',()=>{
  const f=fixture();f.owner.sibling=f.owner;assert.equal(f.run().status,'unsupported');assert.equal(f.run().limited,true);
  const g=fixture();let parent=g.root;for(let i=0;i<130;i++){const child={return:parent};parent.child=child;parent=child;}parent.child=g.owner;assert.equal(g.run().status,'unsupported');assert.equal(g.run().limited,true);
});

test('Alibaba numeric account-key lists resolve only through matching native listMap conversations',()=>{
  const f=fixture(),keys=f.models.map((_,index)=>910000000+index);f.store.list=keys;f.store.filterResultList=[...keys];f.store.listMap=Object.fromEntries(keys.map((key,index)=>[key,f.models[index]]));f.list.memoizedProps.list=[...keys];
  assert.equal(f.run().status,'ready');f.store.listMap[keys[0]]={cid:cid(19)};assert.equal(f.run().status,'unsupported');
});


test('short Alibaba inbox proves its final row when the viewport is taller than all chats',()=>{
  const f=fixture();f.models.length=2;f.keys.length=2;f.store.filterResultList=f.keys.slice();f.list.memoizedProps.list=f.keys.slice();f.widget.memoizedProps.itemCount=2;f.scroller._scrollHeight=200;f.setRows([0,1],0);
  const r=f.run();assert.equal(r.status,'ready');assert.equal(r.startVerified,true);assert.equal(r.endVerified,true);assert.equal(r.loadedCount,2);
});

function micFixture(){
  const f=fixture(),{Element}=f;f.context.location.href='https://webim.made-in-china.com/super-tm/';f.context.document._queries={'.conversation-record-lst':[f.sidebar]};
  f.sidebar._queries={};f.sidebar._queries['[data-test-id="virtuoso-scroller"]']=[f.scroller];
  const listElement=new Element();listElement._parent=f.scroller;f.sidebar._queries['[data-test-id="virtuoso-item-list"]']=[listElement];
  const rows=[];f.sidebar._queries['[data-test-id="virtuoso-item-list"] .lst-item[id^="friend-PERSON-"]']=rows;
  const models=Array.from({length:20},(_,index)=>({friend:{userId:`synthetic-${index}`},recent:{recentId:`synthetic-${index}`}}));
  const recentList=models.map(model=>model.recent),ownerInstance={isFetchingMore:false,dataSource:models};
  const root={return:null};root.stateNode={current:root};
  const filter={memoizedProps:{isTagFiltering:false,tagFilterId:null,recentList},memoizedState:{showSearchResult:false,conversationType:0},return:root};
  const user={contactsInited:true,hasMoreHistoryRecents:true};
  const owner={memoizedProps:{recentList,user,OAList:[],isLoading:false,firstRowItem:null,lastRowItem:null,tagFilterId:null},stateNode:ownerInstance,return:filter};
  const widget={memoizedProps:{data:models,context:{firstRowItem:null,lastRowItem:null}},return:owner};
  const host={stateNode:f.scroller,return:widget};f.scroller.__reactFiber$test=host;
  const viewportState={items:[],totalCount:20,offsetTop:0,offsetBottom:0,firstItemIndex:0,topListHeight:0,topItems:[]};
  const renderer={memoizedState:{memoizedState:viewportState,next:null},return:host},listHost={stateNode:listElement,return:renderer};listElement.__reactFiber$test=listHost;
  root.child=filter;filter.child=owner;owner.child=widget;widget.child=host;host.child=renderer;renderer.child=listHost;
  function setRows(indices,offset){
    rows.length=0;viewportState.items=[];listHost.child=null;f.scroller._scrollTop=offset;listElement._top=-offset;listElement._height=models.length*50;f.scroller._scrollHeight=Math.max(200,models.length*50);viewportState.totalCount=models.length;let previous=null;
    for(const index of indices){const wrapper=new Element(),row=new Element();wrapper._parent=listElement;row._parent=wrapper;wrapper._top=row._top=index*50-offset;wrapper._height=row._height=50;wrapper._attrs={'data-index':String(index),'data-item-index':String(index)};row._attrs.id=`friend-PERSON-${models[index].friend.userId}`;row._closest={'[data-index][data-item-index]':wrapper};
      const wrapperFiber={stateNode:wrapper,memoizedProps:{'data-index':index,'data-item-index':index,'data-known-size':50},return:listHost};
      const item={memoizedProps:models[index],return:wrapperFiber},rowFiber={stateNode:row,return:item};row.__reactFiber$test=rowFiber;wrapper.__reactFiber$test=wrapperFiber;wrapperFiber.child=item;item.child=rowFiber;
      if(previous)previous.sibling=wrapperFiber;else listHost.child=wrapperFiber;previous=wrapperFiber;rows.push(row);viewportState.items.push({index,originalIndex:index,offset:index*50,size:50,data:models[index]});
    }
    viewportState.offsetTop=indices[0]*50;viewportState.offsetBottom=(models.length-indices.at(-1)-1)*50;
  }
  setRows([0,1,2,3,4,5],0);
  return {...f,models,rows,root,filter,owner,ownerInstance,widget,viewportState,listElement,setRows,user,finish(){user.hasMoreHistoryRecents=false;const last={type:'div',props:{className:'conversation-record-lst-bottom-tip'}};owner.memoizedProps.lastRowItem=last;widget.memoizedProps.context.lastRowItem=last;const footer=new Element();footer._parent=f.scroller;footer._top=models.length*50-f.scroller._scrollTop;footer._height=30;f.scroller._queries['.conversation-record-lst-bottom-tip']=[footer];f.scroller._scrollHeight=Math.max(200,models.length*50+30);return footer;}};
}


test('MIC reports native server pagination and global virtual row ranks',()=>{
  const f=micFixture(),r=f.run();assert.equal(r.status,'ready');assert.equal(r.schema,'mic-inbox-pagination-v1');assert.equal(r.loadedCount,20);assert.equal(r.hasMore,true);assert.equal(r.startVerified,true);assert.equal(r.endVerified,false);assert.deepEqual(r.rowRanks.map(row=>row.index),[0,1,2,3,4,5]);
  f.setRows([16,17,18,19],800);assert.equal(f.run().endVerified,true);assert.equal(f.run().hasMore,true);
  f.finish();f.scroller._scrollTop=830;f.listElement._top=-830;for(const row of f.rows){row._top-=30;row._parent._top-=30;}const footer=f.scroller._queries['.conversation-record-lst-bottom-tip'][0];footer._top-=30;
  const end=f.run();assert.equal(end.status,'ready');assert.equal(end.hasMore,false);assert.equal(end.endVerified,true);
});

test('MIC incomplete native loading, missing flags or unproven footer cannot claim completion',()=>{
  for(const mutate of [f=>delete f.user.hasMoreHistoryRecents,f=>delete f.user.contactsInited,f=>delete f.ownerInstance.isFetchingMore,f=>f.user.hasMoreHistoryRecents=false,f=>f.widget.memoizedProps.context.lastRowItem={},f=>f.owner.memoizedProps.lastRowItem={type:'div',props:{className:'foreign'}}]){const f=micFixture();mutate(f);assert.equal(f.run().status,'unsupported');}
  const f=micFixture();f.user.contactsInited=false;assert.equal(f.run().loading,true);f.user.contactsInited=true;f.ownerInstance.isFetchingMore=true;assert.equal(f.run().loading,true);
});

test('MIC filters, search, hidden native rows, stale geometry and incomplete membership fail closed',()=>{
  for(const mutate of [f=>f.filter.memoizedProps.isTagFiltering=true,f=>f.filter.memoizedState.showSearchResult=true,f=>f.filter.memoizedState.conversationType=1,f=>f.owner.memoizedProps.OAList.push({}),f=>f.viewportState.items.pop(),f=>f.viewportState.items[0].index=1,f=>f.viewportState.items[0].originalIndex=3,f=>f.viewportState.items[0].offset=50,f=>f.viewportState.offsetBottom-=50,f=>f.rows[0]._parent._attrs['data-index']='1',f=>f.rows[0]._top+=10,f=>f.ownerInstance.dataSource=[...f.models].reverse(),f=>f.filter.memoizedProps.recentList=[...f.owner.memoizedProps.recentList].reverse()]){const f=micFixture();mutate(f);assert.equal(f.run().status,'unsupported');}
});

test('MIC own flags cannot invoke getters, SDK handlers or Redux state accessors',()=>{
  const f=micFixture();let calls=0;const forbidden=()=>{calls++;throw new Error('Forbidden application call');};Object.defineProperty(f.user,'phone',{get:forbidden});f.ownerInstance.store={getState:forbidden};f.ownerInstance.fetchMore=forbidden;f.owner.memoizedProps.handleFetchMore=forbidden;f.context.fetch=forbidden;
  assert.equal(f.run().status,'ready');assert.equal(calls,0);Object.defineProperty(f.user,'hasMoreHistoryRecents',{get:forbidden});assert.equal(f.run().status,'unsupported');assert.equal(calls,0);
});

test('short MIC inbox proves both boundaries only with its real native terminal footer',()=>{
  const f=micFixture();f.models.length=2;f.owner.memoizedProps.recentList=f.models.map(model=>model.recent);f.filter.memoizedProps.recentList=f.owner.memoizedProps.recentList;f.setRows([0,1],0);f.finish();
  const r=f.run();assert.equal(r.status,'ready');assert.equal(r.startVerified,true);assert.equal(r.endVerified,true);assert.equal(r.hasMore,false);assert.equal(r.loadedCount,2);
  f.scroller._queries['.conversation-record-lst-bottom-tip']=[];assert.equal(f.run().status,'unsupported');
});


test('only the exact MIC Virtuoso viewport may use observed overflow-y:hidden',()=>{
  const f=micFixture();f.scroller._style['overflow-y']='hidden';f.scroller._style['overflow-x']='auto';assert.equal(f.run().status,'ready');assert.equal(f.run().startVerified,true);f.setRows([16,17,18,19],800);assert.equal(f.run().status,'ready');assert.equal(f.run().endVerified,true);assert.equal(f.run().hasMore,true);
  for(const css of ['clip','visible']){const g=micFixture();g.scroller._style['overflow-y']=css;assert.equal(g.run().status,'unsupported');}
  const ali=fixture();ali.scroller._style['overflow-y']='hidden';assert.equal(ali.run().status,'unsupported');
  const generic=micFixture();generic.scroller._style['overflow-y']='hidden';generic.sidebar._queries['[data-test-id="virtuoso-scroller"]']=[];assert.equal(generic.run().status,'unsupported');
});
