// Serialized by chrome.scripting.executeScript into the top frame's MAIN world.
// Keep this function self-contained. The captured URL may contain authentication
// material: only the caller may use it, transiently, to navigate its owned tab.
export function captureMICChat() {
  const blocked=reason=>({ok:false,status:'blocked',reason,detail:'Не удалось безопасно открыть центр сообщений Made-in-China. Проверьте вкладку площадки.'});
  const waiting=reason=>({ok:false,status:'loading',reason,detail:'Ожидаю готовности центра сообщений Made-in-China.'});
  try {
    const page=new URL(location.href);
    // MIC may add tracking or UI state to the member-center URL. Keep the
    // origin/path fixed without mistaking those suffixes for a different page.
    if(window.top!==window||page.origin!=='https://membercenter.made-in-china.com'||page.pathname!=='/message/index.html'||page.username||page.password||page.port)return blocked('wrong_page');
    if(document.readyState!=='complete')return waiting('page_loading');
    const visible=element=>{
      if(!element?.isConnected)return false;
      const rect=element.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return false;
      for(let current=element;current;current=current.parentElement){
        if(current.hidden||current.inert||current.getAttribute('aria-hidden')==='true')return false;
        const style=getComputedStyle(current);
        if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
      }
      return true;
    };
    const visibleMatches=selector=>[...document.querySelectorAll(selector)].filter(visible);
    if(visibleMatches('#nc_1_wrapper,.nc-container,.geetest_panel,[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i],iframe[src*="recaptcha" i],iframe[src*="hcaptcha" i],iframe[src*="_____tmd_____/punish"],#baxia-dialog-content').length)return blocked('captcha');
    if(visibleMatches('input[type="password"]').length)return blocked('login');
    if(document.activeElement?.closest('input:not([type="hidden"]),textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))return blocked('user_editing');
    const wrappers=document.querySelectorAll('#webtm-wrapper');
    if(wrappers.length!==1)return wrappers.length?blocked('ambiguous_widget'):waiting('widget_loading');
    const widget=wrappers[0];
    for(const field of widget.querySelectorAll('textarea,input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]),[contenteditable]:not([contenteditable="false"]),[role="textbox"]')){
      if(String('value' in field?field.value:field.textContent||'').trim())return blocked('widget_draft');
    }
    const key=Symbol.for('openlinks.mic.chat-launch.v1');
    let attempt=document[key];
    if(!attempt){attempt=Object.seal({bubble:false,expand:false});Object.defineProperty(document,key,{value:attempt});}
    if(attempt.expand)return blocked('attempt_consumed');
    const fullButton='#webtm-wrapper .webtm-min-task-expanded .webtm-lite-content-visible button.webtm-full-btn';
    let expanded=visibleMatches(fullButton);
    if(expanded.length>1)return blocked('ambiguous_expand');
    const safeControl=element=>{
      if(element.closest('form')||element.form)return 'form_control';
      if(element.disabled||element.matches(':disabled')||element.closest('[aria-disabled="true"],[inert]')||getComputedStyle(element).pointerEvents==='none')return 'disabled_control';
      return '';
    };
    if(!expanded.length){
      if(attempt.bubble)return waiting('widget_expanding');
      const bubbles=visibleMatches('#webtm-wrapper .webtm-min-box[role="button"][aria-label="tm"]');
      if(bubbles.length!==1)return bubbles.length?blocked('ambiguous_bubble'):waiting('launcher_loading');
      const unsafe=safeControl(bubbles[0]);if(unsafe)return blocked(unsafe);
      attempt.bubble=true;
      try{HTMLElement.prototype.click.call(bubbles[0]);}catch{return blocked('bubble_failed');}
      // Let the caller immediately rescan newly visible child frames before
      // the next action. A fresh editor guard is still required before opening.
      expanded=visibleMatches(fullButton);
      if(expanded.length>1)return blocked('ambiguous_expand');
      return waiting(expanded.length?'widget_ready':'widget_expanding');
    }
    const control=expanded[0],unsafe=safeControl(control);if(unsafe)return blocked(unsafe);
    const original=Object.getOwnPropertyDescriptor(window,'open');
    if(original&&!original.configurable&&(!Object.hasOwn(original,'value')||!original.writable))return blocked('open_not_interceptable');
    let captured='',calls=0,invalid=false,handlerFailed=false,restored=false;
    // Return null exactly as a blocked popup does. Never invoke the original.
    const capture=url=>{calls++;if(typeof url!=='string'||url.length>4096)invalid=true;else if(calls===1)captured=url;return null;};
    const failed=()=>{handlerFailed=true;};
    try {
      Object.defineProperty(window,'open',original&&!original.configurable?{...original,value:capture}:{configurable:true,enumerable:original?.enumerable??true,writable:true,value:capture});
      if(Object.getOwnPropertyDescriptor(window,'open')?.value!==capture)return blocked('open_not_interceptable');
      attempt.expand=true;
      window.addEventListener('error',failed,true);
      try{HTMLElement.prototype.click.call(control);}catch{handlerFailed=true;}
    } finally {
      window.removeEventListener('error',failed,true);
      try{
        if(original)Object.defineProperty(window,'open',original);else delete window.open;
        const after=Object.getOwnPropertyDescriptor(window,'open');
        restored=original?!!after&&['value','get','set','writable','enumerable','configurable'].every(name=>after[name]===original[name]):!after;
      }catch{restored=false;}
    }
    if(!restored)return blocked('open_restore_failed');
    if(handlerFailed)return blocked('expand_failed');
    if(calls!==1||invalid)return blocked(calls>1?'ambiguous_open':'no_capture');
    // Refuse credentials, explicit ports (including :443), relative URLs and
    // empty/login routes. Do not include the captured string in error details.
    if(!/^https:\/\/webim\.made-in-china\.com\/super-tm\/(?:[?#]|$)/.test(captured)||/[\u0000-\u0020\u007f]/.test(captured))return blocked('invalid_chat_url');
    let url,fragment;
    try{url=new URL(captured);fragment=decodeURIComponent(url.hash.slice(1));}catch{return blocked('invalid_chat_url');}
    if(url.origin!=='https://webim.made-in-china.com'||url.pathname!=='/super-tm/'||url.username||url.password||url.port||!fragment.trim()||fragment==='/'||/^\/?(?:login|signin|sign-in)(?:[/?#&]|$)/i.test(fragment))return blocked('invalid_chat_url');
    return {ok:true,url:captured};
  } catch {return blocked('capture_failed');}
}
