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
            const pendingCount = await this.getPendingBlockTransactionCount(provider);
            if (pendingCount !== null) {
                Logger.debug('Used method: eth_getBlockTransactionCountByNumber("pending")');
                return pendingCount;
            }
            return 0;
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
            format: 'Gathering receipts [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
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
        blocks: Map<number, BlockInfo>
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
        let emptyBlockCount = 0;
        let blockNumber = startBlock;
        for (; emptyBlockCount < 10;) { // Increase from 5 to 20
            try {
                // Check pending transaction count to determine if transactions are still being processed
                const pendingTxCount = await this.getPendingTransactionCount(provider);
                // Logger.debug(`Pending transactions: ${pendingTxCount}`);

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
                    else if (Date.now() - waitStartTime > 600000) {
                        scanBar.stop();
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                } else {
                    // Calculate TPS for the current block
                    let tps = 0;
                    const prevBlockInfo = blocks.get(blockNumber - 1);
                    if (prevBlockInfo) {
                        const timeDiff = block.timestamp - prevBlockInfo.createdAt;
                        if (timeDiff > 0) {
                            tps = Number((block.transactions.length / timeDiff).toFixed(2));
                        }
                    }

                    // Create a new BlockInfo object and add it to the map
                    blocks.set(blockNumber, new BlockInfo(
                        block.number,
                        block.timestamp,
                        block.transactions.length,
                        block.gasUsed,
                        block.gasLimit,
                        tps
                    ));
                    waitStartTime = 0;
                    scanBar.update({ scannedBlocks: blockNumber });
                    blockNumber++;
                    let newTxFound = false;
                    if (block.transactions) {
                        for (const tx of block.transactions) {
                            const txHash = tx.hash;
                            if (targetTxSet.has(txHash)) {
                                succeededTransactions.push(new txStats(txHash, block.number));
                                scanBar.update(succeededTransactions.length, {});
                                newTxFound = true;
                            }
                        }
                        if (targetTxSet.size === succeededTransactions.length) {
                            scanBar.stop();
                            break;
                        }
                    }
                    if (!newTxFound && succeededTransactions.length > 0) {
                        emptyBlockCount++;
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
        Logger.success(`Found ${foundCount}/${totalCount} transactions in blocks ${startBlock} - ${blockNumber}`);

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

    /**
     * Fetches block information in parallel with batching to improve performance on slow networks.
     * @param stats Array of transaction statistics containing block numbers.
     * @param provider The Ethereum provider.
     * @returns A map of block numbers to BlockInfo objects.
     */
    async fetchBlockInfo(
        stats: txStats[],
        provider: Provider
    ): Promise<Map<number, BlockInfo>> {
        Logger.info('\nGathering block info...');
        const blocksBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Gathering blocks [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} blocks',
        });

        // 1. Collect all unique block numbers we need to fetch.
        // This includes the block itself and the previous block for TPS calculation.
        const uniqueBlockNumbers = new Set<number>();
        for (const s of stats) {
            if (s.block > 0) {
                uniqueBlockNumbers.add(s.block);
            }
        }

        const sortedUniqueBlocks = Array.from(uniqueBlockNumbers).sort((a, b) => a - b);
        const allBlockNumbersToFetch = new Set<number>(sortedUniqueBlocks);
        if (sortedUniqueBlocks.length > 0) {
            // Also fetch the block before the first one for TPS calculation of the first block in our list.
            allBlockNumbersToFetch.add(sortedUniqueBlocks[0] - 1);
        }

        blocksBar.start(allBlockNumbersToFetch.size, 0, { speed: 'N/A' });

        // 2. Fetch all required blocks in parallel, with batching.
        const BATCH_SIZE = 50; // Number of parallel requests per batch
        const blockNumbersArray = Array.from(allBlockNumbersToFetch);
        const fetchedBlocks = new Map<number, any>();
        const blockFetchErrors: Error[] = [];

        for (let i = 0; i < blockNumbersArray.length; i += BATCH_SIZE) {
            const batch = blockNumbersArray.slice(i, i + BATCH_SIZE);
            const promises = batch.map(blockNum =>
                provider.getBlock(blockNum).catch(e => {
                    blockFetchErrors.push(new Error(`Failed to fetch block ${blockNum}: ${e.message}`));
                    return null; // Return null on error to not break Promise.all
                })
            );

            const results = await Promise.all(promises);

            results.forEach((blockInfo, index) => {
                if (blockInfo) {
                    fetchedBlocks.set(batch[index], blockInfo);
                }
                blocksBar.increment();
            });
        }
        blocksBar.stop();

        // 3. Now that we have all blocks, calculate TPS and create BlockInfo objects.
        const blocksMap = new Map<number, BlockInfo>();
        for (const blockNum of sortedUniqueBlocks) {
            const fetchedInfo = fetchedBlocks.get(blockNum);
            if (!fetchedInfo) continue;

            let tps = 0;
            const prevBlockInfo = fetchedBlocks.get(blockNum - 1);

            if (prevBlockInfo) {
                const timeDiff = fetchedInfo.timestamp - prevBlockInfo.timestamp;
                if (timeDiff > 0) {
                    tps = Number((fetchedInfo.transactions.length / timeDiff).toFixed(2));
                }
            }

            blocksMap.set(blockNum, new BlockInfo(
                blockNum, fetchedInfo.timestamp, fetchedInfo.transactions.length,
                fetchedInfo.gasUsed, fetchedInfo.gasLimit, tps
            ));
        }

        Logger.success('Gathered block info');
        if (blockFetchErrors.length > 0) {
            Logger.warn('Errors encountered during block info fetch:');

            for (const err of blockFetchErrors) {
                Logger.error(err.message);
            }
        }

        return blocksMap;
    }

    calcTPS(stats: txStats[], blockInfoMap: Map<number, BlockInfo>): number {
        Logger.title('\n🧮 Calculating TPS data 🧮\n');
        let totalTxs = 0;
        let totalTime = 0;

        const uniqueBlocks = new Set<number>();

        // Collect all unique blocks first
        for (const stat of stats) {
            if (stat.block == 0) {
                continue;
            }
            uniqueBlocks.add(stat.block);
        }

        const sortedBlocks = Array.from(uniqueBlocks).sort((a, b) => a - b);

        // Handle edge cases: we need at least 3 blocks with transactions to calculate a TPS range.
        if (sortedBlocks.length < 4) { // Need at least 4 blocks to have a start, end, and a block in between.
            Logger.error(
                'Insufficient data to calculate Overall TPS (need at least 4 blocks with transactions to define a stable range)'
            );
            Logger.error(`Found only ${sortedBlocks.length} block(s) with transactions. Cannot exclude start and end blocks.`);
            return 0;
        }

        // The calculation range is from the second block to the second-to-last block.
        // This aligns with the data displayed in the final report table.
        const secondBlock = sortedBlocks[1];
        const secondToLastBlock = sortedBlocks[sortedBlocks.length - 2];

        // Count transactions within the defined range (inclusive).
        for (const stat of stats) {
            if (stat.block >= secondBlock && stat.block <= secondToLastBlock) {
                totalTxs++;
            }
        }

        // Calculate total time span from the second block to the second-to-last block.
        const lastBlockInfo = blockInfoMap.get(secondToLastBlock);
        const secondBlockInfo = blockInfoMap.get(secondBlock);

        if (!secondBlockInfo || !lastBlockInfo) {
            Logger.error(
                'Failed to find second or last block info in the pre-fetched map during TPS calculation.'
            );
            return 0;
        }

        totalTime = Math.abs(lastBlockInfo.createdAt - secondBlockInfo.createdAt);

        if (totalTxs === 0) {
            Logger.warn('No transactions found in the calculated range. Overall TPS is 0.');
            return 0;
        }

        if (totalTime === 0) {
            Logger.warn(
                'The time difference between the start and end blocks of the calculation range is zero. Using a minimum of 1s for TPS calculation to avoid division by zero.'
            );
            totalTime = 1;
        }

        return Math.ceil(totalTxs / totalTime);
    }

    printBlockData(blockInfoMap: Map<number, BlockInfo>) {
        Logger.title('\nBlock utilization data:');
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

        Logger.title(utilizationTable.toString());
    }

    printFinalData(tps: number, blockInfoMap: Map<number, BlockInfo>) {
        // Find average utilization
        let totalUtilization = 0;
        blockInfoMap.forEach((info) => {
            totalUtilization += info.gasUtilization;
        });
        const avgUtilization = totalUtilization / blockInfoMap.size;

        // Calculate per-block transaction count statistics
        const txCountValues: number[] = [];
        blockInfoMap.forEach((info) => {
            // All blocks with info have transactions, so we can just push numTxs
            txCountValues.push(info.numTxs);
        });

        let maxTxsPerBlock = 0;
        let minTxsPerBlock = 0;
        let avgTxsPerBlock = 0;

        if (txCountValues.length > 0) {
            maxTxsPerBlock = Math.max(...txCountValues);
            minTxsPerBlock = Math.min(...txCountValues);
            avgTxsPerBlock =
                txCountValues.reduce((sum, val) => sum + val, 0) /
                txCountValues.length;
        }

        // New calculations based on your request
        const sortedBlockNumbers = Array.from(blockInfoMap.keys()).sort((a, b) => a - b);
        let includedBlockCount = 0;
        let includedTxCount = 0;
        let startTime = 0;
        let endTime = 0;
        let startBlockNum = 0;
        let endBlockNum = 0;

        if (sortedBlockNumbers.length > 2) {
            startBlockNum = sortedBlockNumbers[1];
            endBlockNum = sortedBlockNumbers[sortedBlockNumbers.length - 2];
            startTime = blockInfoMap.get(startBlockNum)?.createdAt ?? 0;
            endTime = blockInfoMap.get(endBlockNum)?.createdAt ?? 0;

            for (let i = 1; i < sortedBlockNumbers.length - 1; i++) {
                const blockNum = sortedBlockNumbers[i];
                const block = blockInfoMap.get(blockNum);
                if (block) {
                    includedBlockCount++;
                    includedTxCount += block.numTxs;
                }
            }
        }

        const totalTime = (endTime > startTime) ? (endTime - startTime) : 0;
        const avgBlockTime = (includedBlockCount > 1 && totalTime > 0) ? (totalTime / (includedBlockCount - 1)).toFixed(2) : 'N/A';

        const finalDataTable = new Table({
            head: ['Metric', 'Value'],
        });

        finalDataTable.push(
            { 'Overall TPS': tps },
            { 'Total Txs (included)': includedTxCount },
            { 'Total Blocks (included)': includedBlockCount },
            { 'Start Block': startBlockNum > 0 ? startBlockNum : 'N/A' },
            { 'End Block': endBlockNum > 0 ? endBlockNum : 'N/A' },
            { 'Start Time': startTime > 0 ? new Date(startTime * 1000).toISOString() : 'N/A' },
            { 'End Time': endTime > 0 ? new Date(endTime * 1000).toISOString() : 'N/A' },
            { 'Avg. Block Time (s)': avgBlockTime },
            { 'Avg. Utilization': `${avgUtilization.toFixed(2)}%` },
            { 'Max Txs/Block': maxTxsPerBlock },
            { 'Min Txs/Block': minTxsPerBlock > 0 ? minTxsPerBlock : 'N/A' },
            { 'Avg Txs/Block': avgTxsPerBlock > 0 ? avgTxsPerBlock.toFixed(1) : 'N/A' }
        );

        Logger.title(finalDataTable.toString());
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

        let blockInfoMapAll = new Map<number, BlockInfo>();

        // Gather transaction receipts
        const txStats = await this.gatherTransactionReceipts(
            txHashes,
            batchSize,
            provider,
            startBlock,
            blockInfoMapAll
        );

        // Fetch block info
        //const blockInfoMap = await this.fetchBlockInfo(txStats, provider);

        let blockInfoMap = new Map<number, BlockInfo>();
        for (const tx of txStats) {
            const blockInfo = blockInfoMapAll.get(tx.block);
            if (blockInfo) {
                blockInfoMap.set(tx.block, blockInfo);
            }
        }

        blockInfoMap.delete(Math.min(...blockInfoMap.keys()));
        blockInfoMap.delete(Math.max(...blockInfoMap.keys()));


        // Print the block utilization data
        this.printBlockData(blockInfoMap);

        // Print the final TPS and avg. utilization data
        const avgTPS = this.calcTPS(txStats, blockInfoMap);
        this.printFinalData(avgTPS, blockInfoMap);

        return new CollectorData(avgTPS, blockInfoMap);
    }
}

export { StatCollector, CollectorData, BlockInfo };
