import { parentPort, workerData } from 'worker_threads';
import { Wallet } from '@ethersproject/wallet';
import { TransactionRequest } from '@ethersproject/providers';

// Worker thread for CPU-intensive transaction signing
if (parentPort) {
    parentPort.on('message', async (data: any) => {
        try {
            const { transactions, accountIndexes, mnemonicSeed, hdPath } = data;
            const signedTxs: string[] = [];
            let lastReported = 0;
            
            for (let i = 0; i < transactions.length; i++) {
                const tx = transactions[i];
                const accountIndex = accountIndexes[i];
                
                // Create wallet for this account - same pattern as original
                const wallet = Wallet.fromMnemonic(mnemonicSeed, `${hdPath}/${accountIndex}`);
                
                // Convert JSON-serialized BigNumber objects back to hex strings
                const cleanTx = {
                    to: tx.to,
                    value: tx.value?._hex || tx.value,
                    data: tx.data || '0x',
                    gasLimit: tx.gasLimit?._hex || tx.gasLimit,
                    gasPrice: tx.gasPrice?._hex || tx.gasPrice,
                    nonce: tx.nonce,
                    chainId: tx.chainId,
                    from: tx.from
                };
                
                // Sign the transaction - exactly like signTransactions_old does
                const signedTx = await wallet.signTransaction(cleanTx);
                signedTxs.push(signedTx);
                
                if ((i + 1) % 256 == 0 || i === transactions.length - 1) {
                    const increment = (i + 1) - lastReported;
                    parentPort?.postMessage({
                        type: 'progress',
                        increment: increment
                    });
                    lastReported = i + 1;
                }
            }
            
            // Send results back to main thread
            parentPort?.postMessage({
                success: true,
                signedTxs: signedTxs
            });
        } catch (error: any) {
            parentPort?.postMessage({
                success: false,
                error: error.message
            });
        }
    });
}