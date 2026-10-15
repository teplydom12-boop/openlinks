// A real Chrome mouse click followed by Space and Backspace. DOM commands locate
// only the token-marked editor; no page code, clipboard or Enter is used.
export async function activate1688(job, call, debuggerApi = chrome.debugger) {
  if(job.platform!=='1688')throw new Error('Ввод клавиш разрешён только для чата 1688');
  const target={tabId:job.tabId},token=crypto.randomUUID();
  const settle=()=>new Promise(resolve=>setTimeout(resolve,100));
  let attached=false,searchId;
  const command=(method,params={})=>debuggerApi.sendCommand(target,method,params);
  const check=async stage=>{
    const reply=await call(job,job.frameId,'NATIVE_INPUT',{token,stage,expectedUrl:job.inputUrl});
    if(!reply?.ok)throw Object.assign(new Error(reply?.reason || 'Фокус или текст редактора изменился'),{inputFailure:'editor',inputStage:stage});
  };
  const key=async(type,key,code,keyCode,text)=>command('Input.dispatchKeyEvent',{
    type,key,code,windowsVirtualKeyCode:keyCode,...(text?{text,unmodifiedText:text}:{}),
  });
  try {
    await debuggerApi.attach(target,'1.3');attached=true;
    await check('locate');
    await command('DOM.getDocument',{depth:0});
    const search=await command('DOM.performSearch',{query:`[data-openlinks-input="${token}"]`,includeUserAgentShadowDOM:true});
    searchId=search.searchId;
    if(search.resultCount!==1)throw Object.assign(new Error('Chrome не нашёл одно поле для клика'),{inputFailure:'editor',inputStage:'locate'});
    const {nodeIds}=await command('DOM.getSearchResults',{searchId,fromIndex:0,toIndex:1});
    const {model}=await command('DOM.getBoxModel',{nodeId:nodeIds[0]});
    // Chrome returns viewport coordinates including the offsets of child frames.
    const quad=model.content,x=Math.round((quad[0]+quad[2]+quad[4]+quad[6])/4),y=Math.round((quad[1]+quad[3]+quad[5]+quad[7])/4);
    const {node}=await command('DOM.describeNode',{nodeId:nodeIds[0],depth:0});
    const hit=await command('DOM.getNodeForLocation',{x,y,includeUserAgentShadowDOM:true});
    if(hit.backendNodeId!==node.backendNodeId)throw Object.assign(new Error('Поле сообщения перекрыто другим элементом'),{inputFailure:'editor',inputStage:'locate'});
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'});
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
    await settle();
    await check('focus');
    await key('rawKeyDown',' ','Space',32);
    await key('char',' ','Space',32,' ');
    await key('keyUp',' ','Space',32);
    await settle();
    await check('space');
    await key('rawKeyDown','Backspace','Backspace',8);
    await key('keyUp','Backspace','Backspace',8);
    await check('done');
  } catch(error) {
    error.inputFailure ||= attached?'transport':'attach';
    throw error;
  } finally {
    if(attached && searchId)await command('DOM.discardSearchResults',{searchId}).catch(()=>{});
    if(attached)await debuggerApi.detach(target).catch(()=>{});
    await call(job,job.frameId,'NATIVE_INPUT',{token,stage:'release'}).catch(()=>{});
  }
}
