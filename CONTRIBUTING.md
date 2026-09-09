# Contributing

Use synthetic endpoints such as `example.com` or a local test server. Never add real account identifiers, captured cookies, private IP addresses from your environment, local usernames or credentials to fixtures.

Run the checks below. They are the same in PowerShell and in a macOS terminal; use `python3` on macOS and Linux, `python` on Windows. `npm run build:core` is a Node script and works on every platform, so no PowerShell is required to build the core.

```sh
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
npm ci
npm run test:ui
python3 scripts/export-source.py --check
```

`npm run test:ui` runs the renderer smoke tests under jsdom (desktop bridge and plain browser mode), the HAR export check and the CA install command check; they need only Node and never touch the system trust store.

Electron smoke checks require an already running Librium core. They use separate Electron profiles under `target` and must never terminate the core used by the main application. Proxy probes write synthetic requests into the currently running history; use an isolated `LIBRIUM_DATA_DIR` for testing.

Optional media checks use generated fixtures:

```sh
python3 -m pip install Pillow numpy soundfile
python3 scripts/generate-fixtures.py
node scripts/media-save-smoke.cjs
node scripts/media-probe.cjs
node scripts/ws-probe.cjs
npm run test:electron
node scripts/ws-load.cjs
node scripts/stream-check.cjs
npx electron scripts/replay-smoke.cjs
npx electron scripts/anchor-smoke.cjs
npx electron scripts/preferences-smoke.cjs
LIBRIUM_DATA_DIR=target/quit-smoke-data LIBRIUM_UI_PORT=3003 LIBRIUM_PROXY_PORT=8090 npx electron scripts/quit-smoke.cjs
```

`ws-load.cjs`, `replay-smoke.cjs` (resend, edit-and-resend, compose from scratch), `anchor-smoke.cjs` and `preferences-smoke.cjs` need the running core like the other Electron checks: they attach to `LIBRIUM_UI_PORT`/`LIBRIUM_PROXY_PORT` (3000/8080 by default), so set both when your core listens elsewhere, otherwise the attach-only scripts wait until their timeout (a syntax error in such a script also leaves Electron idle without output, so run `node --check scripts/<name>.cjs` first); the Electron checks run with `LIBRIUM_HEADLESS=1`, so no window appears on screen; `quit-smoke.cjs` starts its own core on the given ports and verifies that quitting stops it and leaves the history checkpointed.

Third-party dependencies retain their own licenses. Do not add copied code, graphics or traffic samples without checking permission and attribution requirements.
