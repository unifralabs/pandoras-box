#!/bin/bash
set -e
yarn build
# Set the number of transactions, batch size, and number of subaccounts
# 使用更保守的参数避免 nonce 冲突和 underpriced 错误
transactions=100000
batch=100
subaccounts=500
concurrency=100
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"

./bin/index.js -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
-c $concurrency \
--mode EOA \
-o ./out/EOA_${transactions}_${batch}_${subaccounts}.json
exit 0
sleep 30

./bin/index.js -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
-c $concurrency \
--mode ERC20 \
-o ./out/ERC20_${transactions}_${batch}_${subaccounts}.json
sleep 30

./bin/index.js -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
-c $concurrency \
--mode ERC721 \
-o ./out/ERC721_${transactions}_${batch}_${subaccounts}.json
