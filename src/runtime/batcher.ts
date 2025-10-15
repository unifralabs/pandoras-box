import axios from 'axios';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';
import { TransactionRequest } from '@ethersproject/providers';
import { senderAccount } from './signer';
import { BigNumber } from '@ethersproject/bignumber';

class Batcher {
    // Generates batches of items based on the passed in
    // input set
    static generateBatches<ItemType>(
        items: ItemType[],
        batchSize: number
    ): ItemType[][] {
        if (batchSize <= 0) {
            return [];
        }
        const batches: ItemType[][] = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }

    static async batchTransactions(
        txsByAccount: TransactionRequest[][],
        accounts: senderAccount[],
        batchSize: number,
        url: string,
        _concurrency?: number,
        tps?: number
    ): Promise<string[]> {
        // Map accounts to their addresses for quick lookup
        const accountMap = new Map<string, senderAccount>();
        for (const acc of accounts) {
            accountMap.set(acc.getAddress().toLowerCase(), acc);
        }

        const senderQueues = txsByAccount;

        Logger.info(
            `Sending transactions for ${senderQueues.length} accounts...`
        );

        const batchBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} batches',
        });

        let totalTransactions = 0;
        let totalBatches = 0;
        for (const queue of senderQueues) {
            totalTransactions += queue.length;
        }
        totalBatches = Math.ceil(totalTransactions / batchSize);

        batchBar.start(totalBatches, 0, {
            speed: 'N/A',
        });
 
        const txHashes: string[] = [];
        const batchErrors: string[] = [];
 
        try {
            // Create a throttler function. If tps is not set, it does nothing.
            const createThrottler = () => {
                const msPerTx = tps && tps > 0 ? 1000 / tps : 0;
                if (msPerTx <= 0) {
                    Logger.info(`Global TPS limit disabled.`);
                    return async (_tokens: number) => Promise.resolve(); // Return a no-op async function
                }
 
                Logger.info(`Global TPS limit enabled: ~${(1000 / msPerTx).toFixed(0)} TPS`);
                let nextSlot = Date.now();
                const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
                let reservationChain: Promise<void> = Promise.resolve();
 
                return (tokens: number) => {
                    reservationChain = reservationChain.then(async () => {
                    const now = Date.now();
                    const earliest = Math.max(now, nextSlot);
                    const duration = tokens * msPerTx;
                    nextSlot = earliest + duration;
                    const waitMs = Math.max(0, earliest - now);
                    if (waitMs > 0) await sleep(waitMs);
                });
                    return reservationChain;
                };
            };
 
            const throttler = createThrottler();
            const concurrency = _concurrency || senderQueues.length;
            const effectiveConcurrency = Math.min(
                concurrency,
                senderQueues.length
            );

            // Define a type for our transaction jobs
            type TxJob = { tx: TransactionRequest, account: senderAccount };

            // 1. Prepare batches for all workers before starting them.
            const allBatches: TxJob[][][] = [];
            for (let i = 0; i < senderQueues.length; i++) {
                const workerIndex = i % effectiveConcurrency;
                if (!allBatches[workerIndex]) {
                    allBatches[workerIndex] = [];
                }
                const account = accounts[i];
                const jobs: TxJob[] = senderQueues[i].map(tx => ({ tx, account }));
                const jobBatches = Batcher.generateBatches(jobs, batchSize);
                allBatches[workerIndex].push(...jobBatches);
            }

            // The previous batching logic could split transactions from the same account across different workers,
            // leading to "replacement transaction underpriced" errors due to race conditions.
            // The new logic ensures all transactions for a single account are assigned to the same worker.
            //
            // for (let accountIdx = 0; accountIdx < senderQueues.length; accountIdx++) {
            //     const queue = senderQueues[accountIdx];
            //     const chargeWorker = accountIdx % effectiveConcurrency;
            //     const workerBatchList = allBatches[chargeWorker];
            //
            //     for (const tx of queue) {
            //         // ... (old logic removed)
            //     }
            // }


            // 3. Update the progress bar with the accurately calculated total number of batches.
            const totalBatches = allBatches.reduce((sum, workerBatches) => sum + workerBatches.length, 0);
            batchBar.start(totalBatches, 0, {
                speed: 'N/A',
            });


            // 4. Define the worker function.
            const workers: Promise<void>[] = [];
            const worker = async (workerId: number) => {
                const batchesForThisWorker = allBatches[workerId];

                for (const batch of batchesForThisWorker) {
                    let retries = 0;
                    const MAX_RETRIES = 3;
                    let currentBatch = batch;

                    while (retries < MAX_RETRIES && currentBatch.length > 0) {
                        const jobsToProcess = currentBatch;
                        currentBatch = []; // Prepare for the next retry iteration

                        // Sign transactions just-in-time
                        const signedTxs = await Promise.all(
                            jobsToProcess.map(job => job.account.wallet.signTransaction(job.tx))
                        );

                        const payloadItems = signedTxs.map((signedTx, index) => {
                            const id = `${workerId}-${jobsToProcess[index].tx.nonce}`;
                            return JSON.stringify({
                                jsonrpc: '2.0',
                                method: 'eth_sendRawTransaction',
                                params: [signedTx],
                                id,
                            });
                        });
                        const payload = `[${payloadItems.join(',')}]`;

                        try {
                            await throttler(jobsToProcess.length);
                            const resp = await axios({
                                url: url,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                data: payload,
                            });

                            if (!resp || !resp.data) {
                                batchErrors.push(`Batch for worker #${workerId}: Invalid response.`);
                                continue;
                            }

                            for (const cnt of resp.data) {
                                // eslint-disable-next-line no-prototype-builtins
                                if (cnt.hasOwnProperty('error')) {
                                    const errorMessage = cnt.error.message;
                                    const isUnderpriced = errorMessage.includes('replacement transaction underpriced');
                                    const isNonceTooLow = errorMessage.includes('nonce too low');

                                    if ((isUnderpriced || isNonceTooLow) && retries < MAX_RETRIES - 1) {
                                        // Find the original job to retry
                                        const jobToRetry = jobsToProcess.find(job => `${workerId}-${job.tx.nonce}` === cnt.id);
                                        if (jobToRetry) {
                                            // Increase gas price by 20% for retry
                                            const oldGasPrice = BigNumber.from(jobToRetry.tx.gasPrice);
                                            const newGasPrice = oldGasPrice.mul(120).div(100);
                                            jobToRetry.tx.gasPrice = newGasPrice;
                                            currentBatch.push(jobToRetry); // Add to the list for the next retry attempt
                                            Logger.warn(`Tx (nonce: ${jobToRetry.tx.nonce}) underpriced. Retrying with higher gas: ${newGasPrice.toString()}`);
                                        }
                                    } else {
                                        batchErrors.push(`Tx Error (worker #${workerId}, id: ${cnt.id}): ${errorMessage}`);
                                        batchBar.increment();
                                    }
                                } else {
                                    txHashes.push(cnt.result);
                                    batchBar.increment();
                                }
                            }
                        } catch (err: any) {
                            // Handle network errors for the whole batch
                            batchErrors.push(`Batch Error (worker #${workerId}): ${err.message}`);
                            batchBar.increment(jobsToProcess.length);
                        }

                        if (currentBatch.length > 0) {
                            retries++;
                            await new Promise(resolve => setTimeout(resolve, 1000 * (retries + 1))); // Exponential backoff
                        }
                    }
                }
            };

            // 5. Start the workers.
            for (let i = 0; i < effectiveConcurrency; i++) {
                workers.push(worker(i));
            }
            await Promise.all(workers);
        } catch (e: any) {
            Logger.error(e.message);
        }

        batchBar.stop();

        Logger.info(
            `Sent ${txHashes.length} transactions, writing errors to logfile`
        );
        if (batchErrors.length > 0) {
            Logger.error('Errors encountered during batch sending:');

            for (const err of batchErrors) {
                Logger.error(err);
            }
        }

        Logger.success(
            `${txHashes.length} transactions sent for ${senderQueues.length} accounts`
        );

        return txHashes;
    }
}

export default Batcher;
