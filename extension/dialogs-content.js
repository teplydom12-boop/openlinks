/* Marketplace inbox reader. snapshot() never clicks, types, navigates or sends.
 * Separate guarded command may select an observed inbox row for reading only.
 * Hooks describe structure, never sender identity inferred from text/position.
 * Unknown live layouts are reported explicitly instead of guessed. */
(() => {
  if (globalThis.OpenLinksDialogsReader) return;
  const DOCUMENT_TOKEN = crypto.randomUUID();
  const INBOX_1688 = '.ww_conversation_list .conversation-list-panel .conversation-item[id]';
  const INBOX_ALIBABA = '.buyer-conversation-list .contact-item-container[data-cid]';
  const INBOX_MIC = '.conversation-record-lst [data-test-id="virtuoso-item-list"] .lst-item[id^="friend-PERSON-"]';
  const INBOX = `${INBOX_1688},${INBOX_ALIBABA},${INBOX_MIC}`;
  const EDITORS = 'textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"][contenteditable]';
  let rowTokens = new WeakMap(), micEpoch = crypto.randomUUID(), loginObserved = false;
  const usedTokens = new Set();
  let selectionRows = new Map(), lastTrustedInput = 0, active1688Evidence = null, activeAlibabaEvidence = null, activeMicEvidence = null, pendingReveal = null;
  const LIMIT = {conversations: 200, messages: 500, text: 12000, nodes: 3000};
  const HISTORY = '[data-message-history],[data-chat-history],[data-message-list],[role="log"],.message-list,.messages-list,.chat-messages,.message-history,.chat-history,.buyer-messenger-container .message-box .im-message-flow .scroll-box,.conversation-area .window-center-messages-main > .msg-list';
  const ROOT = '[data-dialog-root],[data-chat-root],[data-conversation-root],.chat-panel,.chat-window,.conversation-panel,.message-panel,.ww_box,.buyer-messenger-container .message-box,.conversation-area .conversation-window,.conversation-area';
  const ITEM = '[data-conversation-item],[data-thread-item],.conversation-item,.session-item,.chat-list-item,'+INBOX_ALIBABA+','+INBOX_MIC;
  const MESSAGE = '[data-message-id],[data-chat-message],[data-message],.message-item,.chat-message,.im-message,.msg-item,.message-row,.msg-row,.message-item-system,.message-item-wrapper,.msg-box,.msg-list-system-tip,.chat-safe-tip-container';
  const CONTENT = '[data-message-text],[data-message-content],.message-text,.message-content,.msg-content,.text-content';
  const EXCLUDED = 'script,style,textarea,input,select,[contenteditable="true"],[contenteditable="plaintext-only"],blockquote,[data-quote],.quoted-message,.message-quote,.reply-preview,[data-message-preview],.message-preview,[data-sender-name],.sender-name,time,.message-time,.message-status,.file-operation,[aria-hidden="true"],[hidden]';
  const PENDING = '[aria-busy="true"],[data-loading="true"],[data-history-loading="true"],.history-loading,.messages-loading,.message-loading,.loading-spinner,[data-load-more],.load-more-messages';
  const IDS = [['data-thread-id','thread'],['data-conversation-id','conversation'],['data-peer-id','peer'],['data-user-id','peer']];
  const QUERY_IDS = [['threadId','thread'],['thread_id','thread'],['conversationId','conversation'],['conversation_id','conversation'],['touid','peer'],['peerId','peer'],['toUserId','peer']];
  const DIRECTIONS = {inbound:'inbound',incoming:'inbound',received:'inbound',outbound:'outbound',outgoing:'outbound',sent:'outbound',system:'system'};
  const DIRECTION_CLASSES = {incoming:'inbound',received:'inbound','message-incoming':'inbound','message-received':'inbound','msg-incoming':'inbound',outgoing:'outbound',sent:'outbound','message-outgoing':'outbound','message-sent':'outbound','msg-outgoing':'outbound','system-message':'system','message-system':'system'};
  const clean = (value, max=LIMIT.text) => String(value ?? '').replace(/\u0000/g,'').replace(/\r\n?/g,'\n').trim().slice(0,max);
  const identifier = value => typeof value==='string' && value.length>0 && value.length<=256 && value===value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '';
  function platform(url=location.href) {
    try {const host=new URL(url).hostname;return host==='1688.com'||host.endsWith('.1688.com')?'1688':host==='alibaba.com'||host.endsWith('.alibaba.com')?'alibaba':host==='made-in-china.com'||host.endsWith('.made-in-china.com')?'mic':null;} catch {return null;}
  }
  function safeUrl(value) {
    try {const url=new URL(value,location.href);if(url.protocol!=='https:'||url.username||url.password||platform(url.href)!==platform())return '';const keep=new URLSearchParams();for(const [key] of QUERY_IDS)if(url.searchParams.has(key))keep.set(key,url.searchParams.get(key));url.search=keep.toString();url.hash='';return url.href;}catch{return '';}
  }
  function visible(node) {
    if(!(node instanceof Element)||!node.isConnected||node.closest('[hidden],[aria-hidden="true"],[inert]'))return false;
    for(let cursor=node;cursor;cursor=cursor.parentElement){const style=getComputedStyle(cursor);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;}
    const rect=node.getBoundingClientRect();return rect.width>2&&rect.height>2;
  }
  function select(root,selector) {return [...root.querySelectorAll(selector)].slice(0,LIMIT.nodes).filter(visible);}
  function liveThreadId(node) {
    if(platform()==='1688'&&node?.matches(INBOX_1688)&&identifier(node.id)&&/^\d+\.\d+-\d+\.\d+#\d+@cntaobao$/.test(node.id))return `thread:${node.id}`;
    if(platform()==='alibaba'&&node?.matches(INBOX_ALIBABA)&&identifier(node.getAttribute('data-cid'))&&/^\d+-\d+#\d+@icbu$/.test(node.getAttribute('data-cid')))return `thread:${node.getAttribute('data-cid')}`;
    if(platform()==='mic'&&node?.matches(INBOX_MIC)&&identifier(node.id.slice('friend-PERSON-'.length)))return `peer:${node.id.slice('friend-PERSON-'.length)}`;
    return '';
  }
  function ownId(node) {
    const live=liveThreadId(node);if(live)return live;
    for(const [attribute,kind] of IDS){const value=identifier(node?.getAttribute(attribute));if(value)return `${kind}:${value}`;}
    return '';
  }
  function urlId(value) {
    try {const url=new URL(value,location.href);if(!safeUrl(url.href))return '';for(const [key,kind] of QUERY_IDS){const id=identifier(url.searchParams.get(key));if(id)return `${kind}:${id}`;}}catch{}
    return '';
  }
  function accountId(root) {
    for(const node of [root,root?.closest('[data-account-id],[data-current-user-id]'),document.body,document.documentElement]){
      for(const attr of ['data-account-id','data-current-user-id']){const id=identifier(node?.getAttribute(attr));if(id)return id;}
    }
    return '';
  }
  function provenAccount(root) {return Boolean(accountId(root))||Boolean(liveThreadId(root));}
  function scoped(id,root) {const account=accountId(root);return account?`account:${account}/${id}`:platform()==='mic'&&root?.matches(INBOX_MIC)&&liveThreadId(root)?`document:${DOCUMENT_TOKEN}/epoch:${micEpoch}/${id}`:provenAccount(root)?id:`document:${DOCUMENT_TOKEN}/${id}`;}
  function identity(root,allowLocation=false) {
    let id=ownId(root);
    if(!id && root){const ancestor=root.parentElement?.closest(IDS.map(([attr])=>`[${attr}]`).join(','));if(ancestor&&!ancestor.matches(MESSAGE)&&!ancestor.closest(ITEM))id=ownId(ancestor);}
    if(!id&&root?.matches('a[href]'))id=urlId(root.href);
    if(!id&&root?.matches(ITEM)){const links=select(root,'a[href]').map(link=>urlId(link.href)).filter(Boolean);if(new Set(links).size===1)id=links[0];}
    if(!id&&allowLocation)id=urlId(location.href);
    return id?scoped(id,root):'';
  }
  function textOf(node,max=LIMIT.text,allowPreview=false) {
    if(!node)return '';
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);const parts=[];let cursor;
    while((cursor=walker.nextNode())){
      if(parts.length>=LIMIT.nodes)break;
      const parent=cursor.parentElement;
      const excluded=parent?.closest(EXCLUDED);
      if((excluded&&(!allowPreview||excluded!==node))||!visible(parent))continue;
      parts.push(cursor.textContent);
    }
    return clean(parts.join(' ').replace(/[\t \n\r]+/g,' '),max);
  }
  function direction(node) {
    const found=new Set();
    for(const attr of ['data-direction','data-message-direction']){const value=clean(node.getAttribute(attr),40).toLowerCase();if(Object.hasOwn(DIRECTIONS,value))found.add(DIRECTIONS[value]);else if(value)found.add('unknown');}
    for(const cls of node.classList)if(Object.hasOwn(DIRECTION_CLASSES,cls))found.add(DIRECTION_CLASSES[cls]);
    const role=node.getAttribute('data-sender-role');if(['supplier','seller','vendor'].includes(role))found.add('inbound');else if(['self','buyer'].includes(role))found.add('outbound');else if(role==='system')found.add('system');
    return found.size===1?[...found][0]:'unknown';
  }
  function timestamp(node) {
    const raw=node.getAttribute('data-timestamp')||node.querySelector('time[datetime]')?.getAttribute('datetime');
    if(!raw)return null;
    if(/^\d{10}(?:\d{3})?$/.test(raw)){const value=Number(raw)*(raw.length===10?1000:1);return Number.isFinite(value)?value:null;}
    // Locale-dependent labels such as "10:30" or "Yesterday" are not dates.
    if(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw))return null;
    const value=Date.parse(raw);return Number.isFinite(value)?value:null;
  }
  function messageNodes(history) {
    const found=select(history,MESSAGE).filter(node=>!node.closest(ITEM)&&!node.closest(EXCLUDED));
    return found.filter(node=>!found.some(other=>other!==node&&other.contains(node)));
  }
  function readMessages(history,live1688=null,liveAlibaba=false,liveMic=null) {
    const nodes=messageNodes(history);let reliable=true,unsupportedMedia=false,reason='';const result=[],ids=new Map();
    if(nodes.length>LIMIT.messages){reliable=false;reason='История превышает предел 500 сообщений.';}
    for(const node of nodes.slice(-LIMIT.messages)){
      const aliBody=liveAlibaba?select(node,'.user-content .session-rich-content,.session-security-text')[0]:null;
      const micSystem=liveMic&&node.matches('.msg-list-system-tip,.chat-safe-tip-container');
      const micBody=liveMic?(micSystem?node:select(node,'.chat-content .chat-txt .msg-text')[0]):null;
      const body=(live1688?select(node,'.content-row > .content')[0]:aliBody||micBody)||select(node,CONTENT).find(child=>!child.closest(EXCLUDED))||node;
      let kind=direction(node);
      if(live1688&&node.matches('.message-item-system'))kind='system';
      else if(live1688&&kind==='unknown'&&!node.hasAttribute('data-direction')&&!node.hasAttribute('data-message-direction')){
        if(node.matches('.message-item.self')&&select(node,':scope > .item.self').length===1&&select(node,'.first-line.self').length===1)kind='outbound';
        else if(node.matches('.message-item:not(.self)')&&select(node,':scope > .item:not(.self)').length===1&&select(node,'.first-line:not(.self)').length===1){
          const avatar=select(node,':scope > .item > .headPic')[0],peerAvatar=select(live1688,'.avatar > .avatar-img')[0];
          const name=textOf(select(node,'.first-line > .nick')[0]),peerName=textOf(select(live1688,'.content > .conversation > .name')[0]);
          if(avatar?.src&&peerAvatar?.src&&avatar.src===peerAvatar.src&&name&&name===peerName)kind='inbound';
        }
      }
      if(liveAlibaba){
        if(node.querySelector(':scope > .session-security-content'))kind='system';
        else {
          const send=node.querySelector(':scope > .item-content-right > .message-flow-menu-box.send:not(.rec)'),receive=node.querySelector(':scope > .item-content-left > .message-flow-menu-box.rec:not(.send)');
          kind=send&&!receive&&node.classList.contains('item-right')?'outbound':receive&&!send&&node.classList.contains('item-left-text')?'inbound':'unknown';
        }
        if(!aliBody){reliable=false;unsupportedMedia=true;}
      }
      if(liveMic){
        kind=micSystem?'system':'unknown';
        const contact=node.querySelector(':scope > .contact-chatInfo'),avatar=contact?.querySelector('.avatar img'),peerAvatar=liveMic.querySelector('.item-lf .avatar img');
        const name=contact?textOf(select(contact,'.fromUserName')[0]):'',peerName=title(liveMic);
        if(!micSystem&&contact&&avatar?.src&&peerAvatar?.src&&avatar.src===peerAvatar.src&&name&&name===peerName)kind='inbound';
        if(!micBody){reliable=false;unsupportedMedia=true;}
      }
      let full=textOf(body,LIMIT.text+1);
      if(live1688&&select(body,'.file-msg').length){full=`[Файл: ${textOf(select(body,'.file-name')[0])||'без названия'}; содержимое не прочитано]`;unsupportedMedia=true;kind='unknown';}
      else if(live1688&&select(body,'img,video,audio,canvas').length){full=(full?`${full} `:'')+'[Вложение: содержимое не прочитано]';unsupportedMedia=true;kind='unknown';}
      if(liveAlibaba&&(!aliBody||select(body,'img,video,audio,canvas,iframe').length)){full=aliBody&&full?`${full} [Вложение: содержимое не прочитано]`:'[Вложение: содержимое не прочитано]';unsupportedMedia=true;kind='unknown';}
      if(liveMic&&(!micBody||select(body,'img,video,audio,canvas,iframe').length)){full=micBody&&full?`${full} [Вложение: содержимое не прочитано]`:'[Вложение: содержимое не прочитано]';unsupportedMedia=true;kind='unknown';}
      const micId=liveMic?node.querySelector(':scope > .contact-chatInfo[id]')?.id:'',id=identifier(node.getAttribute('data-message-id'))||identifier(node.getAttribute('data-msg-id'))||(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(micId||'')?micId:'');
      if(!full){reliable=false;reason||='Есть сообщение без доступного текста.';continue;}
      if(full.length>LIMIT.text){reliable=false;reason||='Слишком длинный текст сообщения обрезан.';}
      const entry={direction:kind,text:full.slice(0,LIMIT.text)};if(id)entry.id=id;const at=timestamp(node);if(at!==null)entry.at=at;
      if(id&&ids.has(id)){const prior=ids.get(id);if(prior.text!==entry.text||prior.direction!==entry.direction||prior.at!==entry.at){reliable=false;reason||='Один идентификатор относится к разным сообщениям.';}continue;}
      if(id)ids.set(id,entry);result.push(entry);
    }
    // A partly matched layout must not expose an older recognized message as
    // the actual newest message. Unknown text/media inside history blocks it.
    const walker=document.createTreeWalker(history,NodeFilter.SHOW_TEXT);let leaf;
    while((leaf=walker.nextNode())){
      const parent=leaf.parentElement;
      if(live1688&&parent.matches('.ww_message .message-list .rc-scrollbars-view > div:first-child > span')&&!parent.closest('.message-item-line')&&clean(parent.textContent)==='暂无更多消息')continue;
      if(clean(leaf.textContent)&&visible(parent)&&!parent.closest(EXCLUDED)&&!nodes.some(node=>node.contains(parent))){reliable=false;reason||=`Не распознан элемент истории (${parent.tagName.toLowerCase()}${parent.classList.length?'.'+[...parent.classList].slice(0,2).join('.'):''}).`;break;}
    }
    if(select(history,'img,video,audio,[data-attachment]').some(media=>!media.closest(EXCLUDED)&&!nodes.some(node=>node.contains(media)))){reliable=false;reason||='В истории есть вложение вне распознанных сообщений.';}
    // Reverse flex/order/positioned virtual rows cannot imply chronological order.
    const style=getComputedStyle(history);
    if((style.flexDirection==='column-reverse'||style.flexDirection==='row-reverse')&&style.display.includes('flex')){
      if(liveAlibaba&&style.flexDirection==='column-reverse'){
        const tops=nodes.map(node=>node.getBoundingClientRect().top);
        if(tops.every((top,index)=>index===0||top<tops[index-1]))result.reverse();
        else {reliable=false;reason||='Обратный порядок Alibaba не подтверждён расположением строк.';}
      }else {reliable=false;reason||='История отображается в обратном CSS-порядке.';}
    }
    for(const node of nodes){const style=getComputedStyle(node);if(Number(style.order)!==0||['absolute','fixed'].includes(style.position)){reliable=false;reason||='Порядок виртуальных или перемещённых строк истории не подтверждён.';}}
    return {messages:result,reliable,unsupportedMedia,reason};
  }
  function unread(root) {
    if(platform()==='1688'&&root.matches(INBOX_1688))return select(root,'.avatar > .avatar-unread').length>0;
    if(platform()==='mic'&&root.matches(INBOX_MIC))return select(root,'.record-chatInfo-right .unread-count').some(node=>/^[1-9]\d*\+?$/.test(clean(node.textContent,20)));
    const explicit=root.getAttribute('data-unread');
    if(['true','1'].includes(explicit))return true;if(['false','0'].includes(explicit))return false;
    const count=root.getAttribute('data-unread-count');if(count!==null&&/^\d+$/.test(count))return Number(count)>0;
    if(select(root,'[data-unread-badge],.unread-count,.unread-badge').some(node=>/^[1-9]\d*\+?$/.test(clean(node.textContent,20))))return true;
    return null;
  }
  function title(root) {return textOf(select(root,'[data-conversation-title],[data-peer-name],.conversation-title,.chat-title,.peer-name'+(platform()==='1688'&&root.matches(INBOX_1688)?',.content > .conversation > .name':platform()==='alibaba'&&root.matches(INBOX_ALIBABA)?',.contact-info > .name':platform()==='mic'&&root.matches(INBOX_MIC)?',.record-name-box .name':''))[0]).slice(0,300)||clean(root.getAttribute('aria-label'),300)||'';}
  function busy() {
    const editors=select(document,EDITORS).filter(node=>!node.closest('[role="search"]')&&!/search|搜索|查找/i.test([node.id,node.getAttribute('name'),node.getAttribute('placeholder'),node.getAttribute('aria-label')].join(' ')));
    return {hasDraft:editors.some(node=>clean('value'in node?node.value:node.textContent)!==''),userEditing:document.hasFocus()&&document.visibilityState!=='hidden'&&editors.some(node=>node===document.activeElement||node.contains(document.activeElement)),recentUserInput:lastTrustedInput>0&&Date.now()-lastTrustedInput<6000};
  }
  function selectable(item,id) {
    if(!liveThreadId(item)||item.closest('form,a[href]')||item.closest('[aria-disabled="true"],[disabled]'))return {};
    const version=JSON.stringify([unread(item),textOf(select(item,'.conversation-secondary-line > .desc,.msg-wrapper .latest-msg > div,.rg-last-msg .last-msg')[0]),textOf(select(item,'.content > .conversation > .time,.contact-time,.record-time')[0]),item.getAttribute('data-lastmsg-id'),item.getAttribute('data-modify-time'),rowActive(item)]);
    let entry=rowTokens.get(item);if(!entry||entry.id!==id||entry.version!==version){entry={id,version,token:crypto.randomUUID()};rowTokens.set(item,entry);}
    if(usedTokens.has(entry.token)||rowActive(item))return {};
    selectionRows.set(entry.token,{item,id});return {canSelect:true,selectionToken:entry.token};
  }
  function pending(root){return root.matches(PENDING)||select(root,PENDING).length>0;}
  function rowActive(item){return item.matches(INBOX_ALIBABA)?item.classList.contains('selected'):item.classList.contains('active');}
  function tailReason(history) {
    if(document.readyState!=='complete'||pending(history))return 'История ещё загружается.';
    const native1688=platform()==='1688'&&history.matches('.ww_box .message-list');
    const scrollers=native1688?select(history,'.rc-scrollbars-view'):[history,...select(history,'[data-message-scroller],.rc-scrollbars-view')];
    if(native1688&&scrollers.length!==1)return 'Контейнер истории 1688 не подтверждён.';
    if(!native1688)for(let parent=history.parentElement;parent&&parent!==document.body;parent=parent.parentElement){const style=getComputedStyle(parent);if(/auto|scroll/.test(style.overflowY))scrollers.push(parent);if(parent.matches(ROOT))break;}
    if(scrollers.some(node=>pending(node)))return 'В истории виден индикатор загрузки.';
    return scrollers.every(node=>node.scrollTop>=-2&&node.scrollHeight-node.clientHeight-node.scrollTop<=3)?'':'История прокручена выше последних сообщений.';
  }
  function atTail(history) {return tailReason(history)==='';}
  function historyDetail(label,stable,parsed,history){return [!stable?`Ожидание устойчивой истории ${label}.`:'',!parsed.reliable?parsed.reason||'Порядок сообщений не подтверждён.':'',tailReason(history),parsed.unsupportedMedia?'Содержимое вложения не прочитано; подготовка ответа заблокирована.':'',parsed.messages.some(message=>message.direction==='unknown')?'Есть сообщения без подтверждённого отправителя.':''].filter(Boolean).join(' ');}
  function readHistory(history,count) {
    if(platform()==='mic'&&history.matches('.conversation-area .window-center-messages-main > .msg-list')){
      const active=select(document,INBOX_MIC).filter(row=>rowActive(row));
      if(active.length!==1||!liveThreadId(active[0])||select(document,'.conversation-area .window-center-messages-main > .msg-list').length!==1)return null;
      const row=active[0],id=identity(row),parsed=readMessages(history,null,false,row),fingerprint=JSON.stringify([id,parsed.messages]);
      if(!activeMicEvidence||activeMicEvidence.fingerprint!==fingerprint)activeMicEvidence={fingerprint,since:Date.now()};
      const stable=Date.now()-activeMicEvidence.since>=1000,readComplete=stable&&atTail(history),tailKnown=readComplete&&!parsed.unsupportedMedia;
      return {id,identityReliable:true,title:title(row),url:safeUrl(location.href),unread:unread(row),active:true,orderReliable:parsed.reliable,historyStable:stable,readComplete,tailKnown,messages:parsed.messages,needsRead:!tailKnown,detail:historyDetail('Made-in-China',stable,parsed,history)};
    }
    if(platform()==='alibaba'&&history.matches('.buyer-messenger-container .message-box .im-message-flow .scroll-box')){
      const active=select(document,INBOX_ALIBABA).filter(row=>rowActive(row));
      if(active.length!==1||!liveThreadId(active[0])||select(document,'.buyer-messenger-container .message-box .im-message-flow .scroll-box').length!==1)return null;
      const row=active[0],id=identity(row),parsed=readMessages(history,null,true),fingerprint=JSON.stringify([id,parsed.messages]);
      if(!activeAlibabaEvidence||activeAlibabaEvidence.fingerprint!==fingerprint)activeAlibabaEvidence={fingerprint,since:Date.now()};
      const stable=Date.now()-activeAlibabaEvidence.since>=1000,readComplete=stable&&atTail(history),tailKnown=readComplete&&!parsed.unsupportedMedia;
      return {id,identityReliable:true,title:title(row),url:safeUrl(location.href),unread:unread(row),active:true,orderReliable:parsed.reliable,historyStable:stable,readComplete,tailKnown,messages:parsed.messages,needsRead:!tailKnown,detail:historyDetail('Alibaba',stable,parsed,history)};
    }
    // The full 1688 inbox can retain the original touid URL while another row
    // is selected. Until its current thread is proven, that URL is not identity.
    if(platform()==='1688'&&history.closest('.ww_box')&&select(document,INBOX_1688).length){
      const active=select(document,INBOX_1688).filter(row=>row.classList.contains('active'));
      if(active.length!==1||!liveThreadId(active[0])||select(document,'.ww_box .message-list').length!==1||select(history,'.message-list-empty').length)return null;
      const row=active[0],id=identity(row),parsed=readMessages(history,row);
      const fingerprint=JSON.stringify([id,parsed.messages]);
      if(!active1688Evidence||active1688Evidence.fingerprint!==fingerprint)active1688Evidence={fingerprint,since:Date.now()};
      const stable=Date.now()-active1688Evidence.since>=1000,readComplete=stable&&atTail(history),tailKnown=readComplete&&!parsed.unsupportedMedia;
      return {id,identityReliable:true,title:title(row),url:safeUrl(location.href),unread:unread(row),active:true,orderReliable:parsed.reliable,historyStable:stable,readComplete,tailKnown,messages:parsed.messages,needsRead:!tailKnown,detail:historyDetail('1688',stable,parsed,history)};
    }
    const root=history.closest(ROOT)||history,id=identity(root,count===1)||identity(history,count===1);
    if(!id)return null;
    const parsed=readMessages(history),tailKnown=atTail(history);
    return {id,identityReliable:provenAccount(root),title:title(root),url:safeUrl(location.href),unread:unread(root),active:true,orderReliable:parsed.reliable,tailKnown,messages:parsed.messages,needsRead:!tailKnown,detail:!provenAccount(root)?'Аккаунт покупателя не подтверждён; подготовка ответа заблокирована.':!parsed.reliable?'Порядок или содержимое сообщений неоднозначны.':!tailKnown?'Последние сообщения ещё не загружены или история прокручена вверх.':''};
  }
  function frames() {return [...document.querySelectorAll('iframe[src],frame[src]')].slice(0,100).map(frame=>({url:safeUrl(frame.src)?frame.src:'',visible:visible(frame)})).filter(frame=>frame.url);}
  function snapshot() {
    selectionRows=new Map();
    const result={platform:platform(),status:'unsupported',url:location.href,detail:'На странице не распознана история с устойчивым идентификатором диалога.',frames:frames(),documentToken:DOCUMENT_TOKEN,busy:busy(),conversations:[]};
    if(!result.platform){result.detail='Эта площадка не поддерживается.';return result;}
    try {
      if(select(document,'#nc_1_wrapper,.nc-container,.geetest_panel,[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i],iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],iframe[src*="_____tmd_____/punish"],#baxia-dialog-content').length){result.status='captcha';result.detail='Видна проверка CAPTCHA; мониторинг ничего не нажимает.';return result;}
      if(select(document,'input[type="password"],[data-login-required="true"],.login-panel').length||/\/(?:login|signin)(?:[/.?]|$)/i.test(location.pathname+location.hash)){
        if(!loginObserved){micEpoch=crypto.randomUUID();rowTokens=new WeakMap();usedTokens.clear();active1688Evidence=null;activeAlibabaEvidence=null;activeMicEvidence=null;pendingReveal=null;}loginObserved=true;
        result.status='login';result.detail='Нужен вход в аккаунт этой площадки.';return result;
      }
      loginObserved=false;
      if(document.readyState!=='complete'){result.status='loading';result.detail='Страница ещё загружается.';return result;}
      const histories=select(document,HISTORY).filter(node=>!node.closest(ITEM)&&!node.closest(EXCLUDED));
      const leafHistories=histories.filter(node=>!histories.some(other=>other!==node&&node.contains(other)));
      const conversations=leafHistories.map(history=>readHistory(history,leafHistories.length)).filter(Boolean);
      const byId=new Map();
      for(const entry of conversations){if(byId.has(entry.id)){const other=byId.get(entry.id);other.orderReliable=false;other.tailKnown=false;other.readComplete=false;other.detail='Найдено несколько историй одного диалога; нужно уточнить структуру страницы.';}else byId.set(entry.id,entry);}
      for(const item of select(document,ITEM).slice(0,LIMIT.conversations)){
        const id=identity(item);if(!id)continue;
        const previewNode=select(item,'[data-message-preview],.message-preview,.conversation-preview,.last-message'+(platform()==='1688'&&item.matches(INBOX_1688)?',.conversation-secondary-line > .desc':platform()==='alibaba'&&item.matches(INBOX_ALIBABA)?',.msg-wrapper .latest-msg > div':platform()==='mic'&&item.matches(INBOX_MIC)?',.rg-last-msg .last-msg':''))[0];const preview=textOf(previewNode,LIMIT.text,true);
        const existing=byId.get(id);if(existing){if(unread(item)!==null)existing.unread=unread(item);if(!existing.title)existing.title=title(item);if(preview)existing.preview=preview;continue;}
        byId.set(id,{id,identityReliable:provenAccount(item),title:title(item),url:safeUrl(item.matches('a[href]')?item.href:select(item,'a[href]')[0]?.href||location.href),unread:unread(item),active:item.matches(INBOX)&&rowActive(item),orderReliable:false,tailKnown:false,preview,needsRead:true,messages:[],...selectable(item,id)});
      }
      result.conversations=[...byId.values()].slice(0,LIMIT.conversations);
      if(result.conversations.length){result.status='ready';result.detail=result.conversations.some(item=>item.active)?'Прочитаны доступные сообщения. Предпросмотры других диалогов требуют открытия пользователем.':'Доступен только список диалогов. Откройте нужную переписку, чтобы прочитать сообщения.';}
      else if(select(document,PENDING+(platform()==='mic'?',.conversation-lst .ant-skeleton-active':'')).length){result.status='loading';result.detail='История чата ещё загружается.';}
      else if(result.frames.some(frame=>frame.visible)){result.detail='Чат может находиться во вложенном фрейме; требуется отдельное чтение фрейма.';}
      return result;
    } catch {return {...result,status:'error',detail:'Не удалось прочитать структуру чата. Отправка и ввод не выполнялись.',conversations:[]};}
  }
  function openConversation(request) {
    if(request?.documentToken!==DOCUMENT_TOKEN||typeof request.selectionToken!=='string'||typeof request.conversationId!=='string')return {ok:false,detail:'Документ или разрешение выбора устарели.'};
    const current=snapshot();
    if(current.status!=='ready')return {ok:false,detail:current.detail};
    if(Object.values(current.busy).some(Boolean))return {ok:false,busy:true,detail:'Открыт черновик или пользователь работает в чате.'};
    const selected=selectionRows.get(request.selectionToken);
    const matches=current.conversations.filter(row=>row.id===request.conversationId&&row.selectionToken===request.selectionToken&&row.canSelect===true&&!row.active);
    if(!selected||selected.id!==request.conversationId||matches.length!==1||!visible(selected.item)||identity(selected.item)!==request.conversationId||usedTokens.has(request.selectionToken))return {ok:false,detail:'Строка диалога изменилась или неоднозначна.'};
    const peers=select(document,INBOX).filter(row=>identity(row)===request.conversationId);
    if(peers.length!==1||peers[0]!==selected.item)return {ok:false,detail:'Найдено несколько строк одного диалога.'};
    usedTokens.add(request.selectionToken);selectionRows.delete(request.selectionToken);
    selected.item.click();
    pendingReveal=['alibaba','1688'].includes(platform())?{platform:platform(),id:request.conversationId,documentToken:DOCUMENT_TOKEN,at:Date.now()}:null;
    return {ok:true,openedId:request.conversationId};
  }
  function revealLatest(request) {
    const site=platform();
    if(!['alibaba','1688'].includes(site)||!pendingReveal||pendingReveal.platform!==site||request?.documentToken!==DOCUMENT_TOKEN||request.conversationId!==pendingReveal.id||Date.now()-pendingReveal.at>120000)return {ok:false,detail:'Нет актуального разрешения дочитать открытый диалог.'};
    const current=snapshot();
    if(current.status!=='ready')return {ok:false,detail:current.detail};
    if(Object.values(current.busy).some(Boolean))return {ok:false,busy:true,detail:'Пользователь работает в чате или есть черновик.'};
    const active=current.conversations.filter(row=>row.active&&row.id===request.conversationId&&row.identityReliable);
    const evidence=site==='alibaba'?activeAlibabaEvidence:active1688Evidence;
    if(active.length!==1||!active[0].messages.length||!evidence||Date.now()-evidence.since<1000)return {ok:false,detail:'История выбранного диалога ещё не подтверждена.'};
    const histories=select(document,site==='alibaba'?'.buyer-messenger-container .message-box .im-message-flow .scroll-box':'.ww_box .ww_message .message-list .rc-scrollbars-view');
    const scroller=histories.length===1?(site==='alibaba'?histories[0].closest('.common-load-more'):histories[0]):null;
    if(!scroller||!visible(scroller)||(site==='alibaba'&&!scroller.closest('.buyer-messenger-container .message-box .im-message-flow')))return {ok:false,detail:`Контейнер прокрутки ${site==='1688'?'1688':'Alibaba'} не подтверждён.`};
    pendingReveal=null;
    scroller.scrollTop=scroller.scrollHeight;
    return {ok:true,revealedId:request.conversationId};
  }
  for(const type of ['keydown','pointerdown','input','wheel','touchstart'])document.addEventListener(type,event=>{if(event.isTrusted){lastTrustedInput=Date.now();pendingReveal=null;}},{capture:true,passive:true});
  globalThis.OpenLinksDialogsReader=Object.freeze({snapshot,openConversation,revealLatest});
  globalThis.chrome?.runtime?.onMessage?.addListener((message,sender,respond)=>{
    if(!['DIALOGS_SNAPSHOT','DIALOGS_OPEN_CONVERSATION','DIALOGS_REVEAL_LATEST'].includes(message?.type))return;
    if(sender?.id!==chrome.runtime.id){respond({status:'error',detail:'Источник запроса не подтверждён.'});return;}
    respond(message.type==='DIALOGS_SNAPSHOT'?snapshot():message.type==='DIALOGS_OPEN_CONVERSATION'?openConversation(message):revealLatest(message));
  });
})();
