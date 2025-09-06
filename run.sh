#!/bin/bash

#yarn install
#yarn build
rm -rf out/pandoras-box.log
transactions=2000
batch=300
subaccounts=200
concurrency=100

RPC="https://rpc.perf.unifra.xyz"
zmq="tcp://k8s-default-dogecoin-d42273c909-1efdf5d8964aa3b0.elb.us-west-2.amazonaws.com:28332"
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


runWithDrawal(){
    rm -rf doge_headers.db
    export LOG_LEVEL=DEBUG
    ./bin/index.js -u "$RPC" -m "$MNEMONIC" \
    --fixed-gas-price \
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --moat-address $MOAT_CONTRACT \
    --mode WITHDRAWAL \
    --target-address "nr1wfXopXGQe2TDKmGM7xkHFGYNN3Her39" \
    --doge-zmq-endpoint "${zmq}" \
    -o ./${out}/WITHDRAWAL_${transactions}_${batch}_${subaccounts}.json
}

runWithDrawal

#getPending
#clearPending
# exit 0

#runEOA
# #getPending
# exit 0

# sleep 30
# runERC20

#runERC721
