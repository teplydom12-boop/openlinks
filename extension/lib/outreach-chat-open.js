// A captured native contact URL may include login bootstrap data. Keep it
// transient in this capture/validation path and out of its logs. Existing job
// navigation state separately tracks browser URLs. Unknown routes fail closed.
export function capturedContactURL(value,platform,store) {
  try {
    if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020\u007f]/.test(value))return null;
    const url=new URL(value),source=new URL(store);
    if(url.protocol!=='https:'||url.username||url.password||url.port||!/^https:\/\/[^/:?#]+\//.test(value))return null;
    if(platform==='1688')return globalThis.OpenLinks1688.route(value);
    // Observed supplier widget URL, not the account's full-inbox bootstrap.
    // Its refer origin ties the native handler's recipient to this storefront.
    if(platform!=='mic'||url.origin!=='https://webim.made-in-china.com'||url.pathname!=='/super-tm/'||url.search)return null;
    const match=/^#\/chat\/([A-Za-z0-9]+_[0-9]+)\?(.+)$/.exec(url.hash);
    if(!match)return null;
    const params=new URLSearchParams(match[2]),keys=[...params.keys()];
    if(keys.length!==4||new Set(keys).size!==4||keys.some(key=>!['data','refer','isLiteTM','isSAChat'].includes(key))||!params.get('data')||!['true','false'].includes(params.get('isLiteTM'))||params.get('isSAChat')!=='false')return null;
    const refer=new URL(params.get('refer'));
    if(refer.origin!==source.origin||refer.username||refer.password||refer.port)return null;
    return value;
  } catch {return null;}
}

// Serialized into one exact document's MAIN world. The worker arms the top
// document and the contact frame before invoking the native handler. Guards
// last until navigation: restoring window.open after the synchronous click
// would let delayed site handlers create a foreground popup later.
export function controlledContact(request) {
  const blocked=reason=>({ok:false,reason});
  try {
    if(location.href!==request.pageUrl)return blocked('document_changed');
    const key=Symbol.for('openlinks.outreach.popup-guard.v1');
    let guard=document[key];
    const matches=selector=>{
      const nodes=[];const visit=root=>{nodes.push(...root.querySelectorAll(selector));for(const element of root.querySelectorAll('*'))if(element.shadowRoot)visit(element.shadowRoot);};visit(document);return nodes;
    };
    if(!guard) {
      if(request.action==='read')return blocked('guard_missing');
      guard={urls:[],invalid:''};
      const capture=value=>{
        if(typeof value!=='string'||value.length>8192||!value||value==='about:blank'){guard.invalid='empty_popup';return null;}
        if(!guard.urls.includes(value))guard.urls.push(value);
        if(guard.urls.length>1){guard.urls.length=1;guard.invalid='ambiguous_popup';}
        return null;
      };
      const replacements={open:capture,focus:()=>{}};
      for(const name of Object.keys(replacements)) {
        const descriptor=Object.getOwnPropertyDescriptor(window,name);
        if(descriptor&&!descriptor.configurable&&(!Object.hasOwn(descriptor,'value')||!descriptor.writable))return blocked('guard_unavailable');
      }
      for(const [name,value] of Object.entries(replacements)) {
        Object.defineProperty(window,name,{configurable:false,enumerable:true,writable:false,value});
        if(window[name]!==value)return blocked('guard_unavailable');
      }
      // Cancel only synthetic link defaults. Native click handlers still run;
      // their preventDefault calls tell us not to use the anchor as a fallback.
      // This also catches async anchor.click(), including an inherited base target.
      window.addEventListener('click',event=>{
        if(event.isTrusted)return;
        const anchor=event.composedPath().find(node=>node instanceof HTMLAnchorElement);
        if(!anchor)return;
        const href=anchor.getAttribute('href');
        if(!href)return;
        const alreadyCancelled=event.defaultPrevented;
        let cancelled=alreadyCancelled;
        const original=event.preventDefault;
        try {
          Object.defineProperties(event,{
            preventDefault:{configurable:true,value(){cancelled=true;return original.call(this);}},
            // Preserve the handler-visible cancellation state while blocking
            // only the browser's default navigation underneath it.
            defaultPrevented:{configurable:true,get:()=>cancelled},
            returnValue:{configurable:true,get:()=>!cancelled,set:value=>{if(value===false)cancelled=true;}},
          });
        } catch {guard.invalid='event_guard_unavailable';}
        Event.prototype.preventDefault.call(event);
        // Microtasks run after all native handlers and their synchronous opens.
        queueMicrotask(()=>{
          if(cancelled||guard.urls.length)return;
          if(/^\s*(?:javascript:|#)/i.test(href))return;
          let target;try{target=new URL(href,document.baseURI).href;}catch{guard.invalid='invalid_anchor';return;}
          capture(target);
        });
      },true);
      Object.defineProperty(document,key,{value:guard});
    }
    if(request.action==='click') {
      if(typeof request.token!=='string'||!/^[a-f\d-]{36}$/i.test(request.token))return blocked('invalid_marker');
      const nodes=matches('[data-openlinks-contact="'+request.token+'"]');
      if(nodes.length!==1)return blocked('contact_changed');
      const contact=nodes[0];contact.removeAttribute('data-openlinks-contact');
      if(!contact.isConnected||contact.closest('form')||contact.form||contact.matches(':disabled')||contact.getAttribute('aria-disabled')==='true'||contact.closest('[inert]'))return blocked('unsafe_control');
      // Do not erase captures from an earlier asynchronous attempt.
      if(!guard.urls.length&&!guard.invalid) {
        contact.scrollIntoView({block:'center'});
        contact.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
        HTMLElement.prototype.click.call(contact);
      }
    }
    // A Promise lets the anchor fallback microtask finish before returning.
    return Promise.resolve().then(()=>guard.invalid?blocked(guard.invalid):({ok:true,urls:[...guard.urls]}));
  } catch {return blocked('controlled_click_failed');}
}
