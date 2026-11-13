#!/usr/bin/env sh
# kons sunucusunu başlatır. Panel: http://127.0.0.1:4700
cd "$(dirname "$0")" || exit 1
exec node --disable-warning=ExperimentalWarning server.js
