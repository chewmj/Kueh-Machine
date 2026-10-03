#!/bin/bash
cd "$(dirname "$0")"
PORT=8080

# A server left running from another copy of the project would otherwise be
# reused, and the browser would show that copy instead of this one.
OLD=$(lsof -t -i tcp:$PORT -sTCP:LISTEN 2>/dev/null)
if [ -n "$OLD" ] && ps -o command= -p $OLD | grep -q -i python; then
  kill $OLD
  sleep 0.5
fi

python3 tools/serve.py "$PORT" >/tmp/kueh-machine-server.log 2>&1 &
sleep 0.5

open "http://localhost:$PORT"
