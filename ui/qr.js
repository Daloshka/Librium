// QR code encoder: byte mode, error correction level M, versions 1–10.
(function(root){
  const EC_PER_BLOCK=[10,16,26,18,24,16,18,22,22,26],BLOCKS=[1,1,1,2,2,4,4,4,5,5];
  const rawModules=v=>{let r=(16*v+128)*v+64;if(v>=2){const n=Math.floor(v/7)+2;r-=(25*n-10)*n-55;if(v>=7)r-=36;}return r;};
  const alignment=v=>{if(v===1)return[];const n=Math.floor(v/7)+2,step=Math.ceil((v*4+4)/(n*2-2))*2,r=[6];for(let p=v*4+10;r.length<n;p-=step)r.splice(1,0,p);return r;};
  const mul=(x,y)=>{let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11d);z^=((y>>>i)&1)*x;}return z;};
  function reedSolomon(data,degree){
    const div=new Array(degree).fill(0);div[degree-1]=1;let root=1;
    for(let i=0;i<degree;i++){for(let j=0;j<degree;j++){div[j]=mul(div[j],root);if(j+1<degree)div[j]^=div[j+1];}root=mul(root,2);}
    const out=new Array(degree).fill(0);
    for(const b of data){const f=b^out.shift();out.push(0);div.forEach((c,i)=>out[i]^=mul(c,f));}
    return out;
  }
  function encode(text){
    const bytes=[...new TextEncoder().encode(text)];
    let v=1;
    for(;v<=10;v++){const cap=Math.floor(rawModules(v)/8)-EC_PER_BLOCK[v-1]*BLOCKS[v-1];if(4+(v<=9?8:16)+bytes.length*8<=cap*8)break;}
    if(v>10)throw Error('Text is too long for a QR code');
    const ecLen=EC_PER_BLOCK[v-1],blocks=BLOCKS[v-1],total=Math.floor(rawModules(v)/8),dataLen=total-ecLen*blocks;
    const bits=[],put=(val,n)=>{for(let i=n-1;i>=0;i--)bits.push((val>>>i)&1);};
    put(4,4);put(bytes.length,v<=9?8:16);bytes.forEach(b=>put(b,8));
    put(0,Math.min(4,dataLen*8-bits.length));while(bits.length%8)bits.push(0);
    const data=[];for(let i=0;i<bits.length;i+=8)data.push(parseInt(bits.slice(i,i+8).join(''),2));
    for(let pad=0xec;data.length<dataLen;pad^=0xec^0x11)data.push(pad);
    const shortLen=Math.floor(total/blocks),shortCount=blocks-total%blocks,parts=[];
    for(let i=0,k=0;i<blocks;i++){const d=data.slice(k,k+=shortLen-ecLen+(i<shortCount?0:1));parts.push({d,e:reedSolomon(d,ecLen)});}
    const codewords=[];
    for(let i=0;i<=shortLen-ecLen;i++)parts.forEach(p=>{if(i<p.d.length)codewords.push(p.d[i]);});
    for(let i=0;i<ecLen;i++)parts.forEach(p=>codewords.push(p.e[i]));
    const size=v*4+17,m=[...Array(size)].map(()=>new Array(size).fill(false)),fn=[...Array(size)].map(()=>new Array(size).fill(false));
    const set=(x,y,d)=>{m[y][x]=d;fn[y][x]=true;};
    for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0);}
    for(const [cx,cy] of [[3,3],[size-4,3],[3,size-4]])for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const x=cx+dx,y=cy+dy,d=Math.max(Math.abs(dx),Math.abs(dy));if(x>=0&&x<size&&y>=0&&y<size)set(x,y,d!==2&&d!==4);}
    const al=alignment(v);
    al.forEach((ay,i)=>al.forEach((ax,j)=>{if((i===0&&j===0)||(i===0&&j===al.length-1)||(i===al.length-1&&j===0))return;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(ax+dx,ay+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);}));
    const drawFormat=mask=>{
      const d=(0<<3|mask);let r=d;for(let i=0;i<10;i++)r=(r<<1)^((r>>>9)*0x537);const b=((d<<10)|r)^0x5412,bit=i=>((b>>>i)&1)===1;
      for(let i=0;i<=5;i++)set(8,i,bit(i));set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));for(let i=9;i<15;i++)set(14-i,8,bit(i));
      for(let i=0;i<8;i++)set(size-1-i,8,bit(i));for(let i=8;i<15;i++)set(8,size-15+i,bit(i));set(8,size-8,true);
    };
    drawFormat(0);
    if(v>=7){let r=v;for(let i=0;i<12;i++)r=(r<<1)^((r>>>11)*0x1f25);const b=(v<<12)|r;for(let i=0;i<18;i++){const bit=((b>>>i)&1)===1,a=size-11+i%3,c=Math.floor(i/3);set(a,c,bit);set(c,a,bit);}}
    let i=0;
    for(let right=size-1;right>=1;right-=2){if(right===6)right=5;for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){const x=right-j,up=((right+1)&2)===0,y=up?size-1-vert:vert;if(!fn[y][x]&&i<codewords.length*8){m[y][x]=((codewords[i>>>3]>>>(7-(i&7)))&1)===1;i++;}}}
    const masks=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,x=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,(x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];
    const applyMask=k=>{for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(!fn[y][x]&&masks[k](x,y))m[y][x]=!m[y][x];};
    const penalty=()=>{
      let p=0;const line=get=>{let run=1,prev=get(0),hist=[];for(let k=1;k<=size;k++){const c=k<size?get(k):null;if(c===prev)run++;else{if(run>=5)p+=run-2;hist.push(run);run=1;prev=c;}}const s=[];for(let k=0;k<size;k++)s.push(get(k)?1:0);const str=s.join('');for(const pat of ['10111010000','00001011101'])for(let k=str.indexOf(pat);k!==-1;k=str.indexOf(pat,k+1))p+=40;};
      for(let y=0;y<size;y++)line(x=>m[y][x]);for(let x=0;x<size;x++)line(y=>m[y][x]);
      let dark=0;for(let y=0;y<size;y++)for(let x=0;x<size;x++){if(m[y][x])dark++;if(x<size-1&&y<size-1&&m[y][x]===m[y][x+1]&&m[y][x]===m[y+1][x]&&m[y][x]===m[y+1][x+1])p+=3;}
      return p+Math.floor(Math.abs(dark*20-size*size*10)/(size*size))*10;
    };
    let best=0,bestScore=Infinity;
    for(let k=0;k<8;k++){applyMask(k);drawFormat(k);const s=penalty();if(s<bestScore){bestScore=s;best=k;}applyMask(k);}
    applyMask(best);drawFormat(best);
    return m;
  }
  function svg(text,quiet=4){
    const m=encode(text),n=m.length+quiet*2;let path='';
    m.forEach((row,y)=>row.forEach((dark,x)=>{if(dark)path+=`M${x+quiet} ${y+quiet}h1v1h-1z`;}));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }
  const api={encode,svg};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.qr=api;
})(this);
