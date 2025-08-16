import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import Logger from '../logger/logger';

class ClearPendingRuntime {
    mnemonic: string;
    url: string;
    provider: Provider;

    constructor(mnemonic: string, url: string) {
        this.mnemonic = mnemonic;
        this.provider = new JsonRpcProvider(url);
        this.url = url;
    }

    public async run() {
        Logger.title('\n🧹 Clearing pending transactions 🧹\n');

        try {
            // 1. Create a wallet instance for the primary account
            const wallet = Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/0`).connect(this.provider);
            Logger.info(`Using primary account: ${wallet.address}`);

            // 2. Get the current nonce for this account
            const nonce = await wallet.getTransactionCount('latest');
            Logger.info(`Using nonce: ${nonce} (to replace the oldest pending transaction)`);

            // 3. Get the current gas price and calculate a high gas price
            const currentGasPrice = await this.provider.getGasPrice();
            const highGasPrice = currentGasPrice.mul(20); // Using 20x multiplier
            Logger.info(`Current gas price: ${currentGasPrice.toString()} wei`);
            Logger.info(`Using high gas price: ${highGasPrice.toString()} wei (20x)`);

            // 4. Construct and send the transaction
            const tx = {
                to: wallet.address,
                from: wallet.address,
                nonce: nonce,
                value: 0,
                gasPrice: highGasPrice,
                gasLimit: 21000, // Standard gas limit for a simple ETH transfer
            };

            Logger.info('Sending transaction to clear pending queue...');
            const response = await wallet.sendTransaction(tx);

            Logger.success('Replacement transaction sent successfully!');
            Logger.info(`Transaction hash: ${response.hash}`);
            Logger.info('Please check a block explorer to confirm it has been mined.');

        } catch (error: any) {
            Logger.error('An error occurred while trying to clear pending transactions:');
            Logger.error(error.message);
        }
    }
}

export default ClearPendingRuntime;
