#!/usr/bin/env bash
set -e

echo "=== WindsurfAPI Setup ==="

# Create directories
echo "[1/4] Creating directories..."
mkdir -p /opt/windsurf/data/db
mkdir -p /tmp/windsurf-workspace

# Check LS binary
LS_PATH="/opt/windsurf/language_server_linux_x64"
if [ -f "$LS_PATH" ]; then
  chmod +x "$LS_PATH"
  echo "[2/4] Language Server found at $LS_PATH"
else
  echo "[2/4] WARNING: Language Server not found at $LS_PATH"
  echo "       Download it and place it there before starting the server"
  echo "       chmod +x $LS_PATH"
fi

# Generate .env if not exists
if [ ! -f .env ]; then
  echo "[3/4] Generating .env..."
  cat > .env << 'ENVEOF'
PORT=3003
API_KEY=
DEFAULT_MODEL=claude-4.5-haiku
MAX_TOKENS=8192
LOG_LEVEL=info
LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64
LS_PORT=42100
DASHBOARD_PASSWORD=
RPM_LIMIT_TRIAL=4
MAX_INFLIGHT_TRIAL=1
MAX_TRIAL_ANTHROPIC_CREDIT=1
RPM_LIMIT_PRO=20
MAX_INFLIGHT_PRO=2
MAX_UPSTREAM_ATTEMPTS=2
PROBE_CANARIES=
ENABLE_EXPENSIVE_PROBE=false
ENABLE_CASCADE_PREWARM=false
MAX_CONTEXT_CHARS=180000
MAX_TOOL_RESULT_CHARS=64000
MAX_CONTEXT_MESSAGES=200
ENVEOF
  echo "       Edit .env to set your API_KEY and DASHBOARD_PASSWORD"
else
  echo "[3/4] .env already exists, skipping"
fi

# Check Node.js version
NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VER" ]; then
  echo "[4/4] WARNING: Node.js not found. Install Node.js >= 20"
elif [ "$NODE_VER" -lt 20 ]; then
  echo "[4/4] WARNING: Node.js v$NODE_VER detected, need >= 20"
else
  echo "[4/4] Node.js v$(node -v) OK"
fi

echo ""
echo "=== Done ==="
echo "Start:     node src/index.js"
echo "Dev:       node --watch src/index.js"
echo "Dashboard: http://localhost:3003/dashboard"
