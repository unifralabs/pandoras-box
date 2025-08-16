import { BigNumber } from '@ethersproject/bignumber';
import {
    JsonRpcProvider,
    Provider,
    TransactionRequest,
} from '@ethersproject/providers';
import { parseUnits } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';
import { senderAccount } from './signer';

class EOARuntime {
    mnemonic: string;
    url: string;
    provider: Provider;

    gasEstimation: BigNumber = BigNumber.from(0);
    gasPrice: BigNumber = BigNumber.from(0);

    defaultValue: BigNumber = BigNumber.from(1);
    fixedGasPrice: BigNumber | null;

    constructor(mnemonic: string, url: string, fixedGasPrice: BigNumber | null = null) {
        this.mnemonic = mnemonic;
        this.provider = new JsonRpcProvider(url);
        this.url = url;
        this.fixedGasPrice = fixedGasPrice;
    }

    async EstimateBaseTx(): Promise<BigNumber> {
        // EOA to EOA transfers are simple value transfers between accounts
        this.gasEstimation = await this.provider.estimateGas({
            from: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/0`)
                .address,
            to: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/1`).address,
            value: this.defaultValue,
        });

        return this.gasEstimation;
    }

    GetValue(): BigNumber {
        return this.defaultValue;
    }

    async GetGasPrice(): Promise<BigNumber> {
        if (this.fixedGasPrice) {
            this.gasPrice = this.fixedGasPrice;
            return this.gasPrice;
        }
        const currentGasPrice = await this.provider.getGasPrice();
        this.gasPrice = currentGasPrice.mul(4);
        return this.gasPrice;
    }

    async ConstructTransactions(
        accounts: senderAccount[],
        numTx: number
    ): Promise<TransactionRequest[][]> {
        // Validate accounts array
        if (!accounts || accounts.length === 0) {
            throw new Error('No accounts available for transaction construction. Please check fund distribution.');
        }

        // Check for undefined accounts
        const validAccounts = accounts.filter(acc => acc !== undefined && acc !== null);
        if (validAccounts.length !== accounts.length) {
            Logger.warn(`Found ${accounts.length - validAccounts.length} invalid accounts. Using ${validAccounts.length} valid accounts.`);
        }

        if (validAccounts.length === 0) {
            throw new Error('All accounts are invalid. Cannot construct transactions.');
        }

        Logger.info(`Using ${validAccounts.length} funded accounts for ${numTx} transactions`);

        const queryWallet = Wallet.fromMnemonic(
            this.mnemonic,
            `m/44'/60'/0'/0/0`
        ).connect(this.provider);

        const chainID = await queryWallet.getChainId();
        const gasPrice = this.gasPrice;

        Logger.info(`Chain ID: ${chainID}`);
        Logger.info(`Avg. gas price: ${gasPrice.toHexString()}`);

        const constructBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Constructing transactions [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
        });

        Logger.info('\nConstructing value transfer transactions...');
        constructBar.start(numTx, 0, {
            speed: 'N/A',
        });

        const transactions: TransactionRequest[][] = Array.from({ length: validAccounts.length }, () => []);

        for (let i = 0; i < numTx; i++) {
            const senderIndex = i % validAccounts.length;
            const receiverIndex = (i + 1) % validAccounts.length;
            const sender = validAccounts[senderIndex];
            const receiver = validAccounts[receiverIndex];

            // Additional safety check
            if (!sender || !receiver) {
                Logger.error(`Invalid account at transaction ${i}: sender=${!!sender}, receiver=${!!receiver}`);
                throw new Error(`Invalid accounts at transaction index ${i}`);
            }

            transactions[senderIndex].push({
                from: sender.getAddress(),
                chainId: chainID,
                to: receiver.getAddress(),
                gasPrice: gasPrice,
                gasLimit: this.gasEstimation,
                value: this.defaultValue,
                nonce: sender.getNonce(),
            });

            sender.incrNonce();
            constructBar.increment();
        }

        constructBar.stop();
        Logger.success(`Successfully constructed ${numTx} transactions`);

        return transactions;
    }

    GetStartMessage(): string {
        return '\n⚡️ EOA to EOA transfers initialized ️⚡️\n';
    }
}

export default EOARuntime;
