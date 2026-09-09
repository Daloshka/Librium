const {t}=require('./i18n.cjs');
const {decodeBody,supported}=require('./decode.cjs');
function mediaFile(detail,side){
  if(!['request','response'].includes(side))throw Error(t('save.badSide'));
  const payload=detail[side];
  if(!payload.complete||payload.truncated)throw Error(t('save.incomplete'));
  const {bytes,decoded,encoding}=decodeBody(payload);
  if(!decoded)throw Error(supported(encoding)?t('save.corrupt',{encoding}):t('save.encoding',{encoding}));
  let name;try{name=decodeURIComponent(new URL(detail.summary.url).pathname.split('/').pop());}catch{}
  name=(name||'media').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,180);
  if(!name||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='media-'+detail.summary.id;
  const mime=payload.headers.find(([k])=>k.toLowerCase()==='content-type')?.[1].split(';')[0].trim().toLowerCase();
  const ext={'image/png':'png','image/jpeg':'jpg','image/svg+xml':'svg','image/webp':'webp','image/gif':'gif','image/avif':'avif','image/bmp':'bmp','image/x-icon':'ico','image/vnd.microsoft.icon':'ico','audio/ogg':'ogg','application/ogg':'ogg','audio/mpeg':'mp3','audio/wav':'wav','audio/flac':'flac','audio/mp4':'m4a','audio/aac':'aac','video/mp4':'mp4','video/webm':'webm','application/json':'json','application/ld+json':'json','application/manifest+json':'json','text/html':'html','application/xhtml+xml':'html','text/plain':'txt','text/css':'css','text/javascript':'js','application/javascript':'js','application/x-javascript':'js','application/xml':'xml','text/xml':'xml','application/pdf':'pdf','application/zip':'zip','application/wasm':'wasm','font/woff2':'woff2','font/woff':'woff','font/ttf':'ttf','text/csv':'csv','application/x-www-form-urlencoded':'txt','text/event-stream':'txt','text/markdown':'md'}[mime];
  if(ext&&!name.toLowerCase().endsWith('.'+ext))name+='.'+ext;
  return {name,bytes};
}
module.exports={mediaFile};
