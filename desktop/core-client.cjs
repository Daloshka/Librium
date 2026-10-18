const http=require('node:http');
const DESKTOP_API=1;
const REQUIRED=['persistent_history','external_capture','capture_sources','capture_targets','capture_contexts','capture_context_catalogue','ws_archive_search','ws_context','ws_jsonrpc_related','ws_jsonrpc_search','ws_profile','ws_rpc_unique_members','ws_content_search','ws_export','ws_close','ws_protobuf','ws_summary','ws_message','ws_hex_search','ws_kind_groups','ws_inflate','ws_roles','ws_cdp_related','ws_cdp_search','ws_json_pointer','ws_json_fields','ws_json_values','ws_json_exact','ws_socketio_search','ws_socketio_events','ws_socketio_related','ws_fields','ws_fields_search','ws_field_values','ws_timing','ws_timing_links','ws_hex_mask','ws_hex_mask_offset'];
function parseJson(text){try{return JSON.parse(text);}catch{throw Error('Ядро вернуло некорректный JSON');}}
function assertCompatible(info){
  if(info?.desktop_api!==DESKTOP_API||REQUIRED.some(key=>info[key]!==true)){
    const error=Error('Несовместимое Rust-ядро. Закрой ранее запущенный Librium (включая ядро в терминале) и запусти обновлённую сборку заново.');
    error.code='LIBRIUM_CORE_INCOMPATIBLE';throw error;
  }
}
class CoreClient {
  #token;#connected=false;#failure;
  constructor({base='http://127.0.0.1:3000'}={}){this.base=base;}
  get connected(){return this.#connected;}
  // Always direct loopback HTTP; no system proxy and no token in the URL.
  #read(path,method,token,body,signal){
    return new Promise((resolve,reject)=>{
      const req=http.request(this.base+path,{method,signal,headers:{...(token?{'x-librium-token':token}:{}),...(body?{'content-type':'application/json'}:{})}},res=>{
        const chunks=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>64*1024*1024)req.destroy(Error('Ответ API слишком большой'));else chunks.push(chunk);});
        res.on('end',()=>res.statusCode>=200&&res.statusCode<300?resolve(Buffer.concat(chunks).toString()):reject(Error(`API: ${res.statusCode}`)));
        res.on('error',reject);
      });
      req.setTimeout((/^\/api\/capture-contexts\?/.test(path)||/^\/api\/traffic\/\d+\/ws(?:\?|$)/.test(path)||path.endsWith('/socketio-related')||path.endsWith('/cdp-related')||path.endsWith('/ws-summary')||path.endsWith('/ws-profile')||path.endsWith('/json-fields')||path.endsWith('/ws-search')||path.endsWith('/ws-archive-search')||path.endsWith('/context')||/\/jsonrpc-related(?:\?entry=\d+)?$/.test(path)||path.endsWith('/ws-field-values')||path.endsWith('/ws-socketio-events')||/^\/api\/traffic\/\d+\/ws-json-values\?/.test(path))?30000:3000,()=>req.destroy(Error('Ядро не отвечает')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
    });
  }
  async connect(){
    try{
      const html=await this.#read('/','GET');
      const match=html.match(/const token\s*=\s*'([a-f0-9-]+)'/);
      if(!match||!html.includes('Librium'))throw Error('Порт 3000 занят другим приложением');
      const candidate=match[1];
      assertCompatible(parseJson(await this.#read('/api/info','GET',candidate)));
      const rows=parseJson(await this.#read('/api/traffic','GET',candidate));
      if(!Array.isArray(rows))throw Error('Неверный ответ ядра');
      this.#token=candidate;this.#connected=true;this.#failure=null;
    }catch(error){this.#connected=false;this.#token=undefined;this.#failure=error;throw error;}
  }
  request(path,method='GET',authenticated=true,body,signal){
    if(!this.#connected)return Promise.reject(this.#failure||Error('Нет проверенного соединения с Rust-ядром'));
    return this.#read(path,method,authenticated?this.#token:undefined,body,signal);
  }
}
module.exports={CoreClient,assertCompatible,DESKTOP_API};
