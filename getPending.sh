#!/bin/bash

# --- Configuration ---
RPC_URL="https://rpc.shude.unifra.xyz"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
NUM_ACCOUNTS=5000
CONCURRENCY=100

# --- Script ---
set -e # Exit immediately if a command exits with a non-zero status.

echo "Building TypeScript files..."
yarn build
./bin/index.js --mode GET_PENDING_COUNT -u $RPC_URL

