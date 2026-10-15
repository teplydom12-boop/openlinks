(() => {
  if (globalThis.__openlinksInstalled) return;
  globalThis.__openlinksInstalled = true;
  const CONTACT = /^(contact supplier|contact now|contact us|chat now|chat with supplier|send inquiry|send enquiry|inquire now|inquiry|联系卖家|联系供应商|联系我们|立即咨询|在线咨询|立即询价|询盘|发询盘|在线洽谈|联系商家|Связаться с поставщиком|Написать поставщику)$/iu;
  const SEND = /^(send|send message|send inquiry|send enquiry|submit inquiry|submit enquiry|发送|发送消息|发送询盘|提交询盘|立即发送|Отправить|Отправить запрос)$/iu;
  const SUCCESS = /^(message sent[.!]?|your message has been sent[.!]?|inquiry sent[.!]?|your inquiry has been sent[.!]?|发送成功[！!。]?|消息发送成功[！!。]?|询盘发送成功[！!。]?|Сообщение отправлено[.!]?)$/iu;
  const EDITORS = 'textarea,[contenteditable="true"],[role="textbox"][contenteditable]';
  const ACTIONS = 'a,button,[role="button"],input[type="submit"],input[type="button"]';
  const OUTGOING = '[data-direction="outgoing"],[data-is-self="true"],.message-outgoing,.message-self,.msg-self,.msg-sent,.message-right,.im-message-right';
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
    return all(fallback).filter(node=>labels(node).some(label=>label.length<100 && regex.test(label)));
  }
  function obstacle() {
    const challenges = all('#nc_1_wrapper,.nc-container,.geetest_panel,[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i],iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],#baxia-dialog-content');
    if(challenges.length) return 'Обнаружена проверка CAPTCHA. Пройдите её вручную и нажмите «Проверить снова».';
    const text = (document.body?.innerText || '').slice(0,50000);
    if(/too many requests|unusual traffic|access denied|访问过于频繁|操作太频繁|您的访问受限|请求过于频繁|滑动验证|安全验证|verify you are human/i.test(text)) return 'Сайт показал ограничение доступа или проверку безопасности. Очередь остановлена.';
    if(all('input[type="password"]').length || /\/(?:login|signin)(?:[/.?]|$)/i.test(location.href)) return 'Нужен вход в аккаунт. Войдите вручную в этой вкладке.';
    return '';
  }
  function inspect(profile) {
    const blocked=obstacle();
    if(blocked) return {kind:'obstacle',obstacle:blocked};
    const editors=all(profile.editor || EDITORS).filter(node=>!node.disabled && !node.readOnly && !node.closest('[role="search"]') && !/search|搜索|查找/i.test([node.name,node.id,node.getAttribute('placeholder'),node.getAttribute('aria-label')].join(' ')));
    // A valid form may initially have a disabled Send button until text is entered.
    const sends=candidates(profile.send,ACTIONS,SEND);
    if(editors.length && sends.length) {
      if(editors.length!==1 || sends.length!==1) return {kind:'ambiguous',reason:'Найдено несколько полей сообщения или кнопок отправки. Уточните CSS-селекторы.'};
      return {kind:'form',editor:editors[0],send:sends[0]};
    }
    if(editors.length>1) return {kind:'ambiguous',reason:'На странице несколько текстовых полей. Укажите селектор сообщения в настройках.'};
    const contacts=candidates(profile.contact,ACTIONS,CONTACT);
    const unique=[];
    for(const node of contacts) {
      const href=node.tagName==='A' && node.getAttribute('href') ? node.href : '';
      if(href && unique.some(other=>other.href===href)) continue;
      unique.push({node,href});
    }
    if(unique.length>1) return {kind:'ambiguous',reason:'На странице несколько разных контактов. Откройте нужный чат вручную или задайте селектор контакта.'};
    if(unique.length===1) {
      const {node,href}=unique[0];
      // javascript:, aliim: and wangwang: are not navigated by the extension.
      return {kind:'contact',contact:node,href:/^https:\/\//i.test(href) && href!==location.href ? href : null};
    }
    return {kind:'waiting'};
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
    if(found.kind!=='form') return {ok:false,reason:found.obstacle || found.reason || 'Не найдена однозначная форма сообщения'};
    const current=textOf(found.editor);
    if(current && current!==norm(request.message)) return {ok:false,reason:'В поле уже есть другой текст. Расширение не перезаписывает чужой черновик.'};
    if(!current) { fill(found.editor,request.message); await new Promise(resolve=>setTimeout(resolve,350)); }
    if(textOf(found.editor)!==norm(request.message)) return {ok:false,reason:'Сайт не принял текст. Проверьте редактор вручную.'};
    const reason=validation(found.send);
    if(reason) return {ok:false,reason};
    if(found.send.disabled || found.send.getAttribute('aria-disabled')==='true') return {ok:false,reason:'Кнопка отправки недоступна. Проверьте обязательные поля или ограничения сайта.'};
    return {ok:true,pageUrl:location.href,evidence:evidence(request.profile,request.message)};
  }
  function handle(request) {
    const profile=request.profile || {};
    if(request.type==='PROBE') {
      const found=inspect(profile);
      return {kind:found.kind,obstacle:found.obstacle,reason:found.reason,href:found.href};
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
      if(found.kind!=='form') return {clicked:false,reason:found.reason || found.obstacle || 'Форма изменилась'};
      if(textOf(found.editor)!==norm(request.message)) return {clicked:false,reason:'Текст изменился. Отправка остановлена.'};
      const reason=validation(found.send);
      if(reason) return {clicked:false,reason};
      if(found.send.disabled || found.send.getAttribute('aria-disabled')==='true') return {clicked:false,reason:'Кнопка отправки недоступна'};
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
