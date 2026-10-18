const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {payloadFile,parseOffset,parseLength,analysisRange,analysisSuffix,inflateRequest,inflatedPayload,numericValues,hexHighlight,comparePayloads}=require('../ui/ws-message.js'),{writePayload}=require('../desktop/ws-message-save.cjs');
const message={id:7,kind:'BINARY',direction:'received',base64:'AP8=',size:2,truncated:false};
(async()=>{
  const file=payloadFile(4,message);assert.deepEqual(Buffer.from(file.bytes),Buffer.from([0,255]));assert.equal(file.name,'librium-ws-4-7-received.bin');
  const params={codec:'gzip',offset:4,length:12},reply={ok:true,codec:'gzip',offset:4,length:12,size:2,base64:'AP8='};
  assert.equal(inflateRequest(4,7,params),'traffic/4/ws/7/inflate?codec=gzip&offset=4&length=12');assert.equal(inflateRequest(4,7,{...params,length:null}),'traffic/4/ws/7/inflate?codec=gzip&offset=4');
  const unpackedFile=inflatedPayload(4,7,params,reply);assert.deepEqual(Buffer.from(unpackedFile.bytes),Buffer.from([0,255]));assert.equal(unpackedFile.name,'librium-ws-4-7-unpacked-gzip-4-12.bin');
  assert.equal(inflatedPayload(4,7,params,{...reply,size:0,base64:''}).bytes.length,0);
  for(const bad of [{codec:'brotli',offset:0,length:null},{...params,offset:-1},{...params,offset:65536},{...params,length:0},{...params,length:65536},{...params,length:'12'},null])assert.throws(()=>inflateRequest(4,7,bad));assert.throws(()=>inflateRequest(0,7,params));
  for(const bad of [{...reply,codec:'zlib'},{...reply,offset:5},{...reply,length:13},{...reply,size:3},{...reply,base64:' AP8='},{...reply,size:65537,base64:Buffer.alloc(65537).toString('base64')},{ok:false,error:'bad stream'}])assert.throws(()=>inflatedPayload(4,7,params,bad));
  const source=Object.freeze({...message,base64:'wQD/CAI=',size:5,text:''});
  const suffix=analysisSuffix(source,3);assert.equal(suffix.base64,'CAI=');assert.equal(suffix.size,2);assert.equal(suffix.truncated,false);assert.equal(source.base64,'wQD/CAI=');
  assert.deepEqual(analysisSuffix(source,0),source);
  const partial=analysisSuffix({...source,size:9,truncated:true},3);assert.equal(partial.truncated,true);assert.equal(partial.size,6);assert.equal(partial.base64,'CAI=');
  for(const offset of [-1,5,6,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>analysisSuffix(source,offset));
  assert.throws(()=>analysisSuffix({...source,kind:'TEXT'},1));assert.throws(()=>analysisSuffix({...source,base64:'',size:0},0));
  for(const [text,length]of [['',null],['  ',null],['1',1],[' 0X02 ',2]])assert.equal(parseLength(text,2),length);
  for(const text of ['0','-1','+1','0x','1e2','3','0x20000000000000'])assert.throws(()=>parseLength(text,2));
  assert.throws(()=>parseLength('1',0));
  assert.equal(analysisRange(source,3,1).base64,'CA==');assert.equal(analysisRange(source,0,5).base64,source.base64);
  const selected=analysisRange({...source,size:9,truncated:true},3,2);assert.equal(selected.truncated,false);assert.equal(selected.size,2);assert.equal(selected.base64,'CAI=');
  assert.equal(analysisRange({...source,size:9,truncated:true},3).truncated,true);
  for(const length of [0,-1,3,0.5,NaN,Infinity,'2',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>analysisRange(source,3,length));
  const boundary={...source,base64:Buffer.alloc(65536,255).toString('base64'),size:65536};assert.equal(analysisRange(boundary,65535,1).base64,'/w==');assert.throws(()=>analysisRange(boundary,65535,2));
  const values=(hex,offset=0)=>Object.fromEntries(numericValues(Buffer.from(hex,'hex'),offset).rows.map(row=>[row.type,row]));
  const ordered=values('0102030405060708');assert.equal(ordered.uint16.le,'513');assert.equal(ordered.uint16.be,'258');assert.equal(ordered.uint32.le,'67305985');assert.equal(ordered.uint32.be,'16909060');assert.equal(ordered.uint64.le,'578437695752307201');assert.equal(ordered.uint64.be,'72623859790382856');
  const maximum=values('ffffffffffffffff');for(const endian of ['le','be']){assert.equal(maximum.uint64[endian],'18446744073709551615');assert.equal(maximum.int64[endian],'-1');assert.equal(maximum.float64[endian],'NaN');}
  const minimum=values('0000000000000080');assert.equal(minimum.int64.le,'-9223372036854775808');assert.equal(minimum.uint64.le,'9223372036854775808');assert.equal(minimum.float64.le,'-0');assert.equal(values('8000000000000000').float64.be,'-0');
  for(const [hex,value]of [['0000c03f','1.5'],['00000080','-0'],['0000807f','Infinity'],['000080ff','-Infinity'],['0000c07f','NaN']])assert.equal(values(hex).float32.le,value);
  assert.equal(values('3fc00000').float32.be,'1.5');assert.equal(values('000000000000f83f').float64.le,'1.5');assert.equal(values('3ff8000000000000').float64.be,'1.5');
  const tail=values('0000ff',2);assert.equal(tail.uint8.le,'255');assert.equal(tail.int8.be,'-1');assert.equal(tail.uint16.le,null);assert.equal(tail.float64.be,null);
  const slice=Buffer.from([99,1,2,3,88]).subarray(1,4),unaligned=numericValues(slice,1);assert.equal(unaligned.hex,'02 03');assert.equal(unaligned.available,2);assert.equal(unaligned.rows.find(row=>row.type==='uint16').le,'770');assert.deepEqual(slice,Buffer.from([1,2,3]));
  for(const offset of [-1,8,0.5,NaN,Infinity])assert.throws(()=>numericValues(Buffer.alloc(8),offset));assert.throws(()=>numericValues(Buffer.alloc(0),0));assert.throws(()=>numericValues(Buffer.alloc(65537),0));assert.equal(numericValues(Buffer.alloc(65536,255),65535).hex,'ff');
  const text=Buffer.from('Привет\0\r\n');assert.deepEqual(Buffer.from(payloadFile(4,{...message,kind:'TEXT',base64:text.toString('base64'),size:text.length}).bytes),text);
  assert.match(payloadFile(4,{...message,size:9,truncated:true}).name,/-partial\.bin$/);
  assert.equal(payloadFile(4,{...message,size:0,base64:''}).bytes.length,0);
  assert.equal(payloadFile(4,{...message,size:2**60,truncated:true}).bytes.length,2);
  for(const bad of [{...message,base64:' AP8='},{...message,base64:'bad!'},{...message,size:1},{...message,truncated:true},{...message,size:3},{...message,id:0},{...message,direction:'../'},{...message,kind:'bad'},{...message,base64:Buffer.alloc(65537).toString('base64'),size:65537}])assert.throws(()=>payloadFile(4,bad));
  assert.throws(()=>payloadFile(0,message));
  for(const [input,offset]of [['0',0],['00015',15],[' 0X0f ',15],['65535',65535]])assert.equal(parseOffset(input,65536),offset);
  for(const input of ['','-1','+1','1e3','0x','0x10000','65536','0x20000000000000'])assert.throws(()=>parseOffset(input,65536));assert.throws(()=>parseOffset('0',0));
  const row=offset=>offset.toString(16).padStart(6,'0')+'  '+Array.from({length:16},(_,i)=>(offset+i).toString(16).padStart(2,'0')).join(' ')+'  '+'.'.repeat(16);
  for(const offset of [0,16]){const line=row(offset),parts=hexHighlight(line,offset,15,2);assert.equal(parts.map(part=>part.text).join(''),line);assert.deepEqual(parts.filter(part=>part.hit).map(part=>part.text),[offset?'10':'0f','.']);}
  assert.equal(hexHighlight(row(0),0,100,2).some(part=>part.hit),false);
  const comparison=comparePayloads(Buffer.from([0,1,2,3,4]),Buffer.from([0,9,2,8,4,5]));
  assert.deepEqual(comparison,{common:5,max:6,same:3,changed:2,onlyA:0,onlyB:1,unknownA:0,unknownB:0,ranges:[{start:1,end:2,kind:'changed'},{start:3,end:4,kind:'changed'},{start:5,end:6,kind:'only_b'}]});
  assert.deepEqual(comparePayloads(Buffer.alloc(0),Buffer.alloc(0)).ranges,[]);assert.equal(comparePayloads(Buffer.from([1]),Buffer.alloc(0)).onlyA,1);
  const short=Buffer.from([1,2]),long=Buffer.from([1,2,3,4,5,6]);
  const partialDiff=comparePayloads(short,long,{sizeA:4,sizeB:6});
  assert.deepEqual(partialDiff,{common:2,max:6,same:2,changed:0,onlyA:0,onlyB:2,unknownA:2,unknownB:0,ranges:[{start:2,end:4,kind:'unknown_a'},{start:4,end:6,kind:'only_b'}]});
  const reverseDiff=comparePayloads(long,short,{sizeA:6,sizeB:4});
  assert.deepEqual(reverseDiff.ranges,[{start:2,end:4,kind:'unknown_b'},{start:4,end:6,kind:'only_a'}]);assert.equal(reverseDiff.onlyA,2);assert.equal(reverseDiff.unknownB,2);
  const hugePartial=comparePayloads(short,long,{sizeA:2**60,sizeB:2**60});assert.equal(hugePartial.max,6);assert.equal(hugePartial.onlyB,0);assert.equal(hugePartial.unknownA,4);
  const noSaved=comparePayloads(Buffer.alloc(0),Buffer.alloc(0),{sizeA:99,sizeB:100});assert.equal(noSaved.max,0);assert.deepEqual(noSaved.ranges,[]);
  assert.equal(comparePayloads(short,long,{sizeA:4,sizeB:100}).onlyB,2);
  for(const sizes of [{sizeA:1,sizeB:6},{sizeA:2,sizeB:5},{sizeA:NaN,sizeB:6},{sizeA:2,sizeB:Infinity},{sizeA:2.5,sizeB:6},{sizeA:'4',sizeB:6}])assert.throws(()=>comparePayloads(short,long,sizes));
  assert.deepEqual(short,Buffer.from([1,2]));assert.deepEqual(long,Buffer.from([1,2,3,4,5,6]));
  const alternating=Buffer.alloc(65536);for(let i=1;i<alternating.length;i+=2)alternating[i]=1;const many=comparePayloads(Buffer.alloc(65536),alternating);assert.equal(many.changed,32768);assert.equal(many.same,32768);assert.equal(many.ranges.length,32768);assert.throws(()=>comparePayloads(Buffer.alloc(65537),Buffer.alloc(0)));
  const root=path.resolve('target'),directory=await fs.mkdtemp(path.join(root,'ws-message-test-')),destination=path.join(directory,'payload.bin');
  try{
    await writePayload(destination,file.bytes);assert.deepEqual(await fs.readFile(destination),Buffer.from([0,255]));
    const rename=fs.rename;fs.rename=async()=>{throw Error('Simulated replacement failure');};
    try{await assert.rejects(()=>writePayload(destination,Buffer.from('replacement')),/replacement failure/);}finally{fs.rename=rename;}
    assert.deepEqual(await fs.readFile(destination),Buffer.from([0,255]));assert.deepEqual(await fs.readdir(directory),['payload.bin']);
    await writePayload(destination,Buffer.alloc(0));assert.equal((await fs.readFile(destination)).length,0);
  }finally{assert.equal(path.dirname(directory),root);await fs.rm(directory,{recursive:true,force:true});}
  console.log('PASS: exact binary / UTF-8 / empty / partial WS payloads, strict validation and atomic replacement / failure cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
