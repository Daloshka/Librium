(function(root){
  'use strict';
  function create({document:doc,request,apply}){
    const $=id=>doc.getElementById('capture-contexts-'+id),el=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    let view=null,data=null,version=0,busy=false,pending=null;
    const active=job=>view===job.view&&version===job.version&&$('dialog').open;
    const time=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('ru-RU'):'Время недоступно';};
    const count=value=>Number(value).toLocaleString('ru-RU');
    function controls(){const ready=Boolean(view&&data&&!busy&&!pending);$('prev').disabled=!ready||view.page===0;$('next').disabled=!ready||!data.older;$('refresh').disabled=busy&&!pending;}
    function close(){++version;view=null;data=null;pending=null;if($('dialog').open)$('dialog').close();$('content').replaceChildren();$('state').textContent='';$('page').textContent='';$('error').hidden=true;controls();}
    function render(job,result){
      if(!result||!Array.isArray(result.contexts)||result.contexts.length>100)throw Error('Ядро вернуло неверный список окон и потоков.');
      data=result;view.through=result.through;
      $('state').textContent=`Окон и потоков: ${count(result.matched)} / ${count(result.total)} · без контекста: ${count(result.without_context)} записей.`;
      $('page').textContent=`Страница ${view.page+1} · снимок архива`;
      const table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');table.className='capture-contexts-table';
      for(const text of ['Окно / поток','Источник','HTTP','WebSocket','Последняя запись','']){const cell=el('th',text);cell.scope='col';header.append(cell);}head.append(header);table.append(head,body);
      for(const row of result.contexts){
        const tr=el('tr'),name=el('td'),label=row.label||'Контекст захвата';name.append(el('strong',label));const first=el('small',`Первая запись: ${time(row.first_time)} · всего ${count(row.total)}`);name.append(first);
        const source=el('td',({proxy:'Прокси',external:'Адаптер',cdp_node:'Node.js',cdp_chromium:'Окна'})[row.source]||'Не указан');source.title='Источник последней записи';
        const action=el('button','Выбрать');action.type='button';action.title='Только этот контекст подключения';action.onclick=()=>{if(!active(job)||data!==result||busy||!$('content').contains(action))return;try{apply({id:row.id,label});close();}catch(error){$('error').textContent=error.message;$('error').hidden=false;}};
        const cell=el('td');cell.append(action);tr.append(name,source,el('td',count(row.http)),el('td',count(row.ws)),el('td',time(row.last_time)),cell);body.append(tr);
      }
      $('content').replaceChildren(result.contexts.length?table:el('p',result.matched?'На этой странице нет записей.':result.total?'Совпадений по последнему названию не найдено.':result.without_context?'В записях не указаны окно или поток. Подключи источник приложения, чтобы записать новые контексты.':'Записанных окон и потоков пока нет. Подключи приложение, выполни сетевое действие и обнови список.'));
    }
    async function pump(){
      if(busy||!pending)return;const job=pending;pending=null;busy=true;controls();
      try{const result=await request('capture-contexts?q='+encodeURIComponent(JSON.stringify(job.query)));if(active(job))render(job,result);}
      catch(error){if(active(job)){$('error').textContent=error.message;$('error').hidden=false;$('state').textContent='Не удалось прочитать архив. Нажми «Обновить», чтобы повторить.';}}
      finally{busy=false;if(pending)void pump();else controls();}
    }
    function read(){const job={view,version:++version,query:{search:view.search,before:view.cursors[view.page],through:view.through}};pending=job;data=null;$('content').replaceChildren();$('error').hidden=true;$('state').textContent='Читаем окна и потоки из архива…';$('page').textContent='';controls();void pump();}
    function refresh(){
      if(!$('dialog').open)return;
      const search=$('search').value.trim();if(Array.from(search).length>256){$('error').textContent='Название: до 256 символов.';$('error').hidden=false;return;}
      view={search,page:0,cursors:[null],through:null};read();
    }
    function open(){close();$('search').value='';$('dialog').showModal();refresh();}
    $('form').onsubmit=event=>{event.preventDefault();refresh();};$('refresh').onclick=refresh;
    $('prev').onclick=()=>{if(!view||busy||!data||view.page===0)return;view.page--;read();};
    $('next').onclick=()=>{if(!view||busy||!data?.older)return;view.cursors[++view.page]=data.next_before;read();};
    $('close').onclick=close;$('dialog').onclose=()=>{if(!$('dialog').open)close();};
    return {open,close};
  }
  const api={create};root.LibriumCaptureContexts=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
