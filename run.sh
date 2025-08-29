#!/bin/bash

yarn install
yarn build
echo ""> out/pandoras-box.log
transactions=100
batch=100
subaccounts=20
concurrency=5

RPC="https://rpc.dg.unifra.xyz"
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

MOAT_CONTRACT=0x394ace8E1a27494FDBE2833422681DA136E96153
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
    --target-address "nm2XcS85GHU44A1eSu5nAyWrP9NCK1K7RK" \
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
