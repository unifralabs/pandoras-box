
import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import * as readline from 'readline';
import { SingleBar } from 'cli-progress';
import Table from 'cli-table3';
import Logger from '../logger/logger';

class ClearPendingRuntime {
    private provider: JsonRpcProvider;
    private mnemonic: string;
    private numAccounts: number;
    private concurrency: number;
    private autoConfirm: boolean;

    constructor(
        url: string,
        mnemonic: string,
        numAccounts: number,
        concurrency: number,
        autoConfirm: boolean
    ) {
        this.provider = new JsonRpcProvider(url);
        this.mnemonic = mnemonic;
        this.numAccounts = numAccounts;
        this.concurrency = concurrency || 50;
        this.autoConfirm = autoConfirm;
    }

    public async run() {
        Logger.info(`Checking ${this.numAccounts} accounts for pending transactions with a concurrency of ${this.concurrency}...`);
        const accountsToClear: { wallet: Wallet; nonce: number; address: string; accountIndex: number }[] = [];

        const checkBar = new SingleBar({
            format: 'Checking Accounts [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });
        checkBar.start(this.numAccounts, 0);

        for (let i = 0; i < this.numAccounts; i += this.concurrency) {
            const batchPromises: Promise<any>[] = [];
            const batchEnd = Math.min(i + this.concurrency, this.numAccounts);
            
            for (let j = i; j < batchEnd; j++) {
                const checkPromise = (async (accountIndex) => {
                    const wallet = Wallet.fromMnemonic(
                        this.mnemonic,
                        `m/44'/60'/0'/0/${accountIndex}`
                    ).connect(this.provider);

                    try {
                        const pendingNonce = await wallet.getTransactionCount('pending');
                        const latestNonce = await wallet.getTransactionCount('latest');

                        if (pendingNonce > latestNonce) {
                            return {
                                wallet,
                                nonce: latestNonce,
                                address: wallet.address,
                                accountIndex: accountIndex,
                            };
                        }
                    } catch (error: any) {
                        Logger.error(`\nError checking account ${accountIndex}: ${error.message}`);
                    } finally {
                        checkBar.increment();
                    }
                    return null;
                })(j);
                batchPromises.push(checkPromise);
            }

            const batchResults = await Promise.all(batchPromises);
            
            for (const result of batchResults) {
                if (result) {
                    accountsToClear.push(result);
                }
            }
        }
        checkBar.stop();

        if (accountsToClear.length === 0) {
            Logger.success('\n✅ No accounts with pending transactions found.');
            return;
        }

        Logger.info(`\nFound ${accountsToClear.length} accounts with pending transactions:`);

        const table = new Table({
            head: ['Index', 'Address', 'Nonce to Clear'],
            colWidths: [10, 70, 20],
        });

        for (const acc of accountsToClear) {
            table.push([acc.accountIndex, acc.address, acc.nonce]);
        }
        console.log(table.toString());

        if (!this.autoConfirm) {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const answer = await new Promise<string>(resolve => {
                rl.question('\nDo you want to proceed with sending clearing transactions for all accounts listed above? (y/n): ', resolve);
            });
            rl.close();

            if (answer.toLowerCase() !== 'y') {
                Logger.warn('Transaction cancelled by user.');
                return;
            }
        }

        Logger.info('\nSending clearing transactions...');
        const sendBar = new SingleBar({
            format: 'Sending Txs [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });
        sendBar.start(accountsToClear.length, 0);

        const feeData = await this.provider.getFeeData();
        const gasPrice = (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) ? null : await this.provider.getGasPrice();

        for (let i = 0; i < accountsToClear.length; i += this.concurrency) {
            const batchPromises: Promise<void>[] = [];
            const batchEnd = Math.min(i + this.concurrency, accountsToClear.length);
            
            for (let j = i; j < batchEnd; j++) {
                const account = accountsToClear[j];
                const sendPromise = (async () => {
                    try {
                        let tx: any;
                        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                            const boostedMaxPriorityFeePerGas = feeData.maxFeePerGas.mul(120).div(100);
                            const boostedMaxFeePerGas = feeData.maxFeePerGas.mul(120).div(100);
                            tx = {
                                to: account.address,
                                value: 0,
                                nonce: account.nonce,
                                gasLimit: 21000,
                                maxFeePerGas: boostedMaxFeePerGas,
                                maxPriorityFeePerGas: boostedMaxPriorityFeePerGas,
                            };
                        } else if (gasPrice) {
                            const boostedGasPrice = gasPrice.mul(2);
                            tx = {
                                to: account.address,
                                value: 0,
                                nonce: account.nonce,
                                gasPrice: boostedGasPrice,
                                gasLimit: 21000,
                            };
                        } else {
                            throw new Error('Could not determine gas fees for transaction.');
                        }

                        const txResponse = await account.wallet.sendTransaction(tx);
                        await txResponse.wait(1);
                    } catch (error: any) {
                        Logger.error(`\nFailed to clear transaction for account ${account.accountIndex} (${account.address}): ${error.message}`);
                    } finally {
                        sendBar.increment();
                    }
                })();
                batchPromises.push(sendPromise);
            }
            await Promise.all(batchPromises);
        }
        sendBar.stop();

        Logger.success('\n✅ All clearing transactions have been processed.');
    }
}

export default ClearPendingRuntime;
