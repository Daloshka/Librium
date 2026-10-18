let captureError='',captureBusy=false;
const captureButtons=['capture-connect','capture-majestic','capture-disconnect','capture-choose','capture-launch'];
try{$('capture-startup').checked=localStorage.getItem('captureStartup')!=='false';}catch{}
$('capture-startup').onchange=()=>{try{localStorage.setItem('captureStartup',String($('capture-startup').checked));}catch{}};
async function captureStatus(){
  if(!window.librium?.captureStatus){$('capture-state').textContent='Захват приложений доступен в десктопной версии Librium.';for(const id of captureButtons)$(id).disabled=true;return;}
  try{const [state,target]=await Promise.all([window.librium.captureStatus(),window.librium.captureTarget?.()]);
    const error=[captureError||state.error,state.warning].filter(Boolean).join(' · ');
    $('capture-state').textContent=(state.connected?`Подключено источников: ${state.sources?.filter(s=>s.connected).length||1} · ${state.exchanges} соединений и запросов · ${state.messages} WS-сообщений`:'Захват отключён')+(error?' · '+error:'');
    $('capture-connect').disabled=captureBusy;
    $('capture-disconnect').disabled=captureBusy||!state.connected;$('capture-majestic').disabled=captureBusy||!state.majesticInstalled;
    $('capture-choose').disabled=captureBusy||!window.librium.captureSelect;
    $('capture-launch').disabled=captureBusy||!target?.available;
    $('capture-target').textContent=target?.target?`${target.target.label} · ${target.target.kind==='project'?'Проект Electron':'Приложение'}\n${target.target.path}`:target?.error||'Выбери .exe Electron или package.json проекта, например Morphius.';
    $('capture-sources').replaceChildren(...(state.sources||[]).map(source=>el('p',`${source.label}: ${source.connected?'подключено к '+source.port:'не подключено'} · ${source.exchanges} запросов / соединений · ${source.messages} WS-сообщений${source.startup==='captured'?' · с начала запуска':source.startup==='unconfirmed'?' · начало запуска не подтверждено':''}`)));
  }catch(e){$('capture-state').textContent=e.message;}
}
$('capture-open').onclick=async()=>{$('capture-dialog').showModal();await captureStatus();};
$('capture-close').onclick=()=>$('capture-dialog').close();
$('capture-refresh').onclick=captureStatus;
for(const [id,method]of [['capture-connect','captureConnect'],['capture-majestic','captureMajestic'],['capture-launch','captureLaunch'],['capture-choose','captureSelect'],['capture-disconnect','captureDisconnect']]){
  $(id).onclick=async()=>{if(captureBusy)return;captureBusy=true;captureError='';for(const key of captureButtons)$(key).disabled=true;$('capture-state').textContent=method==='captureSelect'?'Выбор приложения…':method==='captureDisconnect'?'Отключение…':'Подключение…';
    try{const mode=$('capture-source').value,port=Number($('capture-port').value),launched=['captureMajestic','captureLaunch'].includes(method);await window.librium[method](launched&&mode==='node'?port-1:port,launched?$('capture-startup').checked:mode,method==='captureConnect'?$('capture-startup').checked:undefined);}
    catch(e){captureError=e.message;}finally{captureBusy=false;await captureStatus();}
  };
}
function capturePorts(){const port=Number($('capture-port').value),base=$('capture-source').value==='node'?port-1:port;$('capture-ports').textContent=`При запуске приложения: окна — ${base}, главный процесс — ${base+1}.`;}
$('capture-source').onchange=()=>{if(['9333','9334'].includes($('capture-port').value))$('capture-port').value=$('capture-source').value==='node'?'9334':'9333';capturePorts();};
$('capture-port').oninput=capturePorts;
setInterval(()=>{if($('capture-dialog').open&&!captureBusy)captureStatus();},1500);
