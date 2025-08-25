#!/bin/bash

yarn build
rm -rf out/out/pandoras-box.log
transactions=200
batch=4
subaccounts=10
concurrency=3

RPC="https://rpc.scrollsdk.unifra.xyz"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467

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

runERC20()
{
    ./bin/index.js -u $RPC -m "$MNEMONIC" \
    --fixed-gas-price \
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --mode ERC20 \
    -o ./${out}/ERC20_${transactions}_${batch}_${subaccounts}.json
    getPending
    exit 0
}

runERC721()
{
    ./bin/index.js -u $RPC -m "$MNEMONIC" \
    --fixed-gas-price \
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --mode ERC721 \
    -o ./${out}/ERC721_${transactions}_${batch}_${subaccounts}.json
    getPending
    exit 0
}

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

# getPending
# clearPending
# exit 0

# runEOA
# #getPending
# exit 0

# sleep 30
# runERC20

# runERC721
