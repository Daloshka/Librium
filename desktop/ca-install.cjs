'use strict';

const { execFile } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { t } = require('./i18n.cjs');

// Pass the public certificate itself. The authorized process creates its own temporary
// file so the certificate cannot be swapped on disk while macOS waits for approval.
const macInstall = `set -eu
file=$(/usr/bin/mktemp /private/tmp/librium-ca.XXXXXX)
trap '/bin/rm -f "$file"' EXIT
/usr/bin/printf '%s\\n' "$1" > "$file"
/usr/bin/security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain "$file"`;

function command(platform, { file, certificate }) {
  if (platform === 'darwin') {
    let ca;
    try {
      ca = new X509Certificate(certificate);
      if (!ca.ca || !ca.checkIssued(ca) || !ca.verify(ca.publicKey)) throw Error();
    } catch {
      throw Error(t('ca.invalid'));
    }
    return { command: '/usr/bin/osascript', args: [
      '-e', 'on run argv',
      '-e', 'do shell script ("/bin/sh -c " & quoted form of (item 1 of argv) & " librium-ca " & quoted form of (item 2 of argv)) with prompt (item 3 of argv) with administrator privileges',
      '-e', 'end run', macInstall, ca.toString(), t('ca.systemPrompt'),
    ] };
  }
  if (platform === 'win32') return { command: 'certutil', args: ['-user', '-addstore', 'Root', file] };
  return null;
}
async function install({ platform = process.platform, file, certificate, run = execFile }) {
  const spec = command(platform, { file, certificate });
  if (!spec) throw Error(t('ca.unsupported'));
  return new Promise((resolve, reject) => {
    run(spec.command, spec.args, { timeout: 120000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.code || error.signal || t('ca.installError')).trim().slice(0, 400);
        reject(Error(t('ca.failed', { detail })));
      } else {
        resolve();
      }
    });
  });
}
module.exports = { command, install };
