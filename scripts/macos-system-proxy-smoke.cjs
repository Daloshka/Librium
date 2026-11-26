'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const vm = require('node:vm');
const { MacSystemProxy, pacScript, proxySettings, hasProxy, networkSnapshot, parseRoutes } = require('../desktop/macos-system-proxy.cjs');

function proxyResolver(script) {
  const sandbox = { isPlainHostName: host => !host.includes('.'), dnsDomainIs: (host, suffix) => host.endsWith(suffix) };
  vm.runInNewContext(script, sandbox);
  return url => sandbox.FindProxyForURL(url, new URL(url).hostname);
}

test('PAC sends remote traffic through the selected port and keeps a direct fallback', () => {
  const resolve = proxyResolver(pacScript(9080));
  const proxyFor = host => resolve(`https://${host}/`);
  for (const host of ['localhost', '127.0.0.1', '192.168.0.4', '172.16.0.2', '[::1]', 'foo.local.']) {
    assert.equal(proxyFor(host), 'DIRECT', host);
  }
  for (const host of ['example.com', '10.example.com', '172.32.0.1', '[2001:db8::1]']) {
    assert.equal(proxyFor(host), 'PROXY 127.0.0.1:9080; DIRECT', host);
  }
});

test('site routes match exact domains and their subdomains', () => {
  const domains = ['*.Example.com', 'example.com.'];
  const only = parseRoutes({ mode: 'only', domains });
  assert.deepEqual(only, { mode: 'only', domains: ['example.com'] });
  const selected = proxyResolver(pacScript(9080, only));
  const excluded = proxyResolver(pacScript(9080, parseRoutes({ mode: 'except', domains })));
  for (const host of ['example.com', 'sub.example.com']) {
    assert.match(selected(`https://${host}/`), /^PROXY /);
    assert.equal(excluded(`https://${host}/`), 'DIRECT');
  }
  for (const host of ['other.com', 'impostorexample.com']) {
    assert.equal(selected(`https://${host}/`), 'DIRECT');
    assert.match(excluded(`https://${host}/`), /^PROXY /);
  }
  assert.throws(() => parseRoutes({ mode: 'only', domains: [] }), /proxyRoutes.empty/);
  assert.throws(() => parseRoutes({ mode: 'except', domains: ['https://example.com/'] }), /proxyRoutes.invalid/);
});

test('network configuration checks read the effective proxy, not disabled or scoped entries', () => {
  const scoped = '<dictionary> {\n  HTTPEnable : 0\n  __SCOPED__ : <dictionary> {\n    en0 : <dictionary> {\n      HTTPEnable : 1\n    }\n  }\n}';
  assert.equal(hasProxy(proxySettings(scoped)), false);
  assert.equal(hasProxy(proxySettings('<dictionary> {\n  ProxyAutoConfigEnable : 1\n}')), true);
});

test('VPN detection reports named profiles, IPv6 routes and unnamed tunnel candidates', () => {
  const services = [
    '* (Disconnected) 12345678-1234-1234-1234-1234567890AA VPN (org.example.first) "First VPN" [VPN:org.example.first]',
    '* (Connected) 12345678-1234-1234-1234-1234567890BB VPN (org.example.second) "Work Tunnel" [VPN:org.example.second]',
    '* (Connected) 12345678-1234-1234-1234-1234567890CC PPP (PPPoE) "Broadband" [PPP:PPPoE]',
  ].join('\n');
  const interfaces = {
    utun0: [{ address: 'fe80::1', internal: false }],
    utun5: [{ address: '10.1.2.3', internal: false }],
  };
  const network = networkSnapshot(services, '  interface: en0', '', interfaces);
  assert.equal(network.vpn, true);
  assert.deepEqual(network.profiles.map(({ name, status }) => [name, status]), [['Work Tunnel', 'connected'], ['First VPN', 'disconnected']]);
  assert.deepEqual(network.tunnels, ['utun5']);
  assert.deepEqual(network.defaults, { ipv4: 'en0', ipv6: '' });
  assert.equal(networkSnapshot('', '  interface: en0', '  interface: utun4', interfaces).vpn, true);
  assert.deepEqual(networkSnapshot('', '', '  interface: utun4', {}).tunnels, ['utun4']);
  assert.equal(networkSnapshot('', '  interface: en0', '', interfaces).vpn, false);
  assert.equal(networkSnapshot(undefined, '', '', {}).vpn, null);
});

function setup(t, options = {}) {
  let settings = options.settings || {};
  const original = settings;
  let core = { port: 9080, intercept: Boolean(options.intercept) };
  let lease;
  let issues = [];
  const proxy = new MacSystemProxy({
    coreStatus: async () => core,
    certificate: async () => 'test CA',
    checkCertificate: async () => {},
    readSettings: async () => settings,
    resolveProxy: async urls => {
      if (options.result) return urls.map(() => options.result);
      const response = await fetch(settings.ProxyAutoConfigURLString);
      const resolve = proxyResolver(await response.text());
      return urls.map(resolve);
    },
    prompt: () => 'test',
    onError: issue => { issues.push(issue); },
    activationTimeout: 400,
    launch: spec => {
      lease = spec.lease;
      if (options.cancel) return { stopped: true, cancelled: true, done: Promise.resolve(), stop() {} };
      settings = { ProxyAutoConfigEnable: '1', ProxyAutoConfigURLString: `${spec.url}?v=1` };
      const worker = { stopped: false, stop: () => release() };
      let release;
      worker.done = new Promise(resolve => {
        const timer = setInterval(() => {
          if (!fs.existsSync(lease)) { release(); return; }
          const revision = Math.floor(fs.statSync(`${lease}.revision`).mtimeMs / 1000);
          settings.ProxyAutoConfigURLString = `${spec.url}?v=${revision}`;
        }, 10);
        release = () => { clearInterval(timer); worker.stopped = true; settings = original; resolve(); };
      });
      return worker;
    },
  });
  t.after(() => proxy.disable());
  return { proxy, issues, lease: () => lease, settings: () => settings, setCore: value => { core = value; } };
}

test('enable verifies proxy selection and disable releases the temporary setting', async t => {
  const { proxy, settings, lease } = setup(t);
  await proxy.enable();
  assert.equal((await proxy.status()).enabled, true);
  const response = await fetch(settings().ProxyAutoConfigURLString);
  assert.match(await response.text(), /PROXY 127\.0\.0\.1:9080; DIRECT/);
  assert.equal(fs.existsSync(lease()), true);
  await proxy.disable();
  assert.equal(fs.existsSync(lease()), false);
  assert.deepEqual(settings(), {});
  assert.equal((await proxy.status()).enabled, false);
});

test('changing routes while active publishes a new PAC and verifies it', async t => {
  const { proxy, settings } = setup(t);
  await proxy.enable();
  const first = settings().ProxyAutoConfigURLString;
  await proxy.setRoutes({ mode: 'only', domains: ['example.org'] });
  const latest = settings().ProxyAutoConfigURLString;
  assert.notEqual(latest, first);
  const response = await fetch(latest);
  const resolve = proxyResolver(await response.text());
  assert.equal(resolve('https://example.com/'), 'DIRECT');
  assert.match(resolve('https://example.org/'), /^PROXY /);
  const status = await proxy.status();
  assert.equal(status.enabled, true);
  assert.deepEqual(status.routes, { mode: 'only', domains: ['example.org'] });
});

test('a third-party proxy or enabled Intercept leaves settings alone', async t => {
  for (const [options, reason] of [[{ settings: { HTTPEnable: '1' } }, 'existing'], [{ intercept: true }, 'intercept']]) {
    const { proxy, lease, issues } = setup(t, options);
    await proxy.enable();
    assert.equal(lease(), undefined);
    assert.equal(proxy.inUse, false);
    assert.deepEqual(issues, ['systemProxy.' + reason]);
  }
});

test('cancellation or a client ignoring PAC rolls the setting back', async t => {
  for (const [options, reason] of [[{ cancel: true }, 'cancelled'], [{ result: 'DIRECT' }, 'ignored']]) {
    const { proxy, settings, lease, issues } = setup(t, options);
    await proxy.enable();
    assert.equal(fs.existsSync(lease()), false);
    assert.deepEqual(settings(), {});
    assert.equal(proxy.inUse, false);
    assert.deepEqual(issues, ['systemProxy.' + reason]);
  }
});

test('loss of the proxy releases the temporary setting automatically', async t => {
  const { proxy, settings, setCore, issues } = setup(t);
  await proxy.enable();
  assert.equal(proxy.inUse, true);
  setCore({ port: 9090, intercept: false });
  for (let i = 0; proxy.inUse && i < 50; i++) await delay(100);
  assert.equal(proxy.inUse, false);
  assert.deepEqual(settings(), {});
  assert.deepEqual(issues, ['systemProxy.core']);
});
