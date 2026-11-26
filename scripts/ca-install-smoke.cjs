'use strict';

const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const { command, install } = require('../desktop/ca-install.cjs');

// Public self-signed CA for command construction tests. The private key was discarded.
const certificate = `-----BEGIN CERTIFICATE-----
MIICQjCCAeigAwIBAgIJALB17UxSYilxMAoGCCqGSM49BAMCMBoxGDAWBgNVBAMM
D0xpYnJpdW0gVGVzdCBDQTAeFw0yNjExMjYxMDE3MzJaFw0zNjExMjMxMDE3MzJa
MBoxGDAWBgNVBAMMD0xpYnJpdW0gVGVzdCBDQTCCAUswggEDBgcqhkjOPQIBMIH3
AgEBMCwGByqGSM49AQECIQD/////AAAAAQAAAAAAAAAAAAAAAP//////////////
/zBbBCD/////AAAAAQAAAAAAAAAAAAAAAP///////////////AQgWsY12Ko6k+ez
671VdpiGvGUdBrDMU7D2O848PifSYEsDFQDEnTYIhucEk2pmeOETnSa3gZ9+kARB
BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+e
FivOM1drMV7Oy7ZAaDe/UfUCIQD/////AAAAAP//////////vOb6racXnoTzucrC
/GMlUQIBAQNCAAQGEn+ZXgFkfHg6tR+HFmVxZeNjVdUVgvWbnGR+e6Ye918amIhx
iAiXivafPE3o8t6Vh9YvYm5NXMzf/sP2w2HyoyMwITAPBgNVHRMBAf8EBTADAQH/
MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNIADBFAiEAuyiTU+bJ0VEGfVbB
wyINqOaO7J9S2arfv8b89Fm3YcwCIFFRaGdo1gMeYnFute4/9x1+VE3qBzH0a7ts
dqh8bD8X
-----END CERTIFICATE-----`;

(async () => {
  const mac = command('darwin', { certificate, file: '/tmp/ignored.crt' });
  assert.equal(mac.command, '/usr/bin/osascript');
  assert.match(mac.args[3], /with administrator privileges/);
  assert.match(mac.args[6], /-d -r trustRoot -p ssl -k \/Library\/Keychains\/System\.keychain/);
  assert.equal(mac.args[7], new X509Certificate(certificate).toString());
  assert.ok(mac.args.every(argument => !argument.includes('/tmp/ignored.crt')));

  const windows = { file: 'C:\\data\\librium-ca.crt' };
  assert.deepEqual(command('win32', windows), { command: 'certutil', args: ['-user', '-addstore', 'Root', windows.file] });

  const calls = [];
  const run = (cmd, args, _options, callback) => { calls.push([cmd, args]); callback(null, 'ok', ''); };
  await install({ platform: 'darwin', certificate, run });
  assert.deepEqual(calls, [[mac.command, mac.args]]);
  await assert.rejects(install({ platform: 'darwin', certificate: 'not a certificate', run }), /root CA|корневой CA/);
  assert.equal(calls.length, 1);
  const fail = (_cmd, _args, _options, callback) => callback(Error('boom'), '', 'CertUtil: -addstore command FAILED');
  await assert.rejects(install({ platform: 'win32', ...windows, run: fail }), /CertUtil: -addstore command FAILED/);
  assert.equal(command('linux', {}), null);
  await assert.rejects(install({ platform: 'linux', run }), /no standard trust store|нет стандартного хранилища/);
  console.log('CA install smoke OK: macOS system TLS trust, Windows user trust, invalid CA and failed commands');
})().catch(error => { console.error(error); process.exitCode = 1; });
