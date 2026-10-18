(function(root){
  'use strict';
  const STORAGE_KEY='librium-ws-signatures-v1',KINDS=['','DATA','CONTROL','TEXT','BINARY','PING','PONG','CLOSE','CONTINUATION'],DIRECTIONS=['','sent','received'];
  function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('Неверные настройки сигнатуры.');}
  function signature(value){
    keys(value,['name','pattern','kind','direction']);
    if(typeof value.name!=='string'||!value.name.trim()||Array.from(value.name.trim()).length>64)throw Error('Имя сигнатуры: от 1 до 64 символов.');
    if(typeof value.pattern!=='string')throw Error('Введи Hex-маску.');
    const pattern=root.LibriumWS.normalizeHexMask(value.pattern);if(!pattern)throw Error('Введи непустую Hex-маску.');
    if(!KINDS.includes(value.kind)||!DIRECTIONS.includes(value.direction))throw Error('Выбери тип и направление сообщений.');
    return {name:value.name.trim(),pattern,kind:value.kind,direction:value.direction};
  }
  function presets(raw){
    if(raw===null)return [];if(typeof raw!=='string'||raw.length>65536)throw Error('Сохранённые сигнатуры слишком велики.');
    let data;try{data=JSON.parse(raw);}catch{throw Error('Не удалось прочитать сохранённые сигнатуры.');}
    keys(data,['version','presets']);if(data.version!==1||!Array.isArray(data.presets)||data.presets.length>20)throw Error('Неверная версия или число сигнатур.');
    const result=data.presets.map(signature);if(new Set(result.map(item=>item.name)).size!==result.length)throw Error('Имена сигнатур повторяются.');return result;
  }
  function create({document:doc,storage,currentConnection,apply}){
    const $=id=>doc.getElementById('ws-signatures-'+id);let state=null;
    const error=failure=>{$('error').textContent=failure.message;$('error').hidden=false;};
    const clearError=()=>{$('error').textContent='';$('error').hidden=true;};
    const read=()=>presets(storage.getItem(STORAGE_KEY));
    function write(list){const encoded=JSON.stringify({version:1,presets:list});presets(encoded);storage.setItem(STORAGE_KEY,encoded);}
    function form(){return signature({name:$('name').value,pattern:$('pattern').value,kind:$('kind').value,direction:$('direction').value});}
    function fillForm(value){$('name').value=value.name;$('pattern').value=value.pattern;$('kind').value=value.kind;$('direction').value=value.direction;}
    function fill(list,selected=''){
      $('presets').replaceChildren();for(const item of [{name:'Новая сигнатура',value:''},...list.map(value=>({name:value.name,value:value.name}))]){const option=doc.createElement('option');option.value=item.value;option.textContent=item.name;$('presets').append(option);}
      $('presets').value=selected;$('delete').disabled=!selected;
    }
    function close(){state=null;if($('dialog').open)$('dialog').close();fillForm({name:'',pattern:'',kind:'',direction:''});$('presets').replaceChildren();$('delete').disabled=true;$('scope').textContent='';$('state').textContent='';clearError();}
    function open({id,pattern='',kind='',direction=''}){
      if(!Number.isSafeInteger(id)||id<1)throw Error('Выбери соединение WebSocket.');
      close();state={id,initial:{name:'',pattern,kind:KINDS.includes(kind)?kind:'',direction:DIRECTIONS.includes(direction)?direction:''}};fillForm(state.initial);$('scope').textContent=`Применить к WS #${id}. Сигнатуры можно использовать в других соединениях.`;
      try{fill(read());}catch(failure){fill([]);error(failure);}
      $('dialog').showModal();$('name').focus();
    }
    $('presets').onchange=()=>{if(!state)return;try{const selected=$('presets').value,value=selected?read().find(item=>item.name===selected):state.initial;if(!value)throw Error('Сигнатура уже удалена. Открой список заново.');fillForm(value);$('delete').disabled=!selected;$('state').textContent='';clearError();}catch(failure){error(failure);}};
    $('form').onsubmit=event=>{
      event.preventDefault();if(!state)return;try{const value=form(),list=read(),index=list.findIndex(item=>item.name===value.name);
        if(index>=0&&$('presets').value!==value.name)throw Error('Имя занято. Выбери эту сигнатуру в списке, чтобы заменить её.');
        if(index<0){if(list.length>=20)throw Error('Можно сохранить до 20 сигнатур. Удали ненужную.');list.push(value);}else list[index]=value;
        write(list);fill(list,value.name);fillForm(value);clearError();$('state').textContent='Сигнатура сохранена на этом устройстве.';
      }catch(failure){error(failure);}
    };
    $('delete').onclick=()=>{if(!state||!$('presets').value)return;try{const selected=$('presets').value,list=read();if(!list.some(item=>item.name===selected))throw Error('Сигнатура уже удалена.');write(list.filter(item=>item.name!==selected));fill(list.filter(item=>item.name!==selected));clearError();$('state').textContent='Сигнатура удалена. Настройки остались в форме.';}catch(failure){error(failure);}};
    $('apply').onclick=()=>{if(!state)return;try{if(currentConnection()!==state.id)throw Error('Соединение изменилось. Открой сигнатуры для выбранного WebSocket.');const value=form(),id=state.id;apply(value,id);close();}catch(failure){error(failure);}};
    $('close').onclick=close;$('dialog').onclose=()=>{if(!$('dialog').open)close();};
    return {open,close};
  }
  const api={STORAGE_KEY,signature,presets,create};root.LibriumWSSignatures=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
