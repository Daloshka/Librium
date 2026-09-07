# Security and private data

Librium is a local HTTP/HTTPS debugging proxy. Captured traffic can contain passwords, cookies, authorization headers and personal data.

Do not attach raw traffic, HAR/PCAP files, databases, session settings or unredacted screenshots to public issues. Replace hostnames, identifiers and credentials with synthetic examples. Never share the private CA key. Generate a separate CA for each installation.

Runtime data is stored outside the source tree by default. The data directory holds the CA certificate/key and the SQLite history, including WAL/SHM files:

- Windows: `%LOCALAPPDATA%\Librium`.
- macOS: `~/Library/Application Support/Librium`.
- Linux: `~/.local/share/librium`.
- Any directory set through `LIBRIUM_DATA_DIR`, which overrides the defaults above.

Electron's user-data directory holds filter sessions and diagnostic logs.

The API listens on loopback and requires a session token. LAN access is opt-in and restricted to the selected local subnet. Only use the proxy on traffic you are authorized to inspect.

For a security report, use GitHub's private vulnerability reporting if the repository owner has enabled it. Otherwise open a minimal issue requesting a private contact channel; do not include exploit credentials or personal captures.

Before publication run `python3 scripts/export-source.py --check` (`python` on Windows) and review the source export. The scanner is a safeguard, not a guarantee that every possible secret is detectable. Build release binaries from a clean checkout; do not publish build logs, PDB/debug symbols, test profiles or runtime data.
