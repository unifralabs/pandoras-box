#!/bin/bash

# --- Configuration ---
RPC_URL="https://rpc.shude.unifra.xyz"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
NUM_ACCOUNTS=5000
CONCURRENCY=100
AUTO_CONFIRM="--yes" # Set to "--yes" to auto-confirm, or "" to prompt manually

# --- Script ---
set -e # Exit immediately if a command exits with a non-zero status.

echo "Building TypeScript files..."
yarn build

echo "Running clear pending script..."
./bin/index.js \
    --json-rpc "$RPC_URL" \
    --mnemonic "$MNEMONIC" \
    --mode "CLEAR_PENDING" \
    --num-accounts "$NUM_ACCOUNTS" \
    --concurrency "$CONCURRENCY" \
    $AUTO_CONFIRM

echo "Script finished."
 
./bin/index.js --mode GET_PENDING_COUNT -u $RPC_URL