// Sends a captured request again through the Librium proxy, so the replay shows up in the history
// next to the original. Chromium's network stack does the TLS and the CONNECT tunnel; a dedicated
// session keeps the app's own cookies and cache out of it and trusts the Librium CA explicitly.
const {net,session}=require('electron');
const {X509Certificate}=require('node:crypto');
const {t}=require('./i18n.cjs');
// Chromium sets these itself or forbids them; the captured values would only conflict.
const SKIP=/^(host|content-length|connection|proxy-connection|keep-alive|transfer-encoding|te|trailer|upgrade|expect|proxy-authorization)$/i;
let configured=null;
async function replaySession(proxyPort,caPem){
  const partition=session.fromPartition('librium-replay',{cache:false});
  const ca=new X509Certificate(caPem);
  const key=`${proxyPort}:${ca.fingerprint256}`;
  if(configured!==key){
    await partition.setProxy({proxyRules:`http=127.0.0.1:${proxyPort};https=127.0.0.1:${proxyPort}`,proxyBypassRules:'<-loopback>'});
    // Accept what the system trusts. When the only complaint is an unknown authority, accept a
    // chain whose certificate was issued and signed by the Librium CA: the proxy serves that CA's
    // leaf certificates, and it need not be installed system-wide for a replay to work.
    partition.setCertificateVerifyProc((request,callback)=>{
      if(request.errorCode===0||request.verificationResult==='net::OK')return callback(0);
      // Chromium reports the unknown authority before a name mismatch, so the name is checked here as well.
      if(request.verificationResult==='net::ERR_CERT_AUTHORITY_INVALID'){
        try{
          const leaf=new X509Certificate(request.certificate.data);
          if(leaf.checkHost(request.hostname)!==undefined){
            let certificate=request.certificate;
            while(certificate){
              const cert=new X509Certificate(certificate.data);
              if(cert.fingerprint256===ca.fingerprint256||(cert.checkIssued(ca)&&cert.verify(ca.publicKey)))return callback(0);
              certificate=certificate.issuerCert;
            }
          }
        }catch{}
      }
      callback(-2);
    });
    configured=key;
  }
  return partition;
}
// `edit` optionally replaces the method, the URL, the headers and (as text) the body before sending.
async function replay({detail,proxyPort,caPem,edit=null,timeoutMs=30000}){
  const url=edit?.url??detail.summary.url,method=edit?.method??detail.summary.method,headers=edit?.headers??detail.request.headers;
  if(!/^https?:$/.test(new URL(url).protocol))throw Error(t('replay.scheme'));
  if(detail.summary.status===101)throw Error(t('replay.websocket'));
  let body=detail.request.size>0?Buffer.from(detail.request.base64,'base64'):null;
  if(body&&(!detail.request.complete||detail.request.truncated))throw Error(t('replay.incomplete'));
  if(typeof edit?.body==='string')body=edit.body.length?Buffer.from(edit.body,'utf8'):null;
  const partition=await replaySession(proxyPort,caPem);
  const request=net.request({session:partition,url,method,redirect:'manual',credentials:'omit',useSessionCookies:false,cache:'no-store'});
  for(const [name,value] of headers)if(!SKIP.test(name)&&!(typeof edit?.body==='string'&&/^content-encoding$/i.test(name)))try{request.setHeader(name,value);}catch{}
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{request.abort();reject(Error(t('replay.timeout')));},timeoutMs);
    const done=result=>{clearTimeout(timer);resolve(result);};
    const fail=error=>{clearTimeout(timer);reject(error instanceof Error?error:Error(String(error)));};
    request.on('response',response=>{response.on('data',()=>{});response.on('end',()=>done({status:response.statusCode}));response.on('error',fail);});
    // The original was captured without following redirects; the replay stops at the same point.
    request.on('redirect',(statusCode)=>{done({status:statusCode});request.abort();});
    request.on('error',fail);
    if(body)request.write(body);
    request.end();
  });
}
module.exports={replay};
