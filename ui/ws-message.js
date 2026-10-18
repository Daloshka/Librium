(function(root){
  function payloadFile(exchangeId,message){
    if(!Number.isSafeInteger(exchangeId)||exchangeId<1||!Number.isSafeInteger(message?.id)||message.id<1)throw Error('Неверное сообщение WebSocket');
    if(!['sent','received'].includes(message.direction)||!['TEXT','BINARY','PING','PONG','CLOSE','CONTINUATION'].includes(message.kind)||typeof message.base64!=='string'||message.base64.length>87384||!Number.isInteger(message.size)||message.size<0||typeof message.truncated!=='boolean')throw Error('Неверные данные сообщения WebSocket');
    let raw;try{raw=atob(message.base64);if(btoa(raw)!==message.base64)throw Error();}catch{throw Error('Неверные байты сообщения WebSocket');}
    if(raw.length>65536||raw.length>message.size||message.truncated!==(message.size>raw.length))throw Error('Неверный размер сообщения WebSocket');
    return {bytes:Uint8Array.from(raw,c=>c.charCodeAt(0)),name:`librium-ws-${exchangeId}-${message.id}-${message.direction}${message.truncated?'-partial':''}.${message.kind==='TEXT'?'txt':'bin'}`,truncated:message.truncated,size:message.size};
  }
  function parseOffset(text,length){
    text=text.trim();
    if(!length)throw Error('В сообщении нет сохранённых байтов.');
    if(!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text))throw Error('Введи смещение числом или в Hex, например: 120 или 0x0078.');
    const offset=Number.parseInt(text,/^0x/i.test(text)?16:10);
    if(!Number.isSafeInteger(offset)||offset<0||offset>=length)throw Error(`Смещение должно быть от 0 до ${length-1} — внутри сохранённых байтов.`);
    return offset;
  }
  function parseLength(text,available){
    text=text.trim();if(!text)return null;
    if(!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text))throw Error('Введи длину числом или в Hex; пустое поле означает до конца.');
    const length=Number.parseInt(text,/^0x/i.test(text)?16:10);
    if(!Number.isSafeInteger(length)||length<1||length>available)throw Error(`Длина должна быть от 1 до ${available} — внутри сохранённых байтов.`);
    return length;
  }
  function analysisRange(message,offset,length=null){
    if(message?.kind!=='BINARY')throw Error('Смещение разбора доступно для BINARY.');
    const payload=payloadFile(1,message);
    if(!Number.isSafeInteger(offset)||offset<0||offset>=payload.bytes.length)throw Error('Начало разбора должно находиться внутри сохранённых байтов.');
    if(length!==null&&(!Number.isSafeInteger(length)||length<1||length>payload.bytes.length-offset))throw Error('Диапазон разбора должен находиться внутри сохранённых байтов.');
    // An explicit range is a complete selection of known bytes, not evidence
    // of a complete source message. Never persist/export this derived view.
    return {...message,text:'',base64:btoa(atob(message.base64).slice(offset,length===null?undefined:offset+length)),size:length??message.size-offset,truncated:length===null?message.truncated:false};
  }
  function analysisSuffix(message,offset){return analysisRange(message,offset);}
  function inflateRequest(id,messageId,params){
    if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(messageId)||messageId<1||!params||!['gzip','zlib','deflate'].includes(params.codec)||!Number.isSafeInteger(params.offset)||params.offset<0||params.offset>=65536||!(params.length===null||(Number.isSafeInteger(params.length)&&params.length>0&&params.length<=65536-params.offset)))throw Error('Некорректный диапазон распаковки.');
    return `traffic/${id}/ws/${messageId}/inflate?codec=${params.codec}&offset=${params.offset}${params.length===null?'':'&length='+params.length}`;
  }
  function inflatedPayload(id,messageId,params,result){
    inflateRequest(id,messageId,params);
    if(result?.ok!==true)throw Error(typeof result?.error==='string'?result.error.slice(0,500):'Распаковка не выполнена.');
    if(result.codec!==params.codec||result.offset!==params.offset||!Number.isSafeInteger(result.length)||result.length<1||result.length>65536-params.offset||(params.length!==null&&result.length!==params.length))throw Error('Результат не соответствует выбранному диапазону.');
    const payload=payloadFile(id,{id:messageId,kind:'BINARY',direction:'received',base64:result.base64,size:result.size,truncated:false});
    return {...payload,name:`librium-ws-${id}-${messageId}-unpacked-${params.codec}-${params.offset}-${result.length}.bin`};
  }
  function numericValues(bytes,offset){
    if(!(bytes instanceof Uint8Array)||bytes.length>65536||!Number.isSafeInteger(offset)||offset<0||offset>=bytes.length)throw Error('Выбери смещение внутри сохранённых байтов.');
    const available=bytes.length-offset,view=new DataView(bytes.buffer,bytes.byteOffset+offset,available);
    const text=value=>Object.is(value,-0)?'-0':String(value);
    const rows=[['uint8',1,'getUint8'],['int8',1,'getInt8'],['uint16',2,'getUint16'],['int16',2,'getInt16'],['uint32',4,'getUint32'],['int32',4,'getInt32'],['uint64',8,'getBigUint64'],['int64',8,'getBigInt64'],['float32',4,'getFloat32'],['float64',8,'getFloat64']].map(([type,width,method])=>({type,width,le:available>=width?text(view[method](0,true)):null,be:available>=width?text(view[method](0,false)):null}));
    return {offset,available,hex:Array.from(bytes.subarray(offset,offset+8),value=>value.toString(16).padStart(2,'0')).join(' '),rows};
  }
  function hexHighlight(line,rowOffset,start,length){
    const first=Math.max(rowOffset,start),last=Math.min(rowOffset+Math.max(0,line.length-57),start+length);
    if(first>=last)return [{text:line,hit:false}];
    const a=first-rowOffset,b=last-rowOffset,ranges=[[8+a*3,8+b*3-1],[57+a,57+b]],parts=[];let cursor=0;
    for(const [from,to]of ranges){parts.push({text:line.slice(cursor,from),hit:false},{text:line.slice(from,to),hit:true});cursor=to;}
    parts.push({text:line.slice(cursor),hit:false});return parts;
  }
  function comparePayloads(a,b,{sizeA=a.length,sizeB=b.length}={}){
    if(!(a instanceof Uint8Array)||!(b instanceof Uint8Array)||a.length>65536||b.length>65536)throw Error('Сравнение ограничено 64 КиБ сохранённых байтов на сообщение.');
    if(!Number.isInteger(sizeA)||!Number.isInteger(sizeB)||sizeA<a.length||sizeB<b.length)throw Error('Неверный полный размер сравниваемого сообщения.');
    // Visit saved bytes only: full message sizes can be much larger than 64 KiB.
    const common=Math.min(a.length,b.length),max=Math.max(a.length,b.length),ranges=[];let same=0,changed=0,onlyA=0,onlyB=0,unknownA=0,unknownB=0;
    for(let offset=0;offset<max;offset++){
      const kind=offset<common?(a[offset]===b[offset]?'equal':'changed'):offset<a.length?(offset<sizeB?'unknown_b':'only_a'):(offset<sizeA?'unknown_a':'only_b');
      if(kind==='equal'){same++;continue;}if(kind==='changed')changed++;
      if(kind==='only_a')onlyA++;if(kind==='only_b')onlyB++;if(kind==='unknown_a')unknownA++;if(kind==='unknown_b')unknownB++;
      const last=ranges.at(-1);if(last&&last.kind===kind&&last.end===offset)last.end++;else ranges.push({start:offset,end:offset+1,kind});
    }
    return {common,max,same,changed,onlyA,onlyB,unknownA,unknownB,ranges};
  }
  const api={payloadFile,parseOffset,parseLength,analysisRange,analysisSuffix,inflateRequest,inflatedPayload,numericValues,hexHighlight,comparePayloads};root.LibriumWSMessage=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
