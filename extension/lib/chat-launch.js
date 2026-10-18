// Public message-center entry points observed in the supported marketplaces.
// Never accept a page URL from the extension UI or derive a recipient here.
export const CHAT_CENTERS=Object.freeze({
  '1688':'https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html',
  alibaba:'https://message.alibaba.com/message/messenger.htm',
  mic:'https://membercenter.made-in-china.com/message/index.html',
});
export const CHAT_LAUNCH_TIMEOUT_MS=120000;
// The member center is only a launch page. Its embedded lite widget can expose
// readable rows, but that must never make the mailbox a full messenger.
export function isMICBootstrapPage(value) {
  try {
    const url=new URL(value);
    return url.protocol==='https:'&&url.hostname==='membercenter.made-in-china.com'&&url.pathname==='/message/index.html'&&!url.username&&!url.password&&!url.port;
  } catch {return false;}
}
export function isMICMessengerPage(value) {
  try {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.hostname!=='webim.made-in-china.com'||url.pathname!=='/super-tm/'||url.username||url.password||url.port)return false;
    const fragment=decodeURIComponent(url.hash.slice(1));
    if(/^\/?(?:login|signin|sign-in)(?:[/?#&]|$)/i.test(fragment))return false;
    const queryIndex=url.hash.indexOf('?'),params=[url.searchParams,new URLSearchParams(queryIndex<0?'':url.hash.slice(queryIndex+1))];
    return params.every(query=>['isLiteTM','isSAChat'].every(key=>query.getAll(key).every(value=>value==='false')));
  } catch {return false;}
}
export function managedChatRoute(name,value) {
  try {
    const url=new URL(value),center=new URL(CHAT_CENTERS[name]);
    if(url.protocol!=='https:'||url.username||url.password||url.port)return false;
    // A login redirect may retain ownership of our tab; it never proves that
    // the reader is ready. Storefronts and unrelated same-platform tabs do not.
    const domain=name==='1688'?'1688.com':name==='alibaba'?'alibaba.com':'made-in-china.com';
    if((url.hostname===domain||url.hostname.endsWith('.'+domain))&&(/^(?:login|passport|passport-buyer)\./.test(url.hostname)||/^\/(?:login|sign-in|signin)(?:[/.]|$)/i.test(url.pathname)))return true;
    if(name==='mic'&&url.origin==='https://webim.made-in-china.com'&&url.pathname==='/super-tm/')return true;
    return url.origin===center.origin&&(url.pathname===center.pathname||name==='alibaba'&&/^\/message\/(?:default|messenger)\.htm$/.test(url.pathname));
  } catch {return false;}
}
export function normalizeManagedChat(raw) {
  if(!raw||!Number.isSafeInteger(raw.windowId)||raw.windowId<0||!Number.isFinite(raw.openedAt)||raw.openedAt<0||!Number.isFinite(raw.deadlineAt)||raw.deadlineAt<raw.openedAt||raw.deadlineAt>raw.openedAt+CHAT_LAUNCH_TIMEOUT_MS||typeof raw.token!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(raw.token))return null;
  const managed={windowId:raw.windowId,openedAt:raw.openedAt,deadlineAt:raw.deadlineAt,token:raw.token,pending:raw.pending===true};
  if(typeof raw.micInitDocumentToken==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(raw.micInitDocumentToken))managed.micInitDocumentToken=raw.micInitDocumentToken;
  return managed;
}

// The native full-inbox action supplies account bootstrap data in the hash.
// This URL is used once for navigation, never saved in extension state/logs.
export function validMICBootstrapURL(value) {
  try {
    if(typeof value!=='string'||value.length>4096||!/^https:\/\/webim\.made-in-china\.com\/super-tm\/(?:[?#]|$)/.test(value)||/[\u0000-\u0020\u007f]/.test(value))return false;
    const url=new URL(value);
    if(url.protocol!=='https:'||url.hostname!=='webim.made-in-china.com'||url.pathname!=='/super-tm/'||url.username||url.password||url.port||url.search)return false;
    const index=url.hash.indexOf('?');if(index<0||/^#\/(?:login|signin|sign-in)(?:[/?]|$)/i.test(decodeURIComponent(url.hash)))return false;
    const params=new URLSearchParams(url.hash.slice(index+1)),keys=[...params.keys()];
    return keys.length===4&&new Set(keys).size===4&&keys.every(key=>['data','refer','isLiteTM','isSAChat'].includes(key))&&!!params.get('data')&&params.get('data').length<=3000&&params.get('refer')===''&&params.get('isLiteTM')==='false'&&params.get('isSAChat')==='false';
  } catch {return false;}
}
