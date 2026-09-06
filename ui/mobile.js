let mobileState=null;
async function refreshMobile(){
  if(!window.librium?.mobileStatus){$('mobile-state').textContent='Подключение телефона доступно в Electron-приложении.';$('mobile-toggle').disabled=true;return;}
  try{mobileState=await window.librium.mobileStatus();renderMobile();}catch(error){$('mobile-state').textContent=error.message;}
}
function renderMobile(){
  const select=$('mobile-address'),previous=select.value;select.replaceChildren();
  for(const adapter of mobileState.addresses){const option=el('option',`${adapter.address} · ${adapter.name}`);option.value=adapter.address;select.append(option);}
  if(mobileState.address)select.value=mobileState.address;else if([...select.options].some(o=>o.value===previous))select.value=previous;
  select.disabled=mobileState.enabled;
  $('mobile-toggle').disabled=!mobileState.addresses.length;
  $('mobile-toggle').textContent=mobileState.enabled?'Выключить доступ телефона':'Включить домашнюю сеть';
  $('mobile-state').textContent=mobileState.enabled?`Доступ включён · ${mobileState.address}:${mobileState.proxyPort}`:mobileState.addresses.length?'Выбери адрес домашней сети и включи доступ.':'Не найден домашний IPv4-адрес. Подключи компьютер к домашней сети.';
  $('mobile-details').hidden=!mobileState.enabled;
  if(mobileState.enabled){$('mobile-host').textContent=mobileState.address;$('mobile-port').textContent=mobileState.proxyPort;$('mobile-url').value=mobileState.url;$('mobile-client').textContent=mobileState.lastClient?`Последнее подключение: ${mobileState.lastClient}`:'Телефон ещё не подключался.';}
}
$('phone').onclick=async()=>{$('mobile-dialog').showModal();await refreshMobile();};
$('mobile-close').onclick=()=>$('mobile-dialog').close();
$('mobile-refresh').onclick=refreshMobile;
$('mobile-toggle').onclick=async()=>{
  $('mobile-toggle').disabled=true;
  try{mobileState=mobileState.enabled?await window.librium.mobileDisable():await window.librium.mobileEnable($('mobile-address').value);renderMobile();}
  catch(error){$('mobile-state').textContent=error.message;$('mobile-toggle').disabled=false;}
};
$('mobile-copy').onclick=async()=>{try{await window.librium.copy(mobileState.url);toast('Ссылка скопирована');}catch(error){$('mobile-state').textContent=error.message;}};
$('mobile-firewall').onclick=async()=>{
  if(!mobileState?.enabled)return;
  const command=`New-NetFirewallRule -DisplayName 'Librium Phone LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress ${mobileState.address} -LocalPort ${mobileState.proxyPort},${mobileState.certificatePort} -RemoteAddress LocalSubnet -Profile Private`;
  try{await window.librium.copy(command);$('mobile-state').textContent='Команда скопирована. Выполни её в PowerShell от администратора, если телефон не подключается.';}catch(error){$('mobile-state').textContent=error.message;}
};
