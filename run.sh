#!/bin/bash

yarn install
yarn build
rm -rf out/pandoras-box.log
transactions=5000
batch=50
subaccounts=500
concurrency=100

RPC="https://rpc.testnet.dogeos.com"
zmq="tcp://localhost:28332"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467


MOAT_CONTRACT=0xb46985D56F57d138Bfaa7ACbAE0dE38dc3CFc00f

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
    rm -rf withdrawal.db
    export LOG_LEVEL=DEBUG
    ./bin/index.js -u "$RPC" -m "$MNEMONIC" \
    --fixed-gas-price \
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --moat-address $MOAT_CONTRACT \
    --mode WITHDRAWAL \
    --target-address "ngFbQoFBoeTrxM5MBoMsopunoFsBKHtQdb" \
    --doge-zmq-endpoint "${zmq}" \
    -o ./${out}/WITHDRAWAL_${transactions}_${batch}_${subaccounts}.json
}

runDeposit() {
    export L1_RPC_URL="https://fBJhRsMr:btmiSyJ4YRiWNgwr@dogecoin.qiaoxiaorui.org"
    export ZMQ_URL="tcp://localhost:28332"
    export WIF_MASTER="ciCWUwnkp21uK3Mm12UcGT27HNXCMFa6U1kFogJjsp9W51BVRgnX"
    export WIF_AGENT='co89zv3jhdCm2sr2s3151EjUBLtd7oH82FRcUdgTmWzBLuq9HtjM'
    export TX_COUNT=10000
    export DB_URL="deposit.db"
    export NETWORK="testnet"
    export AMOUNT_PER_TX=201000000
    export DEPOSIT_TARGET_ADDRESS="0xd98f41da0f5b229729ed7bf469ea55d98d11f467"
    export L2_RPC_URL=${RPC}
    export BRIDGE_ADDRESS="2N93sHBDVig5aG6hms2Ep5z6d5NQVgghEzX"
    export L1_CONFIRMATIONS=120
    npx ts-node src/runtime/deposit.ts 3
}

#getPending

runDeposit

#clearPending
#runWithDrawal

#clearPending
#runEOA

#clearPending
#runERC20

#clearPending
#runERC721
