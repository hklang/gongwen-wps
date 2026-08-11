#!/bin/bash
# 在 LXD mybox 内：/home/ubuntu/gongwen-relay/start.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$DIR/.env"
  set +a
fi

export RELAY_PORT="${RELAY_PORT:-3000}"
# 去掉 Windows 编辑 .env 时可能带入的 CR，避免 curl URL 非法
RELAY_PORT="${RELAY_PORT//$'\r'/}"
RELAY_TOKEN="${RELAY_TOKEN//$'\r'/}"
CONTROL_ENABLED="${CONTROL_ENABLED:-1}"
CONTROL_REQUIRE_USER="${CONTROL_REQUIRE_USER:-0}"
CONTROL_SECRET="${CONTROL_SECRET:-}"
CONTROL_DB="${CONTROL_DB:-}"
CONTROL_ENABLED="${CONTROL_ENABLED//$'\r'/}"
CONTROL_REQUIRE_USER="${CONTROL_REQUIRE_USER//$'\r'/}"
CONTROL_SECRET="${CONTROL_SECRET//$'\r'/}"
CONTROL_DB="${CONTROL_DB//$'\r'/}"
export RELAY_PORT
export RELAY_TOKEN="${RELAY_TOKEN:?请在 .env 设置 RELAY_TOKEN}"
export CONTROL_ENABLED
export CONTROL_REQUIRE_USER
# 未单独设 CONTROL_SECRET 时回落到 RELAY_TOKEN（控制面代码已支持）
if [ -n "$CONTROL_SECRET" ]; then
  export CONTROL_SECRET
fi
if [ -n "$CONTROL_DB" ]; then
  export CONTROL_DB
fi
export PYTHONUNBUFFERED=1
mkdir -p "$DIR/data"

python3 - <<'PY'
from pathlib import Path
import os
DIR = Path(".")
vals = {}
env_path = DIR / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        vals[k.strip()] = v.strip().strip('"').strip("'")
for k in ("MINIMAX_API_KEY", "DEEPSEEK_API_KEY", "AI_PROVIDER", "RELAY_TOKEN", "RELAY_PORT"):
    if os.environ.get(k):
        vals[k] = os.environ[k].strip()
text = f'''# auto-generated from .env
AI_PROVIDER = {vals.get("AI_PROVIDER", "deepseek")!r}
AI_USE_RELAY = False

MINIMAX_API_KEY = {vals.get("MINIMAX_API_KEY", "")!r}
MINIMAX_BASE_URL = "https://api.minimaxi.com/v1"
MINIMAX_MODEL = "MiniMax-M3"
MINIMAX_TIMEOUT = 90

DEEPSEEK_API_KEY = {vals.get("DEEPSEEK_API_KEY", "")!r}
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-v4-flash"
DEEPSEEK_TIMEOUT = 90
'''
(DIR / "settings.py").write_text(text, encoding="utf-8")
print("settings_written")
PY

mkdir -p "$DIR/logs"
pkill -f "$DIR/relay_server.py" 2>/dev/null || true
sleep 1
nohup python3 "$DIR/relay_server.py" >>"$DIR/logs/relay.log" 2>&1 &
echo $! >"$DIR/relay.pid"
sleep 1
curl -sS "http://127.0.0.1:${RELAY_PORT}/api/health" || true
echo
echo "started pid=$(cat "$DIR/relay.pid") port=$RELAY_PORT"
