#!/bin/bash

#yarn install
yarn build
echo ""> out/pandoras-box.log
transactions=3000
batch=300
subaccounts=2
concurrency=100

RPC="https://rpc.perf.unifra.xyz"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467

MOAT_CONTRACT=0x8e7E0351b3F3342Df7Ba43Eb3d857fCEE675F90C

out=latest
mkdir -p ${out}

getPending(){
    ./bin/index.js --mode GET_PENDING_COUNT -u $RPC
}

clearPending(){
    getPending
    sleep 2

./bin/index.js \
    --json-rpc "$RPC" \
    --mnemonic "$MNEMONIC" \
    --mode "CLEAR_PENDING" \
    --num-accounts "$subaccounts" \
    --concurrency "$concurrency"
} 

runEOA()
{
    ./bin/index.js -u $RPC -m "$MNEMONIC" \
    --fixed-gas-price \
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --mode "EOA" \
    -o ./${out}/EOA_${transactions}_${batch}_${subaccounts}.json
    getPending
    exit 0
}

#runWithDrawal

# getPending
# clearPending
# exit 0

runEOA
# #getPending
# exit 0

# sleep 30
# runERC20

# runERC721