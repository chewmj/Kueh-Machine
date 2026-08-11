#!/bin/bash
cd "$(dirname "$0")"
PORT=8080

if ! lsof -i tcp:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  python3 -m http.server "$PORT" >/tmp/kueh-machine-server.log 2>&1 &
  sleep 0.5
fi

open "http://localhost:$PORT"
