import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import axios, { AxiosResponse } from 'axios';
import { SingleBar } from 'cli-progress';
import Table from 'cli-table3';
import Logger from '../logger/logger';
import Batcher from '../runtime/batcher';

class txStats {
    txHash: string;
    block = 0;

    constructor(txHash: string, block: number) {
        this.txHash = txHash;
        this.block = block;
    }
}

class BlockInfo {
    blockNum: number;
    createdAt: number;
    numTxs: number;

    gasUsed: string;
    gasLimit: string;
    gasUtilization: number;
    tps: number;

    constructor(
        blockNum: number,
        createdAt: number,
        numTxs: number,
        gasUsed: BigNumber,
        gasLimit: BigNumber,
        tps: number = 0
    ) {
        this.blockNum = blockNum;
        this.createdAt = createdAt;
        this.numTxs = numTxs;
        this.gasUsed = gasUsed.toHexString();
        this.gasLimit = gasLimit.toHexString();
        this.tps = tps;

        const largeDivision = gasUsed
            .mul(BigNumber.from(10000))
            .div(gasLimit)
            .toNumber();

        this.gasUtilization = largeDivision / 100;
    }
}

class CollectorData {
    tps: number;
    blockInfo: Map<number, BlockInfo>;

    constructor(tps: number, blockInfo: Map<number, BlockInfo>) {
        this.tps = tps;
        this.blockInfo = blockInfo;
    }
}

class txBatchResult {
    succeeded: txStats[];
    remaining: string[];

    errors: string[];

    constructor(succeeded: txStats[], remaining: string[], errors: string[]) {
        this.succeeded = succeeded;
        this.remaining = remaining;

        this.errors = errors;
    }
}

class StatCollector {
    /**
     * Get the number of pending transactions in the transaction pool
     * @param provider The Ethereum provider
     * @returns Number of pending transactions
     */
    async getPendingTransactionCount(provider: Provider): Promise<number> {
        try {
            // Method 1: Try txpool_status (if supported by the node)
            const txpoolStatus = await this.getTxpoolStatus(provider);
            if (txpoolStatus !== null) {
                return txpoolStatus.pending || 0;
            }

            // Method 2: Use eth_getBlockTransactionCountByNumber with "pending"
            const pendingCount = await this.getPendingBlockTransactionCount(provider);
            if (pendingCount !== null) {
                return pendingCount;
            }

            // Method 3: Fallback - estimate by checking latest block vs pending block
            const latestCount = await provider.getBlockNumber();
            const pendingBlockCount = await provider.getTransactionCount("0x0000000000000000000000000000000000000000", "pending");
            
            return Math.max(0, pendingBlockCount);
        } catch (error: any) {
            Logger.warn(`Failed to get pending transaction count: ${error.message}`);
            return 0;
        }
    }

    /**
     * Get transaction pool status using txpool_status RPC method
     * @param provider The Ethereum provider
     * @returns Txpool status or null if not supported
     */
    async getTxpoolStatus(provider: Provider): Promise<{ pending: number; queued: number } | null> {
        try {
            const rpcProvider = provider as JsonRpcProvider;
            const result = await rpcProvider.send('txpool_status', []);
            
            return {
                pending: parseInt(result.pending, 16) || 0,
                queued: parseInt(result.queued, 16) || 0
            };
        } catch (error: any) {
            // txpool_status might not be supported by all nodes
            return null;
        }
    }

    /**
     * Get pending block transaction count using eth_getBlockTransactionCountByNumber
     * @param provider The Ethereum provider
     * @returns Number of pending transactions or null if not supported
     */
    async getPendingBlockTransactionCount(provider: Provider): Promise<number | null> {
        try {
            const rpcProvider = provider as JsonRpcProvider;
            const result = await rpcProvider.send('eth_getBlockTransactionCountByNumber', ['pending']);
            return parseInt(result, 16) || 0;
        } catch (error: any) {
            return null;
        }
    }

    /**
     * Get detailed pending transaction information using txpool_content
     * @param provider The Ethereum provider
     * @returns Detailed txpool content or null if not supported
     */
    async getTxpoolContent(provider: Provider): Promise<any | null> {
        try {
            const rpcProvider = provider as JsonRpcProvider;
            const result = await rpcProvider.send('txpool_content', []);
            return result;
        } catch (error: any) {
            Logger.warn(`txpool_content not supported: ${error.message}`);
            return null;
        }
    }

    async gatherTransactionReceipts_old(
        txHashes: string[],
        batchSize: number,
        provider: Provider
    ): Promise<txStats[]> {
        Logger.info('Gathering transaction receipts...');

        const receiptBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        receiptBar.start(txHashes.length, 0, {
            speed: 'N/A',
        });

        const fetchErrors: string[] = [];

        let receiptBarProgress = 0;
        let retryCounter = Math.ceil(txHashes.length * 0.025);
        let remainingTransactions: string[] = txHashes;
        let succeededTransactions: txStats[] = [];

        const providerURL = (provider as JsonRpcProvider).connection.url;

        // Fetch transaction receipts in batches,
        // until the batch retry counter is reached (to avoid spamming)
        while (remainingTransactions.length > 0) {
            // Get the receipts for this batch
            const result = await this.fetchTransactionReceipts(
                remainingTransactions,
                batchSize,
                providerURL
            );

            // Save any fetch errors
            for (const fetchErr of result.errors) {
                fetchErrors.push(fetchErr);
            }

            // Update the remaining transactions whose
            // receipts need to be fetched
            remainingTransactions = result.remaining;

            // Save the succeeded transactions
            succeededTransactions = succeededTransactions.concat(
                result.succeeded
            );

            // Update the user loading bar
            receiptBar.increment(
                succeededTransactions.length - receiptBarProgress
            );
            receiptBarProgress = succeededTransactions.length;

            // Decrease the retry counter
            retryCounter--;

            if (remainingTransactions.length == 0 || retryCounter == 0) {
                // If there are no more remaining transaction receipts to wait on,
                // or the batch retries have been depleted, stop the batching process
                break;
            }

            // Wait for a block to be mined on the network before asking
            // for the receipts again
            await new Promise((resolve) => {
                provider.once('block', () => {
                    resolve(null);
                });
            });
        }

        // Wait for the transaction receipts individually
        // if they were not retrieved in the batching process.
        // This process is slower, but it guarantees transaction receipts
        // will eventually get retrieved, regardless of the number of blocks
        for (const txHash of remainingTransactions) {
            const txReceipt = await provider.waitForTransaction(
                txHash,
                1,
                30 * 1000 // 30s per transaction
            );

            receiptBar.increment(1);

            if (txReceipt.status != undefined && txReceipt.status == 0) {
                throw new Error(
                    `transaction ${txReceipt.transactionHash} failed on execution`
                );
            }

            succeededTransactions.push(
                new txStats(txHash, txReceipt.blockNumber)
            );
        }

        receiptBar.stop();
        if (fetchErrors.length > 0) {
            Logger.warn('Errors encountered during batch sending:');

            for (const err of fetchErrors) {
                Logger.error(err);
            }
        }

        Logger.success('Gathered transaction receipts');

        return succeededTransactions;
    }

    async gatherTransactionReceipts(
        txHashes: string[],
        batchSize: number,
        provider: Provider,
        startBlock: number,
    ): Promise<txStats[]> {
        let succeededTransactions: txStats[] = [];

        Logger.info(`Scanning blocks ${startBlock} for transactions...`);

        const targetTxSet = new Set(txHashes);

        const scanBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: false,
            format: '{scannedBlocks} blocks|{bar} {percentage}% | {value}/{total} txs | {speed} | {eta}s',
        });

        scanBar.start(txHashes.length, 0, {
            speed: 'N/A',
        });

        const errors: string[] = [];


        let waitStartTime = 0;
        for (let blockNumber = startBlock; ; blockNumber) {
            try {
                // Check pending transaction count to determine if transactions are still being processed
                const pendingTxCount = await this.getPendingTransactionCount(provider);
                Logger.debug(`Pending transactions: ${pendingTxCount}`);
                
                // If no pending transactions for a while, consider processing complete
                if (pendingTxCount === 0 && succeededTransactions.length === txHashes.length) {
                    scanBar.stop();
                    Logger.info('All transactions processed and no pending transactions found');
                    break;
                }

                const block = await provider.getBlockWithTransactions(blockNumber);
                if (!block) {
                    if (waitStartTime == 0) {
                        waitStartTime = Date.now();
                    }
                    else if (Date.now() - waitStartTime > 10000) {
                        scanBar.stop();
                        break;
                    }
                    continue;
                } else {
                    scanBar.update({scannedBlocks:blockNumber});
                    blockNumber++;
                    if (block.transactions) {
                        for (const tx of block.transactions) {
                            const txHash = tx.hash;
                            if (targetTxSet.has(txHash)) {
                                succeededTransactions.push(new txStats(txHash, blockNumber));
                                scanBar.update(succeededTransactions.length, {});
                            }
                        }
                    }
                }
            } catch (error: any) {
                
                errors.push(`Failed to scan block ${blockNumber}: ${error.message}`);
            }
        }

        scanBar.stop();

        if (errors.length > 0) {
            Logger.warn('Errors encountered during block scanning:');
            for (const err of errors) {
                Logger.error(err);
            }
        }

        const foundCount = succeededTransactions.length;
        const totalCount = txHashes.length;
        Logger.success(`Found ${foundCount}/${totalCount} transactions in blocks ${startBlock}`);

        if (foundCount < totalCount) {
            Logger.warn(`${totalCount - foundCount} transactions were not found in the scanned block range`);
        }

        return succeededTransactions;
    }
    async fetchTransactionReceipts(
        txHashes: string[],
        batchSize: number,
        url: string
    ): Promise<txBatchResult> {
        // Create the batches for transaction receipts
        const batches: string[][] = Batcher.generateBatches<string>(
            txHashes,
            batchSize
        );
        const succeeded: txStats[] = [];
        const remaining: string[] = [];
        const batchErrors: string[] = [];

        let nextIndx = 0;
        const responses = await Promise.all<AxiosResponse<any, any>>(
            batches.map((hashes) => {
                let singleRequests = '';
                for (let i = 0; i < hashes.length; i++) {
                    singleRequests += JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_getTransactionReceipt',
                        params: [hashes[i]],
                        id: nextIndx++,
                    });

                    if (i != hashes.length - 1) {
                        singleRequests += ',\n';
                    }
                }

                return axios({
                    url: url,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    data: '[' + singleRequests + ']',
                });
            })
        );

        for (let batchIndex = 0; batchIndex < responses.length; batchIndex++) {
            const data = responses[batchIndex].data;

            for (
                let txHashIndex = 0;
                txHashIndex < data.length;
                txHashIndex++
            ) {
                const batchItem = data[txHashIndex];

                if (!batchItem.result) {
                    remaining.push(batches[batchIndex][txHashIndex]);

                    continue;
                }

                // eslint-disable-next-line no-prototype-builtins
                if (batchItem.hasOwnProperty('error')) {
                    // Error occurred during batch sends
                    batchErrors.push(batchItem.error.message);

                    continue;
                }

                if (batchItem.result.status == '0x0') {
                    // Transaction failed
                    throw new Error(
                        `transaction ${batchItem.result.transactionHash} failed on execution`
                    );
                }

                succeeded.push(
                    new txStats(
                        batchItem.result.transactionHash,
                        parseInt(batchItem.result.blockNumber, 16)
                    )
                );
            }
        }

        return new txBatchResult(succeeded, remaining, batchErrors);
    }

    async fetchBlockInfo(
        stats: txStats[],
        provider: Provider
    ): Promise<Map<number, BlockInfo>> {
        const blockSet: Set<number> = new Set<number>();
        for (const s of stats) {
            blockSet.add(s.block);
        }

        const blockFetchErrors: Error[] = [];

        Logger.info('\nGathering block info...');
        const blocksBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        blocksBar.start(blockSet.size, 0, {
            speed: 'N/A',
        });

        const blocksMap: Map<number, BlockInfo> = new Map<number, BlockInfo>();
        const sortedBlocks = Array.from(blockSet).sort((a, b) => a - b);

        // Fetch blocks and calculate TPS
        for (let i = 0; i < sortedBlocks.length; i++) {
            const block = sortedBlocks[i];
            try {
                const fetchedInfo = await provider.getBlock(block);
                let tps = 0;

                // Calculate TPS for this block
                if (i > 0) {
                    // Get the previous block for time difference calculation
                    const prevBlock = sortedBlocks[i - 1];
                    const prevBlockInfo = await provider.getBlock(prevBlock);
                    const timeDiff = fetchedInfo.timestamp - prevBlockInfo.timestamp;

                    // Calculate TPS (transactions per second)
                    if (timeDiff > 0) {
                        tps = Number((fetchedInfo.transactions.length / timeDiff).toFixed(2));
                    }
                }

                blocksBar.increment();

                blocksMap.set(
                    block,
                    new BlockInfo(
                        block,
                        fetchedInfo.timestamp,
                        fetchedInfo.transactions.length,
                        fetchedInfo.gasUsed,
                        fetchedInfo.gasLimit,
                        tps
                    )
                );
            } catch (e: any) {
                blockFetchErrors.push(e);
            }
        }

        blocksBar.stop();

        Logger.success('Gathered block info');

        if (blockFetchErrors.length > 0) {
            Logger.warn('Errors encountered during block info fetch:');

            for (const err of blockFetchErrors) {
                Logger.error(err.message);
            }
        }

        return blocksMap;
    }

    async calcTPS(stats: txStats[], provider: Provider): Promise<number> {
        Logger.title('\n🧮 Calculating TPS data 🧮\n');
        let totalTxs = 0;
        let totalTime = 0;

        // Find the average txn time per block
        const blockFetchErrors = [];
        const blockTimeMap: Map<number, number> = new Map<number, number>();
        const uniqueBlocks = new Set<number>();

        for (const stat of stats) {
            if (stat.block == 0) {
                continue;
            }

            totalTxs++;
            uniqueBlocks.add(stat.block);
        }

        for (const block of uniqueBlocks) {
            // Get the parent block to find the generation time
            try {
                const currentBlockNum = block;
                const parentBlockNum = currentBlockNum - 1;

                if (!blockTimeMap.has(parentBlockNum)) {
                    const parentBlock = await provider.getBlock(parentBlockNum);

                    blockTimeMap.set(parentBlockNum, parentBlock.timestamp);
                }

                const parentBlock = blockTimeMap.get(parentBlockNum) as number;

                if (!blockTimeMap.has(currentBlockNum)) {
                    const currentBlock =
                        await provider.getBlock(currentBlockNum);

                    blockTimeMap.set(currentBlockNum, currentBlock.timestamp);
                }

                const currentBlock = blockTimeMap.get(
                    currentBlockNum
                ) as number;

                totalTime += Math.round(Math.abs(currentBlock - parentBlock));
            } catch (e: any) {
                blockFetchErrors.push(e);
            }
        }

        return Math.ceil(totalTxs / totalTime);
    }

    printBlockData(blockInfoMap: Map<number, BlockInfo>) {
        Logger.info('\nBlock utilization data:');
        const utilizationTable = new Table({
            head: [
                'Block #',
                'Gas Used [wei]',
                'Gas Limit [wei]',
                'Transactions',
                'Utilization',
                'TPS',
            ],
        });

        const sortedMap = new Map(
            [...blockInfoMap.entries()].sort((a, b) => a[0] - b[0])
        );

        sortedMap.forEach((info) => {
            utilizationTable.push([
                info.blockNum.toString(),
                info.gasUsed,
                info.gasLimit,
                info.numTxs,
                `${info.gasUtilization}%`,
                info.tps === 0 ? 'N/A' : info.tps.toString(),
            ]);
        });

        Logger.info(utilizationTable.toString());
    }

    printFinalData(tps: number, blockInfoMap: Map<number, BlockInfo>) {
        // Find average utilization
        let totalUtilization = 0;
        blockInfoMap.forEach((info) => {
            totalUtilization += info.gasUtilization;
        });
        const avgUtilization = totalUtilization / blockInfoMap.size;

        const finalDataTable = new Table({
            head: ['TPS', 'Blocks', 'Avg. Utilization'],
        });

        finalDataTable.push([
            tps,
            blockInfoMap.size,
            `${avgUtilization.toFixed(2)}%`,
        ]);

        Logger.info(finalDataTable.toString());
    }

    async generateStats(
        txHashes: string[],
        mnemonic: string,
        url: string,
        batchSize: number,
        startBlock: number
    ): Promise<CollectorData> {
        if (txHashes.length == 0) {
            Logger.warn('No stat data to display');

            return new CollectorData(0, new Map());
        }

        Logger.title('\n⏱ Statistics calculation initialized ⏱\n');

        const provider = new JsonRpcProvider(url);

        // Fetch receipts
        const txStats = await this.gatherTransactionReceipts(
            txHashes,
            batchSize,
            provider,
            startBlock
        );

        // Fetch block info
        const blockInfoMap = await this.fetchBlockInfo(txStats, provider);

        // Print the block utilization data
        this.printBlockData(blockInfoMap);

        // Print the final TPS and avg. utilization data
        const avgTPS = await this.calcTPS(txStats, provider);
        this.printFinalData(avgTPS, blockInfoMap);

        return new CollectorData(avgTPS, blockInfoMap);
    }
}

export { StatCollector, CollectorData, BlockInfo };
