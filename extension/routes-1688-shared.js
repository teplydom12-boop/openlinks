// Public seller metadata only. Shared by the worker and isolated content scripts.
(() => {
  const {platform,is1688Storefront,direct1688}=globalThis.OpenLinksRules;
  const BASE='https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html';
  const MAX_BYTES=2*1024*1024;
  function storeKey(raw) {
    try {const u=new URL(raw);return platform(raw)==='1688' && is1688Storefront(u.hostname)?u.origin+'/':null;}catch{return null;}
  }
  function isMessenger(raw) {
    try {const u=new URL(raw);return platform(raw)==='1688' && u.hostname==='air.1688.com' && /\/def_cbu_web_im(?:_core)?\/index\.html$/.test(u.pathname);}catch{return false;}
  }
  function route(raw) {
    const safe=direct1688(raw);if(!safe)return null;
    const u=new URL(safe),recipient=u.searchParams.get('touid') || u.searchParams.get('chatId');
    // Core iframe and outer shell represent the same recipient. Always open the
    // full web messenger, not an internal iframe copied from the saved page.
    const target=new URL(BASE);
    target.searchParams.set(u.searchParams.has('touid')?'touid':'chatId',recipient);
    target.searchParams.set('siteid',u.searchParams.get('siteid') || 'cnalichn');
    target.searchParams.set('status','1');target.hash='/';return target.href;
  }
  function fromLogin(login) {
    if(typeof login!=='string' || !login.trim() || login.length>100 || /[\x00-\x1f]/.test(login))return null;
    const u=new URL(BASE);u.searchParams.set('touid','cnalichn'+login.trim());return route(u.href);
  }
  function jsonPrefix(text,start) {
    if(text[start]!=='{')return null;
    let depth=0,quoted=false,escaped=false;
    for(let i=start;i<text.length;i++) {
      const ch=text[i];
      if(quoted) {if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
      if(ch==='"'){quoted=true;continue;}
      if(ch==='{')depth++;
      if(ch==='}' && --depth===0)return JSON.parse(text.slice(start,i+1));
    }
    return null;
  }
  function fromPage(text,store) {
    const key=storeKey(store);
    if(!key || typeof text!=='string' || text.length>MAX_BYTES)return {url:null,reason:'Нет данных витрины подходящего размера'};
    const assignments=/\bwindow\.pageData\s*=\s*/g;
    const candidates=new Set();let source='',sawConflict=false,match;
    while((match=assignments.exec(text))) {
      let data;
      try{data=jsonPrefix(text,assignments.lastIndex);}catch{continue;}
      const global=data?.globalData;
      // Do not borrow a recipient from recommendations, buyer data, a different
      // supplier, or an arbitrary "loginId" somewhere in the document.
      if(typeof global?.domain!=='string' || storeKey(/^https:\/\//i.test(global.domain)?global.domain:'https://'+global.domain)!==key)continue;
      const derived=fromLogin(global.sellerLoginId),links=new Set();
      for(const component of Object.values(data.components || {})) {
        const found=route(component?.moduleData?.commonUrl?.wangWangUrl);
        if(found)links.add(found);
      }
      if(links.size>1 || (links.size===1 && derived && !links.has(derived))) {sawConflict=true;continue;}
      const found=[...links][0] || derived;
      if(found){candidates.add(found);source=links.size?'pageData → wangWangUrl':'pageData → sellerLoginId';}
    }
    if(sawConflict || candidates.size>1)return {url:null,reason:'Данные получателя противоречат друг другу; нужен штатный чат'};
    return {url:[...candidates][0] || null,source,reason:candidates.size?'':'В данных страницы нет однозначного получателя этого магазина'};
  }
  function cached(routes,store) {
    const key=storeKey(store);if(!key)return null;
    const found=Object.entries(routes || {}).filter(([saved])=>storeKey(saved)===key)
      .map(([,entry])=>({url:route(entry.url),at:Number(entry.at)||0})).filter(entry=>entry.url).sort((a,b)=>b.at-a.at);
    if(!found.length || found.some(entry=>entry.at===found[0].at && entry.url!==found[0].url))return null;
    return found[0].url;
  }
  async function lookup(store,fetcher=fetch) {
    const key=storeKey(store);if(!key)return {url:null,reason:'Адрес не является витриной 1688'};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
    let reader;
    try {
      const response=await fetcher(key,{credentials:'include',redirect:'error',signal:controller.signal});
      if(!response.ok)return {url:null,reason:`Фоновое чтение вернуло HTTP ${response.status}`};
      if(response.url && storeKey(response.url)!==key)return {url:null,reason:'Ответ относится к другому магазину или входу в аккаунт'};
      if(!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || ''))return {url:null,reason:'Вместо HTML получен другой формат'};
      if(Number(response.headers.get('content-length'))>MAX_BYTES)return {url:null,reason:'HTML превышает допустимый размер'};
      reader=response.body.getReader();const decoder=new TextDecoder();let bytes=0,text='';
      while(true) {
        const {done,value}=await reader.read();if(done)break;
        bytes+=value.byteLength;if(bytes>MAX_BYTES)return {url:null,reason:'HTML превышает допустимый размер'};
        text+=decoder.decode(value,{stream:true});
      }
      text+=decoder.decode();return fromPage(text,key);
    } catch {return {url:null,reason:'Фоновое чтение недоступно или превышено время ожидания'};}
    finally {clearTimeout(timer);controller.abort();if(reader)await reader.cancel().catch(()=>{});}
  }
  globalThis.OpenLinks1688={storeKey,isMessenger,route,fromPage,cached,lookup};
})();
