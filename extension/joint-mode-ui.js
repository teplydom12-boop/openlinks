import {displayTime} from './lib/time.js';

const PHASES={independent:'Раздельная работа',outreach:'Первичные обращения',dialogs_quota_wait:'Диалоги · ожидание квот',dialogs_queue_complete:'Диалоги · очередь завершена',needs_attention:'Нужно вмешательство',test_paused:'Тестовый режим'};
const STORAGE_KEYS=['openlinksWorkCoordinator','openlinksState','openlinksDialogs','openlinksClaudeFolder'];

// Both workspaces use the same controller; starting it never changes send or test preferences.
export function setupJointModeUI({beforeStart=async()=>{},afterChange=async()=>{}}={}){
  const $=selector=>document.querySelector(selector),root=$('#joint-mode');
  if(!root)return;
  let joint=null,busy=false,loading=false,refreshAgain=false,available=false,readFailure=false,epoch=0;
  function feedback(message,error=false){const el=$('#joint-mode-feedback');el.textContent=message;el.hidden=!message;el.classList.toggle('error',error);}
  function render(){
    const enabled=joint?.enabled===true,phase=joint?.phase||'independent';
    const status=$('#joint-mode-status');status.textContent=!available?'Статус недоступен':PHASES[phase]||'Совместная работа';
    status.className='dialogs-status '+(['needs_attention','test_paused'].includes(phase)?'warn':enabled?'good':'');
    $('#joint-mode-detail').textContent=joint?.detail||'Оба блока можно запускать отдельно или объединить с приоритетом первичных обращений.';
    const next=Number(joint?.nextAt);$('#joint-mode-next').hidden=!(Number.isFinite(next)&&next>0);
    $('#joint-mode-next').textContent=next>0?'Следующая проверка очереди: '+displayTime(next)+'.':'';
    $('#joint-mode-start').disabled=!available||busy||enabled||joint?.testMode===true;
    $('#joint-mode-pause').disabled=busy||!enabled;
    root.setAttribute('aria-busy',String(busy||loading));
  }
  async function command(name){
    const result=await chrome.runtime.sendMessage({type:'DIALOGS_JOINT_'+name});
    if(!result?.ok)throw new Error(result?.error||'Не удалось получить состояние совместной работы.');
    if(!result.joint||typeof result.joint.enabled!=='boolean')throw new Error('Состояние совместной работы недоступно. Обновите страницу расширения.');
    return result;
  }
  async function refresh(){
    if(loading||busy){refreshAgain=true;return;}
    const requestedEpoch=epoch;loading=true;render();
    try{const result=await command('GET');if(requestedEpoch===epoch){joint=result.joint;available=true;if(readFailure){readFailure=false;feedback('');}}}
    catch(error){if(requestedEpoch===epoch){available=false;readFailure=true;feedback(error.message,true);}}
    finally{loading=false;render();if(refreshAgain){refreshAgain=false;queueMicrotask(refresh);}}
  }
  async function act(name){
    if(busy)return;
    epoch++;busy=true;readFailure=false;feedback('');render();
    try{
      if(name==='START'){
        if(joint?.testMode===true)throw new Error('Совместный запуск требует рабочего режима: первичная очередь отправляет реальные обращения. Сейчас тест включён, совместный запуск заблокирован.');
        await beforeStart();
      }
      const result=await command(name);joint=result.joint;available=true;
      feedback(name==='PAUSE'?'Оба блока остановлены.':joint.detail||'Совместная работа включена.');
      await afterChange(result);
    }catch(error){feedback(error.message,true);}
    finally{busy=false;render();await refresh();}
  }
  $('#joint-mode-start').addEventListener('click',()=>act('START'));
  $('#joint-mode-pause').addEventListener('click',()=>act('PAUSE'));
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&STORAGE_KEYS.some(key=>Object.hasOwn(changes,key)))refresh();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  setInterval(()=>{if(!document.hidden)refresh();},5000);
  refresh();
  return {refresh};
}
