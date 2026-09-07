## What changed

Describe the change and the reason for it. Link the issue it closes (`Closes #123`).

## How it was checked

Which of the checks below you ran, and on which OS. Use `python3` on macOS and Linux, `python` on Windows.

```sh
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
npm ci
npm run test:ui
python3 scripts/export-source.py --check
```

Electron and media checks are optional and need a running core; see [CONTRIBUTING.md](https://github.com/Daloshka/Librium/blob/main/CONTRIBUTING.md).

## Checklist

- [ ] No real traffic, cookies, tokens, account identifiers, private IP addresses or local user names in code, fixtures, screenshots or the description.
- [ ] Checks above pass locally, or the failure is explained here.
- [ ] User-visible strings are added to both language dictionaries in `ui/i18n.js`.
- [ ] Docs updated when behaviour, ports, paths or defaults changed.
- [ ] Third-party code or assets come with a compatible license and attribution.

## Screenshots

For UI changes, before and after. Redact any captured traffic that is visible.
