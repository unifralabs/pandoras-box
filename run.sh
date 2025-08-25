#!/bin/bash

yarn build
rm -rf out/out/pandoras-box.log
transactions=10
batch=1
subaccounts=1
concurrency=1

RPC="https://rpc.dg.unifra.xyz"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467

out=latest
mkdir -p ${out}

rm -rf out/pandoras-box.log

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

MOAT_CONTRACT=0x3eD6eD3c572537d668F860d4d556B8E8BF23E1E2
runWithDrawal(){
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
