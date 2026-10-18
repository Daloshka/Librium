(function(root){
 'use strict';
 const formats={
  json_rpc:{name:'Конверты JSON-RPC 2.0',hint:'Есть корректные команды, ответы или уведомления. В пакетах могут встречаться другие элементы. Открой JSON-RPC и найди пару по ID.',view:'jsonrpc'},
  socket_io:{name:'Заголовки Socket.IO EVENT / ACK',hint:'Распознан текстовый заголовок события или подтверждения. Бинарные вложения здесь не собираются.',view:'pretty'},
  cdp_like:{name:'CDP-подобный JSON',hint:'Подходит под шаблон конверта CDP. Это признак формы данных, а не доказательство использования DevTools.',view:'cdp'},
  json:{name:'Обычный JSON',hint:'Корректный JSON без распознанного конверта. Начни с полей JSON, затем выбери поле для поиска.',view:'pretty'},
  text:{name:'Текст UTF-8',hint:'Полные текстовые данные. Посмотри исходное содержимое и найди повторяющиеся фрагменты.',view:'raw'},
  binary_utf8:{name:'Байты BINARY допускают UTF-8',hint:'Строгое декодирование UTF-8 возможно, но это не подтверждает текстовый формат. Сравни текст с Hex.',view:'pretty'},
  binary:{name:'Байты без распознанного формата',hint:'Начни с Hex и сравнения пакетов. MessagePack, Protobuf и свой формат выбирай по известной схеме; содержимое не угадывается.',view:'hex'},
  gzip_header:{name:'Признак заголовка gzip',hint:'Есть базовые поля заголовка gzip. Это не проверка потока или контрольной суммы. В инспекторе выбран gzip; распаковка запускается вручную.',view:'hex',codec:'gzip'},
  zlib_header:{name:'Признак заголовка zlib',hint:'Подходят два байта заголовка zlib. Совпадение возможно случайно. В инспекторе выбран zlib; проверь распаковкой вручную.',view:'hex',codec:'zlib'},
  empty:{name:'Пустые сообщения',hint:'Размер сохранённого содержимого равен нулю. Разбирать пока нечего.',view:'hex'},
  incomplete:{name:'Неполные / несогласованные данные',hint:'Часть сообщения отсутствует либо метаданные или Base64 не согласованы. Полный конверт не определяется по префиксу. Смотри сохранённые байты в Hex.',view:'hex'},
  control:{name:'Служебные кадры / фрагменты',hint:'PING, PONG, CLOSE или CONTINUATION. Это отдельная группа, она не считается прикладным конвертом.',view:'hex'},
 };
 function create({document:doc,request,openMessage,filterGroup}){
  const $=id=>doc.getElementById('ws-profile-'+id),el=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  let view=null,version=0,data=null,busy=false,pending=null;
  const active=job=>view===job.view&&version===job.version&&$('dialog').open;
  function close(){++version;view=null;data=null;pending=null;if($('dialog').open)$('dialog').close();$('content').replaceChildren();$('state').textContent='';$('error').hidden=true;}
  function render(job,result){
   if(!result||result.id!==view.id||!Array.isArray(result.groups)||result.groups.length>12||!Number.isSafeInteger(result.total)||result.total<0||result.groups.reduce((n,g)=>n+g.count,0)!==result.total)throw Error('Неверный профиль содержимого WS.');
   data=result;$('title').textContent=`Содержимое WS #${result.id}`;const url=el('span',result.summary?.url||'');url.className='ws-profile-url';$('state').replaceChildren(url,el('span',`Записано сообщений: ${result.total} · снимок по ID ${result.through}`));
   const table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');table.className='ws-profile-table';for(const text of ['Признак содержимого','Всего','↑','↓','С чего начать / примеры'])header.append(el('th',text));head.append(header);table.append(head,body);
   const seen=new Set();
   for(const group of result.groups){
    const format=formats[group.kind];if(!format||seen.has(group.kind)||!Array.isArray(group.examples)||group.examples.length>6||[group.count,group.sent,group.received,group.unknown].some(n=>!Number.isSafeInteger(n)||n<0)||group.sent+group.received+group.unknown!==group.count)throw Error('Неверная группа содержимого WS.');seen.add(group.kind);
    const tr=el('tr'),name=el('td'),details=el('td');tr.dataset.format=group.kind;name.append(el('strong',format.name));if(group.unknown)name.append(el('small',`Без направления: ${group.unknown}`));details.append(el('p',format.hint));
    const actions=el('div');actions.className='ws-profile-examples';
    for(const example of group.examples){
     if(!Number.isSafeInteger(example.id)||example.id<1||!['sent','received','unknown'].includes(example.direction)||(example.entry!==null&&(!Number.isInteger(example.entry)||example.entry<0||example.entry>255)))throw Error('Неверный пример WS.');
     const button=el('button',`${example.direction==='sent'?'↑':example.direction==='received'?'↓':'?'} #${example.id} · ${example.kind}`);button.type='button';button.onclick=()=>{
      if(!active(job)||data!==result||busy||!$('content').contains(button))return;
      const id=view.id;close();const opened=version;Promise.resolve().then(()=>openMessage(id,example.id,format.view,example.entry,format.codec||null)).catch(error=>{if(version!==opened)return;$('dialog').showModal();$('error').textContent=error.message;$('error').hidden=false;});
     };actions.append(button);
    }
    if(filterGroup){const filter=el('button','Показать группу');filter.type='button';filter.className='ws-profile-filter';filter.onclick=()=>{if(!active(job)||data!==result||busy||!$('content').contains(filter))return;const id=view.id;close();Promise.resolve().then(()=>filterGroup(id,group.kind)).catch(error=>{$('error').textContent=error.message;$('error').hidden=false;});};actions.append(filter);}
    details.append(actions);tr.append(name,el('td',String(group.count)),el('td',String(group.sent)),el('td',String(group.received)),details);body.append(tr);
   }
   $('content').replaceChildren(result.total?table:el('p','Записанных сообщений пока нет. Выполни сетевое действие в приложении и нажми «Обновить».'));
  }
  async function pump(){
   if(busy||!pending)return;const job=pending;pending=null;busy=true;$('refresh').disabled=true;
   try{const result=await request(`traffic/${job.view.id}/ws-profile`);if(active(job))render(job,result);}
   catch(error){if(active(job)){$('error').textContent=error.message.includes('404')?'Соединение удалено из истории или недоступно.':error.message;$('error').hidden=false;$('state').textContent='Содержимое не исследовано. Нажми «Обновить», чтобы повторить.';}}
   finally{busy=false;if(pending)void pump();else $('refresh').disabled=false;}
  }
  function read(){if(!view||!$('dialog').open)return;pending={view,version:++version};data=null;$('content').replaceChildren();$('error').hidden=true;$('state').textContent='Исследуем сохранённые сообщения…';void pump();}
  function open(id){close();view={id};$('title').textContent=`Содержимое WS #${id}`;$('dialog').showModal();read();}
  $('close').onclick=close;$('refresh').onclick=read;$('dialog').onclose=()=>{if(!$('dialog').open)close();};
  return {open,close};
 }
 const kinds=Object.freeze(Object.entries(formats).map(([value,format])=>Object.freeze({value,name:format.name,view:format.view,codec:format.codec||null})));
 const api={create,kinds};root.LibriumWSProfile=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
