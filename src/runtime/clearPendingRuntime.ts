
import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';

class ClearPendingRuntime {
    private provider: JsonRpcProvider;
    private mnemonic: string;
    private numAccounts: number;
    private concurrency: number;
    private startIndex: number;
    private endIndex: number;

    constructor(
        url: string,
        mnemonic: string,
        numAccounts: number,
        concurrency: number,
        startIndex: number = 0,
        endIndex?: number
    ) {
        this.provider = new JsonRpcProvider(url);
        this.mnemonic = mnemonic;
        this.numAccounts = numAccounts;
        this.concurrency = concurrency || 50;
        this.startIndex = startIndex;
        this.endIndex = endIndex !== undefined ? endIndex : numAccounts;
    }

    public async run() {
        const totalAccountsToScan = this.endIndex - this.startIndex;
        Logger.info(`Scanning and clearing pending transactions for accounts from index ${this.startIndex} to ${this.endIndex} with a concurrency of ${this.concurrency}...`);
        
        let totalClearedCount = 0;
        const processBar = new SingleBar({
            format: 'Processing Accounts [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | Sent Clearing Txs: {cleared}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: false,
        });
        processBar.start(totalAccountsToScan, 0, { cleared: 0 });

        for (let i = this.startIndex; i < this.endIndex; i += this.concurrency) {
            // Move feeData fetching to the batch level to ensure consistency within the batch and reduce RPC calls.
            const feeData = await this.provider.getFeeData();

            const batchEnd = Math.min(i + this.concurrency, this.endIndex);
            // 2. 让 Promise 返回清理的数量，而不是直接修改外部变量
            const batchPromises: Promise<number>[] = [];
            
            for (let j = i; j < batchEnd; j++) { // This inner loop is correct
                const processPromise = (async (accountIndex): Promise<number> => {
                    const wallet = Wallet.fromMnemonic(
                        this.mnemonic,
                        `m/44'/60'/0'/0/${accountIndex}`
                    ).connect(this.provider);

                    let successfullyClearedInAccount = 0;
                    try {
                        const pendingNonce = await wallet.getTransactionCount('pending');
                        const latestNonce = await wallet.getTransactionCount('latest');

                        if (pendingNonce > latestNonce) {
                            const numToClear = pendingNonce - latestNonce;
                            Logger.debug(`\n[Account ${accountIndex}] Pending txs detected. Nonce -> Pending: ${pendingNonce}, On-chain: ${latestNonce}. Attempting to clear ${numToClear} tx(s).`);

                            for (let nonceToClear = latestNonce; nonceToClear < pendingNonce; nonceToClear++) {
                                try {
                                    let tx: any;

                                    // 适配 EIP-1559 和 legacy 交易
                                    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                                        // Use a more aggressive gas strategy to ensure replacement
                                        // 1. Double the priority fee to strongly incentivize miners.
                                        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(200).div(100);

                                        // 2. Calculate base fee from the node's suggestion.
                                        const baseFee = feeData.maxFeePerGas.sub(feeData.maxPriorityFeePerGas);
                                        
                                        // 3. Set maxFeePerGas to be comfortably above the current base fee + our new priority fee.
                                        const maxFeePerGas = baseFee.add(maxPriorityFeePerGas).mul(150).div(100); // Add 50% buffer
                                        Logger.debug(`  -> Clearing with EIP-1559: maxFeePerGas=${maxFeePerGas.toString()}, maxPriorityFeePerGas=${maxPriorityFeePerGas.toString()}`);

                                        // 2. 健壮性检查：确保 priority fee 不会超过 max fee
                                        if (maxPriorityFeePerGas.gt(maxFeePerGas)) {
                                            Logger.warn(`\n  -> Adjusted maxPriorityFeePerGas (${maxPriorityFeePerGas.toString()}) was higher than maxFeePerGas (${maxFeePerGas.toString()}). Using maxFeePerGas as priority fee.`);
                                            tx = { 
                                                to: wallet.address, value: 0, nonce: nonceToClear, gasLimit: 21000, 
                                                maxFeePerGas: maxFeePerGas, 
                                                maxPriorityFeePerGas: maxFeePerGas // Fallback to prevent error
                                            };
                                        } else {
                                        tx = { 
                                            to: wallet.address, value: 0, nonce: nonceToClear, gasLimit: 21000, 
                                            maxFeePerGas: maxFeePerGas, 
                                            maxPriorityFeePerGas: maxPriorityFeePerGas
                                        };
                                        }
                                    } else {
                                        // For legacy networks, double the current gas price.
                                        const gasPrice = (feeData.gasPrice || await this.provider.getGasPrice()).mul(200).div(100);
                                        Logger.debug(`  -> Clearing with Legacy Gas: gasPrice=${gasPrice.toString()}`);
                                        tx = { to: wallet.address, value: 0, nonce: nonceToClear, gasPrice: gasPrice, gasLimit: 21000 };
                                    }

                                    const txResponse = await wallet.sendTransaction(tx);
                                    Logger.debug(`  -> Sent clearing transaction for nonce ${nonceToClear}. Hash: ${txResponse.hash}`);
                                    successfullyClearedInAccount++;
                                } catch (error: any) {
                                    // 3. 更清晰的错误日志
                                    Logger.warn(`\n  -> Failed to send clearing tx for nonce ${nonceToClear} on account ${accountIndex}: ${error.message}`);
                                    Logger.warn(`  -> Aborting further clearing for this account.`);
                                    break; 
                                }
                            }
                            
                            if (successfullyClearedInAccount > 0) {
                                Logger.debug(`\nSuccessfully sent ${successfullyClearedInAccount} of ${numToClear} clearing tx(s) for account ${accountIndex}.`);
                            }
                        }
                    } catch (error: any) {
                        Logger.debug(`\nFailed to process account ${accountIndex}: ${error.message}`);
                    } finally {
                        // 更新进度条，但计数值在 Promise.all 后更新
                        processBar.increment(1, { cleared: totalClearedCount });
                    }
                    return successfullyClearedInAccount;
                })(j);
                batchPromises.push(processPromise);
            }
            // 2. (续) 在批次结束后，安全地汇总结果
            const clearedInBatch = await Promise.all(batchPromises);
            const batchSum = clearedInBatch.reduce((sum, count) => sum + count, 0);
            totalClearedCount += batchSum;

            // 4. 在批次间增加短暂延时，保护 RPC 节点
            if (i + this.concurrency < this.endIndex) {
                await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
            }
        }
        processBar.stop();

        Logger.success(`\n✅ Finished processing. Sent a total of ${totalClearedCount} clearing transactions.`);
    }
}

export default ClearPendingRuntime;
