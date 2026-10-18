const assert=require('node:assert/strict'),http=require('node:http');
const {CoreClient,DESKTOP_API}=require('../desktop/core-client.cjs');
const current={desktop_api:DESKTOP_API,persistent_history:true,external_capture:true,capture_sources:true,capture_targets:true,capture_contexts:true,capture_context_catalogue:true,ws_archive_search:true,ws_context:true,ws_jsonrpc_related:true,ws_jsonrpc_search:true,ws_profile:true,ws_rpc_unique_members:true,ws_content_search:true,ws_export:true,ws_close:true,ws_protobuf:true,ws_summary:true,ws_message:true,ws_hex_search:true,ws_kind_groups:true,ws_inflate:true,ws_roles:true,ws_cdp_related:true,ws_cdp_search:true,ws_json_pointer:true,ws_json_fields:true,ws_json_values:true,ws_json_exact:true,ws_socketio_search:true,ws_socketio_events:true,ws_socketio_related:true,ws_fields:true,ws_fields_search:true,ws_field_values:true,ws_timing:true,ws_timing_links:true,ws_hex_mask:true,ws_hex_mask_offset:true};
async function run(){
  let info={...current},fixtureToken='a'.repeat(32),hold=false,waiting,release;const calls=[];
  const server=http.createServer((req,res)=>{
    calls.push({path:req.url,method:req.method,token:req.headers['x-librium-token']});req.resume();
    if(req.url==='/'){res.end(`Librium<script>const token='${fixtureToken}'</script>`);return;}
    if(req.url==='/api/info'){const respond=()=>res.end(typeof info==='string'?info:JSON.stringify(info));if(hold){waiting=true;release=respond;}else respond();return;}
    if(req.url==='/api/traffic'){res.end('[]');return;}res.end('ok');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const client=new CoreClient({base:'http://127.0.0.1:'+server.address().port});
  try{
    for(const invalid of [{...current,ws_content_search:undefined},{...current,ws_rpc_unique_members:undefined},{...current,ws_profile:undefined},{...current,ws_jsonrpc_search:undefined},{...current,ws_jsonrpc_related:undefined},{...current,ws_context:undefined},{...current,ws_archive_search:undefined},{...current,capture_context_catalogue:undefined},{...current,capture_contexts:undefined},{...current,capture_targets:undefined},{...current,desktop_api:undefined},{...current,desktop_api:DESKTOP_API+1},{...current,ws_export:false},{...current,ws_close:undefined},{...current,ws_protobuf:undefined},{...current,ws_summary:undefined},{...current,ws_message:undefined},{...current,ws_hex_search:undefined},{...current,ws_kind_groups:undefined},{...current,ws_inflate:undefined},{...current,ws_roles:undefined},{...current,ws_cdp_related:undefined},{...current,ws_cdp_search:undefined},{...current,ws_json_pointer:undefined},{...current,ws_json_fields:undefined},{...current,ws_json_values:undefined},{...current,ws_json_exact:undefined},{...current,ws_socketio_search:undefined},{...current,ws_socketio_events:undefined},{...current,ws_socketio_related:undefined},{...current,ws_fields:undefined},{...current,ws_fields_search:undefined},{...current,ws_field_values:undefined},{...current,ws_timing:undefined},{...current,ws_timing_links:undefined},{...current,ws_hex_mask:undefined},{...current,ws_hex_mask_offset:undefined}]){
      info=invalid;calls.length=0;await assert.rejects(()=>client.connect(),{code:'LIBRIUM_CORE_INCOMPATIBLE'});assert.equal(client.connected,false);assert.deepEqual(calls.map(row=>row.path),['/','/api/info']);
      await assert.rejects(()=>client.request('/api/storage-flush','POST'));await assert.rejects(()=>client.request('/api/storage-flush','POST',false));assert.equal(calls.length,2,'incompatible connection must block writes without HTTP');
    }
    info='fixture-response-body';await assert.rejects(()=>client.connect(),error=>error.message==='Ядро вернуло некорректный JSON');assert.equal(client.connected,false);
    info=current;await client.connect();assert.equal(client.connected,true);await client.request('/api/echo','POST',true,{fixture:1});assert.equal(calls.at(-1).token,fixtureToken);
    const previous=fixtureToken;fixtureToken='b'.repeat(32);hold=true;const pending=client.connect();for(let n=0;n<100&&!waiting;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(waiting,true);
    await client.request('/api/echo');assert.equal(calls.at(-1).token,previous,'candidate token must not replace a verified token before negotiation');release();await pending;await client.request('/api/echo');assert.equal(calls.at(-1).token,fixtureToken);
    hold=false;info={...current,desktop_api:undefined};await assert.rejects(()=>client.connect());const before=calls.length;await assert.rejects(()=>client.request('/api/capture','POST',true,{}));assert.equal(calls.length,before);assert.equal(client.connected,false);assert.ok(!JSON.stringify(client).includes(fixtureToken));
    console.log('PASS: missing / future / incomplete core API rejected before history, no writes after rejection, staged token validation and safe revalidation');
  }finally{await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
