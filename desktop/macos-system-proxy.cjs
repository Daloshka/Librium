'use strict';

const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { isIP } = require('node:net');
const os = require('node:os');
const { dirname, join } = require('node:path');
const { domainToASCII } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');

const run = promisify(execFile);
const pollInterval = 2000;
const authorizationTimeout = 90000;
const leaseSeconds = 10;
const defaultRoutes = { mode: 'all', domains: [] };

class SystemProxyError extends Error {}

function proxySettings(stdout) {
  return Object.fromEntries([...stdout.matchAll(/^  (\w+) : ([^\r\n]+)$/gm)].map(([, key, value]) => [key, value.trim()]));
}

function hasProxy(settings) {
  return ['HTTP', 'HTTPS', 'SOCKS', 'ProxyAutoConfig', 'ProxyAutoDiscovery'].some(key => settings[key + 'Enable'] === '1');
}

function usesPac(settings, url) {
  return settings.ProxyAutoConfigEnable === '1' && settings.ProxyAutoConfigURLString === url;
}

async function readProxySettings() {
  return proxySettings((await run('/usr/sbin/scutil', ['--proxy'], { timeout: 2000 })).stdout);
}

const tunnelName = /^(?:utun|tun|tap|ppp|ipsec|wg)\d+$/i;
const vpnStates = new Set(['connected', 'connecting', 'disconnecting', 'disconnected']);

function networkSnapshot(connections, ipv4, ipv6, interfaces) {
  const profiles = [];
  for (const line of (connections || '').split('\n')) {
    const match = line.match(/^\s*\*?\s*\(([^)]+)\)\s+([\da-f-]{36})\s+(VPN|PPP|IPSec)\b.*?\s+"(.*)"\s+\[/i);
    if (!match) continue;
    const [, state, id, type, name] = match;
    if (type.toUpperCase() !== 'VPN' && !/\[(?:PPP|IPSec):(?:PPTP|L2TP|IPSec)\]/i.test(line)) continue;
    const status = state.toLowerCase();
    profiles.push({ id, name, status: vpnStates.has(status) ? status : 'unknown' });
  }
  profiles.sort((a, b) => Number(b.status === 'connected') - Number(a.status === 'connected') || a.name.localeCompare(b.name));

  const routeInterface = text => text?.match(/^\s*interface:\s+(\S+)/m)?.[1] || '';
  const defaults = { ipv4: routeInterface(ipv4), ipv6: routeInterface(ipv6) };
  const defaultTunnel = Object.values(defaults).some(name => tunnelName.test(name));
  // macOS itself creates utun devices. Only list a non-default tunnel as a candidate
  // when it has an address beyond link-local; that still does not identify its owner.
  const tunnels = Object.entries(interfaces).filter(([name, addresses]) => tunnelName.test(name) && (
    Object.values(defaults).includes(name) || addresses.some(address => !address.internal && !/^fe80:/i.test(address.address))
  )).map(([name]) => name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const vpn = profiles.some(profile => profile.status === 'connected') || defaultTunnel
    ? true : connections !== undefined && (defaults.ipv4 || defaults.ipv6) ? false : null;
  return { vpn, profiles, defaults, tunnels: [...new Set([...Object.values(defaults).filter(name => tunnelName.test(name)), ...tunnels])] };
}

async function detectNetwork() {
  const env = { ...process.env, LC_ALL: 'C' };
  const read = (command, args) => run(command, args, { env, timeout: 2000 }).then(result => result.stdout, () => undefined);
  const [connections, ipv4, ipv6] = await Promise.all([
    read('/usr/sbin/scutil', ['--nc', 'list']),
    read('/sbin/route', ['-n', 'get', 'default']),
    read('/sbin/route', ['-n', 'get', '-inet6', 'default']),
  ]);
  return networkSnapshot(connections, ipv4, ipv6, os.networkInterfaces());
}

function parseRoutes(value) {
  const { mode, domains } = value || {};
  if (!['all', 'only', 'except'].includes(mode) || !Array.isArray(domains) || domains.length > 100) {
    throw new SystemProxyError('proxyRoutes.invalid');
  }
  const normalized = domains.map(value => {
    if (typeof value !== 'string' || value.length > 253) throw new SystemProxyError('proxyRoutes.invalid');
    const name = domainToASCII(value.trim().replace(/^\*\./, '').replace(/\.$/, '')).toLowerCase();
    if (/[\s/:?#@\\%]/.test(value.trim()) || name.length > 253 || isIP(name) || /\.(?:local|localhost)$/.test(name) ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
      throw new SystemProxyError('proxyRoutes.invalid');
    }
    return name;
  });
  if (mode !== 'all' && normalized.length === 0) throw new SystemProxyError('proxyRoutes.empty');
  return { mode, domains: [...new Set(normalized)] };
}

function pacChecks(routes, port) {
  const proxy = `PROXY 127.0.0.1:${port}`;
  if (routes.mode === 'all') return [['http://example.com/', proxy], ['https://example.com/', proxy]];
  const domain = routes.domains[0];
  let index = 0;
  while (routes.domains.includes(`librium-check-${index}.invalid`)) index++;
  const sample = `librium-check-${index}.invalid`;
  const included = routes.mode === 'only';
  return [[`https://${domain}/`, included ? proxy : 'DIRECT'], [`http://${sample}/`, included ? 'DIRECT' : proxy]];
}

function pacScript(port, routes = defaultRoutes) {
  // Loopback and local services must stay reachable directly. DIRECT also lets PAC-aware
  // clients recover while the OS is withdrawing the temporary setting after a proxy failure.
  return `function FindProxyForURL(url, host) {
  host = host.toLowerCase().replace(/\\.$/, '');
  var localV4 = /^[0-9.]+$/.test(host) && /^(?:(?:127|10)\\.|192\\.168\\.|169\\.254\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.)/.test(host);
  var localV6 = /^(?:::1$|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/.test(host.replace(/^\\[|\\]$/g, ''));
  if ((host.indexOf(':') < 0 && isPlainHostName(host)) || dnsDomainIs(host, '.localhost') || dnsDomainIs(host, '.local') || localV4 || localV6) return 'DIRECT';
  var mode = ${JSON.stringify(routes.mode)};
  if (mode !== 'all') {
    var domains = ${JSON.stringify(routes.domains)};
    var matched = false;
    for (var i = 0; i < domains.length; i++) {
      if (host === domains[i] || dnsDomainIs(host, '.' + domains[i])) { matched = true; break; }
    }
    if (mode === 'only' ? !matched : matched) return 'DIRECT';
  }
  return 'PROXY 127.0.0.1:${port}; DIRECT';
}`;
}

async function servePac(port, id) {
  const path = `/librium-${id}.pac`;
  const scripts = new Map();
  const server = http.createServer({ requestTimeout: 3000, keepAliveTimeout: 1000 }, (req, res) => {
    const script = scripts.get(req.url);
    if (!['GET', 'HEAD'].includes(req.method) || !script) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Cache-Control': 'no-store' }).end(script);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}${path}`;
  return {
    url,
    publish: (revision, routes) => {
      if (scripts.size === 4) scripts.delete(scripts.keys().next().value);
      scripts.set(`${path}?v=${revision}`, pacScript(port, routes));
      return `${url}?v=${revision}`;
    },
    close: () => server.close(),
  };
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

function helperCommand({ lease, url, id }) {
  const key = `State:/Network/Service/${id}/Proxies`;
  const commands = [
    'd.init',
    'd.add ProxyAutoConfigEnable # 1',
    `d.add ProxyAutoConfigURLString ${url}?v=1`,
    'd.add SupplementalMatchDomains * ""',
    `add ${key} temporary`,
  ];
  // configd owns this synthetic service for the lifetime of scutil's session. Closing the
  // session removes only this key, so the VPN's and user's current settings are exposed again.
  return `lease=${shellQuote(lease)}
fresh() {
  /bin/kill -0 ${process.pid} 2>/dev/null || return 1
  modified=$(/usr/bin/stat -f %m "$lease" 2>/dev/null) || return 1
  now=$(/bin/date +%s) || return 1
  [ "$now" -ge "$modified" ] && [ "$((now - modified))" -lt ${leaseSeconds} ]
}
fresh || exit 0
if /usr/sbin/scutil --proxy | /usr/bin/grep -Eq '^  (HTTP|HTTPS|SOCKS|ProxyAutoConfig|ProxyAutoDiscovery)Enable : 1$'; then
  exit 2
fi
{
  /usr/bin/printf '%s\\n' ${commands.map(shellQuote).join(' ')}
  revision=1
  while fresh; do
    next=$(/usr/bin/stat -f %m "$lease.revision" 2>/dev/null) || break
    case "$next" in
      ''|*[!0-9]*) break ;;
    esac
    if [ "$revision" != "$next" ]; then
      /usr/bin/printf '%s\\n' ${shellQuote(`d.add ProxyAutoConfigURLString ${url}?v=`)}"$next" ${shellQuote(`set ${key}`)}
      revision=$next
    fi
    /bin/sleep 1
  done
  /usr/bin/printf '%s\\n' quit
} | /usr/sbin/scutil`;
}

function startHelper(spec) {
  const child = spawn('/usr/bin/osascript', [
    '-e', 'on run argv',
    '-e', 'with timeout of 604800 seconds',
    '-e', 'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges',
    '-e', 'end timeout', '-e', 'end run', helperCommand(spec), spec.prompt,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  const worker = { stopped: false, cancelled: false, stop: () => child.kill() };
  worker.done = new Promise(resolve => {
    child.once('error', () => { worker.stopped = true; resolve(); });
    child.once('close', () => {
      worker.stopped = true;
      worker.cancelled = stderr.includes('(-128)');
      resolve();
    });
  });
  return worker;
}

async function verifyCertificate(dir, certificate) {
  const file = join(dir, 'ca.crt');
  fs.writeFileSync(file, certificate, { mode: 0o600 });
  try {
    await run('/usr/bin/security', ['verify-cert', '-q', '-L', '-l', '-p', 'ssl', '-c', file], { timeout: 5000 });
  } catch {
    throw new SystemProxyError('systemProxy.certificate');
  }
}

class MacSystemProxy {
  constructor({ coreStatus, certificate, resolveProxy, onError, prompt, routesFile, readSettings = readProxySettings,
    launch = startHelper, checkCertificate = verifyCertificate, activationTimeout = authorizationTimeout }) {
    Object.assign(this, { coreStatus, certificate, resolveProxy, onError, prompt, routesFile, readSettings, launch, checkCertificate, activationTimeout });
    this.current = null;
    this.issue = '';
    this.routes = defaultRoutes;
    if (routesFile) {
      try { this.routes = parseRoutes(JSON.parse(fs.readFileSync(routesFile, 'utf8'))); }
      catch { /* No saved routes or the last file could not be read. */ }
    }
  }

  get inUse() {
    return Boolean(this.current);
  }

  async status() {
    return { ...await detectNetwork(), enabled: this.current?.phase === 'active', busy: this.inUse && this.current.phase !== 'active', issue: this.issue, routes: this.routes };
  }

  ensureCurrent(entry) {
    if (this.current !== entry || entry.phase === 'stopping') throw new SystemProxyError('systemProxy.cancelled');
  }

  saveRoutes(routes) {
    if (this.routesFile) {
      fs.mkdirSync(dirname(this.routesFile), { recursive: true });
      const temporary = `${this.routesFile}.part`;
      fs.writeFileSync(temporary, JSON.stringify(routes), { mode: 0o600 });
      fs.renameSync(temporary, this.routesFile);
    }
    this.routes = routes;
  }

  publishRoutes(entry, routes) {
    entry.revision++;
    const url = entry.pac.publish(entry.revision, routes);
    fs.utimesSync(`${entry.lease}.revision`, entry.revision, entry.revision);
    return url;
  }

  async verifyPac(entry, url, routes, timeout) {
    const checks = pacChecks(routes, entry.port);
    const deadline = Date.now() + timeout;
    let visibleSince = 0;
    while (Date.now() < deadline) {
      this.ensureCurrent(entry);
      if (entry.worker.stopped) throw new SystemProxyError(entry.worker.cancelled ? 'systemProxy.cancelled' : 'systemProxy.failed');
      if (usesPac(await this.readSettings(), url)) {
        visibleSince ||= Date.now();
        const resolved = await Promise.race([this.resolveProxy(checks.map(([url]) => url), url), delay(3000, [], { ref: false })]);
        if (resolved.length === checks.length && resolved.every((value, i) => value.split(';')[0].trim() === checks[i][1])) {
          this.ensureCurrent(entry);
          entry.activeUrl = url;
          return;
        }
        if (Date.now() - visibleSince > 5000) break;
      }
      await delay(350);
    }
    throw new SystemProxyError('systemProxy.ignored');
  }

  async setRoutes(input) {
    const routes = parseRoutes(input);
    if (JSON.stringify(routes) === JSON.stringify(this.routes)) return;
    const entry = this.current;
    if (!entry) { this.saveRoutes(routes); return; }
    if (entry.phase !== 'active') throw new SystemProxyError('systemProxy.busy');

    const previous = this.routes;
    entry.phase = 'updating';
    try {
      await this.verifyPac(entry, this.publishRoutes(entry, routes), routes, 6000);
      this.saveRoutes(routes);
    } catch {
      if (this.current === entry && entry.phase !== 'stopping') {
        try { await this.verifyPac(entry, this.publishRoutes(entry, previous), previous, 6000); }
        catch { await this.disable('systemProxy.changed'); }
      }
      throw new SystemProxyError('proxyRoutes.applyFailed');
    } finally {
      if (this.current === entry && entry.phase === 'updating') entry.phase = 'active';
    }
  }

  async enable() {
    if (this.inUse) return;
    this.issue = '';
    const entry = { phase: 'starting', revision: 0 };
    this.current = entry;
    try {
      const { port, intercept } = await this.coreStatus();
      if (intercept) throw new SystemProxyError('systemProxy.intercept');
      if (!Number.isInteger(port) || port < 1 || port >= 65535) throw new SystemProxyError('systemProxy.core');
      entry.port = port;
      if (hasProxy(await this.readSettings())) throw new SystemProxyError('systemProxy.existing');
      this.ensureCurrent(entry);

      const id = randomUUID().toUpperCase();
      entry.dir = fs.mkdtempSync(join(os.tmpdir(), 'librium-proxy-'));
      await this.checkCertificate(entry.dir, await this.certificate());
      this.ensureCurrent(entry);
      const pac = await servePac(port, id);
      if (this.current !== entry || entry.phase === 'stopping') { pac.close(); this.ensureCurrent(entry); }
      entry.pac = pac;
      entry.lease = join(entry.dir, 'lease');
      fs.writeFileSync(entry.lease, '', { mode: 0o600 });
      fs.writeFileSync(`${entry.lease}.revision`, '', { mode: 0o600 });
      const url = this.publishRoutes(entry, this.routes);
      entry.worker = this.launch({ lease: entry.lease, url: pac.url, id, prompt: this.prompt() });
      this.monitor(entry, port);
      await this.verifyPac(entry, url, this.routes, this.activationTimeout);
      this.ensureCurrent(entry);
      entry.phase = 'active';
    } catch (error) {
      if (this.current === entry && entry.phase !== 'stopping') {
        await this.disable(error instanceof SystemProxyError ? error.message : 'systemProxy.failed');
      }
    }
  }

  monitor(entry, port) {
    entry.timer = setTimeout(async () => {
      try {
        this.ensureCurrent(entry);
        const core = await this.coreStatus();
        this.ensureCurrent(entry);
        if (core.intercept || core.port !== port) {
          await this.disable(core.intercept ? 'systemProxy.intercept' : 'systemProxy.core');
          return;
        }
        const activeUrl = entry.activeUrl;
        if (entry.phase === 'active' && (entry.worker.stopped || !usesPac(await this.readSettings(), activeUrl)) &&
            entry.phase === 'active' && entry.activeUrl === activeUrl) {
          await this.disable('systemProxy.changed');
          return;
        }
        this.ensureCurrent(entry);
        const now = new Date();
        fs.utimesSync(entry.lease, now, now);
        this.monitor(entry, port);
      } catch {
        if (this.current === entry && entry.phase !== 'stopping') await this.disable('systemProxy.core');
      }
    }, pollInterval);
  }

  async disable(issue = '') {
    const entry = this.current;
    if (!entry) return;
    if (entry.phase === 'stopping') return entry.stopping;
    entry.phase = 'stopping';
    clearTimeout(entry.timer);
    entry.stopping = (async () => {
      let shutdownTimeout = 2500;
      if (entry.dir) {
        try { fs.rmSync(entry.dir, { recursive: true, force: true }); }
        catch { shutdownTimeout = (leaseSeconds + 2) * 1000; }
      }
      if (entry.worker) {
        await Promise.race([entry.worker.done, delay(shutdownTimeout)]);
        if (!entry.worker.stopped) entry.worker.stop();
        for (let attempt = 0; attempt < 10; attempt++) {
          const settings = await this.readSettings().catch(() => ({}));
          if (!settings.ProxyAutoConfigURLString?.startsWith(`${entry.pac.url}?v=`)) break;
          await delay(150);
        }
      }
      entry.pac?.close();
      this.current = null;
      this.issue = issue;
      if (issue) this.onError(issue);
    })();
    return entry.stopping;
  }
}

module.exports = { MacSystemProxy, SystemProxyError, pacScript, proxySettings, hasProxy, helperCommand, networkSnapshot, parseRoutes };
