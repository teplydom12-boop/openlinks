/* Fixed MAIN-world collector for native history boundaries. Reads only own
 * data descriptors and returns identity/DOM digests plus pagination evidence.
 * No page functions, getters, clicks, editor changes or network requests. */
(() => {
  const result={platform:null,url:location.href,threadId:'',capturedAt:Date.now(),historySignature:'',schema:'',startKnown:false,loading:null,limited:false,status:'unsupported'};
  try {
    const url=new URL(result.url);
    if(url.protocol!=='https:')return result;
    result.platform=url.hostname==='alibaba.com'||url.hostname.endsWith('.alibaba.com')?'alibaba':url.hostname==='made-in-china.com'||url.hostname.endsWith('.made-in-china.com')?'mic':null;
    if(!result.platform)return result;
    const own=(value,key)=>{if(!value||typeof value!=='object')return undefined;const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;};
    const native={queryDocument:Document.prototype.querySelectorAll,queryElement:Element.prototype.querySelectorAll,parent:Object.getOwnPropertyDescriptor(Node.prototype,'parentElement').get,connected:Object.getOwnPropertyDescriptor(Node.prototype,'isConnected').get,html:Object.getOwnPropertyDescriptor(Element.prototype,'outerHTML').get,attribute:Element.prototype.getAttribute,rect:Element.prototype.getBoundingClientRect,closest:Element.prototype.closest,css:CSSStyleDeclaration.prototype.getPropertyValue};
    const query=(root,selector)=>[...(root===document?native.queryDocument:native.queryElement).call(root,selector)];
    const visible=node=>{if(!native.connected.call(node)||native.closest.call(node,'[hidden],[aria-hidden="true"],[inert]'))return false;let parent=node,depth=0;while(parent&&depth++<100){const style=getComputedStyle(parent),css=key=>native.css.call(style,key);if(css('display')==='none'||['hidden','collapse'].includes(css('visibility'))||Number(css('opacity'))===0)return false;parent=native.parent.call(parent);}if(parent){result.limited=true;return false;}const rect=native.rect.call(node);return rect.width>2&&rect.height>2;};
    const site=result.platform,active=query(document,site==='alibaba'?'.buyer-conversation-list .contact-item-container.selected[data-cid]':'.conversation-record-lst [data-test-id="virtuoso-item-list"] .lst-item.active[id^="friend-PERSON-"]').filter(visible);
    const histories=query(document,site==='alibaba'?'.buyer-messenger-container .message-box .im-message-flow .scroll-box':'.conversation-area .window-center-messages-main > .msg-list').filter(visible);
    if(active.length!==1||histories.length!==1)return result;
    result.threadId=site==='alibaba'?native.attribute.call(active[0],'data-cid'):native.attribute.call(active[0],'id').slice('friend-PERSON-'.length);
    if(!result.threadId||result.threadId.length>256||/[\u0000-\u001f\u007f]/u.test(result.threadId)||site==='alibaba'&&!/^\d+-\d+#\d+@icbu$/.test(result.threadId))return result;
    const html=native.html.call(histories[0]);if(html.length>1000000){result.limited=true;return result;}
    let a=2166136261,b=2246822507;for(let index=0;index<html.length;index++){a=Math.imul(a^html.charCodeAt(index),16777619);b=Math.imul(b^html.charCodeAt(index),3266489909);}result.historySignature=`${(a>>>0).toString(16)}${(b>>>0).toString(16)}:${html.length}`;
    const props=[],seenFibers=new Set(),seenProps=new Set();
    const add=value=>{if(value&&typeof value==='object'&&!seenProps.has(value)){seenProps.add(value);props.push(value);}};
    let node=histories[0];
    for(let level=0;node&&level<5;level++,node=native.parent.call(node)){
      const keys=Object.getOwnPropertyNames(node);if(keys.length>512){result.limited=true;return result;}
      const hooks=keys.filter(key=>/^__react(?:Props|Fiber|InternalInstance|EventHandlers)\$/.test(key));if(hooks.length>4){result.limited=true;return result;}
      for(const key of hooks){
        const hook=own(node,key);if(/^__react(?:Props|EventHandlers)\$/.test(key)){add(hook);continue;}
        let fiber=hook;
        for(let depth=0;fiber&&typeof fiber==='object'&&depth<24&&!seenFibers.has(fiber);depth++,fiber=own(fiber,'return')){seenFibers.add(fiber);add(own(fiber,'memoizedProps'));}
      }
    }
    if(site==='alibaba'){
      const scalarId=value=>typeof value==='string'&&/^\d{1,30}$/.test(value)?value:Number.isSafeInteger(value)&&value>0?String(value):'';
      const messageOf=value=>{
        const id=scalarId(own(value,'messageId')),conversation=own(value,'conversationCode'),account=scalarId(own(own(value,'contact'),'accountId')),at=own(value,'sendTime');
        return id&&conversation===result.threadId&&account&&Number.isFinite(at)&&at>0?{id,account,at}:null;
      };
      const messagesOf=list=>{
        const messages=[];
        for(let index=0;index<list.length;index++){
          const value=own(list,String(index)),message=messageOf(value);
          if(message){messages.push(message);continue;}
          const card=own(value,'messageId')===undefined&&own(value,'sendTime')===undefined&&own(value,'sender')===undefined&&own(own(value,'contact'),'cid')===result.threadId;
          if(!card)return null;
        }
        return messages;
      };
      const rowModels=[];let rowsValid=true;
      const wrappers=query(histories[0],'.message-item-wrapper').filter(visible);
      if(wrappers.length>500){result.limited=true;return result;}
      for(const row of wrappers){
        const candidates=new Map(),keys=Object.getOwnPropertyNames(row);if(keys.length>512){result.limited=true;return result;}
        for(const key of keys.filter(key=>/^__react(?:Fiber|InternalInstance)\$/.test(key))){
          let fiber=own(row,key);const seen=new Set();
          for(let depth=0;fiber&&typeof fiber==='object'&&depth<5&&!seen.has(fiber);depth++,fiber=own(fiber,'return')){seen.add(fiber);const message=messageOf(own(own(fiber,'memoizedProps'),'itemData'));if(message)candidates.set(JSON.stringify(message),message);}
        }
        if(candidates.size===1)rowModels.push(candidates.values().next().value);
        else if(candidates.size>1||!query(row,':scope > .session-security-content,:scope > .item-content-wrap > .item-system-notice').length){rowsValid=false;break;}
      }
      if(!rowsValid||!rowModels.length||new Set(rowModels.map(row=>row.id)).size!==rowModels.length)return result;
      const renderedIds=rowModels.map(row=>row.id).sort(),candidates=[];
      for(const candidate of props){
        const contact=own(own(candidate,'summaryData'),'contact'),account=scalarId(own(contact,'accountId')),cid=own(contact,'cid'),loading=own(candidate,'msgLoading'),more=account?own(own(candidate,'noMoreCache'),account):undefined;
        if(!account||cid!==undefined&&cid!==result.threadId||typeof loading!=='boolean'||typeof more!=='boolean'||!rowModels.every(row=>row.account===account))continue;
        const cached=own(own(candidate,'sessionData'),account),lists=[];
        if(Array.isArray(cached))lists.push(cached);
        else if(Array.isArray(own(cached,'list')))lists.push(own(cached,'list'));
        if(cached!==undefined&&!lists.length)continue;
        // The known history component's list includes rendered platform cards
        // as well as real message models. Its non-system message coverage must
        // exactly equal the DOM; an available full cache must also agree.
        const renderedLists=props.map(value=>own(value,'list')).filter(Array.isArray);
        let covered=false;
        for(const list of renderedLists){
          if(list.length>500){result.limited=true;continue;}
          const messages=messagesOf(list);
          if(messages?.length&&messages.every(row=>row.account===account)&&JSON.stringify(messages.map(row=>row.id).sort())===JSON.stringify(renderedIds)){covered=true;break;}
        }
        for(const list of lists){
          if(list.length>500){result.limited=true;covered=false;break;}
          const messages=messagesOf(list);
          if(!messages?.length||!messages.every(row=>row.account===account)||JSON.stringify(messages.map(row=>row.id).sort())!==JSON.stringify(renderedIds)){covered=false;break;}
        }
        candidates.push({startKnown:more===true&&loading===false&&covered,loading,covered,count:rowModels.length,cacheChecked:lists.length>0});
      }
      const unique=new Map(candidates.map(value=>[JSON.stringify(value),value]));
      if(unique.size===1&&!result.limited)Object.assign(result,unique.values().next().value,{status:'ready',schema:'alibaba-no-more-cache-v1'});
    }
    if(site==='mic'){
      const candidates=[];
      const domIds=[];
      const boxes=query(histories[0],'.msg-box').filter(visible);if(boxes.length>500){result.limited=true;return result;}
      for(const row of boxes){
        const bodies=query(row,':scope > .contact-chatInfo,:scope > .mine-chatInfo');
        if(bodies.length===1){domIds.push(native.attribute.call(bodies[0],'id'));continue;}
        // MIC stores an inquiry-assignment notice as an ordinary native
        // message, but renders no contact/mine UUID element for that card.
        // Account for it only through the exact known card's own React msg.
        if(bodies.length||query(row,':scope > .msg-system-box > .msg-inquiry-assign.iAmBuyer').length!==1)return result;
        const ids=new Set(),keys=Object.getOwnPropertyNames(row);if(keys.length>512){result.limited=true;return result;}
        for(const key of keys.filter(key=>/^__react(?:Fiber|InternalInstance)\$/.test(key))){
          let fiber=own(row,key);const seen=new Set();
          for(let depth=0;fiber&&typeof fiber==='object'&&depth<4&&!seen.has(fiber);depth++,fiber=own(fiber,'return')){
            seen.add(fiber);const props=own(fiber,'memoizedProps'),id=own(own(props,'msg'),'svrMsgId');
            if(own(own(props,'friend'),'userId')===result.threadId&&typeof id==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id))ids.add(id);
          }
        }
        if(ids.size!==1)return result;domIds.push(ids.values().next().value);
      }
      for(const candidate of props){
        if(own(own(candidate,'friend'),'userId')!==result.threadId)continue;
        const recent=own(candidate,'recent'),list=own(recent,'msgList'),more=own(recent,'hasMoreHistoryMsg'),loading=own(recent,'fetchingHistoryMsg');
        if(!Array.isArray(list)||typeof more!=='boolean'||typeof loading!=='boolean')continue;
        if(list.length>500){result.limited=true;continue;}
        const rows=[];let valid=true;
        for(let index=0;index<list.length;index++){
          const message=own(list,String(index));
          if(own(message,'isSystemMsg')===true)continue;
          const id=own(message,'svrMsgId'),at=own(message,'timestamp');
          const matchesPeer=['friendId','userId','toUserId'].some(key=>own(message,key)===result.threadId);
          if(!matchesPeer||own(message,'isSystemMsg')!==false||typeof own(message,'isSend')!=='boolean'||typeof id!=='string'||!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)||!Number.isFinite(at)||at<=0){valid=false;break;}
          rows.push({id,at});
        }
        if(!valid||!rows.length||new Set(rows.map(row=>row.id)).size!==rows.length||new Set(domIds).size!==domIds.length)continue;
        // no-more in the application's cache alone does not prove the visible
        // DOM begins at the first message: a virtualized tail must not qualify.
        rows.sort((left,right)=>left.at-right.at);
        const covered=JSON.stringify(rows.map(row=>row.id))===JSON.stringify(domIds);
        const epoch=value=>Number.isFinite(value)&&/^\d{10}(?:\d{3})?$/.test(String(value))?value*(String(value).length===10?1000:1):null;
        const latest=rows.at(-1),at=epoch(latest.at),nativeLatest=epoch(own(recent,'lastMsgTimestamp'));
        // The contact summary is stamped after the message itself (107 ms in
        // the observed native messenger). Allow at most one second of native
        // bookkeeping skew, always returning the message's own timestamp.
        // A later unloaded message or unrelated summary date cannot qualify.
        const latestKnown=covered&&loading===false&&at!==null&&nativeLatest!==null&&Math.abs(at-nativeLatest)<=1000&&at<=Date.now()+300000;
        candidates.push({startKnown:more===false&&loading===false&&covered,loading,covered,count:rows.length,...(latestKnown?{latestMessageAt:at,latestMessageId:latest.id}:{})});
      }
      const unique=new Map(candidates.map(value=>[JSON.stringify(value),value]));
      if(unique.size===1&&!result.limited){Object.assign(result,unique.values().next().value,{status:'ready',schema:'mic-history-boundary-v1'});}
    }
    return result;
  } catch {result.status='error';return result;}
})();
