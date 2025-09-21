#!/bin/bash
#yarn install
yarn build
rm -rf out/pandoras-box.log

if [ -f doge.db ]; then
    mv doge.db "$(date +%Y%m%d_%H%M%S)_doge.db"
fi
transactions=2400
batch=300
subaccounts=300
concurrency=200

RPC="https://rpc.perf.unifra.xyz"
zmq="tcp://k8s-default-dogecoin-d42273c909-1efdf5d8964aa3b0.elb.us-west-2.amazonaws.com:28332"
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467 This is the master address for the MNEMONIC; make sure it has enough coins to fund subaccounts

MOAT_CONTRACT=0xF13cA52F8B7B2a208742Bab311bd5D50a775a4a9
WITHDRAWAL_TARGET="njheRpkMP86j3hgtHVEjcsqYMiV2jbK3mF"

out=latest
mkdir -p ${out}

echo "master account balance:"
cast balance 0xd98f41da0f5b229729ed7bf469ea55d98d11f467 -r ${RPC}

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

runWithDrawal(){
    rm -rf doge.db
    export LOG_LEVEL=INFO
    ./bin/index.js -u "$RPC" -m "$MNEMONIC" \
    --fixed-gas-price \
    -t $transactions \
    -b $batch \
    -s $subaccounts \
    -c $concurrency \
    --moat-address $MOAT_CONTRACT \
    --mode WITHDRAWAL \
    --target-address "${WITHDRAWAL_TARGET}" \
    --doge-zmq-endpoint "${zmq}" \
    -o ./${out}/WITHDRAWAL_${transactions}_${batch}_${subaccounts}.json
}

runWithDrawal
bash ./report.sh