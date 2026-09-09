const {command,install}=require('../desktop/ca-install.cjs');
const assert=require('node:assert/strict');
assert.deepEqual(command('darwin','/Users/someone','/tmp/librium-ca.crt'),{command:'security',args:['add-trusted-cert','-r','trustRoot','-k','/Users/someone/Library/Keychains/login.keychain-db','/tmp/librium-ca.crt']});
assert.deepEqual(command('win32','C:\\Users\\someone','C:\\data\\librium-ca.crt'),{command:'certutil',args:['-user','-addstore','Root','C:\\data\\librium-ca.crt']});
assert.equal(command('linux','/home/x','/tmp/ca.crt'),null);
(async()=>{
  const calls=[];
  const run=(cmd,args,options,callback)=>{calls.push([cmd,args]);callback(null,'ok','');};
  const result=await install({platform:'darwin',home:'/Users/someone',file:'/tmp/librium-ca.crt',run});
  assert.equal(calls.length,1);assert.match(result.command,/^security add-trusted-cert/);
  await assert.rejects(install({platform:'win32',home:'C:\\Users\\x',file:'C:\\ca.crt',run:(c,a,o,cb)=>cb(Error('boom'),'','CertUtil: -addstore command FAILED')}),/CertUtil: -addstore command FAILED/);
  await assert.rejects(install({platform:'linux',file:'/tmp/ca.crt',run}),/no standard trust store|нет стандартного хранилища/);
  console.log('CA install smoke OK: platform commands built, failures reported, nothing executed');
})().catch(error=>{console.error(error);process.exitCode=1;});
