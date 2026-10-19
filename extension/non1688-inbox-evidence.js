/* Fixed MAIN-world inbox boundary collector. Only descriptor-owned application
 * data is read. Never invoke page getters, handlers, scroll, input or network.
 * The isolated reader verifies this result against its fresh nonce and DOM. */
(() => {
  const result={platform:null,url:location.href,status:'unsupported',schema:'',capturedAt:Date.now(),domSignature:'',rowRanks:[],loadedCount:null,itemCount:null,hasMore:null,loading:null,firstScreenRequestEnds:false,scrollTop:null,scrollHeight:null,clientHeight:null,scrollOffset:null,startVerified:false,endVerified:false,limited:false,diagnostic:{stage:'url',branches:0,widgets:0,owners:0,candidates:0}};
  try {
    const url=new URL(result.url);
    if(url.protocol!=='https:'||url.username||url.password)return result;
    const site=url.hostname==='alibaba.com'||url.hostname.endsWith('.alibaba.com')?'alibaba':url.hostname==='made-in-china.com'||url.hostname.endsWith('.made-in-china.com')?'mic':null;
    if(!site)return result;result.platform=site;result.schema=`${site}-inbox-pagination-v1`;
    const own=(object,key)=>{if(!object||typeof object!=='object')return undefined;const descriptor=Object.getOwnPropertyDescriptor(object,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;};
    const native={queryDocument:Document.prototype.querySelectorAll,queryElement:Element.prototype.querySelectorAll,parent:Object.getOwnPropertyDescriptor(Node.prototype,'parentElement').get,connected:Object.getOwnPropertyDescriptor(Node.prototype,'isConnected').get,html:Object.getOwnPropertyDescriptor(Element.prototype,'outerHTML').get,scrollTop:Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop').get,scrollHeight:Object.getOwnPropertyDescriptor(Element.prototype,'scrollHeight').get,clientHeight:Object.getOwnPropertyDescriptor(Element.prototype,'clientHeight').get,attribute:Element.prototype.getAttribute,rect:Element.prototype.getBoundingClientRect,closest:Element.prototype.closest,contains:Node.prototype.contains,css:CSSStyleDeclaration.prototype.getPropertyValue};
    const query=(root,selector)=>[...(root===document?native.queryDocument:native.queryElement).call(root,selector)];
    const style=(node,key)=>native.css.call(getComputedStyle(node),key);
    const visible=node=>{
      if(!native.connected.call(node)||native.closest.call(node,'[hidden],[aria-hidden="true"],[inert]'))return false;
      let parent=node,depth=0;
      while(parent&&depth++<100){if(style(parent,'display')==='none'||['hidden','collapse'].includes(style(parent,'visibility'))||Number(style(parent,'opacity'))===0)return false;parent=native.parent.call(parent);}
      if(parent){result.limited=true;return false;}const rect=native.rect.call(node);return rect.width>2&&rect.height>2;
    };
    const sidebarSelector=site==='alibaba'?'.buyer-conversation-list':'.conversation-record-lst';
    const rowSelector=site==='alibaba'?'.contact-item-container[data-cid]':'[data-test-id="virtuoso-item-list"] .lst-item[id^="friend-PERSON-"]';
    const sidebars=query(document,sidebarSelector).filter(visible);result.diagnostic.stage='dom';if(sidebars.length!==1)return result;
    const sidebar=sidebars[0],rows=query(sidebar,rowSelector).filter(visible);
    if(!rows.length||rows.length>3000){result.limited=rows.length>3000;return result;}
    const idOf=row=>native.attribute.call(row,site==='alibaba'?'data-cid':'id');
    const validId=id=>typeof id==='string'&&id.length<=256&&(site==='alibaba'?/^\d+-\d+#\d+@icbu$/.test(id):/^friend-PERSON-[^\u0000-\u0020\u007f]+$/u.test(id));
    const ids=rows.map(idOf);if(ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)return result;
    const direct=query(sidebar,site==='alibaba'?'.normal-list-container':'[data-test-id="virtuoso-scroller"]').filter(visible);
    const directOverflow=direct.length===1?style(direct[0],'overflow-y'):'';
    // The observed MIC Virtuoso viewport hides the vertical scrollbar with
    // overflow-y:hidden; its native virtual model still owns scrollTop. This
    // exception never applies to generic ancestors or overflow:clip/visible.
    let scroller=direct.length===1&&(/auto|scroll/.test(directOverflow)||site==='mic'&&directOverflow==='hidden')?direct[0]:null;
    if(!scroller){
      const candidates=[];let node=native.parent.call(rows[0]),depth=0;
      for(;node&&native.contains.call(sidebar,node)&&depth++<100;node=native.parent.call(node))if(rows.every(row=>native.contains.call(node,row))&&visible(node)&&/auto|scroll/.test(style(node,'overflow-y')))candidates.push(node);
      if(depth>=100){result.limited=true;return result;}
      const overflowing=candidates.filter(node=>native.scrollHeight.call(node)-native.clientHeight.call(node)>3);
      scroller=overflowing.length===1?overflowing[0]:!overflowing.length&&candidates.length===1?candidates[0]:null;
    }
    if(!scroller||!rows.every(row=>native.contains.call(scroller,row)))return result;
    result.scrollTop=native.scrollTop.call(scroller);result.scrollHeight=native.scrollHeight.call(scroller);result.clientHeight=native.clientHeight.call(scroller);result.scrollOffset=result.scrollTop;
    if(![result.scrollTop,result.scrollHeight,result.clientHeight].every(Number.isFinite)||result.scrollTop<0||result.clientHeight<=0||result.scrollHeight<result.clientHeight)return result;
    const html=native.html.call(sidebar);if(html.length>1000000){result.limited=true;return result;}
    let a=2166136261,b=2246822507;for(let index=0;index<html.length;index++){a=Math.imul(a^html.charCodeAt(index),16777619);b=Math.imul(b^html.charCodeAt(index),3266489909);}result.domSignature=`${(a>>>0).toString(16)}${(b>>>0).toString(16)}:${html.length}`;
    const view=native.rect.call(scroller);if(!rows.some(row=>{const rect=native.rect.call(row);return rect.bottom>view.top&&rect.top<view.bottom;}))return result;
    const array=value=>{if(!Array.isArray(value))return null;const length=own(value,'length');if(!Number.isInteger(length)||length<0||length>10000){result.limited=true;return null;}const items=[];for(let i=0;i<length;i++){const item=own(value,String(i));if(item===undefined)return null;items.push(item);}return items;};
    const same=(left,right)=>left&&right&&left.length===right.length&&left.every((value,index)=>value===right[index]);
    const targetNodes=new Set([scroller,...rows,...query(sidebar,'[data-test-id="virtuoso-item-list"]')]),rootPaths=new Map();
    const chains=node=>{
      const names=Object.getOwnPropertyNames(node);if(names.length>512){result.limited=true;return [];}
      const hooks=names.filter(key=>/^__react(?:Fiber|InternalInstance)\$/.test(key));if(!hooks.length||hooks.length>2)return [];
      const roots=new Set();
      for(const key of hooks){const start=own(node,key);for(const first of [start,own(start,'alternate')]){
        let fiber=first,last=null;const seen=new Set();for(let depth=0;fiber&&typeof fiber==='object'&&!seen.has(fiber)&&depth<128;depth++,fiber=own(fiber,'return')){seen.add(fiber);last=fiber;}
        if(!fiber){const current=own(own(last,'stateNode'),'current');if(current&&typeof current==='object')roots.add(current);}
      }}
      const found=[];
      for(const root of roots){
        if(!rootPaths.has(root)){
          const paths=new Map(),seen=new Set(),stack=[{fiber:root,path:[]}];let count=0,limited=false;
          while(stack.length&&count<20000){const {fiber,path}=stack.pop();if(!fiber||typeof fiber!=='object')continue;if(seen.has(fiber)){limited=true;break;}seen.add(fiber);count++;if(path.length>=128){limited=true;break;}
            const next=[...path,fiber],host=own(fiber,'stateNode');if(targetNodes.has(host)){if(paths.has(host)){limited=true;break;}paths.set(host,[...next].reverse());}
            const sibling=own(fiber,'sibling'),child=own(fiber,'child');if(sibling)stack.push({fiber:sibling,path});if(child)stack.push({fiber:child,path:next});
          }
          if(stack.length)limited=true;if(limited)result.limited=true;rootPaths.set(root,limited?null:paths);
        }
        const path=rootPaths.get(root)?.get(node);if(path)found.push(path);
      }
      return found;
    };
    const hookValues=fiber=>{const values=[],seen=new Set();let hook=own(fiber,'memoizedState');for(let i=0;hook&&typeof hook==='object'&&i<64&&!seen.has(hook);i++,hook=own(hook,'next')){seen.add(hook);values.push(own(hook,'memoizedState'));}return values;};
    const candidates=[];result.diagnostic.stage='native';
    if(site==='alibaba'){
      const allChains=chains(scroller);result.diagnostic.branches=allChains.length;
      const modelIds=value=>{const list=array(value);if(!list)return null;const ids=list.map(item=>own(item,'cid'));return ids.every(validId)&&new Set(ids).size===ids.length?ids:null;};
      const keyList=value=>{const list=array(value);return list&&list.every(key=>typeof key==='string'&&key.length>0&&key.length<=256||Number.isSafeInteger(key)&&key>0)&&new Set(list.map(String)).size===list.length?list.map(String):null;};
      for(const chain of allChains){
        for(let wd=0;wd<chain.length;wd++){
          const widget=chain[wd],props=own(widget,'memoizedProps'),state=own(widget,'memoizedState'),loaded=modelIds(own(props,'itemData')),count=own(props,'itemCount'),offset=own(state,'scrollOffset');
          if(!loaded?.length||count!==loaded.length||!Number.isFinite(offset)||Math.abs(offset-result.scrollTop)>3)continue;result.diagnostic.widgets++;
          const owners=[];
          for(let od=wd+1;od<chain.length;od++)for(const store of hookValues(chain[od])){
            if(typeof own(store,'conversationPaginationDone')!=='boolean'||typeof own(store,'listDataFetched')!=='boolean')continue;
            const keys=keyList(own(store,'list')),filtered=keyList(own(store,'filterResultList')),map=own(store,'listMap');
            if(!keys||!same(keys,filtered)||keys.length!==loaded.length||own(store,'orderedFilter')!==false||array(own(store,'projectFilter'))?.length!==0||array(own(store,'companyFilter'))?.length!==0||array(own(store,'stayTopFoldedList'))?.length!==0||own(store,'archiveListVisable')!==false)continue;
            const mapped=keys.map(key=>own(own(map,key),'cid'));if(!same(mapped,loaded))continue;
            const rendered=chain.slice(wd+1,od).some(f=>same(keyList(own(own(f,'memoizedProps'),'list')),keys));if(!rendered)continue;
            const queued=own(store,'queueFetchContactParams');if(queued===undefined)continue;
            owners.push({hasMore:!own(store,'conversationPaginationDone'),loading:!own(store,'listDataFetched')||queued!==null});
          }
          result.diagnostic.owners+=owners.length;if(!owners.length)continue;
          const spacers=query(scroller,':scope > *');if(spacers.length!==1||!rows.every(row=>native.contains.call(spacers[0],row)))continue;
          const spacerRect=native.rect.call(spacers[0]),ranks=[];let valid=true;
          for(const row of rows){
            const options=new Set();
            for(const rowChain of chains(row)){
              const at=rowChain.indexOf(widget);if(at<0||at>24)continue;let index=null,matchedItem=false,matchedData=false,top=null,conflict=false;
              for(const fiber of rowChain.slice(0,at)){
                const p=own(fiber,'memoizedProps'),idx=own(p,'index');if(idx===undefined)continue;
                if(!Number.isInteger(idx)||idx<0||idx>=count||index!==null&&index!==idx){conflict=true;break;}index=idx;
                const item=own(p,'item');if(item!==undefined){if(own(item,'cid')!==idOf(row)||loaded[idx]!==idOf(row)){conflict=true;break;}matchedItem=true;}
                const data=own(p,'data');if(data!==undefined){if(!same(modelIds(data),loaded)){conflict=true;break;}matchedData=true;}
                const s=own(p,'style')||own(p,'RWStyle'),nativeTop=own(s,'top');if(typeof nativeTop==='number'){if(top!==null&&top!==nativeTop){conflict=true;break;}top=nativeTop;}
              }
              const rect=native.rect.call(row);
              if(!conflict&&index!==null&&matchedItem&&matchedData&&top!==null&&Math.abs(rect.top-spacerRect.top-top)<=3)options.add(index);
            }
            if(options.size!==1){valid=false;break;}ranks.push({id:idOf(row),index:options.values().next().value});
          }
          if(!valid||new Set(ranks.map(row=>row.index)).size!==ranks.length)continue;
          const visual=rows.map((row,index)=>({...ranks[index],rect:native.rect.call(row)})).sort((a,b)=>a.rect.top-b.rect.top);
          if(visual.some((row,index)=>index>0&&(row.index!==visual[index-1].index+1||row.rect.top<=visual[index-1].rect.top)))continue;
          const start=result.scrollTop<=3&&visual[0].index===0&&Math.abs(visual[0].rect.top-spacerRect.top)<=3;
          const last=visual.at(-1),end=result.scrollHeight-result.clientHeight-result.scrollTop<=3&&last.index===count-1&&Math.abs(Math.max(result.clientHeight,last.rect.bottom-spacerRect.top)-result.scrollHeight)<=3;
          if(result.scrollTop<=3&&!start||result.scrollHeight-result.clientHeight-result.scrollTop<=3&&!end)continue;
          for(const owner of owners)candidates.push({...owner,rowRanks:ranks,loadedCount:count,itemCount:count,scrollOffset:offset,firstScreenRequestEnds:true,startVerified:start,endVerified:end});
        }
      }
    }
    if(site==='mic'){
      const lists=query(sidebar,'[data-test-id="virtuoso-item-list"]').filter(visible);
      if(lists.length!==1||!rows.every(row=>native.contains.call(lists[0],row)))return result;
      const listElement=lists[0],allChains=chains(listElement);result.diagnostic.branches=allChains.length;
      const peerId=value=>typeof value==='string'&&value.length>0&&value.length<=241&&!/[\u0000-\u0020\u007f]/u.test(value)?value:null;
      const dataIds=value=>{const list=array(value);if(!list)return null;const ids=list.map(item=>{const id=peerId(own(own(item,'friend'),'userId'));return id&&id===own(own(item,'recent'),'recentId')?id:null;});return ids.every(Boolean)&&new Set(ids).size===ids.length?ids:null;};
      const recentIds=value=>{const list=array(value);if(!list)return null;const ids=list.map(item=>peerId(own(item,'recentId')));return ids.every(Boolean)&&new Set(ids).size===ids.length?ids:null;};
      for(const chain of allChains){
        for(let wd=0;wd<chain.length;wd++){
          const widget=chain[wd],props=own(widget,'memoizedProps'),loaded=dataIds(own(props,'data'));
          const context=own(props,'context'),lastItem=own(context,'lastRowItem');
          const footerExpected=lastItem!==null&&own(lastItem,'type')==='div'&&own(own(lastItem,'props'),'className')==='conversation-record-lst-bottom-tip';
          if(!loaded?.length||own(context,'firstRowItem')!==null||lastItem!==null&&!footerExpected)continue;
          const footers=query(scroller,'.conversation-record-lst-bottom-tip').filter(visible);if(footers.length!==(footerExpected?1:0))continue;
          result.diagnostic.widgets++;
          const owners=[];
          for(let od=wd+1;od<chain.length;od++){
            const ownerFiber=chain[od],p=own(ownerFiber,'memoizedProps'),instance=own(ownerFiber,'stateNode'),user=own(p,'user'),more=own(user,'hasMoreHistoryRecents'),inited=own(user,'contactsInited'),loading=own(p,'isLoading'),fetching=own(instance,'isFetchingMore');
            if(!same(recentIds(own(p,'recentList')),loaded)||!same(dataIds(own(instance,'dataSource')),loaded)||typeof more!=='boolean'||typeof inited!=='boolean'||typeof loading!=='boolean'||typeof fetching!=='boolean'||own(p,'firstRowItem')!==null||own(p,'lastRowItem')!==lastItem||own(p,'tagFilterId')!==null||array(own(p,'OAList'))?.length!==0||footerExpected===more)continue;
            const unfiltered=chain.slice(od+1).some(f=>{const fp=own(f,'memoizedProps');return own(fp,'isTagFiltering')===false&&own(fp,'tagFilterId')===null&&same(recentIds(own(fp,'recentList')),loaded);});
            const allChats=chain.slice(od+1).some(f=>{const state=own(f,'memoizedState');return own(state,'showSearchResult')===false&&own(state,'conversationType')===0;});
            if(!unfiltered||!allChats)continue;
            owners.push({hasMore:more,loading:!inited||loading||fetching});
          }
          result.diagnostic.owners+=owners.length;if(!owners.length)continue;
          for(let ld=0;ld<wd;ld++)for(const state of hookValues(chain[ld])){
            const items=array(own(state,'items')),total=own(state,'totalCount'),top=own(state,'offsetTop'),bottom=own(state,'offsetBottom');
            if(!items?.length||items.length!==rows.length||total!==loaded.length||own(state,'firstItemIndex')!==0||own(state,'topListHeight')!==0||array(own(state,'topItems'))?.length!==0||!Number.isFinite(top)||top<0||!Number.isFinite(bottom)||bottom<0)continue;
            const nativeRows=[];let valid=true;
            for(const item of items){
              const index=own(item,'index'),original=own(item,'originalIndex'),offset=own(item,'offset'),size=own(item,'size'),data=own(item,'data'),id=peerId(own(own(data,'friend'),'userId'));
              if(!Number.isInteger(index)||index<0||index>=total||original!==index||!Number.isFinite(offset)||offset<0||!Number.isFinite(size)||size<=2||id!==loaded[index]||own(own(data,'recent'),'recentId')!==id){valid=false;break;}
              nativeRows.push({index,offset,size,id});
            }
            if(!valid||nativeRows.some((row,index)=>index>0&&(row.index!==nativeRows[index-1].index+1||Math.abs(row.offset-nativeRows[index-1].offset-nativeRows[index-1].size)>3))||nativeRows[0].offset!==top)continue;
            const tail=nativeRows.at(-1),totalHeight=tail.offset+tail.size+bottom,listRect=native.rect.call(listElement);
            if(Math.abs(listRect.height-totalHeight)>3)continue;
            if(!footerExpected&&Math.abs(Math.max(result.clientHeight,totalHeight)-result.scrollHeight)>3)continue;
            if(footerExpected){const footer=native.rect.call(footers[0]);if(footer.top-listRect.top<totalHeight-3||footer.bottom-listRect.top>result.scrollHeight+3)continue;}
            const ranks=[],used=new Set();
            for(const row of rows){
              const id=idOf(row).slice('friend-PERSON-'.length),expected=nativeRows.find(item=>item.id===id);
              if(!expected||used.has(expected.index)){valid=false;break;}
              const wrapper=native.closest.call(row,'[data-index][data-item-index]');
              if(!wrapper||native.parent.call(wrapper)!==listElement||Number(native.attribute.call(wrapper,'data-index'))!==expected.index||Number(native.attribute.call(wrapper,'data-item-index'))!==expected.index){valid=false;break;}
              const rect=native.rect.call(wrapper),rowRect=native.rect.call(row);
              if(Math.abs(rect.top-listRect.top-expected.offset)>3||Math.abs(rect.height-expected.size)>3||Math.abs(rowRect.top-rect.top)>3||Math.abs(rowRect.height-rect.height)>3){valid=false;break;}
              let matched=false;
              for(const rowChain of chains(row)){
                const at=rowChain.indexOf(widget);if(at<0||at>40)continue;
                const ownWrapper=rowChain.slice(0,at).find(fiber=>own(fiber,'stateNode')===wrapper),wp=own(ownWrapper,'memoizedProps');
                if(own(wp,'data-index')!==expected.index||own(wp,'data-item-index')!==expected.index||own(wp,'data-known-size')!==expected.size)continue;
                if(!rowChain.slice(0,at).some(fiber=>{const p=own(fiber,'memoizedProps');return own(own(p,'friend'),'userId')===id&&own(own(p,'recent'),'recentId')===id;}))continue;
                matched=true;
              }
              if(!matched){valid=false;break;}used.add(expected.index);ranks.push({id:idOf(row),index:expected.index});
            }
            if(!valid)continue;
            const start=result.scrollTop<=3&&nativeRows[0].index===0&&top===0;
            const end=result.scrollHeight-result.clientHeight-result.scrollTop<=3&&tail.index===total-1&&bottom===0;
            if(result.scrollTop<=3&&!start||result.scrollHeight-result.clientHeight-result.scrollTop<=3&&!end)continue;
            for(const owner of owners)candidates.push({...owner,rowRanks:ranks,loadedCount:total,itemCount:total,firstScreenRequestEnds:true,startVerified:start,endVerified:end});
          }
        }
      }
    }
    result.diagnostic.candidates=candidates.length;
    const unique=new Map(candidates.map(candidate=>[JSON.stringify(candidate),candidate]));
    if(unique.size===1&&!result.limited)Object.assign(result,unique.values().next().value,{status:'ready'});
    result.diagnostic.stage=result.status==='ready'?'ready':!result.diagnostic.branches?'current-branch':!result.diagnostic.widgets?'widget':!result.diagnostic.owners?'owner':unique.size>1?'conflict':'rows';
    return result;
  }catch{result.diagnostic.stage='error';return result;}
})();
