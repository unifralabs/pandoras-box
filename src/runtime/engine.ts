import { TransactionRequest } from '@ethersproject/providers';
import Logger from '../logger/logger';
import Batcher from './batcher';
import { Runtime } from './runtimes';
import { senderAccount, Signer } from './signer';

class EngineContext {
    accountIndexes: number[];
    numTxs: number;
    batchSize: number;

    mnemonic: string;
    url: string;
    concurrency?: number;

    constructor(
        accountIndexes: number[],
        numTxs: number,
        batchSize: number,
        mnemonic: string,
        url: string,
        concurrency?: number
    ) {
        this.accountIndexes = accountIndexes;
        this.numTxs = numTxs;
        this.batchSize = batchSize;

        this.mnemonic = mnemonic;
        this.url = url;
        this.concurrency = concurrency ? Number.parseInt(concurrency as any, 10) : undefined;
    }
}

class Engine {
    static async Run(runtime: Runtime, ctx: EngineContext): Promise<string[]> {
        // Validate input parameters
        if (!ctx.accountIndexes || ctx.accountIndexes.length === 0) {
            Logger.error('No account indexes provided. Fund distribution may have failed.');
            throw new Error('No funded accounts available. Please check the fund distribution process.');
        }

        Logger.info(`Starting with ${ctx.accountIndexes.length} funded accounts for ${ctx.numTxs} transactions`);
        Logger.info(`Account indexes: [${ctx.accountIndexes.slice(0, 5).join(', ')}${ctx.accountIndexes.length > 5 ? '...' : ''}]`);

        // Initialize transaction signer
        const signer: Signer = new Signer(ctx.mnemonic, ctx.url);

        // Get the account metadata
        const accounts: senderAccount[] = await signer.getSenderAccounts(
            ctx.accountIndexes,
            ctx.numTxs
        );

        // Construct the transactions
        const rawTransactions: TransactionRequest[][] =
            await runtime.ConstructTransactions(accounts, ctx.numTxs);

        // Sign the transactions (using multi-threaded version for better CPU utilization)
        const signedTransactions = await signer.signTransactionsMultiThreaded(
            accounts,
            rawTransactions
        );

        Logger.title(runtime.GetStartMessage());

        // Send the transactions in batches
        return Batcher.batchTransactions(
            signedTransactions,
            ctx.batchSize,
            ctx.url,
            ctx.concurrency
        );
    }
}

export { Engine, EngineContext };
