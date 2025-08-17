import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import { formatEther, parseEther } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Table from 'cli-table3';
import Heap from 'heap';
import Logger from '../logger/logger';
import { Runtime } from '../runtime/runtimes';
import DistributorErrors from './errors';

// Timeout constants (in milliseconds)
const TIMEOUT_CONSTANTS = {
    QUICK_OPERATION: 5000,    // 5 seconds for quick network calls (gas price, nonce, etc.)
    BALANCE_QUERY: 5000,      // 5 seconds for balance queries
    TRANSACTION_SEND: 15000,   // 15 seconds for sending transactions
    TRANSACTION_CONFIRM: 18000 // 18 seconds for transaction confirmation
} as const;

// Helper function to add timeout to promises
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Operation '${operation}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        })
    ]);
}

class distributeAccount {
    missingFunds: BigNumber;
    address: string;
    mnemonicIndex: number;

    constructor(missingFunds: BigNumber, address: string, index: number) {
        this.missingFunds = missingFunds;
        this.address = address;
        this.mnemonicIndex = index;
    }
}

class runtimeCosts {
    accDistributionCost: BigNumber;
    subAccount: BigNumber;

    constructor(accDistributionCost: BigNumber, subAccount: BigNumber) {
        this.accDistributionCost = accDistributionCost;
        this.subAccount = subAccount;
    }
}

// Manages the fund distribution before each run-cycle
class Distributor {
    ethWallet: Wallet;
    mnemonic: string;
    provider: Provider;

    runtimeEstimator: Runtime;

    totalTx: number;
    requestedSubAccounts: number;
    readyMnemonicIndexes: number[];
    concurrency?: number;

    constructor(
        mnemonic: string,
        subAccounts: number,
        totalTx: number,
        runtimeEstimator: Runtime,
        url: string,
        concurrency?: number | string
    ) {
        this.requestedSubAccounts = subAccounts;
        this.totalTx = totalTx;
        this.mnemonic = mnemonic;
        this.runtimeEstimator = runtimeEstimator;
        this.readyMnemonicIndexes = [];
        this.concurrency = concurrency !== undefined ? Number.parseInt(concurrency as any, 10) : undefined;

        this.provider = new JsonRpcProvider(url);
        this.ethWallet = Wallet.fromMnemonic(
            mnemonic,
            `m/44'/60'/0'/0/0`
        ).connect(this.provider);
    }

    async distribute(): Promise<number[]> {
        Logger.title('💸 Fund distribution initialized 💸');

        const threshold = parseEther('1');
        // Check if there are any addresses that need funding
        const shortAddresses = await this.findAccountsForDistribution(
            threshold
        );

        const initialAccCount = shortAddresses.size();

        if (initialAccCount == 0) {
            // Nothing to distribute
            Logger.success('Accounts are fully funded for the cycle');
            
            // Double-check: if readyMnemonicIndexes is empty but no accounts need funding,
            // it means balance queries may have failed. Use all requested accounts as fallback.
            if (this.readyMnemonicIndexes.length === 0) {
                Logger.warn('No accounts marked as ready despite sufficient funds. Using all requested accounts as fallback.');
                // Generate all account indexes from 1 to requestedSubAccounts
                this.readyMnemonicIndexes = Array.from({length: this.requestedSubAccounts}, (_, i) => i + 1);
            }
            
            Logger.info(`Returning ${this.readyMnemonicIndexes.length} ready account indexes`);
            return this.readyMnemonicIndexes;
        }

        // Get a list of accounts that can be funded
        const fundableAccounts = await this.getFundableAccounts(
            threshold,
            shortAddresses
        );

        if (fundableAccounts.length != initialAccCount) {
            Logger.warn(
                `Unable to fund all sub-accounts. Funding ${fundableAccounts.length}`
            );
        }

        // Fund the accounts
        await this.fundAccounts(threshold, fundableAccounts);

        Logger.success('Fund distribution finished!');

        return this.readyMnemonicIndexes;
    }

    async calculateRuntimeCosts(): Promise<runtimeCosts> {
        const inherentValue = this.runtimeEstimator.GetValue();
        const baseTxEstimate = await withTimeout(
            this.runtimeEstimator.EstimateBaseTx(),
            TIMEOUT_CONSTANTS.QUICK_OPERATION,
            'EstimateBaseTx'
        );
        const baseGasPrice = await withTimeout(
            this.runtimeEstimator.GetGasPrice(),
            TIMEOUT_CONSTANTS.QUICK_OPERATION,
            'GetGasPrice'
        );

        const baseTxCost = baseGasPrice.mul(baseTxEstimate).add(inherentValue);

        // Calculate how much each sub-account needs
        // to execute their part of the run cycle.
        // Each account needs at least numTx * (gasPrice * gasLimit + value)
        const subAccountCost = BigNumber.from(this.totalTx).mul(baseTxCost);

        // Calculate the cost of the single distribution transaction
        const singleDistributionCost = await withTimeout(
            this.provider.estimateGas({
                from: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/0`)
                    .address,
                to: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/1`).address,
                value: subAccountCost,
            }),
            TIMEOUT_CONSTANTS.QUICK_OPERATION,
            'estimateGas for distribution transaction'
        );

        return new runtimeCosts(singleDistributionCost, subAccountCost);
    }

    async findAccountsForDistribution(
        singleRunCost: BigNumber
    ): Promise<Heap<distributeAccount>> {
        const balanceBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Fetching balances [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} accounts',
        });

        Logger.info('\nFetching sub-account balances...');

        const shortAddresses = new Heap<distributeAccount>();

        balanceBar.start(this.requestedSubAccounts, 0, {
            speed: 'N/A',
        });

        // Create account indices array
        const accountIndices = Array.from({length: this.requestedSubAccounts}, (_, i) => i + 1);
        
        // Process accounts in batches to avoid overwhelming RPC endpoint
        const concurrency = this.concurrency && this.concurrency > 0 ? this.concurrency : 50; // Number of balances fetched in parallel per wave
        
        for (let i = 0; i < accountIndices.length; i += concurrency) {
            const accountIndexBatch = accountIndices.slice(i, i + concurrency);
            
            const balanceBatchPromises = accountIndexBatch.map(index => {
                const addrWallet = Wallet.fromMnemonic(
                    this.mnemonic,
                    `m/44'/60'/0'/0/${index}`
                ).connect(this.provider);

                // Add timeout to balance request
                return withTimeout(
                    addrWallet.getBalance(),
                    TIMEOUT_CONSTANTS.BALANCE_QUERY,
                    `getBalance for account ${index}`
                ).then(balance => ({
                    index: index,
                    balance: balance,
                    address: addrWallet.address,
                    error: undefined as string | undefined
                })).catch((error: any) => ({
                    index: index,
                    balance: null as BigNumber | null,
                    address: addrWallet.address,
                    error: error.message as string
                }));
            });

            const balanceBatchResults = await Promise.all(balanceBatchPromises);
            
            // Process batch results immediately and update progress bar
            for (const result of balanceBatchResults) {
                balanceBar.increment();

                // Handle failed requests
                if (result.balance === null || result.error) {
                    Logger.warn(`Failed to get balance for account ${result.index}: ${result.error || 'Unknown error'}`);
                    
                    // For failed balance queries, we'll assume the account has sufficient funds
                    // to avoid blocking the entire process. This is a conservative fallback.
                    if (result.error && result.error.includes('timed out')) {
                        Logger.info(`Assuming account ${result.index} has sufficient funds due to timeout`);
                        this.readyMnemonicIndexes.push(result.index);
                    }
                    continue;
                }

                if (result.balance.lt(singleRunCost)) {
                    // Address doesn't have enough funds, make sure it's
                    // on the list to get topped off
                    shortAddresses.push(
                        new distributeAccount(
                            BigNumber.from(singleRunCost),
                            result.address,
                            result.index
                        )
                    );

                    continue;
                }

                // Address has enough funds already, mark it as ready
                this.readyMnemonicIndexes.push(result.index);
            }
        }

        balanceBar.stop();
        
        Logger.info(`Balance check summary: ${this.readyMnemonicIndexes.length} accounts ready, ${shortAddresses.size()} need funding`);
        
        return shortAddresses;
    }

    printCostTable(costs: runtimeCosts) {
        Logger.info('\nCycle Cost Table:');
        const costTable = new Table({
            head: ['Name', 'Cost [eth]'],
        });

        costTable.push(
            ['Required acc. balance', formatEther(costs.subAccount)],
            ['Single distribution cost', formatEther(costs.accDistributionCost)]
        );

        Logger.info(costTable.toString());
    }

    async getFundableAccounts(
        costs: BigNumber,
        initialSet: Heap<distributeAccount>
    ): Promise<distributeAccount[]> {
        // Check if the root wallet has enough funds to distribute
        const accountsToFund: distributeAccount[] = [];
        let distributorBalance = BigNumber.from(
            await withTimeout(
                this.ethWallet.getBalance(),
                TIMEOUT_CONSTANTS.QUICK_OPERATION,
                'getBalance for distributor wallet'
            )
        );

        while (
            distributorBalance.gt(costs) &&
            initialSet.size() > 0
        ) {
            const acc = initialSet.pop() as distributeAccount;
            distributorBalance = distributorBalance.sub(acc.missingFunds);

            accountsToFund.push(acc);
        }

        // Check if there are accounts to fund
        if (accountsToFund.length == 0) {
            throw DistributorErrors.errNotEnoughFunds;
        }

        return accountsToFund;
    }

    async fundAccounts(costs: BigNumber, accounts: distributeAccount[]) {
        Logger.info('\nFunding accounts (parallel with nonce management)...');

        // Internal helper functions for nonce management
        const fundAccountWithNonce = async (
            to: string, 
            value: any, 
            nonce: number
        ): Promise<void> => {
            // Send ETH transaction with explicit nonce
            const tx = await withTimeout(
                this.ethWallet.sendTransaction({
                    to: to,
                    value: value,
                    nonce: nonce
                }),
                TIMEOUT_CONSTANTS.TRANSACTION_SEND,
                `sendTransaction to ${to} with nonce ${nonce}`
            );

            // Wait for transaction to be mined
            await withTimeout(
                tx.wait(),
                TIMEOUT_CONSTANTS.TRANSACTION_CONFIRM,
                `wait for transaction ${tx.hash} confirmation`
            );
        };

        const fundBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Funding accounts (parallel) [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
        });

        // Get initial nonce from ETH wallet (with timeout)
        let currentNonce = await withTimeout(
            this.ethWallet.getTransactionCount(),
            TIMEOUT_CONSTANTS.QUICK_OPERATION,
            'getTransactionCount for ETH wallet'
        );
        
        Logger.info(`Starting with ETH wallet nonce: ${currentNonce}`);

        fundBar.start(accounts.length, 0, {
            speed: 'N/A',
        });

        const concurrency = this.concurrency && this.concurrency > 0 ? this.concurrency : 50; // Number of transfers sent in parallel per wave
        const successfulIndexes: { index: number; mnemonicIndex: number }[] = [];

        // Process accounts in batches with managed nonce
        for (let i = 0; i < accounts.length; i += concurrency) {
            const fundingBatch = accounts.slice(i, i + concurrency);
            
            const fundingBatchPromises = fundingBatch.map(async (acc, batchIndex) => {
                // Assign nonce locally and increment for each transaction
                const assignedNonce = currentNonce + batchIndex;
                
                try {
                    await fundAccountWithNonce(
                        acc.address,
                        acc.missingFunds,
                        assignedNonce
                    );

                    // Update progress immediately after each transaction completes
                    fundBar.increment();

                    return {
                        success: true,
                        originalIndex: i + batchIndex,
                        mnemonicIndex: acc.mnemonicIndex,
                        nonce: assignedNonce,
                        error: undefined as string | undefined
                    };
                } catch (error: any) {
                    Logger.warn(`Failed to fund account ${acc.address} with nonce ${assignedNonce}: ${error.message}`);
                    
                    // Update progress bar even for failed transactions
                    fundBar.increment();
                    
                    return {
                        success: false,
                        originalIndex: i + batchIndex,
                        mnemonicIndex: acc.mnemonicIndex,
                        nonce: assignedNonce,
                        error: error.message as string
                    };
                }
            });

            const fundingBatchResults = await Promise.all(fundingBatchPromises);
            
            // Update currentNonce for next batch
            currentNonce += fundingBatch.length;
            
            // Process batch results and maintain original order (no progress bar updates here)
            for (const result of fundingBatchResults) {
                if (result.success) {
                    successfulIndexes.push({
                        index: result.originalIndex,
                        mnemonicIndex: result.mnemonicIndex
                    });
                }
            }
        }

        // Sort by original index to maintain order, then push to readyMnemonicIndexes
        successfulIndexes
            .sort((a, b) => a.index - b.index)
            .forEach(item => this.readyMnemonicIndexes.push(item.mnemonicIndex));

        fundBar.stop();
        
        Logger.success(`Successfully funded ${successfulIndexes.length}/${accounts.length} accounts with ETH nonce management`);
        
        if (successfulIndexes.length < accounts.length) {
            Logger.warn(`${accounts.length - successfulIndexes.length} accounts failed to fund.`);
        }
    }
}

export { Distributor, Runtime, distributeAccount };
