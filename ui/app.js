'use strict';
const $ = id => document.getElementById(id);
let rows = [], selected = null, detail = null, paused = false, detailSignature = '', rowsSignature = '', wrapped = true;
let refreshEpoch=0;
const currentRefresh=ticket=>ticket===undefined||(!paused&&ticket===refreshEpoch);
let wsData=null,wsBefore=null,wsSignature="";
const wsRequests=new Map();
let wsExactFilter=null;
let wsRequestCount=0,wsQueuedRequest=null;
function discardWsQuery(request){
 if(wsRequests.get(request.key)===request)wsRequests.delete(request.key);
 if(wsQueuedRequest===request)wsQueuedRequest=null;
 request.resolve(null);
}
function startWsQuery(request){
 if(!request.active()){discardWsQuery(request);return;}
 wsRequestCount++;
 const finish=(error,data)=>{
  wsRequestCount--;if(wsRequests.get(request.key)===request)wsRequests.delete(request.key);
  const next=wsQueuedRequest;wsQueuedRequest=null;if(next)startWsQuery(next);
  if(error)request.reject(error);else request.resolve(data);
 };
 api(request.path,request.body?'POST':'GET',request.body).then(data=>finish(null,data),error=>finish(error));
}
function requestWsQuery(key,path,active,body){
 if(wsQueuedRequest&&wsQueuedRequest.key!==key)discardWsQuery(wsQueuedRequest);
 const previous=wsRequests.get(key);if(previous){previous.active=active;return previous.promise;}
 let resolve,reject;const promise=new Promise((success,failure)=>{resolve=success;reject=failure;}),request={key,path,active,body,promise,resolve,reject};
 wsRequests.set(key,request);
 if(wsRequestCount<2)startWsQuery(request);else wsQueuedRequest=request;
 return promise;
}
let wsExporting=false;
let wsSummaryId=null,wsSummaryVersion=0;
let wsJsonValues=null,wsJsonValuesVersion=0;
let wsSocketIoEvents=null,wsSocketIoEventsVersion=0;
let wsMessageSaving=false;
let wsInspect=null,wsInspectVersion=0,wsInspectText='';
let wsJsonFields=null,wsJsonFieldsVersion=0;
let wsInflate=null,wsInflateVersion=0;
let wsCompareBaseline=null,wsCompare=null;
let wsSignatureController=null;
let captureContextsController=null;
let wsArchiveController=null;
let wsContextController=null;
let wsProfileController=null;
let jsonRpcRelatedController=null;
const modes = { request: 'http', response: 'pretty' };
const paneNodes = {};
let filterRules=[],sortField="id",sortOrder="desc";
const wsContentKinds=window.LibriumWSProfile?.kinds||[];
for(const kind of wsContentKinds){const option=el('option',kind.name);option.value=kind.value;$('ws-content-kind').append(option);}
function wsSearchValue(){return $('ws-search-format').value==='content_kind'?$('ws-content-kind').value:$('ws-filter').value;}
function wsContentHint(){return $('ws-search-format').value==='content_kind'?wsContentKinds.find(kind=>kind.value===$('ws-content-kind').value):null;}
const PAGE_SIZE=500;
let pageOffset=0, pageAnchor=null, pageTotal=0, pageMatched=0, pageNewest=0, listGeneration=0;
async function loadPage(ticket) {
  if(!currentRefresh(ticket))return;
  const generation=++listGeneration;
  const query={offset:pageOffset,limit:PAGE_SIZE,before:pageAnchor,query:$('filter').value,method:$('method').value,status:$('status').value,rules:filterRules,traffic_type:$('traffic-type').value,source:$('traffic-source').value||undefined,capture_context:captureContext?.id,ws_role:$('traffic-ws-role').value,sort:sortField,order:sortOrder};
  const data=await api('traffic-page?q='+encodeURIComponent(JSON.stringify(query)));
  if(generation!==listGeneration||!currentRefresh(ticket))return;
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

let captureContext=null;
let sessionState=null,sessionEditing=false,sessionSaveGeneration=0;
const currentFilters=()=>({query:$('filter').value,method:$('method').value,status:$('status').value,type:$('traffic-type').value,source:$('traffic-source').value,captureContext:captureContext?{...captureContext}:null,wsRole:$('traffic-ws-role').value,sort:sortField,order:sortOrder,rules:JSON.parse(JSON.stringify(filterRules))});
const emptyFilters=()=>({query:'',method:'',status:'',type:'',source:'',captureContext:null,wsRole:'',sort:'id',order:'desc',rules:[]});
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
 captureContext=LibriumFilters.contextFilter(session.captureContext);sortField=session.sort||'id';sortOrder=session.order||'desc';renderSort();$('filter').value=session.query;$('method').value=session.method;$('status').value=session.status;$('traffic-type').value=session.type;$('traffic-source').value=session.source||'';if($('traffic-ws-role').value!==(session.wsRole||''))rows=[];$('traffic-ws-role').value=session.wsRole||'';filterRules=JSON.parse(JSON.stringify(session.rules));renderSessions();renderFilterChips();pageOffset=0;pageAnchor=null;
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
async function api(path, method = 'GET', body) {
  if (window.librium) return window.librium.request(path, method, body);
  const response = await fetch('/api/' + path, { method, headers: { 'x-librium-token': token,...(body?{'content-type':'application/json'}:{}) },...(body?{body:JSON.stringify(body)}:{}) });
  if (!response.ok) throw Error(`API: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
function splitUrl(url) { try { const u = new URL(url); return { host: u.host, path: u.pathname + u.search }; } catch { return { host: url, path: '/' }; } }
function renderSort(){
 document.querySelectorAll('[data-sort]').forEach(button=>{const active=button.dataset.sort===sortField;button.textContent=button.dataset.label+(active?(sortOrder==='asc'?' ↑':' ↓'):'');button.closest('th').setAttribute('aria-sort',active?(sortOrder==='asc'?'ascending':'descending'):'none');});
 $('sort-description').textContent=sortField==='id'?(sortOrder==='desc'?'Новые сверху ↓':'Старые сверху ↑'):'Сортировка: '+document.querySelector(`[data-sort="${sortField}"]`).dataset.label;
}
function renderRows() {
  const query = $('filter').value.toLowerCase(), method = $('method').value, status = $('status').value,source=$('traffic-source').value,role=$('traffic-ws-role').value;
  const shown = rows.filter(r => `${r.id} ${r.method} ${r.url} ${r.status ?? ''}`.toLowerCase().includes(query) && (!method || r.method === method) && (!source||(r.source||'proxy')===source) && (!captureContext||r.capture_context===captureContext.id) && LibriumFilters.wsRoleMatches(r,role) && LibriumFilters.statusMatches(r,status) && LibriumFilters.matches(r,filterRules));
  const fragment = document.createDocumentFragment();
  for (const row of shown) {
    const tr = el('tr'); tr.dataset.id = row.id;tr.dataset.wsRole=row.ws_role||''; tr.tabIndex = 0; tr.classList.toggle('selected', row.id === selected);
    tr.setAttribute('aria-selected', String(row.id === selected)); tr.setAttribute('aria-label', `ID ${row.id}: ${row.method} ${row.url}`);
    const url = splitUrl(row.url), urlCell = el('td'); urlCell.append(el('span', url.host, 'host'), el('span', url.path, 'path')); urlCell.title = row.url;if(row.ws_role||row.status===101||/^wss?:/i.test(row.url)||role==='unknown'){const badge=el('span',LibriumFilters.wsRoleLabel(row.ws_role),'ws-role-tag');badge.title=row.ws_role==='server'?'Приложение приняло соединение':row.ws_role==='client'?'Приложение подключилось к серверу':'Роль в записи не указана';urlCell.append(badge);}
    const methodCell = el('td'); methodCell.append(el('span', row.method, 'method-tag ' + row.method));
    if(row.capture_target||row.capture_context){const target=el('span',row.capture_target||'Контекст захвата','capture-target-tag');target.title='Окно / поток: '+(row.capture_target||'Контекст захвата');urlCell.append(target);}
    const idCell = el('td', row.id, 'request-id'); idCell.title = String(row.id);
    const code=el('td',LibriumFilters.statusText(row)+(row.error&&row.status!=null?' !':''),`status s${String(row.status)[0]}`);if(row.error){code.title=row.error;code.classList.add('capture-problem');}
    tr.append(idCell, methodCell, urlCell, code, el('td', bytes(row.size), 'bytes'));
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
  if (!shown.length && (rows.length || pageTotal>0)) $('empty').replaceChildren(el('h3', 'Ничего не найдено'), el('p', 'Измени фильтр, чтобы увидеть запросы.'));
  else if (!rows.length) $('empty').replaceChildren(el('div', '↔', 'empty-icon'), el('h3', 'Ожидание трафика'), el('p', 'Прокси 127.0.0.1:8080 · Настройка HTTPS слева внизу.'));
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
    button.onclick = () => { modes[side] = key;if(detail?.summary.status===101&&$('ws-layout').value==='timeline'&&key!=='ws'){setWsLayout('split');} renderDetail(); }; tabs.append(button);
  }
  const notice = el('div', '', 'notice'); notice.hidden = true;
  const wsFormat=el('select');wsFormat.setAttribute('aria-label','Формат WebSocket');wsFormat.className='ws-format';wsFormat.hidden=true;
  for(const [value,label]of [['pretty','WS: Авто / JSON'],['cdp','WS: CDP / DevTools'],['jsonrpc','WS: JSON-RPC 2.0'],['msgpack','WS: MessagePack'],['protobuf','WS: Protobuf (без схемы)'],['raw','WS: Исходное'],['hex','WS: Hex']]){const option=el('option',label);option.value=value;wsFormat.append(option);}
  wsFormat.onchange=()=>renderDetail();title.append(wsFormat);
  const content = el('div', undefined, 'content');
  pane.append(title, tabs, notice, content); $('panes').append(pane); paneNodes[side] = { pane, heading, state, tabs, notice, content, wsFormat, copyText: '' };
}
function highlighted(text,query=$('find').value) {
  const fragment = document.createDocumentFragment();
  if (!query) { fragment.append(document.createTextNode(text)); return fragment; }
  const haystack = text.toLowerCase(), needle = query.toLowerCase(); let cursor = 0, index;
  while ((index = haystack.indexOf(needle, cursor)) !== -1) { fragment.append(document.createTextNode(text.slice(cursor, index)), el('mark', text.slice(index, index + query.length))); cursor = index + query.length; }
  fragment.append(document.createTextNode(text.slice(cursor))); return fragment;
}
function codeLines(text, type, limit=3000, query=$('find').value) {
  const fragment = document.createDocumentFragment(), lines = text.split('\n');
  const headerEnd=lines.indexOf('');
  for (let index = 0; index < Math.min(lines.length, limit); index++) {
    const row = el('div', undefined, 'code-line'), content = el('span', undefined, 'line-text');
    if (!query && type === 'json') {
      const regex = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(-?\d+(?:\.\d+)?|true|false|null)\b/g;
      let cursor = 0; for (const match of lines[index].matchAll(regex)) { content.append(document.createTextNode(lines[index].slice(cursor, match.index)), el('span', match[0], match[1] ? 'json-key' : match[2] ? 'json-string' : 'json-number')); cursor = match.index + match[0].length; } content.append(document.createTextNode(lines[index].slice(cursor)));
    } else if (type==='http' && index>0 && (headerEnd<0||index<headerEnd) && /^[^\s:]+:/.test(lines[index])) {
      const colon=lines[index].indexOf(':'),key=el('span',undefined,'http-header-key'),value=el('span',undefined,'http-header-value');
      key.append(highlighted(lines[index].slice(0,colon+1),query));value.append(highlighted(lines[index].slice(colon+1),query));content.append(key,value);
    } else if (!query && type === 'http' && index === 0) content.append(el('span', lines[index], 'http-start'));
    else content.append(highlighted(lines[index],query));
    row.append(el('span', index + 1, 'line-number'), content); fragment.append(row);
  }
  if (lines.length > limit) fragment.append(el('div', `Показаны первые ${limit} строк. Копирование содержит весь предпросмотр.`, 'notice'));
  return fragment;
}
function hexView(base64) {
  const raw = atob(base64.slice(0,87384)).slice(0,65536), lines = [];
  for (let i = 0; i < raw.length; i += 16) { const part = [...raw.slice(i,i+16)].map(c => c.charCodeAt(0)); lines.push(i.toString(16).padStart(6,'0') + '  ' + part.map(n => n.toString(16).padStart(2,'0')).join(' ').padEnd(47,' ') + '  ' + part.map(n => n >= 32 && n < 127 ? String.fromCharCode(n) : '.').join('')); }
  return lines.join('\n');
}
async function bodyText(payload) {
  if(payload.headers.some(([k,v])=>k==='x-librium-body-decoded'&&v==='true'))return {text:payload.text,notice:'Тело декодировано приложением (CDP).'};
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
  const timeline=detail?.summary.status===101&&$('ws-layout').value==='timeline';$('panes').classList.toggle('ws-timeline',timeline);
  for(const [side,node]of Object.entries(paneNodes)){const label=timeline&&side==='request'?'Сообщения WS':detail?.summary.status===101?(side==='request'?'Отправлено':'Получено'):(side==='request'?'Request':'Response');node.heading.replaceChildren(el('span',timeline&&side==='request'?'↔':side==='request'?'↗':'↙'),document.createTextNode(label));}
  $('ws-export').disabled=wsExporting||(!window.librium?.exportWs&&typeof window.showSaveFilePicker!=='function');
  $('ws-export').title=window.librium?.exportWs||typeof window.showSaveFilePicker==='function'?'Все сохранённые сообщения выбранного WebSocket, независимо от фильтров':'Экспорт доступен в настольном Librium или браузере с сохранением файлов';
  const version = ++renderVersion;
  $('ws-tools').hidden=detail?.summary.status!==101;
  if (!detail) {
    for (const [side,node] of Object.entries(paneNodes)) { releaseImage(side); node.audioKey=null; node.content.replaceChildren(el('div', 'Выбери запрос для просмотра', 'empty')); node.state.textContent = ''; node.notice.hidden = true; node.wsFormat.hidden=true;node.copyText = ''; }
    return;
  }
  const current = detail;
  const selectionUrl = el('button', current.summary.url, 'selection-url'); selectionUrl.title = 'Копировать URL: '+current.summary.url;
  selectionUrl.setAttribute('aria-label','Копировать полный URL');
  selectionUrl.onclick=async()=>{try{if(window.librium)await window.librium.copy(current.summary.url);else await navigator.clipboard.writeText(current.summary.url);toast('URL скопирован');}catch(error){showError(error);}};
  const open=el('button','↗','open-url');open.title='Открыть в браузере';open.setAttribute('aria-label','Открыть URL в браузере');
  open.onclick=async()=>{try{const url=new URL(current.summary.url);if(!['http:','https:'].includes(url.protocol))throw Error('Разрешены только HTTP и HTTPS адреса');if(window.librium)await window.librium.openUrl(url.href);else window.open(url.href,'_blank','noopener,noreferrer');}catch(error){showError(error);}};
  $('selection').replaceChildren(el('span', '#' + current.summary.id, 'selection-id'),el('span',current.summary.method,'selection-method'),el('span',({proxy:'Прокси',external:'Адаптер',cdp_node:'Node.js',cdp_chromium:'Окна'})[current.summary.source]||'Прокси','selection-source'),open, selectionUrl, el('span', `${LibriumFilters.statusText(current.summary)} · ${current.summary.elapsed_ms ?? '…'} ms`, 'selection-time'));
  if(current.summary.capture_target||current.summary.capture_context){const label=current.summary.capture_target||'Контекст захвата',target=el('button',label,'selection-target');target.title=current.summary.capture_context?'Только это окно / поток в пределах подключения: '+label:'Поиск по названию (контекст в старой записи не указан): '+label;target.onclick=()=>{if(detail!==current)return;if(current.summary.capture_context){captureContext={id:current.summary.capture_context,label};renderFilterChips();filtersChanged();return;}const rule={field:'capture_target',op:'eq',value:label};if(filterRules.length>=32&&!filterRules.some(value=>JSON.stringify(value)===JSON.stringify(rule))){showError(Error('Допускается до 32 условий фильтрации. Удали одно условие и повтори.'));return;}captureContext=null;addRule(rule);};$('selection').append(target);}
  if(current.summary.ws_role||current.summary.status===101||/^wss?:/i.test(current.summary.url)||current.request.headers.some(([key,value])=>key.toLowerCase()==='upgrade'&&value.toLowerCase()==='websocket'))$('selection').append(el('span',LibriumFilters.wsRoleLabel(current.summary.ws_role),'ws-role-tag'));
  let matches = 0;
  await Promise.all(['request','response'].map(async side => {
    const node = paneNodes[side], payload = current[side], mode = modes[side];
    if(timeline&&side==='response'){releaseImage(side);node.audioKey=null;node.content.replaceChildren();node.copyText='';return;}
    const audioKey=mode==='audio'?`${current.summary.id}:${payload.base64.length}:${payload.complete}:${payload.truncated}`:null;
    if(audioKey && node.audioKey===audioKey)return;
    node.audioKey=null;releaseImage(side);node.wsFormat.hidden=mode!=='ws';
    node.tabs.querySelector('[data-mode="ws"]').hidden=current.summary.status!==101;
    node.tabs.querySelector('[data-mode="image"]').hidden=!imageType(payload,current.summary.url);
    node.tabs.querySelector('[data-mode="audio"]').hidden=!audioType(payload,current.summary.url);
    const decoded = mode === 'headers' || mode === 'hex' || mode === 'image' || mode === 'audio' || mode === 'ws' ? {text:'',notice:''} : await bodyText(payload);
    if (version !== renderVersion) return;
    node.tabs.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
    const captureNote=(current.summary.status===101?current.request:payload).headers.find(([k])=>k.toLowerCase()==='x-librium-capture-note')?.[1];
    node.state.textContent = current.summary.status===101?'WebSocket · '+(wsData?.state==='open'?'открыт':wsData?.state==='closed'?'закрыт':'архив'):`${bytes(payload.size)}${payload.complete ? '' : captureNote?' · данные недоступны / частично':' · поток / ожидание'}`;
    const notices = [captureNote,current.summary.status===101?null:current.summary.error, mode === 'hex' && payload.base64.length > 87384 ? 'Hex: показаны первые 64 КиБ.' : '', payload.truncated ? 'Тело сохранено частично. Для картинок и аудио лимит 32 МиБ, для остальных тел — 64 КиБ.' : '', decoded.notice].filter(Boolean);
    node.notice.hidden = !notices.length; node.notice.textContent = notices.join(' · ');
    if(side==='response' && [301,302,303,307,308].includes(current.summary.status)) {
      const location=payload.headers.find(([k])=>k.toLowerCase()==='location')?.[1];
      if(location)try{const target=new URL(location,current.summary.url);if(['http:','https:'].includes(target.protocol)){
        const follow=el('button','Открыть запрос по Location','redirect-open');follow.onclick=()=>openRedirect(current,target).catch(showError);
        node.notice.hidden=false;node.notice.append(el('span',` Перенаправление ${current.summary.status} → ${target.href} `),follow);
      }}catch{}
    }
    let text = decoded.text, type = '';
    if (mode === 'http') { text = (side === 'request' ? `${current.summary.method} ${current.summary.url}` : `Status: ${LibriumFilters.statusText(current.summary)}`) + '\n' + payload.headers.map(([k,v]) => `${k}: ${v}`).join('\n') + '\n\n' + decoded.text; type = 'http'; }
    if (mode === 'pretty') { try { text = JSON.stringify(JSON.parse(decoded.text),null,2); type = 'json'; } catch { /* Plain text and HTML remain inert text. */ } }
    if (mode === 'hex') text = hexView(payload.base64);
    const scroll = node.content.scrollTop, left = node.content.scrollLeft;
    if(mode==='ws') {
      const messages=(wsData?.messages||[]).filter(m=>timeline||m.direction===(side==='request'?'sent':'received'));
      const entries=messages.map(m=>{const decoded=window.LibriumWS?.analyze(m,node.wsFormat.value)||{format:m.kind,text:m.text};
        const value=node.wsFormat.value==='hex'?hexView(m.base64):node.wsFormat.value==='raw'?(m.kind==='BINARY'||!m.text?hexView(m.base64):m.text):(decoded.text??hexView(m.base64));
        const format=node.wsFormat.value==='hex'?'Hex / байты':decoded.format,offset=['hex','hex_mask','protocol_field'].includes($('ws-search-format').value)&&Number.isSafeInteger(m.match_offset)?' · найдено @ 0x'+m.match_offset.toString(16).padStart(6,'0'):'';
        const header=`[${new Date(m.time).toLocaleTimeString()}.${String(m.time%1000).padStart(3,'0')}] ${m.direction==='sent'?'→':'←'}${timeline?(m.direction==='sent'?' Отправлено':' Получено'):''} #${m.id} ${m.kind} · ${format} · ${bytes(m.size)}${m.truncated?' · сохранено '+bytes(atob(m.base64||'').length):''}${offset}`;
        const field=$('ws-search-format').value==='jsonpointer'&&typeof m.field_preview==='string'?`Поле ${$('ws-json-pointer').value||'(весь JSON)'}: ${m.field_preview}`:'';return {message:m,header,value,field};});
      text=entries.map(entry=>entry.header+'\n'+(entry.field?entry.field+'\n':'')+entry.value).join('\n\n');
      const direction=$('ws-direction').value,sideDirection=side==='request'?'sent':'received';
      const emptyMessage=!$('ws-filter-error').hidden?'Исправь параметры поиска.':wsData?.state==='not_recorded'?'Этот WebSocket записан старой версией: сообщений нет. Переподключи клиент.':!timeline&&direction&&direction!==sideDirection?(sideDirection==='sent'?'Отправленные':'Полученные')+' сообщения скрыты фильтром направления.':direction||$('ws-filter').value||$('ws-kind').value||['jsonpointer','socketio_event','protocol_field','content_kind'].includes($('ws-search-format').value)?(timeline?'По выбранным условиям сообщений нет.':'По выбранным условиям сообщений в этом направлении нет.'):wsData?.total>0?(timeline?'На этой странице сообщений нет.':'На этой странице сообщений в этом направлении нет.'):wsData?.state==='closed'?'Сообщения не записаны.':timeline?'Ожидание сообщений…':'Сообщений в этом направлении пока нет.';
      if(entries.length){const fragment=document.createDocumentFragment();let remaining=3000;
        for(const entry of entries){const card=el('section',undefined,'ws-message'),actions=el('div',undefined,'ws-message-actions'),save=el('button',entry.message.truncated?'Сохранить фрагмент':'Сохранить байты','ws-message-save');
          card.dataset.messageId=entry.message.id;card.dataset.direction=entry.message.direction;save.disabled=wsMessageSaving;save.setAttribute('aria-label',`Сохранить байты сообщения #${entry.message.id}`);save.title='Исходные байты из архива, без форматирования и метаданных';save.onclick=()=>saveWsMessage(current.summary.id,entry.message.id);
          const inspect=el('button','Открыть','ws-message-open');inspect.setAttribute('aria-label',`Открыть сообщение #${entry.message.id}`);
          let match=null;if(['protocol_field','hex_mask'].includes($('ws-search-format').value)&&Number.isSafeInteger(entry.message.match_offset)&&Number.isSafeInteger(entry.message.match_length))match={offset:entry.message.match_offset,length:entry.message.match_length};if($('ws-search-format').value==='hex'&&Number.isSafeInteger(entry.message.match_offset)){try{match={offset:entry.message.match_offset,length:window.LibriumWS.normalizeHex($('ws-filter').value).length/2};}catch{}}
          inspect.onclick=()=>openWsInspectorFromHint(current.summary.id,entry.message.id,node.wsFormat.value,match,entry.message.rpc_entries?.[0]??null,wsContentKinds.find(kind=>kind.value===entry.message.content_kind)?.codec);
          const header=el('span');header.append(highlighted(entry.header));actions.append(header,inspect,save);card.append(actions);if(entry.field)card.append(el('div',entry.field,'ws-field-preview'));
          if(remaining>0){card.append(codeLines(entry.value,'',remaining));remaining-=Math.min(remaining,entry.value.split('\n').length);}else card.append(el('div','Предпросмотр скрыт: достигнут лимит 3000 строк. Байты сообщения можно сохранить.','notice'));
          fragment.append(card);
        }node.content.replaceChildren(fragment);
      }else node.content.replaceChildren(el('div',emptyMessage,'empty'));
      const close=wsData?.close,closeText=close&&Number.isInteger(close.code)?` · Код закрытия: ${close.code}${close.direction==='sent'?' (отправлено)':close.direction==='received'?' (получено)':''}${close.reason?' · Причина: '+close.reason:''}`:'';
      node.notice.hidden=false;node.notice.textContent=`Сообщений: ${wsData?.matched??wsData?.total??0} / ${wsData?.total||0}${closeText}${wsData?.error?' · '+wsData.error:''}${captureNote?' · '+captureNote:''} `;
      if(wsData?.older){const older=el('button','Раньше');older.onclick=()=>{wsBefore=wsData.messages[0].id;loadWs().catch(showError);};node.notice.append(older);}
      if(wsBefore){const live=el('button','К новым');live.onclick=()=>{wsBefore=null;loadWs().catch(showError);};node.notice.append(live);}
    } else if (mode === 'image' || mode === 'audio') {
      const mime=mode==='audio'?audioType(payload,current.summary.url):imageType(payload,current.summary.url);
      if(!mime || payload.truncated || !payload.complete) {
        node.content.replaceChildren(el('div',payload.truncated?'Медиа сохранено частично. Доступные байты — во вкладке Hex.':!payload.complete?(captureNote||'Загрузка медиа…'):'Формат медиа не поддерживается.','empty'));
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
    } else node.content.replaceChildren(text ? codeLines(text,type) : el('div', payload.complete ? 'Тело отсутствует' : captureNote||'Ожидание данных…', 'empty'));
    node.copyText = text;
    node.content.scrollTop = scroll; node.content.scrollLeft = left;
    const query = $('find').value.toLowerCase(); if (query) matches += text.toLowerCase().split(query).length-1;
  }));
  if (version === renderVersion) $('matches').textContent = $('find').value ? `${matches} совп.` : '';
}
async function loadWs(ticket){
 if(!currentRefresh(ticket))return;
 if(selected===null||detail?.summary.status!==101)return;
 const id=selected,cursor=wsBefore,search=wsSearchValue(),kind=$('ws-kind').value,format=$('ws-search-format').value,direction=$('ws-direction').value,pointer=format==='jsonpointer'?$('ws-json-pointer').value:'';
 $('ws-filter').setCustomValidity('');$('ws-filter').setAttribute('aria-invalid','false');$('ws-filter-error').hidden=true;$('ws-json-pointer').setCustomValidity('');$('ws-json-pointer').setAttribute('aria-invalid','false');
 if(format==='jsonpointer'){try{window.LibriumWS.validateJsonPointer(pointer);}catch(error){$('ws-json-pointer').setCustomValidity(error.message);$('ws-json-pointer').setAttribute('aria-invalid','true');$('ws-filter-error').textContent=error.message;$('ws-filter-error').hidden=false;await renderDetail();return;}}
 if(['hex','hex_mask','cdp_id','jsonrpc_id'].includes(format)){try{if(format==='hex')window.LibriumWS.normalizeHex(search);else if(format==='hex_mask')window.LibriumWS.normalizeHexMask(search);else if(format==='jsonrpc_id')window.LibriumWS.normalizeJsonRpcIdQuery(search);else window.LibriumWS.normalizeCdpId(search);}catch(error){$('ws-filter').setCustomValidity(error.message);$('ws-filter').setAttribute('aria-invalid','true');$('ws-filter-error').textContent=error.message;$('ws-filter-error').hidden=false;await renderDetail();return;}}
 const exactFilter=wsExactFilter,exact=exactFilter&&!['socketio','field'].includes(exactFilter.protocol)&&exactFilter.id===id&&exactFilter.pointer===pointer&&format==='jsonpointer'?{kind:exactFilter.kind,value:exactFilter.value}:undefined;
 const socketio_exact=exactFilter?.protocol==='socketio'&&exactFilter.id===id&&format==='socketio_event'?{namespace:exactFilter.namespace,kind:exactFilter.kind,value:exactFilter.value}:undefined;
 const field_exact=exactFilter?.protocol==='field'&&exactFilter.id===id&&format==='protocol_field'?exactFilter.condition:undefined;
 const params={before:cursor,search,kind,format,direction,pointer,...(exact?{exact}:{}),...(socketio_exact?{socketio_exact}:{}),...(field_exact?{field_exact}:{})},query=JSON.stringify(params),epoch=refreshEpoch,key=JSON.stringify([id,query,epoch]);
 const active=()=>wsExactFilter===exactFilter&&currentRefresh(ticket)&&epoch===refreshEpoch&&selected===id&&cursor===wsBefore&&search===wsSearchValue()&&kind===$('ws-kind').value&&format===$('ws-search-format').value&&direction===$('ws-direction').value&&pointer===(format==='jsonpointer'?$('ws-json-pointer').value:'');
 const post=exact||socketio_exact||field_exact||format==='jsonrpc_id';
 const request=requestWsQuery(key,post?`traffic/${id}/ws-search`:`traffic/${id}/ws?q=`+encodeURIComponent(query),active,post?params:undefined);
 let data;try{data=await request;}catch(error){if(!active())return;throw error;}
 if(data===null||!active())return;
 const signature=JSON.stringify(data);if(signature!==wsSignature){wsData=data;wsSignature=signature;await renderDetail();}
}
async function loadDetail(ticket) {
  if(!currentRefresh(ticket))return;
  if (selected === null) return;
  const id = selected;
  if(detail?.summary.id===id && ((detail.summary.source&&detail.summary.source!=='proxy')||(detail.request.complete && detail.response.complete)))return;
  try { const data = await api('traffic/' + id); if (selected !== id||!currentRefresh(ticket)) return; const signature = JSON.stringify(data); if (signature !== detailSignature) { if(!detail){modes.request=data.summary.status===101?'ws':'http';modes.response=data.summary.status===101?'ws':imageType(data.response,data.summary.url)?'image':audioType(data.response,data.summary.url)?'audio':'pretty';} detail = data; detailSignature = signature; await renderDetail(); } }
  catch (error) { if (selected !== id||!currentRefresh(ticket)) return; if (error.message.includes('404')) { detail = null; detailSignature = ''; await renderDetail(); $('selection').replaceChildren(el('span','Запрос удалён из истории.')); } else throw error; }
}
async function choose(id,exact=null) {
  if (id === selected) return;
  wsSignatureController?.close();
  selected = id;wsExactFilter=exact;syncWsExactChip(); wsData=null;wsBefore=null;wsSignature="";detail = null; detailSignature = ''; renderRows(); await renderDetail();
  $('selection').replaceChildren(el('span','#'+id,'selection-id'),el('span','Загрузка…'));
  try { await loadDetail(); await loadWs(); } catch(error) { showError(error); }
}
async function refresh() {
  const ticket=refreshEpoch;
  try {
    if(paused)return;
    await loadPage(ticket);if(!currentRefresh(ticket))return;
    await loadDetail(ticket);if(!currentRefresh(ticket))return;
    await loadWs(ticket);if(!currentRefresh(ticket))return;
    $('connection').textContent = 'Прокси подключён'; $('dot').classList.add('live'); showError(null);
  } catch(error) { if(!currentRefresh(ticket))return;$('connection').textContent = 'Нет связи с ядром'; $('dot').classList.remove('live'); showError(error); }
  finally { setTimeout(refresh, 1000); }
}
function renderFilterChips(){
  const box=$('filter-chips');box.replaceChildren();
  const add=(label,remove)=>{const button=el('button',label+' ×','filter-chip');button.title='Убрать условие';button.onclick=()=>{remove();renderFilterChips();filtersChanged();};box.append(button);};
  if($('filter').value)add('Поиск: '+$('filter').value,()=>{$('filter').value='';});
  if($('traffic-type').value)add('Тип: '+$('traffic-type').selectedOptions[0].textContent,()=>{$('traffic-type').value='';});
  if($('traffic-source').value)add('Источник: '+$('traffic-source').selectedOptions[0].textContent,()=>{$('traffic-source').value='';});
  if($('traffic-ws-role').value)add('Роль WS: '+({client:'клиент',server:'сервер',unknown:'неизвестна'})[$('traffic-ws-role').value],()=>{$('traffic-ws-role').value='';});
  if(captureContext)add('Только это окно / поток: '+captureContext.label,()=>{captureContext=null;});
  if($('method').value)add('Метод: '+$('method').value,()=>{$('method').value='';});
  if($('status').value)add('Статус: '+$('status').selectedOptions[0].textContent,()=>{$('status').value='';});
  filterRules.forEach((rule,index)=>add(LibriumFilters.label(rule),()=>filterRules.splice(index,1)));
  box.hidden=!box.children.length;
  if(box.children.length){box.prepend(el('span','Все условия (И):'));const reset=el('button','Сбросить всё','quiet');reset.onclick=()=>{filterRules=[];captureContext=null;for(const id of ['filter','method','status','traffic-type','traffic-source','traffic-ws-role'])$(id).value='';renderFilterChips();filtersChanged();};box.append(reset);}
}
for (const id of ['filter','method','status','traffic-type','traffic-source','traffic-ws-role']) $(id).addEventListener('input', ()=>{if(id==='traffic-ws-role')rows=[];renderFilterChips();filtersChanged();});
for(const [key,label] of Object.entries(LibriumFilters.fields)){const option=el('option',label);option.value=key;$('rule-field').append(option);}
function ruleOperators(){const numeric=LibriumFilters.numeric($('rule-field').value);$('rule-op').replaceChildren();for(const key of numeric?['eq','gte','lte','ne']:['contains','not_contains','eq','ne']){const option=el('option',LibriumFilters.operators[key]);option.value=key;$('rule-op').append(option);}$('rule-value').type=numeric?'number':'text';$('rule-value').value='';$('rule-value').placeholder=numeric?'Например: 400':'Например: api.example.com';$('rule-error').textContent='';}
$('rule-field').onchange=ruleOperators;ruleOperators();
$('filters-open').onclick=()=>{$('filters-dialog').showModal();$('rule-value').focus();};$('filters-close').onclick=()=>$('filters-dialog').close();
function openWsArchive(seed={}){
 if(!wsArchiveController)wsArchiveController=window.LibriumWSArchive.create({document,request:query=>api('ws-archive-search','POST',query),openMessage:openWsInspectorFromHint});
 const summary=detail?.summary,scope=captureContext||(summary?.capture_context?{id:summary.capture_context,label:summary.capture_target}:null);
 wsArchiveController.open(seed,scope);
}
$('ws-archive-open').onclick=()=>openWsArchive();
$('ws-archive-current').onclick=()=>{
 const format=$('ws-search-format').value,filter=wsExactFilter?.id===selected?wsExactFilter:null;
 openWsArchive({search:wsSearchValue(),format,kind:$('ws-kind').value,direction:$('ws-direction').value,pointer:format==='jsonpointer'?$('ws-json-pointer').value:'',...(filter?.protocol==='field'?{field_exact:filter.condition}:filter?.protocol==='socketio'?{socketio_exact:{namespace:filter.namespace,kind:filter.kind,value:filter.value}}:filter?{exact:{kind:filter.kind,value:filter.value}}:{})});
};
$('capture-contexts-open').onclick=()=>{if(!captureContextsController)captureContextsController=window.LibriumCaptureContexts.create({document,request:path=>api(path),apply:value=>{captureContext=LibriumFilters.contextFilter(value);renderFilterChips();filtersChanged();}});captureContextsController.open();};
function addRule(rule){const error=LibriumFilters.validate(rule);$('rule-error').textContent=error;if(error)return;if(!filterRules.some(r=>JSON.stringify(r)===JSON.stringify(rule)))filterRules.push(rule);renderFilterChips();filtersChanged();$('filters-dialog').close();}
$('filter-form').onsubmit=event=>{event.preventDefault();addRule({field:$('rule-field').value,op:$('rule-op').value,value:$('rule-value').value.trim()});};
document.querySelectorAll('[data-preset]').forEach(button=>button.onclick=()=>{const kind=button.dataset.preset;if(kind==='errors')addRule({field:'status',op:'gte',value:'400'});else if(kind==='post')addRule({field:'method',op:'eq',value:'POST'});else{const row=rows.find(r=>r.id===selected);if(!row){$('rule-error').textContent='Сначала выбери запрос в истории.';return;}addRule({field:'host',op:'eq',value:new URL(row.url).hostname});}});
$('page-next').onclick=()=>{if(pageAnchor===null)pageAnchor=pageNewest;pageOffset+=PAGE_SIZE;loadPage().catch(showError);};
$('page-prev').onclick=()=>{pageOffset=Math.max(0,pageOffset-PAGE_SIZE);if(pageOffset===0)pageAnchor=null;loadPage().catch(showError);};
$('page-live').onclick=()=>{pageOffset=0;pageAnchor=null;loadPage().catch(showError);};
$('find').oninput = renderDetail;
function wsFiltersChanged(){wsBefore=null;wsSignature='';wsData=null;renderDetail();loadWs().catch(showError);}
function setWsLayout(value){$('ws-layout').value=value==='timeline'?'timeline':'split';if(value==='timeline'){modes.request='ws';modes.response='ws';}try{localStorage.setItem('librium-ws-layout-v1',$('ws-layout').value);}catch(error){showError(error);}}
$('ws-layout').onchange=()=>{setWsLayout($('ws-layout').value);renderDetail();};
async function saveWsMessage(id,messageId,onError=showError){
 if(wsMessageSaving)return;wsMessageSaving=true;document.querySelectorAll('.ws-message-save').forEach(button=>button.disabled=true);$('ws-inspector-save').disabled=true;$('ws-inflate-save').disabled=true;
 try{
  let result;
  if(window.librium)result=await window.librium.saveWsMessage(id,messageId);
  else{const message=await api(`traffic/${id}/ws/${messageId}`),payload=window.LibriumWSMessage.payloadFile(id,message),url=URL.createObjectURL(new Blob([payload.bytes],{type:'application/octet-stream'}));
   try{const link=el('a');link.href=url;link.download=payload.name;link.click();result={bytes:payload.bytes.length,truncated:payload.truncated};}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }
  if(result)toast(`${result.truncated?'Сохранён фрагмент':'Сохранены байты сообщения'}: ${bytes(result.bytes)}`);
  return result;
 }catch(error){onError(error);}finally{wsMessageSaving=false;document.querySelectorAll('.ws-message-save').forEach(button=>button.disabled=false);$('ws-inspector-save').disabled=!wsInspect?.message;$('ws-inflate-save').disabled=!wsInflate?.message;}
}
function wsInspectorError(error){$('ws-inspector-error').hidden=false;$('ws-inspector-error').textContent=error.message;}
let wsFieldsController=null;
function closeWsFields(){wsFieldsController?.close();}
function openWsFields(range=null){
 if(!wsInspect?.payload||!['TEXT','BINARY'].includes(wsInspect.message?.kind))return;
 if(!wsFieldsController)wsFieldsController=window.LibriumWSFields.create({document,storage:localStorage,currentSource:()=>wsInspect,baseline:()=>wsCompareBaseline,values:(source,definition)=>api(`traffic/${source.id}/ws-field-values`,'POST',definition),find:(source,name,condition)=>findExactProtocolField(source,name,condition).catch(showError),copy:text=>window.librium?window.librium.copy(text):navigator.clipboard.writeText(text),jump:(source,offset,length)=>{if(wsInspect!==source)return;source.selection={offset,length};$('ws-inspector-format').value='hex';resetWsRelated();renderWsInspector();}});
 wsFieldsController.open(wsInspect,range);
}
$('ws-inspector-fields').onclick=()=>openWsFields();
async function findExactProtocolField(source,name,condition){
 if(wsInspect!==source)return;const exact={id:source.id,protocol:'field',name,condition:{...condition}};closeWsInspector();
 $('ws-filter').value='';$('ws-field-search-option').hidden=false;$('ws-search-format').value='protocol_field';$('ws-kind').value='DATA';$('ws-direction').value='';
 if(selected===exact.id){wsExactFilter=exact;syncWsSearchFormat();wsFiltersChanged();}else{await choose(exact.id,exact);syncWsSearchFormat();}
}
function clearWsValues(){const panel=$('ws-inspector-values');panel.hidden=true;panel.open=false;$('ws-inspector-values-body').replaceChildren();}
function renderWsValues(state){
 const panel=$('ws-inspector-values'),box=$('ws-inspector-values-body');panel.hidden=false;state.valuesText='';
 if(!state.selection){$('ws-inspector-values-title').textContent='Числа из исходных байтов';box.replaceChildren(el('p','Нет сохранённых байтов для чтения чисел.','muted'));return;}
 const data=window.LibriumWSMessage.numericValues(state.payload.bytes,state.selection.offset),title=`Числа с байта ${data.offset} (0x${data.offset.toString(16).padStart(6,'0')})`;
 $('ws-inspector-values-title').textContent=title;
 const copy=el('button','Копировать числа'),note=el('p',`Исходный пакет · следующие байты: ${data.hex}${state.message.truncated?' · сообщение сохранено частично':''}`,'muted'),table=el('table',undefined,'ws-values-table'),head=el('thead'),header=el('tr'),body=el('tbody');
 for(const label of ['Тип','LE · младший байт первым','BE · старший байт первым']){const cell=el('th',label);cell.scope='col';header.append(cell);}head.append(header);table.append(head,body);
 const lines=[title,'Исходный пакет'+(state.message.truncated?' · сообщение сохранено частично':''),'Байты: '+data.hex,'Тип\tLE\tBE'];
 for(const value of data.rows){const row=el('tr'),label=el('th',value.type);row.dataset.numericType=value.type;label.scope='row';row.append(label);for(const key of ['le','be']){const cell=el('td',value[key]??'—');cell.dataset.endian=key;row.append(cell);}body.append(row);lines.push(`${value.type}\t${value.le??'—'}\t${value.be??'—'}`);}
 const explanation='Это варианты чтения, а не определение полей протокола. uint — целое без знака, int — со знаком, float — число с плавающей точкой. — означает, что сохранённых байтов недостаточно для этого типа.';
 state.valuesText=lines.join('\n')+'\n'+explanation;
 copy.onclick=async()=>{try{if(window.librium)await window.librium.copy(state.valuesText);else await navigator.clipboard.writeText(state.valuesText);if(wsInspect===state)$('ws-inspector-state').textContent='Числовые представления скопированы';}catch(error){if(wsInspect===state)wsInspectorError(error);}};
 copy.id='ws-inspector-values-copy';box.replaceChildren(copy,note,table,el('p',explanation,'muted'));
}
function wsSelectedRange(state=wsInspect){const range=state?.selection;if(!state?.message||!state.payload||!Number.isSafeInteger(range?.offset)||!Number.isSafeInteger(range?.length)||range.offset<0||range.length<1||range.offset+range.length>state.payload.bytes.length)return null;return range;}
function resetWsSelectionControls(){for(const name of ['offset','selection-length','selection-copy','selection-field','selection-find','go','match'])$('ws-inspector-'+name).disabled=true;for(const name of ['offset','selection-length']){$('ws-inspector-'+name).setCustomValidity('');$('ws-inspector-'+name).setAttribute('aria-invalid','false');}$('ws-inspector-offset').value='';$('ws-inspector-selection-length').value='1';}
function scrollWsSelection(state){if(!wsSelectedRange(state))return;const target=$('ws-inspector-content').querySelector(`[data-byte-offset="${Math.floor(state.selection.offset/16)*16}"]`),scroll=()=>{if(wsInspect===state&&$('ws-inspector-dialog').open&&target?.isConnected&&typeof target.scrollIntoView==='function')target.scrollIntoView({block:'center'});};if(typeof requestAnimationFrame==='function')requestAnimationFrame(scroll);else scroll();}
function renderWsInspector(){
 const state=wsInspect;if(!state?.message)return;state.renderVersion=(state.renderVersion||0)+1;const message=state.message,format=$('ws-inspector-format').value;state.format=format;
 updateWsCompareControls();
 $('ws-inspector-fields').disabled=!['TEXT','BINARY'].includes(message.kind);
 $('ws-inspector-json-fields').disabled=message.truncated||!['TEXT','BINARY'].includes(message.kind)||state.decodeOffset!==0||state.decodeLength!==null;
 $('ws-inspector-json-fields').title=$('ws-inspector-json-fields').disabled?'Нужно полное исходное сообщение без выбранного диапазона':'Поля полного исходного JSON';
 renderWsValues(state);
 const decodeActive=message.kind==='BINARY'&&(state.decodeOffset>0||state.decodeLength!==null)&&!['raw','hex'].includes(format);
 const relatedProtocol=wsRelatedProtocol(state);$('ws-inspector-related').hidden=!relatedProtocol;
 $('ws-inspector-related').textContent=relatedProtocol==='socketio'?'Найти событие / ACK':'Найти команду / ответ';
 $('ws-inspector-related-result').hidden=!relatedProtocol||!$('ws-inspector-related-result').childNodes.length;
 const decoded=window.LibriumWS.analyze(decodeActive?window.LibriumWSMessage.analysisRange(message,state.decodeOffset,state.decodeLength):message,format),isHex=format==='hex'||(format==='raw'&&(message.kind!=='TEXT'||!message.text))||(!['raw','hex'].includes(format)&&decoded.text===null);
 wsInspectText=isHex?hexView(message.base64):format==='raw'?message.text:decoded.text??'';
 $('ws-inspector-error').hidden=true;for(const name of ['offset','selection-length']){$('ws-inspector-'+name).setCustomValidity('');$('ws-inspector-'+name).setAttribute('aria-invalid','false');}
 $('ws-inspector-content').replaceChildren(wsInspectText?codeLines(wsInspectText,'',isHex?4096:3000,''):el('div','Содержимое пустое','empty'));
 $('ws-inspector-state').textContent=isHex?'Hex · все сохранённые байты':'Представление: '+decoded.format;
 if(decodeActive)$('ws-inspector-state').textContent+=` · Разбор с байта ${state.decodeOffset} (0x${state.decodeOffset.toString(16)})${isHex?' · текстовый разбор недоступен':format==='protobuf'?'; смещения полей отсчитываются от этого начала':''}`;
 if(decodeActive&&state.decodeLength!==null)$('ws-inspector-state').textContent+=` · заданный диапазон: ${state.decodeLength} Б${message.truncated?' · исходное сообщение сохранено частично':''}`;
 $('ws-inspector-decode-form').hidden=message.kind!=='BINARY';
 $('ws-inspector-decode-offset').value=String(state.decodeOffset);$('ws-inspector-decode-offset').setCustomValidity('');$('ws-inspector-decode-offset').setAttribute('aria-invalid','false');
 $('ws-inspector-decode-length').value=state.decodeLength===null?'':String(state.decodeLength);$('ws-inspector-decode-length').setCustomValidity('');$('ws-inspector-decode-length').setAttribute('aria-invalid','false');
 for(const name of ['decode-offset','decode-length','decode-apply','decode-reset'])$('ws-inspector-'+name).disabled=message.kind!=='BINARY'||!state.payload.bytes.length;
 $('ws-inflate-tools').hidden=message.kind!=='BINARY';$('ws-inflate-open').disabled=!state.payload.bytes.length;$('ws-inflate-codec').disabled=!state.payload.bytes.length;
 $('ws-inspector-format').disabled=false;$('ws-inspector-copy').disabled=false;$('ws-inspector-save').disabled=wsMessageSaving;$('ws-inspector-save').textContent=message.truncated?'Сохранить фрагмент':'Сохранить байты';
 $('ws-inspector-go').disabled=!state.payload.bytes.length;$('ws-inspector-offset').disabled=!state.payload.bytes.length;$('ws-inspector-selection-length').disabled=!state.payload.bytes.length;$('ws-inspector-match').disabled=!state.originalMatch;
 const selectedRange=wsSelectedRange(state);$('ws-inspector-selection-copy').disabled=!selectedRange;$('ws-inspector-selection-field').disabled=!selectedRange||!['TEXT','BINARY'].includes(message.kind);$('ws-inspector-selection-find').disabled=$('ws-inspector-selection-field').disabled;
 $('ws-inspector-selection-length').value=String(selectedRange?.length??1);
 if(selectedRange){$('ws-inspector-offset').value='0x'+selectedRange.offset.toString(16).padStart(6,'0');$('ws-inspector-state').textContent+=` · исходное выделение: ${selectedRange.length} Б с байта ${selectedRange.offset}`;}
 if(isHex){for(const [index,row]of [...$('ws-inspector-content').querySelectorAll('.code-line')].entries()){
   row.dataset.byteOffset=index*16;if(!state.selection)continue;const line=row.querySelector('.line-text'),parts=window.LibriumWSMessage.hexHighlight(line.textContent,index*16,state.selection.offset,state.selection.length);
   if(parts.some(part=>part.hit)){line.replaceChildren(...parts.map(part=>part.hit?el('mark',part.text,'ws-byte-focus'):document.createTextNode(part.text)));}
  }
  scrollWsSelection(state);
 }
}
async function openWsInspectorFromHint(id,messageId,format,match=null,entry=null,codec=null){
 const opening=openWsInspector(id,messageId,format,match,entry),version=wsInspectVersion;await opening;
 if(codec&&version===wsInspectVersion&&$('ws-inspector-dialog').open&&wsInspect?.id===id&&wsInspect?.messageId===messageId&&wsInspect?.message?.kind==='BINARY')$('ws-inflate-codec').value=codec;
}
async function openWsInspector(id,messageId,format='pretty',match=null,rpcEntry=null){
 wsContextController?.close();
 closeWsFields();closeWsJsonFields();resetWsRelated();
 closeWsInflate();$('ws-inflate-tools').hidden=true;$('ws-inflate-open').disabled=true;$('ws-inflate-codec').value='gzip';
 const version=++wsInspectVersion,state={id,messageId,format:['pretty','cdp','jsonrpc','msgpack','protobuf','raw','hex'].includes(format)?format:'pretty',decodeOffset:0,decodeLength:null,requestedMatch:match,relatedEntry:rpcEntry,message:null};wsInspect=state;wsInspectText='';
 $('ws-inspector-title').textContent=`WS #${id} · сообщение #${messageId}`;$('ws-inspector-meta').textContent='Загрузка из архива…';$('ws-inspector-state').textContent='';$('ws-inspector-error').hidden=true;$('ws-inspector-content').replaceChildren();$('ws-inspector-retry').hidden=true;
 $('ws-inspector-decode-form').hidden=true;$('ws-inspector-decode-offset').value='0';$('ws-inspector-decode-offset').setCustomValidity('');$('ws-inspector-decode-offset').setAttribute('aria-invalid','false');
 clearWsValues();
 $('ws-inspector-decode-length').value='';$('ws-inspector-decode-length').setCustomValidity('');$('ws-inspector-decode-length').setAttribute('aria-invalid','false');
 for(const name of ['context','fields','json-fields','format','copy','save','offset','selection-length','selection-copy','selection-field','selection-find','go','match','decode-offset','decode-length','decode-apply','decode-reset'])$('ws-inspector-'+name).disabled=true;
 resetWsSelectionControls();
 updateWsCompareControls();
 if(!$('ws-inspector-dialog').open)$('ws-inspector-dialog').showModal();
 try{const message=await api(`traffic/${id}/ws/${messageId}`);if(version!==wsInspectVersion||!$('ws-inspector-dialog').open)return;
  const payload=window.LibriumWSMessage.payloadFile(id,message);state.message=message;state.payload=payload;
  state.originalMatch=match&&Number.isSafeInteger(match.offset)&&Number.isSafeInteger(match.length)&&match.offset>=0&&match.length>0&&match.offset+match.length<=payload.bytes.length?match:null;
  state.selection=state.originalMatch||(payload.bytes.length?{offset:0,length:1}:null);if(state.originalMatch)state.format='hex';$('ws-inspector-format').value=state.format;
  const date=new Date(message.time),time=Number.isFinite(date.getTime())?date.toLocaleString('ru-RU'):'время недоступно';
  $('ws-inspector-meta').textContent=`${message.direction==='sent'?'Отправлено':'Получено'} · ${message.kind} · ${time} · размер ${bytes(message.size)} · сохранено ${bytes(payload.bytes.length)}${message.truncated?' · только фрагмент':''}`;
  renderWsInspector();$('ws-inspector-context').disabled=false;
 }catch(error){if(version!==wsInspectVersion||!$('ws-inspector-dialog').open)return;$('ws-inspector-meta').textContent='Сообщение не загружено';wsInspectorError(Error(error.message.includes('404')?'Сообщение удалено из истории или недоступно.':error.message));$('ws-inspector-retry').hidden=false;}
}
function closeWsInspector(){wsContextController?.close();closeWsFields();closeWsJsonFields();resetWsRelated();closeWsInflate();closeWsComparison();++wsInspectVersion;wsInspect=null;wsInspectText='';if($('ws-inspector-dialog').open)$('ws-inspector-dialog').close();$('ws-inspector-content').replaceChildren();resetWsSelectionControls();clearWsValues();updateWsCompareControls();}
function closeWsJsonFields(){
 ++wsJsonFieldsVersion;wsJsonFields=null;if($('ws-json-fields-dialog').open)$('ws-json-fields-dialog').close();$('ws-json-fields-content').replaceChildren();$('ws-json-fields-error').hidden=true;
}
async function useWsJsonField(state,pointer){
 if(wsJsonFields!==state||wsInspect!==state.source)return;
 const id=state.source.id;closeWsInspector();wsExactFilter=null;
 $('ws-filter').value='';$('ws-search-format').value='jsonpointer';$('ws-json-pointer').value=pointer;$('ws-kind').value='DATA';$('ws-direction').value='';syncWsSearchFormat();
 if(selected===id)wsFiltersChanged();else await choose(id);
}
async function loadWsJsonFields(){
 const state=wsJsonFields;if(!state||wsInspect!==state.source)return;const version=++wsJsonFieldsVersion;
 const active=()=>wsJsonFields===state&&wsInspect===state.source&&version===wsJsonFieldsVersion&&$('ws-json-fields-dialog').open;
 $('ws-json-fields-content').replaceChildren();$('ws-json-fields-state').textContent='Читаем поля исходного JSON…';$('ws-json-fields-error').hidden=true;$('ws-json-fields-retry').disabled=true;
 try{
  const data=await api(`traffic/${state.source.id}/ws/${state.source.messageId}/json-fields`);if(!active())return;
  if(data.supported===false){$('ws-json-fields-state').textContent=data.reason||'JSON недоступен.';return;}
  if(data.supported!==true||!Array.isArray(data.rows)||data.rows.length>256||typeof data.limited!=='boolean')throw Error('Неверный ответ просмотра JSON.');
  const table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');for(const title of ['Поле / путь','Тип','Значение','Действия']){const cell=el('th',title);cell.scope='col';header.append(cell);}head.append(header);table.append(head,body);
  const types={object:'Объект',array:'Массив',string:'Строка',number:'Число',boolean:'Логическое',null:'null'};
  for(const row of data.rows){
   if(typeof row.pointer!=='string'||typeof row.preview!=='string'||row.preview.length>1000||!Object.hasOwn(types,row.kind)||typeof row.searchable!=='boolean'||typeof row.ambiguous!=='boolean')throw Error('Неверные данные поля JSON.');
   window.LibriumWS.validateJsonPointer(row.pointer);
   const tr=el('tr'),path=el('td',row.pointer||'(весь JSON)'),type=el('td',row.ambiguous?'Неоднозначно':types[row.kind]),value=el('td',row.preview),actions=el('td'),copy=el('button','Копировать путь','ws-json-field-copy'),find=el('button','Найти поле','ws-json-field-find');tr.dataset.jsonPointer=row.pointer;path.className='ws-json-field-path';value.className='ws-json-field-value';
   copy.setAttribute('aria-label','Копировать путь '+(row.pointer||'всего JSON'));copy.onclick=async()=>{try{if(window.librium)await window.librium.copy(row.pointer);else await navigator.clipboard.writeText(row.pointer);if(active())$('ws-json-fields-state').textContent='Путь скопирован';}catch(error){if(active()){$('ws-json-fields-error').textContent=error.message;$('ws-json-fields-error').hidden=false;}}};
   find.disabled=!row.searchable||row.ambiguous;find.title=find.disabled?'Нет однозначного значения для поиска':'Поиск наличия поля во всей истории соединения';find.onclick=()=>useWsJsonField(state,row.pointer).catch(showError);
   actions.append(copy,find);tr.append(path,type,value,actions);body.append(tr);
  }
  $('ws-json-fields-content').replaceChildren(table);$('ws-json-fields-state').textContent=`Показано значений: ${data.rows.length}${data.limited?' · список ограничен: до 256 значений, 64 уровней и 2048 байт на путь':''}`;
 }catch(error){if(active()){$('ws-json-fields-state').textContent='Поля не загружены';$('ws-json-fields-error').textContent=error.message.includes('404')?'Сообщение удалено из истории или недоступно.':error.message;$('ws-json-fields-error').hidden=false;}}
 finally{if(active())$('ws-json-fields-retry').disabled=false;}
}
$('ws-inspector-json-fields').onclick=()=>{
 if(!wsInspect?.message||$('ws-inspector-json-fields').disabled)return;
 wsJsonFields={source:wsInspect};$('ws-json-fields-meta').textContent=`WS #${wsInspect.id} · сообщение #${wsInspect.messageId} · исходный JSON`;
 if(!$('ws-json-fields-dialog').open)$('ws-json-fields-dialog').showModal();loadWsJsonFields();
};
$('ws-json-fields-close').onclick=closeWsJsonFields;$('ws-json-fields-retry').onclick=loadWsJsonFields;
$('ws-json-fields-dialog').onclose=()=>{if(!$('ws-json-fields-dialog').open)closeWsJsonFields();};
$('ws-inspector-close').onclick=closeWsInspector;
$('ws-inspector-dialog').onclose=()=>{if($('ws-inspector-dialog').open)return;wsContextController?.close();closeWsFields();closeWsJsonFields();resetWsRelated();closeWsInflate();closeWsComparison();++wsInspectVersion;wsInspect=null;wsInspectText='';$('ws-inspector-content').replaceChildren();clearWsValues();updateWsCompareControls();};
function wsRelatedProtocol(state){
 if(!state?.message||state.decodeOffset||state.decodeLength!==null)return null;
 if(state.format==='cdp')return 'cdp';
 if(state.format==='jsonrpc')return 'jsonrpc';
 if(state.format==='pretty'&&state.message.kind==='TEXT'&&!state.message.truncated){const packet=window.LibriumWS.socketIoPacket(state.message.text);if(packet?.ack!==null&&packet?.ack!==undefined)return 'socketio';}
 return null;
}
function resetWsRelated(){
 jsonRpcRelatedController?.reset();
 if(wsInspect)wsInspect.relatedVersion=(wsInspect.relatedVersion||0)+1;
 $('ws-inspector-related').hidden=true;$('ws-inspector-related').disabled=false;
 $('ws-inspector-related-result').replaceChildren();$('ws-inspector-related-result').hidden=true;
}
$('ws-inspector-related').onclick=async()=>{
 const state=wsInspect,protocol=wsRelatedProtocol(state);if(!protocol)return;
 if(protocol==='jsonrpc'){
  if(!jsonRpcRelatedController)jsonRpcRelatedController=window.LibriumJsonRpcRelated.create({document,request:path=>api(path),openMessage:openWsInspector,findId:(source,kind,value)=>{if(wsInspect!==source)return;const query=kind==='string'?JSON.stringify(value):value;closeWsInspector();openWsArchive({format:'jsonrpc_id',search:query});},isCurrent:source=>wsInspect===source&&wsRelatedProtocol(source)==='jsonrpc'&&$('ws-inspector-dialog').open,box:$('ws-inspector-related-result'),button:$('ws-inspector-related')});
  jsonRpcRelatedController.load(state);return;
 }
 const socketio=protocol==='socketio';
 const version=state.relatedVersion=(state.relatedVersion||0)+1,box=$('ws-inspector-related-result');
 const active=()=>wsInspect===state&&state.relatedVersion===version&&wsRelatedProtocol(state)===protocol&&$('ws-inspector-dialog').open;
 box.hidden=false;box.replaceChildren(el('p',`Поиск по всей записанной сессии ${socketio?'Socket.IO':'CDP'}…`));$('ws-inspector-related').disabled=true;
 try{
  const data=await api(`traffic/${state.id}/ws/${state.messageId}/${socketio?'socketio':'cdp'}-related`);if(!active())return;
  if(data.supported===false){box.replaceChildren(el('p',data.reason||'Полное исходное сообщение с ID недоступно.'));return;}
  const commands=socketio?data.events:data.commands,responses=socketio?data.acks:data.responses,commandCount=socketio?data.event_count:data.command_count,responseCount=socketio?data.ack_count:data.response_count;
  if(data.supported!==true||!['matched','missing','ambiguous'].includes(data.status)||!Array.isArray(commands)||!Array.isArray(responses)||commands.length>20||responses.length>20)throw Error('Неверный ответ поиска '+(socketio?'Socket.IO':'CDP')+'.');
  if(socketio&&(data.headers_only!==true||typeof data.ack_id!=='string'||typeof data.namespace!=='string'||[commandCount,responseCount,data.inspected].some(value=>!Number.isSafeInteger(value)||value<0)))throw Error('Неверные данные пары Socket.IO.');
  const description=data.status==='matched'?(socketio?'Найдено единственное событие и ACK.':'Найдена единственная команда и ответ.'):data.status==='ambiguous'?`Неоднозначный ID: найдено несколько ${socketio?'событий / ACK':'команд / ответов'} либо нарушен порядок. Автоматическая пара не выбрана.`:'Пара среди полных исходных сообщений пока не найдена.';
  const identity=socketio?`Socket.IO ACK ID: ${data.ack_id} · Namespace: ${data.namespace} · событий: ${commandCount}, ACK: ${responseCount}`:`CDP ID: ${data.rpc_id} · ${data.session_id===null?'без sessionId':'sessionId: '+data.session_id} · команд: ${commandCount}, ответов: ${responseCount}`;
  box.replaceChildren(el('p',description),el('p',identity+` · проверено сообщений: ${data.inspected}`,'muted'));
  if(data.status==='matched'&&Number.isSafeInteger(data.latency_ms)&&data.latency_ms>=0)box.append(el('p',`${socketio?'Между записями заголовков события и ACK':'Между записями команды и ответа'}: ${data.latency_ms} мс`));
  const links=el('div',undefined,'ws-inspector-tools');
  for(const [label,items]of [[socketio?'Событие':'Команда',commands],[socketio?'ACK':'Ответ',responses]])for(const item of items){
   if(!Number.isSafeInteger(item.id)||item.id<1)throw Error('Неверный ID связанного сообщения.');
   const button=el('button',`${label} #${item.id}${item.method?' · '+item.method:''}`,'ws-related-open');button.disabled=item.id===state.messageId;button.onclick=()=>openWsInspector(state.id,item.id,socketio?'pretty':'cdp').catch(showError);links.append(button);
  }
  const footer=socketio?'До 20 событий и 20 ACK. Сопоставляются текстовые заголовки; бинарные вложения не собираются и не проверяются.':'До 20 команд и 20 ответов.';
  box.append(links,el('p','Вся записанная WS-сессия на момент проверки; фильтры просмотра не учитываются. '+footer+' Повтори поиск, если ответ ещё не записан.','muted'));
 }catch(error){if(active())box.replaceChildren(el('p',error.message.includes('404')?'Сообщение удалено из истории или недоступно.':error.message));}
 finally{if(active())$('ws-inspector-related').disabled=false;}
};
$('ws-inspector-format').onchange=()=>{resetWsRelated();renderWsInspector();};
for(const name of ['offset','selection-length'])$('ws-inspector-'+name).oninput=()=>{if(wsInspect)wsInspect.selectionCopyJob=null;for(const field of ['offset','selection-length']){$('ws-inspector-'+field).setCustomValidity('');$('ws-inspector-'+field).setAttribute('aria-invalid','false');}$('ws-inspector-error').hidden=true;};
for(const name of ['decode-offset','decode-length'])$('ws-inspector-'+name).oninput=()=>{for(const field of ['decode-offset','decode-length']){$('ws-inspector-'+field).setCustomValidity('');$('ws-inspector-'+field).setAttribute('aria-invalid','false');}$('ws-inspector-error').hidden=true;};
$('ws-inspector-decode-form').onsubmit=event=>{event.preventDefault();if(wsInspect?.message?.kind!=='BINARY')return;let field=$('ws-inspector-decode-offset');try{const offset=window.LibriumWSMessage.parseOffset(field.value,wsInspect.payload.bytes.length);field=$('ws-inspector-decode-length');const length=window.LibriumWSMessage.parseLength(field.value,wsInspect.payload.bytes.length-offset);resetWsRelated();wsInspect.decodeOffset=offset;wsInspect.decodeLength=length;if(['hex','raw'].includes($('ws-inspector-format').value))$('ws-inspector-format').value='pretty';renderWsInspector();}catch(error){field.setCustomValidity(error.message);field.setAttribute('aria-invalid','true');wsInspectorError(error);}};
$('ws-inspector-decode-reset').onclick=()=>{if(!wsInspect?.message)return;resetWsRelated();wsInspect.decodeOffset=0;wsInspect.decodeLength=null;renderWsInspector();};
$('ws-inspector-context').onclick=()=>{
 const state=wsInspect;if(!state?.message)return;
 if(!wsContextController)wsContextController=window.LibriumWSContext.create({document,request:path=>api(path),openMessage:openWsInspector});
 wsContextController.open(state.id,state.messageId,state.format);
};
$('ws-inspector-retry').onclick=()=>{if(wsInspect)openWsInspector(wsInspect.id,wsInspect.messageId,wsInspect.format,wsInspect.requestedMatch,wsInspect.relatedEntry);};
$('ws-inspector-offset-form').onsubmit=event=>{event.preventDefault();if(!wsInspect?.message)return;wsInspect.selectionCopyJob=null;let field=$('ws-inspector-offset');try{const offset=window.LibriumWSMessage.parseOffset(field.value,wsInspect.payload.bytes.length);field=$('ws-inspector-selection-length');const length=window.LibriumWSMessage.parseLength(field.value.trim()||'1',wsInspect.payload.bytes.length-offset);wsInspect.selection={offset,length};$('ws-inspector-format').value='hex';renderWsInspector();}catch(error){field.setCustomValidity(error.message);field.setAttribute('aria-invalid','true');wsInspectorError(error);}};
$('ws-inspector-selection-copy').onclick=async()=>{const state=wsInspect,range=wsSelectedRange(state);if(!range)return;const version=state.renderVersion,job=Symbol();state.selectionCopyJob=job;const active=()=>wsInspect===state&&state.renderVersion===version&&state.selectionCopyJob===job;if(['offset','selection-length'].every(name=>$('ws-inspector-'+name).getAttribute('aria-invalid')!=='true'))$('ws-inspector-error').hidden=true;
 try{const text=Array.from(state.payload.bytes.subarray(range.offset,range.offset+range.length),value=>value.toString(16).padStart(2,'0')).join(' ');if(window.librium)await window.librium.copy(text);else await navigator.clipboard.writeText(text);if(active())$('ws-inspector-state').textContent=`Скопировано исходное выделение: ${range.length} Б с байта ${range.offset}.`;}
 catch(error){if(active())wsInspectorError(error);}
};
$('ws-inspector-selection-field').onclick=()=>{const range=wsSelectedRange();if(!range||!['TEXT','BINARY'].includes(wsInspect.message.kind))return;try{openWsFields({...range});}catch(error){wsInspectorError(error);}};
$('ws-inspector-selection-find').onclick=()=>{const state=wsInspect,range=wsSelectedRange(state);if(!range||!['TEXT','BINARY'].includes(state.message.kind))return;const value=Array.from(state.payload.bytes.subarray(range.offset,range.offset+range.length),byte=>byte.toString(16).padStart(2,'0')).join(' ');findExactProtocolField(state,'Выделение',{type:'bytes',offset:range.offset,endian:'le',length:range.length,value}).catch(showError);};
$('ws-inspector-match').onclick=()=>{if(!wsInspect?.originalMatch)return;wsInspect.selection=wsInspect.originalMatch;$('ws-inspector-format').value='hex';renderWsInspector();};
$('ws-inspector-copy').onclick=async()=>{const state=wsInspect;if(!state?.message)return;try{if(wsInspectText.length>500000)throw Error('Представление слишком велико для буфера. Сохрани исходные байты.');if(window.librium)await window.librium.copy(wsInspectText);else await navigator.clipboard.writeText(wsInspectText);if(wsInspect===state)$('ws-inspector-state').textContent='Представление скопировано';}catch(error){if(wsInspect===state)wsInspectorError(error);}};
$('ws-inspector-save').onclick=async()=>{const state=wsInspect;if(!state?.message)return;const result=await saveWsMessage(state.id,state.messageId,error=>{if(wsInspect===state)wsInspectorError(error);});if(result&&wsInspect===state)$('ws-inspector-state').textContent=`${result.truncated?'Сохранён фрагмент':'Сохранены байты'}: ${bytes(result.bytes)}`;};
function updateWsCompareControls(){
 const loaded=Boolean(wsInspect?.message);$('ws-inspector-pin').disabled=!loaded;$('ws-inspector-compare').disabled=!loaded||!wsCompareBaseline;$('ws-inspector-unpin').disabled=!wsCompareBaseline;
 $('ws-inspector-baseline').textContent=wsCompareBaseline?`Образец A: WS #${wsCompareBaseline.id} · сообщение #${wsCompareBaseline.messageId}${wsCompareBaseline.truncated?' · фрагмент':''}`:'Образец не выбран';
}
function closeWsInflate(){++wsInflateVersion;wsInflate=null;if($('ws-inflate-dialog').open)$('ws-inflate-dialog').close();$('ws-inflate-content').replaceChildren();}
function renderWsInflate(){
 const state=wsInflate;if(!state?.message)return;const format=$('ws-inflate-format').value,decoded=window.LibriumWS.analyze(state.message,format),hex=format==='hex'||decoded.text===null;
 state.text=hex?hexView(state.message.base64):decoded.text??'';
 $('ws-inflate-content').replaceChildren(state.text?codeLines(state.text,'',hex?4096:3000,''):el('div','Распакованные данные пустые','empty'));
 $('ws-inflate-state').textContent=hex?'Hex · распакованные байты':'Представление: '+decoded.format;
 $('ws-inflate-format').disabled=false;$('ws-inflate-copy').disabled=false;$('ws-inflate-save').disabled=wsMessageSaving;
}
async function openWsInflate(){
 const source=wsInspect;if(source?.message?.kind!=='BINARY')return;let field=$('ws-inspector-decode-offset'),offset,length;
 try{offset=window.LibriumWSMessage.parseOffset(field.value,source.payload.bytes.length);field=$('ws-inspector-decode-length');length=window.LibriumWSMessage.parseLength(field.value,source.payload.bytes.length-offset);}catch(error){field.setCustomValidity(error.message);field.setAttribute('aria-invalid','true');wsInspectorError(error);return;}
 const codec=$('ws-inflate-codec').value;if(!['gzip','zlib','deflate'].includes(codec))return;
 const version=++wsInflateVersion,state={source,codec,offset,length,message:null,text:''};wsInflate=state;
 $('ws-inflate-title').textContent=`Распакованные данные · WS #${source.id} / #${source.messageId}`;
 const label=`${codec} · исходный диапазон с байта ${offset}, ${length??source.payload.bytes.length-offset} Б${source.message.truncated?' · исходное сообщение сохранено частично':''}`;
 $('ws-inflate-meta').textContent=label;$('ws-inflate-error').hidden=true;$('ws-inflate-state').textContent='Распаковка…';$('ws-inflate-content').replaceChildren();$('ws-inflate-format').disabled=true;$('ws-inflate-copy').disabled=true;$('ws-inflate-save').disabled=true;
 $('ws-inflate-format').value=['pretty','cdp','jsonrpc','msgpack','protobuf','hex'].includes(source.format)?source.format:'pretty';
 if(!$('ws-inflate-dialog').open)$('ws-inflate-dialog').showModal();
 try{
  const result=await api(`traffic/${source.id}/ws/${source.messageId}/inflate?codec=${codec}&offset=${offset}${length===null?'':'&length='+length}`);
  if(version!==wsInflateVersion||wsInflate!==state||!$('ws-inflate-dialog').open)return;
  if(result?.ok!==true)throw Error(typeof result?.error==='string'?result.error:'Некорректный результат распаковки.');
  if(result.codec!==codec||result.offset!==offset||result.length!==(length??source.payload.bytes.length-offset))throw Error('Результат не соответствует выбранному диапазону.');
  const message={...source.message,base64:result.base64,size:result.size,truncated:false,text:''};window.LibriumWSMessage.inflatedPayload(source.id,source.messageId,state,result);state.message=message;state.result=result;
  $('ws-inflate-meta').textContent=label+` → распаковано ${bytes(message.size)}`;renderWsInflate();
 }catch(error){if(version!==wsInflateVersion||wsInflate!==state)return;$('ws-inflate-state').textContent='Распаковка не выполнена';$('ws-inflate-error').hidden=false;$('ws-inflate-error').textContent=error.message.includes('404')?'Исходное сообщение удалено из истории или недоступно.':error.message;}
}
$('ws-inflate-open').onclick=openWsInflate;$('ws-inflate-close').onclick=closeWsInflate;
$('ws-inflate-dialog').onclose=()=>{if(!$('ws-inflate-dialog').open){++wsInflateVersion;wsInflate=null;$('ws-inflate-content').replaceChildren();}};
$('ws-inflate-format').onchange=renderWsInflate;
$('ws-inflate-save').onclick=async()=>{
 const state=wsInflate;if(!state?.message||wsMessageSaving)return;wsMessageSaving=true;document.querySelectorAll('.ws-message-save').forEach(button=>button.disabled=true);$('ws-inspector-save').disabled=true;$('ws-inflate-save').disabled=true;
 try{
  const params={codec:state.codec,offset:state.offset,length:state.length};let result;
  if(window.librium)result=await window.librium.saveWsInflated(state.source.id,state.source.messageId,params);
  else{const payload=window.LibriumWSMessage.inflatedPayload(state.source.id,state.source.messageId,params,state.result),url=URL.createObjectURL(new Blob([payload.bytes],{type:'application/octet-stream'}));try{const link=el('a');link.href=url;link.download=payload.name;link.click();result={bytes:payload.bytes.length,download:true};}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}}
  if(result&&wsInflate===state)$('ws-inflate-state').textContent=`${result.download?'Скачивание распакованных байтов начато':'Распакованные байты сохранены'}: ${bytes(result.bytes)}`;
 }catch(error){if(wsInflate===state){$('ws-inflate-error').hidden=false;$('ws-inflate-error').textContent=error.message;}}
 finally{wsMessageSaving=false;document.querySelectorAll('.ws-message-save').forEach(button=>button.disabled=false);$('ws-inspector-save').disabled=!wsInspect?.message;$('ws-inflate-save').disabled=!wsInflate?.message;}
};
$('ws-inflate-copy').onclick=async()=>{const state=wsInflate;if(!state?.message)return;try{if(state.text.length>500000)throw Error('Представление слишком велико для буфера.');if(window.librium)await window.librium.copy(state.text);else await navigator.clipboard.writeText(state.text);if(wsInflate===state)$('ws-inflate-state').textContent='Распакованное представление скопировано';}catch(error){if(wsInflate===state){$('ws-inflate-error').hidden=false;$('ws-inflate-error').textContent=error.message;}}};
function closeWsComparison(){wsCompare=null;$('ws-compare-field-b').disabled=true;$('ws-compare-copy-error').hidden=true;$('ws-compare-copy-error').textContent='';if($('ws-compare-dialog').open)$('ws-compare-dialog').close();$('ws-compare-a').replaceChildren();$('ws-compare-b').replaceChildren();for(const name of ['labels','summary','range','action-state'])$('ws-compare-'+name).textContent='';for(const side of ['a','b'])for(const action of ['copy','open'])$('ws-compare-'+action+'-'+side).disabled=true;}
function resetWsCompareBaseline(){wsCompareBaseline=null;wsFieldsController?.resetComparison();closeWsComparison();updateWsCompareControls();}
function renderWsComparison(){
 const state=wsCompare;if(!state)return;state.renderVersion=(state.renderVersion||0)+1;const {a,b,diff}=state,focus=state.focus,columns=window.innerWidth<1150?8:16,start=Math.max(0,Math.floor(focus/columns)*columns-columns*2),end=Math.min(diff.max,start+256);
 const label=sample=>`WS #${sample.id} · сообщение #${sample.messageId} · сохранено ${bytes(sample.bytes.length)} из ${bytes(sample.size)}${sample.truncated?' · фрагмент':''}`;
 $('ws-compare-labels').textContent=`A: ${label(a)}. B: ${label(b)}.`;
 $('ws-compare-summary').textContent=`Общие сохранённые байты: ${diff.common}. Совпали: ${diff.same}; отличаются: ${diff.changed}. Подтверждённо только в A: ${diff.onlyA}; только в B: ${diff.onlyB}. Недостаточно данных: A — ${diff.unknownA}; B — ${diff.unknownB}.`;
 $('ws-compare-note').textContent=a.truncated||b.truncated?'Есть усечённое сообщение. ?? — неизвестные байты внутри полного размера; -- — за концом сообщения. Байты напротив ?? не считаются отличием. Участки без сохранённых байтов с обеих сторон не показаны и не сравнивались.':'Оба содержимых сохранены полностью. Сравниваются байты по одинаковым смещениям.';
 let previous=null,next=null;for(const range of diff.ranges){if(range.end<=focus)previous=range.start;if(next===null&&range.start>focus)next=range.start;}state.previous=previous;state.next=next;
 $('ws-compare-prev').disabled=previous===null;$('ws-compare-next').disabled=next===null;$('ws-compare-go').disabled=!diff.max;$('ws-compare-offset').disabled=!diff.max;$('ws-compare-offset').value='0x'+focus.toString(16).padStart(6,'0');$('ws-compare-offset').setAttribute('aria-invalid','false');$('ws-compare-offset').setCustomValidity('');$('ws-compare-error').hidden=true;
 const current=diff.ranges.findIndex(range=>range.start<=focus&&focus<range.end),names={changed:'Байты отличаются',only_a:'Байты только в A: сообщение B закончилось',only_b:'Байты только в B: сообщение A закончилось',unknown_a:'Байты A не сохранены; сравнение невозможно',unknown_b:'Байты B не сохранены; сравнение невозможно'};
 const range=current>=0?diff.ranges[current]:null;state.range=range;$('ws-compare-copy-error').hidden=true;$('ws-compare-copy-error').textContent='';
 $('ws-compare-field-b').disabled=!(range&&range.end<=b.bytes.length&&['TEXT','BINARY'].includes(state.source?.message?.kind)&&wsInspect===state.source);
 $('ws-compare-action-state').textContent=range?`Действия относятся ко всему участку: ${range.end-range.start} Б. Копирование — в Hex; переход выделяет байты в исходном сообщении.`:'Выбери участок отличий или неполных данных кнопками ← / →.';
 for(const side of ['a','b']){const available=Boolean(range&&range.end<=state[side].bytes.length);for(const action of ['copy','open']){const button=$('ws-compare-'+action+'-'+side);button.disabled=!available;button.title=available?'Весь участок, включая байты за пределами видимого окна':range?'На этой стороне нет сохранённых байтов всего участка':'Выбери участок кнопками ← / →';}}
 $('ws-compare-range').textContent=(range?`Участок ${current+1} / ${diff.ranges.length}: ${names[range.kind]}, 0x${range.start.toString(16).padStart(6,'0')}–0x${(range.end-1).toString(16).padStart(6,'0')} (${range.end-range.start} байт). `:diff.ranges.length?'В этом смещении сохранённые байты совпадают. ':'Различий в сохранённых байтах нет. ')+(diff.max?`Показаны байты 0x${start.toString(16).padStart(6,'0')}–0x${(end-1).toString(16).padStart(6,'0')}.`:'Сохранённые содержимые пусты.');
 for(const [side,own,other]of [['a',a,b],['b',b,a]]){const fragment=document.createDocumentFragment();
  for(let rowOffset=start;rowOffset<end;rowOffset+=columns){const row=el('div',undefined,'ws-compare-line'),hex=el('span',undefined,'ws-compare-hex'),ascii=el('span',undefined,'ws-compare-ascii');hex.style.width=(columns*3-1)+'ch';
   for(let offset=rowOffset;offset<Math.min(rowOffset+columns,end);offset++){
    const present=offset<own.bytes.length,unknown=!present&&offset<own.size,kind=present?(offset<other.bytes.length?(own.bytes[offset]===other.bytes[offset]?'equal':'changed'):offset<other.size?'unverified':'only'):unknown?'unknown':'absent',className=`ws-compare-byte ${kind}${offset===focus?' ws-compare-focus':''}`;
    const cell=el('span',present?own.bytes[offset].toString(16).padStart(2,'0'):unknown?'??':'--',className);cell.dataset.byteOffset=offset;cell.dataset.state=kind;
    hex.append(cell);if(offset+1<Math.min(rowOffset+columns,end))hex.append(document.createTextNode(' '));ascii.append(el('span',present?(own.bytes[offset]>=32&&own.bytes[offset]<127?String.fromCharCode(own.bytes[offset]):'.'):unknown?'?':'-',className));
   }row.append(el('span',rowOffset.toString(16).padStart(6,'0'),'ws-compare-address'),hex,ascii);fragment.append(row);
  }$('ws-compare-'+side).replaceChildren(diff.max?fragment:el('p','Нет сохранённых байтов','muted'));
 }$('ws-compare-content').scrollTop=0;
}
$('ws-inspector-pin').onclick=()=>{if(!wsInspect?.message)return;wsCompareBaseline={id:wsInspect.id,messageId:wsInspect.message.id,bytes:new Uint8Array(wsInspect.payload.bytes),size:wsInspect.message.size,kind:wsInspect.message.kind,truncated:wsInspect.message.truncated};wsFieldsController?.resetComparison();updateWsCompareControls();$('ws-inspector-state').textContent='Образец выбран. Он хранится только в памяти до сброса или закрытия Librium.';};
$('ws-inspector-unpin').onclick=()=>{resetWsCompareBaseline();$('ws-inspector-state').textContent='Образец сброшен';};
$('ws-inspector-compare').onclick=()=>{if(!wsInspect?.message||!wsCompareBaseline)return;const b={id:wsInspect.id,messageId:wsInspect.message.id,bytes:wsInspect.payload.bytes,size:wsInspect.message.size,truncated:wsInspect.message.truncated},diff=window.LibriumWSMessage.comparePayloads(wsCompareBaseline.bytes,b.bytes,{sizeA:wsCompareBaseline.size,sizeB:b.size});wsCompare={a:wsCompareBaseline,b,diff,source:wsInspect,focus:diff.ranges[0]?.start||0};if(!$('ws-compare-dialog').open)$('ws-compare-dialog').showModal();renderWsComparison();};
$('ws-compare-close').onclick=closeWsComparison;
$('ws-compare-dialog').onclose=()=>{if(!$('ws-compare-dialog').open)closeWsComparison();};
$('ws-compare-field-b').onclick=()=>{const state=wsCompare,range=state?.range;if(!range||wsInspect!==state.source||range.end>state.b.bytes.length||!['TEXT','BINARY'].includes(state.source.message?.kind))return;closeWsComparison();try{openWsFields({offset:range.start,length:range.end-range.start});}catch(error){wsInspectorError(error);}};
for(const side of ['a','b']){
 $('ws-compare-copy-'+side).onclick=async()=>{const state=wsCompare,range=state?.range,sample=state?.[side];if(!range||range.end>sample.bytes.length)return;const version=state.renderVersion,job=Symbol();state.copyJob=job;$('ws-compare-copy-error').hidden=true;$('ws-compare-copy-error').textContent='';const active=()=>wsCompare===state&&state.renderVersion===version&&state.copyJob===job;
  try{const text=Array.from(sample.bytes.subarray(range.start,range.end),value=>value.toString(16).padStart(2,'0')).join(' ');if(window.librium)await window.librium.copy(text);else await navigator.clipboard.writeText(text);if(active())$('ws-compare-action-state').textContent=`Участок ${side.toUpperCase()} скопирован в Hex: ${range.end-range.start} Б.`;}
  catch(error){if(active()){$('ws-compare-copy-error').textContent=error.message;$('ws-compare-copy-error').hidden=false;}}
 };
 $('ws-compare-open-'+side).onclick=()=>{const state=wsCompare,range=state?.range,sample=state?.[side];if(!range||range.end>sample.bytes.length)return;closeWsComparison();openWsInspector(sample.id,sample.messageId,'hex',{offset:range.start,length:range.end-range.start});};
}
$('ws-compare-prev').onclick=()=>{if(wsCompare?.previous===null||!wsCompare)return;wsCompare.focus=wsCompare.previous;renderWsComparison();};
$('ws-compare-next').onclick=()=>{if(wsCompare?.next===null||!wsCompare)return;wsCompare.focus=wsCompare.next;renderWsComparison();};
$('ws-compare-form').onsubmit=event=>{event.preventDefault();if(!wsCompare)return;try{wsCompare.focus=window.LibriumWSMessage.parseOffset($('ws-compare-offset').value,wsCompare.diff.max);renderWsComparison();}catch(error){$('ws-compare-offset').setCustomValidity(error.message);$('ws-compare-offset').setAttribute('aria-invalid','true');$('ws-compare-error').textContent=error.message;$('ws-compare-error').hidden=false;}};
window.addEventListener('resize',()=>{if(wsCompare&&$('ws-compare-dialog').open)renderWsComparison();if(wsInspect&&$('ws-inspector-dialog').open)scrollWsSelection(wsInspect);});
function wsSummaryBytes(value){if(!Number.isFinite(value)||value<0)return '—';const units=['Б','КиБ','МиБ','ГиБ','ТиБ','ПиБ'];let unit=0;while(value>=1024&&unit<units.length-1){value/=1024;unit++;}return value.toLocaleString('ru-RU',{maximumFractionDigits:unit?1:0})+' '+units[unit];}
function renderWsSummary(data){
 const box=$('ws-summary-content'),table=(caption,rows)=>{const table=el('table',undefined,'ws-summary-table');table.append(el('caption',caption));const head=el('thead'),tr=el('tr');for(const label of ['Направление / тип','Сообщений','Объём','Сохранено','Частично']){const th=el('th',label);th.scope='col';tr.append(th);}head.append(tr);table.append(head);const body=el('tbody');for(const [label,stats]of rows){const row=el('tr'),title=el('th',label);title.scope='row';row.append(title);for(const value of [stats.count.toLocaleString('ru-RU'),wsSummaryBytes(stats.bytes),wsSummaryBytes(stats.stored_bytes),stats.truncated.toLocaleString('ru-RU')])row.append(el('td',value));body.append(row);}table.append(body);return table;};
 const direction=value=>value==='sent'?'Отправлено':value==='received'?'Получено':value;
 const time=value=>{const date=new Date(value);return value!==null&&Number.isFinite(date.getTime())?date.toLocaleString('ru-RU'):'нет записанного времени';};
 $('ws-summary-title').textContent=`#${data.id} · ${data.summary.url}`;
 const status=data.state==='open'?'открыт':data.state==='closed'?'закрыт':'архив';
 $('ws-summary-state').textContent=`WebSocket ${status} · Снимок: ${time(data.measured_at)}${data.close?' · Код закрытия: '+data.close.code+(data.close.reason?' · '+data.close.reason:''):''}${data.error?' · '+data.error:''}`;
 box.replaceChildren(table('Все записанные сообщения',[['Отправлено',data.sent],['Получено',data.received],['Всего',data.total]]));
 if(data.kinds.length)box.append(table('По типам сообщений',data.kinds.map(row=>[direction(row.direction)+' · '+row.kind,row.stats])));
 if(data.kinds.some(row=>row.intervals)){
  const timing=el('table',undefined,'ws-summary-table ws-summary-timing'),head=el('thead'),header=el('tr'),body=el('tbody');timing.append(el('caption','Интервалы одного направления и типа'));
  for(const label of ['Направление / тип','Интервалов','Мин., мс','Среднее, мс','Макс., мс','Нулевых','Часы назад']){const th=el('th',label);th.scope='col';header.append(th);}head.append(header);timing.append(head,body);
  const ms=value=>Number.isFinite(value)&&value>=0?value.toLocaleString('ru-RU',{maximumFractionDigits:3}):'—';
  for(const row of data.kinds){const stats=row.intervals;if(!stats)continue;const tr=el('tr'),title=el('th',direction(row.direction)+' · '+row.kind);title.scope='row';tr.dataset.timingDirection=row.direction;tr.dataset.timingKind=row.kind;tr.append(title);
   for(const [index,value]of [stats.count.toLocaleString('ru-RU'),ms(stats.min_ms),ms(stats.mean_ms),ms(stats.max_ms),stats.zero.toLocaleString('ru-RU'),stats.backwards.toLocaleString('ru-RU')].entries()){
    const cell=el('td',value),pair=stats.longest;
    if(index===3&&pair&&Number.isSafeInteger(pair.before)&&Number.isSafeInteger(pair.after)&&pair.before>0&&pair.after>pair.before){
     const actions=el('div',undefined,'ws-summary-gap-links');
     for(const [key,label]of [['before','До'],['after','После']]){const button=el('button',label,'ws-summary-gap-'+key);button.type='button';button.title=`Открыть сообщение #${pair[key]} · ${label.toLowerCase()} максимального интервала ${ms(stats.max_ms)} мс`;button.setAttribute('aria-label',button.title);button.onclick=()=>{if(!box.contains(button)||wsSummaryId!==data.id||!$('ws-summary-dialog').open)return;$('ws-summary-close').click();openWsInspector(data.id,pair[key]);};actions.append(button);}cell.append(actions);
    }
    tr.append(cell);
   }body.append(tr);
  }
  box.append(timing,el('p','Интервалы между соседними сообщениями одного направления и типа в порядке захвата, по всей записи. Это не RTT и не время ответа сервера. Нули входят в среднее; скачки часов назад исключены и посчитаны отдельно. Частично сохранённые сообщения учитываются.','muted'));
 }
 box.append(el('p',`Первое сообщение: ${time(data.first_time)}. Последнее: ${time(data.last_time)}.`,'muted'));
 box.append(el('p','«Сохранено» — байты, доступные в архиве. «Частично» — число сообщений с усечённым содержимым.','muted'));
}
async function loadWsSummary(){
 const id=wsSummaryId;if(id===null)return;const version=++wsSummaryVersion;
 $('ws-summary-refresh').disabled=true;$('ws-summary-error').hidden=true;$('ws-summary-state').textContent='Вычисление сводки…';
 try{const data=await api(`traffic/${id}/ws-summary`);if(version!==wsSummaryVersion||!$('ws-summary-dialog').open)return;renderWsSummary(data);}
 catch(error){if(version!==wsSummaryVersion||!$('ws-summary-dialog').open)return;$('ws-summary-state').textContent='Сводка не обновлена';$('ws-summary-error').hidden=false;$('ws-summary-error').textContent=error.message.includes('404')?'Соединение удалено из истории или недоступно.':error.message;}
 finally{if(version===wsSummaryVersion)$('ws-summary-refresh').disabled=false;}
}
function closeWsSocketIoEvents(){++wsSocketIoEventsVersion;wsSocketIoEvents=null;if($('ws-socketio-events-dialog').open)$('ws-socketio-events-dialog').close();$('ws-socketio-events-content').replaceChildren();$('ws-socketio-events-error').hidden=true;}
async function findExactSocketIoEvent(state,row){
 if(wsSocketIoEvents!==state)return;const exact={id:state.id,protocol:'socketio',namespace:row.namespace,kind:row.kind,value:row.value};closeWsSocketIoEvents();
 $('ws-filter').value='';$('ws-search-format').value='socketio_event';$('ws-kind').value='TEXT';$('ws-direction').value='';
 if(selected===exact.id){wsExactFilter=exact;syncWsSearchFormat();wsFiltersChanged();}else{await choose(exact.id,exact);syncWsSearchFormat();}
}
async function loadWsSocketIoEvents(){
 const state=wsSocketIoEvents;if(!state)return;const version=++wsSocketIoEventsVersion,active=()=>wsSocketIoEvents===state&&version===wsSocketIoEventsVersion&&$('ws-socketio-events-dialog').open;
 $('ws-socketio-events-state').textContent='Считаем события по всей записи…';$('ws-socketio-events-content').replaceChildren();$('ws-socketio-events-error').hidden=true;$('ws-socketio-events-refresh').disabled=true;
 try{
  const data=await api(`traffic/${state.id}/ws-socketio-events`);if(!active())return;
  if(data.id!==state.id||!Array.isArray(data.rows)||data.rows.length>100||['total','matched','excluded','distinct','other'].some(key=>!Number.isSafeInteger(data[key])||data[key]<0)||data.matched+data.excluded!==data.total)throw Error('Неверный список событий Socket.IO.');
  const table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody'),preview=value=>{const chars=Array.from(value);return chars.slice(0,160).join('')+(chars.length>160?'…':'');};
  for(const label of ['Тип','Namespace','Событие','Всего','Отправлено','Получено','']){const cell=el('th',label);cell.scope='col';header.append(cell);}head.append(header);table.append(head,body);
  for(const row of data.rows){
   if(!['string','number'].includes(row.kind)||typeof row.value!=='string'||row.value.length>65536||typeof row.namespace!=='string'||!row.namespace.startsWith('/')||row.namespace.length>65536||['count','sent','received'].some(key=>!Number.isSafeInteger(row[key])||row[key]<0)||row.sent+row.received!==row.count)throw Error('Неверное событие Socket.IO.');
   const tr=el('tr'),name=el('td',row.value===''?'(пустая строка)':preview(row.value),'ws-json-value-text'),namespace=el('td',preview(row.namespace),'ws-json-value-text'),actions=el('td'),copy=el('button','Копировать имя','ws-socketio-event-copy'),find=el('button','Найти точно','ws-socketio-event-find');tr.dataset.eventKind=row.kind;
   copy.onclick=async()=>{try{if(window.librium)await window.librium.copy(row.value);else await navigator.clipboard.writeText(row.value);if(active())$('ws-socketio-events-state').textContent=state.summaryText+' · имя скопировано';}catch(error){if(active()){$('ws-socketio-events-error').textContent=error.message;$('ws-socketio-events-error').hidden=false;}}};
   find.onclick=()=>findExactSocketIoEvent(state,row).catch(showError);tr.append(el('td',row.kind==='string'?'Строка':'Число'),namespace,name);for(const key of ['count','sent','received'])tr.append(el('td',String(row[key]),'ws-json-value-count'));actions.append(copy,find);tr.append(actions);body.append(tr);
  }
  $('ws-socketio-events-content').replaceChildren(data.rows.length?table:el('p','События Socket.IO не найдены.','empty'));
  state.summaryText=`Сообщений: ${data.total} · событий: ${data.matched} · исключено: ${data.excluded} · разных событий и namespace: ${data.distinct} · сообщений вне списка: ${data.other}`;$('ws-socketio-events-state').textContent=state.summaryText;
 }catch(error){if(active()){$('ws-socketio-events-state').textContent='Список не загружен';$('ws-socketio-events-error').textContent=error.message.includes('404')?'Соединение удалено из истории или недоступно.':error.message;$('ws-socketio-events-error').hidden=false;}}
 finally{if(active())$('ws-socketio-events-refresh').disabled=false;}
}
$('ws-socketio-events').onclick=()=>{
 if(selected===null||detail?.summary.status!==101||$('ws-search-format').value!=='socketio_event')return;
 wsSocketIoEvents={id:selected};$('ws-socketio-events-meta').textContent=`WS #${selected}`;if(!$('ws-socketio-events-dialog').open)$('ws-socketio-events-dialog').showModal();loadWsSocketIoEvents();
};
$('ws-socketio-events-close').onclick=closeWsSocketIoEvents;$('ws-socketio-events-refresh').onclick=loadWsSocketIoEvents;$('ws-socketio-events-dialog').onclose=()=>{if(!$('ws-socketio-events-dialog').open)closeWsSocketIoEvents();};
function closeWsJsonValues(){++wsJsonValuesVersion;wsJsonValues=null;if($('ws-json-values-dialog').open)$('ws-json-values-dialog').close();$('ws-json-values-content').replaceChildren();$('ws-json-values-error').hidden=true;}
function syncWsExactChip(){
 const exact=wsExactFilter;let format=$('ws-search-format').value;
 const valid=exact&&(exact.protocol==='field'?format==='protocol_field':exact.protocol==='socketio'?format==='socketio_event':format==='jsonpointer'&&exact.pointer===$('ws-json-pointer').value);
 if(exact&&(exact.id!==selected||$('ws-filter').value!==''||!valid))wsExactFilter=null;
 const isField=wsExactFilter?.protocol==='field';$('ws-field-search-option').hidden=!isField;
 if(format==='protocol_field'&&!isField){$('ws-search-format').value='text';format='text';$('ws-filter').placeholder='Поиск по всей истории сообщений WS';}
 const chip=$('ws-json-exact');chip.hidden=!wsExactFilter;
 if(wsExactFilter){
  const types={string:'строка',number:'число',boolean:'логическое',null:'null'},preview=value=>{const chars=Array.from(value);return chars.slice(0,80).join('')+(chars.length>80?'…':'');};
  if(isField){const field=wsExactFilter.condition,order=['bytes','utf8','uint8','int8'].includes(field.type)?'':' '+field.endian.toUpperCase(),width=field.length===undefined?'':` · ${field.length} Б`;chip.textContent=`Точно · ${preview(wsExactFilter.name)} · ${field.type}${order} @ ${field.offset}${width}: ${preview(field.value)} ×`;}
  else chip.textContent=`Точно · ${wsExactFilter.protocol==='socketio'?'Socket.IO '+preview(wsExactFilter.namespace)+' · ':''}${types[wsExactFilter.kind]}: ${wsExactFilter.value===''?'(пустая строка)':preview(wsExactFilter.value)} ×`;
 }
 if(format==='protocol_field')$('ws-filter').placeholder='Введи текст, чтобы вернуться к обычному поиску';
 if(format==='jsonpointer')$('ws-filter').placeholder=wsExactFilter?'Введи текст, чтобы перейти к поиску подстроки':'Значение выбранного поля; пусто — поле существует';
 if(format==='socketio_event')$('ws-filter').placeholder=wsExactFilter?'Введи текст, чтобы искать подстроку в имени события':'Имя события Socket.IO с учётом регистра; пусто — все события';
}
$('ws-json-exact').onclick=()=>{wsExactFilter=null;syncWsExactChip();wsFiltersChanged();};
async function findExactJsonValue(state,row){
 if(wsJsonValues!==state)return;const exact={id:state.id,pointer:state.pointer,kind:row.kind,value:row.value};closeWsJsonValues();
 $('ws-filter').value='';$('ws-search-format').value='jsonpointer';$('ws-json-pointer').value=exact.pointer;$('ws-kind').value='DATA';$('ws-direction').value='';
 if(selected===exact.id){wsExactFilter=exact;syncWsSearchFormat();wsFiltersChanged();}else{await choose(exact.id,exact);syncWsSearchFormat();}
}
async function loadWsJsonValues(){
 const state=wsJsonValues;if(!state)return;const version=++wsJsonValuesVersion,active=()=>wsJsonValues===state&&version===wsJsonValuesVersion&&$('ws-json-values-dialog').open;
 $('ws-json-values-state').textContent='Считаем значения по всей записи…';$('ws-json-values-content').replaceChildren();$('ws-json-values-error').hidden=true;$('ws-json-values-refresh').disabled=true;
 try{
  const data=await api(`traffic/${state.id}/ws-json-values?pointer=`+encodeURIComponent(state.pointer));if(!active())return;
  if(data.id!==state.id||data.pointer!==state.pointer||!Array.isArray(data.rows)||data.rows.length>100||['total','matched','excluded','distinct','other'].some(key=>!Number.isSafeInteger(data[key])||data[key]<0))throw Error('Неверная сводка значений JSON.');
  const types={string:'Строка',number:'Число',boolean:'Логическое',null:'null'},table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');
  for(const label of ['Тип','Значение','Всего','Отправлено','Получено','']){const cell=el('th',label);cell.scope='col';header.append(cell);}head.append(header);table.append(head,body);
  for(const row of data.rows){
   if(!Object.hasOwn(types,row.kind)||typeof row.value!=='string'||row.value.length>65536||['count','sent','received'].some(key=>!Number.isSafeInteger(row[key])||row[key]<0))throw Error('Неверное значение в сводке JSON.');
   const tr=el('tr'),type=el('td',types[row.kind]),chars=Array.from(row.value),value=el('td',row.value===''?'(пустая строка)':chars.slice(0,160).join('')+(chars.length>160?'…':'')),actions=el('td'),copy=el('button','Копировать');tr.dataset.valueKind=row.kind;value.className='ws-json-value-text';
   copy.className='ws-json-value-copy';copy.title='Копировать полное значение';copy.onclick=async()=>{try{if(window.librium)await window.librium.copy(row.value);else await navigator.clipboard.writeText(row.value);if(active())$('ws-json-values-state').textContent=state.summaryText+' · значение скопировано';}catch(error){if(active()){$('ws-json-values-error').textContent=error.message;$('ws-json-values-error').hidden=false;}}};
   tr.append(type,value);for(const key of ['count','sent','received'])tr.append(el('td',String(row[key]),'ws-json-value-count'));const find=el('button','Найти точно','ws-json-value-find');find.onclick=()=>findExactJsonValue(state,row).catch(showError);actions.append(copy,find);tr.append(actions);body.append(tr);
  }
  $('ws-json-values-content').replaceChildren(data.rows.length?table:el('p','Скалярные значения выбранного поля не найдены.','empty'));
  state.summaryText=`Сообщений: ${data.total} · учтено: ${data.matched} · исключено: ${data.excluded} · разных значений: ${data.distinct} · сообщений вне списка: ${data.other}`;$('ws-json-values-state').textContent=state.summaryText;
 }catch(error){if(active()){$('ws-json-values-state').textContent='Сводка не загружена';$('ws-json-values-error').textContent=error.message.includes('404')?'Соединение удалено из истории или недоступно.':error.message;$('ws-json-values-error').hidden=false;}}
 finally{if(active())$('ws-json-values-refresh').disabled=false;}
}
$('ws-json-values').onclick=()=>{
 if(selected===null||detail?.summary.status!==101||$('ws-search-format').value!=='jsonpointer')return;
 const pointer=$('ws-json-pointer').value;try{window.LibriumWS.validateJsonPointer(pointer);}catch(error){$('ws-json-pointer').setCustomValidity(error.message);$('ws-json-pointer').setAttribute('aria-invalid','true');$('ws-filter-error').textContent=error.message;$('ws-filter-error').hidden=false;return;}
 wsJsonValues={id:selected,pointer};$('ws-json-values-meta').textContent=`WS #${selected} · поле ${pointer||'(весь JSON)'}`;if(!$('ws-json-values-dialog').open)$('ws-json-values-dialog').showModal();loadWsJsonValues();
};
$('ws-json-values-close').onclick=closeWsJsonValues;$('ws-json-values-refresh').onclick=loadWsJsonValues;$('ws-json-values-dialog').onclose=()=>{if(!$('ws-json-values-dialog').open)closeWsJsonValues();};
$('ws-signatures').onclick=()=>{
 if(selected===null||detail?.summary.status!==101)return;
 if(!wsSignatureController)wsSignatureController=window.LibriumWSSignatures.create({document,storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},currentConnection:()=>detail?.summary.status===101?selected:null,apply:(preset,id)=>{if(selected!==id||detail?.summary.status!==101)return;wsExactFilter=null;$('ws-filter').value=preset.pattern;$('ws-kind').value=preset.kind;$('ws-direction').value=preset.direction;$('ws-search-format').value='hex_mask';syncWsSearchFormat();wsFiltersChanged();toast('Применена сигнатура: '+preset.name);}});
 const format=$('ws-search-format').value;wsSignatureController.open({id:selected,pattern:['hex','hex_mask'].includes(format)?$('ws-filter').value:'',kind:$('ws-kind').value,direction:$('ws-direction').value});
};
$('ws-profile-open').onclick=()=>{
 if(selected===null||detail?.summary.status!==101)return;
 if(!wsProfileController)wsProfileController=window.LibriumWSProfile.create({document,request:path=>api(path),openMessage:(id,messageId,format,entry,codec)=>openWsInspectorFromHint(id,messageId,format,null,entry,codec),filterGroup:async(id,kind)=>{wsExactFilter=null;$('ws-search-format').value='content_kind';$('ws-content-kind').value=kind;$('ws-filter').value='';$('ws-kind').value='';$('ws-direction').value='';syncWsSearchFormat();if(selected===id)wsFiltersChanged();else await choose(id);window.requestAnimationFrame?.(()=>{if(selected===id&&detail?.summary.status===101&&$('ws-search-format').value==='content_kind'&&$('ws-content-kind').value===kind)$('panes').scrollIntoView?.({block:'start'});});}});
 wsProfileController.open(selected);
};
$('ws-summary').onclick=()=>{if(selected===null||detail?.summary.status!==101)return;wsSummaryId=selected;$('ws-summary-title').textContent='#'+selected;$('ws-summary-content').replaceChildren();$('ws-summary-dialog').showModal();loadWsSummary();};
$('ws-summary-refresh').onclick=()=>loadWsSummary();
$('ws-summary-close').onclick=()=>{++wsSummaryVersion;wsSummaryId=null;$('ws-summary-dialog').close();};
$('ws-summary-dialog').onclose=()=>{if($('ws-summary-dialog').open)return;++wsSummaryVersion;wsSummaryId=null;$('ws-summary-refresh').disabled=false;};
$('ws-filter').oninput=()=>{wsExactFilter=null;syncWsExactChip();wsFiltersChanged();};$('ws-json-pointer').oninput=()=>{wsExactFilter=null;syncWsExactChip();wsFiltersChanged();};$('ws-kind').onchange=wsFiltersChanged;$('ws-direction').onchange=wsFiltersChanged;
function syncWsSearchFormat(){const format=$('ws-search-format').value;$('ws-content-kind').hidden=format!=='content_kind';$('ws-filter').hidden=format==='content_kind';$('ws-filter').maxLength=format==='jsonrpc_id'?65536:1024;$('ws-filter').title=format==='hex_mask'?'До 256 байтов; ?? — один сохранённый байт. @12: или @0x0c: — строгое смещение от начала исходного сообщения.':'';$('ws-json-pointer').hidden=format!=='jsonpointer';$('ws-json-values').hidden=format!=='jsonpointer';$('ws-socketio-events').hidden=format!=='socketio_event';for(const node of Object.values(paneNodes))node.wsFormat.value=format==='content_kind'?(wsContentHint()?.view||'hex'):['protocol_field','hex_mask'].includes(format)?'hex':format.startsWith('jsonrpc_')?'jsonrpc':format.startsWith('cdp_')?'cdp':['msgpack','protobuf','hex'].includes(format)?format:'pretty';$('ws-filter').placeholder=format==='jsonrpc_id'?'ID: 17, "17" или null; пусто — все ID':format==='jsonrpc_method'?'Метод JSON-RPC; пусто — все команды и уведомления':format==='socketio_event'?'Имя события Socket.IO с учётом регистра; пусто — все события':format==='jsonpointer'?'Значение выбранного поля; пусто — поле существует':format==='cdp_id'?'Точный CDP ID, например: 17':format==='cdp_method'?'Имя CDP метода / события, например: Runtime.evaluate':format==='hex_mask'?'Маска: 01 ?? ff или @12: 01 ?? ff':format==='hex'?'Байты во всей истории, например: 00 ff 2a':format==='protobuf'?'Поиск по полям Protobuf во всей истории':format==='msgpack'?'Поиск по значениям MessagePack во всей истории':format==='utf8'?'Поиск по тексту и UTF-8 бинарных сообщений':'Поиск по всей истории сообщений WS';syncWsExactChip();}
$('ws-content-kind').onchange=()=>{syncWsSearchFormat();wsFiltersChanged();};
$('ws-search-format').onchange=()=>{syncWsSearchFormat();wsFiltersChanged();};
$('ws-export').onclick=async()=>{
  if(wsExporting||selected===null||detail?.summary.status!==101)return;
  const id=selected;let writable;wsExporting=true;$('ws-export').disabled=true;$('ws-export').textContent='Экспорт…';
  try{
    let result;
    if(window.librium?.exportWs)result=await window.librium.exportWs(id);
    else{
      if(typeof window.showSaveFilePicker!=='function')throw Error('Сохранение файлов не поддерживается этим браузером; используй настольный Librium');
      const handle=await window.showSaveFilePicker({suggestedName:`librium-ws-${id}.jsonl`,types:[{description:'JSON Lines',accept:{'application/json':['.jsonl']}}]});
      writable=await handle.createWritable();result=await window.LibriumWSExport.exportSession({id,request:route=>api(route),write:line=>writable.write(line)});await writable.close();writable=null;
    }
    if(result)toast(`WS #${id}: сохранено сообщений — ${result.messages}`);
  }catch(error){if(writable)await writable.abort().catch(()=>{});if(error.name!=='AbortError')showError(error);}
  finally{wsExporting=false;$('ws-export').textContent='Экспорт JSONL';$('ws-export').disabled=!window.librium?.exportWs&&typeof window.showSaveFilePicker!=='function';}
};
$('pause').onclick = () => { paused = !paused;++refreshEpoch;++renderVersion;$('pause').textContent = paused ? '▶ Продолжить' : 'Ⅱ Пауза'; $('pause').classList.toggle('active',paused);$('pause').setAttribute('aria-pressed',String(paused));$('connection').textContent=paused?'Просмотр на паузе':'Обновление…';$('dot').classList.remove('live'); };
$('clear').onclick = async () => { if(!window.confirm('Удалить всю сохранённую историю запросов с диска?'))return; try { await api('traffic','DELETE');captureContextsController?.close();wsProfileController?.close();wsArchiveController?.close();wsSignatureController?.close();resetWsCompareBaseline();closeWsInspector();closeWsJsonValues();closeWsSocketIoEvents();wsExactFilter=null;syncWsExactChip(); ++listGeneration; pageOffset=0;pageAnchor=null;pageTotal=0;pageMatched=0; rows = []; selected = null; detail = null; detailSignature = ''; rowsSignature = ''; renderRows(); renderDetail(); $('selection').replaceChildren(el('span','История очищена')); } catch(error) { showError(error); } };
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
try{if(localStorage.getItem('librium-ws-layout-v1')==='timeline')$('ws-layout').value='timeline';}catch{}
renderDetail();initSessions().then(refresh).catch(showError);
