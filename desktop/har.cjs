// HAR 1.2 export of the stored history. Bodies are decompressed the way a browser would show them,
// text stays text and anything else is base64; WebSocket frames use the Chrome DevTools extension.
const fs=require('node:fs');
const {STATUS_CODES}=require('node:http');
const {decodeBody}=require('./decode.cjs');
const {t}=require('./i18n.cjs');
const CREATOR={name:'Librium',version:require('../package.json').version};
const header=(headers,name)=>headers.find(([key])=>key.toLowerCase()===name)?.[1];
const headerList=headers=>headers.map(([name,value])=>({name,value}));
// Why a body is not the exact, decoded content; undefined when it is.
function bodyNote(payload,decoded){
  if(payload.truncated)return 'Body captured partially';
  if(!payload.complete)return 'Body incomplete';
  if(!decoded.decoded)return `Body kept as transmitted (Content-Encoding: ${decoded.encoding})`;
  return undefined;
}
const utf8=new TextDecoder('utf-8',{fatal:true});
function textOrBase64(bytes){
  try{return {text:utf8.decode(bytes)};}catch{return {text:bytes.toString('base64'),encoding:'base64'};}
}
const params=require('../ui/params.js');
const requestCookies=params.requestCookies;
const queryString=params.queryParams;
// HAR knows path, domain, expires (ISO 8601), httpOnly and secure; expires must be a date.
function responseCookies(headers){
  return params.responseCookies(headers).map(({name,value,path,domain,expires,httpOnly,secure})=>{
    const cookie={name,value};
    if(path!==undefined)cookie.path=path;if(domain!==undefined)cookie.domain=domain;
    if(expires!==undefined){const when=new Date(expires);if(!Number.isNaN(when.getTime()))cookie.expires=when.toISOString();}
    if(httpOnly)cookie.httpOnly=true;if(secure)cookie.secure=true;
    return cookie;
  });
}
// DevTools' WebSocket extension: text frames as text, everything else as base64 with its real opcode.
const OPCODES={TEXT:1,BINARY:2,CLOSE:8,PING:9,PONG:10};
function frame(message){return {type:message.direction==='sent'?'send':'receive',time:message.time/1000,opcode:OPCODES[message.kind]||1,data:message.kind==='TEXT'?message.text:message.base64};}
// Headers that carry credentials; with `redact` their values (and the cookies) are replaced before export.
const SECRET_HEADERS=/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|api-key|apikey|x-access-token|x-amz-security-token)$/i;
const REDACTED='«redacted»';
function redactHeaders(headers){return headers.map(([name,value])=>[name,SECRET_HEADERS.test(name)?REDACTED:value]);}
function redacted(detail){
  return {...detail,request:{...detail.request,headers:redactHeaders(detail.request.headers)},response:{...detail.response,headers:redactHeaders(detail.response.headers)}};
}
function entry(original,messages,options={}){
  const detail=options.redact?redacted(original):original;
  const summary=detail.summary;
  const request=decodeBody(detail.request),response=decodeBody(detail.response);
  const elapsed=Number.isFinite(summary.elapsed_ms)?summary.elapsed_ms:0;
  // size is the length of the decoded content: for an uncompressed body that is the transfer size even when only a prefix was kept.
  const content={size:response.decoded&&response.encoding?response.bytes.length:detail.response.size,mimeType:header(detail.response.headers,'content-type')||'',...textOrBase64(response.bytes)};
  // HAR counts compression as bytes saved: decoded size minus what went over the wire.
  if(response.decoded&&response.encoding)content.compression=response.bytes.length-detail.response.size;
  const responseNote=bodyNote(detail.response,response);if(responseNote)content.comment=responseNote;
  const result={
    startedDateTime:new Date(summary.time||0).toISOString(),
    time:elapsed,
    request:{method:summary.method,url:summary.url,httpVersion:summary.version||'HTTP/1.1',cookies:requestCookies(detail.request.headers),headers:headerList(detail.request.headers),queryString:queryString(summary.url),headersSize:-1,bodySize:detail.request.size},
    response:{status:summary.status??0,statusText:STATUS_CODES[summary.status]||'',httpVersion:summary.version||'HTTP/1.1',cookies:responseCookies(detail.response.headers),headers:headerList(detail.response.headers),content,redirectURL:header(detail.response.headers,'location')||'',headersSize:-1,bodySize:detail.response.size},
    cache:{},
    timings:{send:0,wait:elapsed,receive:0},
  };
  if(detail.request.size>0){result.request.postData={mimeType:header(detail.request.headers,'content-type')||'',...textOrBase64(request.bytes)};const requestNote=bodyNote(detail.request,request);if(requestNote)result.request.postData.comment=requestNote;}
  if(summary.error)result.comment=summary.error;
  // A star and a note ride along in a custom field, so our own export imports back complete.
  if(summary.starred||summary.note||summary.mock)result._librium={starred:!!summary.starred,note:String(summary.note||''),...(summary.mock?{mock:true}:{})};
  if(messages)result._webSocketMessages=messages.map(frame);
  return result;
}
// Streams the matching history into `file`, oldest first, without holding every entry in memory.
// The file is written next to its final name and renamed at the end, so a failure part-way leaves
// the user's earlier file (or nothing) rather than a truncated document.
// The other direction: a HAR (ours, a browser's, another tool's) as exchanges the core can store.
function fromHar(har){
  const entries=har?.log?.entries;
  if(!Array.isArray(entries))throw Error(t('import.notHar'));
  const headers=list=>(Array.isArray(list)?list:[]).filter(h=>h&&typeof h.name==='string').map(h=>[h.name,String(h.value??'')]);
  const bytes=(content)=>{if(!content||typeof content.text!=='string')return Buffer.alloc(0);return content.encoding==='base64'?Buffer.from(content.text,'base64'):Buffer.from(content.text,'utf8');};
  // A body the file only measured (DevTools leaves large ones out) keeps its size and shows as truncated.
  const payload=(list,buffer,declared)=>{const size=Number.isFinite(declared)&&declared>buffer.length?declared:buffer.length;return {headers:headers(list),text:buffer.subarray(0,65536).toString('utf8'),base64:buffer.toString('base64'),size,complete:true,truncated:size>buffer.length};};
  // DevTools' `_webSocketMessages`: text frames as text, other opcodes as base64 (a tool that wrote plain text there is taken as text).
  const KINDS={1:'TEXT',2:'BINARY',8:'CLOSE',9:'PING',10:'PONG'};
  const frames=(list,started)=>(Array.isArray(list)?list:[]).filter(m=>m&&typeof m.data==='string').map(m=>{
    const kind=KINDS[m.opcode]||'TEXT';
    const base64=kind!=='TEXT'&&/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)&&m.data.length%4===0?m.data:Buffer.from(m.data,'utf8').toString('base64');
    return {time:Number.isFinite(m.time)&&m.time>0?Math.round(m.time*1000):started,direction:m.type==='send'?'sent':'received',kind,base64};
  });
  return entries.filter(e=>e&&e.request&&typeof e.request.url==='string').map(e=>{
    const started=Date.parse(e.startedDateTime||'');
    const requestBody=bytes(e.request.postData),responseBody=bytes(e.response?.content);
    const status=Number.isInteger(e.response?.status)&&e.response.status>0?e.response.status:null;
    const contentType=(headers(e.response?.headers).find(([k])=>k.toLowerCase()==='content-type')?.[1]||e.response?.content?.mimeType||'').split(';')[0].trim().toLowerCase();
    return {
      summary:{id:0,time:Number.isFinite(started)?started:0,method:String(e.request.method||'GET').toUpperCase(),url:e.request.url,version:typeof e.request.httpVersion==='string'?e.request.httpVersion.replace(/^http\/2\.0$/i,'HTTP/2').toUpperCase():'',content_type:contentType,status,elapsed_ms:Number.isFinite(e.time)&&e.time>=0?Math.round(e.time):null,size:responseBody.length,error:null,finished:true,...(e._librium&&typeof e._librium==='object'?{starred:!!e._librium.starred,note:String(e._librium.note||'').slice(0,4096),mock:!!e._librium.mock}:{})},
      request:payload(e.request.headers,requestBody,e.request.bodySize),
      response:payload(e.response?.headers,responseBody,e.response?.content?.size),
      ...(e._webSocketMessages?.length?{frames:frames(e._webSocketMessages,Number.isFinite(started)?started:0)}:{}),
    };
  });
}
async function exportHar({fetchJson,query,file,redact=false}){
  const temporary=file+'.part';
  const handle=await fs.promises.open(temporary,'w');
  let count=0,finished=false;
  try{
    await handle.write(`{"log":{"version":"1.2","creator":${JSON.stringify(CREATOR)},"entries":[`);
    // First the ids of everything that matches now, walking by id (not by offset) so rows that
    // start or stop matching a live filter while the export runs cannot shift later pages, and
    // pinned to the newest id of the first page; then the details by id.
    const ids=[],base={...query,sort:'id',order:'asc',limit:1000,offset:0};
    let after=0,before=null;
    for(;;){
      const page=await fetchJson('traffic-page?q='+encodeURIComponent(JSON.stringify({...base,before,rules:[...(query.rules||[]),{field:'id',op:'gte',value:String(after+1)}]})));
      if(before===null)before=page.newest;
      if(!page.rows.length)break;
      for(const row of page.rows)ids.push(row.id);
      after=page.rows[page.rows.length-1].id;
    }
    for(const id of ids){
      let detail;
      try{detail=await fetchJson('traffic/'+id);}
      catch(error){if(String(error.message).includes('404'))continue;throw error;} // cleared meanwhile
      const json=JSON.stringify(entry(detail,null,{redact}));
      if(detail.summary.status!==101){await handle.write((count?',\n':'\n')+json);count++;continue;}
      // Socket frames are streamed oldest first, a page at a time, so a long-lived socket never has to fit in memory.
      await handle.write((count?',\n':'\n')+json.slice(0,-1)+',"_webSocketMessages":[');
      let cursor=0,written=0;
      for(;;){
        const ws=await fetchJson(`traffic/${id}/ws?after=${cursor}`);
        for(const message of ws.messages){await handle.write((written++?',':'')+JSON.stringify(frame(message)));}
        if(!ws.more||!ws.messages.length)break;
        cursor=ws.messages[ws.messages.length-1].id;
      }
      await handle.write(']}');
      count++;
    }
    await handle.write('\n]}}\n');
    finished=true;
  }finally{
    await handle.close();
    if(finished)await fs.promises.rename(temporary,file);else await fs.promises.rm(temporary,{force:true});
  }
  return count;
}
module.exports={entry,exportHar,fromHar,REDACTED};
