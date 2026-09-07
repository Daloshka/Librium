let mobileState=null;
async function refreshMobile(){
  if(!window.librium?.mobileStatus){$('mobile-state').textContent=t('phone.electronOnly');$('mobile-toggle').disabled=true;return;}
  try{mobileState=await window.librium.mobileStatus();renderMobile();}catch(error){$('mobile-state').textContent=error.message;}
}
function renderMobile(){
  const select=$('mobile-address'),previous=select.value;select.replaceChildren();
  for(const adapter of mobileState.addresses){const option=el('option',`${adapter.address} · ${adapter.name}`);option.value=adapter.address;select.append(option);}
  if(mobileState.address)select.value=mobileState.address;else if([...select.options].some(o=>o.value===previous))select.value=previous;
  select.disabled=mobileState.enabled;
  $('mobile-toggle').disabled=!mobileState.addresses.length;
  $('mobile-toggle').textContent=t(mobileState.enabled?'phone.disable':'phone.enable');
  $('mobile-state').textContent=mobileState.enabled?t('phone.enabled',{address:mobileState.address,port:mobileState.proxyPort}):t(mobileState.addresses.length?'phone.pickAddress':'phone.noAddress');
  $('mobile-details').hidden=!mobileState.enabled;
  mobileFirewallHint(mobileState.proxyPort,mobileState.certificatePort);
  if(mobileState.enabled){$('mobile-host').textContent=mobileState.address;$('mobile-port').textContent=mobileState.proxyPort;$('mobile-url').value=mobileState.url;$('mobile-client').textContent=mobileState.lastClient?t('phone.lastClient',{client:mobileState.lastClient}):t('phone.noClient');}
}
function mobileFirewallHint(proxyPort=Number(proxyAddress.split(':')[1])||8080,certificatePort=proxyPort+1){
  $('mobile-firewall').hidden=platform!=='win32';
  $('mobile-firewall-hint').textContent=t(platform==='win32'?'phone.firewallWindows':platform==='darwin'?'phone.firewallMac':'phone.firewallOther',{proxyPort,certificatePort});
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
$('mobile-copy').onclick=async()=>{try{await window.librium.copy(mobileState.url);toast(t('phone.linkCopied'));}catch(error){$('mobile-state').textContent=error.message;}};
$('mobile-firewall').onclick=async()=>{
  if(!mobileState?.enabled)return;
  const command=`New-NetFirewallRule -DisplayName 'Librium Phone LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress ${mobileState.address} -LocalPort ${mobileState.proxyPort},${mobileState.certificatePort} -RemoteAddress LocalSubnet -Profile Private`;
  try{await window.librium.copy(command);$('mobile-state').textContent=t('phone.commandCopied');}catch(error){$('mobile-state').textContent=error.message;}
};
