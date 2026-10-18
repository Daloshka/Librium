(function(root){
 'use strict';
 function create({document:doc,request,openMessage,findId,isCurrent,box,button}){
  const el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;},short=value=>{const chars=Array.from(String(value));return chars.slice(0,160).join('')+(chars.length>160?'…':'');};
  const identity=(kind,value)=>kind==='string'?JSON.stringify(String(value)):String(value);
  let version=0,pending=null,busy=false,source=null;
  const active=job=>source===job.source&&version===job.version&&isCurrent(job.source);
  function reset(){++version;pending=null;source=null;}
  function navigate(job,data,item){if(!active(job)||!box.contains(data.links))return;Promise.resolve().then(()=>openMessage(job.source.id,item.id,'jsonrpc',null,item.entry)).catch(error=>{if(active(job))box.replaceChildren(el('p',error.message));});}
  function render(job,data){
   if(!data||typeof data.supported!=='boolean')throw Error('Неверный ответ поиска JSON-RPC.');
   box.replaceChildren();
   if(Array.isArray(data.entries)){
    if(data.entries.length>256||(!Number.isInteger(data.selected)||data.selected<0||data.selected>255))throw Error('Неверный список элементов JSON-RPC.');
    const label=el('label','Элемент исходного пакета '),select=el('select');select.className='ws-jsonrpc-entry';select.setAttribute('aria-label','Элемент JSON-RPC для поиска пары');
    for(const entry of data.entries){
     if(!Number.isInteger(entry.index)||entry.index<0||entry.index>255)throw Error('Неверный индекс JSON-RPC.');
     const option=el('option',`[${entry.index+1}] ${!entry.valid?'Неверный объект':!entry.has_id?'Уведомление':entry.request?'Команда':'Ответ'}${entry.method?' · '+short(entry.method):''}${entry.has_id?' · '+entry.id_kind+': '+short(identity(entry.id_kind,entry.id_value)):''}`);option.value=entry.index;select.append(option);
    }
    select.value=data.selected;job.source.relatedEntry=data.selected;select.onchange=()=>{if(active(job)&&box.contains(select))load(job.source,Number(select.value));};label.append(select);box.append(label);
   }
   if(!data.supported){box.append(el('p',data.reason||'Полное сообщение с однозначным ID недоступно.'));return;}
   if(!['matched','missing','ambiguous'].includes(data.status)||!['string','number'].includes(data.id_kind)||typeof data.id_value!=='string'||!Array.isArray(data.commands)||!Array.isArray(data.responses)||data.commands.length>20||data.responses.length>20||[data.command_count,data.response_count,data.inspected].some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Неверные данные пары JSON-RPC.');
   const description=data.status==='matched'?'Найдена единственная команда и ответ.':data.status==='ambiguous'?'Неоднозначный ID: несколько команд / ответов либо нарушен порядок записи. Автоматическая пара не выбрана.':'Пара среди полных исходных сообщений пока не найдена.';
   box.append(el('p',description),el('p',`JSON-RPC ID (${data.id_kind}): ${short(identity(data.id_kind,data.id_value))} · команд: ${data.command_count}, ответов: ${data.response_count} · проверено сообщений: ${data.inspected}`));
   if(data.status==='matched'&&Number.isSafeInteger(data.latency_ms)&&data.latency_ms>=0)box.append(el('p',`Между записями команды и ответа: ${data.latency_ms} мс`));
   const links=el('div');links.className='ws-inspector-tools ws-jsonrpc-links';data.links=links;
   for(const [label,items]of [['Команда',data.commands],['Ответ',data.responses]])for(const item of items){
    if(!Number.isSafeInteger(item.id)||item.id<1||!Number.isInteger(item.entry)||item.entry<0||item.entry>255)throw Error('Неверная ссылка на элемент JSON-RPC.');
    const link=el('button',`${label} #${item.id} · элемент ${item.entry+1}${item.method?' · '+short(item.method):''}`);link.type='button';link.className='ws-jsonrpc-open';link.disabled=item.id===job.source.messageId&&item.entry===data.selected;link.onclick=()=>navigate(job,data,item);links.append(link);
   }
   if(findId){const find=el('button','Найти этот ID во всех соединениях');find.type='button';find.className='ws-jsonrpc-find-id';find.onclick=()=>{if(active(job)&&box.contains(find))findId(job.source,data.id_kind,data.id_value);};links.append(find);}
   box.append(links,el('p','Вся запись одного соединения, независимо от фильтров. До 20 команд и 20 ответов. Строковые и числовые ID различаются; числа сравниваются без округления. Повтор ID не разделяется на предполагаемые пары. Длинные ID и методы сокращены в списке; исходные значения доступны в пакете.','muted'));
  }
  async function pump(){
   if(busy||!pending)return;const job=pending;pending=null;busy=true;
   try{const data=await request(`traffic/${job.source.id}/ws/${job.source.messageId}/jsonrpc-related${job.entry===null?'':'?entry='+job.entry}`);if(active(job))render(job,data);}
   catch(error){if(active(job))box.replaceChildren(el('p',error.message.includes('404')?'Сообщение удалено из истории или недоступно.':error.message));}
   finally{busy=false;if(pending)void pump();else if(source&&isCurrent(source))button.disabled=false;}
  }
  function load(value,entry=value.relatedEntry??null){source=value;pending={source:value,entry,version:++version};box.hidden=false;box.replaceChildren(el('p','Поиск JSON-RPC по всей записанной сессии…'));button.disabled=true;void pump();}
  return {load,reset};
 }
 const api={create};root.LibriumJsonRpcRelated=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
