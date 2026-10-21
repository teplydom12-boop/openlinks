// Give the marketplace's own contact handler a Chrome user gesture. This opens
// its normal popup/inline chat without replacing window.open or using OS input.
// The worker owns the active supplier tab and checks its document immediately
// before calling this helper; the marked node and exact URL are checked again
// inside that node's own MAIN-world execution context.
export function invokeNativeContact(request) {
  const fail=reason=>({ok:false,reason});
  try {
    // Keep this validation self-contained: CDP serializes this function.
    if(typeof request?.token!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(request.token))return fail('invalid_marker');
    if(location.href!==request.pageUrl||this.ownerDocument!==document)return fail('document_changed');
    const guard=Symbol.for('openlinks.outreach.popup-guard.v1');
    const guarded=()=>{
      if(document[guard])return true;
      try {return window.top!==window&&!!window.top.document[guard];}catch{return false;}
    };
    if(guarded())return {ok:false,reason:'reload_required',reloadRequired:true};
    if(!(this instanceof HTMLElement)||this.getAttribute('data-openlinks-contact')!==request.token)return fail('contact_changed');
    const safe=()=>this.isConnected&&this.ownerDocument===document&&!this.closest('form')&&!this.form&&!this.matches(':disabled')&&this.getAttribute('aria-disabled')!=='true'&&!this.closest('[inert]');
    if(!safe())return fail('unsafe_control');
    const external=()=>{const href=this.getAttribute('href')||'';return /^[a-z][a-z\d+.-]*:/i.test(href.trim())&&!/^\s*(https?:|javascript:)/i.test(href);};
    if(external())return fail('external_application');
    // Consume only this proven marker. A stale/unsafe node retains its marker
    // for the content script to replace, and can never be clicked here.
    this.removeAttribute('data-openlinks-contact');
    this.scrollIntoView({block:'center'});
    this.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    if(location.href!==request.pageUrl||!safe())return fail('contact_changed');
    if(external())return fail('external_application');
    if(guarded())return {ok:false,reason:'reload_required',reloadRequired:true};
    HTMLElement.prototype.click.call(this);
    return {ok:true};
  } catch {return fail('contact_click_failed');}
}

const explanations={
  invalid_marker:'Кнопка чата не подтверждена текущей проверкой.',
  document_changed:'Страница кнопки чата изменилась. Повторите проверку.',
  contact_changed:'Кнопка чата изменилась. Повторите проверку.',
  unsafe_control:'Кнопка чата недоступна либо находится в форме.',
  external_application:'Контакт открывается во внешнем приложении. Откройте веб-чат вручную.',
  reload_required:'В этой странице осталась старая фоновая защита. Обновите вкладку поставщика и повторите проверку.',
  contact_click_failed:'Не удалось выполнить штатное открытие чата.',
};
export async function clickNativeContact(job,markedReply,debuggerApi=chrome.debugger) {
  const token=markedReply?.contactToken,pageUrl=markedReply?.pageUrl;
  if(!Number.isInteger(job?.tabId)||job.tabId<0||markedReply?.ok!==true||typeof token!=='string'||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(token)||
    typeof pageUrl!=='string'||pageUrl.length>8192||!/^https:\/\//.test(pageUrl))return {ok:false,reason:explanations.invalid_marker};
  const target={tabId:job.tabId};let attached=false,searchId,objectId,result,clicked=false,attempted=false;
  const command=(method,params={})=>debuggerApi.sendCommand(target,method,params);
  try {
    await debuggerApi.attach(target,'1.3');attached=true;
    await command('DOM.getDocument',{depth:0});
    const search=await command('DOM.performSearch',{query:`[data-openlinks-contact="${token}"]`,includeUserAgentShadowDOM:true});
    searchId=search.searchId;
    if(search.resultCount!==1)throw new Error('contact_changed');
    const {nodeIds}=await command('DOM.getSearchResults',{searchId,fromIndex:0,toIndex:1});
    if(nodeIds?.length!==1||!Number.isInteger(nodeIds[0]))throw new Error('contact_changed');
    const resolved=await command('DOM.resolveNode',{nodeId:nodeIds[0]});
    objectId=resolved.object?.objectId;if(!objectId)throw new Error('contact_changed');
    attempted=true;
    const reply=await command('Runtime.callFunctionOn',{objectId,functionDeclaration:invokeNativeContact.toString(),arguments:[{value:{token,pageUrl}}],returnByValue:true,userGesture:true});
    if(reply.exceptionDetails)throw new Error('contact_click_failed');
    const value=reply.result?.value;
    clicked=value?.ok===true;
    result=clicked?{ok:true,key:markedReply.key,pageUrl}:{ok:false,reason:explanations[value?.reason]||explanations.contact_click_failed,...(value?.reloadRequired?{reloadRequired:true}:{})};
  } catch(error) {
    result={ok:false,reason:explanations[error?.message]||'Не удалось открыть чат через Chrome. Проверьте разрешение debugger и закройте DevTools этой вкладки.',...(attempted?{contactAttempted:true}:{})};
  } finally {
    if(attached&&searchId)await command('DOM.discardSearchResults',{searchId}).catch(()=>{});
    if(attached&&objectId)await command('Runtime.releaseObject',{objectId}).catch(()=>{});
    if(attached)try {await debuggerApi.detach(target);}catch {result={ok:false,reason:'Chrome не освободил подключение к вкладке после открытия чата. Закройте DevTools и повторите проверку.',...(clicked?{contactClicked:true}:{}),...(attempted?{contactAttempted:true}:{})};}
  }
  return result;
}
