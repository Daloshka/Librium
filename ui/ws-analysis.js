(function(root){
  // Display decoder: preserve values JSON cannot represent with explicit tags.
  // Never infer MessagePack from arbitrary binary data.
  function messagePack(bytes){
    if(bytes.length>65536)throw Error('Превышен лимит 64 КиБ');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=0,nodes=0;
    const need=n=>{if(n>bytes.length-offset)throw Error('Недостаточно байтов: смещение '+offset);};
    const take=n=>{need(n);const value=bytes.subarray(offset,offset+n);offset+=n;return value;};
    const number=(n,method)=>{need(n);const value=view[method](offset,false);offset+=n;return value;};
    const u8=()=>number(1,'getUint8'),u16=()=>number(2,'getUint16'),u32=()=>number(4,'getUint32');
    const hex=value=>Array.from(value,b=>b.toString(16).padStart(2,'0')).join('');
    const string=n=>{const value=take(n);try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);}catch{return {$stringBytes:hex(value)};}};
    const binary=n=>({$binary:hex(take(n))});
    const extension=n=>{const type=number(1,'getInt8');return {$extension:{type,hex:hex(take(n))}};};
    const integer=method=>{const value=number(8,method);return value>=BigInt(Number.MIN_SAFE_INTEGER)&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):{$integer:value.toString()};};
    const float=(n,method)=>{const value=number(n,method);return Number.isFinite(value)?Object.is(value,-0)?{$float:'-0'}:value:{$float:String(value)};};
    function array(n,depth){if(n>10000-nodes)throw Error('Лимит 10000 значений');const result=[];for(let i=0;i<n;i++)result.push(read(depth+1));return result;}
    function map(n,depth){
      if(n>(10000-nodes)/2)throw Error('Лимит 10000 значений');
      const pairs=[],object=Object.create(null);let plain=true;
      for(let i=0;i<n;i++){const key=read(depth+1),value=read(depth+1);pairs.push([key,value]);if(typeof key!=='string'||Object.hasOwn(object,key))plain=false;else object[key]=value;}
      return plain?object:{$map:pairs};
    }
    function read(depth){
      if(depth>64)throw Error('Лимит вложенности 64');if(++nodes>10000)throw Error('Лимит 10000 значений');
      const tag=u8();if(tag<=0x7f)return tag;if(tag>=0xe0)return tag-256;
      if(tag>=0xa0&&tag<=0xbf)return string(tag&31);
      if(tag>=0x90&&tag<=0x9f)return array(tag&15,depth);
      if(tag>=0x80&&tag<=0x8f)return map(tag&15,depth);
      switch(tag){
        case 0xc0:return null;case 0xc2:return false;case 0xc3:return true;
        case 0xc4:return binary(u8());case 0xc5:return binary(u16());case 0xc6:return binary(u32());
        case 0xc7:return extension(u8());case 0xc8:return extension(u16());case 0xc9:return extension(u32());
        case 0xca:return float(4,'getFloat32');case 0xcb:return float(8,'getFloat64');
        case 0xcc:return u8();case 0xcd:return u16();case 0xce:return u32();case 0xcf:return integer('getBigUint64');
        case 0xd0:return number(1,'getInt8');case 0xd1:return number(2,'getInt16');case 0xd2:return number(4,'getInt32');case 0xd3:return integer('getBigInt64');
        case 0xd4:return extension(1);case 0xd5:return extension(2);case 0xd6:return extension(4);case 0xd7:return extension(8);case 0xd8:return extension(16);
        case 0xd9:return string(u8());case 0xda:return string(u16());case 0xdb:return string(u32());
        case 0xdc:return array(u16(),depth);case 0xdd:return array(u32(),depth);
        case 0xde:return map(u16(),depth);case 0xdf:return map(u32(),depth);
        default:throw Error('Зарезервированный код 0x'+tag.toString(16));
      }
    }
    const result=read(0);if(offset!==bytes.length)throw Error('Лишние байты после значения: '+(bytes.length-offset));return result;
  }
  // Schema-free wire view: LEN bytes are not guessed as nested / packed data.
  function protobuf(bytes){
    if(bytes.length>65536)throw Error('Превышен лимит 64 КиБ');
    let offset=0,nodes=0;
    const take=n=>{if(n>bytes.length-offset)throw Error('Недостаточно байтов: смещение '+offset);const data=bytes.subarray(offset,offset+n);offset+=n;return data;};
    const varint=()=>{let value=0n;for(let i=0;i<10;i++){const b=take(1)[0];if(i===9&&b>1)throw Error('Переполнение varint');value|=BigInt(b&127)<<BigInt(i*7);if(!(b&128))return value;}throw Error('Незавершённый varint');};
    const hex=data=>Array.from(data,b=>b.toString(16).padStart(2,'0')).join('');
    function fields(depth,group){
      if(depth>64)throw Error('Лимит вложенности 64');const result=[];
      while(offset<bytes.length){
        const start=offset,tag=varint(),field=Number(tag>>3n),wire=Number(tag&7n);
        if(field<1||field>536870911)throw Error('Неверный номер поля');
        if(wire===4){if(group!==field)throw Error('Неверное завершение группы');return result;}
        if(++nodes>10000)throw Error('Лимит 10000 полей');
        const row={offset:start,field,wire:['VARINT','I64','LEN','SGROUP','EGROUP','I32'][wire]};
        if(wire===0)row.value=varint().toString();
        else if(wire===1||wire===5)row.hex=hex(take(wire===1?8:4));
        else if(wire===2){const size=varint();if(size>BigInt(bytes.length-offset))throw Error('Неверная длина поля');const data=take(Number(size));row.hex=hex(data);try{row.utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch{}}
        else if(wire===3)row.fields=fields(depth+1,field);
        else throw Error('Неверный wire type');
        result.push(row);
      }
      if(group!==undefined)throw Error('Незавершённая группа');return result;
    }
    return fields(0);
  }
  function normalizeHex(query){
    const digits=query.replace(/[ \t\n\r\v\f]/g,'');
    if(query.length>4096||digits.length%2||!/^[0-9a-f]*$/i.test(digits))throw Error('Введи пары шестнадцатеричных цифр, например: 00 ff 2a. Пробелы между байтами необязательны.');
    return digits.toLowerCase();
  }
  function normalizeHexMask(query){
    let digits=query.replace(/[ \t\n\r\v\f]/g,'');let anchor=null;
    const invalid=()=>Error('Маска до 256 байтов: 01 ?? ff. Для точного смещения: @12: 01 ?? ff или @0x0c: 01 ?? ff.');
    if(query.length>4096)throw invalid();
    if(digits.startsWith('@')){const colon=digits.indexOf(':'),literal=digits.slice(1,colon);if(colon<0||!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(literal))throw invalid();anchor=Number.parseInt(literal,/^0x/i.test(literal)?16:10);digits=digits.slice(colon+1);if(!Number.isSafeInteger(anchor)||anchor<0||anchor>=65536||!digits)throw invalid();}
    if(digits.length>512||!/^(?:[0-9a-f]{2}|\?\?)*$/i.test(digits)||anchor!==null&&anchor+digits.length/2>65536)throw invalid();
    return (anchor===null?'':'@'+anchor+':')+digits.toLowerCase();
  }
  function normalizeCdpId(query){
    const value=query.replace(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/g,'');
    if(query.length>4096||value&&!/^[0-9]+$/.test(value)||value&&BigInt(value)>9007199254740991n)throw Error('Введи целый CDP ID от 0 до 9007199254740991, например: 17.');
    return value?BigInt(value).toString():'';
  }
  function validateJsonPointer(pointer){
    let bytes=0;
    for(const c of pointer){const n=c.codePointAt(0);if(n>=0xd800&&n<=0xdfff)throw Error('Путь JSON содержит неполный Unicode-символ.');bytes+=n<128?1:n<2048?2:n<65536?3:4;}
    if(bytes>2048||pointer&&!pointer.startsWith('/')||pointer.split('/').length-1>64||/~(?![01])/.test(pointer))throw Error('Путь JSON: пустое поле — весь JSON; например /params/state или /items/0/type. Для символов / и ~ в имени используй ~1 и ~0. Лимит: 2048 байт, 64 части.');
    return pointer;
  }
  function pretty(text){
    try{
      let keepSource=false;
      const value=JSON.parse(text,function(_key,value,context){
        if(typeof value==='number'){
          if(typeof JSON.rawJSON==='function'&&typeof context?.source==='string')return JSON.rawJSON(context.source);
          // Older engines cannot reliably recover a numeric token after parsing.
          // Retain the source rather than displaying a rounded identifier.
          keepSource=true;
        }
        return value;
      });
      return {text:keepSource?text:JSON.stringify(value,null,2),format:'JSON'};
    }catch{return null;}
  }
  // JSON.parse has already checked syntax. Scan the raw member names before
  // interpreting an envelope, because JSON.parse keeps only the last duplicate.
  // Payload containers are skipped iteratively, not recursively interpreted.
  function checkRpcMembers(text){
    const space=i=>{while(/[\x20\t\r\n]/.test(text[i]||'x'))i++;return i;};
    const stringEnd=start=>{let i=start+1;while(i<text.length){if(text[i]==='\\')i+=2;else if(text[i++]==='"')return i;}throw Error('Неверный JSON.');};
    function skip(start){
      let i=space(start);if(text[i]==='"')return stringEnd(i);
      if(text[i]!=='{'&&text[i]!=='['){while(i<text.length&&!/[\x20\t\r\n,\]}]/.test(text[i]))i++;return i;}
      let depth=0;do{const c=text[i];if(c==='"'){i=stringEnd(i);continue;}if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;i++;}while(depth&&i<text.length);return i;
    }
    function object(start,error=false){
      let i=space(start);if(text[i]!=='{')return skip(i);i=space(i+1);const keys=new Set();
      while(text[i]!=='}'){
        const end=stringEnd(i),key=JSON.parse(text.slice(i,end));
        if(keys.has(key))throw Error('Повторяющееся поле '+JSON.stringify(key)+' в '+(error?'объекте error':'конверте')+'. Значение неоднозначно.');keys.add(key);
        i=space(space(end)+1);i=space(!error&&key==='error'?object(i,true):skip(i));if(text[i]===',')i=space(i+1);else break;
      }
      return i+1;
    }
    let i=space(0);if(text[i]!=='['){object(i);return;}i=space(i+1);
    while(text[i]!==']'){i=space(object(i));if(text[i]===',')i=space(i+1);else break;}
  }
  // Explicit envelope views: never infer a protocol from an arbitrary JSON body.
  // Keep the original JSON lexemes, including integers outside JS precision.
  function rpcView(message,mode){
    const protocol=mode==='cdp'?'CDP':'JSON-RPC 2.0';
    const failure=reason=>({format:protocol+' / разбор недоступен',text:reason+' Исходные данные доступны в «Исходное» и Hex.'});
    if(message.truncated)return failure('Сообщение сохранено не полностью.');
    if(!['TEXT','BINARY'].includes(message.kind))return failure('Нужны текстовые данные JSON.');
    let text=message.text;
    try{
      if(message.kind==='BINARY')text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Uint8Array.from(atob(message.base64),c=>c.charCodeAt(0)));
      if(typeof text!=='string'||text.length>65536)throw Error('Лимит 64 КиБ текста.');
      const numericIds=new WeakMap();
      const rootValue=JSON.parse(text,function(key,value,context){if(key==='id'&&typeof value==='number'&&context?.source)numericIds.set(this,context.source);return value;}),object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
      checkRpcMembers(text);
      const batch=Array.isArray(rootValue);
      if(batch&&(mode==='cdp'||!rootValue.length||rootValue.length>256))throw Error('Пакет JSON-RPC должен содержать от 1 до 256 элементов; CDP принимает один объект.');
      const items=batch?rootValue:[rootValue],lines=[];
      for(const [index,value]of items.entries()){
        if(!object(value))throw Error('Элемент '+(index+1)+': нужен объект.');
        const has=key=>Object.hasOwn(value,key),hasId=has('id');
        if(mode==='jsonrpc'&&value.jsonrpc!=='2.0')throw Error('Нет версии jsonrpc: "2.0".');
        if(mode==='cdp'&&has('jsonrpc'))throw Error('Для jsonrpc выбери JSON-RPC 2.0.');
        if(hasId&&!(mode==='cdp'?Number.isSafeInteger(value.id)&&value.id>=0:value.id===null||typeof value.id==='string'||(typeof value.id==='number'&&(numericIds.has(value)||Number.isSafeInteger(value.id)))))throw Error('ID имеет неподдерживаемый тип или число выходит за точность JavaScript. ID не округляется; смотри исходный JSON.');
        if(mode==='cdp'&&has('sessionId')&&typeof value.sessionId!=='string')throw Error('sessionId должен быть строкой.');
        let kind;
        if(has('method')){
          if(typeof value.method!=='string'||(mode==='cdp'&&!/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(value.method))||has('result')||has('error'))throw Error('Неверный объект команды / события.');
          if(has('params')&&!(object(value.params)||(mode==='jsonrpc'&&Array.isArray(value.params))))throw Error('Неверный тип params.');
          kind=(hasId?'Команда':'Уведомление / событие')+' · '+value.method;
        }else{
          if(!hasId||has('result')===has('error')||has('params'))throw Error('В ответе нужны ID и ровно одно поле result / error.');
          if(has('error')&&(!object(value.error)||!Number.isSafeInteger(value.error.code)||typeof value.error.message!=='string'))throw Error('В ошибке нужны целочисленный code и строка message.');
          kind=has('error')?'Ошибка · '+value.error.code+' · '+value.error.message:'Результат';
        }
        lines.push((batch?'['+(index+1)+'] ':'')+kind,hasId?'ID: '+(numericIds.get(value)??JSON.stringify(value.id)):'Без ID · ответ не ожидается');
        if(mode==='cdp'&&has('sessionId'))lines.push('Сессия: '+JSON.stringify(value.sessionId));
        if(batch)lines.push('');
      }
      return {format:protocol+(batch?' / пакет':' / сообщение'),text:lines.join('\n')+'\n\nИсходный JSON:\n'+text};
    }catch(error){return failure(error instanceof SyntaxError?'Неверный JSON.':error.message);}
  }
  // Only EVENT / BINARY_EVENT text headers, never binary attachments.
  function socketIoPacket(text){
    if(typeof text!=='string'||new TextEncoder().encode(text).length>65536)return null;
    const header=/^4([2356])([\s\S]*)$/.exec(text);if(!header)return null;
    let rest=header[2],attachments=null,namespace='/',ack=null;
    if(header[1]==='5'||header[1]==='6'){
      const count=/^(\d+)-/.exec(rest);if(!count||!/[1-9]/.test(count[1]))return null;
      attachments=count[1];rest=rest.slice(count[0].length);
    }
    if(rest.startsWith('/')){const comma=rest.indexOf(',');if(comma<0)return null;namespace=rest.slice(0,comma);rest=rest.slice(comma+1);}
    const id=/^\d+/.exec(rest);if(id){ack=id[0].replace(/^0+(?=\d)/,'');rest=rest.slice(id[0].length);}
    try{
      const payload=JSON.parse(rest);if(!Array.isArray(payload))return null;
      const isEvent=header[1]==='2'||header[1]==='5';let event=null;
      if(isEvent){
        if(!payload.length)return null;event=payload[0];
        if(typeof event==='string'){
          if(['connect','connect_error','disconnect','disconnecting','newListener','removeListener'].includes(event))return null;
        }else if(typeof event==='number'){
          event=/^\s*\[\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest)?.[1];
          if(event===undefined)return null;
        }else return null;
      }
      return {event,isEvent,namespace,ack,attachments,payload:rest};
    }catch{return null;}
  }
  function socketIoEvent(text){const packet=socketIoPacket(text);return packet?.isEvent?packet:null;}
  function analyze(message,mode){
    if(mode==='cdp'||mode==='jsonrpc')return rpcView(message,mode);
    let text=message.text;
    if(message.kind==='BINARY'){
      if(mode==='protobuf'){
        if(message.truncated)return {format:'Protobuf / неполное сообщение',text:'Сообщение сохранено не полностью. Разбор Protobuf невозможен; доступные байты — в Hex.'};
        try{return {format:'Protobuf / wire (без схемы)',text:JSON.stringify(protobuf(Uint8Array.from(atob(message.base64),c=>c.charCodeAt(0))),null,2)};}
        catch(error){return {format:'Protobuf / ошибка разбора',text:error.message+'. Проверь формат сообщения; исходные байты доступны в Hex.'};}
      }
      if(mode==='msgpack'){
        if(message.truncated)return {format:'MessagePack / неполное сообщение',text:'Сообщение сохранено не полностью. Разбор MessagePack невозможен; доступные байты — в Hex.'};
        try{const bytes=Uint8Array.from(atob(message.base64),c=>c.charCodeAt(0));return {format:'MessagePack',text:JSON.stringify(messagePack(bytes),null,2)};}
        catch(error){return {format:'MessagePack / ошибка разбора',text:error.message+'. Проверь формат сообщения; исходные байты доступны в Hex.'};}
      }
      try{const bytes=Uint8Array.from(atob(message.base64),c=>c.charCodeAt(0));text=new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:Boolean(message.truncated)});}catch{return {format:'Binary',text:null};}
      const json=pretty(text);return json?{...json,format:'Binary / UTF-8 JSON'}:{format:'Binary / UTF-8',text};
    }
    if(message.kind!=='TEXT')return {format:message.kind,text:message.text||null};
    // Engine.IO v4 packet, with an optional Socket.IO packet carried in MESSAGE.
    if(text==='2'||text==='3')return {format:'Engine.IO',text:text==='2'?'PING':'PONG'};
    if(text.startsWith('0{')){const open=pretty(text.slice(1));if(open)return {format:'Engine.IO / OPEN',text:open.text};}
    const event=!message.truncated&&socketIoPacket(text);
    if(event)return {format:'Socket.IO / '+(event.attachments===null?'':'BINARY_')+(event.isEvent?'EVENT':'ACK'),text:[
      event.isEvent?'Event: '+JSON.stringify(event.event):'','Namespace: '+event.namespace,
      event.ack!==null?'Ack: '+event.ack:'',event.attachments!==null?'Attachments: '+event.attachments:'',
      pretty(event.payload)?.text||event.payload
    ].filter(Boolean).join('\n')};
    // Keep other packet types visible; event recognition above validates its payload.
    const match=/^4([014])(\d+-)?(\/[^,]*,)?(\d+)?([\s\S]*)$/.exec(text);
    if(match){
      const names=['CONNECT','DISCONNECT','EVENT','ACK','CONNECT_ERROR','BINARY_EVENT','BINARY_ACK'];
      const data=pretty(match[5]);
      if(data||!match[5])return {format:'Socket.IO / '+names[Number(match[1])],text:[match[3]?'Namespace: '+match[3].slice(0,-1):'',match[4]?'Ack: '+match[4]:'',match[2]?'Attachments: '+match[2].slice(0,-1):'',data?.text||''].filter(Boolean).join('\n')};
    }
    const json=pretty(text);if(json)return json;
    return {format:'Text',text};
  }
  function normalizeJsonRpcIdQuery(input){
    if(typeof input!=='string')throw Error('JSON-RPC ID: нужен текст JSON.');
    const bytes=Array.from(input).reduce((n,c)=>n+(c.codePointAt(0)<=0x7f?1:c.codePointAt(0)<=0x7ff?2:c.codePointAt(0)<=0xffff?3:4),0);
    if(bytes>65536)throw Error('JSON-RPC ID: до 64 КиБ UTF-8.');
    const query=input.replace(/^[\t\n\r\x20\x0b\x0c]+|[\t\n\r\x20\x0b\x0c]+$/g,'');
    if(!query||query==='null'||/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\s\S])/.test(query))return query;
    try{const value=JSON.parse(query);if(typeof value==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))return query;}catch{}
    throw Error('JSON-RPC ID: число, строка в двойных кавычках или null. Пусто — все ID.');
  }
  root.LibriumWS={socketIoPacket,socketIoEvent,analyze,messagePack,protobuf,normalizeHex,normalizeHexMask,normalizeCdpId,normalizeJsonRpcIdQuery,validateJsonPointer};
})(typeof window==='undefined'?globalThis:window);
