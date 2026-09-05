#!/usr/bin/env bash
#
# The whole app, locally, with everything switched on, against devnet.
#
#   ./scripts/dev-app.sh            -> http://localhost:4311  (X gate on)
#   APP_X_GATE=false ./scripts/dev-app.sh   (gate off)
#
# Reads the admin key from the file the CLI already keeps, so no secret is ever
# pasted into a shell line. Mints REAL devnet markets when you create one
# (POST /api/v1/markets), which costs devnet SOL from that wallet.
#
# HTML shells are read once at boot: after editing anything under public/,
# stop this (Ctrl+C) and run it again, or you will be looking at the old page.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="$HOME/.config/solana/oddie-admin.json"
if [ ! -f "$KEY" ]; then
  echo "admin keypair not found at $KEY" >&2
  exit 1
fi

export APP_OPEN=true
export ONCHAIN_ENABLED=true
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"
export SOLANA_CLUSTER="${SOLANA_CLUSTER:-devnet}"
export SOLANA_ADMIN_SECRET_KEY="$(cat "$KEY")"
export GENESIS_DEV_SEED=1
export PORT="${PORT:-4311}"
export APP_X_GATE="${APP_X_GATE:-true}"

echo "oddie app on http://localhost:$PORT  (devnet, X gate ${APP_X_GATE})"
echo "seed an X account for this browser: POST /api/genesis/_seed {\"handle\":\"you\",\"uid\":\"dev1\",\"deviceId\":\"<the oddie_did cookie>\"}"
exec npx tsx src/server.ts
