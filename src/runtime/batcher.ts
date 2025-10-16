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

    static async batchSignedTransactions(
        signedTxsByAccount: string[][],
        accounts: senderAccount[],
        batchSize: number,
        url: string,
        _concurrency?: number,
        tps?: number
    ): Promise<string[]> {
        Logger.info(
            `Sending pre-signed transactions for ${signedTxsByAccount.length} accounts...`
        );

        const batchBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Sending Batches [{bar}] {percentage}% | ETA: {eta}s | Elapsed: {duration_formatted} | {value}/{total} batches',
        });

        // High-Efficiency Batching without using .flat():
        // 1. Iterate through each account's transactions.
        // 2. Create batches of the specified size without creating a large intermediate flat array.
        const allBatches: string[][] = [];
        let currentBatch: string[] = [];

        for (const accountTxs of signedTxsByAccount) {
            for (const tx of accountTxs) {
                currentBatch.push(tx);

            }
            if (currentBatch.length >= batchSize) {
                allBatches.push(currentBatch);
                currentBatch = [];
            }
        }

        // Add the last batch if it's not empty and wasn't pushed yet.
        // This handles cases where the total number of transactions is not a multiple of the batch size.
        if (currentBatch.length > 0) {
            allBatches.push(currentBatch);
        }

        const totalBatches = allBatches.length;

        batchBar.start(totalBatches, 0, { speed: 'N/A' });

        const txHashes: string[] = [];
        const batchErrors: string[] = [];

        Logger.info('Starting to send all transaction batches...');
        const startTime = Date.now();

        try {
            const createThrottler = () => {
                const msPerTx = tps && tps > 0 ? 1000 / tps : 0;
                if (msPerTx <= 0) {
                    return async (_tokens: number) => Promise.resolve();
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
            const concurrency = _concurrency || 50; // Default concurrency for sending

            const effectiveConcurrency = Math.min(concurrency, allBatches.length);
            Logger.info(
                `Configuration: Batch Size = ${batchSize}, Concurrency (Worker Threads) = ${effectiveConcurrency}`
            );

            const worker = async (workerId: number, assignedBatches: string[][]) => {
                for (const batch of assignedBatches) {
                    if (!batch || batch.length === 0) continue;

                    const payloadItems = batch.map((signedTx, index) => ({
                        jsonrpc: '2.0',
                        method: 'eth_sendRawTransaction',
                        params: [signedTx],
                        id: `${workerId}-${index}`, // Unique ID per worker and batch item
                    }));

                    const payload = JSON.stringify(payloadItems);

                    Logger.info(
                        `[Worker #${workerId}] Sending batch with ${batch.length} transactions. Payload size: ~${(payload.length / 1024).toFixed(2)} KB`
                    );

                    try {
                        await throttler(batch.length);
                        const resp = await axios({
                            url: url,
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            data: payload,
                        });

                        if (resp && resp.data) {
                            for (const cnt of resp.data) {
                                if (cnt.error) {
                                    batchErrors.push(`Tx Error (id: ${cnt.id}): ${cnt.error.message}`);
                                } else {
                                    txHashes.push(cnt.result);
                                }
                            }
                        }
                    } catch (err: any) {
                        batchErrors.push(`[Worker #${workerId}] Batch Network Error: ${err.message}`);
                    } finally {
                        batchBar.increment();
                    }
                }
            };

            // Pre-assign batches to workers to avoid race conditions on Array.shift()
            // The `allBatches` variable is now correctly structured, with each element
            // being a batch of the desired size. We distribute these small batches
            // evenly among the workers.
            const workerBatches: string[][][] = Array.from({ length: effectiveConcurrency }, () => []);
            allBatches.forEach((batch, index) => {
                workerBatches[index % effectiveConcurrency].push(batch);
            });

            const workers = workerBatches.map((assignedBatches, i) => worker(i + 1, assignedBatches));
            await Promise.all(workers);

            const endTime = Date.now();
            const durationInSeconds = (endTime - startTime) / 1000; //NOSONAR
            Logger.info(`Finished sending all batches in ${durationInSeconds.toFixed(2)} seconds.`);

        } catch (e: any) {
            Logger.error(e.message);
        }

        batchBar.stop();

        Logger.info(`Sent ${txHashes.length} transactions, writing errors to logfile`);
        if (batchErrors.length > 0) {
            Logger.error('Errors encountered during batch sending:');
            for (const err of batchErrors) {
                Logger.error(err);
            }
        }

        Logger.success(`${txHashes.length} transactions sent for ${accounts.length} accounts`);
        return txHashes;
    }

}

export default Batcher;
