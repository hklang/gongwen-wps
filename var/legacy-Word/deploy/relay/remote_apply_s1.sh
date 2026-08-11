#!/bin/bash
set -e
cd /home/ubuntu/gongwen-relay
mkdir -p data
chmod +x start.sh
if [ -f .env ]; then
  grep -q '^CONTROL_ENABLED=' .env || echo 'CONTROL_ENABLED=1' >> .env
  grep -q '^CONTROL_REQUIRE_USER=' .env || echo 'CONTROL_REQUIRE_USER=0' >> .env
  if ! grep -q '^CONTROL_SECRET=' .env; then
    echo "CONTROL_SECRET=$(python3 -c 'import secrets;print(secrets.token_hex(24))')" >> .env
  fi
fi
./start.sh
sleep 1
PORT=3000
if [ -f .env ]; then
  P=$(grep '^RELAY_PORT=' .env | head -1 | cut -d= -f2 | tr -d '\r')
  [ -n "$P" ] && PORT="$P"
fi
curl -sS "http://127.0.0.1:${PORT}/api/health" || true
echo
