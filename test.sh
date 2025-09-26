# const DOGE_RPC_USER: string = process.env.DOGE_RPC_USER ?? 'gIiXOF7h';
# const DOGE_RPC_PASSWORD: string = process.env.DOGE_RPC_PASSWORD ?? 'WxkMni1FAZc77cvZ';

# The address derived from the WIF in deposit.ts is n2eA8F2h5f6VnhefXyzaqvrEVLzWDPtMv5
ADDRESS_TO_CHECK="nkQArEidsCriPkYwkE3vW1yuinPLcbsZ4Q"
URL="https://gIiXOF7h:WxkMni1FAZc77cvZ@dogecoin.perf.unifra.xyz"

# curl --data-binary '{"jsonrpc": "1.0", "id":13, "method": "listunspent", "params": [1, 1000000000, ["nkQArEidsCriPkYwkE3vW1yuinPLcbsZ4Q"], false, {}] }' \
#      -H 'content-type: text/plain;' \
#      $URL

curl --data-binary '{"jsonrpc": "1.0", "id":13, "method": "sendrawtransaction", "params": ["020000000e7d75b3bdf310202c67d10948c2fc88d114b53ea8e812e70eed60f68855e5b7c5040000006a4730440220665af46012332bf41a21a7dbd5f07dffb4d88c19c567bcbb509952e0b32ddd580220382028493676fd5372711ceae59ca42fd3bfd29b1c277ac191417be2d6e46eeb012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffff7d75b3bdf310202c67d10948c2fc88d114b53ea8e812e70eed60f68855e5b7c5030000006b483045022100ceacc4bcbc8b0ed75cdb196791a161049b8262d06adfd98bf4681e5b36595695022019975e366c60c047a3c485a735fa583005883295db4bc02199ca852d4f439023012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffff7d75b3bdf310202c67d10948c2fc88d114b53ea8e812e70eed60f68855e5b7c5020000006a47304402203873599c39e724b02452e45710014f0ea13696bfbac4acf82f7af5912b86733102202d0f9d0dff01b209a749179ba152b7687d0501b68f814af43ebe2ea899ef517e012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffffcf718b602b72186215da5fc871ca0e55eaf5f5d4159ef8358d87c339cae41aa9030000006a47304402206773f8ec8a134f2304bdcb4ec978921e50658b1dcfdaf34b937768124f38c0340220104bdb44710d210ffd5aa753906cff786d21b0240eca2f299fe44f78ce596b14012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffffcf718b602b72186215da5fc871ca0e55eaf5f5d4159ef8358d87c339cae41aa9020000006a47304402202df0ac31b1433c0faf91a5d6c9878d70b22fb041be31ffbc288cfa83037a48600220045eec3565546219560a67ce0ac34c7bcf111b486b7b5c71076a389d76cff507012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffff621084b4b45119fc1c72e1c3b03496c097fce2cfc2fe8d8950d28347136fcd3e030000006b483045022100e97e01828a6cd418bc1ae400e4c388cd68fa501e50815e417cbab4bd205b06350220725ca4eef4ca89311a77c68e86d9989873c7126447e25edca9e207b2745f3554012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffffd5c20aba0ccf4aac4b7ee35356c6b08fd35e5f8c276c16a10c02d0b70f47dcef090000006b48304502210080e6529f443562d2e4ca9523e0546c1526ee645812e9bd7ee0c42bf26aafc72e02206bd6dedb7926bf1d8130aab146e51e5326cf0125d2692b6d698c42bb8279e68e012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffffb3e59fecb9704e94c62af175ff051d26d0ea4b7dd2559e7111d8fdb45c3e6c1d090000006a47304402203c4835ef0a10519fcce28cd93e2c376b59e4692ecceebc6c045ba757aae1c1bd022055f7a3443dce3d32c2f659646eab41ee80523255bc82d950823528e8fb6327fe012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffff3992ef8446d3222e2c1b10e9837274de222908c2294f6154da53ae9437153980090000006a47304402205e4c7732a29d93703ad0b294f30d48df45bf9d933bb3cf1e2899b52ae41ab9ca022013d39b68c82cc5b8085fe90b7d81030b55eb09193bd03b6f80d31f4b0b9e4cdc012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffff0da4a80a185d4c7cdd9475bd54306eed95f21063e3fde169878e09d8ba1ce9be090000006a473044022043ed1875faf763cd8f7218ffe4bb0d2990c00a2ce751816c73c3f484e66e89c8022059886c758035bee8ab559f70104e71783a5ec364edaa4075ee9465511bed5eed012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffffc9b44020e3a20ae5913838b293133c8462b48561bb436eae665ffbcbae98e5db090000006a47304402202beaacebebcf417c650f5b07de4c8bef9197f6eb78d56ab5fcfd2199f95ee2db022015aaf6777632935d46aa976fc1ac8a771faac29308370dc9c70af7356a97d54f012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffff8f8c3094b5ec60624200e12d8141281894b6cd849ea3afc129f63655c106ff50090000006b4830450221008a0d52f5d2017704753cf74d64b3ccfc956572261a47c031e8112977621303d602202409633cf6c4d7976de92f0ec53c20a1f7bfaa6673cab396af2d646a82551d92012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffff665777b076adb2ea582d80761392a26a5af9d326c871812203b97c2c9b26b3af090000006a47304402207ddc89fbefa66339dd17ae57b3b77dea6094e495fee6846bff906e26a78432d8022044bb1f9c788f81ce1e8ab650c95cfbea9975cce355b45d938dabb6b8c65418a2012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffffe28a00b07819323314c0921b9a3bd290fe757c02f402437b2d5ebcdc725bee56090000006b483045022100c5720bc22e65509b660cbc17d524474f3ed2629cabdea4cbe34b1a8dd5b21143022048ff87cc5535160957fbec51f8bbe7624416ce22c1e6fc3267820fb140a5c1b3012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301effffffff0d000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac000011ec2f0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac0038ac71220000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac0073fbd8210000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac00000000"] }' \
     -H 'content-type: text/plain;' \
     $URL

# curl --data-binary '{"jsonrpc": "1.0", "id":13, "method": "getblockcount", "params": [] }' \
#      -H 'content-type: text/plain;' \
#      https://dogecoin.perf.unifra.xyz

# curl --data-binary '{
#     "jsonrpc": "1.0", 
#     "id":6,
#     "method":"importmulti", 
#     "params":[
#         [
#           {
#             "scriptPubKey":{"address": "nkQArEidsCriPkYwkE3vW1yuinPLcbsZ4Q"},
#             "timestamp":"now",
#             "watchonly": true, 
#             "label": "My Testnet Watch Address"
#           }
#         ],
#         {"rescan": false}
#     ]
# }' \
# -H 'content-type: text/plain;' \
# $URL

# curl --data-binary '{"jsonrpc": "1.0", "id":123, "method": "getwalletinfo", "params": [] }' \
#      -H 'content-type: text/plain;' \
#      $URL

# curl --data-binary '{"jsonrpc": "1.0", "id":123, "method": "listaccounts", "params": [0, true] }' \
#      -H 'content-type: text/plain;' \
#      $URL


# curl --data-binary '{"jsonrpc": "1.0", "id":"333", "method": "listtransactions", "params": ["", 10000, 0,false] }' \
#      -H 'content-type: text/plain;' \
#      $URL

# echo -e "\n--- Testing getrawmempool (verbose=false) ---"
# curl --data-binary '{"jsonrpc": "1.0", "id":"mempool-test-1", "method": "getrawmempool", "params": [] }' \
#      -H 'content-type: text/plain;' \
#      $URL

# echo -e "\n\n--- Testing getrawmempool (verbose=true) ---"
# curl --data-binary '{"jsonrpc": "1.0", "id":"mempool-test-2", "method": "getrawmempool", "params": [true] }' \
#      -H 'content-type: text/plain;' \
#      $URL


# {
#     "result": [
#         {
#             "txid": "43c17d848b5c1103163b29088fa9dd81ef03a8a23bec82fb4849fdabd470925f",
#             "vout": 1,
#             "address": "nkQArEidsCriPkYwkE3vW1yuinPLcbsZ4Q",
#             "account": "Donation Watch",
#             "scriptPubKey": "76a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac",
#             "amount": 15675.15968100,
#             "confirmations": 273258,
#             "spendable": false,
#             "solvable": false
#         }
#     ],
#     "error": null,
#     "id": "curltest"
# }

# curl --data-binary '[{"jsonrpc": "1.0", "id":"curltest", "method": "getrawtransaction", "params": ["43c17d848b5c1103163b29088fa9dd81ef03a8a23bec82fb4849fdabd470925f"] },{"jsonrpc": "1.0", "id":"curltest", "method": "getrawtransaction", "params": ["43c17d848b5c1103163b29088fa9dd81ef03a8a23bec82fb4849fdabd470925f"] }]' \
#      -H 'content-type: text/plain;' \
#     $URL
# [
#     {"result":"01000000026e13aa573315f4132c63f47eb5a1e4611bcc10745e98a2c79329982decb2fad0000000006a473044022064d91e06f784385a0b505843f746b1734823512fff26568515c3be5dff72714302206373ba0835ecbb1c20c01798545ce33a0896719c1af3524769b95105af27fa5a012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301efdffffff8ba47ba523c23387342576f0a9ee761a4ae6b32543474b1457f960e13436fdd2010000006b4830450221009bd34314c69603d340a948dfc8335b10e3a64bd8aad3b776b6cfb08ba6232f1502201f17dda93e04df8694cb2a7e2c86fe143ae4906644beb5482ff291ec0a7d1bb2012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301efdffffff02f05f16491e0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac64823bf76c0100001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac00000000","error":null,"id":"curltest"},
#     {"result":"01000000026e13aa573315f4132c63f47eb5a1e4611bcc10745e98a2c79329982decb2fad0000000006a473044022064d91e06f784385a0b505843f746b1734823512fff26568515c3be5dff72714302206373ba0835ecbb1c20c01798545ce33a0896719c1af3524769b95105af27fa5a012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301efdffffff8ba47ba523c23387342576f0a9ee761a4ae6b32543474b1457f960e13436fdd2010000006b4830450221009bd34314c69603d340a948dfc8335b10e3a64bd8aad3b776b6cfb08ba6232f1502201f17dda93e04df8694cb2a7e2c86fe143ae4906644beb5482ff291ec0a7d1bb2012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301efdffffff02f05f16491e0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac64823bf76c0100001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac00000000","error":null,"id":"curltest"}
# ]


# curl -v  --data-binary '{"jsonrpc": "1.0", "id":"curltest", "method": "gettransaction", "params": ["7cc3a0e099625803f9ea024d1441af22666c88cc6de70169436465b5d9b7cf94"]}' \
#      -H 'content-type: text/plain;' \
#     $URL




# curl  --data-binary '{"jsonrpc": "1.0", "id":"curltest", "method": "getblockhash", "params": [13100656]}' \
#      -H 'content-type: text/plain;' \
#      https://gIiXOF7h:WxkMni1FAZc77cvZ@dogecoin.perf.unifra.xyz

# curl --data-binary '{"jsonrpc": "1.0", "id":"curltest", "method": "getblock", "params": ["eb3a30038a62efcc309ef214e882e11ee240bcc868efca7e23170acfb23d76ef",1]}' \
#      -H 'content-type: text/plain;' \
#      https://gIiXOF7h:WxkMni1FAZc77cvZ@dogecoin.perf.unifra.xyz
