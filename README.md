# Librium

**English** · [Русский](README.ru.md)

**See what happens between an app and the network.**

Librium is a free, open-source HTTP, HTTPS and WebSocket inspector for Windows and macOS. A Rust proxy core, a real Electron desktop app and SQLite history: requests, responses, images, audio and WebSocket messages in one workspace.

Explore APIs, debug client apps, check headers and study network behavior. The color-coded interface keeps traffic readable, and saved filter sessions bring you straight back to the task you were working on.

[![Checks](https://github.com/Daloshka/Librium/actions/workflows/checks.yml/badge.svg)](https://github.com/Daloshka/Librium/actions/workflows/checks.yml)
[![Latest release](https://img.shields.io/github/v/release/Daloshka/Librium)](https://github.com/Daloshka/Librium/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Daloshka/Librium/total)](https://github.com/Daloshka/Librium/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Rust + Electron · HTTP / HTTPS / WebSocket · SQLite · MIT**

[Why Librium](#why-librium) · [Screenshots](#screenshots) · [Install](#install) · [HTTPS setup](#https-setup) · [Documentation](#documentation)

![Librium demo](docs/images/demo.webp)

## Screenshots

Request history and workspace:

![HTTP request history](docs/images/http-history.webp)

Image preview in a response (synthetic demo traffic):

![Image preview in a response](docs/images/media-preview.webp)

## Why Librium

- **Free and open source.** MIT license, no account, no subscription, no cloud sync and no telemetry — the captured traffic stays on your machine.
- **The same tool on Windows and macOS.** One interface, one set of shortcuts, one history format.
- **HTTP/1.1 and HTTP/2** through an explicit proxy; HTTPS with a local CA. One button adds it to the trust store of your user account on macOS and Windows; the system asks for confirmation.
- **History in SQLite**, kept on disk and never trimmed by request count. Sort the whole history by ID, method, host and path, status, size or duration, page through it, or switch on “Follow” to open each new request as it arrives.
- **Request and response side by side**: headers, query and form parameters, cookies, text, a collapsible JSON tree, hex, search inside bodies and copy URL.
- **Search, quick filters and a filter builder** for HTTP and WebSocket, saved as named sessions with autosave. Noisy hosts (`*.google-analytics.com`, `telemetry.*`) can be kept out of the history altogether, from Settings (the gear in the rail) or a row's right-click menu. The search box takes conditions next to plain words: `host:api status:4xx method:post type:json size:>1mb -path:/static`.
- **Media, not just text.** PNG, SVG and other images with 1:1 zoom and drag, an audio player, and saving captured media to a file.
- **WebSocket in both directions**: text and binary frames with timing and per-connection history.
- **HAR in and out.** Export the requests matching the current filters, or the whole history, with decompressed bodies and WebSocket frames (opens in Chrome DevTools and other HAR viewers); import a HAR from a browser, a colleague or another tool into the history (or drop the file onto the window), WebSocket frames included. Credentials (Authorization, Cookie, Set-Cookie, API keys) are masked by default; the switch is in the Filters dialog. The request pane also copies any request as a curl command.
- **Summary of the current search.** “Σ Summary of the selection” in the toolbar’s ⋯ menu shows totals, error share, mocked answers, bytes, median / 95th percentile / max latency, status classes, methods and the busiest hosts; a click on a host keeps only it in the search.
- **Copy as code.** A row's menu copies the request as cURL, as a browser `fetch()` call or as Python `requests`.
- **Stars and notes.** Star an exchange from the inspector or the row menu and write a note next to it; `is:starred` and `note:` find them again.
- **New request.** “+ Request” opens the editor empty: pick a method, type the URL, headers and body (or paste a cURL command into the address field and let it fill everything), and send it through the proxy; the editor remembers the last request you composed; the exchange lands in the history like any other.
- **Recording toggle.** “● Recording” in the toolbar stops writing the history while traffic keeps flowing and the rules keep applying; nothing is held either. On again after a restart.
- **Intercept.** Hold requests to chosen hosts, methods and paths before they leave the proxy: look at them (several held ones line up as tabs), edit the method, URL, headers and body, then forward or drop. Responses too, when asked: status, headers and body (shown decoded; an edited body goes out uncompressed), and a held response can be saved as a mock. Off by default; anything held goes on unchanged after ten minutes without a decision.
- **Mocks.** “Mock this response” in a row's menu turns a recorded exchange into a canned answer: the proxy serves it for matching host, path and method (a path pattern with `?` also matches the query) without asking the origin, and records the exchange as usual (with an `x-librium-mock` header and a “mock” tag in the list). Edit, switch off or delete mocks in Settings.
- **Header rewrites.** Set or remove request headers for matching hosts (optionally narrowed to a path pattern, `api.example.com/v1/*`) before they leave the proxy, and response headers before the client sees them (drop a CSP, allow CORS, disable caching): inject a token, drop caching headers, spoof a User-Agent. The history shows what was actually sent.
- **Slow network.** Add a delay to the responses of matching hosts (optionally a path pattern; up to a minute), mocks included, to watch an app on a bad connection; the recorded duration includes it.
- **Rules as a file.** Settings can export the ignored hosts, header rewrites, delays and mocks as one JSON file and import such a file back (it replaces the lists it contains; dropping the file onto the window works too), so a team shares the same mocks.
- **Active rules pill.** While mocks, delays or header rewrites are on, the header shows an amber pill with their counts; click it to open Settings, so a forgotten rule never answers in silence.
- **Resend a request, as is or edited.** One button sends a captured request again through the proxy; another opens it for editing first: method, address, headers and body. The replay lands in the history next to the original.
- **Phone capture over your home Wi-Fi**, opt-in: LAN access is off by default and the core listens on loopback only.
- **Works behind a VPN.** One button opens a separate Chrome profile that goes through Librium even when a tunnel swallows the system proxy.
- **Interface in English and Russian**, switched in the app with one click.

## Librium and the alternatives

| | Free | Open source | Windows | macOS | Phone over Wi-Fi | WebSocket | Unlimited on-disk history | No account / cloud |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Librium** | Yes | Yes (MIT) | Yes | Yes | Yes | Yes | Yes (SQLite) | Yes |
| Charles | No (~$50 one-time) | No | Yes | Yes | Yes | Yes | — | Yes |
| Proxyman | Partly (freemium) | No | Yes | Yes | Yes | Yes | — | — |
| Fiddler Everywhere | No (subscription) | No | Yes | Yes | Yes | Yes | — | No (sign-in) |
| mitmproxy | Yes | Yes | Yes | Yes | Yes | Yes | — | Yes |
| HTTP Toolkit | Partly (free tier) | Yes (core) | Yes | Yes | Yes | Yes | — | — |

“—” means “depends on the plan or on how you run it”, not “missing”. A few notes so the table is not read as more than it is:

- **Charles** is a mature paid tool with a one-time license and a time-limited trial.
- **Proxyman** is a polished macOS-first app with Windows and Linux builds; several features are behind the paid tier.
- **Fiddler Everywhere** is a paid subscription and asks you to sign in to a Telerik account.
- **mitmproxy** is free and open source, but it is a CLI plus a web UI rather than a desktop application.
- **HTTP Toolkit** is open source with paid Pro features.
- Most of these keep the captured session in memory and write it out on demand; Librium streams it into SQLite as it goes, so the history survives a restart without an export step.

Features change. If a cell is out of date, [open an issue](https://github.com/Daloshka/Librium/issues) and it will be fixed.

## Install

### Prebuilt app

Open the [Releases](https://github.com/Daloshka/Librium/releases) page of this repository.

**Windows.** Download `Librium.<version>.exe` and run it. The portable build needs neither Node.js nor Rust. If you use an unpacked build instead, keep the whole `win-unpacked` folder together.

**macOS.** Download `Librium-<version>-arm64.dmg` (Apple Silicon; on Intel build from source, which produces `Librium-<version>-x64.dmg`), open the image and drag Librium into Applications. The same app is also published as a `.zip`. The build is ad-hoc signed, without an Apple Developer ID, so the first launch is refused. Remove the quarantine attribute:

```sh
xattr -dr com.apple.quarantine /Applications/Librium.app
```

Without a terminal: after the refusal open System Settings → Privacy & Security and press “Open Anyway” (macOS 15 and newer); on older versions right-click the app → “Open”.

### Homebrew (macOS)

Apple Silicon, macOS 13 or newer (the cask enforces both).

```sh
brew install --cask daloshka/tap/librium
xattr -dr com.apple.quarantine /Applications/Librium.app
```

Homebrew keeps the quarantine attribute on downloaded apps, so the second command is needed once after every install or upgrade until the builds are notarized.

### Scoop (Windows)

```powershell
scoop bucket add daloshka https://github.com/Daloshka/scoop-bucket
scoop install librium
```

### From source

Download the sources with **Code → Download ZIP** and unpack them, or clone the repository. Open PowerShell or a terminal in the folder that contains `package.json` and `Cargo.toml`.

**Windows.** You need current stable Rust, Node.js 24 or newer, and Visual Studio Build Tools with the C++ tools and the Windows SDK. Some native dependencies may also need CMake.

```powershell
npm ci
npm run build:core
npm start
```

**macOS.** You need the Xcode Command Line Tools, Rust via [rustup](https://rustup.rs) and Node.js 24 or newer (`brew install node` or nvm).

```sh
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
npm ci
npm run build:core
npm start
```

`npm run build:core` is a plain Node script and behaves the same in PowerShell and in a terminal.

To package the app for the current system:

```sh
npm run dist
```

The result lands in `dist/v<version>`: `Librium <version>.exe` on Windows, `Librium-<version>-arm64.dmg` (`-x64.dmg` on Intel) and `.zip` on macOS.

Rust core only: `./run.sh` (macOS and Linux), `./run.ps1` (Windows) or `cargo run --locked`. The core serves its UI and API on `127.0.0.1:3000` and the proxy on `127.0.0.1:8080`; both ports are configurable.

## Quick start

1. Start Librium and wait for the proxy to connect.
2. Point your browser or app at the HTTP proxy `127.0.0.1:8080`. For HTTPS, trust the local certificate as described below.
3. Open a page or send a request — it shows up in the history.
4. Select a row: the request is on the left, the response on the right. Switch between headers, body, pretty and hex; media can be previewed, played and downloaded.
5. Use search and the filters by traffic type, method and status. Save a set as its own filter session to come back to it after a restart.

New requests appear at the top by default. Click a column header to change the sorting.

The interface speaks English and Russian: the **EN / RU** button at the bottom of the left rail switches the language and reloads the window. Librium picks your system language on the first run.

### Search syntax

Plain words match the ID, method, address, status and content type. Conditions narrow the list further; all of them apply at once, together with the quick filters and the filter builder. A right click on a row offers the same conditions for that row's host, path, method and status, plus copying its URL, resending it, comparing it line by line with the previously selected request, and deleting it from the history. “Delete matching” next to the condition chips removes everything the current conditions match, after a confirmation.

| Condition | Meaning |
| --- | --- |
| `host:api` · `path:/v1/` · `url:token` | contains |
| `host:=api.example.com` | exact value |
| `-host:cdn` · `-path:/static` | does not contain |
| `method:post` · `-method:get` | method equals / differs |
| `status:404` · `status:4xx` · `status:>=400` · `status:<500` · `status:!=200` | status code or class |
| `size:>1mb` · `size:<=20kb` · `id:>1000` | size and ID with units and comparisons |
| `type:json` · `type:image` | content type contains |
| `body:token` · `-body:error` | the request or response body text contains (the first 16 KiB of each, decoded from gzip, deflate and brotli; requests captured before this version have no body text) |
| `header:set-cookie` · `header:"cache-control: no-store"` | a request or response header line contains (`name: value`, lowercase, the first 8 KiB of the lines) |
| `frame:ping` · `-frame:error` | WebSocket connections with a frame whose text contains (the first 64 KiB of each frame) |
| `is:error` · `-is:error` · `is:pending` | failed or interrupted exchanges; exchanges without a response yet |
| `is:starred` · `note:todo` | starred exchanges; the note contains (plain words search notes too) |
| `is:mock` | exchanges answered by a mock instead of the origin |
| `since:10m` · `since:2h` · `since:14:30` · `since:2026-09-08` · `until:2026-09-08 18:00` | request time: the last minutes, hours or days, a time today, or a local date and time |
| `elapsed:>1s` · `elapsed:<200` | time to the first response byte (milliseconds, or seconds with `s`) |
| `"two words"` | words kept together |

Suggestions appear under the box as you type: the fields first, then values seen in the history (hosts, paths, methods, statuses, content types) and examples of the syntax. ↑ ↓ choose, Tab or Enter accepts, Esc closes the list. An empty box also lists the last eight searches you ran (Enter, or leaving the box, remembers one).

### Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl K` (`⌘ K` on macOS) | Focus the history search |
| `Ctrl F` (`⌘ F`) | Focus the search inside the request and response |
| `Ctrl I` (`⌘ I`) | Toggle intercept |
| `Ctrl N` (`⌘ N`) | New request |
| `Ctrl Shift M` (`⌘ ⇧ M`) | Mock the selected response |
| `Ctrl ]` / `Ctrl [` (`⌘ ]` / `⌘ [`) | In the intercept panel: next / previous held request |
| `?` | Keys and search syntax cheat sheet (also the `?` button in the rail) |
| `Ctrl D` (`⌘ D`) | Star or unstar the selected request |
| `Esc` | Clear the focused search box |
| `↑` `↓` `Enter` | Move along the history and open a request |
| `Ctrl Enter` (`⌘ Enter`) | Send from the “Edit and resend” dialog |

## HTTPS setup

On the first run Librium creates a CA in its data directory:

| OS | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Librium` |
| macOS | `~/Library/Application Support/Librium` |
| Linux | `~/.local/share/librium` |

Set the HTTP/HTTPS proxy to `127.0.0.1:8080` in the client you want to inspect and add `ca.crt` to that client's trusted certificates. The certificate and a short guide are available inside the app.

A check that does not touch the system certificate store — in PowerShell:

```powershell
curl.exe --ssl-revoke-best-effort --proxy http://127.0.0.1:8080 --cacert "$env:LOCALAPPDATA\Librium\ca.crt" https://example.com
```

In a macOS terminal:

```sh
curl --proxy http://127.0.0.1:8080 --cacert "$HOME/Library/Application Support/Librium/ca.crt" https://example.com
```

On macOS the CA is trusted through Keychain Access: open `ca.crt`, find **Librium Local CA** and set Trust to “Always Trust”. The same from a terminal:

```sh
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "$HOME/Library/Application Support/Librium/ca.crt"
```

The macOS system proxy is set per network service: System Settings → Network → the service → Details… → Proxies → “Web proxy (HTTP)” and “Secure web proxy (HTTPS)” with `127.0.0.1` and `8080`. The same from a terminal (replace `Wi-Fi` with your service name from `networksetup -listallnetworkservices`):

```sh
networksetup -setwebproxy Wi-Fi 127.0.0.1 8080
networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 8080
```

Turn it off when you are done:

```sh
networksetup -setwebproxystate Wi-Fi off
networksetup -setsecurewebproxystate Wi-Fi off
```

Librium never enables the system proxy and never installs the CA for you. Switch the proxy off in the client or in the system after a session, and never share the private key `ca.key`.

### Using a VPN

Network Extension based VPN clients on macOS (Xray, sing-box, Amnezia, WireGuard and friends) and many Windows tunnels ignore the system proxy: while the tunnel is up, `scutil --proxy` is empty and requests bypass Librium even if a proxy is set for Wi-Fi or for the VPN service itself. Librium keeps working — its own outgoing connections go through the tunnel like any other app's.

The fix is to give the proxy to the browser instead of to the system. The **“Open Chrome through the proxy”** button in the “HTTPS setup” dialog launches a separate Chrome, Chromium, Edge or Brave profile with a `--proxy-server` flag that does not depend on system settings or on the VPN. The profile lives in Electron's data directory and does not touch your main browser. The same by hand:

```sh
open -na "Google Chrome" --args --proxy-server=127.0.0.1:8080 --user-data-dir="$HOME/Library/Application Support/librium-desktop/chrome-profile"
```

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --proxy-server=127.0.0.1:8080 --user-data-dir="$env:APPDATA\librium-desktop\chrome-profile"
```

Firefox is configured in its own network settings: “Manual proxy configuration”, HTTP and HTTPS `127.0.0.1:8080`. HTTPS still needs Librium's CA to be trusted.

In-depth walkthroughs: [proxy setup on Windows](docs/proxy-setup.md) and [proxy setup on macOS](docs/proxy-setup-macos.md).

## Phone capture

Connect the phone and the computer to the same home network. In the app press **“Connect phone”**, pick the local network interface and follow the steps. LAN access is opt-in; by default the core is reachable on loopback only.

In the phone's Wi-Fi settings enter the computer address shown by Librium and the proxy port `8080`. For HTTPS, install the local CA on the phone and enable full trust for it if the system asks. On Windows, allow incoming connections for Librium in the firewall for private networks. On macOS, if the firewall is on, allow incoming connections for Librium (System Settings → Network → Firewall → Options…); the system usually offers this the first time LAN access is enabled.

Switch the proxy off on the phone when you are done. Some apps ignore the system proxy or refuse user-installed certificates, so their traffic may stay invisible.

## Ports and directories

| Variable | Default | What it sets |
| --- | --- | --- |
| `LIBRIUM_UI_PORT` | `3000` | Port of the core's UI and API on `127.0.0.1`. |
| `LIBRIUM_PROXY_PORT` | `8080` | Port of the HTTP/HTTPS proxy on `127.0.0.1`. |
| `LIBRIUM_DATA_DIR` | system data directory | Where the CA (`ca.crt`, `ca.key`) and the history `history.sqlite3` are stored. |

The certificate page for the phone runs one port above the proxy (`8081` by default), so the proxy port may be anything from `1` to `65534`.

macOS and Linux:

```sh
LIBRIUM_PROXY_PORT=8088 npm start
```

Windows, PowerShell:

```powershell
$env:LIBRIUM_PROXY_PORT=8088; npm start
```

The app passes these values to the core, so setting them once at startup is enough. The current proxy address is shown in the app header.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The history is empty | That the client really uses the proxy `127.0.0.1:8080`, and that active filters are not hiding requests. Starting Librium does not redirect the system's traffic on its own. |
| HTTPS certificate error | That the client trusts the CA created by this copy of Librium. Some clients need the certificate file to be passed explicitly. |
| `ECONNREFUSED 127.0.0.1:3000` | The Rust core is not running or has exited. When running from source, run `npm run build:core` and restart the app; check that port `3000` is free or set another one with `LIBRIUM_UI_PORT`. |
| Port `8080` is taken by another app | Start with `LIBRIUM_PROXY_PORT=<port>` and use the same port in the client. The proxy address is shown in the app header. |
| macOS: “Librium is damaged” or “cannot be opened” | The build is not signed with an Apple Developer ID. Remove the quarantine: `xattr -dr com.apple.quarantine /Applications/Librium.app`, or press “Open Anyway” in System Settings → Privacy & Security after the refusal. |
| The phone does not connect | Both devices on the same network, LAN access enabled, the computer address entered correctly, and the firewall allowing the connection. |
| A `301` or `302` instead of an image | That is a redirect. Open the captured request for the address from `Location`: the image is in the final response. |
| The header says “History is not being saved” | The core cannot write `history.sqlite3`: the disk is full, the file is read-only, or another program holds the database open in a write transaction. Traffic keeps flowing through the proxy meanwhile and is written once the problem is gone; the banner shows the SQLite error. |

## Storage and limits

The history lives in the data directory next to the CA and the SQLite WAL/SHM files:

| OS | History file |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Librium\history.sqlite3` |
| macOS | `~/Library/Application Support/Librium/history.sqlite3` |
| Linux | `~/.local/share/librium/history.sqlite3` |

- The directory can be changed with `LIBRIUM_DATA_DIR`.
- Filter sessions and logs live in Electron's data directory (`%APPDATA%\librium-desktop` on Windows, `~/Library/Application Support/librium-desktop` on macOS).
- For ordinary HTTP bodies and for each WebSocket message the first 64 KiB are stored. For images and audio, up to 32 MiB. The client always receives the full data. Bodies compressed with gzip, deflate, brotli or zstd are shown, saved and exported decoded; the Hex tab keeps the bytes as transmitted. The decoded text of the first 16 KiB of each body is also kept next to each exchange for `body:` searches.
- The history is written every half second and on shutdown; the footer shows how much it takes on disk. Closing the app asks the core to finish writing before it exits; after a crash or a power loss the last moments may be missing.
- HTTP/3 and QUIC, transparent interception of all system traffic and bypassing certificate pinning are not implemented. The client has to use the proxy and to trust the CA.

Only use Librium on traffic you are allowed to inspect. The history can contain passwords, cookies and personal data: keep it out of repositories and public reports. More in [SECURITY.md](SECURITY.md).

## Checks

The commands are the same in PowerShell and in a macOS terminal; on Windows use `python` instead of `python3`.

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
npm run test:ui
python3 scripts/export-source.py --check
```

Additional Electron and synthetic-media checks are described in [CONTRIBUTING.md](CONTRIBUTING.md).

### Preparing sources for publication

```sh
python3 scripts/export-source.py --check
python3 scripts/export-source.py
```

The export creates a fresh `.publish/Librium` folder with allowlisted sources and the two prepared documentation screenshots only. It never copies `.git`, local databases, certificates, traffic, logs, builds or arbitrary screenshots. The destination has to be new or empty. If your working Git history contains personal data, publish a fresh history from a clean export rather than the original repository.

## Documentation

- [Architecture](docs/architecture.md) — design notes; the features of the current version are listed above.
- [Networking](docs/network.md), [protocols](docs/basics/protocols.md).
- [TLS](docs/basics/tls-versions.md), [certificates](docs/basics/certificates.md), [certificate authorities](docs/basics/certificate-authorities.md).
- [Proxy setup on Windows](docs/proxy-setup.md), [proxy setup on macOS](docs/proxy-setup-macos.md), [practice examples](docs/practice.md).
- [Release process](docs/release.md) — versions, tags, optional signing and notarization, Homebrew tap and Scoop bucket updates.

The long-form documents in `docs/` are currently written in Russian; the README, `CONTRIBUTING.md` and `SECURITY.md` are the English entry points. Translations are welcome.

## License

Librium is distributed under the [MIT License](LICENSE). You may use, modify and redistribute the project, including in commercial products, as long as the copyright notice and the license text are preserved.

Third-party dependencies and the third-party images shown in demonstration materials keep their own licenses and rights. The MIT text: [Open Source Initiative](https://opensource.org/license/mit).

## Contributing

Found a bug or have an idea — open an issue or send a pull request. For bugs, include the Librium version, the steps to reproduce and the expected result. Attach only anonymized examples, without cookies, tokens or personal traffic.

Development and check instructions are in [CONTRIBUTING.md](CONTRIBUTING.md); guidance on handling sensitive data is in [SECURITY.md](SECURITY.md).
