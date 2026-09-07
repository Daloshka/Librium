'use strict';
const $ = id => document.getElementById(id);
let rows = [], selected = null, detail = null, paused = false, detailSignature = '', rowsSignature = '', wrapped = true;
let wsData=null,wsBefore=null,wsSignature="";
const modes = { request: 'http', response: 'pretty' };
const paneNodes = {};
let filterRules=[],sortField="id",sortOrder="desc";
const PAGE_SIZE=500;
let pageOffset=0, pageAnchor=null, pageTotal=0, pageMatched=0, pageNewest=0, listGeneration=0;
async function loadPage() {
  const generation=++listGeneration;
  const query={offset:pageOffset,limit:PAGE_SIZE,before:pageAnchor,query:$('filter').value,method:$('method').value,status:$('status').value,rules:filterRules,traffic_type:$('traffic-type').value,sort:sortField,order:sortOrder};
  const data=await api('traffic-page?q='+encodeURIComponent(JSON.stringify(query)));
  if(generation!==listGeneration)return;
  pageTotal=data.total;pageMatched=data.matched;pageNewest=data.newest;
  rows=data.rows;rowsSignature=JSON.stringify(data);renderRows();
}
function filtersChanged(){saveActiveSession();pageOffset=0;pageAnchor=null;renderRows();loadPage().catch(showError);}

let renderVersion = 0, toastTimer;
const imageUrls={};
function releaseImage(side){if(imageUrls[side]){URL.revokeObjectURL(imageUrls[side]);delete imageUrls[side];}}
function imageType(payload,url=''){const mime=payload.headers.find(([k])=>k.toLowerCase()==='content-type')?.[1].split(';')[0].trim().toLowerCase();if(/^image\/(png|jpeg|gif|webp|bmp|x-icon|vnd.microsoft.icon|avif|svg\+xml)$/.test(mime||''))return mime;if(payload.base64.startsWith('iVBORw0KGgo'))return 'image/png';if((!mime||['application/octet-stream','text/plain','text/xml','application/xml'].includes(mime))&&url.split('?')[0].toLowerCase().endsWith('.svg'))return 'image/svg+xml';return null;}
function audioType(payload,url=''){
 const mime=payload.headers.find(([k])=>k.toLowerCase()==='content-type')?.[1].split(';')[0].trim().toLowerCase();
 if(/^audio\/[a-z0-9.+-]+$/.test(mime||''))return mime;
 if(mime==='application/ogg'||payload.base64.startsWith('T2dnUw'))return 'audio/ogg';
 if(!mime||mime==='application/octet-stream'){
  const ext=url.split('?')[0].split('.').pop().toLowerCase();return {ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac'}[ext]||null;
 }
 return null;
}

let sessionState=null,sessionEditing=false,sessionSaveGeneration=0;
const currentFilters=()=>({query:$('filter').value,method:$('method').value,status:$('status').value,type:$('traffic-type').value,sort:sortField,order:sortOrder,rules:JSON.parse(JSON.stringify(filterRules))});
const emptyFilters=()=>({query:'',method:'',status:'',type:'',sort:'id',order:'desc',rules:[]});
function renderSessions(){
 $('filter-session').replaceChildren();for(const session of sessionState.sessions){const option=el('option',session.name);option.value=session.id;$('filter-session').append(option);}$('filter-session').value=sessionState.activeId;
}
async function persistSessions(){
 const generation=++sessionSaveGeneration;$('session-state').textContent='Сохранение…';
 try{const value=JSON.parse(JSON.stringify(sessionState));if(window.librium?.saveFilterSessions)await window.librium.saveFilterSessions(value);else localStorage.setItem('librium-filter-sessions-v1',JSON.stringify(value));if(generation===sessionSaveGeneration)$('session-state').textContent='Сохранено';}
 catch(error){$('session-state').textContent='Не сохранено';showError(error);}
}
function saveActiveSession(){if(!sessionState)return;Object.assign(sessionState.sessions.find(s=>s.id===sessionState.activeId),currentFilters());persistSessions();}
function applySession(){
 const session=sessionState.sessions.find(s=>s.id===sessionState.activeId);
 sortField=session.sort||'id';sortOrder=session.order||'desc';renderSort();$('filter').value=session.query;$('method').value=session.method;$('status').value=session.status;$('traffic-type').value=session.type;filterRules=JSON.parse(JSON.stringify(session.rules));renderSessions();renderFilterChips();pageOffset=0;pageAnchor=null;
}
async function initSessions(){
 const saved=window.librium?.loadFilterSessions?await window.librium.loadFilterSessions():JSON.parse(localStorage.getItem('librium-filter-sessions-v1')||'null');
 sessionState=saved||{version:1,activeId:'default',sessions:[{id:'default',name:'Основная',...emptyFilters()}]};applySession();
 $('session-state').textContent='Автосохранение';
}
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function bytes(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`; }
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 2400); }
let lastReportedError='';
function showError(error) { $('error').hidden = !error; $('error').textContent = error?.message || '';if(error && error.message!==lastReportedError){lastReportedError=error.message;window.librium?.reportError?.(error.stack||error.message).catch(()=>{});} }
window.addEventListener('error',event=>showError(event.error||Error(event.message)));
window.addEventListener('unhandledrejection',event=>showError(event.reason instanceof Error?event.reason:Error(String(event.reason))));
async function api(path, method = 'GET') {
  if (window.librium) return window.librium.request(path, method);
  const response = await fetch('/api/' + path, { method, headers: { 'x-librium-token': token } });
  if (!response.ok) throw Error(`API: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
let proxyAddress='127.0.0.1:8080',dataDir='';
const platform=window.librium?.platform||(navigator.platform.startsWith('Mac')?'darwin':navigator.platform.startsWith('Win')?'win32':'linux');
function caPath(){
  if(dataDir)return dataDir+(platform==='win32'?'\\ca.crt':'/ca.crt');
  return platform==='win32'?'$env:LOCALAPPDATA\\Librium\\ca.crt':platform==='darwin'?'$HOME/Library/Application Support/Librium/ca.crt':'${XDG_DATA_HOME:-$HOME/.local/share}/librium/ca.crt';
}
function renderConnectionInfo(){
  for(const id of ['proxy-address','dialog-proxy','empty-proxy']){const node=$(id);if(node)node.textContent=proxyAddress;}
  $('ca-install').textContent=platform==='win32'?'Скачай CA и установи его в доверенные корневые сертификаты текущего пользователя.'
    :platform==='darwin'?'Скачай CA и открой файл в «Связке ключей» (Keychain Access): найди Librium Local CA и в свойствах доверия выбери «Всегда доверять». Или в Терминале: security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db <путь к ca.crt>'
    :'Скачай CA и добавь его в хранилище сертификатов системы или браузера.';
  $('ca-check-label').textContent=platform==='win32'?'Проверка из PowerShell:':'Проверка из терминала:';
  $('ca-check').textContent=platform==='win32'?`curl.exe --ssl-revoke-best-effort --proxy http://${proxyAddress} --cacert "${caPath()}" https://example.com`:`curl --proxy http://${proxyAddress} --cacert "${caPath()}" https://example.com`;
  window.mobileFirewallHint?.();
}
async function loadInfo(){
  try{const info=await api('info');const port=Number(info?.proxy_port);if(Number.isInteger(port)&&port>0&&port<=65535)proxyAddress='127.0.0.1:'+port;if(typeof info?.data_dir==='string'&&info.data_dir)dataDir=info.data_dir;}catch{}
  renderConnectionInfo();
}
function splitUrl(url) { try { const u = new URL(url); return { host: u.host, path: u.pathname + u.search }; } catch { return { host: url, path: '/' }; } }
function renderSort(){
 document.querySelectorAll('[data-sort]').forEach(button=>{const active=button.dataset.sort===sortField;button.textContent=button.dataset.label+(active?(sortOrder==='asc'?' ↑':' ↓'):'');button.closest('th').setAttribute('aria-sort',active?(sortOrder==='asc'?'ascending':'descending'):'none');});
 $('sort-description').textContent=sortField==='id'?(sortOrder==='desc'?'Новые сверху ↓':'Старые сверху ↑'):'Сортировка: '+document.querySelector(`[data-sort="${sortField}"]`).dataset.label;
}
function renderRows() {
  const query = $('filter').value.toLowerCase(), method = $('method').value, status = $('status').value;
  const shown = rows.filter(r => `${r.id} ${r.method} ${r.url} ${r.status ?? ''}`.toLowerCase().includes(query) && (!method || r.method === method) && (!status || (status === 'pending' ? r.status === null : String(r.status).startsWith(status))) && LibriumFilters.matches(r,filterRules));
  const fragment = document.createDocumentFragment();
  for (const row of shown) {
    const tr = el('tr'); tr.dataset.id = row.id; tr.tabIndex = 0; tr.classList.toggle('selected', row.id === selected);
    tr.setAttribute('aria-selected', String(row.id === selected)); tr.setAttribute('aria-label', `ID ${row.id}: ${row.method} ${row.url}`);
    const url = splitUrl(row.url), urlCell = el('td'); urlCell.append(el('span', url.host, 'host'), el('span', url.path, 'path')); urlCell.title = row.url;
    const methodCell = el('td'); methodCell.append(el('span', row.method, 'method-tag ' + row.method));
    const idCell = el('td', row.id, 'request-id'); idCell.title = String(row.id);
    tr.append(idCell, methodCell, urlCell, el('td', row.status ?? '…', `status s${String(row.status)[0]}`), el('td', bytes(row.size), 'bytes'));
    tr.onclick = () => choose(row.id);
    tr.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(row.id); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = event.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling; if (next) { next.focus(); choose(Number(next.dataset.id)); } }
    };
    fragment.append(tr);
  }
  const focusedId = document.activeElement?.dataset?.id;
  $('rows').replaceChildren(fragment);
  if (focusedId) $('rows').querySelector(`[data-id="${focusedId}"]`)?.focus({preventScroll:true});
  $('count').textContent = `${pageMatched} / ${pageTotal}`;
  $('page-label').textContent = pageMatched ? `${pageOffset+1}–${pageOffset+rows.length} из ${pageMatched}` : '0 запросов';
  $('page-prev').disabled=pageOffset===0;
  $('page-next').disabled=pageOffset+PAGE_SIZE>=pageMatched;
  $('empty').hidden = shown.length > 0;
  if (rows.length && !shown.length) $('empty').replaceChildren(el('h3', 'Ничего не найдено'), el('p', 'Измени фильтр, чтобы увидеть запросы.'));
  else if (!rows.length) $('empty').replaceChildren(el('div', '↔', 'empty-icon'), el('h3', 'Ожидание трафика'), el('p', `Прокси ${proxyAddress} · Настройка HTTPS слева внизу.`));
}
for (const side of ['request', 'response']) {
  const pane = el('section', undefined, 'pane'), title = el('div', undefined, 'pane-title');
  const heading = el('h2'); heading.append(el('span', side === 'request' ? '↗' : '↙'), document.createTextNode(side === 'request' ? 'Request' : 'Response'));
  const state = el('span', '', 'pane-state'), copy = el('button', 'Копировать');
  copy.onclick = async () => { try { const text = paneNodes[side].copyText || ''; if (window.librium) await window.librium.copy(text); else await navigator.clipboard.writeText(text); toast('Скопировано'); } catch(e) { showError(e); } };
  title.append(heading, state, copy);
  const tabs = el('div', undefined, 'tabs');
  for (const [key,label] of [['http','HTTP'],['headers','Заголовки'],['pretty','Pretty'],['text','Тело'],['hex','Hex'],['image','Картинка'],['audio','Аудио'],['ws','Сообщения WS']]) {
    const button = el('button', label); button.dataset.mode = key;
    button.onclick = () => { modes[side] = key; renderDetail(); }; tabs.append(button);
  }
  const notice = el('div', '', 'notice'); notice.hidden = true;
  const content = el('div', undefined, 'content');
  pane.append(title, tabs, notice, content); $('panes').append(pane); paneNodes[side] = { pane, state, tabs, notice, content, copyText: '' };
}
function highlighted(text) {
  const fragment = document.createDocumentFragment(), query = $('find').value;
  if (!query) { fragment.append(document.createTextNode(text)); return fragment; }
  const haystack = text.toLowerCase(), needle = query.toLowerCase(); let cursor = 0, index;
  while ((index = haystack.indexOf(needle, cursor)) !== -1) { fragment.append(document.createTextNode(text.slice(cursor, index)), el('mark', text.slice(index, index + query.length))); cursor = index + query.length; }
  fragment.append(document.createTextNode(text.slice(cursor))); return fragment;
}
function codeLines(text, type) {
  const fragment = document.createDocumentFragment(), lines = text.split('\n');
  const headerEnd=lines.indexOf('');
  for (let index = 0; index < Math.min(lines.length, 3000); index++) {
    const row = el('div', undefined, 'code-line'), content = el('span', undefined, 'line-text');
    if (!$('find').value && type === 'json') {
      const regex = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(-?\d+(?:\.\d+)?|true|false|null)\b/g;
      let cursor = 0; for (const match of lines[index].matchAll(regex)) { content.append(document.createTextNode(lines[index].slice(cursor, match.index)), el('span', match[0], match[1] ? 'json-key' : match[2] ? 'json-string' : 'json-number')); cursor = match.index + match[0].length; } content.append(document.createTextNode(lines[index].slice(cursor)));
    } else if (type==='http' && index>0 && (headerEnd<0||index<headerEnd) && /^[^\s:]+:/.test(lines[index])) {
      const colon=lines[index].indexOf(':'),key=el('span',undefined,'http-header-key'),value=el('span',undefined,'http-header-value');
      key.append(highlighted(lines[index].slice(0,colon+1)));value.append(highlighted(lines[index].slice(colon+1)));content.append(key,value);
    } else if (!$('find').value && type === 'http' && index === 0) content.append(el('span', lines[index], 'http-start'));
    else content.append(highlighted(lines[index]));
    row.append(el('span', index + 1, 'line-number'), content); fragment.append(row);
  }
  if (lines.length > 3000) fragment.append(el('div', 'Показаны первые 3000 строк. Копирование содержит весь предпросмотр.', 'notice'));
  return fragment;
}
function hexView(base64) {
  const raw = atob(base64.slice(0,87384)).slice(0,65536), lines = [];
  for (let i = 0; i < raw.length; i += 16) { const part = [...raw.slice(i,i+16)].map(c => c.charCodeAt(0)); lines.push(i.toString(16).padStart(6,'0') + '  ' + part.map(n => n.toString(16).padStart(2,'0')).join(' ').padEnd(47,' ') + '  ' + part.map(n => n >= 32 && n < 127 ? String.fromCharCode(n) : '.').join('')); }
  return lines.join('\n');
}
async function bodyText(payload) {
  const encoding = payload.headers.find(([name]) => name.toLowerCase() === 'content-encoding')?.[1]?.toLowerCase();
  if (!encoding || encoding === 'identity') return {text:payload.text, notice:''};
  if (payload.truncated || !payload.complete) return {text:'Сжатое тело пока неполное. Байты доступны во вкладке Hex.', notice:`Content-Encoding: ${encoding}`};
  try {
    const raw = Uint8Array.from(atob(payload.base64), c => c.charCodeAt(0));
    const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream(encoding === 'br' ? 'brotli' : encoding)).getReader();
    const decoder = new TextDecoder(); let text = '', size = 0, capped = false;
    try { while (true) { const {value, done} = await reader.read(); if (done) break; const part = value.subarray(0, Math.max(0, 65536-size)); text += decoder.decode(part,{stream:true}); size += part.length; if (size >= 65536) { capped = true; await reader.cancel(); break; } } text += decoder.decode(); } finally { reader.releaseLock(); }
    return {text, notice:`Распаковано: ${encoding}${capped ? ' · первые 64 КиБ' : ''}. Hex — исходные байты.`};
  } catch { return {text:'Не удалось распаковать тело. Исходные байты доступны во вкладке Hex.', notice:`Content-Encoding: ${encoding}`}; }
}
async function openRedirect(current, target) {
  const query={query:'',method:'',status:'',offset:0,limit:1000,rules:[{field:'host',op:'eq',value:target.hostname},{field:'path',op:'eq',value:target.pathname+target.search},{field:'id',op:'gte',value:String(current.summary.id+1)}]};
  const page=await api('traffic-page?q='+encodeURIComponent(JSON.stringify(query)));
  if(selected!==current.summary.id)return;
  const match=page.rows.filter(row=>{try{return new URL(row.url).href===target.href;}catch{return false;}}).sort((a,b)=>a.id-b.id)[0];
  if(match)await choose(match.id);else toast('Запрос по Location не найден в сохранённой истории.');
}
async function renderDetail() {
  const version = ++renderVersion;
  if (!detail) {
    for (const [side,node] of Object.entries(paneNodes)) { releaseImage(side); node.audioKey=null; node.content.replaceChildren(el('div', 'Выбери запрос для просмотра', 'empty')); node.state.textContent = ''; node.notice.hidden = true; node.copyText = ''; }
    return;
  }
  const current = detail;
  const selectionUrl = el('button', current.summary.url, 'selection-url'); selectionUrl.title = 'Копировать URL: '+current.summary.url;
  selectionUrl.setAttribute('aria-label','Копировать полный URL');
  selectionUrl.onclick=async()=>{try{if(window.librium)await window.librium.copy(current.summary.url);else await navigator.clipboard.writeText(current.summary.url);toast('URL скопирован');}catch(error){showError(error);}};
  const open=el('button','↗','open-url');open.title='Открыть в браузере';open.setAttribute('aria-label','Открыть URL в браузере');
  open.onclick=async()=>{try{const url=new URL(current.summary.url);if(!['http:','https:'].includes(url.protocol))throw Error('Разрешены только HTTP и HTTPS адреса');if(window.librium)await window.librium.openUrl(url.href);else window.open(url.href,'_blank','noopener,noreferrer');}catch(error){showError(error);}};
  $('selection').replaceChildren(el('span', '#' + current.summary.id, 'selection-id'),el('span',current.summary.method,'selection-method'),open, selectionUrl, el('span', `${current.summary.status ?? '…'} · ${current.summary.elapsed_ms ?? '…'} ms`, 'selection-time'));
  let matches = 0;
  await Promise.all(['request','response'].map(async side => {
    const node = paneNodes[side], payload = current[side], mode = modes[side];
    const audioKey=mode==='audio'?`${current.summary.id}:${payload.base64.length}:${payload.complete}:${payload.truncated}`:null;
    if(audioKey && node.audioKey===audioKey)return;
    node.audioKey=null;releaseImage(side);
    node.tabs.querySelector('[data-mode="ws"]').hidden=current.summary.status!==101;
    node.tabs.querySelector('[data-mode="image"]').hidden=!imageType(payload,current.summary.url);
    node.tabs.querySelector('[data-mode="audio"]').hidden=!audioType(payload,current.summary.url);
    const decoded = mode === 'headers' || mode === 'hex' || mode === 'image' || mode === 'audio' || mode === 'ws' ? {text:'',notice:''} : await bodyText(payload);
    if (version !== renderVersion) return;
    node.tabs.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
    node.state.textContent = current.summary.status===101?'WebSocket · '+(wsData?.state==='open'?'открыт':wsData?.state==='closed'?'закрыт':'архив'):`${bytes(payload.size)}${payload.complete ? '' : ' · поток / ожидание'}`;
    const notices = [current.summary.status===101?null:current.summary.error, mode === 'hex' && payload.base64.length > 87384 ? 'Hex: показаны первые 64 КиБ.' : '', payload.truncated ? 'Тело сохранено частично. Для картинок и аудио лимит 32 МиБ, для остальных тел — 64 КиБ.' : '', decoded.notice].filter(Boolean);
    node.notice.hidden = !notices.length; node.notice.textContent = notices.join(' · ');
    if(side==='response' && [301,302,303,307,308].includes(current.summary.status)) {
      const location=payload.headers.find(([k])=>k.toLowerCase()==='location')?.[1];
      if(location)try{const target=new URL(location,current.summary.url);if(['http:','https:'].includes(target.protocol)){
        const follow=el('button','Открыть запрос по Location','redirect-open');follow.onclick=()=>openRedirect(current,target).catch(showError);
        node.notice.hidden=false;node.notice.append(el('span',` Перенаправление ${current.summary.status} → ${target.href} `),follow);
      }}catch{}
    }
    let text = decoded.text, type = '';
    if (mode === 'http') { text = (side === 'request' ? `${current.summary.method} ${current.summary.url}` : `Status: ${current.summary.status ?? 'Ожидание'}`) + '\n' + payload.headers.map(([k,v]) => `${k}: ${v}`).join('\n') + '\n\n' + decoded.text; type = 'http'; }
    if (mode === 'pretty') { try { text = JSON.stringify(JSON.parse(decoded.text),null,2); type = 'json'; } catch { /* Plain text and HTML remain inert text. */ } }
    if (mode === 'hex') text = hexView(payload.base64);
    const scroll = node.content.scrollTop, left = node.content.scrollLeft;
    if(mode==='ws') {
      const messages=(wsData?.messages||[]).filter(m=>m.direction===(side==='request'?'sent':'received'));
      text=messages.map(m=>`[${new Date(m.time).toLocaleTimeString()}.${String(m.time%1000).padStart(3,'0')}] ${m.direction==='sent'?'→':'←'} ${m.kind} · ${bytes(m.size)}${m.truncated?' · первые 64 КиБ':''}\n${m.kind==='BINARY'?hexView(m.base64):m.text}`).join('\n\n');
      node.content.replaceChildren(text?codeLines(text,''):el('div',wsData?.state==='not_recorded'?'Этот WebSocket записан старой версией: сообщений нет. Переподключи клиент.':'Сообщений в этом направлении пока нет.','empty'));
      node.notice.hidden=false;node.notice.textContent=`Всего сообщений: ${wsData?.total||0}${wsData?.error?' · '+wsData.error:''} `;
      if(wsData?.older){const older=el('button','Раньше');older.onclick=()=>{wsBefore=wsData.messages[0].id;loadWs().catch(showError);};node.notice.append(older);}
      if(wsBefore){const live=el('button','К новым');live.onclick=()=>{wsBefore=null;loadWs().catch(showError);};node.notice.append(live);}
    } else if (mode === 'image' || mode === 'audio') {
      const mime=mode==='audio'?audioType(payload,current.summary.url):imageType(payload,current.summary.url);
      if(!mime || payload.truncated || !payload.complete) {
        node.content.replaceChildren(el('div',payload.truncated?'Медиа сохранено не целиком. Повтори запрос после обновления Librium.':!payload.complete?'Загрузка медиа…':'Формат медиа не поддерживается.','empty'));
      } else {
        try {
          let raw=Uint8Array.from(atob(payload.base64),c=>c.charCodeAt(0));
          const encoding=payload.headers.find(([k])=>k.toLowerCase()==='content-encoding')?.[1].toLowerCase();
          if(encoding && encoding!=='identity') {
            const reader=new Blob([raw]).stream().pipeThrough(new DecompressionStream(encoding==='br'?'brotli':encoding)).getReader();
            const chunks=[];let size=0;
            try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32*1024*1024){await reader.cancel();throw Error('Распакованное медиа больше 32 МиБ');}chunks.push(part.value);}}finally{reader.releaseLock();}
            raw=new Uint8Array(await new Blob(chunks).arrayBuffer());
          }
          if(version!==renderVersion)return;
          const download=el('button','↓ Скачать','media-download');
          download.onclick=async()=>{try{if(window.librium){if(await window.librium.saveMedia(current.summary.id,side))toast('Файл сохранён');}else{const a=el('a');a.href=imageUrls[side];a.download=decodeURIComponent(new URL(current.summary.url).pathname.split('/').pop())||'media';a.click();}}catch(error){showError(error);}};
          if(mode==='audio') {
            const player=el('audio'), info=el('div',`${mime} · ${bytes(payload.size)}`,'image-info'), box=el('div',undefined,'audio-preview');
            player.controls=true;player.preload='metadata';player.setAttribute('aria-label','Воспроизвести аудио ответа');
            player.onerror=()=>{info.textContent='Не удалось воспроизвести аудио: неподдерживаемый кодек или неполное тело.';};
            box.append(player,info,download);node.content.replaceChildren(box);
            imageUrls[side]=URL.createObjectURL(new Blob([raw],{type:mime}));player.src=imageUrls[side];node.audioKey=audioKey;
          } else {
          const img=el('img'), info=el('div','Загрузка…','image-info'), tools=el('div',undefined,'image-tools'), zoom=el('button','Масштаб 1:1');
          img.alt='Ответ '+current.summary.url;
          img.onload=()=>{info.textContent=`${img.naturalWidth} × ${img.naturalHeight} · ${bytes(payload.size)}`;};
          img.onerror=()=>{info.textContent='Не удалось декодировать картинку. Проверь целостность тела во вкладке Hex.';};
          const box=el('div',undefined,'image-preview');box.append(img);
          img.draggable=false;let drag=null;
          box.onpointerdown=event=>{if(!box.classList.contains('actual-size')||event.button!==0)return;drag={x:event.clientX,y:event.clientY,left:node.content.scrollLeft,top:node.content.scrollTop,pointer:event.pointerId};box.setPointerCapture(event.pointerId);box.classList.add('dragging');event.preventDefault();};
          box.onpointermove=event=>{if(!drag||event.pointerId!==drag.pointer)return;node.content.scrollLeft=drag.left-(event.clientX-drag.x);node.content.scrollTop=drag.top-(event.clientY-drag.y);event.preventDefault();};
          const stopDrag=()=>{drag=null;box.classList.remove('dragging');};
          box.onpointerup=event=>{if(box.hasPointerCapture(event.pointerId))box.releasePointerCapture(event.pointerId);stopDrag();};box.onpointercancel=stopDrag;box.onlostpointercapture=stopDrag;

          zoom.onclick=()=>{const actual=box.classList.toggle('actual-size');zoom.textContent=actual?'Вписать':'Масштаб 1:1';if(!actual){node.content.scrollTop=0;node.content.scrollLeft=0;stopDrag();}};
          tools.append(info,zoom,download);node.content.replaceChildren(tools,box);
          imageUrls[side]=URL.createObjectURL(new Blob([raw],{type:mime}));img.src=imageUrls[side];
          }
        } catch(error) {node.content.replaceChildren(el('div',error.message,'empty'));}
      }
    } else if (mode === 'headers') {
      const table = el('table', undefined, 'headers-table');
      for (const [key,value] of payload.headers) { const row = el('tr'), k = el('td'), v = el('td'); k.append(highlighted(key)); v.append(highlighted(value)); row.append(k,v); table.append(row); }
      text = payload.headers.map(([k,v]) => `${k}: ${v}`).join('\n'); node.content.replaceChildren(payload.headers.length ? table : el('div', 'Нет заголовков', 'empty'));
    } else node.content.replaceChildren(text ? codeLines(text,type) : el('div', payload.complete ? 'Тело отсутствует' : 'Ожидание данных…', 'empty'));
    node.copyText = text;
    node.content.scrollTop = scroll; node.content.scrollLeft = left;
    const query = $('find').value.toLowerCase(); if (query) matches += text.toLowerCase().split(query).length-1;
  }));
  if (version === renderVersion) $('matches').textContent = $('find').value ? `${matches} совп.` : '';
}
async function loadWs(){
 if(selected===null||detail?.summary.status!==101)return;
 const id=selected,cursor=wsBefore;
 const data=await api(`traffic/${id}/ws`+(cursor?`?before=${cursor}`:''));
 if(selected!==id||cursor!==wsBefore)return;
 const signature=JSON.stringify(data);if(signature!==wsSignature){wsData=data;wsSignature=signature;await renderDetail();}
}
async function loadDetail() {
  if (selected === null) return;
  const id = selected;
  if(detail?.summary.id===id && detail.request.complete && detail.response.complete)return;
  try { const data = await api('traffic/' + id); if (selected !== id) return; const signature = JSON.stringify(data); if (signature !== detailSignature) { if(!detail){modes.request=data.summary.status===101?'ws':'http';modes.response=data.summary.status===101?'ws':imageType(data.response,data.summary.url)?'image':audioType(data.response,data.summary.url)?'audio':'pretty';} detail = data; detailSignature = signature; await renderDetail(); } }
  catch (error) { if (selected !== id) return; if (error.message.includes('404')) { detail = null; detailSignature = ''; await renderDetail(); $('selection').replaceChildren(el('span','Запрос удалён из истории.')); } else throw error; }
}
async function choose(id) {
  if (id === selected) return;
  selected = id; wsData=null;wsBefore=null;wsSignature="";detail = null; detailSignature = ''; renderRows(); await renderDetail();
  $('selection').replaceChildren(el('span','#'+id,'selection-id'),el('span','Загрузка…'));
  try { await loadDetail(); await loadWs(); } catch(error) { showError(error); }
}
async function refresh() {
  try {
    if (!paused) { await loadPage(); await loadDetail(); await loadWs(); }
    $('connection').textContent = paused ? 'Список на паузе' : 'Прокси подключён'; $('dot').classList.toggle('live', !paused); showError(null);
  } catch(error) { $('connection').textContent = 'Нет связи с ядром'; $('dot').classList.remove('live'); showError(error); }
  finally { setTimeout(refresh, 1000); }
}
function renderFilterChips(){
  const box=$('filter-chips');box.replaceChildren();
  const add=(label,remove)=>{const button=el('button',label+' ×','filter-chip');button.title='Убрать условие';button.onclick=()=>{remove();renderFilterChips();filtersChanged();};box.append(button);};
  if($('filter').value)add('Поиск: '+$('filter').value,()=>{$('filter').value='';});
  if($('traffic-type').value)add('Тип: '+$('traffic-type').selectedOptions[0].textContent,()=>{$('traffic-type').value='';});
  if($('method').value)add('Метод: '+$('method').value,()=>{$('method').value='';});
  if($('status').value)add('Статус: '+$('status').selectedOptions[0].textContent,()=>{$('status').value='';});
  filterRules.forEach((rule,index)=>add(LibriumFilters.label(rule),()=>filterRules.splice(index,1)));
  box.hidden=!box.children.length;
  if(box.children.length){box.prepend(el('span','Все условия (И):'));const reset=el('button','Сбросить всё','quiet');reset.onclick=()=>{filterRules=[];for(const id of ['filter','method','status','traffic-type'])$(id).value='';renderFilterChips();filtersChanged();};box.append(reset);}
}
for (const id of ['filter','method','status','traffic-type']) $(id).addEventListener('input', ()=>{renderFilterChips();filtersChanged();});
for(const [key,label] of Object.entries(LibriumFilters.fields)){const option=el('option',label);option.value=key;$('rule-field').append(option);}
function ruleOperators(){const numeric=LibriumFilters.numeric($('rule-field').value);$('rule-op').replaceChildren();for(const key of numeric?['eq','gte','lte','ne']:['contains','not_contains','eq','ne']){const option=el('option',LibriumFilters.operators[key]);option.value=key;$('rule-op').append(option);}$('rule-value').type=numeric?'number':'text';$('rule-value').value='';$('rule-value').placeholder=numeric?'Например: 400':'Например: api.example.com';$('rule-error').textContent='';}
$('rule-field').onchange=ruleOperators;ruleOperators();
$('filters-open').onclick=()=>{$('filters-dialog').showModal();$('rule-value').focus();};$('filters-close').onclick=()=>$('filters-dialog').close();
function addRule(rule){const error=LibriumFilters.validate(rule);$('rule-error').textContent=error;if(error)return;if(!filterRules.some(r=>JSON.stringify(r)===JSON.stringify(rule)))filterRules.push(rule);renderFilterChips();filtersChanged();$('filters-dialog').close();}
$('filter-form').onsubmit=event=>{event.preventDefault();addRule({field:$('rule-field').value,op:$('rule-op').value,value:$('rule-value').value.trim()});};
document.querySelectorAll('[data-preset]').forEach(button=>button.onclick=()=>{const kind=button.dataset.preset;if(kind==='errors')addRule({field:'status',op:'gte',value:'400'});else if(kind==='post')addRule({field:'method',op:'eq',value:'POST'});else{const row=rows.find(r=>r.id===selected);if(!row){$('rule-error').textContent='Сначала выбери запрос в истории.';return;}addRule({field:'host',op:'eq',value:new URL(row.url).hostname});}});
$('page-next').onclick=()=>{if(pageAnchor===null)pageAnchor=pageNewest;pageOffset+=PAGE_SIZE;loadPage().catch(showError);};
$('page-prev').onclick=()=>{pageOffset=Math.max(0,pageOffset-PAGE_SIZE);if(pageOffset===0)pageAnchor=null;loadPage().catch(showError);};
$('page-live').onclick=()=>{pageOffset=0;pageAnchor=null;loadPage().catch(showError);};
$('find').oninput = renderDetail;
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? '▶ Продолжить' : 'Ⅱ Пауза списка'; $('pause').classList.toggle('active',paused); };
$('clear').onclick = async () => { if(!window.confirm('Удалить всю сохранённую историю запросов с диска?'))return; try { await api('traffic','DELETE'); ++listGeneration; pageOffset=0;pageAnchor=null;pageTotal=0;pageMatched=0; rows = []; selected = null; detail = null; detailSignature = ''; rowsSignature = ''; renderRows(); renderDetail(); $('selection').replaceChildren(el('span','История очищена')); } catch(error) { showError(error); } };
$('setup').onclick = () => $('dialog').showModal(); $('close').onclick = () => $('dialog').close();
$('ca').onclick = async () => { try { if(window.librium) { if(await window.librium.saveCertificate()) toast('Сертификат сохранён'); } else { const res = await fetch('/api/ca',{headers:{'x-librium-token':token}}); if(!res.ok) throw Error(`API: ${res.status}`); const url=URL.createObjectURL(await res.blob()); const a=el('a'); a.href=url; a.download='librium-ca.crt'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); } } catch(error) { showError(error); } };
document.addEventListener('keydown',event=>{if(event.ctrlKey && event.key.toLowerCase()==='k'){event.preventDefault();$('filter').focus();}if(event.ctrlKey && event.key.toLowerCase()==='f'){event.preventDefault();$('find').focus();}});
const divider=$('divider');
divider.onpointerdown=event=>{divider.setPointerCapture(event.pointerId);};
divider.onpointermove=event=>{if(divider.hasPointerCapture(event.pointerId)){const main=document.querySelector('main').getBoundingClientRect();document.documentElement.style.setProperty('--history',Math.max(30,Math.min(60,(event.clientX-main.left)/main.width*100))+'%');}};
divider.onpointerup=event=>divider.releasePointerCapture(event.pointerId);
divider.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const current=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--history'));document.documentElement.style.setProperty('--history',Math.max(30,Math.min(60,current+(event.key==='ArrowRight'?2:-2)))+'%');}};
$('filter-session').onchange=()=>{sessionState.activeId=$('filter-session').value;applySession();persistSessions();loadPage().catch(showError);};
function sessionDialog(rename){sessionEditing=rename;$('session-title').textContent=rename?'Переименовать сессию':'Новая сессия фильтров';$('session-name').value=rename?sessionState.sessions.find(s=>s.id===sessionState.activeId).name:'';$('session-copy-row').hidden=rename;$('session-copy').checked=true;$('session-error').textContent='';$('session-dialog').showModal();$('session-name').focus();}
$('session-new').onclick=()=>sessionDialog(false);$('session-rename').onclick=()=>sessionDialog(true);$('session-cancel').onclick=()=>$('session-dialog').close();
$('session-form').onsubmit=event=>{event.preventDefault();const name=$('session-name').value.trim();if(!name){$('session-error').textContent='Введи название';return;}if(sessionState.sessions.some(s=>s.name.toLowerCase()===name.toLowerCase()&&(!sessionEditing||s.id!==sessionState.activeId))){$('session-error').textContent='Такая сессия уже есть';return;}
 if(sessionEditing)sessionState.sessions.find(s=>s.id===sessionState.activeId).name=name;else{if(sessionState.sessions.length>=200){$('session-error').textContent='Достигнут лимит: 200 сессий';return;}const id=crypto.randomUUID();sessionState.sessions.push({id,name,...($('session-copy').checked?currentFilters():emptyFilters())});sessionState.activeId=id;}
 applySession();persistSessions();loadPage().catch(showError);$('session-dialog').close();};
$('session-delete').onclick=()=>{const current=sessionState.sessions.find(s=>s.id===sessionState.activeId);if(!window.confirm(`Удалить сессию «${current.name}»? История запросов останется.`))return;sessionState.sessions=sessionState.sessions.filter(s=>s.id!==current.id);if(!sessionState.sessions.length)sessionState.sessions=[{id:crypto.randomUUID(),name:'Основная',...emptyFilters()}];sessionState.activeId=sessionState.sessions[0].id;applySession();persistSessions();loadPage().catch(showError);};
$('preset-ws').onclick=()=>{$('traffic-type').value='ws';renderFilterChips();filtersChanged();$('filters-dialog').close();};
document.querySelectorAll('[data-sort]').forEach(button=>button.onclick=()=>{const field=button.dataset.sort;sortOrder=field===sortField?(sortOrder==='asc'?'desc':'asc'):['method','url'].includes(field)?'asc':'desc';sortField=field;renderSort();filtersChanged();});
renderDetail();loadInfo().catch(showError);initSessions().then(refresh).catch(showError);
