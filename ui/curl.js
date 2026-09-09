(function(root){
  // A cURL command pasted into the request editor: shell quoting undone, the options that shape a
  // request picked out (method, URL, headers, body, basic auth, cookie, user agent, referer); the
  // rest (-s, -k, -L, --compressed, -o …) is ignored. Returns null when the text is not a curl call.
  function tokens(text){
    const out=[];let current='',quote=null,has=false;
    const src=String(text||'').replace(/\\\r?\n/g,' ');
    for(let i=0;i<src.length;i++){
      const c=src[i];
      if(quote==="'"){if(c==="'")quote=null;else current+=c;continue;}
      if(quote==='"'){if(c==='"')quote=null;else if(c==='\\'&&i+1<src.length&&'"\\$`'.includes(src[i+1])){current+=src[++i];}else current+=c;continue;}
      if(c==="'"||c==='"'){quote=c;has=true;continue;}
      if(c==='\\'&&i+1<src.length){current+=src[++i];has=true;continue;}
      if(/\s/.test(c)){if(has||current){out.push(current);current='';has=false;}continue;}
      current+=c;has=true;
    }
    if(has||current)out.push(current);
    return out;
  }
  const WITH_VALUE=new Set(['-X','--request','-H','--header','-d','--data','--data-raw','--data-binary','--data-ascii','--data-urlencode','-u','--user','-A','--user-agent','-e','--referer','-b','--cookie','--url','-o','--output','-m','--max-time','--connect-timeout','-w','--write-out','-c','--cookie-jar','-T','--upload-file','--proxy','-x','-F','--form','--form-string','--resolve','--cacert','--cert','--key','-U','--proxy-user','--retry','--limit-rate','-r','--range','-Q','--quote']);
  function parse(text){
    const list=tokens(text);
    const start=list.findIndex(token=>/^curl(\.exe)?$/i.test(token));
    if(start<0)return null;
    let method=null,url=null,body=[],get=false;const headers=[];const setHeader=(name,value)=>{const at=headers.findIndex(([k])=>k.toLowerCase()===name.toLowerCase());if(at>=0)headers[at]=[name,value];else headers.push([name,value]);};
    for(let i=start+1;i<list.length;i++){
      let token=list[i],value=null;
      const eq=token.startsWith('--')?token.indexOf('='):-1;
      if(eq>0){value=token.slice(eq+1);token=token.slice(0,eq);}
      else if(WITH_VALUE.has(token)){value=list[++i]??'';}
      else if(/^-[A-Za-z]{2,}$/.test(token)){
        // Bundled short flags such as -sS or -kL; a trailing value-taking one (-sX POST) takes the next token.
        const flags=token.slice(1).split('');const last='-'+flags.at(-1);
        for(const flag of flags.slice(0,-1))if(flag==='G')get=true;
        if(WITH_VALUE.has(last)){token=last;value=list[++i]??'';}else{if(flags.at(-1)==='G')get=true;continue;}
      }
      switch(token){
        case '-X':case '--request':method=value.toUpperCase();break;
        case '-H':case '--header':{const at=value.indexOf(':');if(at>0)setHeader(value.slice(0,at).trim(),value.slice(at+1).trim());break;}
        case '-d':case '--data':case '--data-raw':case '--data-binary':case '--data-ascii':body.push(value.startsWith('@')&&token!=='--data-raw'?'':value);break;
        case '--data-urlencode':body.push(value);break;
        case '-u':case '--user':setHeader('Authorization','Basic '+btoa(value));break;
        case '-A':case '--user-agent':setHeader('User-Agent',value);break;
        case '-e':case '--referer':setHeader('Referer',value);break;
        case '-b':case '--cookie':if(!/^[^=;]+$/.test(value)||value.includes('='))setHeader('Cookie',value);break;
        case '--url':url=value;break;
        case '-G':case '--get':get=true;break;
        case '-I':case '--head':method=method||'HEAD';break;
        default:
          if(value!==null)break; // a value-taking option we do not use
          if(token.startsWith('-'))break; // a plain flag
          if(url===null)url=token;
      }
    }
    if(url===null)return null;
    if(!/^https?:\/\//i.test(url))url='https://'+url.replace(/^\/*/,'');
    let payload=body.join('&');
    if(get&&payload){url+=(url.includes('?')?'&':'?')+payload;payload='';}
    if(!method)method=payload?'POST':'GET';
    if(payload&&!headers.some(([k])=>k.toLowerCase()==='content-type'))headers.push(['Content-Type','application/x-www-form-urlencoded']);
    return {method,url,headers,body:payload};
  }
  const api={parse,tokens};
  if(typeof module!=='undefined')module.exports=api;else root.LibriumCurl=api;
})(typeof window!=='undefined'?window:globalThis);
