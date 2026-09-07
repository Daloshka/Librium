const fs=require('node:fs');
const path=require('node:path');
const filters=require('../ui/filters.js');
const {t}=require('./i18n.cjs');
function validate(value){
  if(value?.version!==1||!Array.isArray(value.sessions)||!value.sessions.length||value.sessions.length>200)throw Error(t('store.badSessions'));
  const ids=new Set();
  for(const s of value.sessions){
    if(typeof s.id!=='string'||s.id.length>80||ids.has(s.id)||typeof s.name!=='string'||!s.name.trim()||s.name.length>80)throw Error(t('store.badName'));ids.add(s.id);
    if(![undefined,"id","method","url","status","size"].includes(s.sort)||![undefined,"asc","desc"].includes(s.order))throw Error(t('store.badSort'));
    if(typeof s.query!=='string'||s.query.length>4096||!['','GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(s.method)||!['','2','3','4','5','pending'].includes(s.status)||!['','http','ws'].includes(s.type)||!Array.isArray(s.rules)||s.rules.length>32||s.rules.some(r=>filters.validate(r)||String(r.value).length>4096))throw Error(t('store.badFilters'));
  }
  if(!ids.has(value.activeId))throw Error(t('store.noActive'));
  return value;
}
function read(file){try{return validate(JSON.parse(fs.readFileSync(file,'utf8')));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function write(file,value){validate(value);fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,file);}
module.exports={read,write,validate};
