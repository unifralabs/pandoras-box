#!/bin/bash
set -e
yarn build
transactions=500
batch=20
subaccounts=500
concurrency=50

MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"
#0xd98f41da0f5b229729ed7bf469ea55d98d11f467
out=latest
mkdir -p ${out}

./bin/index.js -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
-c $concurrency \
--mode EOA \
-o ./${out}/EOA_${transactions}_${batch}_${subaccounts}.json
sleep 30

./bin/index.js -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
-c $concurrency \
--mode ERC20 \
-o ./${out}/ERC20_${transactions}_${batch}_${subaccounts}.json
sleep 30

./bin/index.js -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
-c $concurrency \
--mode ERC721 \
-o ./${out}/ERC721_${transactions}_${batch}_${subaccounts}.json
