#!/bin/bash

yarn install
yarn build
rm -rf out/pandoras-box.log
transactions=10000
batch=200
subaccounts=1000
concurrency=100

DEPOSIT_COUNT=200

zmq="tcp://localhost:28332"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467

TARGET_ENV=${1:-"dogeos"} # Default to "dogeos", or take from the first script argument.
echo "[INFO] Using target environment: $TARGET_ENV"


# ###################################
# #dogeos config
# L1_RPC_URL="http://localhost:44555"
# L1_RPC_USER="fBJhRsMr"
# L1_RPC_PASSWORD="btmiSyJ4YRiWNgwr"
# RPC="https://rpc.devnet.doge.xyz"
# export L1_CONFIRMATIONS=120
# export BRIDGE_ADDRESS="2N93sHBDVig5aG6hms2Ep5z6d5NQVgghEzX"
# MOAT_CONTRACT="0xb46985D56F57d138Bfaa7ACbAE0dE38dc3CFc00f"
# WITHDRAWAL_TARGET="ngFbQoFBoeTrxM5MBoMsopunoFsBKHtQdb"
# ###################################


###################################
#unifra config
L1_RPC_URL="https://dogecoin.qiaoxiaorui.org"
L1_RPC_USER="fBJhRsMr"
L1_RPC_PASSWORD="btmiSyJ4YRiWNgwr"
RPC="https://rpc.qiaoxiaorui.org"
export BRIDGE_ADDRESS="2MwCNMnogvBTbcGPyxedtgpULVSuicUWUT1"
export L1_CONFIRMATIONS=6
MOAT_CONTRACT="0x0482EEdb28Cb155C9F8c70a86A0513dbAD0e347d"
WITHDRAWAL_TARGET="njheRpkMP86j3hgtHVEjcsqYMiV2jbK3mF"
###################################


echo "[INFO] RPC Endpoint: $RPC"

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
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --mode "EOA" \
    -o ./${out}/EOA_${transactions}_${batch}_${subaccounts}.json
    getPending
    exit 0
#        --fixed-gas-price \
}

runERC20()
{
    # --fixed-gas-price \
    ./bin/index.js -u $RPC -m "$MNEMONIC" \
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
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --moat-address $MOAT_CONTRACT \
    --mode WITHDRAWAL \
    --target-address ${WITHDRAWAL_TARGET} \
    --doge-zmq-endpoint "${zmq}" \
    --l1-rpc-url ${L1_RPC_URL} \
    --l1-rpc-user ${L1_RPC_USER} \
    --l1-rpc-pass ${L1_RPC_PASSWORD} \
    -o ./${out}/WITHDRAWAL_${transactions}_${batch}_${subaccounts}.json
}

runDeposit() {
    export L1_RPC_URL="https://${L1_RPC_USER}:${L1_RPC_PASSWORD}@dogecoin.qiaoxiaorui.org"
    export ZMQ_URL="tcp://localhost:28332"
    export WIF_MASTER="ciCWUwnkp21uK3Mm12UcGT27HNXCMFa6U1kFogJjsp9W51BVRgnX"
    export WIF_AGENT='co89zv3jhdCm2sr2s3151EjUBLtd7oH82FRcUdgTmWzBLuq9HtjM'
    export TX_COUNT=${DEPOSIT_COUNT}
    export DB_URL="deposit.db"
    export NETWORK="testnet"
    export AMOUNT_PER_TX=201000000
    export DEPOSIT_TARGET_ADDRESS="0xd98f41da0f5b229729ed7bf469ea55d98d11f467"
    export L2_RPC_URL=${RPC}
    npx ts-node src/runtime/deposit.ts
}


curl -s -X POST --data '{"jsonrpc":"2.0","method":"txpool_content","params":[],"id":1}' -H "Content-Type: application/json" https://rpc.qiaoxiaorui.org | jq '{pending: (.result.pending | length), queued: (.result.queued | length)}'
# clearPending

#runDeposit
#runWithDrawal
#runEOA
runERC20
runERC721
