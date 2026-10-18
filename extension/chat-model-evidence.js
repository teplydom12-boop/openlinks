/* One-shot MAIN-world evidence collector. The completion value is returned by
 * scripting.executeScript. No globals, listeners, application methods, message
 * text, storage, network requests, or DOM mutations are used. Model reads use
 * own data descriptors only; native DOM accessors bypass element overrides. */
(() => {
  const result = {platform:'1688',url:location.href,threadId:'',capturedAt:Date.now(),rows:[],limited:false,status:'unsupported'};
  try {
    const page = new URL(result.url);
    if(page.protocol!=='https:'||!(page.hostname==='1688.com'||page.hostname.endsWith('.1688.com')))return result;
    const own = (value,key) => {
      if(value===null||typeof value!=='object')return undefined;
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
    };
    const native = {
      queryDocument:Document.prototype.querySelectorAll,
      queryElement:Element.prototype.querySelectorAll,
      parent:Object.getOwnPropertyDescriptor(Node.prototype,'parentElement').get,
      connected:Object.getOwnPropertyDescriptor(Node.prototype,'isConnected').get,
      html:Object.getOwnPropertyDescriptor(Element.prototype,'outerHTML').get,
      id:Object.getOwnPropertyDescriptor(Element.prototype,'id').get,
      rect:Element.prototype.getBoundingClientRect,
      closest:Element.prototype.closest,
      css:CSSStyleDeclaration.prototype.getPropertyValue
    };
    const parent = node => native.parent.call(node);
    const query = (root,selector) => [...(root===document?native.queryDocument:native.queryElement).call(root,selector)];
    const visible = node => {
      if(!native.connected.call(node)||native.closest.call(node,'[hidden],[aria-hidden="true"],[inert]'))return false;
      let cursor=node,depth=0;
      while(cursor&&depth++<100){
        const style=getComputedStyle(cursor),css=key=>native.css.call(style,key);
        if(css('display')==='none'||['hidden','collapse'].includes(css('visibility'))||Number(css('opacity'))===0)return false;
        cursor=parent(cursor);
      }
      if(cursor){result.limited=true;return false;}
      const rect=native.rect.call(node);return rect.width>2&&rect.height>2;
    };
    const active=query(document,'.ww_conversation_list .conversation-list-panel .conversation-item.active[id]').filter(visible);
    const histories=query(document,'.ww_box .message-list').filter(visible);
    if(active.length!==1||histories.length!==1)return result;
    const threadId=native.id.call(active[0]);
    if(typeof threadId!=='string'||threadId.length>256||!/^\d+\.\d+-\d+\.\d+#\d+@cntaobao$/.test(threadId))return result;
    result.threadId=threadId;
    const scalar = value => {
      if(typeof value==='string')return value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/u.test(value)?value:undefined;
      if(typeof value==='number')return Number.isSafeInteger(value)?value:undefined;
      return typeof value==='boolean'?value:undefined;
    };
    const fields = (source,keys) => {
      const selected={};
      for(const key of keys){const value=scalar(own(source,key));if(value!==undefined)selected[key]=value;}
      return selected;
    };
    const modelOf = props => {
      const message=own(props,'message');
      if(!message||typeof message!=='object')return null;
      const model=fields(message,['conversationCode','selfState','msgType']);
      for(const [key,names] of [['code',['messageId']],['sender',['targetId','targetType']],['receiver',['targetId','targetType']],['ext',['senderUserId','senderMainUserId','receiverUserId','receiverMainUserId']]]){
        const selected=fields(own(message,key),names);if(Object.keys(selected).length)model[key]=selected;
      }
      return Object.keys(model).length?model:null;
    };
    const signature = html => {
      let a=2166136261,b=2246822507;
      for(let index=0;index<html.length;index++){const code=html.charCodeAt(index);a=Math.imul(a^code,16777619);b=Math.imul(b^code,3266489909);}
      return `${(a>>>0).toString(16)}${(b>>>0).toString(16)}:${html.length}`;
    };
    const rows=query(histories[0],'.rc-scrollbars-view > .message-item-line').filter(visible);
    if(rows.length>500)result.limited=true;
    const bySignature=new Map(),conflicts=new Set();
    for(const row of rows.slice(-500)){
      const html=native.html.call(row);
      if(typeof html!=='string'||html.length>100000){result.limited=true;continue;}
      const candidates=new Map();let cursor=row,rejected=false;
      const take = props => {const model=modelOf(props);if(model)candidates.set(JSON.stringify(model),model);};
      for(let level=0;cursor&&level<3;level++,cursor=parent(cursor)){
        const keys=Object.getOwnPropertyNames(cursor);
        if(keys.length>512){result.limited=true;rejected=true;break;}
        const hooks=keys.filter(key=>/^__react(?:Props|Fiber)\$/.test(key));
        if(hooks.length>4){result.limited=true;rejected=true;break;}
        for(const key of hooks){
          const hook=own(cursor,key);
          if(key.startsWith('__reactProps$')){take(hook);continue;}
          let fiber=hook;const seen=new Set();
          for(let ancestry=0;fiber&&typeof fiber==='object'&&ancestry<7&&!seen.has(fiber);ancestry++){
            seen.add(fiber);take(own(fiber,'memoizedProps'));fiber=own(fiber,'return');
          }
        }
      }
      const key=signature(html);
      if(rejected||candidates.size>1){conflicts.add(key);bySignature.delete(key);continue;}
      if(candidates.size!==1||conflicts.has(key))continue;
      const [serialized,model]=candidates.entries().next().value;
      if(bySignature.has(key)&&bySignature.get(key).serialized!==serialized){conflicts.add(key);bySignature.delete(key);continue;}
      bySignature.set(key,{serialized,model});
    }
    result.rows=[...bySignature].map(([signature,{model}])=>({signature,model}));
    result.status='ready';return result;
  } catch {
    result.rows=[];result.status='error';return result;
  }
})();
