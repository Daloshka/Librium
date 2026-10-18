const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {EventEmitter}=require('node:events');
const {CaptureTarget,targetSpec,launchElectron}=require('../desktop/launch-target.cjs');
async function run(){
  const directory=fs.mkdtempSync(path.resolve('target','capture-launch-unit-'));
  const file=path.join(directory,'capture-target.json'),store=new CaptureTarget(file);
  assert.equal(store.status().available,false);
  const executable=path.join(directory,'Electron app & test.exe');fs.writeFileSync(executable,'synthetic');
  store.select(executable);assert.equal(new CaptureTarget(file).status().target.path,executable);
  assert.throws(()=>store.select('relative.exe'));
  assert.throws(()=>store.select(path.join(directory,'missing.exe')));
  assert.equal(store.status().target.path,executable,'invalid selection must preserve the previous target');
  const manifest=path.join(directory,'package.json');fs.writeFileSync(manifest,'{"productName":"<b>Morphius test</b>"}');
  assert.throws(()=>store.select(manifest),/node_modules/);
  fs.mkdirSync(path.join(directory,'node_modules','electron','dist'),{recursive:true});
  fs.writeFileSync(path.join(directory,'node_modules','electron','dist','electron.exe'),'synthetic');
  const spec=targetSpec(manifest);assert.equal(spec.kind,'project');assert.deepEqual(spec.args,[directory]);
  store.select(manifest);assert.equal(new CaptureTarget(file).status().target.label,'<b>Morphius test</b>');
  let launched=null,unreferenced=false;
  const spawnProcess=(...args)=>{launched=args;const child=new EventEmitter();child.unref=()=>{unreferenced=true;};process.nextTick(()=>child.emit('spawn'));return child;};
  await store.launch(19441,{spawnProcess});
  assert.equal(launched[0],spec.executable);assert.equal(launched[2].shell,false);assert.equal(launched[2].windowsHide,true);assert.equal(launched[2].cwd,directory);assert.equal(unreferenced,true);
  assert.deepEqual(launched[1],[
    '--remote-debugging-port=19441','--remote-debugging-address=127.0.0.1','--inspect=127.0.0.1:19442','--experimental-network-inspection',directory,
  ]);
  for(const port of [3000,8080,65535,'19441'])await assert.rejects(launchElectron(spec,port,{spawnProcess}));
  const occupied=net.createServer();await new Promise(resolve=>occupied.listen(19442,'127.0.0.1',resolve));
  launched=null;
  try{await assert.rejects(launchElectron(spec,19441,{spawnProcess}),/19442.*занят/);assert.equal(launched,null);}finally{await new Promise(resolve=>occupied.close(resolve));}
  fs.writeFileSync(file,'broken');assert.equal(store.status().available,false);assert.ok(store.status().error);
  store.select(executable);fs.unlinkSync(executable);assert.equal(store.status().available,false);
  console.log('PASS: selected executable / Electron project, persistent target, exact argv without shell, invalid selections and occupied ports');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
