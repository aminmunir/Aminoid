#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server 5173
elif command -v python >/dev/null 2>&1; then
  python -m http.server 5173
else
  echo "Python 3 is required to serve this static dashboard locally." >&2
  exit 1
fi
