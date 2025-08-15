import {
    JsonRpcProvider,
    Provider,
    TransactionRequest,
} from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';

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

        // Create sender accounts
        const accounts: senderAccount[] = walletData.map(({ accIndex, wallet, accountNonce }) =>
            new senderAccount(accIndex, accountNonce, wallet)
        );

        nonceBar.stop();

        Logger.success('Gathered initial nonce data\n');

        return accounts;
    }

    async signTransactions(
        accounts: senderAccount[],
        transactions: TransactionRequest[]
    ): Promise<string[]> {
        const failedTxnSignErrors: Error[] = [];

        const signBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
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
}

export { Signer, senderAccount };
