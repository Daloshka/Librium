#!/bin/sh
set -e
cd "$(dirname "$0")"
CARGO=$(command -v cargo || true)
[ -n "$CARGO" ] || CARGO="$HOME/.cargo/bin/cargo"
if [ ! -x "$CARGO" ]; then
    echo 'Rust is required: install it from https://rustup.rs, then run this script again.' >&2
    exit 1
fi
exec "$CARGO" run --locked
