#!/bin/sh
# Restart the local server: kill whatever listens on our ports (Windows PIDs via netstat), start fresh.
cd "$(dirname "$0")"
for port in 8899 8900 8901; do
  for p in $(netstat -ano | grep ":$port .*LISTENING" | awk '{print $5}' | sort -u); do taskkill //F //PID $p >/dev/null 2>&1; done
done
node main.js > logs/main.out 2>&1 &
sleep 1.5
