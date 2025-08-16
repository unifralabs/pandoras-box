import axios from 'axios';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';

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
        signedTxsByAccount: string[][],
        batchSize: number,
        url: string,
        _concurrency?: number
    ): Promise<string[]> {
        const senderQueues = signedTxsByAccount;

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
            const concurrency = _concurrency || senderQueues.length;
            const effectiveConcurrency = Math.min(
                concurrency,
                senderQueues.length
            );

            // 1. Prepare batches for all workers before starting them.
            //    `allBatches` is an array where each element is the list of batches for a single worker.
            const allBatches: string[][][] = [];
            for (let i = 0; i < effectiveConcurrency; i++) {
                allBatches.push([]); // Initialize a batch list for each worker
            }

            // 2. Populate the batches using the efficient packing strategy.
            for (let accountIdx = 0; accountIdx < senderQueues.length; accountIdx++) {
                const queue = senderQueues[accountIdx];
                const chargeWorker = accountIdx % effectiveConcurrency;
                const workerBatchList = allBatches[chargeWorker];

                for (const tx of queue) {
                    const lastBatch = workerBatchList.at(-1);

                    if (lastBatch && lastBatch.length < batchSize) {
                        // If the last batch for this worker exists and is not full, add to it.
                        lastBatch.push(tx);
                    } else {
                        // Otherwise, create a new batch for this worker.
                        workerBatchList.push([tx]);
                    }
                }
            }
            
            // 3. Update the progress bar with the accurately calculated total number of batches.
            const totalBatches = allBatches.reduce((sum, workerBatches) => sum + workerBatches.length, 0);
            batchBar.start(totalBatches, 0, {
                speed: 'N/A',
            });


            // 4. Define the worker function.
            const workers: Promise<void>[] = [];
            const worker = async (workerId: number) => {
                const batchesForThisWorker = allBatches[workerId];
                let nextId = 0; // Each worker can have its own ID sequence

                for (const batch of batchesForThisWorker) {
                    const payloadItems = batch.map((signedTx) => {
                        const id = nextId++;
                        return JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'eth_sendRawTransaction',
                            params: [signedTx],
                            id,
                        });
                    });
                    const payload = `[${payloadItems.join(',')}]`;

                    try {
                        const resp = await axios({
                            url: url,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            data: payload,
                        });
                        batchBar.increment();

                        if (!resp || !resp.data) {
                            batchErrors.push(
                                `Batch for worker #${workerId}: Invalid response or missing data.`
                            );
                            continue;
                        }

                        for (const cnt of resp.data) {
                            // eslint-disable-next-line no-prototype-builtins
                            if (cnt.hasOwnProperty('error')) {
                                batchErrors.push(
                                    `Tx Error (worker #${workerId}, id: ${cnt.id}): ${cnt.error.message}`
                                );
                            } else {
                                txHashes.push(cnt.result);
                            }
                        }
                    } catch (err: any) {
                        batchBar.increment();
                        let errorDetails = `Batch for worker #${workerId}: `;
                        if (err.response) {
                            errorDetails += `HTTP ${
                                err.response.status
                            } - ${
                                err.response.statusText
                            } - ${JSON.stringify(err.response.data)}`;
                        } else if (err.request) {
                            errorDetails +=
                                'Network error - no response received';
                        } else {
                            errorDetails += `Request error: ${err.message}`;
                        }
                        batchErrors.push(errorDetails);
                        // We don't break here, as one failed batch for a worker doesn't affect other batches for the same worker
                        // because they contain txs from different accounts.
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
