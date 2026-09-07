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

Electron smoke checks require an already running Librium core. They use separate Electron profiles under `target` and must never terminate the core used by the main application. Proxy probes write synthetic requests into the currently running history; use an isolated `LIBRIUM_DATA_DIR` for testing.

Optional media checks use generated fixtures:

```sh
python3 -m pip install Pillow numpy soundfile
python3 scripts/generate-fixtures.py
node scripts/media-save-smoke.cjs
node scripts/media-probe.cjs
node scripts/ws-probe.cjs
npm run test:electron
```

Third-party dependencies retain their own licenses. Do not add copied code, graphics or traffic samples without checking permission and attribution requirements.
