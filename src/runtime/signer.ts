import {
    JsonRpcProvider,
    Provider,
    TransactionRequest,
} from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';
import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';

class senderAccount {
    mnemonicIndex: number;
    nonce: number;
    wallet: Wallet;

    constructor(mnemonicIndex: number, nonce: number, wallet: Wallet) {
        this.mnemonicIndex = mnemonicIndex;
        this.nonce = nonce;
        this.wallet = wallet;
    }

    incrNonce() {
        this.nonce++;
    }

    getNonce() {
        return this.nonce;
    }

    getAddress() {
        return this.wallet.address;
    }
}

class Signer {
    mnemonic: string;
    provider: Provider;

    constructor(mnemonic: string, url: string) {
        this.mnemonic = mnemonic;
        this.provider = new JsonRpcProvider(url);
    }

    async getSenderAccounts(
        accountIndexes: number[],
        numTxs: number
    ): Promise<senderAccount[]> {
        Logger.info('\nGathering initial account nonces...');

        // Maps the account index -> starting nonce
        const walletsToInit: number =
            accountIndexes.length > numTxs ? numTxs : accountIndexes.length;

        const nonceBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Gathering nonces [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} accounts',
        });

        nonceBar.start(walletsToInit, 0, {
            speed: 'N/A',
        });

        // Create wallets first (fast, sync operation)
        const wallets = accountIndexes.slice(0, walletsToInit).map(accIndex => ({
            accIndex,
            wallet: Wallet.fromMnemonic(
                this.mnemonic,
                `m/44'/60'/0'/0/${accIndex}`
            ).connect(this.provider)
        }));

        // Fetch nonces in controlled batches to avoid overwhelming RPC
        let batchSize = 50; // Process 50 accounts at a time
        
        const walletData: { accIndex: number; wallet: any; accountNonce: number }[] = [];
        
        for (let i = 0; i < wallets.length; i += batchSize) {
            const batch = wallets.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async ({ accIndex, wallet }) => {
                try {
                    const accountNonce = await wallet.getTransactionCount();
                    nonceBar.increment();
                    return { accIndex, wallet, accountNonce };
                } catch (error: any) {
                    Logger.warn(`Failed to get nonce for account ${accIndex}: ${error.message}`);
                    nonceBar.increment();
                    // Return with nonce 0 as fallback
                    return { accIndex, wallet, accountNonce: 0 };
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            walletData.push(...batchResults);
            
            // Small delay between batches to reduce RPC pressure
            if (i + batchSize < wallets.length) {
                await new Promise(resolve => setTimeout(resolve, 10)); // 100ms delay
            }
        }

        // Create sender accounts - filter out any invalid entries
        const accounts: senderAccount[] = walletData
            .filter(({ wallet }) => wallet !== undefined && wallet !== null)
            .map(({ accIndex, wallet, accountNonce }) =>
                new senderAccount(accIndex, accountNonce, wallet)
            );

        nonceBar.stop();

        // Validate the created accounts
        if (accounts.length === 0) {
            Logger.error('Failed to create any valid sender accounts');
            throw new Error('No valid accounts could be created. Check network connectivity and mnemonic.');
        }

        if (accounts.length < walletData.length) {
            Logger.warn(`Created ${accounts.length}/${walletData.length} valid accounts`);
        }

        Logger.success(`Gathered initial nonce data for ${accounts.length} accounts\n`);

        return accounts;
    }

    async signTransactions_old(
        accounts: senderAccount[],
        transactions: TransactionRequest[]
    ): Promise<string[]> {
        const failedTxnSignErrors: Error[] = [];

        const signBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Signing transactions [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
        });

        Logger.info('\nSigning transactions...');
        signBar.start(transactions.length, 0, {
            speed: 'N/A',
        });

        const signedTxs: string[] = [];
        let txMap: { [key: string]: number } = {};

        for (let i = 0; i < transactions.length; i++) {
            const sender = accounts[i % accounts.length];

            try {
                // Minimal, non-intrusive logging to correlate potential nonce errors during send
                const txNonce = (transactions[i] as any).nonce;
                let key = sender.getAddress() + txNonce.toString();
                if (txMap[key] == undefined) {
                    txMap[key] = txNonce;
                } else {
                    Logger.error(`resend tx for account ${sender.getAddress()}: ${txMap[key]} != ${txNonce}`);
                }
                signedTxs.push(
                    await sender.wallet.signTransaction(transactions[i])
                );
            } catch (e: any) {
                failedTxnSignErrors.push(e);
            }

            signBar.increment();
        }

        signBar.stop();
        Logger.success(`Successfully signed ${signedTxs.length} transactions`);

        if (failedTxnSignErrors.length > 0) {
            Logger.warn('Errors encountered during transaction signing:');

            for (const err of failedTxnSignErrors) {
                Logger.error(err.message);
            }
        }

        return signedTxs;
    }

    /**
     * True multi-threaded version using Worker Threads - utilizes multiple CPU cores
     * @param accounts Array of sender accounts
     * @param transactions Array of transactions to sign
     * @param numWorkers Number of worker threads (default: CPU cores)
     * @returns Array of signed transaction strings
     */
    async signTransactionsMultiThreaded(
        accounts: senderAccount[],
        transactions: TransactionRequest[],
        numWorkers?: number
    ): Promise<string[]> {
        const cpuCores = os.cpus().length;
        const workerCount = numWorkers || Math.max(1, Math.min(cpuCores, transactions.length));
        
        Logger.info(`\nSigning transactions using ${workerCount} CPU cores...`);
        
        const signBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Multi-threaded signing [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
        });

        signBar.start(transactions.length, 0, {
            speed: 'N/A',
        });

        // Check for duplicate nonces before signing to prevent underpriced errors
        // this.checkForDuplicateNonces(accounts, transactions);

        // Split transactions among workers - keep it simple like signTransactions_old
        const batchSize = Math.ceil(transactions.length / workerCount);
        const workerBatches = [];
        
        for (let i = 0; i < workerCount; i++) {
            const start = i * batchSize;
            const end = Math.min(start + batchSize, transactions.length);
            if (start < transactions.length) {
                // Use JSON serialization to maintain structure while making it transferable
                const batchTransactions = JSON.parse(JSON.stringify(transactions.slice(start, end)));
                
                const batchAccountIndexes = [];
                
                // Only pass serializable data - account indexes
                for (let j = start; j < end; j++) {
                    batchAccountIndexes.push(accounts[j % accounts.length].mnemonicIndex);
                }
                
                workerBatches.push({
                    transactions: batchTransactions,
                    accountIndexes: batchAccountIndexes,
                    startIndex: start  // 传递起始索引以保持顺序
                });
            }
        }

        // Create and run workers
        const workerPromises = workerBatches.map((batch, workerIndex) => {
            return new Promise((resolve, reject) => {
                const workerPath = path.join(__dirname, 'signing-worker.js');
                const worker = new Worker(workerPath);
                
                worker.on('message', (data) => {
                    if (data.type === 'progress') {
                        // Handle incremental progress updates from worker
                        signBar.increment(data.increment);
                    } else if (data.success) {
                        // Final result - all transactions signed
                        resolve(data.signedTxs);
                        worker.terminate();
                    } else {
                        reject(new Error(`Worker ${workerIndex} failed: ${data.error}`));
                        worker.terminate();
                    }
                });

                worker.on('error', (error) => {
                    reject(error);
                    worker.terminate();
                });

                // Send work to worker - only serializable data
                worker.postMessage({
                    transactions: batch.transactions,
                    accountIndexes: batch.accountIndexes,
                    startIndex: batch.startIndex,
                    mnemonicSeed: this.mnemonic,
                    hdPath: "m/44'/60'/0'/0"
                });
            });
        });

        try {
            // Wait for all workers to complete
            const results = await Promise.all(workerPromises) as any[][];
            
            // Flatten and sort results by original index to maintain transaction order
            const allSignedTxsWithIndex = results.flat();
            allSignedTxsWithIndex.sort((a: any, b: any) => a.originalIndex - b.originalIndex);
            
            // Extract only the signed transaction strings in correct order
            const allSignedTxs = allSignedTxsWithIndex.map((item: any) => item.signedTx);
            
            signBar.stop();
            
            Logger.success(`Successfully signed ${allSignedTxs.length}/${transactions.length} transactions using ${workerCount} CPU cores`);
            Logger.info('✅ Transaction order preserved - nonces will be sent in correct sequence');
            
            return allSignedTxs;
            
        } catch (error: any) {
            signBar.stop();
            Logger.error(`Multi-threaded signing failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Check for duplicate nonces across transactions to identify potential underpriced errors
     * @param accounts Array of sender accounts
     * @param transactions Array of transactions to check
     */
    private checkForDuplicateNonces(
        accounts: senderAccount[],
        transactions: TransactionRequest[]
    ): void {
        Logger.info('🔍 Checking for duplicate nonces...');
        
        const nonceMap: Map<string, number[]> = new Map();
        let duplicateCount = 0;
        
        // Group transactions by account address and their nonces
        for (let i = 0; i < transactions.length; i++) {
            const sender = accounts[i % accounts.length];
            const address = sender.getAddress();
            const nonce = transactions[i].nonce;
            
            if (nonce !== undefined) {
                const key = `${address}:${nonce}`;
                if (!nonceMap.has(key)) {
                    nonceMap.set(key, []);
                }
                nonceMap.get(key)!.push(i);
            }
        }
        
        // Check for duplicates
        const accountSummary: Map<string, { total: number, duplicates: number, nonceRange: string }> = new Map();
        
        for (const [key, transactionIndexes] of nonceMap.entries()) {
            const [address, nonceStr] = key.split(':');
            const nonce = parseInt(nonceStr);
            
            if (!accountSummary.has(address)) {
                accountSummary.set(address, { total: 0, duplicates: 0, nonceRange: '' });
            }
            
            const summary = accountSummary.get(address)!;
            summary.total += transactionIndexes.length;
            
            if (transactionIndexes.length > 1) {
                summary.duplicates += transactionIndexes.length - 1;
                duplicateCount += transactionIndexes.length - 1;
                Logger.warn(`⚠️  Duplicate nonce ${nonce} for account ${address.slice(0, 8)}... (${transactionIndexes.length} transactions)`);
            }
        }
        
        // Display summary
        Logger.info(`📊 Nonce Analysis Summary:`);
        Logger.info(`   Total accounts: ${accountSummary.size}`);
        Logger.info(`   Total transactions: ${transactions.length}`);
        Logger.info(`   Duplicate nonce conflicts: ${duplicateCount}`);
        
        if (duplicateCount > 0) {
            Logger.warn(`⚠️  Found ${duplicateCount} nonce conflicts that may cause "replacement transaction underpriced" errors!`);
            
            // Show details for each account with conflicts
            for (const [address, summary] of accountSummary.entries()) {
                if (summary.duplicates > 0) {
                    Logger.warn(`   ${address.slice(0, 8)}...: ${summary.total} txs, ${summary.duplicates} conflicts`);
                }
            }
        } else {
            Logger.success(`✅ No duplicate nonces found - all transactions should process correctly!`);
        }
        
        Logger.info(''); // Empty line for spacing
    }
}

export { Signer, senderAccount };
