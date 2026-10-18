const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {exportSession}=require('../ui/ws-export.js'),{exportFile}=require('../desktop/ws-export.cjs');
const session={version:1,id:9,total:3,through:20,state:'open',error:null,exchange:{summary:{id:9,source:'cdp_node'}}};
const messages=[{id:2,kind:'TEXT',text:'first\nline',direction:'sent',base64:Buffer.from('first\nline').toString('base64'),size:10,truncated:false},{id:10,kind:'BINARY',base64:'AP8=',direction:'received',size:2,truncated:false},{id:20,kind:'BINARY',base64:'AP8=',direction:'sent',size:70000,truncated:true}];
const first={session,messages:messages.slice(0,2),through:20,next:10,more:true},last={session:null,messages:messages.slice(2),through:20,next:20,more:false};
async function run(){
  const routes=[],lines=[];let writing=false;
  const result=await exportSession({id:9,request:async route=>{routes.push(route);return routes.length===1?first:last;},write:async line=>{assert.equal(writing,false);writing=true;await new Promise(r=>setTimeout(r,1));lines.push(line);writing=false;}});
  assert.deepEqual(routes,['traffic/9/ws-export?after=0','traffic/9/ws-export?after=10&through=20']);assert.equal(result.messages,3);
  const records=lines.map(line=>JSON.parse(line));assert.equal(lines.join('').split('\n').length,6);assert.deepEqual(records.map(row=>row.type),['session','message','message','message','end']);assert.deepEqual(records.slice(1,-1).map(({type,...message})=>message),messages);assert.equal(records.at(-1).messages,3);
  for(const bad of [{...last,messages:[],next:10},{...last,through:21},{...last,messages:[messages[0]],next:2},{...last,messages:[],next:10,more:true}]){
    let calls=0;const output=[];await assert.rejects(()=>exportSession({id:9,request:async()=>++calls===1?first:bad,write:async line=>output.push(line)}));assert.ok(!output.some(line=>JSON.parse(line).type==='end'));
  }
  const base=path.resolve('target');await fs.mkdir(base,{recursive:true});const directory=await fs.mkdtemp(path.join(base,'ws-export-test-')),destination=path.join(directory,'archive.jsonl');
  try{
    await fs.writeFile(destination,'original');let calls=0;
    await exportFile({id:9,filePath:destination,request:async()=>++calls===1?first:last});assert.deepEqual((await fs.readFile(destination,'utf8')).trimEnd().split('\n').map(JSON.parse),records);
    await fs.writeFile(destination,'original');calls=0;
    await assert.rejects(()=>exportFile({id:9,filePath:destination,request:async()=>{if(++calls===2)throw Error('Simulated API loss');return first;}}));assert.equal(await fs.readFile(destination,'utf8'),'original');
    const controller=new AbortController();await assert.rejects(()=>exportFile({id:9,filePath:destination,signal:controller.signal,request:async()=>{controller.abort();return first;}}),{name:'AbortError'});assert.equal(await fs.readFile(destination,'utf8'),'original');assert.deepEqual(await fs.readdir(directory),['archive.jsonl']);
  }finally{assert.equal(path.dirname(directory),base);await fs.rm(directory,{recursive:true,force:true});}
  console.log('PASS: paged JSONL, exact raw payloads / truncation, snapshot cutoff, backpressure, malformed / deleted pages, atomic replacement and abort cleanup');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
