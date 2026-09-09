// Query parameters, form bodies and cookies as name/value pairs. Shared by the inspector's Params
// and Cookies tabs and by the HAR export in the desktop process.
(function(root){
  function queryParams(url){try{return [...new URL(url).searchParams].map(([name,value])=>({name,value}));}catch{return [];}}
  function formParams(text,contentType){
    if(!/^application\/x-www-form-urlencoded/i.test(contentType||'')||!text)return [];
    try{return [...new URLSearchParams(text)].map(([name,value])=>({name,value}));}catch{return [];}
  }
  function cookiePairs(raw){
    return String(raw).split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const at=part.indexOf('=');return at<0?{name:part,value:''}:{name:part.slice(0,at).trim(),value:part.slice(at+1).trim()};});
  }
  function requestCookies(headers){return headers.filter(([key])=>key.toLowerCase()==='cookie').flatMap(([,value])=>cookiePairs(value));}
  // Set-Cookie: the pair plus its attributes, as HAR names them.
  function responseCookies(headers){
    return headers.filter(([key])=>key.toLowerCase()==='set-cookie').map(([,value])=>{
      const [pair,...attributes]=String(value).split(';');
      const cookie=cookiePairs(pair)[0]||{name:'',value:''};
      for(const attribute of attributes){
        const [name,...rest]=attribute.split('=');const key=name.trim().toLowerCase(),setting=rest.join('=').trim();
        if(key==='path')cookie.path=setting;else if(key==='domain')cookie.domain=setting;else if(key==='expires')cookie.expires=setting;else if(key==='max-age')cookie.maxAge=setting;else if(key==='samesite')cookie.sameSite=setting;else if(key==='httponly')cookie.httpOnly=true;else if(key==='secure')cookie.secure=true;
      }
      return cookie;
    });
  }
  const api={queryParams,formParams,cookiePairs,requestCookies,responseCookies};
  if(typeof module!=='undefined')module.exports=api;else root.LibriumParams=api;
})(globalThis);
