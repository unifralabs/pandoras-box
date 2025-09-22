# const DOGE_RPC_USER: string = process.env.DOGE_RPC_USER ?? 'gIiXOF7h';
# const DOGE_RPC_PASSWORD: string = process.env.DOGE_RPC_PASSWORD ?? 'WxkMni1FAZc77cvZ';

curl --data-binary '{"jsonrpc": "1.0", "id":"333", "method": "listunspent", "params": [1, 999999999, ["nkQArEidsCriPkYwkE3vW1yuinPLcbsZ4Q"],true,{"maximumCount":100000}] }' \
     -H 'content-type: text/plain;' \
     http://gIiXOF7h:WxkMni1FAZc77cvZ@127.0.0.1:44555/

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

# curl --user gIiXOF7h:WxkMni1FAZc77cvZ \
#      --data-binary '[{"jsonrpc": "1.0", "id":"curltest", "method": "getrawtransaction", "params": ["43c17d848b5c1103163b29088fa9dd81ef03a8a23bec82fb4849fdabd470925f"] },{"jsonrpc": "1.0", "id":"curltest", "method": "getrawtransaction", "params": ["43c17d848b5c1103163b29088fa9dd81ef03a8a23bec82fb4849fdabd470925f"] }]' \
#      -H 'content-type: text/plain;' \
#      http://127.0.0.1:44555/
# [
#     {"result":"01000000026e13aa573315f4132c63f47eb5a1e4611bcc10745e98a2c79329982decb2fad0000000006a473044022064d91e06f784385a0b505843f746b1734823512fff26568515c3be5dff72714302206373ba0835ecbb1c20c01798545ce33a0896719c1af3524769b95105af27fa5a012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301efdffffff8ba47ba523c23387342576f0a9ee761a4ae6b32543474b1457f960e13436fdd2010000006b4830450221009bd34314c69603d340a948dfc8335b10e3a64bd8aad3b776b6cfb08ba6232f1502201f17dda93e04df8694cb2a7e2c86fe143ae4906644beb5482ff291ec0a7d1bb2012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301efdffffff02f05f16491e0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac64823bf76c0100001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac00000000","error":null,"id":"curltest"},
#     {"result":"01000000026e13aa573315f4132c63f47eb5a1e4611bcc10745e98a2c79329982decb2fad0000000006a473044022064d91e06f784385a0b505843f746b1734823512fff26568515c3be5dff72714302206373ba0835ecbb1c20c01798545ce33a0896719c1af3524769b95105af27fa5a012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301efdffffff8ba47ba523c23387342576f0a9ee761a4ae6b32543474b1457f960e13436fdd2010000006b4830450221009bd34314c69603d340a948dfc8335b10e3a64bd8aad3b776b6cfb08ba6232f1502201f17dda93e04df8694cb2a7e2c86fe143ae4906644beb5482ff291ec0a7d1bb2012102e34215e774b8be05a19c666e23fff21a1737eee9e2a716402e701a8db2f1301efdffffff02f05f16491e0000001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac64823bf76c0100001976a914b1c77e3103a1374d9d2a48618b71872eaa19e60e88ac00000000","error":null,"id":"curltest"}
# ]


# curl --user gIiXOF7h:WxkMni1FAZc77cvZ \
#      --data-binary '{"jsonrpc": "1.0", "id":"curltest", "method": "gettransaction", "params": ["0337fa6425888985c72a135f850cec1bb77dafbbd23608f9bc11620255d041b1"]}' \
#      -H 'content-type: text/plain;' \
#      http://127.0.0.1:44555/