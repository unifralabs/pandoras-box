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
        const batches: ItemType[][] = [];

        // Find the required number of batches
        let numBatches: number = Math.ceil(items.length / batchSize);
        if (numBatches == 0) {
            numBatches = 1;
        }

        // Initialize empty batches
        for (let i = 0; i < numBatches; i++) {
            batches[i] = [];
        }

        let currentBatch = 0;
        for (const item of items) {
            batches[currentBatch].push(item);

            if (batches[currentBatch].length % batchSize == 0) {
                currentBatch++;
            }
        }

        return batches;
    }

    static async batchTransactions(
        signedTxs: string[],
        batchSize: number,
        url: string,
        _concurrency?: number
    ): Promise<string[]> {
        // Generate the transaction hash batches
        const batches: string[][] = Batcher.generateBatches<string>(
            signedTxs,
            batchSize
        );

        Logger.info(`Sending transactions in ${batches.length} batches...`);

        const batchBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} batches',
        });

        batchBar.start(batches.length, 0, {
            speed: 'N/A',
        });

        const txHashes: string[] = [];
        const batchErrors: string[] = [];

        try {
            let nextIndx = 0;
            const payloads: string[] = [];
            for (const item of batches) {
                let singleRequests = '';
                for (let i = 0; i < item.length; i++) {
                    singleRequests += JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_sendRawTransaction',
                        params: [item[i]],
                        id: nextIndx++,
                    });

                    if (i != item.length - 1) {
                        singleRequests += ',\n';
                    }
                }
                payloads.push('[' + singleRequests + ']');
            }

            let responses: any[];

            if (!_concurrency || _concurrency <= 0 || _concurrency >= payloads.length) {
                const rawResponses = await Promise.all(
                    payloads.map((data) => {
                        batchBar.increment();
                        return axios({
                            url: url,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            data: data,
                        });
                    })
                );
                responses = rawResponses;
            } else {
                responses = new Array(payloads.length);
                let cursor = 0;
                const workers: Promise<void>[] = [];
                const spawn = Math.max(1, Math.min(_concurrency, payloads.length));

                const worker = async () => {
                    for (;;) {
                        let idx = -1;
                        if (cursor < payloads.length) {
                            idx = cursor;
                            cursor++;
                        } else {
                            break;
                        }

                        const data = payloads[idx];
                        batchBar.increment();
                        try {
                            const resp = await axios({
                                url: url,
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                data: data,
                            });
                            responses[idx] = resp;
                        } catch (err) {
                            responses[idx] = err;
                        }
                    }
                };

                for (let i = 0; i < spawn; i++) {
                    workers.push(worker());
                }
                await Promise.all(workers);
            }

            for (let i = 0; i < responses.length; i++) {
                const resp = responses[i];
                if (!resp || !resp.data) {
                    // Provide more detailed error information
                    let errorDetails = `Batch ${i + 1}: `;
                    if (!resp) {
                        errorDetails += 'No response received';
                    } else if (resp.response) {
                        // This is an axios error with response
                        errorDetails += `HTTP ${resp.response.status} - ${resp.response.statusText}`;
                        if (resp.response.data) {
                            errorDetails += ` - ${JSON.stringify(resp.response.data)}`;
                        }
                    } else if (resp.request) {
                        // Network error
                        errorDetails += 'Network error - no response received';
                    } else if (resp.message) {
                        // Other axios error
                        errorDetails += `Request error: ${resp.message}`;
                    } else {
                        // Response exists but no data field
                        errorDetails += `Invalid response structure - missing data field. Status: ${resp.status || 'unknown'}`;
                        if (resp.statusText) {
                            errorDetails += `, StatusText: ${resp.statusText}`;
                        }
                    }
                    batchErrors.push(errorDetails);
                    continue;
                }
                const content = resp.data;

                for (const cnt of content) {
                    // eslint-disable-next-line no-prototype-builtins
                    if (cnt.hasOwnProperty('error')) {
                        batchErrors.push(cnt.error.message);
                        continue;
                    }

                    txHashes.push(cnt.result);
                }
            }
        } catch (e: any) {
            Logger.error(e.message);
        }

        batchBar.stop();

        if (batchErrors.length > 0) {
            Logger.error('Errors encountered during batch sending:');

            for (const err of batchErrors) {
                Logger.error(err);
            }
        }

        Logger.success(
            `${batches.length} ${batches.length > 1 ? 'batches' : 'batch'} sent`
        );

        return txHashes;
    }
}

export default Batcher;
