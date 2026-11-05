const dns = require('node:dns').promises;
const net = require('node:net');
const fs = require('node:fs');

const IP_TTL = 7 * 24 * 3600e3, ERROR_TTL = 5 * 60e3, DNS_TTL = 5 * 60e3, RATE_LIMIT_PAUSE = 15 * 60e3, MAX_ENTRIES = 5000;

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const low = ip.toLowerCase();
  if (low.startsWith('::ffff:')) return privateAddress(low.slice(7));
  return low === '::1' || low === '::' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
}

class GeoIp {
  constructor({file, token = process.env.IPINFO_TOKEN || '', fetchImpl = fetch, lookup = host => dns.lookup(host)}) {
    this.file = file; this.token = token; this.fetch = fetchImpl; this.lookup = lookup;
    this.ips = new Map(); this.hosts = new Map(); this.pending = new Map(); this.pausedUntil = 0; this.saveTimer = null;
    try { for (const [ip, entry] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) if (Date.now() - entry.at < IP_TTL) this.ips.set(ip, entry); } catch {}
  }
  async resolve(host) {
    host = String(host || '').replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return host;
    const cached = this.hosts.get(host);
    if (cached && Date.now() - cached.at < DNS_TTL) return cached.ip;
    const {address} = await this.lookup(host);
    this.hosts.set(host, {ip: address, at: Date.now()});
    if (this.hosts.size > MAX_ENTRIES) this.hosts.delete(this.hosts.keys().next().value);
    return address;
  }
  async info(host) {
    let ip;
    try { ip = await this.resolve(host); } catch { return {ip: null, error: 'dns'}; }
    if (privateAddress(ip)) return {ip, private: true};
    const cached = this.ips.get(ip);
    if (cached && Date.now() - cached.at < (cached.error ? ERROR_TTL : IP_TTL)) return {ip, ...cached.data};
    if (Date.now() < this.pausedUntil) return {ip, error: 'rate'};
    if (!this.pending.has(ip)) this.pending.set(ip, this.request(ip).finally(() => this.pending.delete(ip)));
    return {ip, ...await this.pending.get(ip)};
  }
  async request(ip) {
    let data;
    try {
      const response = await this.fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json${this.token ? '?token=' + encodeURIComponent(this.token) : ''}`, {headers: {accept: 'application/json'}, signal: AbortSignal.timeout(5000)});
      if (response.status === 429) { this.pausedUntil = Date.now() + RATE_LIMIT_PAUSE; return {error: 'rate'}; }
      if (!response.ok) throw Error(String(response.status));
      const body = await response.json();
      const [, asn = '', org = body.org || ''] = /^(AS\d+)\s*(.*)$/.exec(body.org || '') || [];
      data = {asn, org, country: body.country || '', region: body.region || '', city: body.city || '', hostname: body.hostname || ''};
    } catch { data = {error: 'lookup'}; }
    this.ips.set(ip, {data, at: Date.now(), ...(data.error ? {error: true} : {})});
    if (this.ips.size > MAX_ENTRIES) this.ips.delete(this.ips.keys().next().value);
    if (!data.error) this.scheduleSave();
    return data;
  }
  scheduleSave() {
    if (this.saveTimer || !this.file) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const stored = Object.fromEntries([...this.ips].filter(([, entry]) => !entry.error));
      fs.promises.writeFile(this.file, JSON.stringify(stored)).catch(() => {});
    }, 2000);
    this.saveTimer.unref?.();
  }
}
module.exports = {GeoIp, privateAddress};
