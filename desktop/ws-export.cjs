const fs=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
const {exportSession}=require('../ui/ws-export.js');
// The selected destination is replaced only after a complete validated export.
async function exportFile({id,filePath,request,signal}){
  const temporary=filePath+'.librium-'+randomUUID()+'.tmp';let file,created=false;
  try{
    file=await fs.open(temporary,'wx');created=true;
    const result=await exportSession({id,request,write:line=>file.writeFile(line,'utf8'),signal});
    await file.sync();await file.close();file=null;
    signal?.throwIfAborted();
    await fs.rename(temporary,filePath);created=false;return result;
  }finally{
    if(file)await file.close().catch(()=>{});
    if(created)await fs.unlink(temporary).catch(()=>{});
  }
}
module.exports={exportFile};
