// Serialized into the inspected Node runtime. Observe transport diagnostics;
// never iterate, read or replace the application's request body / fetch API.
function observeHttpBodies({publish,recordLimit=2000,byteLimit=8*1024*1024}) {
  const dc=process.getBuiltinModule('diagnostics_channel');
  const {Buffer}=process.getBuiltinModule('buffer');
  const records=new Map(),byRequest=new WeakMap(),subscriptions=[];
  let stopped=false,used=0,warned=false;
  const warning=message=>{if(!warned){warned=true;publish({type:'warning',message});}};
  const safe=fn=>event=>{try{if(!stopped)fn(event);}catch{}};
  const subscribe=(name,fn)=>{const callback=safe(fn);dc.subscribe(name,callback);subscriptions.push([name,callback]);};
  function identify(request){
    const candidates=Object.getOwnPropertySymbols(request).filter(symbol=>symbol.description==='kInspectorRequestId')
      .map(symbol=>Object.getOwnPropertyDescriptor(request,symbol)?.value).filter(value=>typeof value==='string'&&value.length>0&&value.length<=256);
    return candidates.length===1?candidates[0]:null;
  }
  function release(record){
    record.active=false;used-=record.retained;record.retained=0;record.chunks=[];
    if(records.get(record.id)===record)records.delete(record.id);
  }
  subscribe('undici:request:create',({request})=>{
    const method=Object.getOwnPropertyDescriptor(request,'method')?.value;
    const body=Object.getOwnPropertyDescriptor(request,'body');
    if(!body||!('value' in body)||typeof method!=='string')return;
    if(['GET','HEAD','OPTIONS'].includes(method)&&body.value==null)return;
    const id=identify(request);
    if(!id){warning('Диагностика Undici не предоставила ID инспектора; тело запроса будет получено стандартным способом, если доступно');return;}
    if(records.has(id)||records.size>=recordLimit){warning('Достигнут лимит ожидающих тел запросов Undici');return;}
    const empty=body.value==null||(typeof body.value==='string'&&body.value.length===0)||
      (ArrayBuffer.isView(body.value)&&body.value.byteLength===0)||(body.value instanceof ArrayBuffer&&body.value.byteLength===0);
    const record={id,active:true,chunks:[],retained:0,size:0,sawChunk:false,sent:false,error:null,empty};
    records.set(id,record);byRequest.set(request,record);
  });
  subscribe('undici:request:bodyChunkSent',({request,chunk})=>{
    const record=byRequest.get(request);if(!record?.active)return;
    record.sawChunk=true;
    let size,bytes;const remaining=65536-record.retained;
    if(typeof chunk==='string'){
      size=Buffer.byteLength(chunk);
      // Include the next UTF-16 code unit so a surrogate pair at the byte
      // boundary is encoded correctly before cutting the UTF-8 preview.
      bytes=remaining?Buffer.from(chunk.slice(0,remaining+1)).subarray(0,remaining):Buffer.alloc(0);
    }else if(ArrayBuffer.isView(chunk)){
      size=chunk.byteLength;bytes=Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength).subarray(0,remaining);
    }else if(chunk instanceof ArrayBuffer){size=chunk.byteLength;bytes=Buffer.from(chunk).subarray(0,remaining);}
    else {record.error='Неподдерживаемый тип диагностического фрагмента тела';return;}
    record.size+=size;
    if(record.error||!bytes.length)return;
    if(used+bytes.length>byteLimit){record.error='Лимит памяти наблюдателя тел запросов: часть данных не сохранена';warning(record.error);return;}
    record.chunks.push(Buffer.from(bytes));record.retained+=bytes.length;used+=bytes.length;
  });
  subscribe('undici:request:bodySent',({request})=>{const record=byRequest.get(request);if(record?.active)record.sent=true;});
  // An error can arrive after bodySent, while receiving the response. Keep
  // confirmed upload bytes complete; the exchange records the response error.
  subscribe('undici:request:error',({request})=>{const record=byRequest.get(request);if(record?.active&&!record.sent)record.error='Отправка тела запроса прервана';});
  return {
    take(id){
      const record=records.get(id);if(!record||stopped)return null;
      const complete=record.sent&&!record.error&&(record.sawChunk||record.empty);
      const result={base64:Buffer.concat(record.chunks).toString('base64'),size:record.size,complete,
        note:complete?null:record.error||(!record.sent?'Отправка тела ещё не завершилась при сохранении ответа; полный размер не подтверждён':'Диагностика не подтвердила байты тела; пустое тело не подтверждено')};
      release(record);return result;
    },
    cleanup(){
      if(stopped)return;stopped=true;
      for(const [name,callback] of subscriptions)dc.unsubscribe(name,callback);
      for(const record of records.values())release(record);
    },
  };
}
module.exports={observeHttpBodies};
