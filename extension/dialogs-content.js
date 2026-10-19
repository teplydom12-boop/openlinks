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
  let modelRequest=null,modelAttempt='',modelAccepted={threadId:'',rows:new Map()};
  let historyModelRequest=null,historyModelAttempt={fingerprint:'',at:0};
  const historyBoundaryProofs=new Map();
  const historyModelTimes=new Map();
  // Opaque tokens bind a reply to the exact current document and transcript.
  // They change on any message/attachment/evidence change, never persist across
  // navigation, and are checked synchronously immediately before editing/clicking.
  let replyEvidence=new Map();
  const historyLoads=new Map();
  const firstBuyerProofs=new Map();
  const latestMessageTimes=new Map();
  const HISTORY_LOAD_LIMIT=8;
  let inboxTraversal={token:'',signature:'',progressSignature:'',progressToken:'',steps:0,stalledAttempts:0,scroller:null};
  let inboxModelRequest=null,inboxModelAccepted=null,inboxModelAttempt={fingerprint:'',at:0,count:0};
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
  function rowSignature(node,max=100000){const text=node.outerHTML;if(text.length>max)return '';let a=2166136261,b=2246822507;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),3266489909);}return `${(a>>>0).toString(16)}${(b>>>0).toString(16)}:${text.length}`;}
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
  function micEmotion(node){
    if(!node?.matches('img.chat-text-sys-emotion')||!/^\[[^\[\]\u0000-\u001f]{1,64}\]$/.test(node.getAttribute('title')||''))return false;
    try{const url=new URL(node.src);return url.protocol==='https:'&&url.hostname==='webim.made-in-china.com'&&/^\/super-tm\/[a-f\d]{32}\.gif$/i.test(url.pathname)&&!url.search&&!url.hash&&!url.username&&!url.password;}catch{return false;}
  }
  function textOf(node,max=LIMIT.text,allowPreview=false,withMicEmotions=false) {
    if(!node)return '';
    const walker=document.createTreeWalker(node,withMicEmotions?NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT:NodeFilter.SHOW_TEXT);const parts=[];let cursor;
    while((cursor=walker.nextNode())){
      if(parts.length>=LIMIT.nodes)break;
      const element=cursor.nodeType===Node.ELEMENT_NODE,parent=element?cursor:cursor.parentElement;
      const excluded=parent?.closest(EXCLUDED);
      if((excluded&&(!allowPreview||excluded!==node))||!visible(parent))continue;
      if(element){if(micEmotion(cursor))parts.push(cursor.getAttribute('title'));continue;}
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
  // Native inbox labels are relative to the browser's local calendar. Never
  // replace a missing platform date with the time at which we observed it.
  // Day-only labels are useful diagnostics, but cannot prove a rolling 24h age.
  function nativeTimestamp(raw,{relative=false,now=Date.now()}={}) {
    raw=clean(raw,100).replace(/\u00a0/g,' ').replace(/\s+/g,' ');
    const finish=(at,precision='minute')=>Number.isFinite(at)&&at>0&&at<=now+300000?{at,reliable:!['day','yearless'].includes(precision),precision}:null;
    if(/^\d{10}(?:\d{3})?$/.test(raw))return finish(Number(raw)*(raw.length===10?1000:1),'millisecond');
    const local=(year,month,day,hour=0,minute=0,second=0,millisecond=0)=>{
      const value=new Date(year,month-1,day,hour,minute,second,millisecond);
      return value.getFullYear()===year&&value.getMonth()===month-1&&value.getDate()===day&&value.getHours()===hour&&value.getMinutes()===minute&&value.getSeconds()===second?value.getTime():NaN;
    };
    let match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(raw);
    if(match){
      const [,y,m,d,h,mi,s='0',ms='0',zone]=match,parts=[y,m,d,h,mi,s].map(Number),utc=new Date(Date.UTC(parts[0],parts[1]-1,parts[2],parts[3],parts[4],parts[5],Number(ms.padEnd(3,'0'))));
      if(utc.getUTCFullYear()!==parts[0]||utc.getUTCMonth()!==parts[1]-1||utc.getUTCDate()!==parts[2]||utc.getUTCHours()!==parts[3]||utc.getUTCMinutes()!==parts[4]||utc.getUTCSeconds()!==parts[5])return null;
      const offset=zone.toUpperCase()==='Z'?null:/^([+-])(\d{2}):?(\d{2})$/.exec(zone);
      if(offset&&(Number(offset[2])>23||Number(offset[3])>59))return null;
      return finish(utc.getTime()-(offset?(offset[1]==='+'?1:-1)*(Number(offset[2])*60+Number(offset[3]))*60000:0),'second');
    }
    match=/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
    if(match)return finish(local(Number(match[1]),Number(match[2]),Number(match[3]),Number(match[4]||0),Number(match[5]||0),Number(match[6]||0)),match[4]?'minute':'day');
    if(!relative)return null;
    const today=new Date(now);
    match=/^(?:(今天|今日|today|昨天|昨日|yesterday)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/i.exec(raw);
    if(match){
      const day=new Date(today.getFullYear(),today.getMonth(),today.getDate()-( /^(昨天|昨日|yesterday)$/i.test(match[1]||'')?1:0));
      return finish(local(day.getFullYear(),day.getMonth()+1,day.getDate(),Number(match[2]),Number(match[3]),Number(match[4]||0)));
    }
    if(/^(今天|今日|today|昨天|昨日|yesterday)$/i.test(raw)){
      const day=new Date(today.getFullYear(),today.getMonth(),today.getDate()-( /^(昨天|昨日|yesterday)$/i.test(raw)?1:0));
      return finish(day.getTime(),'day');
    }
    match=/^(\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
    if(match){
      let year=today.getFullYear(),at=local(year,Number(match[1]),Number(match[2]),Number(match[3]||0),Number(match[4]||0),Number(match[5]||0));
      if(at>now+300000)at=local(--year,Number(match[1]),Number(match[2]),Number(match[3]||0),Number(match[4]||0),Number(match[5]||0));
      // A repeated calendar date from a previous year is indistinguishable
      // from a recent chat here. Retain the label as a hint, never as age proof.
      return finish(at,'yearless');
    }
    return null;
  }
  function timestamp(node) {
    const raw=node.getAttribute('data-timestamp')||node.querySelector('time[datetime]')?.getAttribute('datetime');
    if(raw)return nativeTimestamp(raw)?.at??null;
    // Chat bubbles often show just HH:mm on old days; it must never be assumed
    // to mean today. Only a complete native bubble date is accepted here.
    const selector=platform()==='1688'?'.first-line > .time':platform()==='mic'?':scope > .chatTime':platform()==='alibaba'?'.item-base-info > span:not(.name)':null;
    const labels=selector?select(node,selector):[];
    if(labels.length!==1)return null;
    const label=clean(labels[0].getAttribute('title')||labels[0].textContent,100);
    const parsed=nativeTimestamp(label,{relative:/^\d{1,2}[-/月]\d{1,2}/.test(label)});
    return parsed?.reliable?parsed.at:null;
  }
  function latestRowTime(row) {
    const result=(value,source)=>value?{latestMessageAt:value.at,latestMessageAtReliable:value.reliable,latestMessageAtSource:source,latestMessageAtPrecision:value.precision}:null;
    // Alibaba data-modify-time is a conversation modification time; live model
    // evidence does not identify it as the newest message timestamp. It stays
    // in the row-version token only and cannot authorize the 24-hour window.
    const explicit=row.getAttribute('data-last-message-at');
    // Invalid explicit metadata must not be silently downgraded to a plausible
    // label (for example a future server timestamp next to an old HH:mm).
    if(explicit)return result(nativeTimestamp(explicit),'data-last-message-at')||{latestMessageAt:null,latestMessageAtReliable:false,latestMessageAtSource:'invalid-native-time'};
    const selector=row.matches(INBOX_1688)?'.content > .conversation > .time':row.matches(INBOX_ALIBABA)?'.contact-info > .contact-time':row.matches(INBOX_MIC)?'.record-chatInfo-right > .record-time':'time[datetime],[data-last-message-time]';
    const labels=select(row,selector);if(labels.length!==1)return null;
    const label=labels[0],raw=label.getAttribute('datetime')||label.getAttribute('data-timestamp')||label.getAttribute('title')||label.textContent;
    return result(nativeTimestamp(raw,{relative:true}),'native-inbox-time');
  }
  function messageNodes(history,live1688=false) {
    const found=select(history,MESSAGE).filter(node=>!node.closest(ITEM)&&!node.closest(EXCLUDED));
    if(live1688)for(const row of select(history,'.message-item-line'))if(!row.closest(EXCLUDED)&&!found.some(node=>row.contains(node)||node.contains(row)))found.push(row);
    return found.filter(node=>!found.some(other=>other!==node&&other.contains(node))).sort((a,b)=>a===b?0:a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
  }
  function known1688Survey(node) {
    if(!node.matches('.rc-scrollbars-view > .message-item-line')||node.querySelector('.message-item,.message-item-system,.nick,.content-row'))return false;
    const cards=node.querySelectorAll('.im-template-msg.dx-msg-wrap'),card=cards[0];
    if(!card||cards.length!==1||card.querySelectorAll('.tpl-wrapper > .FrameLayout_0 > .FrameLayout_56 > .LinearLayout_57 > .LinearLayout_58 > .LinearLayout_60 > .list-item').length!==5)return false;
    const expected=['期待您的真实反馈','很不满','不满','一般','满意','很满意'];
    const labels=select(card,'.FastTextView_59 > span,.FastTextView_63 > span').map(label=>textOf(label));
    if(select(node,'video,audio,canvas,iframe').length||select(node,'img').some(image=>!image.matches('.LinearLayout_60 > .list-item > .LinearLayout_61 > .ImageView_62 > div > img')))return false;
    return JSON.stringify(labels)===JSON.stringify(expected)&&textOf(node)===expected.join(' ');
  }
  function self1688Message(node){
    return node?.matches('.message-item.self')&&!node.closest(EXCLUDED)&&select(node,':scope > .item.self').length===1&&select(node,':scope > .item.self > div > .first-line.self').filter(header=>!header.closest(EXCLUDED)).length===1;
  }
  function pending1688Format(node){return node.matches('.rc-scrollbars-view > .message-item-line')&&!node.querySelector('.message-item,.message-item-system,img,video,audio')&&node.querySelectorAll(':scope > div > span').length===1&&textOf(node)==='暂不支持的消息类型';}
  function attachmentUrl(value) {
    try {const url=new URL(value,location.href);return value&&url.protocol==='https:'&&!url.username&&!url.password&&url.href.length<=4096?url.href:'';}catch{return '';}
  }
  function attachmentsOf(body,survey=false,ignored='',ignoreMedia=null) {
    if(survey)return [];
    const candidates=selector=>select(body,selector).filter(node=>!ignored||!node.closest(ignored));
    const attachments=[],seen=new Set(),add=(type,node,name='',url='',text='')=>{
      const item={type,name:clean(name,300),url:attachmentUrl(url),text:clean(text,1000),contentRead:false};
      const key=JSON.stringify(item);if(seen.has(key))return;if(attachments.length>=30){attachments.limited=true;return;}seen.add(key);attachments.push(item);
    };
    const files=candidates('.file-msg,[data-attachment],a[download]');
    for(const file of files){
      const nameNode=select(file,'.file-name,[data-file-name]')[0],link=file.matches('a[href]')?file:select(file,'a[href]')[0];
      add('file',file,nameNode?.getAttribute('title')||textOf(nameNode)||file.getAttribute('data-file-name')||file.getAttribute('download')||file.getAttribute('title')||'Файл',link?.href||'',textOf(select(file,'.file-size')[0]));
    }
    for(const media of candidates('img,video,audio,canvas,iframe')){
      if(ignoreMedia?.(media))continue;
      if(files.some(file=>file.contains(media)))continue;
      const type={IMG:'image',VIDEO:'video',AUDIO:'audio'}[media.tagName]||'unknown';
      add(type,media,media.getAttribute('alt')||media.getAttribute('title')||'',media.currentSrc||media.src||media.querySelector('source[src]')?.src||'');
    }
    for(const link of candidates('a[href]')){
      if(files.some(file=>file===link||file.contains(link))||link.querySelector('img,video,audio'))continue;
      const url=attachmentUrl(link.href);if(url)add('link',link,textOf(link),url);
    }
    return attachments;
  }
  function readMessages(history,live1688=null,liveAlibaba=false,liveMic=null) {
    const nodes=messageNodes(history,Boolean(live1688));let reliable=true,structuralReliable=true,unsupportedMedia=false,reason='',unsupportedMessages=0,unmatchedTextNodes=0,systemNotices=0,contentLimited=false;const result=[],records=[],ids=new Map();
    const modelSignatures=new Map(),modelSignatureCounts=new Map();
    if(live1688&&modelAccepted.threadId===live1688.id)for(const row of select(history,'.rc-scrollbars-view > .message-item-line')){const signature=rowSignature(row);modelSignatures.set(row,signature);modelSignatureCounts.set(signature,(modelSignatureCounts.get(signature)||0)+1);}
    if(nodes.length>LIMIT.messages){reliable=false;structuralReliable=false;reason='История превышает предел 500 сообщений.';}
    for(const node of nodes.slice(-LIMIT.messages)){
      const aliNotice=liveAlibaba&&node.querySelector(':scope > .item-content-wrap > .item-system-notice');
      const aliBody=liveAlibaba?select(node,'.user-content .session-rich-content,.session-security-text'+(aliNotice?',:scope > .item-content-wrap > .item-system-notice .notice-content':''))[0]:null;
      const micAssignment=liveMic&&node.querySelector(':scope > .msg-system-box > .msg-inquiry-assign.iAmBuyer');
      const micSystem=liveMic&&(node.matches('.msg-list-system-tip,.chat-safe-tip-container')||micAssignment&&!node.querySelector(':scope > .contact-chatInfo,:scope > .mine-chatInfo'));
      const micBody=liveMic?(micSystem?micAssignment||node:select(node,'.chat-content .chat-txt .msg-text')[0]):null;
      const body=(live1688?select(node,'.content-row > .content')[0]:aliBody||micBody)||(liveAlibaba?select(node,'.user-content')[0]:liveMic?select(node,'.chat-content')[0]:null)||select(node,CONTENT).find(child=>!child.closest(EXCLUDED))||node;
      const survey=Boolean(live1688)&&known1688Survey(node);
      let kind=direction(node);
      if(live1688&&(node.matches('.message-item-system')||survey))kind='system';
      else if(live1688&&kind==='unknown'&&!node.hasAttribute('data-direction')&&!node.hasAttribute('data-message-direction')){
        if(self1688Message(node))kind='outbound';
        else if(node.matches('.message-item:not(.self)')&&select(node,':scope > .item:not(.self)').length===1&&select(node,'.first-line:not(.self)').length===1){
          const avatar=select(node,':scope > .item > .headPic')[0],peerAvatar=select(live1688,'.avatar > .avatar-img')[0];
          const name=textOf(select(node,'.first-line > .nick')[0]),peerName=textOf(select(live1688,'.content > .conversation > .name')[0]);
          if(avatar?.src&&peerAvatar?.src&&avatar.src===peerAvatar.src&&name&&name===peerName)kind='inbound';
        }
      }
      if(liveAlibaba){
        if(node.querySelector(':scope > .session-security-content')||aliNotice&&!node.querySelector(':scope > .item-content-left,:scope > .item-content-right'))kind='system';
        else {
          const send=node.querySelector(':scope > .item-content-right > .message-flow-menu-box.send:not(.rec)'),receive=node.querySelector(':scope > .item-content-left > .message-flow-menu-box.rec:not(.send)');
          kind=send&&!receive&&node.classList.contains('item-right')?'outbound':receive&&!send&&node.classList.contains('item-left-text')?'inbound':'unknown';
        }
        if(!aliBody){reliable=false;unsupportedMedia=true;}
      }
      if(liveMic){
        kind=micSystem?'system':'unknown';
        const contact=node.querySelector(':scope > .contact-chatInfo'),mine=node.querySelector(':scope > .mine-chatInfo'),avatar=contact?.querySelector('.avatar img'),peerAvatar=liveMic.querySelector('.item-lf .avatar img');
        const name=contact?textOf(select(contact,'.fromUserName')[0]):'',peerName=title(liveMic);
        if(!micSystem&&mine&&!contact&&!mine.classList.contains('contact-chatInfo'))kind='outbound';
        else if(!micSystem&&contact&&!mine&&!contact.classList.contains('mine-chatInfo')&&avatar?.src&&peerAvatar?.src&&avatar.src===peerAvatar.src&&name&&name===peerName)kind='inbound';
        if(!micBody){reliable=false;unsupportedMedia=true;}
      }
      let full=textOf(body,LIMIT.text+1,false,Boolean(liveMic));
      const attachmentScope=liveMic?select(node,'.chat-content')[0]||body:liveAlibaba?select(node,'.user-content')[0]||body:live1688?body:node;
      const attachments=attachmentsOf(attachmentScope,survey,liveAlibaba?'.session-translate':'',liveMic?micEmotion:null),unreadMedia=attachments.filter(item=>item.type!=='link');
      if(attachments.limited){contentLimited=true;reliable=false;reason||='Список вложений сообщения ограничен 30 элементами.';}
      const unknownFormat=Boolean(live1688&&node.matches('.message-item-line')&&!survey||liveAlibaba&&!aliBody||liveMic&&!micBody);
      if(unknownFormat){unsupportedMessages++;reliable=false;reason||='Сохранён текст сообщения с нераспознанным форматом.';}
      if(unreadMedia.length||unknownFormat){
        unsupportedMedia=true;
        const label=unreadMedia[0]?.type==='file'?`[Файл: ${unreadMedia[0].name||'без названия'}; содержимое не прочитано]`:unreadMedia.length?'[Вложение: содержимое не прочитано]':'[Нераспознанный формат сообщения; доступный текст сохранён]';
        full=(full?`${full} `:'')+label;
      }
      const modelRow=live1688&&node.closest('.message-item-line'),modelSignature=modelSignatures.get(modelRow);
      let accepted=modelRow&&modelSignature&&modelSignatureCounts.get(modelSignature)===1&&modelAccepted.threadId===live1688.id?modelAccepted.rows.get(modelSignature):null;
      if(accepted){
        const signals=node.hasAttribute('data-direction')||node.hasAttribute('data-message-direction')||node.hasAttribute('data-sender-role')||[...node.classList].some(cls=>Object.hasOwn(DIRECTION_CLASSES,cls));
        if(kind==='system')accepted=null;
        else if(kind!=='unknown'&&kind!==accepted.direction||kind==='unknown'&&signals){kind='unknown';accepted=null;reliable=false;structuralReliable=false;reason||='Направление сообщения в модели противоречит DOM; нужна проверка.';}
        else kind=accepted.direction;
      }
      const micId=liveMic?node.querySelector(':scope > .contact-chatInfo[id],:scope > .mine-chatInfo[id]')?.id:'',id=identifier(node.getAttribute('data-message-id'))||identifier(node.getAttribute('data-msg-id'))||(accepted?accepted.id:'')||(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(micId||'')?micId:'');
      if(!full){reliable=false;unsupportedMessages++;full='[Сообщение без доступного текста]';reason||='Есть сообщение без доступного текста.';}
      if(full.length>LIMIT.text){reliable=false;contentLimited=true;reason||='Слишком длинный текст сообщения обрезан.';}
      const entry={direction:kind,text:full.slice(0,LIMIT.text)};if(attachments.length)entry.attachments=attachments;if(unknownFormat)entry.format='unrecognized';if(id)entry.id=id;const at=timestamp(node);if(at!==null)entry.at=at;
      const aliases=[],alias=(text,direction,kind,ignoredAttachments=[])=>{if(text&&text.length<=6000&&aliases.length<4&&!aliases.some(value=>value.text===text&&value.direction===direction)){const value={text,direction,kind};if(ignoredAttachments.length)value.ignoredAttachments=ignoredAttachments.slice(0,4);aliases.push(value);}};
      const iconProof=icons=>[...new Map(icons.map(icon=>{const value={type:'image',name:clean(icon.getAttribute('alt')||icon.getAttribute('title')||'',300),url:attachmentUrl(icon.currentSrc||icon.src||'')};return [JSON.stringify(value),value];})).values()].filter(value=>value.url).slice(0,4);
      const oldMarker='[Вложение: содержимое не прочитано]',oldFormat='[Нераспознанный формат сообщения; доступный текст сохранён]';
      const translationIcons=liveAlibaba?select(node,'.user-content .session-translate img.translate-icon-small').filter(icon=>!icon.closest('.translate-result.hide')):[];
      if(liveAlibaba&&!unknownFormat&&!unreadMedia.length&&['inbound','outbound'].includes(kind)&&translationIcons.length){alias(textOf(body)+' '+oldMarker,kind,'platform-ui',iconProof(translationIcons));alias(oldMarker,'unknown','reader-placeholder');}
      if(liveAlibaba&&aliNotice&&kind==='system'||liveMic&&micAssignment&&micSystem)alias(textOf(node)+' '+oldFormat,'unknown','platform-ui');
      const emotions=liveMic?select(body,'img.chat-text-sys-emotion').filter(micEmotion):[];
      if(liveMic&&!unknownFormat&&!unreadMedia.length&&emotions.length){const previous=textOf(body),proof=iconProof(emotions);alias((previous?previous+' ':'')+oldMarker,kind,'platform-ui',proof);alias((previous?previous+' ':'')+oldMarker,'unknown','platform-ui',proof);}
      if(live1688&&select(body,'.file-msg').length&&attachments.some(value=>value.type==='file'))alias(`[Файл: ${textOf(select(body,'.file-name')[0])||'без названия'}; содержимое не прочитано]`,'unknown','reader-placeholder');
      if(survey){alias(textOf(node)+' '+oldFormat,'unknown','platform-ui');alias('暂不支持的消息类型 '+oldFormat,'unknown','platform-ui');}
      if(accepted&&id===accepted.id&&kind===accepted.direction){alias(entry.text,'unknown','model-direction');alias(entry.text,kind,'model-direction');}
      if(aliases.length)entry.legacyAliases=aliases;
      if(id&&ids.has(id)){const prior=ids.get(id);if(JSON.stringify(prior)!==JSON.stringify(entry)){reliable=false;structuralReliable=false;reason||='Один идентификатор относится к разным сообщениям.';}continue;}
      if(id)ids.set(id,entry);result.push(entry);records.push({node,entry});
      if(liveMic)for(const notice of select(node,':scope > .msg-system,:scope > .diversion-enhanced-reminder')){
        const text=textOf(notice);if(!text)continue;systemNotices++;
        const system={direction:'system',text};if(id)system.id=id+':'+notice.classList[0];result.push(system);records.push({node:notice,entry:system});
      }
    }
    // A partly matched layout must not expose an older recognized message as
    // the actual newest message. Unknown text/media inside history blocks it.
    const walker=document.createTreeWalker(history,NodeFilter.SHOW_TEXT);let leaf;
    while((leaf=walker.nextNode())){
      const parent=leaf.parentElement;
      if(live1688&&parent.matches('.ww_message .message-list .rc-scrollbars-view > div:first-child > span')&&!parent.closest('.message-item-line')&&clean(parent.textContent)==='暂无更多消息')continue;
      if(clean(leaf.textContent)&&visible(parent)&&!parent.closest(EXCLUDED)&&!nodes.some(node=>node.contains(parent))){
        reliable=false;structuralReliable=false;unmatchedTextNodes++;reason||=`Не распознан элемент истории (${parent.tagName.toLowerCase()}${parent.classList.length?'.'+[...parent.classList].slice(0,2).join('.'):''}); его текст сохранён отдельно.`;
        if(result.length<LIMIT.messages){const entry={direction:'unknown',text:clean(leaf.textContent),format:'unrecognized'};result.push(entry);records.push({node:parent,entry});}
        if(unmatchedTextNodes>=LIMIT.nodes)break;
      }
    }
    const orphanMedia=select(history,'img,video,audio,[data-attachment]').filter(media=>!media.closest(EXCLUDED)&&!nodes.some(node=>node.contains(media)));
    if(orphanMedia.length){
      reliable=false;structuralReliable=false;unsupportedMedia=true;reason||='В истории есть вложение вне распознанных сообщений; ссылка сохранена отдельно.';
      for(const media of orphanMedia.slice(0,30))if(result.length<LIMIT.messages){
        const type={IMG:'image',VIDEO:'video',AUDIO:'audio'}[media.tagName]||'unknown';
        const entry={direction:'unknown',text:'[Вложение вне распознанного сообщения; содержимое не прочитано]',format:'unrecognized',attachments:[{type,name:clean(media.getAttribute('alt')||media.getAttribute('title'),300),url:attachmentUrl(media.currentSrc||media.src||''),text:'',contentRead:false}]};
        result.push(entry);records.push({node:media,entry});unsupportedMessages++;
      }
    }
    if(unmatchedTextNodes||orphanMedia.length){records.sort((a,b)=>a.node===b.node?0:a.node.compareDocumentPosition(b.node)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);result.splice(0,result.length,...records.map(record=>record.entry));}
    // Reverse flex/order/positioned virtual rows cannot imply chronological order.
    const style=getComputedStyle(history);
    if((style.flexDirection==='column-reverse'||style.flexDirection==='row-reverse')&&style.display.includes('flex')){
      if(liveAlibaba&&style.flexDirection==='column-reverse'){
        const tops=nodes.map(node=>node.getBoundingClientRect().top);
        if(tops.every((top,index)=>index===0||top<tops[index-1]))result.reverse();
        else {reliable=false;structuralReliable=false;reason||='Обратный порядок Alibaba не подтверждён расположением строк.';}
      }else {reliable=false;structuralReliable=false;reason||='История отображается в обратном CSS-порядке.';}
    }
    for(const node of nodes){const style=getComputedStyle(node);if(Number(style.order)!==0||['absolute','fixed'].includes(style.position)){reliable=false;structuralReliable=false;reason||='Порядок виртуальных или перемещённых строк истории не подтверждён.';}}
    if(result.length>LIMIT.messages){result.splice(0,result.length-LIMIT.messages);contentLimited=true;reliable=false;structuralReliable=false;reason||='История превышает предел 500 сообщений.';}
    const attachments=result.flatMap(message=>message.attachments||[]);
    const totalRows=nodes.length+systemNotices+unmatchedTextNodes+orphanMedia.length;
    const coverage={totalRows,capturedMessages:result.length,unknownSenders:result.filter(message=>message.direction==='unknown').length,attachments:attachments.length,unreadAttachments:attachments.filter(item=>item.type!=='link'&&!item.contentRead).length,unsupportedMessages:unsupportedMessages+unmatchedTextNodes,unmatchedTextNodes,limited:contentLimited||totalRows>LIMIT.messages||unmatchedTextNodes>=LIMIT.nodes||orphanMedia.length>30};
    return {messages:result,reliable,structuralReliable:structuralReliable&&!coverage.limited,unsupportedMedia,reason,coverage,pendingFormat:Boolean(live1688)&&nodes.some(pending1688Format)};
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
  // A stable latest page is not proof that older messages were loaded. 1688
  // exposes a native boundary; the other adapters require separately verified
  // native model evidence tied to this exact history, never just scrollTop=0.
  function historyStartKnown(history) {
    if(['alibaba','mic'].includes(platform())){const context=historyModelContext();return Boolean(context&&context.history===history&&historyBoundaryProofs.get(context.id)===context.signature);}
    if(platform()!=='1688'||!history.matches('.ww_box .ww_message .message-list'))return false;
    const viewers=select(history,'.rc-scrollbars-view');
    if(viewers.length!==1)return false;
    const markers=select(viewers[0],':scope > div:first-child > span');
    return markers.length===1&&!markers[0].closest(MESSAGE+','+EXCLUDED)&&textOf(markers[0])==='暂无更多消息';
  }
  function wholeHistory(startKnown,readComplete,parsed,history) {
    if(!startKnown||!readComplete||!parsed.reliable||!parsed.structuralReliable||parsed.coverage.limited||parsed.coverage.unknownSenders||parsed.coverage.unreadAttachments||parsed.coverage.unsupportedMessages)return false;
    // Lower-level selectors/text readers have a DOM traversal bound. Do not
    // promote a truncated traversal to proof of absence in the whole history.
    const walker=document.createTreeWalker(history,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);let count=0;
    while(walker.nextNode())if(++count>LIMIT.nodes)return false;
    return true;
  }
  function workflowEvidence(entry) {
    const messages=entry.messages||[],last=messages.filter(message=>message.direction!=='system').at(-1);
    const context=historyModelContext(),model=historyModelTimes.get(entry.id),nativeModelTime=context?.id===entry.id&&context.signature===model?.signature&&last?.id===model?.messageId?nativeTimestamp(String(model.at)):null;
    const latest=nativeModelTime||(entry.historyTailKnown===true&&entry.historyOrderReliable===true&&last?.at?nativeTimestamp(String(last.at)):null);
    Object.assign(entry,{latestMessageAt:latest?.at??null,latestMessageAtReliable:latest?.reliable===true,latestMessageAtSource:nativeModelTime?'native-message-model':latest?'last-native-message':'',firstBuyerMessage:null,firstBuyerMessageReliable:false});
    const previousTime=latestMessageTimes.get(entry.id);
    if(latest)latestMessageTimes.set(entry.id,{...previousTime,at:latest.at,source:'last-native-message'});
    else if(previousTime){entry.latestMessageAt=previousTime.at;entry.latestMessageAtReliable=true;entry.latestMessageAtSource='remembered-native-message';}
    let proof=firstBuyerProofs.get(entry.id);
    // A correction of an identified first message invalidates its remembered
    // text. Evidence lives only in this document/account, not in the URL.
    if(proof?.id&&messages.some(message=>message.id===proof.id&&(message.direction!=='outbound'||message.text!==proof.text))){firstBuyerProofs.delete(entry.id);proof=null;}
    if(entry.historyStartKnown&&entry.historyStable!==false){
      const first=messages.find(message=>message.direction==='outbound');
      const reliable=entry.historyOrderReliable===true&&!entry.coverage?.limited&&!entry.coverage?.unknownSenders&&first?.text&&first.format!=='unrecognized'&&!(first.attachments||[]).some(attachment=>attachment.type!=='link'&&attachment.contentRead!==true);
      if(reliable){proof={direction:'outbound',text:first.text,...(first.id?{id:first.id}:{}),...(first.at?{at:first.at}:{})};firstBuyerProofs.set(entry.id,proof);}
      else {firstBuyerProofs.delete(entry.id);proof=null;}
    }
    for(const key of [...firstBuyerProofs.keys()].slice(0,-100))firstBuyerProofs.delete(key);
    if(proof){entry.firstBuyerMessage={...proof};entry.firstBuyerMessageReliable=true;}
    const load=historyLoads.get(entry.id);
    if(load)entry.historyLoad={attempts:load.attempts,maxAttempts:HISTORY_LOAD_LIMIT,status:entry.firstBuyerMessageReliable?'complete':load.status,detail:entry.firstBuyerMessageReliable?'Первое ваше сообщение подтверждено началом истории.':load.detail};
    return entry;
  }
  function mergeRowTime(entry,row,preview) {
    const label=select(row,'.content > .conversation > .time,.contact-info > .contact-time,.record-chatInfo-right > .record-time')[0];
    const version=JSON.stringify([preview,row.getAttribute('data-modify-time'),row.getAttribute('data-lastmsg-id'),row.getAttribute('data-last-message-at'),label?.textContent||'',label?.getAttribute('title')||'']);
    let cached=latestMessageTimes.get(entry.id);
    if(cached?.rowVersion&&cached.rowVersion!==version&&entry.latestMessageAtSource==='remembered-native-message'){
      latestMessageTimes.delete(entry.id);cached=null;entry.latestMessageAt=null;entry.latestMessageAtReliable=false;entry.latestMessageAtSource='';
    }
    const rowTime=latestRowTime(row);
    if(rowTime&&!['last-native-message','native-message-model'].includes(entry.latestMessageAtSource)&&(rowTime.latestMessageAtReliable||!entry.latestMessageAtReliable))Object.assign(entry,rowTime);
    if(entry.latestMessageAtReliable){latestMessageTimes.set(entry.id,{at:entry.latestMessageAt,source:entry.latestMessageAtSource,rowVersion:version});}
    for(const key of [...latestMessageTimes.keys()].slice(0,-100))latestMessageTimes.delete(key);
  }
  function historyDetail(label,stable,parsed,history){return [!stable?`Ожидание устойчивой истории ${label}.`:'',parsed.pendingFormat?'1688 ещё отображает временную заглушку формата; ожидается повторная проверка.':'',!parsed.reliable?parsed.reason||'Порядок сообщений не подтверждён.':'',tailReason(history),parsed.unsupportedMedia?'Содержимое вложения не прочитано; подготовка ответа заблокирована.':'',parsed.messages.some(message=>message.direction==='unknown')?'Есть сообщения без подтверждённого отправителя.':''].filter(Boolean).join(' ');}
  function readHistory(history,count) {
    if(platform()==='mic'&&history.matches('.conversation-area .window-center-messages-main > .msg-list')){
      const active=select(document,INBOX_MIC).filter(row=>rowActive(row));
      if(active.length!==1||!liveThreadId(active[0])||select(document,'.conversation-area .window-center-messages-main > .msg-list').length!==1)return null;
      const row=active[0],id=identity(row),parsed=readMessages(history,null,false,row),startKnown=historyStartKnown(history),fingerprint=JSON.stringify([id,parsed.messages]);
      if(!activeMicEvidence||activeMicEvidence.fingerprint!==fingerprint)activeMicEvidence={fingerprint,since:Date.now()};
      const stable=Date.now()-activeMicEvidence.since>=1000,readComplete=stable&&atTail(history)&&!parsed.pendingFormat,tailKnown=readComplete&&!parsed.unsupportedMedia;
      return {id,identityReliable:true,title:title(row),url:safeUrl(location.href),unread:unread(row),active:true,orderReliable:parsed.reliable,historyStable:stable,readComplete,historyTailKnown:readComplete,historyOrderReliable:parsed.structuralReliable,historyStartKnown:startKnown,historyComplete:wholeHistory(startKnown,readComplete,parsed,history),tailKnown,messages:parsed.messages,coverage:parsed.coverage,needsRead:!tailKnown,detail:historyDetail('Made-in-China',stable,parsed,history)};
    }
    if(platform()==='alibaba'&&history.matches('.buyer-messenger-container .message-box .im-message-flow .scroll-box')){
      const active=select(document,INBOX_ALIBABA).filter(row=>rowActive(row));
      if(active.length!==1||!liveThreadId(active[0])||select(document,'.buyer-messenger-container .message-box .im-message-flow .scroll-box').length!==1)return null;
      const row=active[0],id=identity(row),parsed=readMessages(history,null,true),startKnown=historyStartKnown(history),fingerprint=JSON.stringify([id,parsed.messages]);
      if(!activeAlibabaEvidence||activeAlibabaEvidence.fingerprint!==fingerprint)activeAlibabaEvidence={fingerprint,since:Date.now()};
      const stable=Date.now()-activeAlibabaEvidence.since>=1000,readComplete=stable&&atTail(history)&&!parsed.pendingFormat,tailKnown=readComplete&&!parsed.unsupportedMedia;
      return {id,identityReliable:true,title:title(row),url:safeUrl(location.href),unread:unread(row),active:true,orderReliable:parsed.reliable,historyStable:stable,readComplete,historyTailKnown:readComplete,historyOrderReliable:parsed.structuralReliable,historyStartKnown:startKnown,historyComplete:wholeHistory(startKnown,readComplete,parsed,history),tailKnown,messages:parsed.messages,coverage:parsed.coverage,needsRead:!tailKnown,detail:historyDetail('Alibaba',stable,parsed,history)};
    }
    // The full 1688 inbox can retain the original touid URL while another row
    // is selected. Until its current thread is proven, that URL is not identity.
    if(platform()==='1688'&&history.closest('.ww_box')&&select(document,INBOX_1688).length){
      const active=select(document,INBOX_1688).filter(row=>row.classList.contains('active'));
      if(active.length!==1||!liveThreadId(active[0])||select(document,'.ww_box .message-list').length!==1||select(history,'.message-list-empty').length)return null;
      const row=active[0],id=identity(row),parsed=readMessages(history,row);
      const startKnown=historyStartKnown(history),fingerprint=JSON.stringify([id,parsed.messages,startKnown]);
      if(!active1688Evidence||active1688Evidence.fingerprint!==fingerprint)active1688Evidence={fingerprint,since:Date.now()};
      const stable=Date.now()-active1688Evidence.since>=1000,readComplete=stable&&atTail(history)&&!parsed.pendingFormat,tailKnown=readComplete&&!parsed.unsupportedMedia;
      return {id,identityReliable:true,title:title(row),url:safeUrl(location.href),unread:unread(row),active:true,orderReliable:parsed.reliable,historyStable:stable,readComplete,historyTailKnown:readComplete,historyOrderReliable:parsed.structuralReliable,historyStartKnown:startKnown,historyComplete:wholeHistory(startKnown,readComplete,parsed,history),tailKnown,messages:parsed.messages,coverage:parsed.coverage,needsRead:!tailKnown,detail:historyDetail('1688',stable,parsed,history)};
    }
    const root=history.closest(ROOT)||history,id=identity(root,count===1)||identity(history,count===1);
    if(!id)return null;
    const parsed=readMessages(history),tailKnown=atTail(history)&&!parsed.unsupportedMedia;
    return {id,identityReliable:provenAccount(root),title:title(root),url:safeUrl(location.href),unread:unread(root),active:true,orderReliable:parsed.reliable,historyTailKnown:atTail(history),historyOrderReliable:parsed.structuralReliable,historyStartKnown:false,historyComplete:false,tailKnown,messages:parsed.messages,coverage:parsed.coverage,needsRead:!tailKnown,detail:!provenAccount(root)?'Аккаунт покупателя не подтверждён; подготовка ответа заблокирована.':!parsed.reliable?'Порядок или содержимое сообщений неоднозначны.':!tailKnown?'Последние сообщения ещё не загружены или история прокручена вверх.':''};
  }
  function frames() {return [...document.querySelectorAll('iframe[src],frame[src]')].slice(0,100).map(frame=>({url:safeUrl(frame.src)?frame.src:'',visible:visible(frame)})).filter(frame=>frame.url);}
  function historyScroller() {
    const site=platform(),selector=site==='1688'?'.ww_box .ww_message .message-list .rc-scrollbars-view':site==='alibaba'?'.buyer-messenger-container .message-box .im-message-flow .scroll-box':site==='mic'?'.conversation-area .window-center-messages-main > .msg-list':'';
    if(!selector)return null;
    const histories=select(document,selector);if(histories.length!==1)return null;
    const history=histories[0];
    if(site==='1688')return history;
    if(site==='alibaba'){const scroller=history.closest('.common-load-more');return scroller&&visible(scroller)&&scroller.closest('.buyer-messenger-container .message-box .im-message-flow')?scroller:null;}
    // MIC's full messenger has one known history panel. An inner scrollable
    // list is preferred; never scroll the entire page or the contact sidebar.
    const container=history.parentElement;
    if(/auto|scroll/.test(getComputedStyle(history).overflowY))return history;
    return container?.matches('.window-center-messages-main')&&visible(container)?container:null;
  }
  function scrollBoundary(scroller,start) {
    const style=getComputedStyle(scroller),reverse=style.display.includes('flex')&&style.flexDirection==='column-reverse';
    return reverse?(start?-Math.max(0,scroller.scrollHeight-scroller.clientHeight):0):start?0:scroller.scrollHeight;
  }
  function inboxScroller() {
    const site=platform(),selector=site==='1688'?'.ww_conversation_list .conversation-list-scroll':site==='alibaba'?'.buyer-conversation-list .normal-list-container':site==='mic'?'.conversation-record-lst [data-test-id="virtuoso-scroller"]':'';
    const direct=selector?select(document,selector):[];
    if(direct.length===1&&/auto|scroll/.test(getComputedStyle(direct[0]).overflowY))return direct[0];
    const rows=select(document,INBOX);if(!rows.length)return null;
    const boundary=rows[0].closest(site==='1688'?'.ww_conversation_list':site==='alibaba'?'.buyer-conversation-list':'.conversation-record-lst');
    if(!boundary||!rows.every(row=>boundary.contains(row)))return null;
    const candidates=[];
    for(let node=rows[0].parentElement;node&&boundary.contains(node);node=node.parentElement){if(visible(node)&&rows.every(row=>node.contains(row))&&/auto|scroll/.test(getComputedStyle(node).overflowY))candidates.push(node);if(node===boundary)break;}
    const overflowing=candidates.filter(node=>node.scrollHeight-node.clientHeight>3);
    return overflowing.length===1?overflowing[0]:overflowing.length?null:candidates.length===1?candidates[0]:null;
  }
  function inboxModelContext() {
    if(platform()!=='1688')return null;
    const sidebars=select(document,'.ww_conversation_list'),scrollers=select(document,'.ww_conversation_list .conversation-list-scroll');
    if(sidebars.length!==1||scrollers.length!==1||!sidebars[0].contains(scrollers[0])||inboxScroller()!==scrollers[0])return null;
    const rows=select(document,INBOX_1688),scroller=scrollers[0],signature=rowSignature(sidebars[0],1000000);
    if(!signature||!rows.length||!rows.every(row=>scroller.contains(row)&&liveThreadId(row))||new Set(rows.map(row=>row.id)).size!==rows.length)return null;
    const geometry=[scroller.scrollTop,scroller.scrollHeight,scroller.clientHeight];
    return {signature,rows,scroller,geometry,fingerprint:JSON.stringify([signature,geometry])};
  }
  function acceptedInboxModel(context) {
    if(!context||inboxModelAccepted?.fingerprint!==context.fingerprint)return null;
    const atEnd=context.geometry[1]-context.geometry[2]-context.geometry[0]<=3,ttl=inboxModelAccepted.loading||atEnd&&inboxModelAccepted.hasMore?750:5000;
    return Date.now()-inboxModelAccepted.acceptedAt<ttl?inboxModelAccepted:null;
  }
  function requestInboxEvidence(result) {
    if(result.platform!=='1688'||result.status!=='ready')return;
    const context=inboxModelContext();if(!context||acceptedInboxModel(context))return;
    if(inboxModelAttempt.fingerprint===context.fingerprint&&inboxModelAttempt.count>=8&&Date.now()-inboxModelAttempt.at>=300000)inboxModelAttempt={fingerprint:context.fingerprint,at:0,count:0};
    if(inboxModelAttempt.fingerprint===context.fingerprint&&(inboxModelAttempt.count>=8||Date.now()-inboxModelAttempt.at<750))return;
    if(inboxModelRequest?.fingerprint!==context.fingerprint)inboxModelRequest={...context,token:crypto.randomUUID()};
    result.inboxEvidenceToken=inboxModelRequest.token;
  }
  function applyInboxEvidence(request) {
    if(request?.expectedDocumentToken!==DOCUMENT_TOKEN||!inboxModelRequest||request.evidenceToken!==inboxModelRequest.token)return {ok:false,detail:'Разрешение проверки списка диалогов устарело.'};
    const current=snapshot(),context=inboxModelContext(),pending=inboxModelRequest,evidence=request.evidence;
    if(current.status!=='ready'||!context||!pending||context.fingerprint!==pending.fingerprint||request.evidenceToken!==pending.token)return {ok:false,detail:'Список диалогов изменился во время проверки.'};
    inboxModelAttempt={fingerprint:context.fingerprint,at:Date.now(),count:inboxModelAttempt.fingerprint===context.fingerprint?inboxModelAttempt.count+1:1};inboxModelRequest=null;
    const invalid=()=>({ok:false,detail:'Структура или полнота списка площадки ещё не подтверждена.'});
    if(!evidence||evidence.status!=='ready'||evidence.platform!=='1688'||evidence.url!==location.href||evidence.schema!=='1688-inbox-pagination-v1'||evidence.domSignature!==context.signature||evidence.limited!==false||evidence.firstScreenRequestEnds!==true||typeof evidence.hasMore!=='boolean'||typeof evidence.loading!=='boolean'||typeof evidence.startVerified!=='boolean'||typeof evidence.endVerified!=='boolean'||!Number.isFinite(evidence.capturedAt)||Date.now()-evidence.capturedAt>5000||evidence.capturedAt-Date.now()>1000||!Number.isInteger(evidence.loadedCount)||evidence.loadedCount<1||evidence.loadedCount>10000||!Number.isInteger(evidence.itemCount)||evidence.itemCount<evidence.loadedCount||evidence.itemCount>evidence.loadedCount+1)return invalid();
    if(![evidence.scrollTop,evidence.scrollHeight,evidence.clientHeight,evidence.scrollOffset].every(Number.isFinite)||Math.abs(evidence.scrollTop-context.geometry[0])>1||evidence.scrollHeight!==context.geometry[1]||evidence.clientHeight!==context.geometry[2]||Math.abs(evidence.scrollOffset-context.geometry[0])>3||!Array.isArray(evidence.rowRanks)||evidence.rowRanks.length!==context.rows.length)return invalid();
    const ranks=new Map(),usedRanks=new Set(),visualRows=[];
    for(let index=0;index<context.rows.length;index++){
      const row=evidence.rowRanks[index];
      if(!row||row.id!==context.rows[index].id||!Number.isInteger(row.index)||row.index<0||row.index>=evidence.itemCount||usedRanks.has(row.index)||ranks.has(row.id))return invalid();
      ranks.set(row.id,row.index);usedRanks.add(row.index);visualRows.push({index:row.index,top:context.rows[index].getBoundingClientRect().top});
    }
    visualRows.sort((left,right)=>left.top-right.top);
    if(visualRows.some((row,index)=>index>0&&(row.top<=visualRows[index-1].top||row.index<=visualRows[index-1].index)))return invalid();
    // The native cache stores membership in a different order from the UI.
    // Use verified virtual renderer indices, including its real header/footer
    // slots, and require an observed boundary instead of guessing an offset.
    if(context.geometry[0]<=3&&!evidence.startVerified||context.geometry[1]-context.geometry[2]-context.geometry[0]<=3&&!evidence.endVerified)return invalid();
    inboxModelAccepted={fingerprint:context.fingerprint,acceptedAt:Date.now(),loadedCount:evidence.loadedCount,hasMore:evidence.hasMore,loading:evidence.loading,startVerified:evidence.startVerified,endVerified:evidence.endVerified,ranks};
    inboxModelAttempt={fingerprint:context.fingerprint,at:Date.now(),count:0};
    return {ok:true,loadedRows:evidence.loadedCount,nativeHasMore:evidence.hasMore,loading:evidence.loading};
  }
  function listCoverage() {
    const rows=select(document,INBOX),scroller=inboxScroller();
    if(!scroller)return {token:'',hasMore:false,status:'unsupported',renderedRows:rows.length,complete:false};
    const context=inboxModelContext(),native=acceptedInboxModel(context),nativeRequired=platform()==='1688'&&scroller.matches('.ww_conversation_list .conversation-list-scroll'),nativePending=nativeRequired&&!native,physicalMore=scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop>3;
    const signature=JSON.stringify([rows.map(row=>identity(row)),Math.round(scroller.scrollTop),scroller.scrollHeight,scroller.clientHeight,inboxModelAccepted?.loadedCount??null]);
    // A consumed action token is not list progress. Keep a separate token for
    // actual row/geometry changes, including delayed virtual-list rendering.
    // Successful traversal has no page-count ceiling; only repeated stalls do.
    if(inboxTraversal.progressSignature!==signature)Object.assign(inboxTraversal,{progressSignature:signature,progressToken:crypto.randomUUID(),stalledAttempts:0});
    if(inboxTraversal.signature!==signature||inboxTraversal.scroller!==scroller)inboxTraversal={...inboxTraversal,token:crypto.randomUUID(),signature,scroller};
    const limited=inboxTraversal.stalledAttempts>=8||nativePending&&(!context||inboxModelAttempt.fingerprint===context.fingerprint&&inboxModelAttempt.count>=8&&Date.now()-inboxModelAttempt.at<300000);
    const loading=!limited&&(nativePending||native?.loading===true),hasMore=!limited&&(physicalMore||nativePending||native?.hasMore===true||native?.loading===true);
    return {token:inboxTraversal.token,progressToken:inboxTraversal.progressToken,stalledAttempts:inboxTraversal.stalledAttempts,atStart:Math.abs(scroller.scrollTop-scrollBoundary(scroller,true))<=3&&(!nativeRequired||native?.startVerified===true),scrollTop:Math.round(scroller.scrollTop),scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight,hasMore,status:limited?'limited':nativePending?'metadata_pending':loading?'loading':hasMore?'ready':'end_visible',renderedRows:rows.length,complete:Boolean(native?.endVerified&&!physicalMore&&!hasMore&&!limited),...(nativeRequired?{nativePending,loading,retryAfterMs:loading?1000:0,nativeHasMore:native?.hasMore??null,loadedRows:native?.loadedCount??null}:{} )};
  }
  function inboxSnapshotRows() {
    const items=select(document,ITEM);
    if(items.length<=LIMIT.conversations)return {rows:items,limited:false};
    const fallback=()=>({rows:items.slice(0,LIMIT.conversations),limited:true});
    if(!items.every(item=>item.matches(INBOX)))return fallback();
    const scroller=inboxScroller();if(!scroller)return fallback();
    const bounds=scroller.getBoundingClientRect(),top=Math.max(0,bounds.top),bottom=Math.min(innerHeight,bounds.bottom);
    const start=items.findIndex(item=>{
      if(!scroller.contains(item))return false;
      const rect=item.getBoundingClientRect();return rect.bottom>top&&rect.top<bottom;
    });
    if(start<0)return fallback();
    // Some native inboxes retain every DOM row instead of virtualizing. A
    // fixed first-200 slice would never expose later chats after scrolling.
    // Keep the active identity, then read a bounded window from this viewport.
    return {rows:[...new Set([...items.filter(rowActive),...items.slice(start,start+LIMIT.conversations)])].slice(0,LIMIT.conversations),limited:false};
  }
  function advanceList(request) {
    if(request?.documentToken!==DOCUMENT_TOKEN||typeof request.listToken!=='string'||!request.listToken)return {ok:false,detail:'Документ или разрешение прокрутки списка устарели.'};
    const current=snapshot();if(current.status!=='ready')return {ok:false,detail:current.detail};
    if(Object.values(current.busy).some(Boolean))return {ok:false,busy:true,detail:'Список не прокручивается во время работы пользователя или при открытом черновике.'};
    const coverage=current.listCoverage,scroller=inboxTraversal.scroller,start=request.direction==='start';
    if(request.listToken!==coverage.token||!scroller||inboxScroller()!==scroller||(!start&&!coverage.hasMore))return {ok:false,detail:'Список диалогов изменился либо доступная часть уже просмотрена.'};
    if(!start&&coverage.loading)return {ok:false,status:'loading',retryAfterMs:1000,detail:'Ожидаю загрузку и подтверждение текущего окна списка площадки.'};
    const before=inboxTraversal.progressSignature;
    inboxTraversal.token='';inboxTraversal.signature='';
    if(start){scroller.scrollTop=scrollBoundary(scroller,true);inboxTraversal.steps=0;inboxTraversal.stalledAttempts=0;}
    else {
      const target=Math.min(scroller.scrollHeight-scroller.clientHeight,scroller.scrollTop+Math.max(1,Math.floor(scroller.clientHeight*0.8)));
      // 1688's native virtual widget ignores an unchanged scroll offset.
      // A bounded one-pixel retry notifies that same widget when a server page
      // is still available at the spacer's end; it does not select a chat.
      const retryAtEnd=platform()==='1688'&&coverage.nativeHasMore===true&&target===scroller.scrollTop&&target>0;
      if(retryAtEnd){scroller.scrollTop=target-1;scroller.dispatchEvent(new Event('scroll'));}
      scroller.scrollTop=target;if(retryAtEnd)scroller.dispatchEvent(new Event('scroll'));inboxTraversal.steps++;
    }
    listCoverage();
    const advanced=inboxTraversal.progressSignature!==before;
    if(!start&&!advanced)inboxTraversal.stalledAttempts++;
    return {ok:true,advanced,direction:start?'start':'next',steps:inboxTraversal.steps,stalledAttempts:inboxTraversal.stalledAttempts,progressToken:inboxTraversal.progressToken,status:inboxTraversal.stalledAttempts>=8?'limited':'ready'};
  }
  function loadHistoryStart(request) {
    if(request?.documentToken!==DOCUMENT_TOKEN||typeof request.conversationId!=='string')return {ok:false,detail:'Документ или диалог изменились.'};
    const current=snapshot();if(current.status!=='ready')return {ok:false,detail:current.detail};
    if(Object.values(current.busy).some(Boolean))return {ok:false,busy:true,detail:'История не прокручивается во время ввода пользователя или при открытом черновике.'};
    const active=current.conversations.filter(row=>row.active&&row.identityReliable),row=active[0];
    if(active.length!==1||row.id!==request.conversationId)return {ok:false,detail:'Открытый адресат не подтверждён.'};
    if(row.historyStable!==true)return {ok:false,status:'loading',detail:'Ожидаю устойчивую историю перед чтением первого сообщения.'};
    if(row.firstBuyerMessageReliable){pendingReveal={platform:platform(),id:row.id,documentToken:DOCUMENT_TOKEN,at:Date.now(),historyOperation:true};return {ok:true,status:'complete',complete:true,detail:'Первое ваше сообщение подтверждено началом истории.'};}
    const scroller=historyScroller();if(!scroller)return {ok:false,status:'unsupported',detail:'Не подтверждён контейнер ранней истории этой площадки.'};
    let load=historyLoads.get(row.id);if(!load){load={attempts:0,lastAt:0,status:'loading',detail:''};historyLoads.set(row.id,load);}
    if(load.attempts>=HISTORY_LOAD_LIMIT&&Date.now()-load.lastAt>=300000){load.attempts=0;load.lastAt=0;load.status='loading';}
    if(load.attempts>=HISTORY_LOAD_LIMIT)return {ok:false,status:'limited',attempts:load.attempts,detail:'Начало переписки не подтверждено после 8 попыток. Видимое сообщение не считается первым.'};
    if(load.lastAt&&Date.now()-load.lastAt<1000)return {ok:false,status:'loading',attempts:load.attempts,detail:'Ожидаю загрузку предыдущей части истории.'};
    load.attempts++;load.lastAt=Date.now();load.status=load.attempts>=HISTORY_LOAD_LIMIT?'limited':'loading';load.detail='Загружаю раннюю историю: требуется подтверждение начала переписки.';
    pendingReveal={platform:platform(),id:row.id,documentToken:DOCUMENT_TOKEN,at:Date.now(),historyOperation:true};
    const target=scrollBoundary(scroller,true);
    // A one-pixel movement retriggers a native load-at-top observer without
    // clicking a guessed button. A short, stationary list remains unverified.
    if(scroller.scrollTop===target&&scroller.scrollHeight>scroller.clientHeight)scroller.scrollTop=target===0?1:target+1;
    scroller.scrollTop=target;
    if(platform()==='mic'){
      // The native React scroll handler belongs to .msg-list even where its
      // scrollable geometry is supplied by the surrounding panel. Notify that
      // exact history node; a short list need not produce a browser scroll.
      const history=select(document,'.conversation-area .window-center-messages-main > .msg-list');
      if(history.length===1)history[0].dispatchEvent(new Event('scroll',{bubbles:true}));
    }else if(scroller.scrollHeight<=scroller.clientHeight+1){
      // Short native transcripts can still have older server pages. There is
      // no physical scroll delta in that case; notify only the verified panel
      // through its ordinary read-only scroll/wheel handlers, never a guessed
      // button or an application method. The same eight-attempt cap applies.
      scroller.dispatchEvent(new Event('scroll'));
    }
    for(const key of [...historyLoads.keys()].slice(0,-100))historyLoads.delete(key);
    return {ok:true,status:'loading',attempts:load.attempts,maxAttempts:HISTORY_LOAD_LIMIT,detail:load.detail};
  }
  function modelContext(){
    if(platform()!=='1688')return null;
    const active=select(document,INBOX_1688).filter(row=>rowActive(row)),histories=select(document,'.ww_box .message-list');
    if(active.length!==1||!liveThreadId(active[0])||histories.length!==1)return null;
    const rows=select(histories[0],'.rc-scrollbars-view > .message-item-line').slice(-LIMIT.messages),signatures=rows.map(row=>rowSignature(row));
    return {threadId:active[0].id,rows,signatures,fingerprint:JSON.stringify([active[0].id,signatures])};
  }
  function historyModelContext(){
    const site=platform();if(!['alibaba','mic'].includes(site))return null;
    const active=select(document,site==='alibaba'?INBOX_ALIBABA:INBOX_MIC).filter(row=>rowActive(row));
    const histories=select(document,site==='alibaba'?'.buyer-messenger-container .message-box .im-message-flow .scroll-box':'.conversation-area .window-center-messages-main > .msg-list');
    if(active.length!==1||!liveThreadId(active[0])||histories.length!==1)return null;
    const history=histories[0],signature=rowSignature(history,1000000),id=identity(active[0]);if(!signature)return null;
    return {platform:site,id,threadId:liveThreadId(active[0]).replace(/^(?:thread|peer):/,''),history,signature,fingerprint:JSON.stringify([site,id,signature])};
  }
  function requestHistoryEvidence(result){
    if(!['alibaba','mic'].includes(result.platform)||result.status!=='ready'||!result.conversations.some(row=>row.active&&row.identityReliable&&!row.historyStartKnown))return;
    const context=historyModelContext();if(!context)return;
    if(historyModelAttempt.fingerprint===context.fingerprint&&Date.now()-historyModelAttempt.at<5000)return;
    if(historyModelRequest?.fingerprint!==context.fingerprint)historyModelRequest={...context,token:crypto.randomUUID()};
    result.historyEvidenceToken=historyModelRequest.token;
  }
  function applyHistoryEvidence(request){
    if(request?.documentToken!==DOCUMENT_TOKEN||!historyModelRequest||request.historyEvidenceToken!==historyModelRequest.token)return {ok:false,detail:'Разрешение проверки начала истории устарело.'};
    const current=snapshot(),context=historyModelContext(),evidence=request.evidence;
    if(current.status!=='ready'||!context||context.fingerprint!==historyModelRequest.fingerprint||request.historyEvidenceToken!==historyModelRequest.token)return {ok:false,detail:'Диалог или сообщения изменились при проверке начала истории.'};
    historyModelAttempt={fingerprint:context.fingerprint,at:Date.now()};historyModelRequest=null;
    const schemas={alibaba:'alibaba-no-more-cache-v1',mic:'mic-history-boundary-v1'};
    if(!evidence||evidence.status!=='ready'||evidence.platform!==context.platform||evidence.url!==location.href||evidence.threadId!==context.threadId||evidence.historySignature!==context.signature||evidence.schema!==schemas[context.platform]||evidence.loading!==false||evidence.limited===true||!Number.isFinite(evidence.capturedAt)||Date.now()-evidence.capturedAt>30000||evidence.capturedAt-Date.now()>5000)return {ok:false,detail:'Площадка ещё не подтвердила начало переписки.'};
    const row=current.conversations.find(row=>row.active&&row.id===context.id),last=row?.messages.filter(message=>message.direction!=='system').at(-1),time=nativeTimestamp(String(evidence.latestMessageAt));
    const timeKnown=evidence.covered===true&&last?.id&&last.id===evidence.latestMessageId&&time?.reliable===true;
    if(timeKnown)historyModelTimes.set(context.id,{signature:context.signature,at:time.at,messageId:last.id});
    const startKnown=evidence.startKnown===true&&evidence.covered===true;
    if(!startKnown&&!timeKnown)return {ok:false,detail:'Площадка ещё не подтвердила начало переписки.'};
    if(startKnown)historyBoundaryProofs.set(context.id,context.signature);
    for(const key of [...historyBoundaryProofs.keys()].slice(0,-100))historyBoundaryProofs.delete(key);
    for(const key of [...historyModelTimes.keys()].slice(0,-100))historyModelTimes.delete(key);
    return {ok:true,startKnown,latestMessageAtKnown:timeKnown===true};
  }
  function requestModelEvidence(result){
    if(result.platform!=='1688'||result.status!=='ready'||!result.conversations.some(row=>row.active&&row.identityReliable&&row.messages.some(message=>message.direction==='unknown')))return;
    const context=modelContext();if(!context||context.fingerprint===modelAttempt)return;
    if(modelRequest?.fingerprint!==context.fingerprint)modelRequest={...context,token:crypto.randomUUID()};
    result.modelEvidenceToken=modelRequest.token;
  }
  function applyModelEvidence(request){
    if(request?.documentToken!==DOCUMENT_TOKEN||!modelRequest||request.modelEvidenceToken!==modelRequest.token)return {ok:false,detail:'Разрешение чтения модели или документ устарели.'};
    const current=snapshot(),context=modelContext(),evidence=request.evidence;
    if(current.status!=='ready'||!context||context.fingerprint!==modelRequest.fingerprint||request.modelEvidenceToken!==modelRequest.token)return {ok:false,detail:'Выбранный диалог или его сообщения изменились.'};
    if(!evidence||evidence.status!=='ready'||evidence.platform!=='1688'||evidence.url!==location.href||evidence.threadId!==context.threadId||!Number.isFinite(evidence.capturedAt)||Date.now()-evidence.capturedAt>30000||evidence.capturedAt-Date.now()>5000||!Array.isArray(evidence.rows)||evidence.rows.length>500)return {ok:false,detail:'Источник сведений о сообщениях не подтверждён.'};
    const members=/^(\d+)\.\d+-(\d+)\.\d+#\d+@cntaobao$/.exec(context.threadId),bySignature=new Map(),conflicts=new Set();
    const numeric=value=>typeof value==='string'&&/^\d{1,30}$/.test(value)?value:Number.isSafeInteger(value)&&value>=0?String(value):'';
    for(const record of evidence.rows){
      if(!record||typeof record.signature!=='string'||!record.signature||context.signatures.filter(signature=>signature===record.signature).length!==1)continue;
      const row=context.rows[context.signatures.indexOf(record.signature)],messages=messageNodes(row);
      if(messages.length!==1||!messages[0].matches('.message-item'))continue;
      const model=record.model,ext=model?.ext,sender=model?.sender,receiver=model?.receiver,id=identifier(model?.code?.messageId);
      const from=numeric(ext?.senderMainUserId),to=numeric(ext?.receiverMainUserId),fromUser=numeric(ext?.senderUserId),toUser=numeric(ext?.receiverUserId),senderId=numeric(sender?.targetId),receiverId=numeric(receiver?.targetId);
      if(!members||!id||model?.conversationCode!==context.threadId||!from||!to||from===to||![members[1],members[2]].includes(from)||![members[1],members[2]].includes(to)||!fromUser||!toUser||senderId!==fromUser||![to,toUser].includes(receiverId)||String(sender?.targetType)!=='8'||String(receiver?.targetType)!=='8')continue;
      const value={id,from,to};if(bySignature.has(record.signature)&&JSON.stringify(bySignature.get(record.signature))!==JSON.stringify(value))conflicts.add(record.signature);else bySignature.set(record.signature,value);
    }
    for(const signature of conflicts)bySignature.delete(signature);
    const buyers=new Set();
    for(let i=0;i<context.rows.length;i++){
      const row=context.rows[i],model=bySignature.get(context.signatures[i]),messages=messageNodes(row);
      if(model&&messages.length===1&&self1688Message(messages[0]))buyers.add(model.from);
    }
    modelAttempt=context.fingerprint;modelRequest=null;
    if(buyers.size!==1)return {ok:false,detail:'Аккаунт покупателя не подтверждён собственным сообщением в этой истории.'};
    const buyer=[...buyers][0],peer=members[1]===buyer?members[2]:members[1],accepted=new Map();
    for(const [signature,model] of bySignature){
      const direction=model.from===buyer&&model.to===peer?'outbound':model.from===peer&&model.to===buyer?'inbound':null;
      if(direction)accepted.set(signature,{id:model.id,direction});
    }
    modelAccepted={threadId:context.threadId,rows:accepted};
    return {ok:true,applied:accepted.size};
  }
  function snapshot() {
    selectionRows=new Map();
    const result={platform:platform(),status:'unsupported',url:location.href,detail:'На странице не распознана история с устойчивым идентификатором диалога.',frames:frames(),documentToken:DOCUMENT_TOKEN,busy:busy(),conversations:[]};
    if(!result.platform){result.detail='Эта площадка не поддерживается.';return result;}
    try {
      if(select(document,'#nc_1_wrapper,.nc-container,.geetest_panel,[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i],iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],iframe[src*="_____tmd_____/punish"],#baxia-dialog-content').length){result.status='captcha';result.detail='Видна проверка CAPTCHA; мониторинг ничего не нажимает.';return result;}
      if(select(document,'input[type="password"],[data-login-required="true"],.login-panel').length||/\/(?:login|signin)(?:[/.?]|$)/i.test(location.pathname+location.hash)){
        if(!loginObserved){micEpoch=crypto.randomUUID();rowTokens=new WeakMap();usedTokens.clear();historyLoads.clear();firstBuyerProofs.clear();latestMessageTimes.clear();historyBoundaryProofs.clear();historyModelTimes.clear();historyModelRequest=null;historyModelAttempt={fingerprint:'',at:0};inboxModelRequest=null;inboxModelAccepted=null;inboxModelAttempt={fingerprint:'',at:0,count:0};active1688Evidence=null;activeAlibabaEvidence=null;activeMicEvidence=null;pendingReveal=null;modelRequest=null;modelAttempt='';modelAccepted={threadId:'',rows:new Map()};}loginObserved=true;
        result.status='login';result.detail='Нужен вход в аккаунт этой площадки.';return result;
      }
      loginObserved=false;
      if(document.readyState!=='complete'){result.status='loading';result.detail='Страница ещё загружается.';return result;}
      const histories=select(document,HISTORY).filter(node=>!node.closest(ITEM)&&!node.closest(EXCLUDED));
      const leafHistories=histories.filter(node=>!histories.some(other=>other!==node&&node.contains(other)));
      const conversations=leafHistories.map(history=>readHistory(history,leafHistories.length)).filter(Boolean).map(workflowEvidence);
      const byId=new Map();
      for(const entry of conversations){if(byId.has(entry.id)){const other=byId.get(entry.id);other.orderReliable=false;other.tailKnown=false;other.readComplete=false;other.historyTailKnown=false;other.historyOrderReliable=false;other.historyStartKnown=false;other.historyComplete=false;other.firstBuyerMessage=null;other.firstBuyerMessageReliable=false;other.latestMessageAtReliable=false;firstBuyerProofs.delete(entry.id);other.detail='Найдено несколько историй одного диалога; нужно уточнить структуру страницы.';}else byId.set(entry.id,entry);}
      const rowWindow=inboxSnapshotRows(),nativeInbox=acceptedInboxModel(inboxModelContext()),nativeOrder=new Map(select(document,INBOX).map((item,index)=>[item,nativeInbox?.ranks.get(item.id)??index]));
      for(const item of rowWindow.rows){
        const id=identity(item);if(!id)continue;
        const previewNode=select(item,'[data-message-preview],.message-preview,.conversation-preview,.last-message'+(platform()==='1688'&&item.matches(INBOX_1688)?',.conversation-secondary-line > .desc':platform()==='alibaba'&&item.matches(INBOX_ALIBABA)?',.msg-wrapper .latest-msg > div':platform()==='mic'&&item.matches(INBOX_MIC)?',.rg-last-msg .last-msg':''))[0];const preview=textOf(previewNode,LIMIT.text,true);
        const listOrder=nativeOrder.get(item)??null;
        const existing=byId.get(id);if(existing){existing.listOrder=listOrder;if(unread(item)!==null)existing.unread=unread(item);if(!existing.title)existing.title=title(item);if(preview)existing.preview=preview;mergeRowTime(existing,item,preview);continue;}
        const cached=latestMessageTimes.get(id),entry={id,listOrder,identityReliable:provenAccount(item),title:title(item),url:safeUrl(item.matches('a[href]')?item.href:select(item,'a[href]')[0]?.href||location.href),unread:unread(item),active:item.matches(INBOX)&&rowActive(item),orderReliable:false,tailKnown:false,historyStartKnown:false,historyComplete:false,firstBuyerMessage:null,firstBuyerMessageReliable:false,latestMessageAt:cached?.at??null,latestMessageAtReliable:Boolean(cached),latestMessageAtSource:cached?'remembered-native-message':'',preview,needsRead:true,messages:[],...selectable(item,id)};
        mergeRowTime(entry,item,preview);byId.set(id,entry);
      }
      // Preserve the bounded active history, but do not promote it ahead of
      // earlier sidebar rows merely because its messages were parsed first.
      result.conversations=[...byId.values()].slice(0,LIMIT.conversations).sort((left,right)=>(Number.isInteger(left.listOrder)?left.listOrder:Infinity)-(Number.isInteger(right.listOrder)?right.listOrder:Infinity));result.listCoverage=listCoverage();
      if(rowWindow.limited)Object.assign(result.listCoverage,{status:'limited',hasMore:false,windowLimited:true,detail:'В длинном списке не подтверждено текущее окно диалогов. Проверка всего списка не завершена.'});
      const nextReplyEvidence=new Map();
      for(const row of result.conversations.filter(item=>item.active)){
        const signature=JSON.stringify([row.id,row.identityReliable,row.orderReliable,row.tailKnown,row.historyOrderReliable,row.historyTailKnown,row.historyStartKnown,row.historyComplete,row.needsRead,row.messages,row.coverage,row.firstBuyerMessage,row.firstBuyerMessageReliable,row.latestMessageAt,row.latestMessageAtReliable]);
        const prior=replyEvidence.get(row.id),entry=prior?.signature===signature?prior:{signature,token:crypto.randomUUID()};
        row.replyFingerprint=entry.token;nextReplyEvidence.set(row.id,entry);
      }
      replyEvidence=nextReplyEvidence;
      if(result.conversations.length){result.status='ready';result.detail=result.conversations.some(item=>item.active)?'Прочитаны доступные сообщения. Предпросмотры других диалогов требуют открытия пользователем.':'Доступен только список диалогов. Откройте нужную переписку, чтобы прочитать сообщения.';}
      else if(select(document,PENDING+(platform()==='mic'?',.conversation-lst .ant-skeleton-active':'')).length){result.status='loading';result.detail='История чата ещё загружается.';}
      else if(result.frames.some(frame=>frame.visible)){result.detail='Чат может находиться во вложенном фрейме; требуется отдельное чтение фрейма.';}
      requestModelEvidence(result);requestHistoryEvidence(result);requestInboxEvidence(result);return result;
    } catch {return {...result,status:'error',detail:'Не удалось прочитать структуру чата. Отправка и ввод не выполнялись.',conversations:[]};}
  }
  function guardReply(expected) {
    const invalid=reason=>({ok:false,reason});
    if(!expected || expected.documentToken!==DOCUMENT_TOKEN || expected.platform!==platform() || expected.sourceUrl!==location.href || typeof expected.id!=='string' || typeof expected.replyFingerprint!=='string' || !expected.replyFingerprint)return invalid('Страница или разрешение на ответ изменились.');
    if(expected.purpose==='wechat')return invalid('Продолжить переписку можно только после ответа поставщика на ваше обращение.');
    const current=snapshot(),active=current.conversations.filter(row=>row.active);
    if(current.status!=='ready' || active.length!==1)return invalid('Не подтверждён один открытый диалог без ограничений площадки.');
    const row=active[0];
    if(row.id!==expected.id || row.replyFingerprint!==expected.replyFingerprint || !row.identityReliable)return invalid('Получатель, история или вложения изменились. Ответ остановлен.');
    if(typeof expected.buyerWechat==='string'&&expected.buyerWechat.trim()){
      const normalize=value=>String(value||'').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g,'').toLowerCase(),needle=normalize(expected.buyerWechat).trim();
      const contains=text=>{const value=normalize(text);for(let at=value.indexOf(needle);at!==-1;at=value.indexOf(needle,at+1))if(!/[a-z0-9_-]/i.test(value[at-1]||'')&&!/[a-z0-9_-]/i.test(value[at+needle.length]||''))return true;return false;};
      if(needle&&row.messages.some(message=>contains(message.text)))return invalid('Ваш WeChat уже упомянут в переписке. Диалог завершён, новый ответ не отправляется.');
    }
    const messages=row.messages.filter(message=>message.direction!=='system');
    if((row.historyOrderReliable??row.orderReliable)!==true || (row.historyTailKnown??row.tailKnown)!==true || row.messages.some(message=>message.direction==='unknown') || messages.at(-1)?.direction!=='inbound')return invalid('Последнее сообщение и порядок истории не подтверждены.');
    if(!messages.slice(0,-1).some(message=>message.direction==='outbound')&&!(row.firstBuyerMessageReliable===true&&row.firstBuyerMessage?.direction==='outbound'))return invalid('Не подтверждён ответ поставщика после вашего первичного обращения.');
    return {ok:true,busy:current.busy};
  }
  function guardPreviewCleanup(expected) {
    const invalid=reason=>({ok:false,reason});
    if(!expected||expected.documentToken!==DOCUMENT_TOKEN||expected.platform!==platform()||expected.sourceUrl!==location.href||typeof expected.id!=='string')return invalid('Документ тестового черновика изменился.');
    const current=snapshot(),active=current.conversations.filter(row=>row.active);
    // Cleanup does not send or answer the new message. A new inbound or changed
    // history must not strand our own unchanged preview in the same composer.
    if(current.status!=='ready'||active.length!==1||active[0].id!==expected.id||active[0].identityReliable!==true)return invalid('Получатель тестового черновика изменился или не подтверждён.');
    return {ok:true};
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
    pendingReveal={platform:platform(),id:request.conversationId,documentToken:DOCUMENT_TOKEN,at:Date.now()};
    return {ok:true,openedId:request.conversationId};
  }
  function revealLatest(request) {
    const site=platform();
    if(!['alibaba','1688','mic'].includes(site)||!pendingReveal||pendingReveal.platform!==site||request?.documentToken!==DOCUMENT_TOKEN||request.conversationId!==pendingReveal.id||Date.now()-pendingReveal.at>120000)return {ok:false,detail:'Нет актуального разрешения дочитать открытый диалог.'};
    const current=snapshot();
    if(current.status!=='ready')return {ok:false,detail:current.detail};
    if(Object.values(current.busy).some(Boolean))return {ok:false,busy:true,detail:'Пользователь работает в чате или есть черновик.'};
    const active=current.conversations.filter(row=>row.active&&row.id===request.conversationId&&row.identityReliable);
    const evidence=site==='alibaba'?activeAlibabaEvidence:site==='1688'?active1688Evidence:activeMicEvidence;
    if(active.length!==1||!active[0].messages.length||!evidence||Date.now()-evidence.since<1000)return {ok:false,detail:'История выбранного диалога ещё не подтверждена.'};
    const scroller=historyScroller();
    if(!scroller||!visible(scroller))return {ok:false,detail:'Контейнер прокрутки истории не подтверждён.'};
    pendingReveal=null;
    scroller.scrollTop=scrollBoundary(scroller,false);
    return {ok:true,revealedId:request.conversationId};
  }
  for(const type of ['keydown','pointerdown','input','wheel','touchstart'])document.addEventListener(type,event=>{if(event.isTrusted){lastTrustedInput=Date.now();pendingReveal=null;}},{capture:true,passive:true});
  globalThis.OpenLinksDialogsReader=Object.freeze({snapshot,openConversation,revealLatest,loadHistoryStart,advanceList,applyModelEvidence,applyHistoryEvidence,applyInboxEvidence,guardReply,guardPreviewCleanup});
  globalThis.chrome?.runtime?.onMessage?.addListener((message,sender,respond)=>{
    if(!['DIALOGS_SNAPSHOT','DIALOGS_OPEN_CONVERSATION','DIALOGS_REVEAL_LATEST','DIALOGS_LOAD_HISTORY_START','DIALOGS_ADVANCE_LIST','DIALOGS_APPLY_INBOX_EVIDENCE','DIALOGS_APPLY_HISTORY_EVIDENCE','DIALOGS_APPLY_MODEL_EVIDENCE'].includes(message?.type))return;
    if(sender?.id!==chrome.runtime.id){respond({status:'error',detail:'Источник запроса не подтверждён.'});return;}
    respond(message.type==='DIALOGS_SNAPSHOT'?snapshot():message.type==='DIALOGS_OPEN_CONVERSATION'?openConversation(message):message.type==='DIALOGS_LOAD_HISTORY_START'?loadHistoryStart(message):message.type==='DIALOGS_ADVANCE_LIST'?advanceList(message):message.type==='DIALOGS_APPLY_INBOX_EVIDENCE'?applyInboxEvidence(message):message.type==='DIALOGS_APPLY_HISTORY_EVIDENCE'?applyHistoryEvidence(message):message.type==='DIALOGS_APPLY_MODEL_EVIDENCE'?applyModelEvidence(message):revealLatest(message));
  });
})();
