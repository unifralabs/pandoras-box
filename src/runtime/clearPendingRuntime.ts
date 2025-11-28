
import { JsonRpcProvider } from '@ethersproject/providers';
import type { BigNumber } from '@ethersproject/bignumber';
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

        const PRIORITY_MULTIPLIER_PERCENT = 200;
        const BASE_FEE_BUFFER_PERCENT = 150;
        const LEGACY_GAS_MULTIPLIER_PERCENT = 200;
        const RETRY_BUMP_STEP_PERCENT = 25;
        const MAX_RETRIES_PER_NONCE = 3;

        type FeeConfig =
            | {
                eip1559: true;
                maxFeePerGas: BigNumber;
                maxPriorityFeePerGas: BigNumber;
            }
            | {
                eip1559: false;
                gasPrice: BigNumber;
            };

        const fetchBufferedFees = async (bumpPercent: number = 100): Promise<FeeConfig> => {
            const feeData = await this.provider.getFeeData();

            if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                const recommendedPriority = feeData.maxPriorityFeePerGas
                    .mul(PRIORITY_MULTIPLIER_PERCENT)
                    .div(100);
                const bumpedPriority = recommendedPriority.mul(bumpPercent).div(100);

                const inferredBaseFee = feeData.maxFeePerGas.sub(feeData.maxPriorityFeePerGas);
                const bufferedBase = inferredBaseFee.gt(0)
                    ? inferredBaseFee.mul(BASE_FEE_BUFFER_PERCENT).div(100)
                    : feeData.maxFeePerGas;

                const bumpedBase = bufferedBase.mul(bumpPercent).div(100);
                let maxFeePerGas = bumpedBase.add(bumpedPriority);

                if (bumpedPriority.gt(maxFeePerGas)) {
                    maxFeePerGas = bumpedPriority;
                }

                return {
                    eip1559: true,
                    maxFeePerGas,
                    maxPriorityFeePerGas: bumpedPriority,
                };
            }

            const baseGasPrice = feeData.gasPrice || (await this.provider.getGasPrice());
            const gasPrice = baseGasPrice
                .mul(LEGACY_GAS_MULTIPLIER_PERCENT)
                .div(100)
                .mul(bumpPercent)
                .div(100);

            return {
                eip1559: false,
                gasPrice,
            };
        };

        const buildTxWithFees = (baseTx: any, fees: FeeConfig) => {
            if (fees.eip1559) {
                return {
                    ...baseTx,
                    type: 2,
                    maxFeePerGas: fees.maxFeePerGas,
                    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                };
            }

            return {
                ...baseTx,
                gasPrice: fees.gasPrice,
            };
        };

        const isNonceUsedError = (error: any): boolean => {
            const message = (error?.message || error?.error?.message || '').toLowerCase();
            return (
                message.includes('nonce too low') ||
                message.includes('nonce has already been used') ||
                error?.code === 'NONCE_EXPIRED'
            );
        };

        const isUnderpricedError = (error: any): boolean => {
            const message = (error?.message || error?.error?.message || '').toLowerCase();
            return (
                message.includes('underpriced') ||
                message.includes('fee cap less than block base fee')
            );
        };

        const computeBumpPercent = (attempt: number): number =>
            100 + attempt * RETRY_BUMP_STEP_PERCENT;

        for (let i = this.startIndex; i <= this.endIndex; i += this.concurrency) {
            const batchEnd = Math.min(i + this.concurrency, this.endIndex + 1);
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

                            let abortAccount = false;
                            for (let nonceToClear = latestNonce; nonceToClear < pendingNonce; nonceToClear++) {
                                let attempt = 0;
                                let clearedNonce = false;

                                while (attempt < MAX_RETRIES_PER_NONCE && !clearedNonce && !abortAccount) {
                                    const bumpPercent = computeBumpPercent(attempt);
                                    const feeConfig = await fetchBufferedFees(bumpPercent);
                                    const txBase = {
                                        to: wallet.address,
                                        value: 0,
                                        nonce: nonceToClear,
                                        gasLimit: 21000,
                                    };
                                    const tx = buildTxWithFees(txBase, feeConfig);

                                    try {
                                        const txResponse = await wallet.sendTransaction(tx);
                                        Logger.debug(`  -> Sent clearing transaction for nonce ${nonceToClear}. Hash: ${txResponse.hash}`);
                                        successfullyClearedInAccount++;
                                        clearedNonce = true;
                                    } catch (error: any) {
                                        if (isNonceUsedError(error)) {
                                            Logger.debug(`  -> Nonce ${nonceToClear} already mined for account ${accountIndex}, skipping.`);
                                            clearedNonce = true;
                                            break;
                                        }

                                        if (isUnderpricedError(error)) {
                                            attempt++;
                                            if (attempt >= MAX_RETRIES_PER_NONCE) {
                                                Logger.warn(`\n  -> Clearing tx for nonce ${nonceToClear} underpriced after ${attempt} attempts. Aborting account ${accountIndex}.`);
                                                abortAccount = true;
                                            } else {
                                                Logger.warn(`\n  -> Clearing tx underpriced for nonce ${nonceToClear} on account ${accountIndex}. Retrying with higher fees (attempt ${attempt + 1}/${MAX_RETRIES_PER_NONCE}).`);
                                            }
                                            continue;
                                        }

                                        Logger.warn(`\n  -> Failed to send clearing tx for nonce ${nonceToClear} on account ${accountIndex}: ${error.message}`);
                                        abortAccount = true;
                                    }
                                }

                                if (!clearedNonce || abortAccount) {
                                    break;
                                }
                            }

                            if (successfullyClearedInAccount > 0) {
                                Logger.debug(`\nSuccessfully sent ${successfullyClearedInAccount} of ${numToClear} clearing tx(s) for account ${accountIndex}.`);
                            }

                            if (abortAccount) {
                                Logger.warn(`  -> Aborting further clearing for account ${accountIndex}.`);
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
