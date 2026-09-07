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
  mobileFirewallHint(mobileState.proxyPort,mobileState.certificatePort);
  if(mobileState.enabled){$('mobile-host').textContent=mobileState.address;$('mobile-port').textContent=mobileState.proxyPort;$('mobile-url').value=mobileState.url;$('mobile-client').textContent=mobileState.lastClient?`Последнее подключение: ${mobileState.lastClient}`:'Телефон ещё не подключался.';}
}
function mobileFirewallHint(proxyPort=Number(proxyAddress.split(':')[1])||8080,certificatePort=proxyPort+1){
  $('mobile-firewall').hidden=platform!=='win32';
  $('mobile-firewall-hint').textContent=platform==='win32'
    ?`Если ссылка не открывается, разреши TCP ${proxyPort} и ${certificatePort} для частной сети в брандмауэре Windows. Кнопка копирует команду для PowerShell от администратора. Гостевой Wi-Fi, изоляция клиентов и VPN могут мешать соединению.`
    :platform==='darwin'
    ?'Если ссылка не открывается, разреши входящие подключения для Librium: Системные настройки → Сеть → Брандмауэр → Параметры (если брандмауэр включён). Гостевой Wi-Fi, изоляция клиентов и VPN могут мешать соединению.'
    :`Если ссылка не открывается, разреши входящие TCP-подключения на порты ${proxyPort} и ${certificatePort} в брандмауэре. Гостевой Wi-Fi, изоляция клиентов и VPN могут мешать соединению.`;
}
mobileFirewallHint();
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
