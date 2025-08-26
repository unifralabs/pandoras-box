#!/bin/bash

yarn build
rm -rf out/out/pandoras-box.log
transactions=200
batch=4
subaccounts=10
concurrency=3

RPC="https://rpc.scrollsdk.unifra.xyz"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#fund this account please 
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467

out=latest
mkdir -p ${out}

MOAT_CONTRACT=0x4AE538b8F99b163fE996b4c8B6Ef7D63ECC04b6C
runWithDrawal(){
    rm -rf doge_headers.db
    export LOG_LEVEL=DEBUG
    ./bin/index.js -u $RPC -m "$MNEMONIC" \
    --fixed-gas-price \
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --moat-address $MOAT_CONTRACT \
    --mode WITHDRAWAL \
    --target-address "nmNf4f5kyvCFrfyUBoQU3TKN3Dyc5kcMoH" \
    --doge-zmq-endpoint "tcp://10.8.0.25:30495" \
    -o ./${out}/WITHDRAWAL_${transactions}_${batch}_${subaccounts}.json
}

runWithDrawal
