(() => {
  if (globalThis.__openlinksInstalled) return;
  globalThis.__openlinksInstalled = true;
  const CONTACT = /^(chat now|chat with supplier|start chat|live chat|online chat|chat online|chat|talk to supplier|联系卖家|联系供应商|立即咨询|在线咨询|在线洽谈|在线交谈|立即沟通|联系商家|Написать в чат|Чат с продавцом|Пообщаться сейчас|Начать чат)$/iu;
  const SEND = /^(send|send message|发送|发送消息|立即发送|Отправить|Отправить сообщение)$/iu;
  const INQUIRY = /inquir|inquer|enquir|quotation|request[\s_-]*(?:a[\s_-]*)?quote|\brfq\b|msgsend|询盘|询价|запрос|заявк/iu;
  const EDITORS = 'textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"][contenteditable]';
  const ACTIONS = 'a,button,[role="button"],input[type="submit"],input[type="button"]';
  const CHAT_ROOT = '[data-chat-root],[data-chat],[class~="chat"],[id*="chat" i],[class*="chat-panel" i],[class*="chat-window" i],[class*="chat-container" i],[class*="conversation" i],[class*="messenger" i],[role="dialog"][aria-label*="chat" i]';
  const host=location.hostname;
  const site=host==='alibaba.com' || host.endsWith('.alibaba.com') ? 'alibaba' : host==='1688.com' || host.endsWith('.1688.com') ? '1688' : host==='made-in-china.com' || host.endsWith('.made-in-china.com') ? 'mic' : 'generic';
  // Public structural hooks observed in the supplied saved pages. Prefer the
  // storefront header over repeated toolbars; never merge different recipients.
  const CONTACT_REGIONS={
    '1688':['#pcV2WangWang'],
  };
  const supplierChat=globalThis.OpenLinksSupplierChat?.create(site,{all,visible,isInquiry,labels,selectorFor,obstacle,profileFor:effectiveProfile});
  const sentOps = new Set();
  const preparedEditors = new WeakMap();
  const previewOperations=new Map(),previewEditors=new WeakMap();
  let nativeInput=null, pendingClose=null, chatReadiness=null, contactMarker=null;
  let picker=null;
  let challenge=null;
  const norm = value => String(value || '').replace(/\r\n/g,'\n').trim();
  function visible(node) {
    if (!(node instanceof Element)) return false;
    const rect=node.getBoundingClientRect(), style=getComputedStyle(node);
    return rect.width>2 && rect.height>2 && style.visibility!=='hidden' && style.display!=='none' && style.opacity!=='0' && !node.closest('[hidden],[aria-hidden="true"],[inert]');
  }
  function all(selector,includeHidden=false) {
    // Search open shadow roots as well as the document, without relying on generated classes.
    const result=[];
    function visit(root) {
      result.push(...root.querySelectorAll(selector));
      for(const element of root.querySelectorAll('*')) if(element.shadowRoot) visit(element.shadowRoot);
    }
    visit(document); return includeHidden?result:result.filter(visible);
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
    const basic=candidates('',ACTIONS,CONTACT);
    if(basic.length || site!=='1688') return basic;
    const service=all('a,button,[role="button"],div,span').filter(node=>norm(node.innerText)==='客服' && ![...node.children].some(child=>visible(child)&&norm(child.innerText)==='客服'));
    return [...new Set(service.map(node=>node.closest('a,button,[role="button"],#pcV2WangWang') || node))];
  }
  function unavailable(node) {
    return !node.isConnected || !visible(node) || node.matches(':disabled') || node.getAttribute('aria-disabled')==='true' || getComputedStyle(node).pointerEvents==='none';
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
  function closeControl() {
    if(site!=='1688') return null;
    const panels=all('.J_MIDDLEWARE_FRAME_WIDGET').filter(panel=>[...panel.querySelectorAll('iframe')].some(frame=>visible(frame)&&frame.getAttribute('src')?.includes('_____tmd_____/punish')));
    if(panels.length!==1) return null;
    const close=[...panels[0].children].filter(node=>visible(node) && (node.matches('button[aria-label="Close"],button[aria-label="关闭"],[role="button"][aria-label="Close"]') || (node.tagName==='IMG' && getComputedStyle(node).cursor==='pointer' && node.getBoundingClientRect().width<=40 && node.getBoundingClientRect().height<=40)));
    return close.length===1?close[0]:null;
  }
  function dismissal() {
    const control=closeControl();
    if(!control){challenge=null;return null;}
    if(challenge?.control!==control)challenge={control,key:crypto.randomUUID()};
    return challenge;
  }
  function storeChatRoute() {
    if(site!=='1688' || !globalThis.OpenLinks1688?.storeKey(location.href))return null;
    // Isolated scripts cannot access window.pageData. Parse the inline JSON as
    // data instead; never execute the supplier's saved JavaScript in the worker.
    const scripts=[...document.scripts].filter(script=>/\bwindow\.pageData\s*=/.test(script.textContent));
    return globalThis.OpenLinks1688.fromPage(scripts.map(script=>script.textContent).join('\n'),location.href).url;
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
    if(supplierChat)return supplierChat.inspect(profile);
    profile=effectiveProfile(profile);
    const blocked=obstacle();
    if(blocked) return {kind:'obstacle',obstacle:blocked};
    const chatFrames=all('iframe.webtm-lite-iframe,iframe.weblite-iframe,iframe.layout-iframe[src*="def_cbu_web_im_core"]').length;
    const diagnostics={adapter:site,page:location.origin+location.pathname,editors:0,sends:0,chatRoots:0,contacts:0,chatFrames,inquiriesIgnored:0,learning:profile._learning};
    // A custom selector cannot turn an inquiry page into a live conversation.
    if(INQUIRY.test(location.pathname)) return {kind:'inquiry',reason:'Открыта страница запроса/Inquiry. Нужен чат продавца; запрос отправляться не будет.',diagnostics};
    const editors=all(profile.editor || EDITORS).filter(node=>!node.disabled && !node.readOnly && !node.closest('[role="search"]') && !/search|搜索|查找/i.test([node.name,node.id,node.getAttribute('placeholder'),node.getAttribute('aria-label')].join(' ')));
    // A valid form may initially have a disabled Send button until text is entered.
    const rawSends=candidates(profile.send,ACTIONS,SEND);
    const sends=rawSends.filter(node=>!isInquiry(node));
    const roots=profile._root?[profile._root]:all(profile.chat || (site==='alibaba' ? CHAT_ROOT+',.send-box-container' : CHAT_ROOT));
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
      return {kind:'contact',contact:node,href:/^https:\/\//i.test(href) && href!==location.href ? href : null,key:selectorFor(node),diagnostics};
    }
    const inquiryButtons=all(ACTIONS).filter(isInquiry);
    diagnostics.inquiriesIgnored=Math.max(diagnostics.inquiriesIgnored,inquiryButtons.length);
    // An opened chat frame can coexist with an inquiry form in the storefront.
    // Give its own content script time to load instead of treating that form as the chat.
    if(chatFrames) return {kind:'waiting',reason:'Найден встроенный фрейм чата. Жду его загрузки; редактор должен быть найден внутри самого фрейма.',diagnostics};
    if(inquiryButtons.length || editors.some(isInquiry)) return {kind:'inquiry',reason:'Найдена форма запроса, а не чат. Откройте Chat now / веб-чат в этой вкладке и повторите проверку.',diagnostics};
    return {kind:'waiting',diagnostics};
  }
  // Chromium can represent an ordinary typed space as NBSP in contenteditable
  // (seen in the supplied 1688 pre.edit). Keep every space and newline; only
  // equate these two representations. Do not collapse whitespace or strip ZWJ.
  const editorSpaces = value => String(value ?? '').replace(/\u00a0/g,' ');
  function draftText(value) {return norm(site==='1688'?editorSpaces(value):value);}
  function textOf(node) { return draftText('value' in node ? node.value : node.innerText); }
  function exactReplyText(value) {const text=String(value ?? '').replace(/\r\n/g,'\n');return site==='1688'?editorSpaces(text):text;}
  function exactEditorText(node) {return exactReplyText('value' in node?node.value:node.innerText);}
  document.addEventListener('input',event=>{
    if(!event.isTrusted)return;
    const editor=event.target?.closest?.(EDITORS),preview=editor&&previewEditors.get(editor);
    if(preview&&!preview.cleared&&!preview.cleaning&&nativeInput?.editor!==editor)preview.manualChanged=true;
  },true);
  function previewMatches(preview,token) {
    return preview&&['operation','platform','id','documentToken','sourceUrl','text'].every(key=>preview.token[key]===token[key]);
  }
  function previewCleanupEditor(token) {
    const identity=globalThis.OpenLinksDialogsReader?.guardPreviewCleanup(token);
    if(!identity?.ok)return {reason:identity?.reason||'Не подтверждён получатель тестового черновика.'};
    const found=inspect({});
    if(found.kind!=='chat')return {reason:'Редактор тестового черновика не подтверждён.'};
    let composer=found.editor.parentElement;while(composer&&!composer.contains(found.send))composer=composer.parentElement;
    if(!composer||[...composer.querySelectorAll('input[type="file"]')].some(input=>input.files?.length)||found.editor.querySelector('img,video,audio,iframe,object,[data-attachment]')||[...composer.querySelectorAll('[data-pending-attachment],[data-uploading="true"],.attachment-preview,.upload-preview,.file-preview,.image-preview,.upload-list,.file-list')].some(visible))return {reason:'В редакторе появилось вложение. Оно сохранено.'};
    return {found};
  }
  function checkPreviewEmpty(request) {
    // A fresh identity guard is useful only for observation, never deletion.
    // Do not focus, dispatch an input event or acquire ownership of this editor.
    const {found,reason}=previewCleanupEditor(request.guard);
    if(!found)return {empty:false,reason};
    return exactEditorText(found.editor)===''?{empty:true}:{empty:false,reason:'В поле есть текст. Он сохранён; очистите его вручную.'};
  }
  function clearPreview(request) {
    const token=request.token,preview=token&&previewOperations.get(token.operation),deny=reason=>({cleared:false,reason});
    const {found,reason}=previewCleanupEditor(token);
    if(!found)return deny(reason);
    // A user may clear the draft manually, or preparation may fail before fill.
    // Confirming an already empty, exact recipient/document performs no deletion.
    if(exactEditorText(found.editor)==='') {if(previewMatches(preview,token))preview.cleared=true;return {cleared:true};}
    if(!previewMatches(preview,token)||!preview.editor||!preview.editor.isConnected||previewEditors.get(preview.editor)!==preview)return deny('Владение тестовым черновиком потеряно. Очистите поле вручную.');
    if(found.editor!==preview.editor||found.send!==preview.send||preview.manualChanged||preview.cleared)return deny('Редактор или тестовый черновик изменены пользователем. Текст сохранён.');
    const prepared=preparedEditors.get(found.editor);
    if(prepared?.dialogOperation!==token.operation||prepared.previewOperation!==token.operation||exactEditorText(found.editor)!==exactReplyText(token.text))return deny('Текст тестового черновика изменился. Он сохранён.');
    preview.cleaning=true;
    try {
      // Delete only this owned text. No key, Enter, button click or new text.
      if(found.editor instanceof HTMLTextAreaElement||found.editor instanceof HTMLInputElement) {
        const proto=found.editor instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(found.editor,'');
      }else {
        const selection=getSelection(),range=document.createRange();found.editor.focus();range.selectNodeContents(found.editor);selection.removeAllRanges();selection.addRange(range);
        document.execCommand('delete',false);found.editor.replaceChildren();
      }
      found.editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContentBackward',data:null}));
      found.editor.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      if(exactEditorText(found.editor)!=='')return deny('Сайт не подтвердил очистку тестового черновика. Проверьте поле вручную.');
      // Filling an owned preview focuses this editor. Release that focus after
      // its explicit, verified cleanup so a newly approved operation does not
      // mistake our previous focus for a user currently typing in the chat.
      const focused=document.activeElement;
      if(focused===found.editor||found.editor.contains(focused))focused.blur();
      preview.cleared=true;preparedEditors.delete(found.editor);return {cleared:true};
    }finally{preview.cleaning=false;}
  }
  function guardedReply(request,found,{initial=false}={}) {
    if(!request.dialogGuard)return {ok:true};
    const guard=request.dialogGuard;
    if(typeof guard.operation!=='string' || !guard.operation || typeof request.message!=='string' || !request.message.trim() || request.message.length>6000)return {ok:false,reason:'Некорректное разрешение на ответ.'};
    if(guard.purpose==='wechat')return {ok:false,reason:'Продолжить переписку можно только после ответа поставщика на ваше обращение.'};
    const verified=globalThis.OpenLinksDialogsReader?.guardReply(guard,{preview:request.dialogPreview===true});
    if(!verified?.ok)return {ok:false,reason:verified?.reason || 'Проверка получателя недоступна. Обновите расширение и вкладку чата.'};
    if(!found)return verified;
    if(found.kind!=='chat')return {ok:false,reason:found.reason || found.obstacle || 'Не найден однозначный редактор чата.'};
    let composer=found.editor.parentElement;
    while(composer && !composer.contains(found.send))composer=composer.parentElement;
    if(!composer)return {ok:false,reason:'Редактор и кнопка отправки не связаны.'};
    // This path sends text only. Never accidentally submit a user's queued file
    // or image alongside an automatic reply, including hidden file inputs.
    const queuedFile=[...composer.querySelectorAll('input[type="file"]')].some(input=>input.files?.length);
    const queuedMedia=found.editor.querySelector('img,video,audio,iframe,object,[data-attachment]') || [...composer.querySelectorAll('[data-pending-attachment],[data-uploading="true"],.attachment-preview,.upload-preview,.file-preview,.image-preview,.upload-list,.file-list')].some(visible);
    if(queuedFile || queuedMedia)return {ok:false,reason:'В редакторе есть вложение. Автоматический ответ остановлен.'};
    const prepared=preparedEditors.get(found.editor),owned=prepared?.dialogOperation===guard.operation && prepared.dialogSend===found.send;
    if(initial && !owned) {
      const raw=String('value' in found.editor?found.editor.value:found.editor.innerText ?? found.editor.textContent ?? '');
      if(raw || Object.values(verified.busy || {}).some(value=>value===true))return {ok:false,reason:'В чате есть ручной черновик или пользователь работает с редактором. Текст сохранён без изменений.'};
    } else if(!initial && !owned)return {ok:false,reason:'Редактор или подготовленная попытка ответа изменились.'};
    return {ok:true};
  }
  function chatReady(profile) {
    if(site!=='1688')return {ok:true};
    const found=inspect(profile);
    if(document.readyState!=='complete' || found.kind!=='chat' || found.editor.closest('[aria-busy="true"]')) {
      chatReadiness=null;
      return {ok:false,waiting:true,waitMs:1000,reason:'Жду полной загрузки страницы и редактора 1688'};
    }
    if(!chatReadiness || chatReadiness.editor!==found.editor || chatReadiness.send!==found.send || chatReadiness.url!==location.href)
      chatReadiness={editor:found.editor,send:found.send,url:location.href,at:Date.now()};
    const remaining=5000-(Date.now()-chatReadiness.at);
    return remaining>0?{ok:false,waiting:true,waitMs:1000,reason:'Чат 1688 загружен; жду 5 секунд готовности редактора перед вводом'}:{ok:true};
  }
  function nativeEdit(request) {
    if(request.stage==='release') {
      if(nativeInput?.token===request.token){nativeInput.editor.removeAttribute('data-openlinks-input');nativeInput=null;}
      return {ok:true};
    }
    if(site!=='1688' || location.href!==request.expectedUrl)return {ok:false,reason:'Адрес чата изменился'};
    if(request.stage==='locate') {const ready=chatReady(request.profile);if(!ready.ok)return ready;}
    const found=inspect(request.profile),editor=found.editor;
    if(found.kind!=='chat')return {ok:false,reason:'Редактор чата изменился'};
    const guarded=guardedReply(request,found);if(!guarded.ok)return guarded;
    // Check the message before the click and after both keys, not halfway
    // through the browser's temporary representation of the inserted space.
    if(request.stage!=='space' && textOf(editor)!==draftText(request.message))return {ok:false,reason:'Черновик изменился'};
    if(request.stage==='locate') {
      nativeInput?.editor.removeAttribute('data-openlinks-input');
      nativeInput={token:request.token,editor};
      editor.setAttribute('data-openlinks-input',request.token);
      editor.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
      return {ok:true};
    }
    const operation=nativeInput;
    let active=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
    if(!operation || operation.token!==request.token || editor!==operation.editor || active!==editor)return {ok:false,reason:'Фокус ушёл из редактора чата'};
    if(request.stage==='focus') {
      if('selectionStart' in editor)editor.setSelectionRange(editor.value.length,editor.value.length);
      else {const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}
    }
    // Do not delete a character after the user moved the caret or selected text.
    if('selectionStart' in editor) {
      if(editor.selectionStart!==editor.value.length || editor.selectionEnd!==editor.value.length)return {ok:false,reason:'Курсор перемещён'};
    } else {
      const selection=getSelection();
      if(!selection?.isCollapsed || !selection.rangeCount || !editor.contains(selection.anchorNode))return {ok:false,reason:'Курсор перемещён'};
      const tail=selection.getRangeAt(0).cloneRange();tail.setEnd(editor,editor.childNodes.length);
      if(tail.toString())return {ok:false,reason:'Курсор перемещён'};
    }
    if(request.stage==='done') {
      preparedEditors.set(editor,{...preparedEditors.get(editor),text:draftText(request.message),method:'chrome-mouse-keyboard',native:true});
    }
    return {ok:true};
  }
  function fill(editor,message) {
    editor.focus();
    let method='native-value';
    if(editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const proto=editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(editor,'');
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContentBackward',data:null}));
      editor.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      Object.getOwnPropertyDescriptor(proto,'value').set.call(editor,message);
    } else {
      // Native editing updates rich-editor models; textContent alone only paints
      // a draft and can leave 1688's Send button inactive. insertText never parses HTML.
      const selection=getSelection(),range=document.createRange();
      range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
      if(editor.childNodes.length)document.execCommand('delete',false);
      // Chromium can leave a <br> or formatting wrappers after native deletion.
      // Clear those too before notifying the editor and inserting the new text.
      editor.replaceChildren();
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContentBackward',data:null}));
      editor.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
      method='native-insertText';
      if(!document.execCommand('insertText',false,message)) {
        editor.textContent=message;method='input-events';
      }
    }
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:message}));
    editor.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    // Some legacy composers recalculate availability on keyup. Never synthesize
    // Enter or another shortcut that could submit the draft.
    editor.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,composed:true,key:'Unidentified'}));
    preparedEditors.set(editor,{text:draftText(message),method});
    return method;
  }
  function validation(send) {
    if(!send.form) return '';
    const invalid=[...send.form.elements].filter(el=>el.willValidate && !el.validity.valid && visible(el));
    return invalid.length ? 'На форме есть незаполненные или неверные обязательные поля. Заполните их вручную.' : '';
  }
  function composerConsumed(found,request) {
    // Observe only local draft consumption, never delivery/read receipts. Hidden
    // tabs throttle timers, so an emptied editor must not wait for a timer tick.
    return new Promise(resolve=>{
      const deadline=performance.now()+1200;
      let settled=false,timer;
      const finish=accepted=>{
        if(settled)return;
        settled=true;
        observer.disconnect();clearTimeout(timer);
        found.editor.removeEventListener('input',check);
        found.editor.removeEventListener('change',check);
        removeEventListener('pagehide',navigating);
        removeEventListener('hashchange',check);
        removeEventListener('popstate',check);
        resolve(accepted);
      };
      const check=()=>{
        if(settled)return;
        try {
          if(performance.now()>deadline || location.href!==request.expectedUrl || obstacle() || !found.editor.isConnected || !visible(found.editor))return finish(false);
          // Sending itself may change history. Recheck document and recipient
          // without requiring the pre-send history fingerprint to stay equal.
          if(request.dialogGuard && !globalThis.OpenLinksDialogsReader?.guardPreviewCleanup(request.dialogGuard)?.ok)return finish(false);
          if(!textOf(found.editor))finish(true);
        }catch{finish(false);}
      };
      const navigating=()=>finish(false);
      const observer=new MutationObserver(check);
      check();
      if(settled)return;
      observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});
      // Document observers do not cross shadow roots.
      if(found.editor.getRootNode()!==document)observer.observe(found.editor,{subtree:true,childList:true,characterData:true,attributes:true});
      found.editor.addEventListener('input',check);
      found.editor.addEventListener('change',check);
      addEventListener('pagehide',navigating);
      addEventListener('hashchange',check);
      addEventListener('popstate',check);
      timer=setTimeout(()=>finish(false),1200);
    });
  }
  async function prepare(request) {
    const context=guardedReply(request);if(!context.ok)return context;
    const operation=request.dialogGuard?.operation;
    if(previewOperations.has(operation)&&request.dialogPreview!==true)return {ok:false,reason:'Тестовую операцию нельзя преобразовать в отправку.'};
    if(request.dialogPreview===true&&(!request.dialogGuard||!operation||sentOps.has(operation)))return {ok:false,reason:'Не подтверждена отдельная тестовая операция.'};
    const ready=chatReady(request.profile);if(!ready.ok)return ready;
    const found=inspect(request.profile);
    if(found.kind!=='chat') return {ok:false,reason:found.obstacle || found.reason || 'Не найден однозначный редактор внутри чата. Форма запроса не используется.'};
    const ownedPreview=previewEditors.get(found.editor);
    if(ownedPreview&&!ownedPreview.cleared&&(request.dialogPreview!==true||ownedPreview.token.operation!==operation))return {ok:false,reason:'В поле находится тестовый черновик. Сначала завершите или очистите тест.'};
    const guard=guardedReply(request,found,{initial:true});if(!guard.ok)return guard;
    let preview;
    if(request.dialogPreview===true) {
      const token={operation,platform:request.dialogGuard.platform,id:request.dialogGuard.id,documentToken:request.dialogGuard.documentToken,sourceUrl:request.dialogGuard.sourceUrl,text:request.message};
      preview=previewOperations.get(operation);
      if(preview&&(!previewMatches(preview,token)||preview.cleared||preview.manualChanged||preview.editor!==found.editor||preview.send!==found.send))return {ok:false,reason:'Тестовый черновик или его редактор изменился.'};
      if(!preview){preview={token,editor:found.editor,send:found.send,cleared:false,manualChanged:false};previewOperations.set(operation,preview);}
    }
    const current=textOf(found.editor);
    if(request.dialogGuard && preparedEditors.get(found.editor)?.dialogOperation===request.dialogGuard.operation && current!==draftText(request.message))return {ok:false,reason:'Подготовленный ответ изменён вручную. Текст сохранён без изменений.'};
    const mustFill=!current || current!==draftText(request.message) || preparedEditors.get(found.editor)?.text!==draftText(request.message) || (site!=='1688' && request.reactivate);
    const draftReplaced=!!current && !!mustFill,reply=result=>({draftReplaced,...result,...(preview?{preview:true}:{})});
    if(site==='1688' && request.reactivate && preparedEditors.has(found.editor))preparedEditors.get(found.editor).native=false;
    let inputMethod=preparedEditors.get(found.editor)?.method || 'existing-draft';
    // The user requested replacing existing drafts in the selected chat editor.
    if(mustFill) {
      inputMethod=fill(found.editor,request.message);
      if(request.dialogGuard)Object.assign(preparedEditors.get(found.editor),{dialogOperation:request.dialogGuard.operation,dialogSend:found.send});
      if(preview){preparedEditors.get(found.editor).previewOperation=operation;previewEditors.set(found.editor,preview);}
      await new Promise(resolve=>setTimeout(resolve,350));
    }
    const fresh=inspect(request.profile);
    if(fresh.kind!=='chat' || fresh.editor!==found.editor) return reply({ok:false,reason:fresh.reason || fresh.obstacle || 'Интерфейс чата изменился при заполнении'});
    const rechecked=guardedReply(request,fresh);if(!rechecked.ok)return reply(rechecked);
    if(request.dialogGuard && exactEditorText(fresh.editor)!==exactReplyText(request.message))return reply({ok:false,reason:'Текст ответа изменился, включая пробелы. Отправка остановлена.'});
    if(textOf(fresh.editor)!==draftText(request.message)) return reply({ok:false,reason:'Сайт не принял текст. Проверьте редактор вручную.'});
    const reason=validation(fresh.send);
    if(reason) return reply({ok:false,reason});
    if(site==='1688' && !preparedEditors.get(fresh.editor)?.native)return reply({ok:false,needsNativeInput:true,pageUrl:location.href});
    if(unavailable(fresh.send)) return reply({ok:false,reason:'Кнопка отправки недоступна. Проверьте обязательные поля или ограничения сайта.'});
    return reply({ok:true,pageUrl:location.href,inputMethod});
  }
  function effectiveProfile(raw={}) {
    const profile={...raw},seen=new Set(),resolved={};
    const learning={saved:(raw.rules || []).length,scoped:0,applied:[],rejected:[]};
    for(const rule of [...(raw.rules || [])].reverse()) {
      if(['alibaba','mic'].includes(site) && rule.field==='contact' && rule.engine!=='supplier-chat-v2') {
        learning.rejected.push('contact: правило прежнего механизма сохранено, но отключено');continue;
      }
      if(!globalThis.OpenLinksRules?.matches(rule,location.href))continue;
      learning.scoped++;
      if(seen.has(rule.field))continue;
      for(const selector of rule.selectors || [rule.selector])try {
        const nodes=all(selector);
        if(nodes.length===1 && (!rule.tag || nodes[0].localName===rule.tag) && (!rule.label || norm(nodes[0].getAttribute('aria-label') || nodes[0].innerText).toLowerCase()===rule.label.toLowerCase())) {
          profile[rule.field]=selector;seen.add(rule.field);resolved[rule.field]=nodes[0];learning.applied.push(rule.field+': '+selector);break;
        } else learning.rejected.push(rule.field+': '+selector+' — '+(nodes.length!==1?`видимых совпадений ${nodes.length}`:'изменился тип или текст элемента'));
      } catch {learning.rejected.push(rule.field+': некорректный селектор');}
    }
    // A positional root learned on one template can shift on the next shop.
    // Derive it from two independently validated, learned endpoints instead.
    if(resolved.editor && resolved.send && !isInquiry(resolved.editor) && !isInquiry(resolved.send)) {
      let root=resolved.editor.parentElement;
      while(root && !root.contains(resolved.send))root=root.parentElement;
      if(root && !root.matches('body,html')) {profile._root=root;learning.derivedRoot=true;}
    }
    profile._learning=learning;
    return profile;
  }
  function selectorsFor(node) {
    const unique=selector=>{try{return all(selector).length===1 && all(selector)[0]===node;}catch{return false;}};
    const choices=[];
    const add=selector=>{if(unique(selector) && !choices.includes(selector))choices.push(selector);};
    const tag=node.localName;
    for(const attr of ['data-testid','data-action','name','aria-label','placeholder']) {
      const value=node.getAttribute(attr);
      if(value && value.length<=80)add(`${tag}[${attr}="${CSS.escape(value)}"]`);
    }
    const classes=[...node.classList].filter(c=>!/^(gray|active|disabled|selected|focus|hover|hide|show|undefined)$|^(css|sc|jsx)[-_]|\d{4}|[a-f0-9]{10}/i.test(c)).slice(0,4);
    for(let count=1;count<=classes.length;count++)add(tag+classes.slice(0,count).map(c=>'.'+CSS.escape(c)).join(''));
    if(node.id && /^[a-z_][\w:-]{0,70}$/i.test(node.id) && !/\d{4}|[a-f0-9]{10}|:r\d/i.test(node.id))add('#'+CSS.escape(node.id));
    if(choices.length)return choices.slice(0,12);
    let path='',current=node;
    for(let depth=0;current?.localName && depth<5;depth++,current=current.parentElement) {
      const siblings=current.parentElement?[...current.parentElement.children].filter(n=>n.localName===current.localName):[current];
      path=current.localName+`:nth-of-type(${siblings.indexOf(current)+1})`+(path?' > '+path:'');
      if(unique(path))return [path];
    }
    throw new Error('Не удалось составить однозначное правило. Выберите саму кнопку или поле.');
  }
  function selectorFor(node) {return selectorsFor(node)[0];}
  function stopPicker() {
    if(!picker)return;
    document.removeEventListener('click',picker.listener,true);document.removeEventListener('pointerdown',picker.guard,true);picker.host.remove();picker=null;
  }
  function startPicker(request) {
    supplierChat?.stop();
    stopPicker();
    const host=document.createElement('div');host.dataset.openlinksPicker='true';host.style.pointerEvents='none';
    const shadow=host.attachShadow({mode:'open'}),box=document.createElement('div');
    box.style.cssText='position:fixed;top:10px;right:10px;max-width:420px;pointer-events:none;z-index:2147483647;background:#102b33;color:white;padding:14px 18px;border-radius:9px;font:14px/1.5 Arial;box-shadow:0 3px 20px #0005';
    const message=document.createElement('span'),cancel=document.createElement('button');
    const names={contact:'кнопку открытия чата (например 客服)',editor:'поле сообщения',send:'кнопку отправки в чат',chat:'общую область с полем сообщения и кнопкой отправки'};
    message.textContent=`OpenLinks: нажмите ${names[request.field]}. Правило будет сохранено.${request.field==='contact'?' Затем откроется чат.':request.field==='send'?' Затем будет выполнена одна отправка с учётом лимита.':''}`;
    cancel.textContent='Отмена';cancel.style.cssText='margin-left:15px;padding:5px 12px;cursor:pointer;pointer-events:auto';
    box.append(message,cancel);shadow.append(box);document.documentElement.append(host);
    const listener=async event=>{
      if(event.composedPath().includes(host) || !event.isTrusted)return;
      event.preventDefault();event.stopImmediatePropagation();if(picker?.busy)return;picker.busy=true;
      try {
        let node=event.composedPath().find(item=>item instanceof Element);
        if(['send','contact'].includes(request.field))node=node.closest('a,button,[role="button"],#pcV2WangWang') || node;
        if(!node || isInquiry(node))throw new Error('Это элемент формы запроса. Укажите элемент именно чата.');
        if(request.field==='chat' && node.matches('body,html'))throw new Error('Укажите контейнер диалога, а не всю страницу.');
        if(request.field==='editor' && !node.matches(EDITORS))throw new Error('Укажите само поле сообщения.');
        const selectors=selectorsFor(node),selector=selectors[0],profile=effectiveProfile(request.profile),data={type:'LEARN_PICK',token:request.token,field:request.field,selector,selectors,tag:node.localName,label:''};
        if(['contact','send'].includes(request.field))data.label=norm(node.getAttribute('aria-label') || node.innerText).slice(0,80);
        if(['editor','send'].includes(request.field)) {
          const editor=request.field==='editor'?node:all(profile.editor || EDITORS).filter(n=>!isInquiry(n));
          const send=request.field==='send'?node:candidates(profile.send,ACTIONS,SEND).filter(n=>!isInquiry(n));
          const e=Array.isArray(editor)?(editor.length===1?editor[0]:null):editor;
          const s=Array.isArray(send)?(send.length===1?send[0]:null):send;
          if(e&&s) {
            let root=e.parentElement;while(root && !root.contains(s))root=root.parentElement;
            if(root && !root.matches('body,html') && !isInquiry(e) && !isInquiry(s))data.chatSelector=selectorFor(root);
          }
        }
        const reply=await chrome.runtime.sendMessage(data);
        if(!reply?.ok)throw new Error(reply?.error || 'Не удалось сохранить правило');
        if(picker?.token===request.token)stopPicker();
      } catch(error) {message.textContent='OpenLinks: '+error.message;if(picker?.token===request.token)picker.busy=false;}
    };
    const guard=event=>{if(event.isTrusted && !event.composedPath().includes(host)){event.preventDefault();event.stopImmediatePropagation();}};
    picker={host,listener,guard,busy:false,token:request.token};document.addEventListener('pointerdown',guard,true);document.addEventListener('click',listener,true);
    cancel.addEventListener('click',()=>{chrome.runtime.sendMessage({type:'LEARN_CANCEL',token:request.token}).catch(()=>{});stopPicker();});
    return {ok:true};
  }
  function handle(request) {
    const profile=request.profile || {};
    if(request.type==='CHAT_READY')return chatReady(profile);
    if(request.type==='NATIVE_INPUT')return nativeEdit(request);
    if(request.type==='ARM_CLOSE') {
      if(location.href!==request.expectedUrl)return {ok:false};
      if(pendingClose)clearTimeout(pendingClose.timer);
      const closing=pendingClose={token:request.token,url:location.href,changed:false};
      if(!request.guardOnly)closing.timer=setTimeout(()=>chrome.runtime.sendMessage({type:'CHAT_CLOSE_DUE',token:closing.token}).catch(()=>{}),Math.max(0,request.at-Date.now()));
      return {ok:true};
    }
    if(request.type==='CAN_CLOSE')return {ok:!!pendingClose && pendingClose.token===request.token && pendingClose.url===location.href && !pendingClose.changed};
    if(request.type==='PROBE') {
      const found=inspect(profile);
      const close=dismissal();
      return {kind:found.kind,obstacle:found.obstacle,canDismiss:!!close,dismissKey:close?.key,reason:found.reason,href:found.href,key:found.key,diagnostics:found.diagnostics,chatRoute:found.obstacle?null:storeChatRoute(),engine:found.engine,opened:found.opened,frames:found.frames,opening:supplierChat?.status()};
    }
    if(request.type==='OPEN_CHAT')return supplierChat?supplierChat.start(request):{ok:false,reason:'Новый механизм доступен только Alibaba и Made-in-China'};
    if(request.type==='STOP_OPEN_CHAT'){supplierChat?.stop(request.token);return {ok:true};}
    if(request.type==='PICK_START')return startPicker(request);
    if(request.type==='PICK_STOP'){stopPicker();return {ok:true};}
    if(request.type==='DISMISS_CHALLENGE')return (async()=>{
      const current=dismissal();
      if(!current || (request.dismissKey && current.key!==request.dismissKey))return {clicked:false};
      current.control.click();
      if(!visible(current.control) || !current.control.isConnected)challenge=null;
      await new Promise(resolve=>setTimeout(resolve,150));
      const closed=closeControl()!==current.control;
      if(closed)challenge=null;
      return {clicked:true,closed,key:current.key};
    })();
    if(request.type==='CONTACT') {
      const found=inspect(profile);
      if(found.kind!=='contact') return {ok:false,reason:found.reason || found.obstacle || 'Контакт изменился'};
      if(found.contact.closest('form')||found.contact.form||found.contact.matches(':disabled')||found.contact.getAttribute('aria-disabled')==='true')return {ok:false,reason:'Кнопка чата недоступна либо находится в форме. Открытие остановлено.'};
      const href=found.contact.getAttribute('href') || '';
      if(/^[a-z][a-z\d+.-]*:/i.test(href.trim())&&!/^\s*(https?:|javascript:)/i.test(href)) return {ok:false,reason:'Контакт открывается во внешнем приложении. Откройте веб-чат вручную.'};
      // The worker invokes this exact marker through Chrome with userGesture
      // so native popups can open without replacing window.open or page events.
      if(contactMarker?.node)contactMarker.node.removeAttribute('data-openlinks-contact');
      contactMarker={node:found.contact,token:crypto.randomUUID()};
      found.contact.setAttribute('data-openlinks-contact',contactMarker.token);
      return {ok:true,key:found.key,contactToken:contactMarker.token,pageUrl:location.href};
    }
    if(request.type==='PREPARE') return prepare(request);
    if(request.type==='DIALOGS_CLEAR_PREVIEW')return clearPreview(request);
    if(request.type==='DIALOGS_CHECK_PREVIEW_EMPTY')return checkPreviewEmpty(request);
    if(request.type==='SEND') return (async()=>{
      const operation=request.attemptId || request.jobId;
      if(request.dialogPreview===true||[operation,request.jobId,request.dialogGuard?.operation].some(id=>previewOperations.has(id)))return {clicked:false,reason:'Тестовая операция не имеет права отправлять сообщения.'};
      // Content scripts cannot read TRUSTED_CONTEXTS storage. Ask the worker via
      // its read-only guard outside the command queue, then recheck the DOM.
      try {
        const allowed=await chrome.runtime.sendMessage({type:'OPENLINKS_TEST_SEND_GUARD',scope:request.dialogGuard?'dialog':'outreach',jobId:request.jobId,attemptId:operation,expectedUrl:request.expectedUrl,message:request.message,...(request.dialogGuard?{dialogOperation:request.dialogGuard.operation,dialogId:request.dialogGuard.id}:{})});
        if(allowed?.ok!==true||allowed.canSend!==true) {
          const reasonCode=typeof allowed?.reasonCode==='string'&&/^[a-z0-9_-]{1,80}$/i.test(allowed.reasonCode)?allowed.reasonCode:undefined;
          return {clicked:false,notAttempted:!sentOps.has(operation),permissionReasonCode:reasonCode,reason:'Не подтверждена текущая разрешённая попытка отправки. Обновите состояние очереди.'+(reasonCode?' Код: '+reasonCode+'.':'')};
        }
      }
      catch{return {clicked:false,notAttempted:!sentOps.has(operation),reason:'Не удалось проверить текущую попытку отправки. Отправка остановлена.'};}
      if(sentOps.has(operation)) return {clicked:false,reason:'Эта попытка уже выполнялась. Повтор запрещён.'};
      if(location.href!==request.expectedUrl) return {clicked:false,reason:'Адрес страницы изменился. Проверьте получателя.'};
      const found=inspect(profile);
      if(found.kind!=='chat') return {clicked:false,reason:found.reason || found.obstacle || 'Чат больше не доступен; форма запроса не используется'};
      if(previewEditors.get(found.editor)&&!previewEditors.get(found.editor).cleared)return {clicked:false,reason:'Тестовый черновик нельзя отправлять.'};
      const guard=guardedReply(request,found);if(!guard.ok)return {clicked:false,reason:guard.reason};
      if(request.dialogGuard && exactEditorText(found.editor)!==exactReplyText(request.message))return {clicked:false,reason:'Текст ответа изменился, включая пробелы. Отправка остановлена.'};
      if(textOf(found.editor)!==draftText(request.message)) return {clicked:false,reason:'Текст изменился. Отправка остановлена.'};
      const reason=validation(found.send);
      if(reason) return {clicked:false,reason};
      if(unavailable(found.send)) return {clicked:false,reason:'Кнопка отправки недоступна'};
      sentOps.add(operation);
      found.send.click();
      if(site!=='1688')return {clicked:true};
      if(await composerConsumed(found,request))return {clicked:true,accepted:true};
      return {clicked:true,accepted:false,reason:'После нажатия редактор 1688 не очистился либо чат изменился. Проверьте сообщение вручную; очередь остановлена, автоматического повтора нет.'};
    })();
    return {ok:false,reason:'Неизвестная команда'};
  }
  chrome.runtime.onMessage.addListener((request,sender,respond)=>{
    if(sender.id!==chrome.runtime.id || !['PROBE','CONTACT','PREPARE','SEND','DIALOGS_CLEAR_PREVIEW','DIALOGS_CHECK_PREVIEW_EMPTY','PICK_START','PICK_STOP','DISMISS_CHALLENGE','OPEN_CHAT','STOP_OPEN_CHAT','NATIVE_INPUT','ARM_CLOSE','CAN_CLOSE','CHAT_READY'].includes(request.type)) return;
    Promise.resolve().then(()=>handle(request)).then(respond,error=>respond({ok:false,kind:'ambiguous',reason:'Ошибка селектора или формы: '+error.message}));
    return true;
  });
  addEventListener('pagehide',()=>{supplierChat?.stop();if(pendingClose)pendingClose.changed=true;});
  // A new manual draft makes this a conversation the user is working in.
  document.addEventListener('input',event=>{if(event.isTrusted && pendingClose)pendingClose.changed=true;},true);
  document.addEventListener('pointerdown',event=>{if(event.isTrusted && pendingClose)pendingClose.changed=true;},true);
  chrome.runtime.sendMessage({type:'PAGE_READY',chatRoute:obstacle()?null:storeChatRoute()}).catch(()=>{});
})();
