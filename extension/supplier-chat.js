// Alibaba/Made-in-China engine, rebuilt around open-supplier-chat.user.js.
// This module also loads in the worker; DOM access is confined to create().
(() => {
  const ENGINE='supplier-chat-v2', POLL_MS=700, RETRY_MS=5000, TIMEOUT_MS=20000, MAX_ATTEMPTS=3;
  const sites={
    alibaba:{buttons:['a.icbu-alitalk','.im-alitalk-container a','.icbu-alitalk'],
      roots:'.send-box-container,[class*="weblite"],[class*="im-lite"]',
      editors:'textarea.send-textarea',sends:'button.send-tool-button'},
    mic:{buttons:['a.J-open-tm','.webtm-chat-now-tip-button','a.tm-placeholder'],
      roots:'.webtm-lite-content-visible,.webtm-chat-window,.webtm-content',
      editors:'.webtm-input[contenteditable],textarea.webtm-input',sends:'.webtm-send-button'},
  };
  const EDITORS='textarea,[contenteditable="true"],[contenteditable="plaintext-only"]';
  const ACTIONS='a,button,[role="button"],input[type="submit"],input[type="button"]';
  const SEND=/^(send|send message|发送|发送消息|立即发送|отправить|отправить сообщение)[.!！。:：\s]*$/iu;
  const CHAT=/^(chat now|chat|live chat|chat with supplier|пообщаться сейчас|начать чат|чат с продавцом|在线洽谈)[.!！。:：\s]*$/iu;
  const supports=platform=>Object.hasOwn(sites,platform);
  function isMessenger(raw,platform) {
    try {
      const u=new URL(raw);if(u.protocol!=='https:' || u.username || u.password || u.port)return false;
      return platform==='alibaba'?u.hostname==='onetalk.alibaba.com' && u.pathname.startsWith('/message/'):
        platform==='mic'?u.hostname==='webim.made-in-china.com' && /^\/super-tm(?:\/|$)/.test(u.pathname):false;
    } catch{return false;}
  }
  function create(platform,env) {
    const config=sites[platform];if(!config)return null;
    const {all,visible,isInquiry,labels,selectorFor,obstacle,profileFor}=env;
    let run=null;
    const large=node=>visible(node) && node.getBoundingClientRect().width>250 && node.getBoundingClientRect().height>250;
    const active=node=>node.isConnected && !node.matches(':disabled') && node.getAttribute('aria-disabled')!=='true';
    function frameVisibility() {
      return all('iframe',true).filter(node=>isMessenger(node.src,platform))
        .map(node=>({url:node.src,visible:large(node)}));
    }
    function login() {
      return all('.mb-dialog,.tnh-login').some(node=>node.matches('[class*="login"]') || node.querySelector('[class*="login"],input[type="password"]'));
    }
    function button(profile) {
      // New teaching explicitly overrides built-ins; legacy contact lessons are
      // filtered before this module. Hidden fallback is for known site hooks only.
      if(profile.contact) {
        const nodes=all(profile.contact).filter(node=>!isInquiry(node) && active(node));
        if(nodes.length===1)return {node:nodes[0],selector:profile.contact};
        if(nodes.length>1)return {ambiguous:true};
      }
      for(const selector of config.buttons) {
        const nodes=all(selector,true).filter(node=>!isInquiry(node) && active(node));
        const node=nodes.find(visible) || nodes[0];
        if(node)return {node,selector};
      }
      const fallback=all(ACTIONS).filter(node=>active(node) && !isInquiry(node) && labels(node).some(label=>CHAT.test(label)));
      if(fallback.length===1)return {node:fallback[0],selector:selectorFor(fallback[0])};
      return {ambiguous:fallback.length>1};
    }
    function inspect(raw={}) {
      const profile=profileFor(raw),frames=frameVisibility();
      const diagnostics={engine:ENGINE,adapter:platform,page:location.origin+location.pathname,editors:0,sends:0,chatRoots:0,contacts:0,
        chatFrames:frames.filter(frame=>frame.visible).length,inquiriesIgnored:0,learning:profile._learning};
      const blocked=obstacle() || (login()?'Открылось окно входа. Войдите в аккаунт в этой вкладке и нажмите «Проверить снова».':'');
      if(blocked)return {kind:'obstacle',obstacle:blocked,engine:ENGINE,diagnostics,frames};
      if(/inquir|inquer|enquir|quotation|\brfq\b/i.test(location.pathname))return {kind:'inquiry',engine:ENGINE,diagnostics,frames,reason:'Открыта форма запроса. Нужна страница магазина с кнопкой чата.'};
      const messenger=isMessenger(location.href,platform);
      const widgets=platform==='alibaba'?all('[class*="weblite"],[class*="im-lite"]').filter(large):all('.webtm-lite-content-visible');
      const opened=messenger || widgets.length>0 || frames.some(frame=>frame.visible);
      const roots=profile._root?[profile._root]:all(profile.chat || config.roots+',[data-chat-root],[data-chat],.chat-panel,.conversation');
      // A real messenger document supplies chat context even when its internal
      // class names change. Storefront inquiry forms never supply that context.
      if(messenger && document.body)roots.push(document.body);
      const validEditor=node=>!node.disabled && !node.readOnly && !isInquiry(node) && !node.closest('[role="search"]') &&
        !/search|搜索|查找|feedback/i.test([node.name,node.id,node.getAttribute('placeholder'),node.getAttribute('aria-label')].join(' '));
      const editors=all(profile.editor || EDITORS).filter(validEditor);
      const sends=all(profile.send || config.sends+','+ACTIONS).filter(node=>!isInquiry(node) &&
        (profile.send || node.matches(config.sends) || labels(node).some(label=>SEND.test(label))));
      const pairs=[];
      for(const editor of editors)for(const send of sends) {
        const root=roots.find(root=>root.contains(editor) && root.contains(send));
        if(root)pairs.push({editor,send,root});
      }
      Object.assign(diagnostics,{editors:editors.length,sends:sends.length,chatRoots:roots.length,
        inquiriesIgnored:all(ACTIONS).filter(isInquiry).length});
      const base={engine:ENGINE,opened,diagnostics,frames};
      if(pairs.length===1)return {...base,kind:'chat',opened:true,...pairs[0]};
      if(pairs.length>1)return {...base,kind:'ambiguous',opened:true,reason:'В чате несколько полей или кнопок отправки. Покажите нужное поле.'};
      if(opened)return {...base,kind:'waiting',reason:'Окно чата открыто. Жду редактор сообщения внутри чата.'};
      const contact=button(profile);diagnostics.contacts=contact.node?1:0;
      if(contact.ambiguous)return {...base,kind:'ambiguous',reason:'Неизвестный шаблон: несколько разных кнопок. Покажите кнопку чата.'};
      if(contact.node)return {...base,kind:'contact',contact:contact.node,key:contact.selector,href:null};
      if(diagnostics.inquiriesIgnored)return {...base,kind:'inquiry',reason:'Найдена форма запроса, а не редактор чата. Жду кнопку чата.'};
      return {...base,kind:'waiting',reason:'Жду штатную кнопку чата Alibaba/Made-in-China.'};
    }
    function click(found) {
      if(found.kind!=='contact' || !active(found.contact) || isInquiry(found.contact))return false;
      // Always invoke the site's handler, including anchors with an HTTPS href.
      // Native handlers may prevent navigation and pass the current supplier ID.
      found.contact.scrollIntoView({block:'center'});
      found.contact.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
      found.contact.click();return true;
    }
    function stop(token) {
      if(!run || (token && run.token!==token))return;
      clearTimeout(run.timer);run.cancelled=true;run=null;
    }
    function status(){return run?{token:run.token,status:run.status,attempts:run.attempts}:null;}
    function start(request) {
      if(run?.token===request.token)return {ok:true,opening:status()};
      stop();
      const current={token:request.token,jobId:request.jobId,at:request.at,attempts:request.attempts || 0,lastClick:request.lastClick || 0,status:'opening',cancelled:false};
      run=current;
      const notify=(phase,extra={})=>chrome.runtime.sendMessage({type:'CHAT_OPEN_EVENT',jobId:current.jobId,token:current.token,phase,...extra});
      const end=async(phase,reason)=>{
        current.status=phase;
        await notify(phase,{reason}).catch(()=>{});
      };
      const poll=async()=>{
        if(current.cancelled || run!==current)return;
        try {
          const found=inspect(request.profile);
          if(found.obstacle){await end('blocked',found.obstacle);return;}
          if(found.opened){await end('opened','Окно чата стало видимым. Перехожу к редактору.');return;}
          if(Date.now()-current.at>=TIMEOUT_MS){await end('timeout','За 20 секунд окно чата не открылось. Нужен ваш обучающий клик.');return;}
          if(found.kind==='contact' && current.attempts<MAX_ATTEMPTS && (!current.lastClick || Date.now()-current.lastClick>=RETRY_MS)) {
            // Worker persists/authorizes each opening attempt. Pause, stale
            // tabs and lost replies cannot silently start additional clicks.
            const permit=await notify('attempt',{attempt:current.attempts+1,selector:found.key,hidden:!visible(found.contact)});
            if(current.cancelled || run!==current || !permit?.ok){stop(current.token);return;}
            current.attempts++;current.lastClick=Date.now();
            const fresh=inspect(request.profile);
            if(fresh.obstacle){await end('blocked',fresh.obstacle);return;}
            if(fresh.opened){await end('opened','Чат открылся до повторного клика.');return;}
            click(fresh);
          }
          if(!current.cancelled && run===current)current.timer=setTimeout(poll,POLL_MS);
        } catch {await end('error','Не удалось проверить интерфейс открытия чата. Обновите страницу или покажите кнопку.');}
      };
      current.timer=setTimeout(poll,POLL_MS);
      return {ok:true,opening:status()};
    }
    return {inspect,click,start,stop,status};
  }
  globalThis.OpenLinksSupplierChat={ENGINE,POLL_MS,RETRY_MS,TIMEOUT_MS,MAX_ATTEMPTS,supports,isMessenger,create};
})();
