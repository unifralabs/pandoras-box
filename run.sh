#!/bin/bash

#yarn install
#yarn build
rm -rf out/pandoras-box.log
transactions=200
batch=100
subaccounts=100
concurrency=250

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
    rm -rf doge.db
    export LOG_LEVEL=DEBUG
    ./bin/index.js -u "$RPC" -m "$MNEMONIC" \
    --fixed-gas-price \
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --moat-address $MOAT_CONTRACT \
    --mode WITHDRAWAL \
    --target-address "njheRpkMP86j3hgtHVEjcsqYMiV2jbK3mF" \
    --doge-zmq-endpoint "${zmq}" \
    -o ./${out}/WITHDRAWAL_${transactions}_${batch}_${subaccounts}.json
}

runDeposit() {
    export L1_RPC_URL="https://fBJhRsMr:btmiSyJ4YRiWNgwr@dogecoin.qiaoxiaorui.org"
    export ZMQ_URL="tcp://localhost:28332"
    export WIF_MASTER="ciCWUwnkp21uK3Mm12UcGT27HNXCMFa6U1kFogJjsp9W51BVRgnX"
    export WIF_AGENT='co89zv3jhdCm2sr2s3151EjUBLtd7oH82FRcUdgTmWzBLuq9HtjM'
    export TX_COUNT=100
    export DB_URL="deposit.db"
    export NETWORK="testnet"
    export AMOUNT_PER_TX=201000000
    export DEPOSIT_TARGET_ADDRESS="0xd98f41da0f5b229729ed7bf469ea55d98d11f467"
    export L2_RPC_URL="https://rpc.qiaoxiaorui.org"
    export BRIDGE_ADDRESS="2NAFYySxPpvocpcUKbk6PBxZASRVLhGEVXg"
    export L1_CONFIRMATIONS=6
    npx ts-node src/runtime/deposit.ts 3
}

runDeposit
exit 0

#runWithDrawal
#getPending
#clearPending
# exit 0

#runEOA
# getPending
# exit 0

# sleep 30
#runERC20

#runERC721
