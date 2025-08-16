
import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';
import { parseUnits } from '@ethersproject/units';

class ClearPendingRuntime {
    private provider: JsonRpcProvider;
    private mnemonic: string;
    private numAccounts: number;
    private concurrency: number;

    constructor(
        url: string,
        mnemonic: string,
        numAccounts: number,
        concurrency: number
    ) {
        this.provider = new JsonRpcProvider(url);
        this.mnemonic = mnemonic;
        this.numAccounts = numAccounts;
        this.concurrency = concurrency || 50;
    }

    public async run() {
        Logger.info(`Scanning and clearing pending transactions for ${this.numAccounts} accounts with a concurrency of ${this.concurrency}...`);
        
        let clearedCount = 0;
        const processBar = new SingleBar({
            format: 'Processing Accounts [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | Cleared: {cleared}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: false,
        });
        processBar.start(this.numAccounts, 0, { cleared: 0 });

        const feeData = await this.provider.getFeeData();

        for (let i = 0; i < this.numAccounts; i += this.concurrency) {
            const batchPromises: Promise<void>[] = [];
            const batchEnd = Math.min(i + this.concurrency, this.numAccounts);
            
            for (let j = i; j < batchEnd; j++) {
                const processPromise = (async (accountIndex) => {
                    const wallet = Wallet.fromMnemonic(
                        this.mnemonic,
                        `m/44'/60'/0'/0/${accountIndex}`
                    ).connect(this.provider);

                    try {
                        const pendingNonce = await wallet.getTransactionCount('pending');
                        const latestNonce = await wallet.getTransactionCount('latest');

                        if (pendingNonce > latestNonce) {
                            const numToClear = pendingNonce - latestNonce;
                            Logger.debug(`\n[Account ${accountIndex}] Pending transactions detected. Nonce -> Pending: ${pendingNonce}, On-chain: ${latestNonce}. Attempting to clear ${numToClear} transaction(s) sequentially...`);
                            
                            const fixedGasPrice = parseUnits('100', 'gwei');
                            let successfullyCleared = 0;

                            for (let nonceToClear = latestNonce; nonceToClear < pendingNonce; nonceToClear++) {
                                try {
                                    let tx: any;
                                    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                                        tx = { to: wallet.address, value: 0, nonce: nonceToClear, gasLimit: 21000, maxFeePerGas: fixedGasPrice, maxPriorityFeePerGas: fixedGasPrice };
                                    } else {
                                        tx = { to: wallet.address, value: 0, nonce: nonceToClear, gasPrice: fixedGasPrice, gasLimit: 21000 };
                                    }

                                    const txResponse = await wallet.sendTransaction(tx);
                                    Logger.debug(`  -> Sent clearing transaction for nonce ${nonceToClear}. Hash: ${txResponse.hash}`);
                                    successfullyCleared++;
                                } catch (error: any) {
                                    Logger.debug(`\n  -> Failed to send clearing transaction for nonce ${nonceToClear} on account ${accountIndex}: ${error.message}`);
                                    Logger.debug(`  -> Aborting further clearing for account ${accountIndex}.`);
                                    break; 
                                }
                            }
                            
                            if (successfullyCleared > 0) {
                                clearedCount += successfullyCleared;
                                Logger.debug(`\nSuccessfully sent ${successfullyCleared} of ${numToClear} clearing transaction(s) for account ${accountIndex}.`);
                            }
                        }
                    } catch (error: any) {
                        Logger.debug(`\nFailed to process account ${accountIndex}: ${error.message}`);
                    } finally {
                        processBar.increment(1, { cleared: clearedCount });
                    }
                })(j);
                batchPromises.push(processPromise);
            }
            await Promise.all(batchPromises);
        }
        processBar.stop();

        Logger.success(`\n✅ Finished processing. Cleared a total of ${clearedCount} pending transactions.`);
    }
}

export default ClearPendingRuntime;
