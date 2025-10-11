#!/usr/bin/env bash
# Simple wrapper to run the cross-chain listeners only.
# Build TS -> JS if bin version not present or TS newer.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$ROOT_DIR/bin/tools/crossChainListeners.js" ]; then
  echo "[build] crossChainListeners.js not found, compiling TypeScript..."
  yarn tsc >/dev/null 2>&1 || npx tsc
fi

# Default values (can be overridden by env or CLI flags)
L1_TARGET_HASH="${L1_TARGET_HASH:-ef64172e434033c48104dd80f6bfb6f6d8bd5a99}"
ZMQ_ENDPOINT="${ZMQ_ENDPOINT:-tcp://localhost:28332}"
L2_RPC="${L2_RPC:-https://rpc.perf.unifra.xyz}"
MOAT_ADDRESS="${MOAT_ADDRESS:-0x8e7E0351b3F3342Df7Ba43Eb3d857fCEE675F90C}"
DB_PATH="${DB_PATH:-doge.db}"

# Allow overriding via positional args for quick usage
# Usage: ./run-listeners.sh <l1TargetHash> <zmqEndpoint> <l2Rpc> <moatAddress> <dbPath>
if [ $# -ge 1 ]; then L1_TARGET_HASH="$1"; fi
if [ $# -ge 2 ]; then ZMQ_ENDPOINT="$2"; fi
if [ $# -ge 3 ]; then L2_RPC="$3"; fi
if [ $# -ge 4 ]; then MOAT_ADDRESS="$4"; fi
if [ $# -ge 5 ]; then DB_PATH="$5"; fi

echo "[run] L1_TARGET_HASH=$L1_TARGET_HASH"
echo "[run] ZMQ_ENDPOINT=$ZMQ_ENDPOINT"
echo "[run] L2_RPC=$L2_RPC"
echo "[run] MOAT_ADDRESS=$MOAT_ADDRESS"
echo "[run] DB_PATH=$DB_PATH"

exec node "$ROOT_DIR/bin/tools/crossChainListeners.js" \
  --l1-target-hash "$L1_TARGET_HASH" \
  --zmq-endpoint "$ZMQ_ENDPOINT" \
  --l2-rpc "$L2_RPC" \
  --moat-address "$MOAT_ADDRESS" \
  --db-path "$DB_PATH"
