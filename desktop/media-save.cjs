const zlib=require('node:zlib');
const {t}=require('./i18n.cjs');
function mediaFile(detail,side){
  if(!['request','response'].includes(side))throw Error(t('save.badSide'));
  const payload=detail[side];
  if(!payload.complete||payload.truncated)throw Error(t('save.incomplete'));
  let bytes=Buffer.from(payload.base64,'base64');
  const encoding=payload.headers.find(([k])=>k.toLowerCase()==='content-encoding')?.[1].trim().toLowerCase();
  const options={maxOutputLength:32*1024*1024};
  if(encoding==='gzip')bytes=zlib.gunzipSync(bytes,options);
  else if(encoding==='deflate')bytes=zlib.inflateSync(bytes,options);
  else if(encoding==='br')bytes=zlib.brotliDecompressSync(bytes,options);
  else if(encoding&&encoding!=='identity')throw Error(t('save.encoding',{encoding}));
  let name;try{name=decodeURIComponent(new URL(detail.summary.url).pathname.split('/').pop());}catch{}
  name=(name||'media').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,180);
  if(!name||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='media-'+detail.summary.id;
  const mime=payload.headers.find(([k])=>k.toLowerCase()==='content-type')?.[1].split(';')[0].trim().toLowerCase();
  const ext={'image/png':'png','image/jpeg':'jpg','image/svg+xml':'svg','image/webp':'webp','image/gif':'gif','audio/ogg':'ogg','application/ogg':'ogg','audio/mpeg':'mp3','audio/wav':'wav','audio/flac':'flac','audio/mp4':'m4a'}[mime];
  if(ext&&!name.toLowerCase().endsWith('.'+ext))name+='.'+ext;
  return {name,bytes};
}
module.exports={mediaFile};
