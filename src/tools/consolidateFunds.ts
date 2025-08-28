import { Command } from 'commander';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { BigNumber } from '@ethersproject/bignumber';
import { parseUnits, formatUnits, formatEther } from '@ethersproject/units';
import { TransactionRequest } from '@ethersproject/abstract-provider';
import Logger from '../logger/logger';
import process from 'node:process';

async function main() {
    const program = new Command();
    program
        .requiredOption('-u, --rpc-url <url>', 'The JSON-RPC URL of the client')
        .requiredOption('-m, --mnemonic <mnemonic>', 'The mnemonic used to generate accounts')
        .option('-s, --start-index <number>', 'The starting account index to consolidate from', '1')
        .requiredOption('-e, --end-index <number>', 'The ending account index to consolidate up to')
        .option('-c, --concurrency <number>', 'The maximum number of concurrent transfers', '10')
        .option('--gas-price <gwei>', 'Optional fixed gas price in Gwei');

    program.parse(process.argv);
    const options = program.opts();

    const provider = new JsonRpcProvider(options.rpcUrl);
    const mnemonic = options.mnemonic;
    const startIndex = parseInt(options.startIndex, 10);
    const endIndex = parseInt(options.endIndex, 10);
    const concurrency = parseInt(options.concurrency, 10);

    if (isNaN(startIndex) || isNaN(endIndex) || isNaN(concurrency) || startIndex < 1 || endIndex < startIndex) {
        Logger.error('Invalid start/end index or concurrency.');
        return;
    }

    const destinationWallet = Wallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/0`);
    const destinationAddress = destinationWallet.address;
    Logger.success(`Consolidating funds to account 0: ${destinationAddress}`);

    let gasPrice: BigNumber;
    if (options.gasPrice) {
        gasPrice = parseUnits(options.gasPrice, 'gwei');
        Logger.success(`Using fixed gas price: ${options.gasPrice} Gwei`);
    } else {
        gasPrice = await provider.getGasPrice();
        Logger.success(`Using network gas price: ${formatUnits(gasPrice, 'gwei')} Gwei`);
    }

    const gasLimit = BigNumber.from(21000);
    const txFee = gasPrice.mul(gasLimit);

    const totalAccounts = endIndex - startIndex + 1;
    Logger.success(`Starting consolidation for ${totalAccounts} accounts (from index ${startIndex} to ${endIndex})...`);

    let successCount = 0;
    let failCount = 0;
    let totalConsolidated = BigNumber.from(0);

    const accountIndices = Array.from({ length: totalAccounts }, (_, i) => i + startIndex);

    for (let i = 0; i < accountIndices.length; i += concurrency) {
        const batch = accountIndices.slice(i, i + concurrency);
        const promises = batch.map(async (index) => {
            try {
                const path = `m/44'/60'/0'/0/${index}`;
                const wallet = Wallet.fromMnemonic(mnemonic, path).connect(provider);
                const balance = await wallet.getBalance();

                if (balance.gt(txFee)) {
                    const amountToSend = balance.sub(txFee).sub(parseUnits('1.2', 'ether'));
                    const tx: TransactionRequest = {
                        to: destinationAddress,
                        value: amountToSend,
                        gasLimit: gasLimit,
                        gasPrice: gasPrice,
                    };
                    const txResponse = await wallet.sendTransaction(tx);
                    Logger.success(`Account ${index} (${wallet.address}) | Balance: ${formatEther(balance)} ETH | Transferring: ${formatEther(amountToSend)} ETH | Tx: ${txResponse.hash}`);
                    successCount++;
                    totalConsolidated = totalConsolidated.add(amountToSend);
                } else {
                    Logger.warn(`Account ${index} (${wallet.address}) | Balance: ${formatEther(balance)} ETH | Insufficient for tx fee, skipping.`);
                }
            } catch (error: any) {
                Logger.warn(`Failed to process account ${index}: ${error.message}`);
                failCount++;
            }
        });
        await Promise.all(promises);
    }

    Logger.success(`Consolidation complete.`);
    Logger.success(`- Transferred from ${successCount} accounts.`);
    Logger.success(`- Failed to process ${failCount} accounts.`);
    Logger.success(`- Total consolidated: ${formatEther(totalConsolidated)} ETH.`);
}

main().catch((error) => {
    Logger.error(error.message);
    process.exit(1);
});