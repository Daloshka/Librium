const {mediaFile}=require('../desktop/media-save.cjs');
const fs=require('node:fs'),zlib=require('node:zlib'),assert=require('node:assert/strict');
for(const [file,mime] of [['desktop/assets/icon.png','image/png'],['target/svg-test.svg','image/svg+xml'],['target/audio-test.ogg','audio/ogg']]){
 const bytes=fs.readFileSync(file),compressed=zlib.gzipSync(bytes);
 const detail={summary:{id:42,url:'https://example.test/'+file.split('/').pop()},response:{headers:[['content-type',mime],['content-encoding','gzip']],base64:compressed.toString('base64'),complete:true,truncated:false}};
 const result=mediaFile(detail,'response');assert.deepEqual(result.bytes,bytes);assert.equal(result.name,file.split('/').pop());
 detail.response.truncated=true;assert.throws(()=>mediaFile(detail,'response'),/не целиком|not stored in full/);
}
console.log('Media download: PNG, SVG, OGG bytes preserved after HTTP decompression; partial files rejected');
