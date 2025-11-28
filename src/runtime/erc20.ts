import { BigNumber } from '@ethersproject/bignumber';
import { Contract, ContractFactory } from '@ethersproject/contracts';
import {
    JsonRpcProvider,
    Provider,
    TransactionRequest,
} from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import ZexCoin from '../contracts/ZexCoinERC20.json';
import Logger from '../logger/logger';
import RuntimeErrors from './errors';
import { senderAccount } from './signer';

class ERC20Runtime {
    mnemonic: string;
    url: string;
    provider: Provider;

    gasEstimation: BigNumber = BigNumber.from(0);
    gasPrice: BigNumber = BigNumber.from(0);
    maxFeePerGas: BigNumber = BigNumber.from(0);
    maxPriorityFeePerGas: BigNumber = BigNumber.from(0);

    defaultValue: BigNumber = BigNumber.from(0);
    defaultTransferValue = 1;

    totalSupply = 500000000000;
    coinName = 'Zex Coin';
    coinSymbol = 'ZEX';

    contract: Contract | undefined;
    fixedGasPrice: BigNumber | null;
    gasPriceMultiplier: number;

    baseDeployer: Wallet;

    constructor(mnemonic: string, url: string, fixedGasPrice: BigNumber | null = null, gasPriceMultiplier: number = 2) {
        this.mnemonic = mnemonic;
        this.provider = new JsonRpcProvider(url);
        this.url = url;
        this.fixedGasPrice = fixedGasPrice;
        this.gasPriceMultiplier = gasPriceMultiplier;

        this.baseDeployer = Wallet.fromMnemonic(
            this.mnemonic,
            `m/44'/60'/0'/0/0`
        ).connect(this.provider);
    }

    async Initialize() {
        // Initialize it
        this.contract = await this.deployERC20();
    }

    async deployERC20(): Promise<Contract> {
        const contractFactory = new ContractFactory(
            ZexCoin.abi,
            ZexCoin.bytecode,
            this.baseDeployer
        );

        const deployOptions: any = {};
        if (this.fixedGasPrice) {
            deployOptions.gasPrice = this.fixedGasPrice;
        }

        const contract = await contractFactory.deploy(
            this.totalSupply,
            this.coinName,
            this.coinSymbol,
            deployOptions
        );

        await contract.deployTransaction.wait();

        return contract;
    }

    async EstimateBaseTx(): Promise<BigNumber> {
        if (!this.contract) {
            throw RuntimeErrors.errRuntimeNotInitialized;
        }

        // Estimate a simple transfer transaction
        this.gasEstimation = await this.contract.estimateGas.transfer(
            Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/1`).address,
            this.defaultTransferValue
        );

        return this.gasEstimation;
    }

    GetTransferValue(): number {
        return this.defaultTransferValue;
    }

    async GetTokenBalance(address: string): Promise<number> {
        if (!this.contract) {
            throw RuntimeErrors.errRuntimeNotInitialized;
        }

        return await this.contract.balanceOf(address);
    }

    async GetSupplierBalance(): Promise<number> {
        return this.GetTokenBalance(this.baseDeployer.address);
    }

    async FundAccount(to: string, amount: number): Promise<void> {
        if (!this.contract) {
            throw RuntimeErrors.errRuntimeNotInitialized;
        }

        const tx = await this.contract.transfer(to, amount);

        // Wait for the transfer transaction to be mined
        await tx.wait();
    }

    GetTokenSymbol(): string {
        return this.coinSymbol;
    }

    GetValue(): BigNumber {
        return this.defaultValue;
    }

    async GetGasPrice(): Promise<BigNumber> {
        if (this.fixedGasPrice) {
            this.gasPrice = this.fixedGasPrice;
            return this.gasPrice;
        }

        const feeData = await this.provider.getFeeData();
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            // Apply multiplier to ensure transactions get mined
            const multiplierInt = Math.floor(this.gasPriceMultiplier * 10);
            this.maxFeePerGas = feeData.maxFeePerGas.mul(multiplierInt).div(10);
            this.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(multiplierInt).div(10);
            // Fallback for legacy compatibility if needed, though we prefer EIP1559
            this.gasPrice = feeData.gasPrice ?? BigNumber.from(0);
        } else {
            // Fallback to legacy gas price if EIP1559 data is missing
            const currentGasPrice = await this.provider.getGasPrice();
            const multiplierInt = Math.floor(this.gasPriceMultiplier * 10);
            this.gasPrice = currentGasPrice.mul(multiplierInt).div(10);
        }

        return this.gasPrice;
    }

    async ConstructTransactions(
        accounts: senderAccount[],
        numTx: number
    ): Promise<TransactionRequest[][]> {
        if (!this.contract) {
            throw RuntimeErrors.errRuntimeNotInitialized;
        }

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

        const chainID = await this.baseDeployer.getChainId();
        // Ensure we have the latest gas price/fee data
        await this.GetGasPrice();
        const gasPrice = this.gasPrice;
        const latestBlock = await this.provider.getBlock('latest');

        Logger.info(`Chain ID: ${chainID}`);
        if (latestBlock.baseFeePerGas) {
            Logger.info(`Base Fee: ${latestBlock.baseFeePerGas.toString()} (${latestBlock.baseFeePerGas.div(1e9).toString()} Gwei)`);
        }

        if (this.maxFeePerGas.gt(0)) {
            Logger.info(`Using EIP-1559 Transactions`);
            Logger.info(`Max Fee Per Gas: ${this.maxFeePerGas.toString()} (${this.maxFeePerGas.div(1e9).toString()} Gwei)`);
            Logger.info(`Max Priority Fee Per Gas: ${this.maxPriorityFeePerGas.toString()} (${this.maxPriorityFeePerGas.div(1e9).toString()} Gwei)`);

            if (latestBlock.baseFeePerGas) {
                const baseFee = latestBlock.baseFeePerGas;
                // effectiveGasPrice = min(maxFee, baseFee + maxPriority)
                let effectiveGasPrice = baseFee.add(this.maxPriorityFeePerGas);
                if (effectiveGasPrice.gt(this.maxFeePerGas)) {
                    effectiveGasPrice = this.maxFeePerGas;
                }
                Logger.info(`Estimated Effective Gas Price: ${effectiveGasPrice.toString()} (${effectiveGasPrice.div(1e9).toString()} Gwei)`);
            }
        } else {
            Logger.info(`Using Legacy Transactions`);
            Logger.info(`Avg. gas price: ${gasPrice.toString()} (${gasPrice.div(1e9).toString()} Gwei)`);
        }

        const constructBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Constructing ERC20 transactions [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
        });

        Logger.info(`\nConstructing ${this.coinName} transfer transactions...`);
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

            const transaction = await this.contract.populateTransaction.transfer(
                receiver.getAddress(),
                this.defaultTransferValue
            );

            // Override the defaults
            transaction.from = sender.getAddress();
            transaction.chainId = chainID;

            if (this.maxFeePerGas.gt(0)) {
                transaction.type = 2;
                transaction.maxFeePerGas = this.maxFeePerGas;
                transaction.maxPriorityFeePerGas = this.maxPriorityFeePerGas;
            } else {
                transaction.gasPrice = gasPrice;
            }

            transaction.gasLimit = this.gasEstimation;
            transaction.nonce = sender.getNonce();

            transactions[senderIndex].push(transaction);

            sender.incrNonce();
            constructBar.increment();
        }

        constructBar.stop();
        Logger.success(`Successfully constructed ${numTx} transactions`);

        return transactions;
    }

    GetStartMessage(): string {
        return '\n⚡️ ERC20 token transfers initialized ️⚡️\n';
    }
}

export default ERC20Runtime;
