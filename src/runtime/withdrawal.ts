import { BigNumber } from '@ethersproject/bignumber';
import {
    JsonRpcProvider,
    Provider,
    TransactionRequest,
} from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { Interface } from '@ethersproject/abi'; // 新增导入 Interface
import { SingleBar } from 'cli-progress';
import Logger from '../logger/logger';
import { senderAccount } from './signer';
import { parseUnits } from '@ethersproject/units';
import bs58check from 'bs58check';
import { startCrossChainListeners } from '../tools/crossChainListeners';
import MoatABI from '../abi/moat';

class WithdrawalRuntime {
    mnemonic: string;
    url: string;
    provider: Provider;

    gasEstimation: BigNumber = BigNumber.from(0);
    gasPrice: BigNumber = BigNumber.from(0);

    defaultValue: BigNumber = BigNumber.from(110000000);
    fixedGasPrice: BigNumber | null;
    moatContractAddress: string;
    targetAddress: string;
    zmqEndpoint: string;

    constructor(
        mnemonic: string,
        url: string,
        moatContractAddress: string,
        targetAddress: string,
        fixedGasPrice: BigNumber | null = null,
        zmqEndpoint: string
    ) {
        this.mnemonic = mnemonic;
        this.provider = new JsonRpcProvider(url);
        this.url = url;
        this.moatContractAddress = moatContractAddress;
        this.targetAddress = targetAddress;
        this.fixedGasPrice = fixedGasPrice;
        this.zmqEndpoint = zmqEndpoint;
    }

    private static listenerStarted = false;

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
        // 返回 2 ETH
        return parseUnits('2', 'ether');
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

        const moatInterface = new Interface(MoatABI);

        // Decode base58 address to 20-byte hex (skip version byte)
        let targetHex: string;
        try {
            const decoded = bs58check.decode(this.targetAddress);
            targetHex = '0x' + Buffer.from(decoded.subarray(1)).toString('hex');
            Logger.info(`Decoded target address ${this.targetAddress} to ${targetHex}`);

        } catch (err) {
            Logger.error(`Failed to decode target address ${this.targetAddress}: ${err}`);
            throw err;
        }

        // Estimate gas for withdrawToL1 once (using first valid account)
        const sampleGas = await this.provider.estimateGas({
            from: validAccounts[0].getAddress(),
            to: this.moatContractAddress,
            value: this.GetValue(),
            data: moatInterface.encodeFunctionData('withdrawToL1', [targetHex]),
        });
        this.gasEstimation = sampleGas.mul(2); // add safety margin

        const constructBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Constructing transactions [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
        });

        Logger.info('\nConstructing withdrawToL1 transactions...');
        constructBar.start(numTx, 0, {
            speed: 'N/A',
        });

        const transactions: TransactionRequest[][] = Array.from({ length: validAccounts.length }, () => []);

        for (let i = 0; i < numTx; i++) {
            const senderIndex = i % validAccounts.length;
            const sender = validAccounts[senderIndex];

            // Additional safety check
            if (!sender) {
                Logger.error(`Invalid sender at transaction ${i}`);
                throw new Error(`Invalid sender at transaction index ${i}`);
            }

            transactions[senderIndex].push({
                from: sender.getAddress(),
                chainId: chainID,
                to: this.moatContractAddress,
                gasPrice: gasPrice,
                gasLimit: this.gasEstimation,
                value: this.defaultValue.add(BigNumber.from(senderIndex * 1e5 + i)).mul(1e10),
                data: moatInterface.encodeFunctionData('withdrawToL1', [targetHex]),
                nonce: sender.getNonce(),
            });

            sender.incrNonce();
            constructBar.increment();
        }

        constructBar.stop();
        Logger.success(`Successfully constructed ${numTx} transactions`);
        if (!WithdrawalRuntime.listenerStarted) {
            try {
                const decoded = bs58check.decode(this.targetAddress);
                const hash20 = Buffer.from(decoded.subarray(1)).toString('hex');
                startCrossChainListeners({
                    l1TargetHash: hash20,
                    zmqEndpoint: this.zmqEndpoint,
                    l2Rpc: this.url,
                    moatAddress: this.moatContractAddress,
                    transactions: transactions.flat() as [TransactionRequest],
                });

                WithdrawalRuntime.listenerStarted = true;
            } catch (err) {
                Logger.error(`Failed to decode target address ${this.targetAddress}: ${err}`);
            }
        }
        return transactions;
    }

    GetStartMessage(): string {
        return '\n⚡️ withdrawal transfers initialized ️⚡️\n';
    }
}

export default WithdrawalRuntime;
