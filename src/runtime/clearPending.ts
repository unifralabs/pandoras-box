import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import Logger from '../logger/logger';
import GetPendingCountRuntime from './getPendingCountRuntime';

class ClearPendingRuntime {
    mnemonic: string;
    url: string;
    provider: Provider;
    accountCount: number;

    constructor(mnemonic: string, url: string, accountCount: number) {
        this.mnemonic = mnemonic;
        this.provider = new JsonRpcProvider(url);
        this.url = url;
        this.accountCount = accountCount;
    }

    public async run() {
        Logger.title(`
🧹 Clearing pending transactions for ${this.accountCount} accounts 🧹
`);

        try {
            const currentGasPrice = await this.provider.getGasPrice();
            // Using a 20x multiplier to ensure the transaction is prioritized
            const highGasPrice = currentGasPrice.mul(20); 
            Logger.info(`Current gas price: ${currentGasPrice.toString()} wei`);
            Logger.info(`Using high gas price for clearing: ${highGasPrice.toString()} wei (20x)`);

            const clearingPromises: Promise<any>[] = [];

            for (let i = 0; i < this.accountCount; i++) {
                const walletPath = `m/44'/60'/0'/0/${i}`;
                const wallet = Wallet.fromMnemonic(this.mnemonic, walletPath).connect(this.provider);
                
                // Create a self-executing async function to push to the promise array
                const clearingPromise = (async () => {
                    try {
                        const nonce = await wallet.getTransactionCount('latest');
                        Logger.info(`Preparing to clear account ${i} (${wallet.address}) with nonce ${nonce}`);

                        const tx = {
                            to: wallet.address,
                            from: wallet.address,
                            nonce: nonce,
                            value: 0,
                            gasPrice: highGasPrice,
                            gasLimit: 21000, // Standard gas limit for a simple ETH transfer
                        };
                        
                        return await wallet.sendTransaction(tx);
                    } catch (e: any) {
                        Logger.error(`Failed to prepare clearing tx for account ${i} (${wallet.address}): ${e.message}`);
                        // Return a specific error structure to identify failures
                        return { error: true, message: e.message, address: wallet.address };
                    }
                })();
                clearingPromises.push(clearingPromise);
            }

            Logger.info(`Sending ${clearingPromises.length} clearing transactions in parallel...`);
            const results = await Promise.allSettled(clearingPromises);

            results.forEach((result, index) => {
                if (result.status === 'fulfilled' && !result.value.error) {
                    Logger.success(`  -> Sent for account ${index}. Tx Hash: ${result.value.hash}`);
                } else if (result.status === 'fulfilled' && result.value.error) {
                    Logger.error(`  -> Failed for account ${index} (${result.value.address}): ${result.value.message}`);
                } else if (result.status === 'rejected') {
                    Logger.error(`  -> Unexpected failure for account ${index}: ${result.reason}`);
                }
            });
            
            Logger.info('All clearing transaction attempts are complete.');

        } catch (error: any) {
            Logger.error('A critical error occurred during the clearing process:');
            Logger.error(error.message);
        }

        // Wait for 5 seconds as requested
        Logger.info('Waiting 5 seconds before checking pending transaction count...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Get and print the pending transaction count
        const getPendingCountRuntime = new GetPendingCountRuntime(this.url);
        await getPendingCountRuntime.run();
    }
}

export default ClearPendingRuntime;