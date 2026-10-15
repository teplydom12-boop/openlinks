// Only the worker may invoke this, for the active 1688 draft. No Enter, clipboard,
// page evaluation or network interception is used. Release our session on every exit.
export async function activate1688(job, call, debuggerApi = chrome.debugger) {
  if(job.platform!=='1688')throw new Error('Ввод клавиш разрешён только для чата 1688');
  const target={tabId:job.tabId},token=crypto.randomUUID();
  let attached=false;
  const check=async stage=>{
    const reply=await call(job,job.frameId,'NATIVE_INPUT',{token,stage,expectedUrl:job.inputUrl});
    if(!reply?.ok)throw Object.assign(new Error(reply?.reason || 'Фокус или текст редактора изменился'),{inputFailure:'editor',inputStage:stage});
  };
  const key=async(type,key,code,keyCode,text)=>debuggerApi.sendCommand(target,'Input.dispatchKeyEvent',{
    type,key,code,windowsVirtualKeyCode:keyCode,...(text?{text,unmodifiedText:text}:{}),
  });
  try {
    await debuggerApi.attach(target,'1.3');attached=true;
    await check('focus');
    await key('rawKeyDown',' ','Space',32);
    await check('before');
    await key('char',' ','Space',32,' ');
    await key('keyUp',' ','Space',32);
    await check('space');
    await key('rawKeyDown','Backspace','Backspace',8);
    await key('keyUp','Backspace','Backspace',8);
    await check('done');
  } catch(error) {
    error.inputFailure ||= attached?'transport':'attach';
    throw error;
  } finally {
    if(attached)await debuggerApi.detach(target).catch(()=>{});
  }
}
