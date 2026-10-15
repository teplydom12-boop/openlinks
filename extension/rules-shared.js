// Shared pure helpers for the service worker and classic content scripts.
(() => {
  const domains={alibaba:'alibaba.com','1688':'1688.com',mic:'made-in-china.com'};
  const fields=new Set(['contact','editor','send','chat']);
  const infrastructure1688=new Set(['www','air','login','passport','my','buyer','seller','workbench','detail','offer','h5api','m','xstore','security','auth','trade','order','cart','search','s','sale','show','club','service','member','help','cbu','marketing','im','message','accounts','account','app','api','open']);
  function is1688Storefront(host) {
    const match=host.match(/^([a-z0-9-]+)\.1688\.com$/i);
    return !!match && !infrastructure1688.has(match[1].toLowerCase());
  }
  function platform(url) {
    const u=new URL(url);
    if(u.protocol!=='https:' || u.username || u.password || u.port) throw new Error('Недопустимый адрес страницы');
    return Object.keys(domains).find(key=>u.hostname===domains[key] || u.hostname.endsWith('.'+domains[key]));
  }
  function scopeFor(url) {
    const u=new URL(url),p=platform(url);
    if(!p) throw new Error('Площадка не поддерживается');
    const suffix=p==='alibaba'?(u.hostname.endsWith('.trustpass.alibaba.com')?'.trustpass.alibaba.com':'.en.alibaba.com'):p==='mic'?'.en.made-in-china.com':null;
    const storefront=(suffix && u.hostname.endsWith(suffix)) || (p==='1688' && is1688Storefront(u.hostname));
    return {host:storefront?(suffix?'*'+suffix:'*.shop.1688.com'):u.hostname,
      path:storefront?'/':u.pathname.slice(0,u.pathname.lastIndexOf('/')+1)||'/'};
  }
  function matches(rule,url) {
    try {
      const u=new URL(url);
      if(platform(url)!==rule.platform) return false;
      const host=rule.scope.host;
      const hostOk=host==='*.shop.1688.com'?is1688Storefront(u.hostname):host.startsWith('*.')?u.hostname.endsWith(host.slice(1)):u.hostname===host;
      return hostOk && u.pathname.startsWith(rule.scope.path);
    } catch {return false;}
  }
  function upgradeRule(rule) {
    // v3 tied named storefronts to individual suppliers. Keep the original ID,
    // selector and path while sharing that template across storefront subdomains.
    if(!rule?.scope?.host || rule.scope.host.includes('*')) return rule;
    try {
      const scope=scopeFor('https://'+rule.scope.host+rule.scope.path);
      if(platform('https://'+rule.scope.host)!==rule.platform) return rule;
      return scope.host.startsWith('*.')?{...rule,scope:{...rule.scope,host:scope.host}}:rule;
    } catch {return rule;}
  }
  function mergeRule(rules,rule) {
    return [...rules.filter(old=>!(old.platform===rule.platform && old.field===rule.field && old.selector===rule.selector && old.tag===rule.tag && old.label===rule.label && old.scope.host===rule.scope.host && old.scope.path===rule.scope.path)),rule];
  }
  function makeRule(data,url,expectedPlatform) {
    const p=platform(url);
    if(p!==expectedPlatform || !fields.has(data.field) || typeof data.selector!=='string' || !data.selector.trim() || data.selector.length>500) throw new Error('Неверное правило обучения');
    const selectors=[...new Set([data.selector,...(Array.isArray(data.selectors)?data.selectors:[])])].filter(value=>typeof value==='string' && value.trim() && value.length<=500).slice(0,12);
    return {id:crypto.randomUUID(),platform:p,...(p==='1688'?{}:{engine:'supplier-chat-v2'}),field:data.field,selector:data.selector,selectors,tag:String(data.tag||'').toLowerCase().slice(0,30),
      label:String(data.label||'').slice(0,80),scope:scopeFor(url),createdAt:Date.now()};
  }
  function direct1688(raw) {
    try {
      const u=new URL(raw);
      if(platform(raw)!=='1688' || u.hostname!=='air.1688.com' || !/\/def_cbu_web_im(?:_core)?\/index\.html$/.test(u.pathname)) return null;
      const recipient=u.searchParams.get('touid') || u.searchParams.get('chatId');
      if(!recipient || recipient.length>200) return null;
      // Never retain a buyer UID, session token, challenge or authentication query.
      const permitted=new Set(['touid','chatId','siteid','status','spmid','spm']);
      if([...u.searchParams.keys()].some(key=>!permitted.has(key))) return null;
      for(const key of [...u.searchParams.keys()]) if(!['touid','chatId','siteid','status'].includes(key)) u.searchParams.delete(key);
      u.hash=u.hash.startsWith('#/')?'/':'';return u.href;
    } catch {return null;}
  }
  globalThis.OpenLinksRules={platform,scopeFor,matches,makeRule,upgradeRule,mergeRule,direct1688,is1688Storefront};
})();
