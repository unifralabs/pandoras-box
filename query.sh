
#!/bin/bash
address=0xd98f41da0f5b229729ed7bf469ea55d98d11f467
curl -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_getTransactionCount","params":["'$address'", "latest"],"id":1}' https://rpc.shude.unifra.xyz
curl -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_getTransactionCount","params":["'$address'", "pending"],"id":1}' https://rpc.shude.unifra.xyz