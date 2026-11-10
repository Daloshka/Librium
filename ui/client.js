'use strict';
// Requests: a workspace for composing and sending requests, the way an API client does it. Each request
// has a name, a method, an address, parameters, headers and a body; all of them are kept between starts.
// A request is sent through the proxy (the desktop shell's replay with id 0), so it lands in the history,
// and the answer shown here is read back from the recorded exchange.
const CLIENT_KEY = 'librium-client-v1', CLIENT_LIMIT = 200;
const CLIENT_BODY_TYPES = {none: '', json: 'application/json', text: 'text/plain', form: 'application/x-www-form-urlencoded'};
const blankRequest = () => ({id: crypto.randomUUID(), name: '', method: 'GET', url: 'https://', params: [], headers: [{on: true, name: 'accept', value: '*/*'}], bodyType: 'none', body: ''});
const cleanPairs = list => (Array.isArray(list) ? list : []).filter(item => item && typeof item.name === 'string' && typeof item.value === 'string').map(item => ({on: item.on !== false, name: item.name, value: item.value}));
function loadClient() {
  try {
    const saved = JSON.parse(localStorage.getItem(CLIENT_KEY) || 'null');
    const requests = (saved?.requests || []).filter(r => r && typeof r.id === 'string' && typeof r.url === 'string').slice(0, CLIENT_LIMIT).map(r => ({id: r.id, name: String(r.name || ''), method: String(r.method || 'GET'), url: r.url, params: cleanPairs(r.params), headers: cleanPairs(r.headers), bodyType: Object.hasOwn(CLIENT_BODY_TYPES, r.bodyType) ? r.bodyType : 'none', body: String(r.body || '')}));
    if (requests.length) return {activeId: requests.some(r => r.id === saved.activeId) ? saved.activeId : requests[0].id, requests};
  } catch {}
  const first = blankRequest(); return {activeId: first.id, requests: [first]};
}
const client = loadClient(), clientResponses = new Map();
let clientTab = 'params', clientResponseTab = 'body', clientResponseView = 'pretty', clientSaveTimer = 0, clientRender = 0;
const clientCurrent = () => client.requests.find(r => r.id === client.activeId);
const filled = list => list.filter(item => item.name.trim());
function saveClient() {
  clearTimeout(clientSaveTimer);
  const write = () => { try { localStorage.setItem(CLIENT_KEY, JSON.stringify({activeId: client.activeId, requests: client.requests.map(r => ({...r, params: filled(r.params), headers: filled(r.headers)}))})); } catch {} };
  clientSaveTimer = setTimeout(write, 300); if (!clientSaveTimer) write();
}
// The query string and the Params table are two views of the same thing: rows that are switched on live in the address.
function queryPairs(url) {
  const hash = url.indexOf('#'), plain = hash < 0 ? url : url.slice(0, hash), at = plain.indexOf('?');
  if (at < 0) return [];
  const decode = text => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };
  return plain.slice(at + 1).split('&').filter(Boolean).map(part => { const eq = part.indexOf('='); return {on: true, name: decode(eq < 0 ? part : part.slice(0, eq)), value: decode(eq < 0 ? '' : part.slice(eq + 1))}; });
}
function withQuery(url, params) {
  const hash = url.indexOf('#'), tail = hash < 0 ? '' : url.slice(hash), plain = hash < 0 ? url : url.slice(0, hash), at = plain.indexOf('?');
  const query = params.filter(item => item.on && item.name.trim()).map(item => encodeURIComponent(item.name) + (item.value ? '=' + encodeURIComponent(item.value) : '')).join('&');
  return (at < 0 ? plain : plain.slice(0, at)) + (query ? '?' + query : '') + tail;
}
function clientLabel(request) {
  if (request.name.trim()) return request.name.trim();
  try { const url = new URL(request.url); if (url.hostname) return url.host + (url.pathname === '/' ? '' : url.pathname); } catch {}
  return t('client.untitled');
}
// A table of names and values with a switch per row; an empty row always waits at the end.
function pairEditor(box, list, changed) {
  box.replaceChildren();
  const add = item => {
    const row = el('div', undefined, 'kv-row'), on = document.createElement('input'), name = document.createElement('input'), value = document.createElement('input'), remove = el('button', '×', 'kv-remove');
    on.type = 'checkbox'; on.checked = item.on; on.title = t('client.enabled'); on.setAttribute('aria-label', t('client.enabled'));
    name.value = item.name; name.placeholder = t('client.key'); name.setAttribute('aria-label', t('client.key')); name.spellcheck = false; name.className = 'kv-name';
    value.value = item.value; value.placeholder = t('client.value'); value.setAttribute('aria-label', t('client.value')); value.spellcheck = false; value.className = 'kv-value';
    remove.type = 'button'; remove.title = t('client.remove'); remove.setAttribute('aria-label', t('client.remove'));
    const edited = () => { item.name = name.value; item.value = value.value; if (list.at(-1) === item && (item.name || item.value)) grow(); changed(); };
    name.oninput = edited; value.oninput = edited; on.onchange = () => { item.on = on.checked; row.classList.toggle('off', !item.on); changed(); };
    remove.onclick = () => { list.splice(list.indexOf(item), 1); row.remove(); if (!list.length || list.at(-1).name || list.at(-1).value) grow(); changed(); };
    row.classList.toggle('off', !item.on); row.append(on, name, value, remove); box.append(row);
  };
  const grow = () => { const item = {on: true, name: '', value: ''}; list.push(item); add(item); };
  list.forEach(add);
  if (!list.length || list.at(-1).name || list.at(-1).value) grow();
}
function renderClientList() {
  const box = $('client-list'); box.replaceChildren();
  for (const request of client.requests) {
    const row = el('div', undefined, 'client-item' + (request.id === client.activeId ? ' active' : '')); row.tabIndex = 0; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(request.id === client.activeId));
    const remove = el('button', '×', 'kv-remove'); remove.title = t('client.delete'); remove.setAttribute('aria-label', t('client.delete'));
    remove.onclick = event => { event.stopPropagation(); if (!window.confirm(t('client.confirmDelete', {name: clientLabel(request)}))) return; client.requests.splice(client.requests.indexOf(request), 1); clientResponses.delete(request.id); if (!client.requests.length) client.requests.push(blankRequest()); if (client.activeId === request.id) client.activeId = client.requests[0].id; saveClient(); renderClient(); };
    row.append(el('span', request.method, 'method-tag ' + request.method), el('span', clientLabel(request), 'client-item-name'), remove);
    row.title = request.url;
    row.onclick = () => { client.activeId = request.id; saveClient(); renderClient(); };
    row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.onclick(); } };
    box.append(row);
  }
}
function renderClientCounts() {
  const request = clientCurrent(), count = (id, n) => { $(id).textContent = n ? String(n) : ''; $(id).hidden = !n; };
  count('client-params-count', filled(request.params).filter(item => item.on).length);
  count('client-headers-count', filled(request.headers).filter(item => item.on).length);
  $('client-body-dot').hidden = request.bodyType === 'none' || !request.body;
}
function renderClientBody() {
  const request = clientCurrent();
  document.querySelectorAll('#client-body-type button').forEach(button => { const on = button.dataset.type === request.bodyType; button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on)); });
  $('client-body').hidden = request.bodyType === 'none'; $('client-format').hidden = request.bodyType !== 'json';
  const typed = filled(request.headers).some(item => item.on && item.name.trim().toLowerCase() === 'content-type');
  $('client-body-hint').textContent = request.bodyType === 'none' ? t('client.bodyNoneHint') : typed ? '' : t('client.typeHint', {type: CLIENT_BODY_TYPES[request.bodyType]});
}
function renderClientTabs() {
  document.querySelectorAll('#client-tabs [data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === clientTab));
  for (const name of ['params', 'headers', 'body']) $('client-panel-' + name).hidden = name !== clientTab;
}
// The whole editor for the active request; called when another request is picked, not on every keystroke.
function renderClient() {
  const request = clientCurrent();
  renderClientList();
  $('client-name').value = request.name; $('client-method').value = request.method; if ($('client-method').value !== request.method) $('client-method').value = 'GET';
  $('client-url').value = request.url; $('client-body').value = request.body; $('client-error').textContent = '';
  const touched = () => { renderClientCounts(); renderClientBody(); saveClient(); };
  pairEditor($('client-panel-params'), request.params, () => { request.url = withQuery(request.url, request.params); $('client-url').value = request.url; renderClientList(); touched(); });
  pairEditor($('client-panel-headers'), request.headers, touched);
  renderClientTabs(); renderClientBody(); renderClientCounts(); renderClientResponse().catch(showError);
}
async function renderClientResponse() {
  const version = ++clientRender, request = clientCurrent(), response = clientResponses.get(request.id), content = $('client-content');
  const status = $('client-status'); status.className = 'client-status'; status.textContent = ''; $('client-meta').textContent = '';
  $('client-open').hidden = true; $('client-copy').hidden = true; $('client-notice').hidden = true; $('client-rtabs').hidden = !response?.detail;
  if (!response) { content.replaceChildren(el('div', t('client.empty'), 'empty')); return; }
  if (response.sending) { content.replaceChildren(el('div', t('client.sending'), 'empty')); return; }
  if (response.error) { status.textContent = t('client.failed'); status.classList.add('s5'); content.replaceChildren(el('div', response.error, 'empty')); return; }
  status.textContent = `${response.status}${REASONS[response.status] ? ' ' + REASONS[response.status] : ''}`; status.classList.add('s' + String(response.status)[0]);
  if (!response.detail) { content.replaceChildren(el('div', t('client.notRecorded', {status: response.status}), 'empty')); return; }
  const detail = response.detail, payload = detail.response;
  $('client-meta').textContent = `${detail.summary.elapsed_ms ?? '…'} ms · ${bytes(payload.size)}${detail.summary.version ? ' · ' + detail.summary.version : ''}`;
  $('client-open').hidden = false; $('client-copy').hidden = false;
  document.querySelectorAll('#client-rtabs [data-rtab]').forEach(button => button.classList.toggle('active', button.dataset.rtab === clientResponseTab));
  document.querySelectorAll('#client-rtabs [data-rview]').forEach(button => button.classList.toggle('active', button.dataset.rview === clientResponseView));
  $('client-rviews').hidden = clientResponseTab !== 'body';
  if (clientResponseTab === 'headers') {
    const table = el('table', undefined, 'headers-table');
    for (const [key, value] of payload.headers) { const row = el('tr'), k = el('td', key), v = el('td', value); copyOnClick(k, key); copyOnClick(v, value); row.append(k, v); table.append(row); }
    response.copyText = payload.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
    content.replaceChildren(payload.headers.length ? table : el('div', t('pane.noHeaders'), 'empty')); return;
  }
  const decoded = await bodyText(payload, detail.summary.id, 'response');
  if (version !== clientRender) return;
  const notices = [coreText(detail.summary.error), payload.truncated && payload.complete ? t('body.truncated') : '', decoded.notice, imageType(payload, detail.summary.url) || audioType(payload, detail.summary.url) ? t('client.media') : ''].filter(Boolean);
  $('client-notice').hidden = !notices.length; $('client-notice').textContent = notices.join(' · ');
  let text = decoded.text, tree = null, type = '';
  if (clientResponseView === 'pretty') { try { const parsed = JSON.parse(decoded.text); text = JSON.stringify(parsed, null, 2); type = 'json'; if (parsed !== null && typeof parsed === 'object') tree = jsonTree(parsed); } catch {} }
  response.copyText = text;
  content.replaceChildren(tree || (text ? codeLines(text, type) : el('div', t(payload.complete ? 'pane.noBody' : 'pane.waitingData'), 'empty')));
}
// The exchange the proxy recorded for what was just sent: the first one after `before` with this method and address.
async function findSent(before, edit) {
  const same = url => { try { return new URL(url).href === new URL(edit.url).href; } catch { return url === edit.url; } };
  for (let attempt = 0; attempt < 12; attempt++) {
    const page = await api('traffic-page?q=' + encodeURIComponent(JSON.stringify({rules: [{field: 'id', op: 'gte', value: String(before + 1)}], offset: 0, limit: 100, sort: 'id', order: 'asc'})));
    const found = (page?.rows || []).filter(row => row.method === edit.method && same(row.url)).sort((a, b) => a.id - b.id)[0];
    if (found) { const detail = await api('traffic/' + found.id); if (detail.summary.finished !== false || attempt >= 8) return detail; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}
async function sendClient() {
  const request = clientCurrent(); $('client-error').textContent = '';
  let address; try { address = new URL(request.url.trim()); } catch {}
  if (!address || !['http:', 'https:'].includes(address.protocol) || !address.hostname) { $('client-error').textContent = t('client.badUrl'); $('client-url').focus(); return; }
  const headers = filled(request.headers).filter(item => item.on).map(item => [item.name.trim(), item.value.trim()]);
  const sendsBody = request.bodyType !== 'none';
  if (sendsBody && request.body && !headers.some(([name]) => name.toLowerCase() === 'content-type')) headers.push(['content-type', CLIENT_BODY_TYPES[request.bodyType]]);
  const edit = {method: request.method, url: request.url.trim(), headers, body: sendsBody ? request.body : ''};
  const button = $('client-send'); button.disabled = true; button.textContent = t('client.sending');
  clientResponses.set(request.id, {sending: true}); renderClientResponse().catch(showError);
  try {
    let before = 0; try { before = (await api('traffic-page?q=' + encodeURIComponent(JSON.stringify({offset: 0, limit: 1})))).newest || 0; } catch {}
    const result = await window.librium.replay(0, edit);
    const detail = await findSent(before, edit).catch(() => null);
    clientResponses.set(request.id, {status: detail?.summary.status ?? result.status, detail});
    rowsSignature = ''; loadPage().catch(() => {});
  } catch (error) { clientResponses.set(request.id, {error: error.message}); }
  finally { button.disabled = false; button.textContent = t('client.send'); }
  if (clientCurrent() === request) await renderClientResponse();
}
function newClientRequest(from) {
  // An untouched blank request is reused instead of piling up empty ones.
  const current = clientCurrent(), untouched = !from && current && !current.name && current.url === 'https://' && !current.body;
  if (!untouched) {
    if (client.requests.length >= CLIENT_LIMIT) client.requests.pop();
    const request = {...blankRequest(), ...from}; client.requests.unshift(request); client.activeId = request.id;
  }
  saveClient(); renderClient();
}
function setView(name) {
  const requests = name === 'client';
  document.body.classList.toggle('view-client', requests); $('client').hidden = !requests;
  for (const [id, on] of [['view-history', !requests], ['view-client', requests]]) { $(id).classList.toggle('active', on); $(id).setAttribute('aria-selected', String(on)); }
  if (requests) { renderClient(); $('client-url').focus(); }
}
function fillFromCurl(parsed) {
  const request = clientCurrent(), type = (parsed.headers.find(([name]) => name.toLowerCase() === 'content-type') || [])[1] || '';
  Object.assign(request, {method: parsed.method, url: parsed.url, params: queryPairs(parsed.url), headers: parsed.headers.map(([name, value]) => ({on: true, name, value})), body: parsed.body, bodyType: !parsed.body ? 'none' : /json/i.test(type) ? 'json' : /x-www-form-urlencoded/i.test(type) ? 'form' : 'text'});
  saveClient(); renderClient(); $('client-error').textContent = t('compose.curlParsed', {count: parsed.headers.length});
}
// A captured request opens here as a new one, ready to be changed and sent again.
async function openInClient(row) {
  const full = detail?.summary.id === row.id ? detail : await api('traffic/' + row.id);
  const headers = full.request.headers.filter(([name]) => !/^(host|content-length|connection|proxy-connection|keep-alive|transfer-encoding|te|trailer|upgrade|expect|proxy-authorization)$/i.test(name));
  const body = editableBody(full.request), type = (headers.find(([name]) => name.toLowerCase() === 'content-type') || [])[1] || '';
  newClientRequest({method: full.summary.method, url: full.summary.url, params: queryPairs(full.summary.url), headers: headers.map(([name, value]) => ({on: true, name, value})), body: body.text, bodyType: !body.text ? 'none' : /json/i.test(type) ? 'json' : /x-www-form-urlencoded/i.test(type) ? 'form' : 'text'});
  setView('client');
}
$('view-history').onclick = () => setView('history'); $('view-client').onclick = () => setView('client');
$('compose').onclick = () => { newClientRequest(); setView('client'); };
$('client-new').onclick = () => { newClientRequest(); $('client-url').focus(); };
$('client-name').oninput = () => { clientCurrent().name = $('client-name').value.slice(0, 80); renderClientList(); saveClient(); };
$('client-method').onchange = () => { clientCurrent().method = $('client-method').value; renderClientList(); saveClient(); };
$('client-url').oninput = () => {
  const request = clientCurrent(); request.url = $('client-url').value;
  // Rows switched off stay in the table; the rest follow the address.
  request.params = [...queryPairs(request.url), ...request.params.filter(item => !item.on && item.name.trim())];
  pairEditor($('client-panel-params'), request.params, () => { request.url = withQuery(request.url, request.params); $('client-url').value = request.url; renderClientList(); renderClientCounts(); saveClient(); });
  renderClientList(); renderClientCounts(); saveClient();
};
$('client-url').addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text') || '';
  if (!/^\s*curl(\.exe)?\s/i.test(text)) return;
  const parsed = LibriumCurl.parse(text); if (!parsed) return;
  event.preventDefault(); fillFromCurl(parsed);
});
$('client-body').oninput = () => { clientCurrent().body = $('client-body').value; renderClientCounts(); saveClient(); };
document.querySelectorAll('#client-body-type button').forEach(button => button.onclick = () => { clientCurrent().bodyType = button.dataset.type; renderClientBody(); renderClientCounts(); saveClient(); if (button.dataset.type !== 'none') $('client-body').focus(); });
$('client-format').onclick = () => { try { const request = clientCurrent(); request.body = JSON.stringify(JSON.parse(request.body), null, 2); $('client-body').value = request.body; $('client-error').textContent = ''; saveClient(); } catch (error) { $('client-error').textContent = t('client.badJson', {error: error.message}); } };
document.querySelectorAll('#client-tabs [data-tab]').forEach(button => button.onclick = () => { clientTab = button.dataset.tab; renderClientTabs(); });
document.querySelectorAll('#client-rtabs [data-rtab]').forEach(button => button.onclick = () => { clientResponseTab = button.dataset.rtab; renderClientResponse().catch(showError); });
document.querySelectorAll('#client-rtabs [data-rview]').forEach(button => button.onclick = () => { clientResponseView = button.dataset.rview; renderClientResponse().catch(showError); });
$('client-form').onsubmit = event => { event.preventDefault(); if (!$('client-send').disabled) sendClient().catch(showError); };
$('client').addEventListener('keydown', event => { if (event.key === 'Enter' && shortcut(event)) { event.preventDefault(); $('client-form').requestSubmit(); } });
$('client-open').onclick = () => { const id = clientResponses.get(client.activeId)?.detail?.summary.id; if (id == null) return; setView('history'); choose(id).catch(showError); };
$('client-copy').onclick = async () => { try { await copyText(clientResponses.get(client.activeId)?.copyText || ''); toast(t('pane.copied')); } catch (error) { showError(error); } };
// Sending needs the desktop shell: the plain browser page has no way to make the request itself.
for (const id of ['view-history', 'view-client']) $(id).hidden = !window.librium?.replay;
