(function(root){
 'use strict';
 function create({document:doc,request,openMessage}){
  const $=id=>doc.getElementById('ws-context-'+id),el=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  let view=null,version=0,data=null,busy=false,pending=null;
  const active=job=>view===job.view&&version===job.version&&$('dialog').open;
  function controls(){const ready=Boolean(view&&data&&!busy&&!pending);$('previous').disabled=!ready||!data.previous;$('next').disabled=!ready||!data.next;}
  function close(){++version;view=null;data=null;pending=null;if($('dialog').open)$('dialog').close();$('content').replaceChildren();$('state').textContent='';$('error').hidden=true;controls();}
  function navigate(job,result,id){if(!active(job)||data!==result||busy||!id)return;const {exchangeId,format}=view;close();const opened=version;Promise.resolve().then(()=>openMessage(exchangeId,id,format)).catch(error=>{if(version!==opened)return;$('dialog').showModal();$('error').textContent=error.message;$('error').hidden=false;});}
  function render(job,result){
   if(!result||result.id!==view.exchangeId||result.message_id!==view.messageId||!Array.isArray(result.messages)||result.messages.length>11||!result.messages.some(m=>m.id===view.messageId))throw Error('Неверный контекст сообщения.');
   data=result;$('state').textContent=`Соединение #${result.id} · сообщение #${result.message_id} · до пяти сообщений с каждой стороны`;
   const table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');table.className='ws-context-table';for(const text of ['Сообщение','Время','Фрагмент',''])header.append(el('th',text));head.append(header);table.append(head,body);
   for(const m of result.messages){
    const tr=el('tr'),message=el('td'),time=el('td'),content=el('td'),action=el('td'),selected=m.id===view.messageId;tr.dataset.messageId=m.id;
    if(selected){tr.className='ws-context-selected';tr.setAttribute('aria-current','true');}
    message.append(el('strong',`#${m.id} · ${m.direction==='sent'?'↑ Отправлено':'↓ Получено'} · ${m.kind}`),el('small',`${m.size} Б${m.truncated?' · сохранена часть':''}${selected?' · открыто':''}`));
    const date=new Date(m.time);if(Number.isFinite(date.getTime()))time.append(el('strong',date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,fractionalSecondDigits:3})),el('small',date.toLocaleDateString('ru-RU')));else time.textContent='Недоступно';
    content.append(el('code',m.preview||'(пусто)'));const button=el('button','Открыть');button.type='button';button.disabled=selected;button.onclick=()=>{if(!$('content').contains(button)||selected)return;navigate(job,result,m.id);};action.append(button);tr.append(message,time,content,action);body.append(tr);
   }
   $('content').replaceChildren(table);$('previous').onclick=()=>navigate(job,result,result.previous);$('next').onclick=()=>navigate(job,result,result.next);
   root.requestAnimationFrame?.(()=>{if(active(job))table.querySelector('[aria-current=true]')?.scrollIntoView?.({block:'center'});});
  }
  async function pump(){
   if(busy||!pending)return;const job=pending;pending=null;busy=true;controls();
   try{const result=await request(`traffic/${job.view.exchangeId}/ws/${job.view.messageId}/context`);if(active(job))render(job,result);}
   catch(error){if(active(job)){$('error').textContent=error.message;$('error').hidden=false;$('state').textContent='Контекст не загружен. Нажми «Обновить», чтобы повторить.';}}
   finally{busy=false;if(pending)void pump();else controls();}
  }
  function read(){if(!view||!$('dialog').open)return;pending={view,version:++version};data=null;$('content').replaceChildren();$('state').textContent='Читаем соседние сообщения…';$('error').hidden=true;controls();void pump();}
  function open(exchangeId,messageId,format='pretty'){close();view={exchangeId,messageId,format};$('dialog').showModal();read();}
  $('close').onclick=close;$('refresh').onclick=read;$('dialog').onclose=()=>{if(!$('dialog').open)close();};
  return {open,close};
 }
 const api={create};root.LibriumWSContext=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
