#!/bin/bash
set -e
yarn build
# Set the number of transactions, batch size, and number of subaccounts
transactions=10000
batch=5
subaccounts=500
MNEMONIC="clog mask tuition survey build canvas guide gentle okay ordinary better bonus"

pandoras-box -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
--mode EOA \
-o ./EOA_${transactions}_${batch}_${subaccounts}.json


pandoras-box -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
--mode ERC20 \
-o ./ERC20_${transactions}_${batch}_${subaccounts}.json
# # sleep 60

pandoras-box -url https://rpc.shude.unifra.xyz -m "$MNEMONIC" \
-t $transactions \
-b $batch \
-s $subaccounts \
--mode ERC721 \
-o ./ERC721_${transactions}_${batch}_${subaccounts}.json
