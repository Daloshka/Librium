(function(root){
  'use strict';
  const TYPES={uint8:[1,'getUint8'],int8:[1,'getInt8'],uint16:[2,'getUint16'],int16:[2,'getInt16'],uint32:[4,'getUint32'],int32:[4,'getInt32'],uint64:[8,'getBigUint64'],int64:[8,'getBigInt64'],float32:[4,'getFloat32'],float64:[8,'getFloat64'],bytes:[null,null],utf8:[null,null]};
  const STORAGE_KEY='librium-ws-field-schemas-v1';
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  function keys(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('Неверные настройки схемы.');}
  function name(value,label){if(typeof value!=='string'||!value.trim()||Array.from(value.trim()).length>64)throw Error(label+': от 1 до 64 символов.');return value.trim();}
  function integer(value,label){
    if(typeof value==='string'){if(!/^(?:0x[0-9a-f]+|\d+)$/i.test(value.trim()))throw Error(label+': введи число или Hex, например 12 или 0x0c.');value=Number(value.trim());}
    if(!Number.isSafeInteger(value)||value<0||value>65536)throw Error(label+': число от 0 до 65536.');return value;
  }
  function field(input){
    keys(input,['name','offset','type','endian','length']);
    if(typeof input.type!=='string'||!Object.hasOwn(TYPES,input.type))throw Error('Выбери тип поля.');
    const offset=integer(input.offset,'Смещение'),type=input.type,width=TYPES[type][0]??integer(input.length,'Длина');
    if(width<1||offset>=65536)throw Error('Начало поля — от 0 до 65535; длина — от 1 до 65536 байт.');
    if(!['le','be'].includes(input.endian))throw Error('Выбери порядок байтов LE или BE.');
    return {name:name(input.name,'Имя поля'),offset,type,endian:width===1||TYPES[type][0]===null?'le':input.endian,...(TYPES[type][0]===null?{length:width}:{})};
  }
  function schema(input){
    keys(input,['name','fields']);
    if(!Array.isArray(input.fields)||input.fields.length>64)throw Error('В схеме может быть до 64 полей.');
    const fields=input.fields.map(field),seen=new Set();let total=0;
    for(const item of fields){if(seen.has(item.name))throw Error('Имена полей не должны повторяться.');seen.add(item.name);total+=TYPES[item.type][0]??item.length;}
    if(total>262144)throw Error('Суммарная длина полей должна быть не больше 256 КиБ.');
    return {name:name(input.name,'Имя схемы'),fields};
  }
  function presets(raw){
    if(raw===null)return [];
    if(typeof raw!=='string'||raw.length>500000)throw Error('Не удалось прочитать сохранённые схемы.');
    let data;try{data=JSON.parse(raw);}catch{throw Error('Не удалось прочитать сохранённые схемы.');}
    keys(data,['version','presets']);if(data.version!==1||!Array.isArray(data.presets)||data.presets.length>20)throw Error('Неверная версия или число сохранённых схем.');
    const result=data.presets.map(schema);if(new Set(result.map(item=>item.name)).size!==result.length)throw Error('Имена сохранённых схем повторяются.');return result;
  }
  function exportSchema(input){
    const encoded=JSON.stringify({version:1,schema:schema(input)},null,2);
    if(encoded.length>65536)throw Error('Схема слишком велика для переноса.');return encoded;
  }
  function importSchema(raw){
    if(typeof raw!=='string'||raw.length>65536)throw Error('JSON схемы слишком велик: максимум 65536 символов.');
    let data;try{data=JSON.parse(raw);}catch{throw Error('Неверный JSON схемы. Вставь результат кнопки «Копировать схему».');}
    keys(data,['version','schema']);if(data.version!==1)throw Error('Неподдерживаемая версия схемы.');
    const layout=schema(data.schema);
    for(const item of data.schema.fields)if(TYPES[item.type][0]!==null&&Object.hasOwn(item,'length'))throw Error('У числового поля длина определяется типом.');
    return layout;
  }
  function evaluate(input,payload){
    const layout=schema(input);
    if(!(payload?.bytes instanceof Uint8Array)||payload.bytes.length>65536||!Number.isSafeInteger(payload.size)||payload.size<payload.bytes.length||payload.truncated!==(payload.size>payload.bytes.length))throw Error('Неверные исходные байты.');
    return layout.fields.map(item=>{
      const width=TYPES[item.type][0]??item.length,end=item.offset+width,row={...item,width,status:'ok',value:null};
      if(end>payload.size)return {...row,status:'outside_message'};
      if(end>payload.bytes.length)return {...row,status:'not_saved'};
      const bytes=payload.bytes.subarray(item.offset,end);
      if(item.type==='bytes')row.value=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join(' ');
      else if(item.type==='utf8'){try{row.value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return {...row,status:'invalid_utf8'};}}
      else{const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length),value=view[TYPES[item.type][1]](0,item.endian==='le');row.value=Object.is(value,-0)?'-0':String(value);}
      return row;
    });
  }
  function compare(input,a,b){
    const old=evaluate(input,a),current=evaluate(input,b);
    return current.map((row,index)=>{
      const before=old[index];let comparison,bytesEqual=null;
      if(before.status==='not_saved'||row.status==='not_saved')comparison='unknown';
      else if(before.status==='outside_message'||row.status==='outside_message')comparison=before.status===row.status?'both_outside':before.status==='outside_message'?'old_outside':'current_outside';
      else{
        const left=a.bytes.subarray(row.offset,row.offset+row.width),right=b.bytes.subarray(row.offset,row.offset+row.width);bytesEqual=left.every((byte,n)=>byte===right[n]);
        if(before.status!=='ok'||row.status!=='ok')comparison=bytesEqual?'invalid_same_bytes':'invalid_changed_bytes';
        else comparison=before.value!==row.value?'changed_value':bytesEqual?'same':'same_value_changed_bytes';
      }
      return {before,current:row,comparison,bytesEqual};
    });
  }
  const COMPARISON={same:'Без изменений',changed_value:'Значение изменилось',same_value_changed_bytes:'Значение то же, байты изменились',unknown:'Сравнение неполное',both_outside:'Вне обоих сообщений',old_outside:'Вне образца',current_outside:'Вне текущего сообщения',invalid_same_bytes:'Байты те же, UTF-8 недоступен',invalid_changed_bytes:'Байты изменились, UTF-8 недоступен'};
  const STATUS={outside_message:'За пределами сообщения',not_saved:'Байты не сохранены',invalid_utf8:'Невалидный UTF-8'};
  function create({document:doc,storage,copy,currentSource,jump,find,values,baseline}){
    const $=id=>doc.getElementById(id),el=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    let state=null,lastDraft=null,importState=null,valuesState=null,valuesVersion=0;
    const active=source=>state?.source===source&&currentSource()===source&&$('ws-fields-dialog').open;
    function error(failure){$('ws-fields-error').textContent=failure.message;$('ws-fields-error').hidden=false;}
    function clearError(){$('ws-fields-error').hidden=true;$('ws-fields-error').textContent='';}
    function readPresets(){return presets(storage.getItem(STORAGE_KEY));}
    function writePresets(saved){const encoded=JSON.stringify({version:1,presets:saved});presets(encoded);storage.setItem(STORAGE_KEY,encoded);}
    function fillPresets(selected=''){
      const select=$('ws-fields-presets');select.replaceChildren();const empty=el('option','Новая / несохранённая схема');empty.value='';select.append(empty);
      for(const saved of readPresets()){const option=el('option',saved.name);option.value=saved.name;select.append(option);}select.value=selected;$('ws-fields-delete-schema').disabled=!select.value;
    }
    function resetEditor(){
      if(!state)return;state.edit=null;$('ws-fields-field-name').value='';$('ws-fields-offset').value=String(state.source.selection?.offset??0);$('ws-fields-type').value='uint16';$('ws-fields-endian').value='le';$('ws-fields-length').value='1';$('ws-fields-add').textContent='Добавить поле';$('ws-fields-cancel-edit').hidden=true;typeChanged();
    }
    function typeChanged(){const type=$('ws-fields-type').value,variable=TYPES[type]?.[0]===null;$('ws-fields-length-label').hidden=!variable;$('ws-fields-endian').disabled=variable||TYPES[type]?.[0]===1;}
    function draft(){if(state.edit!==null)throw Error('Сначала примени или отмени правку поля.');return schema({name:$('ws-fields-name').value,fields:state.fields});}
    function remember(){if(state)lastDraft={name:$('ws-fields-name').value,fields:state.fields.map(item=>({...item}))};}
    async function copyText(text,source,message='Скопировано'){
      const copyState=state,copyVersion=state?.renderVersion;try{if(text.length>500000)throw Error('Таблица слишком велика для копирования. Копируй значения отдельных полей.');await copy(text);if(state===copyState&&state?.renderVersion===copyVersion&&active(source))$('ws-fields-state').textContent=message;}catch(failure){if(state===copyState&&state?.renderVersion===copyVersion&&active(source))error(failure);}
    }
    function render(){
      if(!state)return;state.renderVersion=(state.renderVersion||0)+1;
      const source=state.source,layout={name:'Предпросмотр',fields:state.fields},candidate=baseline?.(),reference=state.reference,comparing=Boolean(reference),table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');
      $('ws-fields-dialog').classList.toggle('ws-fields-comparison-mode',comparing);$('ws-fields-compare-filter-label').hidden=!comparing;$('ws-fields-compare-filter').checked=state.onlyChanges;$('ws-fields-copy-table').title=comparing?'Все поля схемы, включая скрытые фильтром':'';state.comparisons=comparing?compare(layout,reference,source.payload):null;
      const rows=state.comparisons?state.comparisons.map(pair=>pair.current):evaluate(layout,source.payload);state.rows=rows;
      $('ws-fields-compare').disabled=!reference&&!['TEXT','BINARY'].includes(candidate?.kind);$('ws-fields-compare').textContent=comparing?'Вернуться к схеме':'Сравнить поля с образцом';
      const sample=reference??candidate;$('ws-fields-baseline').textContent=sample&&['TEXT','BINARY'].includes(sample.kind)?`${comparing?'Схема: '+$('ws-fields-name').value+' · ':''}Образец A: WS #${sample.id} · сообщение #${sample.messageId} · сохранено ${sample.bytes.length} из ${sample.size} Б${comparing?' · B — текущее сообщение; действия относятся к B':''}`:'Сначала выбери образец TEXT / BINARY в окне сообщения.';
      table.classList.toggle('ws-fields-comparing',comparing);
      for(const label of (comparing?['Поле','Смещение','Тип','Образец A','Текущее B','Сравнение','Действия']:['Поле','Смещение','Тип','Значение','Действия'])){const cell=el('th',label);cell.scope='col';header.append(cell);}head.append(header);table.append(head,body);
      let visible=0;for(const [index,row]of rows.entries()){
        if(comparing&&state.onlyChanges&&['same','both_outside'].includes(state.comparisons[index].comparison))continue;visible++;
        const tr=el('tr'),value=el('td'),actions=el('td'),preview=row.value===null?STATUS[row.status]:row.value===''?'(пустая строка)':Array.from(row.value).slice(0,160).join('')+(Array.from(row.value).length>160?'…':'');tr.dataset.fieldIndex=String(index);tr.dataset.fieldStatus=row.status;value.textContent=preview;value.className='ws-field-value';
        const endian=TYPES[row.type][0]>1?' '+row.endian.toUpperCase():'';tr.append(el('td',row.name),el('td',`${row.offset} · 0x${row.offset.toString(16)} · ${row.width} Б`),el('td',row.type+endian));
        if(comparing){
          const pair=state.comparisons[index],old=el('td'),chars=pair.before.value===null?[]:Array.from(pair.before.value),text=el('div',pair.before.value===null?STATUS[pair.before.status]:pair.before.value===''?'(пустая строка)':chars.slice(0,160).join('')+(chars.length>160?'…':''));text.className='ws-field-value ws-field-old-value';old.append(text);
          const copyOld=el('button','Копировать A');copyOld.className='ws-field-copy-old';copyOld.disabled=pair.before.value===null;copyOld.onclick=()=>copyText(pair.before.value,source);old.append(copyOld);tr.append(old,value,el('td',COMPARISON[pair.comparison]));tr.dataset.fieldComparison=pair.comparison;
        }else tr.append(value);
        value.classList.add('ws-field-current-value');tr.append(actions);
        const button=(label,className,action)=>{const node=el('button',label);node.className=className;node.onclick=action;actions.append(node);return node;};
        button('Копировать','ws-field-copy',()=>copyText(row.value,source)).disabled=row.value===null;
        button('Найти точно','ws-field-find',()=>{if(!active(source)||row.value===null||!find)return;const condition={type:row.type,offset:row.offset,endian:row.endian,...(TYPES[row.type][0]===null?{length:row.width}:{}),value:row.value};close();find(source,row.name,condition);}).disabled=row.value===null||!find;
        button('Значения','ws-field-values',()=>openValues(source,row)).disabled=!values;
        button('В Hex','ws-field-jump',()=>{if(!active(source))return;close();jump(source,row.offset,Math.min(row.width,source.payload.bytes.length-row.offset));}).disabled=row.offset>=source.payload.bytes.length;
        if(!comparing){button('Изменить','ws-field-edit',()=>{
          if(!active(source))return;state.edit=index;$('ws-fields-field-name').value=row.name;$('ws-fields-offset').value=String(row.offset);$('ws-fields-type').value=row.type;$('ws-fields-endian').value=row.endian;$('ws-fields-length').value=String(row.width);$('ws-fields-add').textContent='Применить поле';$('ws-fields-cancel-edit').hidden=false;typeChanged();$('ws-fields-field-name').focus();
        });
        button('Удалить','ws-field-remove',()=>{if(!active(source))return;state.fields.splice(index,1);resetEditor();changed();});}body.append(tr);
      }
      $('ws-fields-content').replaceChildren(rows.length?table:el('p',comparing?'В схеме нет полей. Вернись к схеме, чтобы добавить их.':'Добавь поле: имя, смещение от начала сообщения и тип. Например, код команды — uint16 с байта 0.'));if(comparing&&rows.length&&!visible)$('ws-fields-content').append(el('p','Нет полей для выбранного фильтра. Отключи его, чтобы увидеть всю схему.'));
      $('ws-fields-copy-table').disabled=!rows.length;$('ws-fields-state').textContent=comparing?`Сравнение: показано ${visible} из ${rows.length} полей · значений изменилось: ${state.comparisons.filter(row=>row.comparison==='changed_value').length} · байтовых отличий: ${state.comparisons.filter(row=>row.bytesEqual===false).length} · неполных: ${state.comparisons.filter(row=>row.comparison==='unknown').length} · вне границ: ${state.comparisons.filter(row=>row.comparison.includes('outside')).length}`:`Полей: ${rows.length} · прочитано: ${rows.filter(row=>row.status==='ok').length} · недоступно: ${rows.filter(row=>row.status!=='ok').length}`;
    }
    function changed(){remember();clearError();render();$('ws-fields-state').textContent+=' · изменения не сохранены';}
    function close(){closeValues();closeImport();remember();state=null;$('ws-fields-dialog').classList.remove('ws-fields-comparison-mode');if($('ws-fields-dialog').open)$('ws-fields-dialog').close();$('ws-fields-content').replaceChildren();$('ws-fields-error').hidden=true;}
    function open(source,range=null){
      let selected=null;
      if(range!==null){
        keys(range,['offset','length']);
        if(!Number.isSafeInteger(range.offset)||!Number.isSafeInteger(range.length))throw Error('Неверный участок для нового поля.');
        selected=field({name:'Участок',offset:range.offset,type:'bytes',endian:'le',length:range.length});
        if(!['TEXT','BINARY'].includes(source?.message?.kind)||evaluate({name:'Участок',fields:[selected]},source?.payload)[0].status!=='ok')throw Error('Участок должен целиком находиться в сохранённых исходных байтах.');
      }
      close();if(!source?.payload||!['TEXT','BINARY'].includes(source.message?.kind))return;
      state={source,fields:[],rows:[],edit:null,reference:null,onlyChanges:true};clearError();
      let initial=lastDraft;
      try{const saved=readPresets();initial=initial??saved[0]??{name:'Мой протокол',fields:[]};fillPresets(saved.some(item=>item.name===initial.name)?initial.name:'');}catch(failure){error(failure);$('ws-fields-presets').replaceChildren();$('ws-fields-delete-schema').disabled=true;}
      initial=initial??{name:'Мой протокол',fields:[]};state.fields=initial.fields.map(item=>({...item}));$('ws-fields-name').value=initial.name;
      $('ws-fields-meta').textContent=`WS #${source.id} · сообщение #${source.messageId} · исходные байты · сохранено ${source.payload.bytes.length} из ${source.payload.size} Б`;
      resetEditor();render();
      if(selected){$('ws-fields-offset').value=String(selected.offset);$('ws-fields-type').value='bytes';$('ws-fields-length').value=String(selected.length);typeChanged();$('ws-fields-state').textContent=`Выбранный участок: смещение ${selected.offset}, ${selected.length} Б. Задай имя и тип, затем нажми «Добавить поле». Схема пока не изменена.`;}
      $('ws-fields-dialog').showModal();if(selected)$('ws-fields-field-name').focus();
    }
    function resetComparison(){if(state){state.reference=null;render();}}
    $('ws-fields-compare-filter').onchange=()=>{if(state){state.onlyChanges=$('ws-fields-compare-filter').checked;render();}};
    $('ws-fields-compare').onclick=()=>{
      if(!state)return;try{if(state.reference)state.reference=null;else{const selected=baseline?.();if(!selected||!['TEXT','BINARY'].includes(selected.kind))return;evaluate({name:'Образец',fields:[]},selected);state.reference={...selected,bytes:new Uint8Array(selected.bytes)};state.onlyChanges=true;}clearError();render();}catch(failure){error(failure);}
    };
    function closeValues(){++valuesVersion;valuesState=null;if($('ws-field-values-dialog').open)$('ws-field-values-dialog').close();$('ws-field-values-content').replaceChildren();$('ws-field-values-error').hidden=true;}
    function openValues(source,row){
      if(!active(source)||!values)return;closeValues();closeImport();valuesState={source,name:row.name,definition:{type:row.type,offset:row.offset,endian:row.endian,...(TYPES[row.type][0]===null?{length:row.width}:{})}};
      $('ws-field-values-meta').textContent=`WS #${source.id} · ${row.name} · ${row.type} ${row.endian.toUpperCase()} @ ${row.offset} · ${row.width} Б`;
      $('ws-field-values-dialog').showModal();loadValues();
    }
    async function loadValues(){
      const view=valuesState;if(!view)return;const version=++valuesVersion,valid=()=>valuesState===view&&valuesVersion===version&&active(view.source)&&$('ws-field-values-dialog').open;
      $('ws-field-values-content').replaceChildren();$('ws-field-values-error').hidden=true;$('ws-field-values-refresh').disabled=true;$('ws-field-values-state').textContent='Считаем значения поля по всей записи…';
      try{
        const data=await values(view.source,view.definition);if(!valid())return;
        if(data.id!==view.source.id||!data.field||['type','offset','endian'].some(key=>data.field[key]!==view.definition[key])||(data.field.length??null)!==(view.definition.length??null)||!Array.isArray(data.rows)||data.rows.length>100||['total','matched','excluded','distinct','other'].some(key=>!Number.isSafeInteger(data[key])||data[key]<0)||data.matched+data.excluded!==data.total)throw Error('Неверная сводка значений поля.');
        const table=el('table'),head=el('thead'),header=el('tr'),body=el('tbody');for(const label of ['Значение','Всего','Отправлено','Получено','Действия']){const cell=el('th',label);cell.scope='col';header.append(cell);}head.append(header);table.append(head,body);
        for(const row of data.rows){
          if(typeof row.base64!=='string'||row.base64.length>87384||['count','sent','received'].some(key=>!Number.isSafeInteger(row[key])||row[key]<0)||row.count!==row.sent+row.received)throw Error('Неверное значение поля в сводке.');
          const binary=atob(row.base64);if(btoa(binary)!==row.base64)throw Error('Неверные байты поля в сводке.');const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
          const definition=field({name:'value',...view.definition,offset:0}),width=TYPES[definition.type][0]??definition.length;if(bytes.length!==width)throw Error('Неверная длина поля в сводке.');
          const decoded=evaluate({name:'values',fields:[definition]},{bytes,size:bytes.length,truncated:false})[0];if(decoded.status!=='ok')throw Error('Значение поля не удалось прочитать.');
          const text=decoded.value,display=view.definition.type==='utf8'?JSON.stringify(text):text,chars=Array.from(display),tr=el('tr'),value=el('td',text===''?'(пустая строка)':chars.slice(0,160).join('')+(chars.length>160?'…':'')),actions=el('td');value.className='ws-field-value';tr.append(value);for(const key of ['count','sent','received'])tr.append(el('td',String(row[key])));
          const copyButton=el('button','Копировать'),findButton=el('button','Найти точно');copyButton.className='ws-field-value-copy';findButton.className='ws-field-value-find';findButton.disabled=!find;
          copyButton.onclick=async()=>{try{await copy(text);if(valid())$('ws-field-values-state').textContent=view.summary+' · значение скопировано';}catch(failure){if(valid()){$('ws-field-values-error').textContent=failure.message;$('ws-field-values-error').hidden=false;}}};
          findButton.onclick=()=>{if(!valid()||!find)return;const source=view.source,condition={...view.definition,value:text},name=view.name;close();find(source,name,condition);};actions.append(copyButton,findButton);tr.append(actions);body.append(tr);
        }
        $('ws-field-values-content').replaceChildren(data.rows.length?table:el('p','Полные значения выбранного поля не найдены.'));
        view.summary=`Сообщений: ${data.total} · учтено: ${data.matched} · исключено: ${data.excluded} · разных значений: ${data.distinct} · сообщений вне списка: ${data.other}`;$('ws-field-values-state').textContent=view.summary;
      }catch(failure){if(valid()){$('ws-field-values-state').textContent='Сводка не загружена';$('ws-field-values-error').textContent=failure.message.includes('404')?'Соединение удалено из истории или недоступно.':failure.message;$('ws-field-values-error').hidden=false;}}
      finally{if(valid())$('ws-field-values-refresh').disabled=false;}
    }
    $('ws-field-values-close').onclick=closeValues;$('ws-field-values-refresh').onclick=loadValues;$('ws-field-values-dialog').onclose=()=>{if(!$('ws-field-values-dialog').open)closeValues();};
    function closeImport(){importState=null;if($('ws-fields-import-dialog').open)$('ws-fields-import-dialog').close();$('ws-fields-import-json').value='';$('ws-fields-import-error').textContent='';$('ws-fields-import-error').hidden=true;$('ws-fields-import-json').removeAttribute('aria-invalid');}
    $('ws-fields-copy-schema').onclick=()=>{
      if(!state)return;try{const encoded=exportSchema(draft());clearError();copyText(encoded,state.source,'Схема скопирована в JSON — без значений сообщения.');}catch(failure){error(failure);}
    };
    $('ws-fields-import-open').onclick=()=>{
      if(!state||!active(state.source))return;closeValues();closeImport();importState=state;$('ws-fields-import-dialog').showModal();$('ws-fields-import-json').focus();
    };
    $('ws-fields-import-cancel').onclick=closeImport;
    $('ws-fields-import-dialog').onclose=()=>{if(!$('ws-fields-import-dialog').open)closeImport();};
    $('ws-fields-import-json').oninput=()=>{$('ws-fields-import-error').hidden=true;$('ws-fields-import-json').removeAttribute('aria-invalid');};
    $('ws-fields-import-apply').onclick=()=>{
      if(!state||state!==importState||!active(state.source))return;
      try{
        const layout=importSchema($('ws-fields-import-json').value);evaluate(layout,state.source.payload);
        state.fields=layout.fields;$('ws-fields-name').value=layout.name;$('ws-fields-presets').value='';$('ws-fields-delete-schema').disabled=true;
        resetEditor();remember();clearError();render();closeImport();$('ws-fields-state').textContent+=' · схема импортирована в черновик; сохрани её для следующих запусков';
      }catch(failure){$('ws-fields-import-error').textContent=failure.message;$('ws-fields-import-error').hidden=false;$('ws-fields-import-json').setAttribute('aria-invalid','true');}
    };
    for(const type of Object.keys(TYPES)){const option=el('option',type);option.value=type;$('ws-fields-type').append(option);}
    $('ws-fields-type').onchange=typeChanged;$('ws-fields-close').onclick=close;$('ws-fields-dialog').onclose=()=>{if(!$('ws-fields-dialog').open)close();};$('ws-fields-cancel-edit').onclick=resetEditor;
    $('ws-fields-form').onsubmit=event=>{
      event.preventDefault();if(!state)return;
      try{
        const item=field({name:$('ws-fields-field-name').value,offset:$('ws-fields-offset').value,type:$('ws-fields-type').value,endian:$('ws-fields-endian').value,length:$('ws-fields-length').value}),next=state.fields.slice();
        if(state.edit===null)next.push(item);else next[state.edit]=item;schema({name:'Предпросмотр',fields:next});state.fields=next;resetEditor();changed();
      }catch(failure){error(failure);}
    };
    $('ws-fields-name').oninput=()=>{if(state){remember();$('ws-fields-state').textContent='Имя изменено — сохрани схему.';}};
    $('ws-fields-presets').onchange=()=>{
      if(!state)return;try{const selected=$('ws-fields-presets').value,saved=readPresets(),layout=selected?saved.find(item=>item.name===selected):{name:'Мой протокол',fields:[]};if(!layout)throw Error('Схема больше не доступна.');state.fields=layout.fields.map(item=>({...item}));$('ws-fields-name').value=layout.name;$('ws-fields-delete-schema').disabled=!selected;resetEditor();remember();clearError();render();}catch(failure){error(failure);}
    };
    $('ws-fields-save-schema').onclick=()=>{
      if(!state)return;try{const layout=draft(),saved=readPresets(),index=saved.findIndex(item=>item.name===layout.name);if(index<0){if(saved.length>=20)throw Error('Можно сохранить до 20 схем. Удали ненужную схему.');saved.push(layout);}else saved[index]=layout;writePresets(saved);fillPresets(layout.name);remember();clearError();$('ws-fields-state').textContent='Схема сохранена на этом устройстве.';}catch(failure){error(failure);}
    };
    $('ws-fields-delete-schema').onclick=()=>{
      if(!state||!$('ws-fields-presets').value)return;try{const selected=$('ws-fields-presets').value,saved=readPresets().filter(item=>item.name!==selected);writePresets(saved);fillPresets();clearError();$('ws-fields-state').textContent='Сохранённая схема удалена. Поля остались в черновике.';}catch(failure){error(failure);}
    };
    $('ws-fields-copy-table').onclick=()=>{
      if(!state)return;const lines=[`WS #${state.source.id} · сообщение #${state.source.messageId} · исходные байты`,'Имя\tСмещение\tТип\tПорядок\tБайт\tСтатус\tЗначение'];
      if(state.reference){lines[0]+=`\nОбразец A: WS #${state.reference.id} · сообщение #${state.reference.messageId}`;lines[1]='Имя\tСмещение\tТип\tПорядок\tБайт\tСравнение\tСтатус A\tЗначение A\tСтатус B\tЗначение B';}
      for(const [index,row]of state.rows.entries()){const start=[JSON.stringify(row.name),row.offset,row.type,TYPES[row.type][0]>1?row.endian.toUpperCase():'—',row.width],pair=state.comparisons?.[index];lines.push([...start,...(pair?[pair.comparison,pair.before.status,JSON.stringify(pair.before.value),row.status,JSON.stringify(row.value)]:[row.status,JSON.stringify(row.value)])].join('\t'));}copyText(lines.join('\n'),state.source);
    };
    return {open,close,resetComparison};
  }
  const api={TYPES,STORAGE_KEY,field,schema,presets,exportSchema,importSchema,evaluate,compare,create};root.LibriumWSFields=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
