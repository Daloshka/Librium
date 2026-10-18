(function(root){
 'use strict';
 function create({document:doc,request,openMessage}){
  const $=id=>doc.getElementById('ws-archive-'+id),el=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  for(const [target,source]of [['format','ws-search-format'],['kind','ws-kind'],['direction','ws-direction'],['source','traffic-source']]){
   for(const option of doc.getElementById(source).options){const copy=option.cloneNode(true);copy.removeAttribute('id');$(target).append(copy);}
  }
  const contentKinds=root.LibriumWSProfile?.kinds||[];
  for(const kind of contentKinds){const option=el('option',kind.name);option.value=kind.value;$('content-kind').append(option);}
  let view=null,data=null,version=0,busy=false,pending=null,exact=null,context=null;
  const active=job=>view===job.view&&version===job.version&&$('dialog').open;
  function controls(){const ready=Boolean(view&&data&&!busy&&!pending);$('prev').disabled=!ready||view.page===0;$('next').disabled=!ready||!data.older;}
  function invalidate(){++version;pending=null;data=null;$('content').replaceChildren();$('page').textContent='';controls();}
  function close(){invalidate();view=null;if($('dialog').open)$('dialog').close();$('state').textContent='';$('error').hidden=true;}
  function sync(){
   const content=$('format').value==='content_kind';$('content-kind').parentElement.hidden=!content;$('search').parentElement.hidden=content;
   $('search').maxLength=$('format').value==='jsonrpc_id'?65536:4096;
   $('search').placeholder=$('format').value==='jsonrpc_id'?'ID: 17, "17" или null; пусто — все ID':$('format').value==='jsonrpc_method'?'Метод JSON-RPC; пусто — все команды и уведомления':'Текст, имя события или Hex-маска';
   $('pointer').hidden=$('format').value!=='jsonpointer';$('pointer').parentElement.hidden=$('pointer').hidden;
   const field=$('format').querySelector('[value="protocol_field"]');if(field)field.hidden=!exact?.field_exact;
   $('exact').hidden=!exact;const condition=exact?JSON.stringify(exact.field_exact||exact.socketio_exact||exact.exact):'';$('exact').textContent=exact?`Точно: ${Array.from(condition).slice(0,100).join('')} ×`:'';$('exact').title=condition;
  }
  function edited(dropExact=false){
   invalidate();view=null;$('state').textContent='Условия изменены. Нажми «Найти».';$('error').hidden=true;
   if(dropExact){exact=null;if($('format').value==='protocol_field')$('format').value='hex';}sync();
  }
  async function pump(){
   if(busy||!pending)return;const job=pending;pending=null;busy=true;controls();
   try{const result=await request(job.query);if(active(job))render(job,result);}
   catch(error){if(active(job)){$('error').textContent=error.message;$('error').hidden=false;$('state').textContent='Не удалось выполнить поиск. Нажми «Найти», чтобы повторить.';}}
   finally{busy=false;if(pending)void pump();else controls();}
  }
  function render(job,result){
   if(!result||!Array.isArray(result.matches)||result.matches.length>100)throw Error('Неверный ответ поиска WS.');
   data=result;view.through=result.through;$('state').textContent=`Найдено сообщений: ${result.matched} / ${result.total} в выбранной области.`;$('page').textContent=`Страница ${view.page+1} · снимок архива`;
   const table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');table.className='ws-archive-table';
   for(const text of ['Соединение','Сообщение','Фрагмент',''])header.append(el('th',text));head.append(header);table.append(head,body);
   for(const row of result.matches){
    const m=row.message,tr=el('tr'),connection=el('td'),message=el('td'),fragment=el('td'),action=el('td');
    const url=el('strong',row.exchange.url);url.title=row.exchange.url;connection.append(url,el('small',`#${row.exchange_id} · ${row.exchange.capture_target||'Контекст не указан'} · ${row.exchange.source||'proxy'}`));
    message.append(el('strong',`${m.direction==='sent'?'↑ Отправлено':'↓ Получено'} · ${m.kind}`),el('small',`#${m.id} · ${m.size} Б${m.truncated?' · сохранена часть':''}`));
    fragment.append(el('code',m.field_preview??m.preview??''));
    const button=el('button','Открыть');button.type='button';button.onclick=()=>{
     if(!active(job)||data!==result||busy||!$('content').contains(button))return;
     const format=job.query.format,match=Number.isSafeInteger(m.match_offset)&&Number.isSafeInteger(m.match_length)?{offset:m.match_offset,length:m.match_length}:null,hint=format==='content_kind'?contentKinds.find(kind=>kind.value===job.query.search):null;
     const args=[row.exchange_id,m.id,match?'hex':hint?.view||(format.startsWith('jsonrpc_')?'jsonrpc':format.startsWith('cdp_')?'cdp':['hex','msgpack','protobuf'].includes(format)?format:'pretty'),match];
     const entry=Array.isArray(m.rpc_entries)&&Number.isInteger(m.rpc_entries[0])?m.rpc_entries[0]:null;if(entry!==null||hint?.codec)args.push(entry);if(hint?.codec)args.push(hint.codec);
     close();const opened=version;Promise.resolve().then(()=>openMessage(...args)).catch(error=>{if(version!==opened)return;$('dialog').showModal();$('error').textContent=error.message;$('error').hidden=false;});
    };action.append(button);tr.append(connection,message,fragment,action);body.append(tr);
   }
   $('content').replaceChildren(result.matches.length?table:el('p','Совпадений нет. Проверь условия и область поиска.'));
  }
  function read(){
   const job={view,version:++version,query:{...view.query,before:view.cursors[view.page],through:view.through}};pending=job;data=null;$('content').replaceChildren();$('error').hidden=true;$('state').textContent='Ищем по записанным сообщениям…';$('page').textContent='';controls();void pump();
  }
  function search(){
   if(!$('dialog').open)return;
   const format=$('format').value,query={search:format==='content_kind'?$('content-kind').value:$('search').value,format,kind:$('kind').value,direction:$('direction').value,pointer:format==='jsonpointer'?$('pointer').value:'',url:$('url').value,source:$('source').value||undefined,capture_context:$('context').checked?context?.id:undefined,...exact};
   try{
    const ws=root.LibriumWS;
    if(ws){if(format==='hex')ws.normalizeHex(query.search);else if(format==='hex_mask')ws.normalizeHexMask(query.search);else if(format==='cdp_id')ws.normalizeCdpId(query.search);else if(format==='jsonrpc_id')ws.normalizeJsonRpcIdQuery(query.search);else if(format==='jsonpointer')ws.validateJsonPointer(query.pointer);}
   }catch(error){invalidate();view=null;$('error').textContent=error.message;$('error').hidden=false;$('state').textContent='Исправь условие поиска.';return;}
   view={query,page:0,cursors:[null],through:null};read();
  }
  function open(seed={},scope=null){
   close();exact=seed.field_exact?{field_exact:seed.field_exact}:seed.socketio_exact?{socketio_exact:seed.socketio_exact}:seed.exact?{exact:seed.exact}:null;
   context=scope;for(const key of ['search','kind','direction','pointer','url','source'])$(key).value=seed[key]||'';$('format').value=seed.format||'text';
   $('content-kind').value=seed.format==='content_kind'?seed.search:contentKinds[0]?.value||'';if(seed.format==='content_kind')$('search').value='';
   $('context').checked=false;$('context').disabled=!scope;$('context-label').textContent=scope?`Только ${scope.label||'выбранное окно / поток'}`:'Окно / поток не выбран';sync();$('dialog').showModal();search();
  }
  $('form').onsubmit=event=>{event.preventDefault();search();};$('close').onclick=close;$('dialog').onclose=()=>{if(!$('dialog').open)close();};
  for(const id of ['search','format','pointer'])$(id).addEventListener('input',()=>edited(true));
  for(const id of ['url','kind','direction','source','context','content-kind'])$(id).addEventListener('input',()=>edited());
  $('exact').onclick=()=>edited(true);
  $('prev').onclick=()=>{if(!view||busy||!data||view.page===0)return;view.page--;read();};
  $('next').onclick=()=>{if(!view||busy||!data?.older)return;view.cursors[++view.page]=data.next_before;read();};
  return {open,close};
 }
 const api={create};root.LibriumWSArchive=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
