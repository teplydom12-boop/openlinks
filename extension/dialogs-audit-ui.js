import {displayTime} from './lib/time.js';
import {wechatContactFingerprint} from './lib/wechat-audit.js';

const PLATFORMS={'1688':'1688',alibaba:'Alibaba',mic:'Made-in-China'};
const PHASES={idle:'Не запущено',running:'Проверка идёт',paused:'На паузе',blocked:'Проверка остановлена',completed:'Обход завершён'};
const RESULTS={found:['WeChat найден','good'],not_found:['В тексте не найден',''],older:['Старше 24 часов',''],incomplete:['Не удалось проверить','warn'],error:['Ошибка чтения','bad']};
const ACTIONS={audit_waiting:'Ожидаю загрузку списка',audit_list:'Читаю список чатов',audit_history:'Загружаю историю переписки',audit_result:'Результат чата сохранён',audit_platform_complete:'Площадка проверена',audit_start:'Начинаю проверку',audit_running:'Проверяю чаты',audit_opening:'Открываю чат',audit_reading:'Читаю историю',audit_found:'WeChat найден',audit_not_found:'В тексте не найден',audit_older:'Чат старше 24 часов',audit_incomplete:'История не прочитана полностью',audit_blocked:'Проверка остановлена',audit_completed:'Обход завершён',reading_list:'Проверяю список чатов',reading_first:'Загружаю начало истории',reading_latest:'Читаю последние сообщения',opening:'Открываю чат',reading:'Читаю сообщения',history:'Проверяю историю',scanning:'Проверяю список чатов',paused:'Проверка на паузе',blocked:'Проверка остановлена'};
const $=selector=>document.querySelector(selector);
const element=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
const time=at=>Number.isFinite(at)?displayTime(at):'Не определено';
function chatUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&/(^|\.)(1688\.com|alibaba\.com|made-in-china\.com)$/.test(u.hostname)?u.href:null;}catch{return null;}}

// The audit UI has no folder/Claude commands and never touches a chat composer.
export function setupAuditUI({command,adopt,feedback,getState,isOpening=()=>false}){
  let dirty=false,busy=false,page=0,signature='',runId='',viewBusy=false,viewRequested=null;
  const expanded=new Set();
  const state=()=>getState();
  const enabled=()=>state()?.settings?.wechatAudit===true;
  const contactChanged=()=>{const audit=state()?.workflow?.audit;return !!audit?.runId&&!!audit.contactFingerprint&&audit.contactFingerprint!==wechatContactFingerprint(state()?.settings?.wechat);};
  const records=()=>{const audit=state()?.workflow?.audit||{};return Object.values(audit.records||{}).filter(row=>row.runId===audit.runId).sort((a,b)=>['1688','alibaba','mic'].indexOf(a.platform)-['1688','alibaba','mic'].indexOf(b.platform)||(a.position??Infinity)-(b.position??Infinity)).map((row,index)=>({...row,ordinal:index+1}));};
  function renderReport(){
    const all=records(),filter=$('#dialogs-audit-filter').value,platform=$('#dialogs-audit-platform').value,query=$('#dialogs-audit-search').value.trim().toLocaleLowerCase();
    const rows=all.filter(row=>(filter==='all'||(filter==='incomplete'?['incomplete','error'].includes(row.status):row.status===filter))&&(platform==='all'||row.platform===platform)&&(!query||[row.title,PLATFORMS[row.platform],RESULTS[row.status]?.[0],row.detail].join(' ').toLocaleLowerCase().includes(query)));
    const pages=Math.max(1,Math.ceil(rows.length/50));page=Math.max(0,Math.min(page,pages-1));
    const nextSignature=JSON.stringify([rows,page]);
    if(signature!==nextSignature){
      signature=nextSignature;const body=$('#dialogs-audit-body');body.replaceChildren();
      for(const row of rows.slice(page*50,page*50+50)){
        const line=element('tr');line.dataset.auditKey=row.key;line.dataset.auditStatus=row.status;
        const status=element('td'),[label,tone]=RESULTS[row.status]||RESULTS.incomplete;
        status.append(element('span',label,'dialogs-audit-result '+tone));
        const notes=element('td'),details=element('details'),summary=element('summary','Подробнее');details.dataset.auditKey=row.key;details.open=expanded.has(row.key);
        details.append(summary,element('p',row.detail||'Дополнительные сведения не сохранены.'));
        if(row.status==='found'&&row.matchDirection)details.append(element('p',row.matchDirection==='outbound'?'ID найден в вашем сообщении.':row.matchDirection==='inbound'?'ID найден в сообщении продавца.':'ID найден в сообщении переписки.'));
        const url=chatUrl(row.url);if(url){const link=element('a','Открыть чат ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';details.append(link);}
        details.addEventListener('toggle',()=>{if(!details.isConnected)return;if(details.open)expanded.add(row.key);else expanded.delete(row.key);});notes.append(details);
        line.append(element('td',String(row.ordinal)),element('td',PLATFORMS[row.platform]||'Не определена'),element('td',row.title?.trim()||'Имя не прочитано'),element('td',time(row.lastMessageAt)),status,element('td',time(row.checkedAt)),notes);body.append(line);
      }
    }
    const count=status=>all.filter(row=>status.includes(row.status)).length;
    $('#dialogs-audit-count').textContent=all.length+' чатов';
    $('#dialogs-audit-report-note').hidden=!contactChanged();
    $('#dialogs-audit-summary').textContent='WeChat найден: '+count(['found'])+' · В тексте не найден: '+count(['not_found'])+' · Не удалось проверить: '+count(['incomplete','error'])+' · Старше суток: '+count(['older']);
    $('#dialogs-audit-empty').hidden=rows.length>0;$('#dialogs-audit-empty').textContent=all.length?'Нет результатов с выбранными условиями.':'Результаты появятся после запуска проверки.';
    $('#dialogs-audit-page').textContent=rows.length?(page*50+1)+'–'+Math.min(page*50+50,rows.length)+' из '+rows.length:'0 результатов';
    $('#dialogs-audit-prev').disabled=page===0;$('#dialogs-audit-next').disabled=page>=pages-1;
  }
  function render(){
    if(!enabled())return;
    const s=state(),audit=s.workflow?.audit||{},phase=audit.phase||'idle',running=s.running===true,locked=busy||isOpening();
    if(audit.runId!==runId){runId=audit.runId||'';page=0;expanded.clear();signature='';}
    if(!dirty)$('#dialogs-audit-wechat').value=s.settings?.wechat||'';
    $('#dialogs-audit-save').disabled=!dirty||busy;
    $('#dialogs-audit-setting-note').textContent=dirty?'Сохраните ID перед запуском. Изменение ID требует новой проверки.':!s.settings?.wechat?.trim()?'Введите и сохраните WeChat ID, который нужно искать.':'Ищем точный ID: '+s.settings.wechat;
    $('#dialogs-audit-start').disabled=locked||dirty||!s.settings?.wechat?.trim();
    $('#dialogs-audit-resume').disabled=locked||dirty||contactChanged()||audit.saturated===true||running||!audit.runId||!['paused','blocked','running'].includes(phase)||!s.settings?.wechat?.trim();
    $('#dialogs-audit-pause').disabled=busy||!running;
    $('#dialogs-audit-status').textContent=PHASES[phase]||'Проверка';$('#dialogs-audit-status').className='dialogs-status '+(phase==='blocked'?'warn':running?'good':'');
    $('#dialogs-audit-show-working-tab').checked=viewRequested??s.settings?.showWorkingTab===true;$('#dialogs-audit-show-working-tab').disabled=viewBusy;
    const activity=audit.runId?(s.workflowActivity||s.workflow?.current||{}):{},conversation=s.conversations?.[activity.conversationKey||activity.key],record=audit.records?.[activity.conversationKey||activity.key];
    const currentPlatform=['1688','alibaba','mic'][audit.cursor];
    $('#dialogs-audit-action').textContent=phase==='blocked'?'Проверка остановлена':phase==='completed'?'Обход завершён':!running?(phase==='idle'?'Ожидание запуска':'Проверка на паузе'):ACTIONS[activity.phase]||'Проверяю чаты';
    $('#dialogs-audit-target').textContent=[PLATFORMS[activity.platform||currentPlatform],record?.title||audit.progress?.pending?.title||conversation?.title].filter(Boolean).join(' · ');
    $('#dialogs-audit-detail').textContent=(contactChanged()?'WeChat ID изменён. Этот отчёт относится к прежнему ID; начните проверку заново.':'')||audit.blockedReason||activity.detail||(phase==='completed'?'Все площадки пройдены. Результаты сохранены в таблице.':phase==='idle'?'Сохраните WeChat ID, откройте чаты площадок и начните проверку.':'Результаты и место обхода сохранены.');
    $('#dialogs-audit-time').textContent=activity.at?'Последнее действие: '+time(activity.at):audit.startedAt?'Начало проверки: '+time(audit.startedAt):'';
    const list=$('#dialogs-audit-platform-progress');list.replaceChildren();
    for(const platform of ['1688','alibaba','mic']){const item=audit.platforms?.[platform]||{},labels={pending:'Ожидает',running:'Проверяется',blocked:'Обход не завершён',completed:'Список пройден'},li=element('li');li.dataset.platform=platform;li.append(element('strong',PLATFORMS[platform]),element('span',labels[item.phase]||'Ожидает'));if(item.detail)li.append(element('p',item.detail));list.append(li);}
    renderReport();
  }
  async function perform(name,payload={},message=''){
    if(busy||!enabled())return;busy=true;render();
    try{adopt(await command(name,payload));if(message)feedback(message);}
    catch(error){feedback(error.message,true);}
    finally{busy=false;render();}
  }
  $('#dialogs-audit-wechat').addEventListener('input',()=>{dirty=$('#dialogs-audit-wechat').value!==(state()?.settings?.wechat||'');render();});
  $('#dialogs-audit-settings').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!enabled())return;const wechat=$('#dialogs-audit-wechat').value.trim();if(!wechat){feedback('Укажите WeChat ID.',true);return;}
    busy=true;render();try{const result=await command('SETTINGS',{settings:{wechat}});dirty=false;adopt(result);feedback('WeChat ID сохранён. Начните проверку заново.');}catch(error){feedback(error.message,true);}finally{busy=false;render();}
  });
  $('#dialogs-audit-start').addEventListener('click',()=>{if(!dirty)perform('AUDIT_START',{},'Новая проверка начата с верхнего чата 1688.');});
  $('#dialogs-audit-resume').addEventListener('click',()=>{if(!dirty)perform('START',{},'Проверка продолжена с сохранённого места.');});
  $('#dialogs-audit-pause').addEventListener('click',()=>perform('STOP',{},'Проверка на паузе. Место и результаты сохранены.'));
  $('#dialogs-audit-show-working-tab').addEventListener('change',async()=>{if(viewBusy||!enabled())return;const showWorkingTab=$('#dialogs-audit-show-working-tab').checked;viewBusy=true;viewRequested=showWorkingTab;render();try{adopt(await command('SETTINGS',{settings:{showWorkingTab}}));}catch(error){feedback(error.message,true);}finally{viewBusy=false;viewRequested=null;render();}});
  for(const [id,event] of [['filter','change'],['platform','change'],['search','input']])$('#dialogs-audit-'+id).addEventListener(event,()=>{page=0;renderReport();});
  $('#dialogs-audit-prev').addEventListener('click',()=>{page=Math.max(0,page-1);renderReport();});$('#dialogs-audit-next').addEventListener('click',()=>{page++;renderReport();});
  return {render};
}
