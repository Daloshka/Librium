const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { randomUUID, X509Certificate } = require('node:crypto');
const i18n = require('./i18n.cjs');
// The phone page is HTML, so translated text is escaped before it is inlined.
const t = (key, params) => i18n.t(key, params).replace(/[&<>]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[character]));

function privateIp(ip) {
  const parts = ip.split('.').map(Number);
  return net.isIPv4(ip) && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
function addresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries.filter(e => e.family === 'IPv4' && !e.internal && privateIp(e.address)).map(e => ({name, address:e.address, netmask:e.netmask})))
    .sort((a,b) => Number(/tun|tap|vpn|wsl|virtual|docker/i.test(a.name))-Number(/tun|tap|vpn|wsl|virtual|docker/i.test(b.name)) || a.name.localeCompare(b.name));
}
function sameSubnet(ip, local, mask) {
  if (ip?.startsWith('::ffff:')) ip=ip.slice(7);
  if (!net.isIPv4(ip || '')) return false;
  return ip.split('.').every((value,index) => (Number(value) & Number(mask.split('.')[index])) === (Number(local.split('.')[index]) & Number(mask.split('.')[index])));
}
function bind(server, port, host) {
  return new Promise((resolve,reject) => { server.once('error',reject); server.listen({port,host,exclusive:true},()=>{server.off('error',reject);resolve();}); });
}
function blockedPort(ports, port) { return ports.includes(Number(port)); }
function cleanHeaders(headers) {
  const result={...headers};
  for(const name of String(headers.connection || '').split(',')) delete result[name.trim().toLowerCase()];
  for(const name of ['connection','proxy-connection','proxy-authorization','keep-alive','upgrade','te','trailer','transfer-encoding']) delete result[name];
  return result;
}
class Mobile {
  constructor({getCertificate, listAddresses=addresses, corePort=8080, proxyPort=8080, certificatePort=8081, controlPorts=[3000,8080,8081]}) {
    this.getCertificate=getCertificate;this.listAddresses=listAddresses;this.corePort=corePort;this.proxyPort=proxyPort;this.certificatePort=certificatePort;this.controlPorts=controlPorts.map(Number);
    this.sockets=new Set();this.servers=[];this.active=null;this.lastClient=null;
  }
  status() { return {enabled:!!this.active, addresses:this.listAddresses(), ...this.active, lastClient:this.lastClient}; }
  track(socket) { this.sockets.add(socket); socket.on('close',()=>this.sockets.delete(socket));socket.on('error',()=>{}); }
  async enable(address) {
    if(this.active) {if(this.active.address===address)return this.status();throw Error(i18n.t('lan.busy'));}
    const adapter=this.listAddresses().find(a=>a.address===address);
    if(!adapter || !privateIp(address)) throw Error(i18n.t('lan.pickAddress'));
    const pem=await this.getCertificate(), der=new X509Certificate(pem).raw, key=randomUUID();
    const prefix='/'+key;
    const page=`<!doctype html><html lang="${i18n.lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t('lan.pageTitle')}</title><style>body{font:16px/1.6 system-ui;background:#151a2d;color:#d9e3ff;max-width:600px;padding:25px;margin:auto}a{display:block;background:#7553ba;padding:15px;border-radius:9px;color:white;text-align:center}code{color:#93e8c6}small{color:#a5b5d1}</style><h1>Librium · Wi-Fi</h1><p>${t('lan.pageIntro')}</p><a href="${prefix}/ca.crt">${t('lan.pageDownload')}</a><p>${t('lan.pageProxy')} <code>${address}</code><br>${t('lan.pagePort')} <code>${this.proxyPort}</code></p><h3>iPhone / iPad</h3><p>${t('lan.pageIos')}</p><p>${t('lan.pageIosProxy')}</p><h3>Android</h3><p>${t('lan.pageAndroid')}</p><p>${t('lan.pageCheck')}</p><small>${t('lan.pageNote')}</small></html>`;
    const serveCertificate=(req,res,path)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
      if(req.method!=='GET' && req.method!=='HEAD'){res.writeHead(405);res.end();return;}
      if(path===prefix+'/ca.crt'){res.writeHead(200,{'Content-Type':'application/x-x509-ca-cert','Content-Disposition':'attachment; filename="librium-ca.crt"','Content-Length':der.length});res.end(req.method==='HEAD'?undefined:der);}
      else if(path===prefix || path===prefix+'/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:page);}
      else {res.writeHead(404);res.end('Not found');}
    };
    const certServer=http.createServer((req,res)=>serveCertificate(req,res,req.url));
    const proxy=http.createServer((req,res)=>{
      let url;try{url=new URL(req.url);if(url.protocol!=='http:' || url.username || url.password)throw Error();}catch{res.writeHead(400);res.end('Absolute HTTP URL required');return;}
      if(url.hostname===address && Number(url.port)===this.certificatePort){serveCertificate(req,res,url.pathname);return;}
      if(blockedPort(this.controlPorts,url.port||80)){res.writeHead(403);res.end('Local control ports are not available through the phone proxy');return;}
      this.lastClient=req.socket.remoteAddress;
      const upstream=http.request({hostname:'127.0.0.1',port:this.corePort,path:req.url,method:req.method,headers:{...cleanHeaders(req.headers),host:url.host},agent:false},response=>{
        res.writeHead(response.statusCode,cleanHeaders(response.headers));response.pipe(res);
        response.on('error',()=>res.destroy());
      });
      upstream.setTimeout(60000,()=>upstream.destroy(Error('Upstream timeout')));
      upstream.on('socket',socket=>this.track(socket));
      upstream.on('error',()=>{if(!res.headersSent){res.writeHead(502);res.end('Librium core unavailable');}else res.destroy();});
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
    });
    proxy.on('connect',(req,client,head)=>{
      let authority;try{authority=new URL('http://'+req.url);if(!/^\d+$/.test(req.url.split(':').pop()) || authority.username || authority.password || authority.pathname!=='/' || authority.search || authority.hash || !authority.port && !req.url.endsWith(':80'))throw Error();}catch{client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;}
      if(blockedPort(this.controlPorts,authority.port||80)){client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
      this.lastClient=client.remoteAddress;
      const upstream=http.request({hostname:'127.0.0.1',port:this.corePort,method:'CONNECT',path:req.url,headers:{host:req.url},agent:false});
      upstream.setTimeout(15000,()=>upstream.destroy(Error('CONNECT timeout')));
      upstream.on('socket',socket=>this.track(socket));
      upstream.on('connect',(response,socket,upstreamHead)=>{
        if(response.statusCode!==200){socket.destroy();client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
        socket.setTimeout(0);client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if(upstreamHead.length)client.write(upstreamHead);if(head.length)socket.write(head);
        client.pipe(socket);socket.pipe(client);client.on('close',()=>socket.destroy());socket.on('close',()=>client.destroy());
      });
      upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());upstream.end();
    });
    for(const server of [proxy,certServer]){
      server.on('connection',socket=>{this.track(socket);if(!sameSubnet(socket.remoteAddress,address,adapter.netmask))socket.destroy();});
      server.on('clientError',(_error,socket)=>socket.destroy());
    }
    try{await bind(proxy,this.proxyPort,address);await bind(certServer,this.certificatePort,address);}
    catch(error){for(const socket of this.sockets)socket.destroy();for(const server of [proxy,certServer])server.close();throw Error(i18n.t('lan.portsFailed', {message: error.message}));}
    this.servers=[proxy,certServer];this.lastClient=null;
    this.active={address,proxyPort:this.proxyPort,certificatePort:this.certificatePort,url:`http://${address}:${this.certificatePort}${prefix}`};
    return this.status();
  }
  async disable(){for(const socket of this.sockets)socket.destroy();await Promise.all(this.servers.map(server=>new Promise(resolve=>server.close(resolve))));this.servers=[];this.active=null;this.lastClient=null;return this.status();}
}
module.exports={Mobile,addresses,sameSubnet,privateIp};
