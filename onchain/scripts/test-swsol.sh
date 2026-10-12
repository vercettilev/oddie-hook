#!/usr/bin/env bash
# The swSOL tests against Sanctum's real program, on a local validator.
#
# Clones the mainnet swSOL program, its mint and its pool into a fresh local
# validator, loads this program from target/deploy, and runs tests/swsol.ts.
# Mainnet is only READ (to clone three accounts); nothing is sent there.
#
#   cd onchain && anchor build && ./scripts/test-swsol.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=${SWSOL_CLONE_RPC:-https://api.mainnet-beta.solana.com}
WALLET=${ANCHOR_WALLET:-$HOME/.config/solana/id.json}
LEDGER=$(mktemp -d)
solana-test-validator --reset --quiet --ledger "$LEDGER" --url "$RPC" \
  --mint "$(solana-keygen pubkey "$WALLET")" \
  --clone-upgradeable-program so1f7APRw5pJ5iNJrM9g5X9tQgXzk8kMUnXxDNdt99b \
  --clone swso1x7A8Dy36znxtcstSVLNseeCQzNV3wVAfa5GGLu \
  --clone CugxVX9C5N1gmGTB4DGLjTcod1jTJtJFXgnkm9ExjyDP \
  --bpf-program 3SYG7hzQBYGc853BGTxcBtTLefESaP9DqP5aHbvgnYsu target/deploy/oddie_chain.so &
VPID=$!
trap 'kill $VPID 2>/dev/null || true; rm -rf "$LEDGER"' EXIT
for _ in $(seq 1 120); do solana -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 && break; sleep 0.5; done
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET="$WALLET" NODE_OPTIONS=--no-experimental-strip-types \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/swsol.ts
