(() => {
  if (globalThis.__openlinksInstalled) return;
  globalThis.__openlinksInstalled = true;
  const CONTACT = /^(chat now|chat with supplier|start chat|live chat|online chat|chat online|chat|talk to supplier|联系卖家|联系供应商|立即咨询|在线咨询|在线洽谈|在线交谈|立即沟通|联系商家|Написать в чат|Чат с продавцом|Пообщаться сейчас|Начать чат)$/iu;
  const SEND = /^(send|send message|发送|发送消息|立即发送|Отправить|Отправить сообщение)$/iu;
  const SUCCESS = /^(message sent[.!]?|your message has been sent[.!]?|发送成功[！!。]?|消息发送成功[！!。]?|Сообщение отправлено[.!]?)$/iu;
  const INQUIRY = /inquir|inquer|enquir|quotation|request[\s_-]*(?:a[\s_-]*)?quote|\brfq\b|msgsend|询盘|询价|запрос|заявк/iu;
  const EDITORS = 'textarea,[contenteditable="true"],[role="textbox"][contenteditable]';
  const ACTIONS = 'a,button,[role="button"],input[type="submit"],input[type="button"]';
  const OUTGOING = '[data-direction="outgoing"],[data-is-self="true"],.message-outgoing,.message-self,.msg-self,.msg-sent,.message-right,.im-message-right';
  const CHAT_ROOT = '[data-chat-root],[data-chat],[class~="chat"],[id*="chat" i],[class*="chat-panel" i],[class*="chat-window" i],[class*="chat-container" i],[class*="conversation" i],[class*="messenger" i],[role="dialog"][aria-label*="chat" i]';
  const host=location.hostname;
  const site=host==='alibaba.com' || host.endsWith('.alibaba.com') ? 'alibaba' : host==='1688.com' || host.endsWith('.1688.com') ? '1688' : host==='made-in-china.com' || host.endsWith('.made-in-china.com') ? 'mic' : 'generic';
  // Public structural hooks observed in the supplied saved pages. Prefer the
  // storefront header over repeated toolbars; never merge different recipients.
  const CONTACT_REGIONS={
    alibaba:['.shop-sign-container a.icbu-alitalk','.bc-shop-shopsign-new a.icbu-alitalk','#J_Toolbar a.icbu-alitalk'],
    mic:['.shop-sign__btns-wrap a.J-open-tm','.details-footer a.J-open-tm','.info-block.bottom a.J-open-tm'],
    '1688':['#pcV2WangWang'],
  };
  const sentOps = new Set();
  const norm = value => String(value || '').replace(/\r\n/g,'\n').trim();
  function visible(node) {
    if (!(node instanceof Element)) return false;
    const rect=node.getBoundingClientRect(), style=getComputedStyle(node);
    return rect.width>2 && rect.height>2 && style.visibility!=='hidden' && style.display!=='none' && style.opacity!=='0' && !node.closest('[hidden],[aria-hidden="true"],[inert]');
  }
  function all(selector) {
    // Search open shadow roots as well as the document, without relying on generated classes.
    const result=[];
    function visit(root) {
      result.push(...root.querySelectorAll(selector));
      for(const element of root.querySelectorAll('*')) if(element.shadowRoot) visit(element.shadowRoot);
    }
    visit(document); return result.filter(visible);
  }
  function labels(node) { return [node.getAttribute('aria-label'),node.getAttribute('title'),node.value,node.innerText].filter(Boolean).map(norm); }
  function candidates(selector, fallback, regex) {
    if(selector) return all(selector);
    return all(fallback).filter(node=>labels(node).some(label=>label.length<100 && regex.test(label.replace(/[\s.!！。:：]+$/u,''))));
  }
  function contactCandidates(profile) {
    if(profile.contact) return all(profile.contact);
    for(const selector of CONTACT_REGIONS[site] || []) {
      const found=all(selector).filter(node=>!isInquiry(node));
      if(found.length) return found;
    }
    // Made-in-China's tm-placeholder is an unbound visual stub, not a chat action.
    return candidates('',ACTIONS,CONTACT).filter(node=>!(site==='mic' && node.classList.contains('tm-placeholder')));
  }
  function unavailable(node) {
    return node.disabled || node.getAttribute('aria-disabled')==='true' ||
      (site==='alibaba' && node.matches('button.send-tool-button.gray'));
  }
  function isInquiry(node) {
    const names=node.matches(EDITORS) ? [node.getAttribute('aria-label'),node.getAttribute('title')] : labels(node);
    if(node.hasAttribute('fun-inquiry-supplier') || INQUIRY.test([...names,node.id,node.getAttribute('name') || '',node.getAttribute('href') || '',node.getAttribute('formaction') || ''].join(' '))) return true;
    const form=node.form || node.closest('form');
    if(!form) return false;
    if(INQUIRY.test([form.id,form.getAttribute('action') || '',form.getAttribute('name') || '',form.getAttribute('aria-label') || ''].join(' '))) return true;
    return [...form.querySelectorAll('input[type="email"],input[type="tel"],input[name*="subject" i],input[name*="quantity" i]')].some(visible);
  }
  function commonChat(editor,send,roots) {
    return roots.find(root=>root.contains(editor) && root.contains(send));
  }
  function obstacle() {
    const challenges = all('#nc_1_wrapper,.nc-container,.geetest_panel,[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i],iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],iframe[src*="_____tmd_____/punish"],#baxia-dialog-content');
    if(challenges.length) return 'Обнаружена проверка CAPTCHA. Пройдите её вручную и нажмите «Проверить снова».';
    const text = (document.body?.innerText || '').slice(0,50000);
    if(/too many requests|unusual traffic|access denied|访问过于频繁|操作太频繁|您的访问受限|请求过于频繁|滑动验证|安全验证|verify you are human/i.test(text)) return 'Сайт показал ограничение доступа или проверку безопасности. Очередь остановлена.';
    if(all('input[type="password"]').length || /\/(?:login|signin)(?:[/.?]|$)/i.test(location.href)) return 'Нужен вход в аккаунт. Войдите вручную в этой вкладке.';
    return '';
  }
  function inspect(profile) {
    const blocked=obstacle();
    if(blocked) return {kind:'obstacle',obstacle:blocked};
    const chatFrames=all('iframe.webtm-lite-iframe,iframe.weblite-iframe,iframe.layout-iframe[src*="def_cbu_web_im_core"]').length;
    const diagnostics={adapter:site,page:location.origin+location.pathname,editors:0,sends:0,chatRoots:0,contacts:0,chatFrames,inquiriesIgnored:0};
    // A custom selector cannot turn an inquiry page into a live conversation.
    if(INQUIRY.test(location.pathname)) return {kind:'inquiry',reason:'Открыта страница запроса/Inquiry. Нужен чат продавца; запрос отправляться не будет.',diagnostics};
    const editors=all(profile.editor || EDITORS).filter(node=>!node.disabled && !node.readOnly && !node.closest('[role="search"]') && !/search|搜索|查找/i.test([node.name,node.id,node.getAttribute('placeholder'),node.getAttribute('aria-label')].join(' ')));
    // A valid form may initially have a disabled Send button until text is entered.
    const rawSends=candidates(profile.send,ACTIONS,SEND);
    const sends=rawSends.filter(node=>!isInquiry(node));
    const roots=all(profile.chat || (site==='alibaba' ? CHAT_ROOT+',.send-box-container' : CHAT_ROOT));
    const pairs=[];
    for(const editor of editors) for(const send of sends) {
      const root=commonChat(editor,send,roots);
      if(root && !isInquiry(editor)) pairs.push({editor,send,root});
    }
    Object.assign(diagnostics,{editors:editors.length,sends:sends.length,chatRoots:roots.length,inquiriesIgnored:rawSends.length-sends.length});
    if(pairs.length>1) return {kind:'ambiguous',reason:'Найдено несколько редакторов или кнопок внутри чата. Уточните CSS-селекторы.',diagnostics};
    if(pairs.length===1) return {kind:'chat',...pairs[0],diagnostics};
    const rawContacts=contactCandidates(profile);
    const contacts=rawContacts.filter(node=>!isInquiry(node));
    diagnostics.contacts=contacts.length;
    diagnostics.inquiriesIgnored+=rawContacts.length-contacts.length;
    const unique=[];
    for(const node of contacts) {
      const href=node.tagName==='A' && node.getAttribute('href') ? node.href : '';
      if(href && unique.some(other=>other.href===href)) continue;
      unique.push({node,href});
    }
    if(unique.length>1) return {kind:'ambiguous',reason:'На странице несколько разных кнопок чата. Откройте нужный чат вручную или задайте селектор.',diagnostics};
    if(unique.length===1) {
      const {node,href}=unique[0];
      // javascript:, aliim: and wangwang: are not navigated by the extension.
      return {kind:'contact',contact:node,href:/^https:\/\//i.test(href) && href!==location.href ? href : null,diagnostics};
    }
    const inquiryButtons=all(ACTIONS).filter(isInquiry);
    diagnostics.inquiriesIgnored=Math.max(diagnostics.inquiriesIgnored,inquiryButtons.length);
    // An opened chat frame can coexist with an inquiry form in the storefront.
    // Give its own content script time to load instead of treating that form as the chat.
    if(chatFrames) return {kind:'waiting',reason:'Найден встроенный фрейм чата. Жду его загрузки; редактор должен быть найден внутри самого фрейма.',diagnostics};
    if(inquiryButtons.length || editors.some(isInquiry)) return {kind:'inquiry',reason:'Найдена форма запроса, а не чат. Откройте Chat now / веб-чат в этой вкладке и повторите проверку.',diagnostics};
    return {kind:'waiting',diagnostics};
  }
  function textOf(node) { return norm('value' in node ? node.value : node.innerText); }
  function evidence(profile,message) {
    const success=profile.success ? all(profile.success) : all('[role="alert"],[role="status"],.success,.success-tip,.success-message,h1,h2,h3,p,span').filter(node=>SUCCESS.test(norm(node.innerText)));
    return {
      successes:success.map(node=>norm(node.innerText)).filter(Boolean).sort(),
      outgoing:all(OUTGOING).filter(node=>norm(node.innerText)===norm(message)).length,
    };
  }
  function fill(editor,message) {
    editor.focus();
    if(editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const proto=editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(editor,message);
    } else {
      // Plain text only. Never interpret the message as markup.
      editor.textContent=message;
    }
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:message}));
    editor.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function validation(send) {
    if(!send.form) return '';
    const invalid=[...send.form.elements].filter(el=>el.willValidate && !el.validity.valid && visible(el));
    return invalid.length ? 'На форме есть незаполненные или неверные обязательные поля. Заполните их вручную.' : '';
  }
  async function prepare(request) {
    const found=inspect(request.profile);
    if(found.kind!=='chat') return {ok:false,reason:found.obstacle || found.reason || 'Не найден однозначный редактор внутри чата. Форма запроса не используется.'};
    const current=textOf(found.editor);
    if(current && current!==norm(request.message)) return {ok:false,reason:'В поле уже есть другой текст. Расширение не перезаписывает чужой черновик.'};
    if(!current) { fill(found.editor,request.message); await new Promise(resolve=>setTimeout(resolve,350)); }
    const fresh=inspect(request.profile);
    if(fresh.kind!=='chat' || fresh.editor!==found.editor || fresh.send!==found.send) return {ok:false,reason:fresh.reason || fresh.obstacle || 'Интерфейс чата изменился при заполнении'};
    if(textOf(found.editor)!==norm(request.message)) return {ok:false,reason:'Сайт не принял текст. Проверьте редактор вручную.'};
    const reason=validation(found.send);
    if(reason) return {ok:false,reason};
    if(unavailable(found.send)) return {ok:false,reason:'Кнопка отправки недоступна. Проверьте обязательные поля или ограничения сайта.'};
    return {ok:true,pageUrl:location.href,evidence:evidence(request.profile,request.message)};
  }
  function handle(request) {
    const profile=request.profile || {};
    if(request.type==='PROBE') {
      const found=inspect(profile);
      return {kind:found.kind,obstacle:found.obstacle,reason:found.reason,href:found.href,diagnostics:found.diagnostics};
    }
    if(request.type==='CONTACT') {
      const found=inspect(profile);
      if(found.kind!=='contact') return {ok:false,reason:found.reason || found.obstacle || 'Контакт изменился'};
      const href=found.contact.getAttribute('href') || '';
      if(href && !/^(https?:|#|javascript:)/i.test(href)) return {ok:false,reason:'Контакт открывается во внешнем приложении. Откройте веб-чат вручную.'};
      found.contact.click(); return {ok:true};
    }
    if(request.type==='PREPARE') return prepare(request);
    if(request.type==='SEND') {
      if(sentOps.has(request.jobId)) return {clicked:false,reason:'Эта попытка уже выполнялась. Повтор запрещён.'};
      if(location.href!==request.expectedUrl) return {clicked:false,reason:'Адрес страницы изменился. Проверьте получателя.'};
      const found=inspect(profile);
      if(found.kind!=='chat') return {clicked:false,reason:found.reason || found.obstacle || 'Чат больше не доступен; форма запроса не используется'};
      if(textOf(found.editor)!==norm(request.message)) return {clicked:false,reason:'Текст изменился. Отправка остановлена.'};
      const reason=validation(found.send);
      if(reason) return {clicked:false,reason};
      if(unavailable(found.send)) return {clicked:false,reason:'Кнопка отправки недоступна'};
      sentOps.add(request.jobId);
      found.send.click(); return {clicked:true};
    }
    if(request.type==='CHECK_SENT') {
      const blocked=obstacle();
      if(blocked) return {confirmed:false};
      const after=evidence(profile,request.message), before=request.evidence || {successes:[],outgoing:0};
      // Multiset difference: a pre-existing success banner cannot confirm a new send.
      const remaining=[...before.successes];
      let newSuccess=false;
      for(const text of after.successes) {
        const index=remaining.indexOf(text);
        if(index<0) newSuccess=true; else remaining.splice(index,1);
      }
      return {confirmed:newSuccess || after.outgoing>before.outgoing};
    }
    return {ok:false,reason:'Неизвестная команда'};
  }
  chrome.runtime.onMessage.addListener((request,sender,respond)=>{
    if(sender.id!==chrome.runtime.id || !['PROBE','CONTACT','PREPARE','SEND','CHECK_SENT'].includes(request.type)) return;
    Promise.resolve().then(()=>handle(request)).then(respond,error=>respond({ok:false,kind:'ambiguous',reason:'Ошибка селектора или формы: '+error.message}));
    return true;
  });
  chrome.runtime.sendMessage({type:'PAGE_READY'}).catch(()=>{});
})();
