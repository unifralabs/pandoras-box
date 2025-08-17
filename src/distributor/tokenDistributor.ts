import { BigNumber } from '@ethersproject/bignumber';
import { Contract } from '@ethersproject/contracts';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Table from 'cli-table3';
import Heap from 'heap';
import Logger from '../logger/logger';
import { TokenRuntime } from '../runtime/runtimes';
import { distributeAccount } from './distributor';
import DistributorErrors from './errors';
import { parseEther } from '@ethersproject/units';

class tokenRuntimeCosts {
    totalCost: number;
    subAccount: number;

    constructor(totalCost: number, subAccount: number) {
        this.totalCost = totalCost;
        this.subAccount = subAccount;
    }
}

class TokenDistributor {
    mnemonic: string;

    tokenRuntime: TokenRuntime;

    totalTx: number;
    readyMnemonicIndexes: number[];
    concurrency?: number;

    constructor(
        mnemonic: string,
        readyMnemonicIndexes: number[],
        totalTx: number,
        tokenRuntime: TokenRuntime,
        concurrency?: number | string
    ) {
        this.totalTx = totalTx;
        this.mnemonic = mnemonic;
        this.tokenRuntime = tokenRuntime;
        this.readyMnemonicIndexes = readyMnemonicIndexes;
        this.concurrency = concurrency !== undefined ? Number.parseInt(concurrency as any, 10) : undefined;
    }

    async distributeTokens(): Promise<number[]> {
        Logger.title('\n🪙 Token distribution initialized 🪙');

        const baseCosts = await this.calculateRuntimeCosts();
        this.printCostTable(baseCosts);

        // Since a new contract is deployed every time, all accounts start with 0 tokens.
        // We can skip checking balances and assume all ready accounts need funding.
        Logger.info('Assuming all accounts need token funding for new contract (skipping balance check)...');
        const shortAddresses = new Heap<distributeAccount>();
        for (const index of this.readyMnemonicIndexes) {
            const addrWallet = Wallet.fromMnemonic(
                this.mnemonic,
                `m/44'/60'/0'/0/${index}`
            );
            shortAddresses.push(
                new distributeAccount(
                    BigNumber.from(baseCosts.subAccount),
                    addrWallet.address,
                    index
                )
            );
        }
        /*
        // Check if there are any addresses that need funding
        const shortAddresses = await this.findAccountsForDistribution(
            baseCosts.subAccount
        );
        */

        const initialAccCount = shortAddresses.size();

        if (initialAccCount === 0) {
            Logger.warn(
                'No accounts with sufficient gas fees were found to distribute tokens to.'
            );
            return [];
        }

        // Get a list of accounts that can be funded
        const fundableAccounts = await this.getFundableAccounts(
            baseCosts,
            shortAddresses
        );

        if (fundableAccounts.length != initialAccCount) {
            Logger.warn(
                `Unable to fund all sub-accounts. Funding ${fundableAccounts.length}`
            );
        }

        // Fund the accounts
        await this.fundAccountsParall(baseCosts, fundableAccounts);
        Logger.success('Fund distribution finished!');

        return this.readyMnemonicIndexes;
    }

    async calculateRuntimeCosts(): Promise<tokenRuntimeCosts> {
        const transferValue = this.tokenRuntime.GetTransferValue();

        const totalCost = transferValue * this.totalTx;
        const subAccountCost = Math.ceil(
            totalCost / this.readyMnemonicIndexes.length
        );

        return new tokenRuntimeCosts(totalCost, subAccountCost);
    }

    async findAccountsForDistribution(
        singleRunCost: number
    ): Promise<Heap<distributeAccount>> {
        const balanceBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Fetching token balances [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} accounts',
        });

        Logger.info('\nFetching sub-account token balances...');

        const shortAddresses = new Heap<distributeAccount>();

        balanceBar.start(this.readyMnemonicIndexes.length, 0, {
            speed: 'N/A',
        });

        // Process accounts in batches to avoid overwhelming RPC endpoint
        const batchSize = this.concurrency && this.concurrency > 0 ? this.concurrency : 50; // Maximum concurrent requests
        
        for (let i = 0; i < this.readyMnemonicIndexes.length; i += batchSize) {
            const batch = this.readyMnemonicIndexes.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (index) => {
                const addrWallet = Wallet.fromMnemonic(
                    this.mnemonic,
                    `m/44'/60'/0'/0/${index}`
                );

                try {
                    const balance: number = await this.tokenRuntime.GetTokenBalance(
                        addrWallet.address
                    );

                    return {
                        index: index,
                        balance: balance,
                        address: addrWallet.address,
                        error: undefined as string | undefined
                    };
                } catch (error: any) {
                    return {
                        index: index,
                        balance: null as number | null,
                        address: addrWallet.address,
                        error: error.message as string
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            
            // Process batch results immediately and update progress bar
            for (const result of batchResults) {
                balanceBar.increment();

                // Handle failed requests
                if (result.balance === null || result.error) {
                    Logger.warn(`Failed to get token balance for account ${result.index}: ${result.error || 'Unknown error'}`);
                    continue;
                }

                if (result.balance < singleRunCost) {
                    // Address doesn't have enough funds, make sure it's
                    // on the list to get topped off
                    shortAddresses.push(
                        new distributeAccount(
                            BigNumber.from(singleRunCost),
                            result.address,
                            result.index
                        )
                    );
                }
            }
        }

        balanceBar.stop();
        Logger.success('Fetched initial token balances');

        return shortAddresses;
    }

    printCostTable(costs: tokenRuntimeCosts) {
        Logger.info('\nCycle Token Cost Table:');
        const costTable = new Table({
            head: ['Name', `Cost [${this.tokenRuntime.GetTokenSymbol()}]`],
        });

        costTable.push(
            ['Required acc. token balance', costs.subAccount],
            ['Total token distribution cost', costs.totalCost]
        );

        Logger.info(costTable.toString());
    }

    async fundAccounts(
        costs: tokenRuntimeCosts,
        accounts: distributeAccount[]
    ) {
        Logger.info('\nFunding accounts with tokens...');

        // Clear the list of ready indexes
        this.readyMnemonicIndexes = [];

        const fundBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Funding token accounts [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
        });

        fundBar.start(accounts.length, 0, {
            speed: 'N/A',
        });

        for (const acc of accounts) {
            await this.tokenRuntime.FundAccount(
                acc.address,
                acc.missingFunds.toNumber()
            );

            fundBar.increment();
            this.readyMnemonicIndexes.push(acc.mnemonicIndex);
        }

        fundBar.stop();
    }

    async fundAccountsParall(
        costs: tokenRuntimeCosts,
        accounts: distributeAccount[]
    ) {
        Logger.info('\nFunding accounts with tokens (parallel with nonce management)...');

        // Internal helper functions for nonce management
        const getSupplierWallet = (): Wallet => {
            return (this.tokenRuntime as any).baseDeployer;
        };

        const getSupplierContract = (): Contract => {
            return (this.tokenRuntime as any).contract;
        };

        const fundAccountWithNonce = async (
            to: string, 
            amount: number, 
            nonce: number
        ): Promise<void> => {
            const wallet = getSupplierWallet();
            const contract = getSupplierContract();

            if (!contract) {
                throw new Error('Token runtime not initialized');
            }

            // Send transaction with explicit nonce
            const tx = await contract.connect(wallet).transfer(to, amount, {
                nonce: nonce
            });

            // Wait for transaction to be mined
            await tx.wait();
        };

        // Clear the list of ready indexes
        this.readyMnemonicIndexes = [];

        const fundBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            format: 'Funding token accounts [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} transactions',
        });

        // Get initial nonce from supplier wallet
        const supplierWallet = getSupplierWallet();
        let currentNonce = await supplierWallet.getTransactionCount();
        
        Logger.info(`Starting with supplier nonce: ${currentNonce}`);

        fundBar.start(accounts.length, 0, {
            speed: 'N/A',
        });

        const concurrency = this.concurrency && this.concurrency > 0 ? this.concurrency : 50; // Can use larger batches now that nonce is managed locally
        const successfulIndexes: { index: number; mnemonicIndex: number }[] = [];

        // Process accounts in batches with managed nonce
        for (let i = 0; i < accounts.length; i += concurrency) {
            const batch = accounts.slice(i, i + concurrency);
            
            const batchPromises = batch.map(async (acc, batchIndex) => {
                // Assign nonce locally and increment for each transaction
                const assignedNonce = currentNonce + batchIndex;
                
                try {
                    await fundAccountWithNonce(
                        acc.address,
                        acc.missingFunds.toNumber(),
                        assignedNonce
                    );

                    // Update progress bar immediately after each transaction completes
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

            const batchResults = await Promise.all(batchPromises);
            
            // Update currentNonce for next batch
            currentNonce += batch.length;
            
            // Process batch results and maintain original order (no progress bar updates here)
            for (const result of batchResults) {
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
        
        Logger.success(`Successfully funded ${successfulIndexes.length}/${accounts.length} accounts with nonce management`);
        
        if (successfulIndexes.length < accounts.length) {
            Logger.warn(`${accounts.length - successfulIndexes.length} accounts failed to fund.`);
        }
    }

    async getFundableAccounts(
        costs: tokenRuntimeCosts,
        initialSet: Heap<distributeAccount>
    ): Promise<distributeAccount[]> {
        // Check if the root wallet has enough token funds to distribute
        const accountsToFund: distributeAccount[] = [];
        let distributorBalance = await this.tokenRuntime.GetSupplierBalance();

        while (distributorBalance > costs.subAccount && initialSet.size() > 0) {
            const acc = initialSet.pop() as distributeAccount;
            distributorBalance -= acc.missingFunds.toNumber();

            accountsToFund.push(acc);
        }

        // Check if the distributor has funds at all
        if (accountsToFund.length == 0) {
            throw DistributorErrors.errNotEnoughFunds;
        }

        return accountsToFund;
    }
}

export default TokenDistributor;
