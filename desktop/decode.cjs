// One decoder for every place that hands captured bytes to the user: HAR export and saving a body to a file.
const zlib=require('node:zlib');
const OUTPUT_LIMIT=64*1024*1024;
const SUPPORTED=['identity','gzip','x-gzip','deflate','br',...(typeof zlib.zstdDecompressSync==='function'?['zstd']:[])];
function encodingOf(headers){return (headers.find(([name])=>name.toLowerCase()==='content-encoding')?.[1]||'').trim().toLowerCase();}
// {bytes, decoded, encoding}: decoded=false means the bytes are still exactly as transmitted.
function decodeBody(payload){
  const bytes=Buffer.from(payload.base64,'base64'),encoding=encodingOf(payload.headers);
  if(!encoding||encoding==='identity')return {bytes,decoded:true,encoding:''};
  if(!SUPPORTED.includes(encoding)||!payload.complete||payload.truncated)return {bytes,decoded:false,encoding};
  const options={maxOutputLength:OUTPUT_LIMIT};
  try{
    if(encoding==='gzip'||encoding==='x-gzip')return {bytes:zlib.gunzipSync(bytes,options),decoded:true,encoding};
    if(encoding==='br')return {bytes:zlib.brotliDecompressSync(bytes,options),decoded:true,encoding};
    if(encoding==='zstd')return {bytes:zlib.zstdDecompressSync(bytes,options),decoded:true,encoding};
    try{return {bytes:zlib.inflateSync(bytes,options),decoded:true,encoding};}catch{return {bytes:zlib.inflateRawSync(bytes,options),decoded:true,encoding};}
  }catch{return {bytes,decoded:false,encoding};}
}
const supported=encoding=>!encoding||SUPPORTED.includes(encoding);
module.exports={decodeBody,encodingOf,supported,SUPPORTED};
