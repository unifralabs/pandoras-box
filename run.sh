#!/bin/bash

yarn install
yarn build
rm -rf out/pandoras-box.log
transactions=20000
batch=1600
subaccounts=1000
concurrency=50

DEPOSIT_COUNT=2000

zmq="tcp://localhost:28332"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467

TARGET_ENV=${1:-"dogeos"} # Default to "dogeos", or take from the first script argument.
echo "[INFO] Using target environment: $TARGET_ENV"

if [ "$TARGET_ENV" == "dogeos" ]; then
    ###################################
    #dogeos config
    L1_RPC_URL="http://localhost:44555"
    L1_RPC_USER="fBJhRsMr"
    L1_RPC_PASSWORD="btmiSyJ4YRiWNgwr"
    #RPC="http://10.142.0.16:8545"
    RPC="https://rpc.testnet.dogeos.com"
    #RPC="https://dogeos-testnet-public.unifra.io"
    export L1_CONFIRMATIONS=120
    export BRIDGE_ADDRESS="2N93sHBDVig5aG6hms2Ep5z6d5NQVgghEzX"
    MOAT_CONTRACT="0xb46985D56F57d138Bfaa7ACbAE0dE38dc3CFc00f"
    WITHDRAWAL_TARGET="ngFbQoFBoeTrxM5MBoMsopunoFsBKHtQdb"
    ###################################
elif [ "$TARGET_ENV" == "unifra" ]; then
    ###################################
    #unifra config
    L1_RPC_URL="http://localhost:44555"
    L1_RPC_USER="fBJhRsMr"
    L1_RPC_PASSWORD="btmiSyJ4YRiWNgwr"
    RPC="http://localhost:8545"
    export BRIDGE_ADDRESS="2NCCRZP9qvJ8eSZ7AwNYycmmCrvyENXE2LD"
    export L1_CONFIRMATIONS=6
    MOAT_CONTRACT="0x8e09FbF68DAC16334e0D91322d6316d8FDc4f78E"
    WITHDRAWAL_TARGET="njheRpkMP86j3hgtHVEjcsqYMiV2jbK3mF"
    ###################################
fi

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
    --target-address ${WITHDRAWAL_TARGET} \
    --doge-zmq-endpoint "${zmq}" \
    --l1-rpc-url ${L1_RPC_URL} \
    --l1-rpc-user ${L1_RPC_USER} \
    --l1-rpc-pass ${L1_RPC_PASSWORD} \
    -o ./${out}/WITHDRAWAL_${transactions}_${batch}_${subaccounts}.json
}

runDeposit() {
    export L1_RPC_URL="http://${L1_RPC_USER}:${L1_RPC_PASSWORD}}@localhost:44555"
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


# clearPending

#runDeposit
#runWithDrawal

runEOA

#runERC20

#runERC721
