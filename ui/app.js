'use strict';
const $ = id => document.getElementById(id);
const t = (key, params) => LibriumI18n.t(key, params);
let rows = [], previousSelected = null, selected = null, detail = null, paused = false, detailSignature = '', rowsSignature = '', wrapped = true;
let wsData=null,wsBefore=null,wsSignature="";
const modes = { request: 'http', response: 'pretty' };
// The tabs a user picks by hand become the default for the next selection; media and sockets still pick their own.
const preferredModes = (() => { try { const saved = JSON.parse(localStorage.getItem('librium-modes') || '{}'); return {request: ['http','headers','params','cookies','pretty','text','hex'].includes(saved.request) ? saved.request : 'http', response: ['http','headers','cookies','pretty','text','hex'].includes(saved.response) ? saved.response : 'pretty'}; } catch { return {request: 'http', response: 'pretty'}; } })();
function rememberMode(side, key) { if (['ws','image','audio'].includes(key)) return; preferredModes[side] = key; try { localStorage.setItem('librium-modes', JSON.stringify(preferredModes)); } catch {} }
const paneNodes = {};
let filterRules=[],sortField="id",sortOrder="desc";
const PAGE_SIZE=500;
let pageOffset=0, pageAnchor=null, pageTotal=0, pageMatched=0, pageNewest=0, listGeneration=0;
async function loadPage() {
  const generation=++listGeneration;
  const parsed=LibriumFilters.parse($('filter').value);
  const query={offset:pageOffset,limit:PAGE_SIZE,before:pageAnchor,query:parsed.text,method:$('method').value,status:$('status').value,rules:activeRules(parsed),traffic_type:$('traffic-type').value,sort:sortField,order:sortOrder};
  const data=await api('traffic-page?q='+encodeURIComponent(JSON.stringify(query)));
  if(generation!==listGeneration)return;
  const signature=JSON.stringify(data);
  if(signature===rowsSignature)return;
  pageTotal=data.total;pageMatched=data.matched;pageNewest=data.newest;
  rows=data.rows;rememberForSuggest(rows);rowsSignature=signature;renderRows();
  // Follow mode: the newest request opens itself while the newest page is on screen.
  if(following&&!paused&&pageOffset===0&&pageAnchor===null&&sortField==='id'&&sortOrder==='desc'){const newest=rows[0];if(newest&&newest.id!==selected)choose(newest.id).catch(showError);}
}
// The builder's rules plus the conditions typed into the search box; the core accepts up to 48.
const activeRules=parsed=>[...filterRules,...parsed.rules].slice(0,48);
// A body: condition scans the whole history in the core; typing one is not sent letter by letter.
const settle=ms=>new Promise(resolve=>{const id=setTimeout(resolve,ms);if(!id)resolve();});
let filterTicket=0;
function filtersChanged(){saveActiveSession();pageOffset=0;pageAnchor=null;renderRows();const ticket=++filterTicket;const slow=LibriumFilters.parse($('filter').value).rules.some(rule=>rule.field==='body');(slow?settle(350):Promise.resolve()).then(()=>{if(ticket===filterTicket)return loadPage();}).catch(showError);}

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
 const generation=++sessionSaveGeneration;$('session-state').textContent=t('session.saving');
 try{const value=JSON.parse(JSON.stringify(sessionState));if(window.librium?.saveFilterSessions)await window.librium.saveFilterSessions(value);else localStorage.setItem('librium-filter-sessions-v1',JSON.stringify(value));if(generation===sessionSaveGeneration)$('session-state').textContent=t('session.saved');}
 catch(error){$('session-state').textContent=t('session.notSaved');showError(error);}
}
// Typing in the search box changes the session on every key: the file is written once the typing pauses.
let persistTimer=0;
function persistSessionsSoon(){clearTimeout(persistTimer);$('session-state').textContent=t('session.saving');persistTimer=setTimeout(persistSessions,300);if(!persistTimer)persistSessions();}
function saveActiveSession(){if(!sessionState)return;Object.assign(sessionState.sessions.find(s=>s.id===sessionState.activeId),currentFilters());persistSessionsSoon();}
function applySession(){
 const session=sessionState.sessions.find(s=>s.id===sessionState.activeId);
 sortField=session.sort||'id';sortOrder=session.order||'desc';renderSort();$('filter').value=session.query;$('method').value=session.method;$('status').value=session.status;$('traffic-type').value=session.type;filterRules=JSON.parse(JSON.stringify(session.rules));renderSessions();renderFilterChips();pageOffset=0;pageAnchor=null;
}
async function initSessions(){
 const saved=window.librium?.loadFilterSessions?await window.librium.loadFilterSessions():JSON.parse(localStorage.getItem('librium-filter-sessions-v1')||'null');
 sessionState=saved||{version:1,activeId:'default',sessions:[{id:'default',name:t('session.default'),...emptyFilters()}]};applySession();
 $('session-state').textContent=t('session.autosave');
}
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function bytes(n) { if (n < 1024) return `${n} B`; let value = n / 1024, unit = 0; while (value >= 1024 && unit < 2) { value /= 1024; unit++; } return `${value.toFixed(value < 100 ? 1 : 0)} ${['KB', 'MB', 'GB'][unit]}`; }
// The core stores its notices in English; show them in the active language when known.
const CORE_NOTICES={'Dropped in Librium intercept':'core.dropped','Response too large to intercept':'core.heldTooLarge','Response failed while held':'core.heldFailed','Connection interrupted when Librium stopped':'core.stopped','Connection closed when Librium restarted':'core.restarted','Connection ended when Librium was updated':'core.updated','Transfer interrupted before the full body arrived':'core.truncated'};
function coreText(text){return CORE_NOTICES[text]?t(CORE_NOTICES[text]):text;}
function clock(ms) { return ms ? new Date(ms).toLocaleTimeString(LibriumI18n.locale) : ''; }
function stamp(ms) { return ms ? new Date(ms).toLocaleString(LibriumI18n.locale) : ''; }
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 2400); }
let lastReportedError='';
function showError(error) { $('error').hidden = !error; $('error').textContent = error?.message || '';if(error && error.message!==lastReportedError){lastReportedError=error.message;window.librium?.reportError?.(error.stack||error.message).catch(()=>{});} }
window.addEventListener('error',event=>showError(event.error||Error(event.message)));
window.addEventListener('unhandledrejection',event=>showError(event.reason instanceof Error?event.reason:Error(String(event.reason))));
async function api(path, method = 'GET', body) {
  if (window.librium) return window.librium.request(path, method, body);
  const headers = { 'x-librium-token': token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch('/api/' + path, { method, headers, body });
  // A restarted core mints a new token: the page must be reloaded to pick it up (the desktop app does this itself).
  if (response.status === 401 && !api.reloading) { api.reloading = true; setTimeout(() => location.reload(), 500); }
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
  // The launcher needs Electron; the plain browser UI at the core's port has no way to spawn processes.
  for(const id of ['browser','browser-hint'])$(id).hidden=!window.librium?.openBrowser;
  for(const id of ['proxy-address','dialog-proxy','empty-proxy']){const node=$(id);if(node)node.textContent=proxyAddress;}
  $('ca-install').textContent=t(platform==='win32'?'https.caWindows':platform==='darwin'?'https.caMac':'https.caOther');
  $('ca-check-label').textContent=t(platform==='win32'?'https.checkPowerShell':'https.checkTerminal');
  $('ca-check').textContent=platform==='win32'?`curl.exe --ssl-revoke-best-effort --proxy http://${proxyAddress} --cacert "${caPath()}" https://example.com`:`curl --proxy http://${proxyAddress} --cacert "${caPath()}" https://example.com`;
  window.mobileFirewallHint?.();
}
async function loadInfo(){
  try{const info=await api('info');const port=Number(info?.proxy_port);if(Number.isInteger(port)&&port>0&&port<=65535)proxyAddress='127.0.0.1:'+port;if(typeof info?.data_dir==='string'&&info.data_dir)dataDir=info.data_dir;if(typeof info?.version==='string')$('version').textContent=info.version;}catch{}
  renderConnectionInfo();
}
// macOS keyboards expect ⌘ where Windows and Linux use Ctrl.
const shortcut=event=>platform==='darwin'?event.metaKey||event.ctrlKey:event.ctrlKey;
$('filter-key').textContent=platform==='darwin'?'⌘ K':'Ctrl K';
function splitUrl(url) { try { const u = new URL(url); return { host: u.host, path: u.pathname + u.search }; } catch { return { host: url, path: '/' }; } }
function renderSort(){
 document.querySelectorAll('[data-sort]').forEach(button=>{const active=button.dataset.sort===sortField;button.textContent=button.dataset.label+(active?(sortOrder==='asc'?' ↑':' ↓'):'');button.closest('th').setAttribute('aria-sort',active?(sortOrder==='asc'?'ascending':'descending'):'none');});
 $('sort-description').textContent=sortField==='id'?t(sortOrder==='desc'?'sort.newest':'sort.oldest'):t('sort.by',{name:document.querySelector(`[data-sort="${sortField}"]`).dataset.label});
}
// Row nodes are keyed by id and reused between polls, so the list updates in place:
// hover, focus and the reader's scroll position survive new traffic arriving above.
// Reason phrases for the status tooltip; the wire carries none for HTTP/2.
const REASONS={100:'Continue',101:'Switching Protocols',200:'OK',201:'Created',202:'Accepted',204:'No Content',206:'Partial Content',301:'Moved Permanently',302:'Found',303:'See Other',304:'Not Modified',307:'Temporary Redirect',308:'Permanent Redirect',400:'Bad Request',401:'Unauthorized',402:'Payment Required',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',406:'Not Acceptable',408:'Request Timeout',409:'Conflict',410:'Gone',411:'Length Required',412:'Precondition Failed',413:'Content Too Large',414:'URI Too Long',415:'Unsupported Media Type',416:'Range Not Satisfiable',418:'I\'m a teapot',422:'Unprocessable Content',425:'Too Early',426:'Upgrade Required',428:'Precondition Required',429:'Too Many Requests',431:'Request Header Fields Too Large',451:'Unavailable For Legal Reasons',500:'Internal Server Error',501:'Not Implemented',502:'Bad Gateway',503:'Service Unavailable',504:'Gateway Timeout',505:'HTTP Version Not Supported'};
const rowNodes=new Map();
const rowKey=row=>`${row.method}\n${row.url}\n${row.status}\n${row.size}\n${row.time}\n${row.content_type??''}\n${row.elapsed_ms??''}\n${row.error??''}\n${row.starred?1:0}\n${row.note??''}\n${row.mock?1:0}`;
// A short label for the list: the media subtype without vendor prefixes and structured suffixes.
function typeLabel(type){if(!type)return '';const subtype=type.split('/')[1]||type;const shorts={plain:'txt',javascript:'js',ecmascript:'js','octet-stream':'bin','x-www-form-urlencoded':'form','event-stream':'sse','x-icon':'ico','vnd.microsoft.icon':'ico','jpeg':'jpg'};if(Object.hasOwn(shorts,subtype))return shorts[subtype];const [base,suffix]=subtype.replace(/^x-/,'').replace(/^vnd\./,'').split('+');return (suffix==='json'?suffix:base).slice(0,10);}
function buildRow(row) {
  const tr = el('tr'); tr.dataset.id = row.id; tr.tabIndex = 0;
  tr.setAttribute('aria-label', `ID ${row.id}: ${row.method} ${row.url}`);
  const url = splitUrl(row.url), urlCell = el('td'), path = el('span', undefined, 'path');
  const label = typeLabel(row.content_type); if (label) { const tag = el('span', label, 'type'); tag.title = row.content_type; path.append(tag); }
  if (row.mock) { const tag = el('span', 'mock', 'type mock'); tag.title = t('row.mockTitle'); path.append(tag); }
  path.append(document.createTextNode(url.path)); urlCell.append(el('span', url.host, 'host'), path); urlCell.title = row.url;
  const methodCell = el('td'); methodCell.append(el('span', row.method, 'method-tag ' + row.method));
  const idCell = el('td', row.id, 'request-id'); idCell.title = String(row.id);
  // The star sits in front of the host: the ID column is too narrow to carry it.
  if (row.starred) { urlCell.firstChild.prepend(el('span', '★ ', 'star')); tr.classList.add('starred'); }
  if (row.note) urlCell.title = row.url + '\n' + row.note;
  const timeCell = el('td', clock(row.time), 'bytes time'); timeCell.title = stamp(row.time) + (row.elapsed_ms == null ? '' : ` · ${row.elapsed_ms} ms`);
  // Time to the first response byte, under the clock; a second and more stands out.
  if (row.elapsed_ms != null) timeCell.append(el('span', row.elapsed_ms >= 10000 ? `${(row.elapsed_ms / 1000).toFixed(1)} s` : `${row.elapsed_ms} ms`, 'latency' + (row.elapsed_ms >= 1000 ? ' slow' : '')));
  const statusCell = el('td', row.status ?? '…', `status s${String(row.status)[0]}`);
  if (row.status != null && REASONS[row.status]) statusCell.title = `${row.status} ${REASONS[row.status]}`;
  // A transfer that failed after its status arrived would otherwise look like any other 200.
  if (row.error) { statusCell.append(el('span', ' ⚠', 'status-flag')); statusCell.title = coreText(row.error); tr.classList.add('flagged'); }
  tr.append(idCell, timeCell, methodCell, urlCell, statusCell, el('td', bytes(row.size), 'bytes'));
  tr.onclick = () => choose(row.id);
  tr.oncontextmenu = event => { event.preventDefault(); choose(row.id); openRowMenu(row, event.clientX, event.clientY); };
  tr.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(row.id); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); let next = tr; do { next = event.key === 'ArrowDown' ? next.nextElementSibling : next.previousElementSibling; } while (next && !next.dataset.id); if (next) { next.focus(); choose(Number(next.dataset.id)); } }
  };
  return tr;
}
function renderSelection() {
  for (const tr of $('rows').children) { if (!tr.dataset.id) continue; const on = Number(tr.dataset.id) === selected; tr.classList.toggle('selected', on); tr.setAttribute('aria-selected', String(on)); }
}
function renderRows() {
  const parsed = LibriumFilters.parse($('filter').value), query = parsed.text.toLowerCase(), rules = activeRules(parsed), method = $('method').value, status = $('status').value;
  const shown = rows.filter(r => `${r.id} ${r.method} ${r.url} ${r.status ?? ''} ${r.content_type ?? ''}`.toLowerCase().includes(query) && (!method || r.method === method) && (!status || (status === 'pending' ? r.status === null : String(r.status).startsWith(status))) && LibriumFilters.matches(r,rules));
  const tbody = $('rows'), scroller = tbody.closest('.table-scroll');
  // Remember the first visible row; at the very top the newest traffic should stay in view instead.
  let anchor = null;
  if (scroller && scroller.scrollTop > 0) { const top = scroller.getBoundingClientRect().top; for (const tr of tbody.children) { if (!tr.dataset.id) continue; const rect = tr.getBoundingClientRect(); if (rect.bottom > top) { anchor = {id: Number(tr.dataset.id), offset: rect.top - top}; break; } } }
  const focusedId = document.activeElement?.dataset?.id;
  const seen = new Set(), nodes = [];
  // Ordered by id the list is ordered by time too: a dated separator marks where a new day starts.
  let lastDay = null;
  for (const row of shown) {
    const day = sortField === 'id' && row.time ? new Date(row.time).toDateString() : null;
    if (day && day !== lastDay) { const key = 'day:' + day; let entry = rowNodes.get(key); if (!entry) { const tr = el('tr', undefined, 'day'); const label = new Date(row.time).toLocaleDateString(LibriumI18n.locale, {weekday: 'short', day: 'numeric', month: 'long', year: 'numeric'}); const cell = el('td', label.charAt(0).toUpperCase() + label.slice(1)); cell.colSpan = 6; tr.append(cell); entry = {tr, key}; rowNodes.set(key, entry); } seen.add(key); nodes.push(entry.tr); }
    lastDay = day;
    const key = rowKey(row); let entry = rowNodes.get(row.id); if (!entry || entry.key !== key) { entry = {tr: buildRow(row), key}; rowNodes.set(row.id, entry); } seen.add(row.id); nodes.push(entry.tr);
  }
  for (const id of [...rowNodes.keys()]) if (!seen.has(id)) rowNodes.delete(id);
  nodes.forEach((tr, index) => { if (tbody.children[index] !== tr) tbody.insertBefore(tr, tbody.children[index] || null); });
  while (tbody.children.length > nodes.length) tbody.lastElementChild.remove();
  renderSelection();
  if (focusedId && document.activeElement?.dataset?.id !== focusedId) tbody.querySelector(`[data-id="${focusedId}"]`)?.focus({preventScroll:true});
  if (anchor) { const tr = rowNodes.get(anchor.id)?.tr; if (tr) { const delta = tr.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset; if (delta) scroller.scrollTop += delta; } }
  $('count').textContent = `${pageMatched} / ${pageTotal}`;
  $('page-label').textContent = pageMatched ? t('page.range',{from:pageOffset+1,to:pageOffset+rows.length,total:pageMatched}) : t('page.none');
  $('page-prev').disabled=pageOffset===0;
  $('page-next').disabled=pageOffset+PAGE_SIZE>=pageMatched;
  $('empty').hidden = shown.length > 0;
  // With something in the history but nothing on the page, the conditions are the reason, not the traffic.
  if (!shown.length && (rows.length || pageTotal > 0)) { const reset = el('button', t('chip.reset'), 'quiet'); reset.onclick = resetFilters; const actions = el('p', undefined, 'empty-actions'); actions.append(reset); $('empty').replaceChildren(el('h3', t('empty.nothing')), el('p', t('empty.changeFilter')), actions); }
  else if (!shown.length) {
    // The first thing a newcomer needs is right here, not behind the gear in the corner.
    const actions = el('p', undefined, 'empty-actions');
    const setup = el('button', t('empty.setup'), 'primary'); setup.onclick = () => $('setup').click(); actions.append(setup);
    if (window.librium?.openBrowser) { const browser = el('button', t('empty.browser')); browser.onclick = () => $('browser').click(); actions.append(browser); }
    $('empty').replaceChildren(el('div', '↔', 'empty-icon'), el('h3', t('empty.waiting')), el('p', t('empty.proxyHint',{proxy:proxyAddress})), actions);
  }
}
for (const side of ['request', 'response']) {
  const pane = el('section', undefined, 'pane'), title = el('div', undefined, 'pane-title');
  const heading = el('h2'); heading.append(el('span', side === 'request' ? '↗' : '↙'), document.createTextNode(side === 'request' ? 'Request' : 'Response'));
  const state = el('span', '', 'pane-state'), copy = el('button', t('pane.copy'), 'copy-pane');
  copy.onclick = async () => { try { const text = paneNodes[side].copyText || ''; if (window.librium) await window.librium.copy(text); else await navigator.clipboard.writeText(text); toast(t('pane.copied')); } catch(e) { showError(e); } };
  title.append(heading, state);
  const save = el('button', t('pane.save'), 'save-body'); save.title = t('pane.saveTitle'); save.hidden = true;
  save.onclick = async () => { if (!detail) return; try { if (await window.librium.saveMedia(detail.summary.id, side)) toast(t('media.saved')); } catch(e) { showError(e); } };
  title.append(save);
  if (side === 'request') {
    const replay = el('button', t('pane.replay'), 'replay'); replay.title = t('pane.replayTitle'); replay.hidden = true;
    replay.onclick = async () => { if (!detail || replay.disabled) return; replay.disabled = true; const label = replay.textContent; replay.textContent = t('replay.sending'); try { await sendReplay(detail.summary.id); } catch(e) { showError(e); } finally { replay.disabled = false; replay.textContent = label; } };
    title.append(replay); pane.replay = replay;
    const editButton = el('button', t('pane.edit'), 'replay-edit'); editButton.title = t('pane.editTitle'); editButton.hidden = true;
    editButton.onclick = () => { if (detail) openReplayEditor(detail); };
    title.append(editButton); pane.edit = editButton;
    const curl = el('button', t('pane.curl'), 'copy-curl'); curl.title = t('pane.curlTitle'); curl.hidden = true;
    curl.onclick = async () => { if (!detail) return; try { const command = curlCommand(detail); if (window.librium) await window.librium.copy(command.text); else await navigator.clipboard.writeText(command.text); toast(t(command.bodyOmitted ? 'pane.curlNoBody' : 'pane.curlCopied')); } catch(e) { showError(e); } };
    title.append(curl); pane.curl = curl;
  }
  title.append(copy);
  const tabs = el('div', undefined, 'tabs');
  for (const [key,label] of [['http','HTTP'],['headers',t('tab.headers')],['params',t('tab.params')],['cookies',t('tab.cookies')],['pretty','Pretty'],['text',t('tab.text')],['hex','Hex'],['image',t('tab.image')],['audio',t('tab.audio')],['ws',t('tab.ws')]]) {
    const button = el('button', label); button.dataset.mode = key;
    button.onclick = () => { modes[side] = key; rememberMode(side, key); renderDetail(); }; tabs.append(button);
  }
  const notice = el('div', '', 'notice'); notice.hidden = true;
  const content = el('div', undefined, 'content');
  pane.append(title, tabs, notice, content); $('panes').append(pane); paneNodes[side] = { pane, state, tabs, notice, content, save, curl: pane.curl, replay: pane.replay, edit: pane.edit, copyText: '' };
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
  if (lines.length > 3000) fragment.append(el('div', t('body.lineLimit'), 'notice'));
  return fragment;
}
// A collapsible JSON tree for the Pretty tab. Arrays and objects with many children start folded;
// documents beyond TREE_LIMIT nodes fall back to the line view, which stays fast.
const TREE_LIMIT = 5000, FOLD_ABOVE = 100;
function jsonTree(root) {
  let count = 0;
  const walk = value => { count++; if (count > TREE_LIMIT) throw Error('big'); if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  try { walk(root); } catch { return null; }
  const scalar = value => {
    if (typeof value === 'string') return el('span', JSON.stringify(value), 'json-string');
    if (typeof value === 'number') return el('span', String(value), 'json-number');
    return el('span', String(value), 'json-number');
  };
  const node = (key, value, depth, last) => {
    const row = el('div', undefined, 'jt-row'); row.style.setProperty('--depth', depth);
    const container = value && typeof value === 'object';
    const entries = container ? Object.entries(value) : [];
    const array = Array.isArray(value);
    if (key !== null) row.append(el('span', JSON.stringify(key) + ': ', 'json-key'));
    if (!container) { row.append(scalar(value)); if (!last) row.append(document.createTextNode(',')); return row; }
    const toggle = el('button', '', 'jt-toggle'); toggle.setAttribute('aria-label', 'toggle');
    const summary = el('span', '', 'jt-summary');
    const children = el('div', undefined, 'jt-children');
    entries.forEach(([k, v], index) => children.append(node(array ? null : k, v, depth + 1, index === entries.length - 1)));
    const closing = el('span', (array ? ']' : '}') + (last ? '' : ','), 'jt-close');
    const show = open => { children.hidden = !open; toggle.textContent = open ? '▾' : '▸'; summary.textContent = open ? (array ? '[' : '{') : `${array ? '[' : '{'}…${array ? ']' : '}'} ${t(array ? 'json.items' : 'json.keys', {count: entries.length})}${last ? '' : ','}`; closing.hidden = !open; };
    toggle.onclick = () => show(children.hidden);
    row.prepend(toggle); row.append(summary);
    const wrapper = el('div', undefined, 'jt-node'); wrapper.append(row, children, closing); closing.style.setProperty('--depth', depth);
    show(entries.length > 0 && entries.length <= FOLD_ABOVE);
    if (!entries.length) { show(true); summary.textContent = (array ? '[]' : '{}') + (last ? '' : ','); toggle.remove(); closing.remove(); }
    return wrapper;
  };
  const box = el('div', undefined, 'jt'); box.append(node(null, root, 0, true)); return box;
}
function hexView(base64) {
  const raw = atob(base64.slice(0,87384)).slice(0,65536), lines = [];
  for (let i = 0; i < raw.length; i += 16) { const part = [...raw.slice(i,i+16)].map(c => c.charCodeAt(0)); lines.push(i.toString(16).padStart(6,'0') + '  ' + part.map(n => n.toString(16).padStart(2,'0')).join(' ').padEnd(47,' ') + '  ' + part.map(n => n >= 32 && n < 127 ? String.fromCharCode(n) : '.').join('')); }
  return lines.join('\n');
}
// A shell command that repeats the request: bash quoting on macOS and Linux, PowerShell quoting on Windows.
function curlCommand(current) {
  const windows = platform === 'win32';
  const quote = value => windows ? `'${String(value).replace(/'/g, "''").replace(/"/g, '\\"')}'` : `'${String(value).replace(/'/g, "'\\''")}'`;
  const body = current.request;
  // curl turns --data-raw into POST unless the method is spelled out, so a GET with a body keeps its verb.
  const parts = [[windows ? 'curl.exe' : 'curl', current.summary.method === 'GET' && !body.size ? '' : '-X ' + current.summary.method, quote(current.summary.url)].filter(Boolean).join(' ')];
  let compressed = false;
  for (const [name, value] of current.request.headers) {
    if (/^(host|content-length|connection|proxy-connection|transfer-encoding|te|upgrade|keep-alive)$/i.test(name)) continue;
    if (/^accept-encoding$/i.test(name)) { compressed = true; continue; }
    parts.push('-H ' + quote(`${name}: ${value}`));
  }
  if (compressed) parts.push('--compressed');
  let bodyOmitted = false;
  if (body.size > 0) {
    const binary = /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(body.text) || body.headers.some(([name, value]) => /^content-encoding$/i.test(name) && !/^identity$/i.test(value.trim()));
    if (body.complete && !body.truncated && !binary) parts.push('--data-raw ' + quote(body.text)); else bodyOmitted = true;
  }
  return {text: parts.join(windows ? ' `\n  ' : ' \\\n  '), bodyOmitted};
}
// A star and a note stick to an exchange in the core; the list and the header follow.
async function markRow(id, patch) {
  try { await api('traffic/' + id, 'PATCH', JSON.stringify(patch)); if (detail?.summary.id === id) Object.assign(detail.summary, patch); rowsSignature = ''; detailSignature = ''; await loadPage(); await loadDetail(); }
  catch (error) { showError(error); }
}
const markSelected = patch => detail ? markRow(detail.summary.id, patch) : Promise.resolve();
$('note').onchange = () => { if (detail) markSelected({note: $('note').value.trim().slice(0, 4096)}); };
$('note').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('note').blur(); } });
// The same exchange as code: a browser fetch() call and a Python requests call.
function requestParts(current) {
  const body = current.request;
  const headers = body.headers.filter(([name]) => !/^(host|content-length|connection|proxy-connection|transfer-encoding|te|upgrade|keep-alive|accept-encoding)$/i.test(name));
  const binary = body.size > 0 && (/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(body.text) || body.headers.some(([name, value]) => /^content-encoding$/i.test(name) && !/^identity$/i.test(value.trim())));
  const bodyText = body.size > 0 && body.complete && !body.truncated && !binary ? body.text : null;
  return {headers, bodyText, bodyOmitted: body.size > 0 && bodyText === null};
}
function fetchSnippet(current) {
  const {headers, bodyText, bodyOmitted} = requestParts(current);
  const options = {method: current.summary.method};
  if (headers.length) options.headers = headers;
  if (bodyText !== null) options.body = bodyText;
  return {text: `fetch(${JSON.stringify(current.summary.url)}, ${JSON.stringify(options, null, 2)})`, bodyOmitted};
}
function pythonSnippet(current) {
  const {headers, bodyText, bodyOmitted} = requestParts(current);
  const literal = value => JSON.stringify(value);
  const lines = ['import requests', '', `response = requests.request(${literal(current.summary.method)}, ${literal(current.summary.url)},`];
  if (headers.length) lines.push(`    headers={${headers.map(([name, value]) => `${literal(name)}: ${literal(value)}`).join(', ')}},`);
  if (bodyText !== null) lines.push(`    data=${literal(bodyText)},`);
  lines.push(')', 'print(response.status_code, response.text)');
  return {text: lines.join('\n'), bodyOmitted};
}
async function copySnippet(row, build) {
  try { const full = detail?.summary.id === row.id ? detail : await api('traffic/' + row.id); const snippet = build(full); await copyText(snippet.text); toast(t(snippet.bodyOmitted ? 'pane.curlNoBody' : 'pane.snippetCopied')); }
  catch (error) { showError(error); }
}
// Decompressing a body once per selection: typing in the search box re-renders the panes.
const decodedBodies = new WeakMap();
async function bodyText(payload, id, side) {
  if (decodedBodies.has(payload)) return decodedBodies.get(payload);
  const decoded = await decodeBody(payload, id, side);
  decodedBodies.set(payload, decoded);
  return decoded;
}
const contentEncoding = payload => (payload.headers.find(([name]) => name.toLowerCase() === 'content-encoding')?.[1] || '').trim().toLowerCase();
// The decoded bytes of a compressed body, up to `limit`. Chromium's DecompressionStream undoes
// gzip and deflate in the page; brotli and zstd (and anything the page cannot undo) go to the
// desktop process, which has Node's zlib. Throws when nothing could decode the body.
async function inflate(payload, encoding, id, side, limit) {
  if (['gzip', 'x-gzip', 'deflate'].includes(encoding)) {
    try {
      const raw = Uint8Array.from(atob(payload.base64), c => c.charCodeAt(0));
      const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream(encoding === 'deflate' ? 'deflate' : 'gzip')).getReader();
      const chunks = []; let size = 0;
      try { while (true) { const {value, done} = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw Error(t('media.tooLarge')); } chunks.push(value); } } finally { reader.releaseLock(); }
      return new Uint8Array(await new Blob(chunks).arrayBuffer());
    } catch (error) { if (!window.librium?.decodeBody) throw error; }
  }
  if (!window.librium?.decodeBody) throw Error(t('body.decompressFailed'));
  const result = await window.librium.decodeBody(id, side);
  if (!result.decoded) throw Error(t('body.decompressFailed'));
  if (result.size > limit) throw Error(t('media.tooLarge'));
  return Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
}
async function decodeBody(payload, id, side) {
  const encoding = contentEncoding(payload);
  if (!encoding || encoding === 'identity') return {text:payload.text, notice:''};
  if (payload.truncated || !payload.complete) return {text:t('body.compressedIncomplete'), notice:`Content-Encoding: ${encoding}`};
  try {
    const raw = await inflate(payload, encoding, id, side, 64 * 1024 * 1024);
    const capped = raw.length > 65536;
    return {text: new TextDecoder().decode(raw.subarray(0, 65536)), notice:t('body.decompressed',{encoding,capped:capped ? t('body.first64') : ''})};
  } catch {
    // The core already decoded the first 64 KiB for the preview: enough when the page itself cannot.
    if (payload.text) return {text: payload.text, notice: t('body.decompressed', {encoding, capped: t('body.first64')})};
    return {text:t('body.decompressFailed'), notice:`Content-Encoding: ${encoding}`};
  }
}
// Edit and resend: the captured request as editable text; a body that is not plain text is sent as captured.
let replayTarget = null;
function editableBody(payload) {
  if (!payload.size) return {text: '', editable: true, note: t('replay.bodyNone')};
  if (!payload.complete || payload.truncated || contentEncoding(payload) && contentEncoding(payload) !== 'identity') return {text: '', editable: false, note: t('replay.bodyBinary')};
  try { return {text: new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(atob(payload.base64), c => c.charCodeAt(0))), editable: true, note: ''}; }
  catch { return {text: '', editable: false, note: t('replay.bodyBinary')}; }
}
// Every resend goes through here: after the answer, the new exchange is selected so the result is one click closer.
async function sendReplay(id, edit) {
  const before = rows.reduce((max, row) => Math.max(max, row.id), 0);
  const result = await (edit === undefined ? window.librium.replay(id) : window.librium.replay(id, edit));
  toast(t('replay.done', {status: result.status}));
  followReplay(before).catch(() => {});
  return result;
}
async function followReplay(before) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const page = await api('traffic-page?q=' + encodeURIComponent(JSON.stringify({rules: [{field: 'id', op: 'gte', value: String(before + 1)}], offset: 0, limit: 1})));
    const found = page?.rows?.[0];
    if (found) { await choose(found.id); return; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
// A request from scratch: the same editor with nothing to copy from; id 0 tells the shell there is no capture.
// The last composed request comes back next time, so a request can be iterated on instead of retyped.
const COMPOSE_KEY = 'librium-last-compose';
function lastCompose() { try { const saved = JSON.parse(localStorage.getItem(COMPOSE_KEY) || 'null'); return saved && typeof saved.url === 'string' && Array.isArray(saved.headers) ? saved : null; } catch { return null; } }
function rememberCompose(edit) { try { localStorage.setItem(COMPOSE_KEY, JSON.stringify({method: edit.method, url: edit.url, headers: edit.headers, body: edit.body ?? ''})); } catch {} }
function openComposeEditor() {
  const last = lastCompose();
  const blank = {summary: {id: 0, method: last?.method || 'GET', url: last?.url || 'https://', status: null}, request: {headers: last ? last.headers : [['accept', '*/*']], size: 0, complete: true, truncated: false, base64: ''}};
  openReplayEditor(blank);
  $('replay-body').disabled = false; $('replay-body').value = last?.body || ''; $('replay-note').textContent = t('compose.curlHint');
  $('replay-url').value = blank.summary.url; $('replay-url').focus(); const caret = $('replay-url').value.length; $('replay-url').setSelectionRange(caret, caret);
}
function openReplayEditor(current) {
  replayTarget = current;
  $('replay-title').textContent = t(current.summary.id ? 'replay.title' : 'compose.title');
  $('replay-method').value = current.summary.method; if ($('replay-method').value !== current.summary.method) $('replay-method').value = 'GET';
  $('replay-url').value = current.summary.url;
  // Hop-by-hop and length headers are set by the sender itself; showing them would only invite stale edits.
  $('replay-headers').value = current.request.headers.filter(([k]) => !/^(host|content-length|connection|proxy-connection|keep-alive|transfer-encoding|te|trailer|upgrade|expect|proxy-authorization)$/i.test(k)).map(([k, v]) => `${k}: ${v}`).join('\n');
  const body = editableBody(current.request);
  $('replay-body').value = body.text; $('replay-body').disabled = !body.editable; $('replay-note').textContent = body.note; $('replay-error').textContent = '';
  $('replay-dialog').showModal(); $('replay-url').focus();
}
$('replay-form').onsubmit = async event => {
  event.preventDefault(); if (!replayTarget) return;
  const headers = [];
  for (const line of $('replay-headers').value.split('\n')) { if (!line.trim()) continue; const at = line.indexOf(':'); if (at <= 0) { $('replay-error').textContent = t('replay.badHeaderLine', {line: line.slice(0, 60)}); return; } headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]); }
  const edit = {method: $('replay-method').value, url: $('replay-url').value.trim(), headers};
  if (!$('replay-body').disabled) edit.body = $('replay-body').value;
  const button = $('replay-form').querySelector('button[type=submit]'); button.disabled = true;
  try { await sendReplay(replayTarget.summary.id, edit); if (!replayTarget.summary.id) rememberCompose(edit); $('replay-dialog').close(); }
  catch (error) { $('replay-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('replay-close').onclick = $('replay-cancel').onclick = () => $('replay-dialog').close();
$('compose').onclick = openComposeEditor;
// A cURL command pasted into the address field fills the whole editor (any dialog mode).
$('replay-url').addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text') || '';
  if (!/^\s*curl(\.exe)?\s/i.test(text)) return;
  const parsed = LibriumCurl.parse(text);
  if (!parsed) return;
  event.preventDefault();
  $('replay-method').value = parsed.method; if ($('replay-method').value !== parsed.method) $('replay-method').value = 'GET';
  $('replay-url').value = parsed.url;
  $('replay-headers').value = parsed.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
  $('replay-body').disabled = false; $('replay-body').value = parsed.body;
  $('replay-note').textContent = t('compose.curlParsed', {count: parsed.headers.length}); $('replay-error').textContent = '';
});
// Ctrl+Enter / ⌘Enter sends from inside the text areas, where Enter is a newline.
$('replay-dialog').addEventListener('keydown', event => { if (event.key === 'Enter' && shortcut(event)) { event.preventDefault(); $('replay-form').requestSubmit(); } });
// Mock editor: prefilled from a recorded exchange (a new mock) or from the list in Settings (editing
// the mock at `mockEditing`), saved into the core's settings.
let mockEditing = null;
function fillMockEditor(mock, note) {
  $('mock-method').value = mock.method || ''; if ($('mock-method').value !== (mock.method || '')) $('mock-method').value = '';
  $('mock-host').value = mock.host; $('mock-path').value = mock.path;
  $('mock-status').value = String(mock.status ?? 200); $('mock-type').value = mock.content_type || '';
  $('mock-body').value = mock.body; $('mock-note').textContent = note; $('mock-error').textContent = '';
  $('mock-dialog').showModal(); $('mock-body').focus();
}
async function openMockEditor(row) {
  const full = detail?.summary.id === row.id ? detail : await api('traffic/' + row.id);
  let host = '', path = '/';
  try { const url = new URL(full.summary.url); host = url.hostname; path = url.pathname; } catch { host = row.host || ''; }
  const body = editableBody(full.response);
  mockEditing = null;
  fillMockEditor({method: full.summary.method, host, path, status: full.summary.status ?? 200, content_type: (full.response.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || full.summary.content_type || '', body: body.text}, body.editable ? t('mock.note') : t('mock.bodyBinary'));
}
function editMock(mock, index) { mockEditing = index; fillMockEditor(mock, t('mock.editing')); }
$('mock-form').onsubmit = async event => {
  event.preventDefault();
  const mock = {host: $('mock-host').value.trim().toLowerCase(), path: $('mock-path').value.trim() || '*', method: $('mock-method').value, status: Number($('mock-status').value), content_type: $('mock-type').value.trim(), body: $('mock-body').value, enabled: true};
  if (!/^[\/*]/.test(mock.path)) { $('mock-error').textContent = t('mock.invalidPath'); return; }
  if (!Number.isInteger(mock.status) || mock.status < 100 || mock.status > 599) { $('mock-error').textContent = t('mock.invalidStatus'); return; }
  if (new TextEncoder().encode(mock.body).length > 1024 * 1024) { $('mock-error').textContent = t('mock.tooLarge'); return; }
  const button = $('mock-form').querySelector('button[type=submit]'); button.disabled = true;
  try {
    const settings = await api('settings'), current = settings?.mocks || [];
    const mocks = mockEditing !== null && mockEditing < current.length ? current.map((item, i) => i === mockEditing ? {...mock, enabled: item.enabled !== false} : item) : [...current, mock];
    await saveSettings({mocks});
    $('mock-dialog').close(); toast(t('mock.saved', {method: mock.method || t('mock.any'), host: mock.host, path: mock.path, status: mock.status}));
    if ($('settings-dialog').open) renderMockList(mocks);
  } catch (error) { $('mock-error').textContent = error.message; }
  finally { button.disabled = false; mockEditing = null; }
};
$('mock-close').onclick = $('mock-cancel').onclick = () => $('mock-dialog').close();
$('mock-dialog').addEventListener('keydown', event => { if (event.key === 'Enter' && shortcut(event)) { event.preventDefault(); $('mock-form').requestSubmit(); } });
function renderMockList(mocks) {
  const list = $('mock-list'); list.replaceChildren();
  if (!mocks.length) { list.append(el('span', t('mock.none'), 'muted')); return; }
  mocks.forEach((mock, index) => {
    const row = el('div', '', 'mock-row'); row.classList.toggle('off', mock.enabled === false);
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = mock.enabled !== false; toggle.title = t('mock.enabledTitle'); toggle.setAttribute('aria-label', t('mock.enabledTitle'));
    toggle.onchange = async () => { toggle.disabled = true; try { const next = mocks.map((item, i) => i === index ? {...item, enabled: toggle.checked} : item); await saveSettings({mocks: next}); renderMockList(next); } catch (error) { showError(error); toggle.checked = !toggle.checked; toggle.disabled = false; } };
    row.append(toggle, el('span', `${mock.method || t('mock.any')} ${mock.host}${mock.path}`, 'mock-where'), el('span', `→ ${mock.status} ${mock.content_type.split(';')[0]} · ${bytes(new TextEncoder().encode(mock.body).length)}`, 'mock-status'));
    const change = el('button', t('mock.edit')); change.type = 'button'; change.onclick = () => editMock(mock, index);
    const remove = el('button', t('mock.delete')); remove.type = 'button';
    remove.onclick = async () => { remove.disabled = true; try { const rest = mocks.filter((_, i) => i !== index); await saveSettings({mocks: rest}); renderMockList(rest); } catch (error) { showError(error); remove.disabled = false; } };
    row.append(change, remove); list.append(row);
  });
}
// Params tab: the query string, plus form fields when the request body is a URL-encoded form.
function formPairs(current) {
  const type = current.request.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  return current.request.complete && !current.request.truncated && !contentEncoding(current.request) ? LibriumParams.formParams(current.request.text, type) : [];
}
function paramPairs(current) { return [...LibriumParams.queryParams(current.summary.url), ...formPairs(current)]; }
// A cookie's value with its attributes appended, so Set-Cookie shows path, domain and flags at a glance.
function cookieValue(item, mode) {
  if (mode !== 'cookies') return item.value;
  const attributes = [item.domain && `Domain=${item.domain}`, item.path && `Path=${item.path}`, item.expires && `Expires=${item.expires}`, item.maxAge && `Max-Age=${item.maxAge}`, item.sameSite && `SameSite=${item.sameSite}`, item.secure && 'Secure', item.httpOnly && 'HttpOnly'].filter(Boolean);
  return attributes.length ? `${item.value}  ·  ${attributes.join('; ')}` : item.value;
}
// Tables of names and values: a click copies the cell (a selection drag still selects).
async function copyText(text) { if (window.librium) await window.librium.copy(text); else await navigator.clipboard.writeText(text); }
function copyOnClick(cell, text) {
  cell.title = t('pane.copy');
  cell.onclick = async () => { if (window.getSelection?.().toString()) return; try { await copyText(text); toast(t('cell.copied', {text: text.length > 60 ? text.slice(0, 57) + '…' : text})); } catch (error) { showError(error); } };
}
// The row menu: narrow the list to what this row shares with others, or act on the row itself.
function addCondition(token) { const box = $('filter'); box.value = LibriumFilters.without(box.value, token) + ' ' + token; box.value = box.value.trim(); renderFilterChips(); filtersChanged(); }
function openRowMenu(row, x, y) {
  const menu = $('row-menu'); menu.replaceChildren();
  const quote = value => /[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
  const url = splitUrl(row.url), host = (() => { try { return new URL(row.url).hostname; } catch { return url.host; } })(), path = url.path.split('?')[0];
  const item = (label, action) => { const button = el('button', label); button.setAttribute('role', 'menuitem'); button.onclick = () => { closeRowMenu(); action(); }; menu.append(button); return button; };
  item(t(row.starred ? 'menu.unstar' : 'menu.star'), () => markRow(row.id, {starred: !row.starred}));
  menu.append(el('hr'));
  item(t('menu.filterHost'), () => addCondition('host:=' + quote(host)));
  item(t('menu.excludeHost'), () => addCondition('-host:=' + quote(host)));
  if (path && path !== '/') item(t('menu.filterPath'), () => addCondition('path:' + quote(path)));
  item(t('menu.interceptHost'), async () => { try { await api('intercept', 'PUT', JSON.stringify({enabled: true, hosts: [host.toLowerCase()], methods: interceptMethods(), path: $('intercept-path').value.trim(), responses: $('intercept-responses').checked})); await refreshIntercept(); toast(t('intercept.hostArmed', {host})); } catch (error) { showError(error); } });
  item(t('menu.ignoreHost'), async () => { try { const settings = await api('settings'); const hosts = [...new Set([...(settings?.ignore_hosts || []), host.toLowerCase()])]; await saveSettings({ignore_hosts: hosts}); toast(t('menu.ignored', {host})); } catch (error) { showError(error); } });
  item(t('menu.filterMethod', {method: row.method}), () => addCondition('method:' + row.method.toLowerCase()));
  if (row.status != null) item(t('menu.filterStatus', {status: row.status}), () => addCondition('status:' + row.status));
  menu.append(el('hr'));
  item(t('menu.copyUrl'), async () => { try { await copyText(row.url); toast(t('inspect.urlCopied')); } catch (error) { showError(error); } });
  if (previousSelected !== null && previousSelected !== row.id) item(t('menu.compare', {id: previousSelected}), () => compareExchanges(previousSelected, row.id).catch(showError));
  if (row.status !== 101) { item(t('menu.copyFetch'), () => copySnippet(row, fetchSnippet)); item(t('menu.copyPython'), () => copySnippet(row, pythonSnippet)); }
  if (row.status !== 101) item(t('menu.copyCurl'), async () => { try { const full = detail?.summary.id === row.id ? detail : await api('traffic/' + row.id); const command = curlCommand(full); await copyText(command.text); toast(t(command.bodyOmitted ? 'pane.curlNoBody' : 'pane.curlCopied')); } catch (error) { showError(error); } });
  if (row.status != null && row.status !== 101) item(t('menu.mock'), () => openMockEditor(row).catch(showError));
  if (window.librium?.replay && row.status !== 101) item(t('menu.resend'), async () => { try { await sendReplay(row.id); } catch (error) { showError(error); } });
  menu.append(el('hr'));
  item(t('menu.delete'), async () => { try { await api('traffic/' + row.id, 'DELETE'); if (selected === row.id) { selected = null; detail = null; detailSignature = ''; renderDetail(); $('selection').replaceChildren(el('span', t('inspect.deleted'))); } toast(t('menu.deleted', {id: row.id})); rowsSignature = ''; await loadPage(); } catch (error) { showError(error); } });
  menu.hidden = false;
  const width = menu.offsetWidth || 200, height = menu.offsetHeight || 200;
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - width - 4)) + 'px'; menu.style.top = Math.max(4, Math.min(y, window.innerHeight - height - 4)) + 'px';
  menu.querySelector('button')?.focus();
}
function closeRowMenu() { $('row-menu').hidden = true; }
// Arrow keys walk the menu like a native one; Home and End jump to its ends.
$('row-menu').addEventListener('keydown', event => {
  const items = [...$('row-menu').querySelectorAll('button')]; if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const target = event.key === 'ArrowDown' ? items[(at + 1) % items.length] : event.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length] : event.key === 'Home' ? items[0] : event.key === 'End' ? items[items.length - 1] : null;
  if (target) { event.preventDefault(); target.focus(); }
});
document.addEventListener('pointerdown', event => { if (!$('row-menu').hidden && !$('row-menu').contains(event.target)) closeRowMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('row-menu').hidden) { closeRowMenu(); event.stopPropagation(); } }, true);
window.addEventListener('blur', closeRowMenu);
// Removes every exchange the current conditions match: the same query the list uses, without paging.
async function deleteMatching() {
  const count = pageMatched;
  if (!count) { toast(t('history.nothingMatching')); return; }
  if (!window.confirm(t('history.confirmDeleteMatching', {count}))) return;
  const query = searchQuery();
  try {
    const result = await api('traffic-page?q=' + encodeURIComponent(JSON.stringify(query)), 'DELETE');
    if (selected !== null) { selected = null; detail = null; detailSignature = ''; renderDetail(); $('selection').replaceChildren(el('span', t('inspect.choose'))); }
    toast(t('history.deletedMatching', {count: result?.deleted ?? count})); rowsSignature = ''; await loadPage();
  } catch (error) { showError(error); }
}
// Line diff of two exchanges: the HTTP view (start line, headers, decoded body) of each side.
function lineDiff(a, b) {
  const limit = 1500; a = a.slice(0, limit); b = b.slice(0, limit);
  const n = a.length, m = b.length, table = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * (m + 1) + j] = a[i] === b[j] ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { out.push(['same', a[i]]); i++; j++; } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) out.push(['del', a[i++]]); else out.push(['add', b[j++]]); }
  while (i < n) out.push(['del', a[i++]]); while (j < m) out.push(['add', b[j++]]);
  return out;
}
async function httpText(current, side) {
  const payload = current[side], body = await bodyText(payload, current.summary.id, side);
  const start = side === 'request' ? `${current.summary.method} ${current.summary.url}` : `${current.summary.version || 'Status:'} ${current.summary.status ?? ''}`;
  return [start, ...payload.headers.map(([k, v]) => `${k}: ${v}`), '', ...body.text.split('\n')];
}
async function compareExchanges(a, b) {
  const [first, second] = await Promise.all([api('traffic/' + a), api('traffic/' + b)]);
  const box = $('diff-body'); box.replaceChildren();
  $('diff-title').textContent = t('diff.title', {a, b});
  for (const side of ['request', 'response']) {
    const lines = lineDiff(await httpText(first, side), await httpText(second, side));
    const added = lines.filter(([kind]) => kind === 'add').length, removed = lines.filter(([kind]) => kind === 'del').length;
    const heading = el('h3', t('diff.' + side)); heading.append(el('span', added || removed ? t('diff.summary', {added, removed}) : t('diff.same')));
    const list = el('div', undefined, 'diff-lines');
    // Unchanged stretches are folded to three lines of context on each side.
    let quiet = 0;
    lines.forEach(([kind, text], index) => {
      if (kind === 'same') { const near = lines.slice(Math.max(0, index - 3), index + 4).some(([k]) => k !== 'same'); if (!near) { quiet++; return; } }
      if (quiet) { list.append(el('div', `… ${quiet}`, 'diff-skip')); quiet = 0; }
      list.append(el('div', text, 'diff-line diff-' + kind));
    });
    if (quiet) list.append(el('div', `… ${quiet}`, 'diff-skip'));
    box.append(heading, list);
  }
  $('diff-dialog').showModal();
}
$('diff-close').onclick = () => $('diff-dialog').close();
async function openRedirect(current, target) {
  const query={query:'',method:'',status:'',offset:0,limit:1000,rules:[{field:'host',op:'eq',value:target.hostname},{field:'path',op:'eq',value:target.pathname+target.search},{field:'id',op:'gte',value:String(current.summary.id+1)}]};
  const page=await api('traffic-page?q='+encodeURIComponent(JSON.stringify(query)));
  if(selected!==current.summary.id)return;
  const match=page.rows.filter(row=>{try{return new URL(row.url).href===target.href;}catch{return false;}}).sort((a,b)=>a.id-b.id)[0];
  if(match)await choose(match.id);else toast(t('redirect.notFound'));
}
async function renderDetail() {
  const version = ++renderVersion;
  if (!detail) {
    for (const [side,node] of Object.entries(paneNodes)) { releaseImage(side); node.audioKey=null; node.content.replaceChildren(el('div', t('pane.empty'), 'empty')); node.state.textContent = ''; node.notice.hidden = true; node.copyText = ''; node.save.hidden = true; if (node.curl) node.curl.hidden = true; if (node.replay) node.replay.hidden = true; if (node.edit) node.edit.hidden = true; }
    return;
  }
  const current = detail;
  const selectionUrl = el('button', current.summary.url, 'selection-url'); selectionUrl.title = t('inspect.copyUrl',{url:current.summary.url});
  selectionUrl.setAttribute('aria-label',t('inspect.copyUrlAria'));
  selectionUrl.onclick=async()=>{try{if(window.librium)await window.librium.copy(current.summary.url);else await navigator.clipboard.writeText(current.summary.url);toast(t('inspect.urlCopied'));}catch(error){showError(error);}};
  const open=el('button','↗','open-url');open.title=t('inspect.openUrl');open.setAttribute('aria-label',t('inspect.openUrlAria'));
  const star=el('button',current.summary.starred?'★':'☆','star-toggle'+(current.summary.starred?' on':''));star.title=t(current.summary.starred?'inspect.unstar':'inspect.star');star.setAttribute('aria-pressed',current.summary.starred?'true':'false');star.onclick=()=>markSelected({starred:!current.summary.starred});
  $('note').hidden=false;if(document.activeElement!==$('note'))$('note').value=current.summary.note||'';
  open.onclick=async()=>{try{const url=new URL(current.summary.url);if(!['http:','https:'].includes(url.protocol))throw Error(t('main.httpOnly'));if(window.librium)await window.librium.openUrl(url.href);else window.open(url.href,'_blank','noopener,noreferrer');}catch(error){showError(error);}};
  $('selection').replaceChildren(el('span', '#' + current.summary.id, 'selection-id'),star,el('span',current.summary.method,'selection-method'),open, selectionUrl, el('span', `${current.summary.time ? stamp(current.summary.time) + ' · ' : ''}${current.summary.version ? current.summary.version + ' · ' : ''}${current.summary.status ?? '…'} · ${current.summary.elapsed_ms ?? '…'} ms`, 'selection-time'));
  let matches = 0;
  await Promise.all(['request','response'].map(async side => {
    const node = paneNodes[side], payload = current[side], mode = modes[side];
    const audioKey=mode==='audio'?`${current.summary.id}:${payload.base64.length}:${payload.complete}:${payload.truncated}`:null;
    if(audioKey && node.audioKey===audioKey)return;
    node.audioKey=null;releaseImage(side);
    const encoding=(payload.headers.find(([k])=>k.toLowerCase()==='content-encoding')?.[1]||'').trim().toLowerCase();
    const decodable=!encoding||['identity','gzip','x-gzip','deflate','br'].includes(encoding);
    node.save.hidden=!(window.librium?.saveMedia && payload.size>0 && payload.complete && !payload.truncated && decodable && current.summary.status!==101);
    // A WebSocket handshake is not something curl or a replay can repeat.
    if(node.curl)node.curl.hidden=current.summary.status===101;
    if(node.replay)node.replay.hidden=!window.librium?.replay || current.summary.status===101;
    if(node.edit)node.edit.hidden=!window.librium?.replay || current.summary.status===101;
    node.tabs.querySelector('[data-mode="ws"]').hidden=current.summary.status!==101;
    node.tabs.querySelector('[data-mode="image"]').hidden=!imageType(payload,current.summary.url);
    node.tabs.querySelector('[data-mode="audio"]').hidden=!audioType(payload,current.summary.url);
    const pairs = side === 'request' ? paramPairs(current) : [];
    const cookies = side === 'request' ? LibriumParams.requestCookies(payload.headers) : LibriumParams.responseCookies(payload.headers);
    node.tabs.querySelector('[data-mode="params"]').hidden = side !== 'request' || !pairs.length;
    node.tabs.querySelector('[data-mode="cookies"]').hidden = !cookies.length;
    const decoded = ['headers','hex','image','audio','ws','params','cookies'].includes(mode) ? {text:'',notice:''} : await bodyText(payload, current.summary.id, side);
    if (version !== renderVersion) return;
    node.tabs.querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
    node.state.textContent = current.summary.status===101?'WebSocket · '+t(wsData?.state==='open'?'ws.open':wsData?.state==='closed'?'ws.closed':'ws.archived'):`${bytes(payload.size)}${payload.complete ? '' : ' · '+t('pane.streaming')}`;
    const notices = [current.summary.status===101?null:coreText(current.summary.error), mode === 'hex' && payload.base64.length > 87384 ? t('body.hexLimit') : '', payload.truncated && payload.complete ? t('body.truncated') : '', decoded.notice].filter(Boolean);
    node.notice.hidden = !notices.length; node.notice.textContent = notices.join(' · ');
    if(side==='response' && [301,302,303,307,308].includes(current.summary.status)) {
      const location=payload.headers.find(([k])=>k.toLowerCase()==='location')?.[1];
      if(location)try{const target=new URL(location,current.summary.url);if(['http:','https:'].includes(target.protocol)){
        const follow=el('button',t('redirect.open'),'redirect-open');follow.onclick=()=>openRedirect(current,target).catch(showError);
        node.notice.hidden=false;node.notice.append(el('span',t('redirect.notice',{status:current.summary.status,url:target.href})),follow);
      }}catch{}
    }
    let text = decoded.text, type = '';
    if (mode === 'http') { const version = current.summary.version || ''; text = (side === 'request' ? `${current.summary.method} ${current.summary.url}${version ? ' ' + version : ''}` : `${version || 'Status:'} ${current.summary.status ?? t('toolbar.pending')}`) + '\n' + payload.headers.map(([k,v]) => `${k}: ${v}`).join('\n') + '\n\n' + decoded.text; type = 'http'; }
    let tree = null;
    if (mode === 'pretty') { try { const parsed = JSON.parse(decoded.text); text = JSON.stringify(parsed,null,2); type = 'json'; if (!$('find').value && parsed !== null && typeof parsed === 'object') tree = jsonTree(parsed); } catch { /* Plain text and HTML remain inert text. */ } }
    if (mode === 'hex') text = hexView(payload.base64);
    const scroll = node.content.scrollTop, left = node.content.scrollLeft;
    if(mode==='ws') {
      const messages=(wsData?.messages||[]).filter(m=>m.direction===(side==='request'?'sent':'received'));
      text=messages.map(m=>`[${new Date(m.time).toLocaleTimeString(LibriumI18n.locale)}.${String(m.time%1000).padStart(3,'0')}] ${m.direction==='sent'?'→':'←'} ${m.kind} · ${bytes(m.size)}${m.truncated?t('body.first64'):''}\n${m.kind==='BINARY'?hexView(m.base64):m.text}`).join('\n\n');
      node.content.replaceChildren(text?codeLines(text,''):el('div',t(wsData?.state==='not_recorded'?'ws.notRecorded':'ws.noMessages'),'empty'));
      node.notice.hidden=false;node.notice.textContent=t('ws.total',{count:wsData?.total||0})+(wsData?.error?' · '+coreText(wsData.error):'')+' ';
      if(wsData?.older){const older=el('button',t('ws.older'));older.onclick=()=>{wsBefore=wsData.messages[0].id;loadWs().catch(showError);};node.notice.append(older);}
      if(wsBefore){const live=el('button',t('page.live'));live.onclick=()=>{wsBefore=null;loadWs().catch(showError);};node.notice.append(live);}
    } else if (mode === 'image' || mode === 'audio') {
      const mime=mode==='audio'?audioType(payload,current.summary.url):imageType(payload,current.summary.url);
      if(!mime || payload.truncated || !payload.complete) {
        node.content.replaceChildren(el('div',t(payload.truncated?'media.partial':!payload.complete?'media.loading':'media.unsupported'),'empty'));
      } else {
        try {
          const encoding=contentEncoding(payload);
          const raw=encoding&&encoding!=='identity'?await inflate(payload,encoding,current.summary.id,side,32*1024*1024):Uint8Array.from(atob(payload.base64),c=>c.charCodeAt(0));
          if(version!==renderVersion)return;
          const download=el('button',t('media.download'),'media-download');
          download.onclick=async()=>{try{if(window.librium){if(await window.librium.saveMedia(current.summary.id,side))toast(t('media.saved'));}else{const a=el('a');a.href=imageUrls[side];a.download=decodeURIComponent(new URL(current.summary.url).pathname.split('/').pop())||'media';a.click();}}catch(error){showError(error);}};
          if(mode==='audio') {
            const player=el('audio'), info=el('div',`${mime} · ${bytes(payload.size)}`,'image-info'), box=el('div',undefined,'audio-preview');
            player.controls=true;player.preload='metadata';player.setAttribute('aria-label',t('media.audioAria'));
            player.onerror=()=>{info.textContent=t('media.audioFailed');};
            box.append(player,info,download);node.content.replaceChildren(box);
            imageUrls[side]=URL.createObjectURL(new Blob([raw],{type:mime}));player.src=imageUrls[side];node.audioKey=audioKey;
          } else {
          const img=el('img'), info=el('div',t('inspect.loading'),'image-info'), tools=el('div',undefined,'image-tools'), zoom=el('button',t('media.actualSize'));
          img.alt=t('media.imageAlt',{url:current.summary.url});
          img.onload=()=>{info.textContent=`${img.naturalWidth} × ${img.naturalHeight} · ${bytes(payload.size)}`;};
          img.onerror=()=>{info.textContent=t('media.imageFailed');};
          const box=el('div',undefined,'image-preview');box.append(img);
          img.draggable=false;let drag=null;
          box.onpointerdown=event=>{if(!box.classList.contains('actual-size')||event.button!==0)return;drag={x:event.clientX,y:event.clientY,left:node.content.scrollLeft,top:node.content.scrollTop,pointer:event.pointerId};box.setPointerCapture(event.pointerId);box.classList.add('dragging');event.preventDefault();};
          box.onpointermove=event=>{if(!drag||event.pointerId!==drag.pointer)return;node.content.scrollLeft=drag.left-(event.clientX-drag.x);node.content.scrollTop=drag.top-(event.clientY-drag.y);event.preventDefault();};
          const stopDrag=()=>{drag=null;box.classList.remove('dragging');};
          box.onpointerup=event=>{if(box.hasPointerCapture(event.pointerId))box.releasePointerCapture(event.pointerId);stopDrag();};box.onpointercancel=stopDrag;box.onlostpointercapture=stopDrag;

          zoom.onclick=()=>{const actual=box.classList.toggle('actual-size');zoom.textContent=t(actual?'media.fit':'media.actualSize');if(!actual){node.content.scrollTop=0;node.content.scrollLeft=0;stopDrag();}};
          tools.append(info,zoom,download);node.content.replaceChildren(tools,box);
          imageUrls[side]=URL.createObjectURL(new Blob([raw],{type:mime}));img.src=imageUrls[side];
          }
        } catch(error) {node.content.replaceChildren(el('div',error.message,'empty'));}
      }
    } else if (mode === 'params' || mode === 'cookies') {
      // Name/value tables, grouped: query and form fields, or the cookies sent and set.
      const groups = mode === 'params'
        ? [[t('params.query'), LibriumParams.queryParams(current.summary.url)], [t('params.form'), formPairs(current)]]
        : side === 'request' ? [[t('cookies.sent'), cookies]] : [[t('cookies.set'), cookies]];
      const box = el('div', undefined, 'pairs'); text = '';
      for (const [title, list] of groups) {
        if (!list.length) continue;
        box.append(el('h3', title, 'pairs-title'));
        const table = el('table', undefined, 'headers-table');
        for (const item of list) {
          const row = el('tr'), k = el('td'), v = el('td'); k.append(highlighted(item.name)); v.append(highlighted(cookieValue(item, mode))); copyOnClick(k, item.name); copyOnClick(v, item.value); row.append(k, v); table.append(row);
          text += `${item.name}=${cookieValue(item, mode)}\n`;
        }
        box.append(table);
      }
      node.content.replaceChildren(box.children.length ? box : el('div', t(mode === 'params' ? 'params.none' : 'cookies.none'), 'empty'));
    } else if (mode === 'headers') {
      const table = el('table', undefined, 'headers-table');
      for (const [key,value] of payload.headers) { const row = el('tr'), k = el('td'), v = el('td'); k.append(highlighted(key)); v.append(highlighted(value)); copyOnClick(k, key); copyOnClick(v, value); row.append(k,v); table.append(row); }
      text = payload.headers.map(([k,v]) => `${k}: ${v}`).join('\n'); node.content.replaceChildren(payload.headers.length ? table : el('div', t('pane.noHeaders'), 'empty'));
    } else if (tree) node.content.replaceChildren(tree);
    else node.content.replaceChildren(text ? codeLines(text,type) : el('div', t(payload.complete ? 'pane.noBody' : 'pane.waitingData'), 'empty'));
    node.copyText = text;
    node.content.scrollTop = scroll; node.content.scrollLeft = left;
    const query = $('find').value.toLowerCase(); if (query) matches += text.toLowerCase().split(query).length-1;
  }));
  if (version === renderVersion) $('matches').textContent = $('find').value ? t(matches===1?'inspect.match':'inspect.matches',{count:matches}) : '';
}
async function loadWs(){
 if(selected===null||detail?.summary.status!==101)return;
 const id=selected,cursor=wsBefore;
 const data=await api(`traffic/${id}/ws`+(cursor?`?before=${cursor}`:''));
 if(selected!==id||cursor!==wsBefore)return;
 const signature=JSON.stringify(data);if(signature!==wsSignature){wsData=data;wsSignature=signature;await renderDetail();}
}
async function loadDetail() {
  $('note').hidden = selected === null;
  if (selected === null) return;
  const id = selected;
  // `finished` comes from the core: an error on one side does not stop the other from streaming.
  if(detail?.summary.id===id && detail.summary.finished)return;
  try { const data = await api('traffic/' + id); if (selected !== id) return; const signature = JSON.stringify(data); if (signature !== detailSignature) { if(!detail){modes.request=data.summary.status===101?'ws':preferredModes.request;modes.response=data.summary.status===101?'ws':imageType(data.response,data.summary.url)?'image':audioType(data.response,data.summary.url)?'audio':preferredModes.response;} detail = data; detailSignature = signature; await renderDetail(); } }
  catch (error) { if (selected !== id) return; if (error.message.includes('404')) { detail = null; detailSignature = ''; await renderDetail(); $('selection').replaceChildren(el('span',t('inspect.deleted'))); } else throw error; }
}
async function choose(id) {
  if (id === selected) return;
  previousSelected = selected; selected = id; wsData=null;wsBefore=null;wsSignature="";detail = null; detailSignature = ''; renderSelection(); await renderDetail();
  $('selection').replaceChildren(el('span','#'+id,'selection-id'),el('span',t('inspect.loading')));
  try { await loadDetail(); await loadWs(); } catch(error) { showError(error); }
}
let lastRevision = null;
// Recording on/off lives in the core (in memory, on after a restart); the button mirrors the state poll.
let recordingOn=true;
function renderRecord(enabled){recordingOn=enabled;if(polled)renderConnection();const button=$('record');button.classList.toggle('off',!enabled);button.setAttribute('aria-pressed',enabled?'true':'false');button.textContent=t(enabled?'toolbar.record':'toolbar.recordOff');}
$('record').onclick=async()=>{try{await api('recording','PUT',JSON.stringify({enabled:!recordingOn}));renderRecord(!recordingOn);toast(t(recordingOn?'toolbar.recordOn':'toolbar.recordOffToast'));}catch(error){showError(error);}};
// Rules that change traffic (mocks, delays, header rewrites) are easy to forget: the header says when any is on.
function renderTweaks(tweaks) {
  const pill = $('tweaks');
  const parts = [];
  if (tweaks?.mocks) parts.push(t('tweaks.mocks', {count: tweaks.mocks}));
  if (tweaks?.delays) parts.push(t('tweaks.delays', {count: tweaks.delays}));
  if (tweaks?.rewrites) parts.push(t('tweaks.rewrites', {count: tweaks.rewrites}));
  pill.hidden = !parts.length; pill.textContent = parts.join(' · ');
}
$('tweaks').onclick = () => $('settings-open').click();
// The status line: a storage failure first, then paused / recording off / connected.
let lastStorage = null, polled = false;
function renderConnection() {
  if (lastStorage) { $('connection').textContent = t('header.storageError'); $('dot').classList.remove('live'); $('dot').classList.remove('off'); return; }
  $('connection').textContent = t(paused ? 'header.paused' : recordingOn ? 'header.connected' : 'header.notRecording');
  $('dot').classList.toggle('live', !paused && recordingOn); $('dot').classList.toggle('off', !recordingOn);
}
async function refresh() {
  try {
    // One number per second, even while paused, so a failing store is reported; the page, the
    // detail and the socket messages are fetched only when the history changed.
    let storage = null, revision = null;
    try { const state = await api('state'); revision = state.revision; storage = state.error || null; renderTweaks(state.tweaks);if(typeof state.recording==='boolean'&&state.recording!==recordingOn)renderRecord(state.recording); if (Number.isFinite(state.held) && (state.held !== heldCount || state.held > 0)) refreshIntercept().catch(() => {}); if (Number.isFinite(state.disk)) document.querySelector('.history-foot .disk').textContent = t('foot.diskSize', {size: bytes(state.disk)}); } catch (error) { if (!String(error.message).includes('404')) throw error; }
    if (!paused && (revision === null || revision !== lastRevision)) { await loadPage(); await loadDetail(); await loadWs(); lastRevision = revision; }
    lastStorage = storage; polled = true; renderConnection();
    if (storage) showError(Error(t('header.storageDetail', {error: storage}))); else showError(null);
  } catch(error) { $('connection').textContent = t('header.offline'); $('dot').classList.remove('live'); showError(error); }
  finally { setTimeout(refresh, 1000); }
}
function resetFilters(){filterRules=[];for(const id of ['filter','method','status','traffic-type'])$(id).value='';renderFilterChips();filtersChanged();}
function renderFilterChips(){
  const box=$('filter-chips');box.replaceChildren();
  const add=(label,remove)=>{const button=el('button',label+' ×','filter-chip');button.title=t('chip.remove');button.onclick=()=>{remove();renderFilterChips();filtersChanged();};box.append(button);};
  const parsed=LibriumFilters.parse($('filter').value);
  if(parsed.text)add(t('chip.search',{value:parsed.text}),()=>{$('filter').value=parsed.conditions.map(c=>c.raw).join(' ');});
  for(const condition of parsed.conditions)add(condition.raw,()=>{$('filter').value=LibriumFilters.without($('filter').value,condition.raw);});
  if($('traffic-type').value)add(t('chip.type',{value:$('traffic-type').selectedOptions[0].textContent}),()=>{$('traffic-type').value='';});
  if($('method').value)add(t('chip.method',{value:$('method').value}),()=>{$('method').value='';});
  if($('status').value)add(t('chip.status',{value:$('status').selectedOptions[0].textContent}),()=>{$('status').value='';});
  filterRules.forEach((rule,index)=>add(LibriumFilters.label(rule),()=>filterRules.splice(index,1)));
  box.hidden=!box.children.length;
  if(box.children.length){box.prepend(el('span',t('chip.all')));const reset=el('button',t('chip.reset'),'quiet');reset.onclick=resetFilters;box.append(reset);
    const purge=el('button',t('chip.deleteMatching'),'quiet delete-matching');purge.onclick=deleteMatching;box.append(purge);}
}
for (const id of ['filter','method','status','traffic-type']) $(id).addEventListener('input', ()=>{renderFilterChips();filtersChanged();});
for(const [key,label] of Object.entries(LibriumFilters.fields)){const option=el('option',label);option.value=key;$('rule-field').append(option);}
function ruleOperators(){const field=$('rule-field').value,numeric=LibriumFilters.numeric(field);$('rule-op').replaceChildren();for(const key of numeric?['eq','gte','lte','ne']:field==='frame'?['contains','not_contains']:['contains','not_contains','eq','ne']){const option=el('option',LibriumFilters.operators[key]);option.value=key;$('rule-op').append(option);}$('rule-value').type=numeric?'number':'text';$('rule-value').value='';$('rule-value').placeholder=t(numeric?'filters.valueNumber':'filters.valuePlaceholder');$('rule-error').textContent='';}
$('rule-field').onchange=ruleOperators;ruleOperators();
// Ignored hosts live in the core's settings; the dialog shows the current list and saves it as a whole.
async function saveSettings(value){if(window.librium?.saveSettings)return window.librium.saveSettings(value);const response=await fetch('/api/settings',{method:'PUT',headers:{'x-librium-token':token,'content-type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error(`API: ${response.status}`);}
const rewriteLines=rules=>(rules||[]).map(rule=>`${rule.host}${rule.path&&rule.path!=='*'?rule.path:''} ${rule.name}: ${rule.value}`).join('\n');
async function loadIgnoredHosts(){try{const settings=await api('settings');$('ignore-hosts').value=(settings?.ignore_hosts||[]).join('\n');$('rewrite-rules').value=rewriteLines(settings?.rewrites);$('response-rewrite-rules').value=rewriteLines(settings?.response_rewrites);$('delay-rules').value=delayLines(settings?.delays);renderMockList(settings?.mocks||[]);for(const id of ['ignore-state','rewrite-state','response-rewrite-state','delay-state'])$(id).textContent='';}catch(error){$('ignore-state').textContent=error.message;$('rewrite-state').textContent=error.message;}}
// One rewrite per line: `host Header-Name: value`; the core validates names and values again.
const REWRITE_LINE=/^(\S+)\s+([A-Za-z0-9!#$%&'*+.^_`|~-]+):\s*(.*)$/;
// The same editor serves request and response rewrites; `key` is the settings field it saves.
function wireRewrites(prefix,key){
  const rulesBox=$(prefix+'-rules'),state=$(prefix+'-state'),save=$(prefix+'-save');
  save.onclick=async()=>{
    const rules=[];
    for(const line of rulesBox.value.split('\n').map(text=>text.trim()).filter(Boolean)){
      const m=REWRITE_LINE.exec(line);
      // The first token is a host pattern, optionally followed by a path pattern: api.example.com/v1/*
      const slash=m?m[1].indexOf('/'):-1,host=slash<0?m?.[1]:m[1].slice(0,slash),path=slash<0?'*':m[1].slice(slash);
      if(!m||!/^[a-z0-9.\-*:]{1,253}$/i.test(host)){state.textContent=t('rewrite.invalid',{line});return;}
      rules.push({host:host.toLowerCase(),name:m[2].toLowerCase(),value:m[3].trim(),path});
    }
    save.disabled=true;
    try{await saveSettings({[key]:rules});rulesBox.value=rewriteLines(rules);state.textContent=t('rewrite.saved',{count:rules.length});}
    catch(error){state.textContent=error.message;}
    finally{save.disabled=false;}
  };
}
wireRewrites('rewrite','rewrites');wireRewrites('response-rewrite','response_rewrites');
// Delays: `host milliseconds`, one per line.
const delayLines=rules=>(rules||[]).map(rule=>`${rule.host}${rule.path&&rule.path!=='*'?rule.path:''} ${rule.ms}`).join('\n');
$('delay-save').onclick=async()=>{
  const rules=[];
  for(const line of $('delay-rules').value.split('\n').map(text=>text.trim()).filter(Boolean)){
    const m=/^(\S+)\s+(\d{1,5})$/.exec(line),ms=m?Number(m[2]):0;
    const slash=m?m[1].indexOf('/'):-1,host=slash<0?m?.[1]:m[1].slice(0,slash),path=slash<0?'*':m[1].slice(slash);
    if(!m||!/^[a-z0-9.\-*:]{1,253}$/i.test(host)||ms<1||ms>60000){$('delay-state').textContent=t('delay.invalid',{line});return;}
    rules.push({host:host.toLowerCase(),ms,path});
  }
  $('delay-save').disabled=true;
  try{await saveSettings({delays:rules});$('delay-rules').value=delayLines(rules);$('delay-state').textContent=t('delay.saved',{count:rules.length});}
  catch(error){$('delay-state').textContent=error.message;}
  finally{$('delay-save').disabled=false;}
};
$('ignore-save').onclick=async()=>{
  const patterns=[...new Set($('ignore-hosts').value.split('\n').map(line=>line.trim().toLowerCase()).filter(Boolean))];
  const bad=patterns.find(pattern=>!/^[a-z0-9.\-*:]{1,253}$/.test(pattern));
  if(bad){$('ignore-state').textContent=t('ignore.invalid',{pattern:bad});return;}
  $('ignore-save').disabled=true;
  try{await saveSettings({ignore_hosts:patterns});$('ignore-hosts').value=patterns.join('\n');$('ignore-state').textContent=t('ignore.saved',{count:patterns.length});}
  catch(error){$('ignore-state').textContent=error.message;}
  finally{$('ignore-save').disabled=false;}
};
// The redaction choice for HAR exports is remembered; masking is the default.
try{$('export-redact').checked=localStorage.getItem('librium-export-redact')!=='0';}catch{}
$('export-redact').onchange=()=>{try{localStorage.setItem('librium-export-redact',$('export-redact').checked?'1':'0');}catch{}};
$('filters-open').onclick=()=>{$('filters-dialog').showModal();$('rule-value').focus();};$('filters-close').onclick=()=>$('filters-dialog').close();
// The help dialog is built from the same strings the suggestions use, so it never drifts from them.
function renderHelp(){
  const mod=platform==='darwin'?'⌘':'Ctrl';
  const keys=[[`${mod} K`,t('help.kSearch')],[`${mod} F`,t('help.kFind')],[`${mod} I`,t('help.kIntercept')],[`${mod} D`,t('help.kStar')],[`${mod} N`,t('help.kNew')],[`${mod} ⇧ M`,t('help.kMock')],['↑ ↓',t('help.kRows')],['Esc',t('help.kEsc')],[`${mod} Enter`,t('help.kEnter')],[`${mod} ] [`,t('help.kHeld')],['?',t('help.kHelp')]];
  const table=$('help-keys');table.replaceChildren();
  for(const [key,what] of keys){const tr=el('tr');const kbd=el('kbd',key);const th=el('th');th.append(kbd);tr.append(th,el('td',what));table.append(tr);}
  const syntax=$('help-syntax');syntax.replaceChildren();
  for(const field of ['host','path','url','method','status','type','size','elapsed','is','since','until','body','header','frame','note','id']){const tr=el('tr');tr.append(el('th',field+':'),el('td',t('hint.'+field)));syntax.append(tr);}
}
$('help-open').onclick=()=>{renderHelp();$('help-dialog').showModal();};$('help-close').onclick=()=>$('help-dialog').close();
document.addEventListener('keydown',event=>{if(event.key!=='?'||event.ctrlKey||event.metaKey||event.altKey)return;const tag=document.activeElement?.tagName;if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||document.activeElement?.isContentEditable)return;if($('help-dialog').open)return;event.preventDefault();$('help-open').click();});
$('settings-open').onclick=()=>{$('settings-dialog').showModal();loadIgnoredHosts();};$('settings-close').onclick=()=>$('settings-dialog').close();
function addRule(rule){const error=LibriumFilters.validate(rule);$('rule-error').textContent=error;if(error)return;if(!filterRules.some(r=>JSON.stringify(r)===JSON.stringify(rule)))filterRules.push(rule);renderFilterChips();filtersChanged();$('filters-dialog').close();}
$('filter-form').onsubmit=event=>{event.preventDefault();addRule({field:$('rule-field').value,op:$('rule-op').value,value:$('rule-value').value.trim()});};
document.querySelectorAll('[data-preset]').forEach(button=>button.onclick=()=>{const kind=button.dataset.preset;if(kind==='errors')addRule({field:'status',op:'gte',value:'400'});else if(kind==='post')addRule({field:'method',op:'eq',value:'POST'});else if(kind==='starred'){addCondition('is:starred');$('filters-dialog').close();}else{const url=detail?.summary.id===selected?detail.summary.url:rows.find(r=>r.id===selected)?.url;let hostname='';try{hostname=new URL(url).hostname;}catch{}if(!hostname){$('rule-error').textContent=t('filters.pickFirst');return;}addRule({field:'host',op:'eq',value:hostname});}});
$('page-next').onclick=()=>{if(pageAnchor===null)pageAnchor=pageNewest;pageOffset+=PAGE_SIZE;loadPage().catch(showError);};
$('page-prev').onclick=()=>{pageOffset=Math.max(0,pageOffset-PAGE_SIZE);if(pageOffset===0)pageAnchor=null;loadPage().catch(showError);};
$('page-live').onclick=()=>{pageOffset=0;pageAnchor=null;loadPage().catch(showError);};
let following=false;try{following=localStorage.getItem('librium-follow')==='1';}catch{}
function renderFollow(){$('follow').classList.toggle('active',following);$('follow').setAttribute('aria-pressed',String(following));}
renderFollow();
$('follow').onclick=()=>{following=!following;renderFollow();try{localStorage.setItem('librium-follow',following?'1':'0');}catch{}if(following){pageOffset=0;pageAnchor=null;rowsSignature='';loadPage().catch(showError);}};
$('find').oninput = renderDetail;
$('pause').onclick = () => { paused = !paused; $('pause').textContent = t(paused ? 'toolbar.resume' : 'toolbar.pause'); $('pause').classList.toggle('active',paused); };
$('clear').onclick = async () => { if(!window.confirm(t('history.confirmClear')))return; try { await api('traffic','DELETE'); ++listGeneration; pageOffset=0;pageAnchor=null;pageTotal=0;pageMatched=0; rows = []; selected = null; detail = null; detailSignature = ''; rowsSignature = ''; renderRows(); renderDetail(); $('selection').replaceChildren(el('span',t('history.cleared'))); } catch(error) { showError(error); } };
$('export').hidden=!window.librium?.exportHar;
$('import').hidden=!window.librium?.importHar;$('compose').hidden=!window.librium?.replay;
for(const id of ['rules-export','rules-import'])$(id).hidden=!window.librium?.exportRules;
$('rules-export').onclick=async()=>{$('rules-state').textContent='';try{const file=await window.librium.exportRules();if(file)$('rules-state').textContent=t('settings.rulesExported',{file});}catch(error){$('rules-state').textContent=error.message;}};
async function importRules(file){
  $('rules-state').textContent='';
  try{const keys=await window.librium.importRules(file);if(keys){const text=t('settings.rulesImported',{keys:keys.join(', ')});$('rules-state').textContent=text;toast(text);await loadIgnoredHosts();}}
  catch(error){$('rules-state').textContent=error.message;if(file)showError(error);}
}
$('rules-import').onclick=()=>importRules();
// A dropped .json is a rules file when it says so; anything else with .har/.json goes to the HAR import.
async function isRulesFile(file){if(!/\.json$/i.test(file.name)||typeof file.slice!=='function')return false;try{const head=await file.slice(0,4096).text();return /"librium_rules"/.test(head);}catch{return false;}}
// The search the API sees for the box, the quick filters and the builder rules: bulk delete and the summary share it.
function searchQuery(){const parsed=LibriumFilters.parse($('filter').value);return {query:parsed.text,method:$('method').value,status:$('status').value,rules:activeRules(parsed),traffic_type:$('traffic-type').value};}
// The summary dialog: totals, latency percentiles, status classes, methods and the busiest hosts of the current search.
async function openStats(){
  const dialog=$('stats-dialog'),body=$('stats-body'),query=searchQuery();
  const filtered=Object.values(query).some(value=>Array.isArray(value)?value.length:value);
  $('stats-scope').textContent=t(filtered?'stats.scopeFiltered':'stats.scopeAll')+' '+t('stats.clickHint');
  body.replaceChildren(el('p',t('stats.loading'),'muted'));dialog.showModal();
  let stats;
  try{stats=await api('traffic-stats?q='+encodeURIComponent(JSON.stringify(query)));}catch(error){body.replaceChildren(el('p',error.message,'muted'));return;}
  if(!dialog.open)return;
  body.replaceChildren();
  if(!stats.matched){body.append(el('p',t('stats.empty'),'muted'));return;}
  const ms=value=>value==null?'—':value>=10000?`${(value/1000).toFixed(1)} s`:`${value} ms`;
  const share=(part,of)=>of?` · ${Math.round(part/of*100)}%`:'';
  const cards=el('div',undefined,'stats-cards');
  const card=(label,value)=>{const box=el('div',undefined,'stats-card');box.append(el('b',value),el('span',label));cards.append(box);};
  card(t('stats.requests'),String(stats.matched));card(t('stats.errors'),stats.errors+share(stats.errors,stats.matched));card(t('stats.pending'),String(stats.pending));if(stats.mocked)card(t('stats.mocked'),String(stats.mocked));card(t('stats.bytes'),bytes(stats.bytes));
  card(t('stats.p50'),ms(stats.elapsed.p50));card(t('stats.p95'),ms(stats.elapsed.p95));card(t('stats.max'),ms(stats.elapsed.max));
  body.append(cards);
  const line=(label,items)=>{if(!items.length)return;const p=el('p',undefined,'stats-line');p.append(el('span',label+': '));for(const [name,count,token] of items){const code=el('code',name+' ');code.append(el('b',String(count)));code.onclick=()=>{dialog.close();addCondition(token);};p.append(code);}body.append(p);};
  line(t('stats.classes'),stats.classes.map(c=>[c.class+'xx',c.count,`status:${c.class}xx`]));
  line(t('stats.methods'),stats.methods.map(m=>[String(m.method).toUpperCase(),m.count,`method:${String(m.method).toLowerCase()}`]));
  if(stats.hosts.length){
    const table=el('table',undefined,'stats-table'),head=el('tr');
    for(const [key,cls] of [['stats.host',''],['stats.requests','num'],['stats.errors','num'],['stats.bytes','num'],['stats.avg','num'],['stats.max','num']])head.append(el('th',t(key),cls));
    table.append(head);
    for(const host of stats.hosts){
      const tr=el('tr');tr.dataset.host=host.host;
      tr.append(el('td',host.host),el('td',String(host.count),'num'),el('td',String(host.errors),'num'+(host.errors?' bad':'')),el('td',bytes(host.bytes),'num'),el('td',ms(host.elapsed_avg),'num'),el('td',ms(host.elapsed_max),'num'));
      tr.onclick=()=>{dialog.close();addCondition('host:='+(/[\s"]/.test(host.host)?`"${host.host}"`:host.host));};
      table.append(tr);
    }
    body.append(el('p',t('stats.hosts'),'stats-line'),table);
  }
}
$('stats-open').onclick=()=>openStats().catch(showError);$('stats-close').onclick=()=>$('stats-dialog').close();
// Intercept: matching requests wait in the core until they are forwarded (with edits) or dropped.
let interceptOn=false,heldCount=0,heldShown=null,heldWanted=null,heldNotified=0,interceptSaving=false,heldIds=[];
function renderInterceptButton(){const button=$('intercept');button.classList.toggle('active',interceptOn);button.setAttribute('aria-pressed',interceptOn?'true':'false');button.textContent=t('toolbar.intercept')+(heldCount?` ${heldCount}`:'');}
const interceptHosts=()=>$('intercept-hosts').value.split(/[,\s]+/).map(host=>host.trim().toLowerCase()).filter(Boolean);
const interceptMethods=()=>$('intercept-methods').value.split(/[,\s]+/).map(method=>method.trim().toUpperCase()).filter(Boolean);
const INTERCEPT_INPUTS=['intercept-hosts','intercept-methods','intercept-path'];
async function refreshIntercept(){
  const state=await api('intercept');
  interceptOn=!!state.enabled;heldCount=state.held.length;renderInterceptButton();
  if(heldCount!==heldNotified){heldNotified=heldCount;window.librium?.heldCount?.(heldCount).catch(()=>{});}
  // While a rule change is on its way, the poll must not paint the old rules over the user's click.
  if(!interceptSaving){
    const fill=(id,value)=>{if(document.activeElement!==$(id))$(id).value=value;};
    fill('intercept-hosts',(state.hosts||[]).join(', '));fill('intercept-methods',(state.methods||[]).join(', '));fill('intercept-path',state.path||'');
    $('intercept-responses').checked=!!state.responses;
  }
  const panel=$('intercept-panel'),held=state.held.find(item=>item.id===heldWanted)||state.held[0];
  panel.hidden=!interceptOn&&!held;
  $('intercept-count').textContent=t('intercept.title',{count:heldCount});
  $('intercept-editor').hidden=!held;$('intercept-waiting').hidden=!!held;
  heldIds=state.held.map(item=>item.id);renderInterceptQueue(state.held,held);
  if(!held){heldShown=null;heldWanted=null;return;}
  if(heldShown===held.id)return;
  heldShown=held.id;
  panel.classList.remove('collapsed');renderInterceptCollapse();
  const response=held.kind==='response';
  $('intercept-kind').textContent=t(response?'intercept.kindResponse':'intercept.kindRequest');
  $('intercept-method').hidden=response;$('intercept-status').hidden=!response;$('intercept-url').readOnly=response;$('intercept-mock').hidden=!response;
  $('intercept-status').value=response?String(held.status??''):'';
  $('intercept-method').value=held.method;$('intercept-url').value=held.url;
  $('intercept-headers').value=held.headers.map(([name,value])=>`${name}: ${value}`).join('\n');
  const kept=held.truncated||/\uFFFD/.test(held.text);
  $('intercept-body').value=kept?'':held.text;$('intercept-body').disabled=kept;$('intercept-body').dataset.original=kept?'':held.text;
  $('intercept-note').textContent=kept&&held.size?t('intercept.bodyKept',{size:bytes(held.size)}):held.decoded?t('intercept.decoded'):'';
}
// With several requests held the queue lets you pick which one to look at; alone, it stays hidden.
function renderInterceptQueue(list,current){
  const queue=$('intercept-queue');queue.hidden=list.length<2;queue.replaceChildren();
  if(list.length<2)return;
  for(const item of list){
    const button=document.createElement('button');button.type='button';button.setAttribute('role','tab');
    const same=current&&item.id===current.id;button.classList.toggle('current',same);button.setAttribute('aria-selected',same?'true':'false');
    let where=item.url;try{const u=new URL(item.url);where=u.host+u.pathname;}catch{}
    button.textContent=`${item.kind==='response'?'←':'→'} ${item.method} ${where}`;button.title=item.url;
    button.onclick=()=>{heldWanted=item.id;heldShown=null;refreshIntercept().catch(showError);};
    queue.append(button);
  }
}
function renderInterceptCollapse(){const collapsed=$('intercept-panel').classList.contains('collapsed');$('intercept-collapse').textContent=collapsed?'+':'–';$('intercept-collapse').title=t(collapsed?'intercept.expand':'intercept.collapse');}
$('intercept-collapse').onclick=()=>{$('intercept-panel').classList.toggle('collapsed');renderInterceptCollapse();};
const interceptRules=enabled=>JSON.stringify({enabled,hosts:interceptHosts(),methods:interceptMethods(),path:$('intercept-path').value.trim(),responses:$('intercept-responses').checked});
async function decideShown(action){
  if(heldShown===null)return;
  const decision={action};
  if(action==='forward'){
    if($('intercept-status').hidden){decision.method=$('intercept-method').value.trim();decision.url=$('intercept-url').value.trim();}
    else if($('intercept-status').value.trim())decision.status=Number($('intercept-status').value);
    decision.headers=$('intercept-headers').value.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{const at=line.indexOf(':');return at<0?[line,'']:[line.slice(0,at).trim(),line.slice(at+1).trim()];});
    if(!$('intercept-body').disabled&&$('intercept-body').value!==$('intercept-body').dataset.original)decision.text=$('intercept-body').value;
  }
  try{await api('intercept/'+heldShown,'POST',JSON.stringify(decision));}
  catch(error){if(!String(error.message).includes('404')){showError(error);return;}}
  heldShown=null;await refreshIntercept();
}
// A held response, as edited in the panel, becomes a mock: the next matching request never leaves the proxy.
$('intercept-mock').onclick=()=>{
  let host='',path='/';try{const url=new URL($('intercept-url').value);host=url.hostname;path=url.pathname;}catch{}
  const headers=$('intercept-headers').value.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{const at=line.indexOf(':');return at<0?[line,'']:[line.slice(0,at).trim(),line.slice(at+1).trim()];});
  const type=(headers.find(([name])=>name.toLowerCase()==='content-type')||[])[1]||'';
  mockEditing=null;
  fillMockEditor({method:$('intercept-method').value,host,path,status:Number($('intercept-status').value)||200,content_type:type,body:$('intercept-body').disabled?'':$('intercept-body').value},t('mock.note'));
};
async function decideAll(action){
  const state=await api('intercept');
  for(const held of state.held){try{await api('intercept/'+held.id,'POST',JSON.stringify({action}));}catch{}}
  heldShown=null;await refreshIntercept();
}
async function saveInterceptRules(enabled){interceptSaving=true;try{await api('intercept','PUT',interceptRules(enabled));}finally{interceptSaving=false;}await refreshIntercept();}
$('intercept').onclick=async()=>{try{await saveInterceptRules(!interceptOn);toast(t(interceptOn?'intercept.on':'intercept.off'));}catch(error){showError(error);}};
for(const id of [...INTERCEPT_INPUTS,'intercept-responses'])$(id).onchange=async()=>{try{if(interceptOn)await saveInterceptRules(true);else await refreshIntercept();}catch(error){showError(error);}};
// Ctrl/Cmd+Enter in the panel forwards the shown request; Ctrl/Cmd+Backspace drops it.
$('intercept-panel').addEventListener('keydown',event=>{if(!(event.ctrlKey||event.metaKey))return;if(event.key==='Enter'){event.preventDefault();decideShown('forward').catch(showError);}else if(event.key==='Backspace'){event.preventDefault();decideShown('drop').catch(showError);}else if(event.key===']'||event.key==='['){event.preventDefault();stepHeld(event.key===']'?1:-1);}});
// Ctrl/Cmd+] and Ctrl/Cmd+[ walk the queue of held requests.
function stepHeld(direction){if(heldIds.length<2)return;const at=Math.max(0,heldIds.indexOf(heldShown));heldWanted=heldIds[(at+direction+heldIds.length)%heldIds.length];heldShown=null;refreshIntercept().catch(showError);}
$('intercept-forward').onclick=()=>decideShown('forward').catch(showError);$('intercept-drop').onclick=()=>decideShown('drop').catch(showError);
$('intercept-forward-all').onclick=()=>decideAll('forward').catch(showError);$('intercept-drop-all').onclick=()=>decideAll('drop').catch(showError);
refreshIntercept().catch(()=>{});
// A HAR comes in through the button (open dialog) or by dropping the file onto the window.
async function importHar(file){
  const button=$('import');if(button.disabled)return;const label=button.textContent;button.disabled=true;button.textContent=t('import.working');
  try{const count=await window.librium.importHar(file);if(count!==null){toast(count?t('import.done',{count}):t('import.empty'));rowsSignature='';await loadPage();}}
  catch(error){showError(error);}
  finally{button.disabled=false;button.textContent=label;}
}
$('import').onclick=()=>importHar();
if(window.librium?.importHar){
  document.addEventListener('dragover',event=>{if([...event.dataTransfer?.types||[]].includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
  document.addEventListener('drop',event=>{const file=[...event.dataTransfer?.files||[]].find(f=>/\.(har|json)$/i.test(f.name));if(!file)return;event.preventDefault();isRulesFile(file).then(rules=>rules&&window.librium?.importRules?importRules(file):importHar(file));});
}
$('export').onclick=async()=>{
  const button=$('export'),label=button.textContent;button.disabled=true;button.textContent=t('export.working');
  try{const f=currentFilters(),parsed=LibriumFilters.parse(f.query);const count=await window.librium.exportHar({query:parsed.text,method:f.method,status:f.status,traffic_type:f.type,rules:activeRules(parsed)},{redact:$('export-redact').checked});if(count!==null)toast(count?t('export.done',{count}):t('export.none'));}
  catch(error){showError(error);}
  finally{button.disabled=false;button.textContent=label;}
};
$('setup').onclick = () => $('dialog').showModal(); $('close').onclick = () => $('dialog').close();
$('browser').onclick=async()=>{try{await window.librium.openBrowser();toast(t('https.browserStarted'));}catch(error){showError(error);}};
$('ca-trust').hidden = !window.librium?.installCertificate || !['darwin', 'win32'].includes(platform);
$('ca-trust').onclick = async () => { const button = $('ca-trust'), label = button.textContent; button.disabled = true; button.textContent = t('https.installing'); try { await window.librium.installCertificate(); toast(t('https.installed')); } catch (error) { showError(error); } finally { button.disabled = false; button.textContent = label; } };
$('ca').onclick = async () => { try { if(window.librium) { if(await window.librium.saveCertificate()) toast(t('https.caSaved')); } else { const res = await fetch('/api/ca',{headers:{'x-librium-token':token}}); if(!res.ok) throw Error(`API: ${res.status}`); const url=URL.createObjectURL(await res.blob()); const a=el('a'); a.href=url; a.download='librium-ca.crt'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); } } catch(error) { showError(error); } };
// Escape empties the search box under the cursor; the dialogs already close on it by themselves.
// Suggestions under the search box: fields while a token is typed, values once the field has its colon.
// Values come from every row shown so far, not the current page: the page is already narrowed by the
// half-typed condition, and would offer nothing while `host:ap` is on its way.
const suggestPool=new Map();
function rememberForSuggest(list){for(const row of list){suggestPool.delete(row.id);suggestPool.set(row.id,row);}while(suggestPool.size>3000)suggestPool.delete(suggestPool.keys().next().value);}
let suggestState=null,suggestActive=-1,suggestSeeded=false;
// The pool starts from the newest unfiltered page, so a session that opens with a filter still knows the other hosts.
function seedSuggestPool(){
  if(suggestSeeded)return;suggestSeeded=true;
  api('traffic-page?q='+encodeURIComponent(JSON.stringify({limit:1000}))).then(data=>{rememberForSuggest(data.rows||[]);if(document.activeElement===$('filter'))updateSuggest();}).catch(()=>{suggestSeeded=false;});
}
// The last searches, offered when the box is empty; only searches that were run on purpose (Enter or leaving the box).
const RECENT_KEY='librium-recent-searches';
function recentSearches(){try{const list=JSON.parse(localStorage.getItem(RECENT_KEY)||'[]');return Array.isArray(list)?list.filter(q=>typeof q==='string').slice(0,8):[];}catch{return [];}}
function rememberSearch(text){
  const query=String(text||'').trim();if(!query)return;
  const list=[query,...recentSearches().filter(q=>q!==query)].slice(0,8);
  try{localStorage.setItem(RECENT_KEY,JSON.stringify(list));}catch{}
}
function hideSuggest(){$('suggest').hidden=true;$('suggest').replaceChildren();suggestState=null;suggestActive=-1;$('filter').removeAttribute('aria-activedescendant');}
function updateSuggest(){
  const box=$('filter');
  let result=document.activeElement===box?LibriumSuggest.suggest(box.value,box.selectionStart??box.value.length,[...suggestPool.values()]):null;
  if(!result){hideSuggest();return;}
  const recent=box.value.trim()?[]:recentSearches().map(query=>({insert:query,label:query,hint:'',recent:true}));
  if(recent.length)result={...result,items:[...recent,...result.items]};
  suggestState=result;suggestActive=-1;
  const list=$('suggest');list.replaceChildren();
  if(recent.length)list.append(el('div',t('suggest.recent'),'suggest-head'));
  result.items.forEach((item,index)=>{
    if(index===recent.length)list.append(el('div',t(result.kind==='field'?'suggest.fields':'suggest.values'),'suggest-head'));
    const row=el('div','','suggest-item');row.id='suggest-'+index;row.setAttribute('role','option');row.append(el('b',item.label),el('span',item.hint));
    row.onmousedown=event=>{event.preventDefault();acceptSuggest(index);};row.onmouseenter=()=>highlightSuggest(index);
    list.append(row);
  });
  list.append(el('div',t('suggest.keys'),'suggest-foot'));
  list.hidden=false;
}
function highlightSuggest(index){
  suggestActive=index;const items=$('suggest').querySelectorAll('.suggest-item');
  items.forEach((item,i)=>item.classList.toggle('active',i===index));
  if(index>=0){items[index].scrollIntoView?.({block:'nearest'});$('filter').setAttribute('aria-activedescendant','suggest-'+index);}
}
function acceptSuggest(index){
  const item=suggestState?.items[index];if(!item)return;
  const box=$('filter'),{start,end}=suggestState;
  box.value=box.value.slice(0,start)+item.insert+box.value.slice(end);
  const caret=start+item.insert.length;box.setSelectionRange(caret,caret);
  renderFilterChips();filtersChanged();
  if(item.recent)rememberSearch(item.insert);
  if(item.keepOpen)updateSuggest();else hideSuggest();
}
$('filter').addEventListener('input',updateSuggest);$('filter').addEventListener('focus',()=>{seedSuggestPool();updateSuggest();});$('filter').addEventListener('click',updateSuggest);$('filter').addEventListener('blur',()=>{hideSuggest();rememberSearch($('filter').value);});
$('filter').addEventListener('keyup',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key))updateSuggest();});
$('filter').addEventListener('keydown',event=>{
  const open=!$('suggest').hidden&&suggestState;
  if(open&&(event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();const n=suggestState.items.length;highlightSuggest(((suggestActive+(event.key==='ArrowDown'?1:-1))%n+n)%n);return;}
  if(open&&(event.key==='Tab'||(event.key==='Enter'&&suggestActive>=0))){event.preventDefault();acceptSuggest(Math.max(suggestActive,0));return;}
  if(event.key==='Enter'){rememberSearch($('filter').value);hideSuggest();return;}
  if(event.key==='Escape'){if(open){event.preventDefault();hideSuggest();return;}if($('filter').value){event.preventDefault();$('filter').value='';renderFilterChips();filtersChanged();}}
});
$('find').addEventListener('keydown',event=>{if(event.key==='Escape'&&$('find').value){event.preventDefault();$('find').value='';renderDetail();}});
document.addEventListener('keydown',event=>{if(!shortcut(event)||event.altKey)return;const key=event.key.toLowerCase();if(key==='k'){event.preventDefault();$('filter').focus();$('filter').select();}else if(key==='f'){event.preventDefault();$('find').focus();$('find').select();}else if(key==='i'){event.preventDefault();$('intercept').click();}else if(key==='n'){if($('compose').hidden)return;event.preventDefault();openComposeEditor();}else if(key==='m'&&event.shiftKey){if(!detail||detail.summary.status==null||detail.summary.status===101)return;event.preventDefault();openMockEditor(detail.summary).catch(showError);}else if(key==='d'){event.preventDefault();if(detail)markSelected({starred:!detail.summary.starred});}});
// The split between the history and the inspector survives a restart.
const divider=$('divider');
function setSplit(percent,remember){if(!Number.isFinite(percent))return;const value=Math.max(30,Math.min(60,percent));document.documentElement.style.setProperty('--history',value+'%');if(remember)try{localStorage.setItem('librium-split',String(value));}catch{}}
try{const saved=parseFloat(localStorage.getItem('librium-split'));if(Number.isFinite(saved))setSplit(saved,false);}catch{}
divider.onpointerdown=event=>{divider.setPointerCapture(event.pointerId);};
divider.onpointermove=event=>{if(divider.hasPointerCapture(event.pointerId)){const main=document.querySelector('main').getBoundingClientRect();setSplit((event.clientX-main.left)/main.width*100,true);}};
divider.onpointerup=event=>divider.releasePointerCapture(event.pointerId);
divider.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const current=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--history'));setSplit((Number.isFinite(current)?current:40)+(event.key==='ArrowRight'?2:-2),true);}};
$('filter-session').onchange=()=>{sessionState.activeId=$('filter-session').value;applySession();persistSessions();loadPage().catch(showError);};
function sessionDialog(rename){sessionEditing=rename;$('session-title').textContent=t(rename?'session.renameTitle':'session.newTitle');$('session-name').value=rename?sessionState.sessions.find(s=>s.id===sessionState.activeId).name:'';$('session-copy-row').hidden=rename;$('session-copy').checked=true;$('session-error').textContent='';$('session-dialog').showModal();$('session-name').focus();}
$('session-new').onclick=()=>sessionDialog(false);$('session-rename').onclick=()=>sessionDialog(true);$('session-cancel').onclick=()=>$('session-dialog').close();
$('session-form').onsubmit=event=>{event.preventDefault();const name=$('session-name').value.trim();if(!name){$('session-error').textContent=t('session.nameRequired');return;}if(sessionState.sessions.some(s=>s.name.toLowerCase()===name.toLowerCase()&&(!sessionEditing||s.id!==sessionState.activeId))){$('session-error').textContent=t('session.nameTaken');return;}
 if(sessionEditing)sessionState.sessions.find(s=>s.id===sessionState.activeId).name=name;else{if(sessionState.sessions.length>=200){$('session-error').textContent=t('session.limit');return;}const id=crypto.randomUUID();sessionState.sessions.push({id,name,...($('session-copy').checked?currentFilters():emptyFilters())});sessionState.activeId=id;}
 applySession();persistSessions();loadPage().catch(showError);$('session-dialog').close();};
$('session-delete').onclick=()=>{const current=sessionState.sessions.find(s=>s.id===sessionState.activeId);if(!window.confirm(t('session.confirmDelete',{name:current.name})))return;sessionState.sessions=sessionState.sessions.filter(s=>s.id!==current.id);if(!sessionState.sessions.length)sessionState.sessions=[{id:crypto.randomUUID(),name:t('session.default'),...emptyFilters()}];sessionState.activeId=sessionState.sessions[0].id;applySession();persistSessions();loadPage().catch(showError);};
$('preset-ws').onclick=()=>{$('traffic-type').value='ws';renderFilterChips();filtersChanged();$('filters-dialog').close();};
document.querySelectorAll('[data-sort]').forEach(button=>button.onclick=()=>{const field=button.dataset.sort;sortOrder=field===sortField?(sortOrder==='asc'?'desc':'asc'):['method','url'].includes(field)?'asc':'desc';sortField=field;renderSort();filtersChanged();});
$('lang').onclick=async()=>{const next=LibriumI18n.lang==='ru'?'en':'ru';try{localStorage.setItem('librium-lang',next);}catch{}try{await window.librium?.setLanguage?.(next);}catch{}if(window.librium?.reload)window.librium.reload().catch(()=>location.reload());else location.reload();};
Promise.resolve(window.librium?.setLanguage?.(LibriumI18n.lang)).catch(()=>{});
renderDetail();loadInfo().catch(showError);initSessions().then(refresh).catch(showError);
