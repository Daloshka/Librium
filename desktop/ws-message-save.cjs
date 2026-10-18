const fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
async function writePayload(filePath,bytes){
  const temporary=filePath+'.librium-'+randomUUID()+'.tmp';let file,created=false;
  try{file=await fs.open(temporary,'wx');created=true;await file.writeFile(bytes);await file.sync();await file.close();file=null;await fs.rename(temporary,filePath);created=false;}
  finally{if(file)await file.close().catch(()=>{});if(created)await fs.unlink(temporary).catch(()=>{});}
}
module.exports={writePayload};
