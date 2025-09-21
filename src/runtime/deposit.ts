import { JsonRpcProvider } from '@ethersproject/providers';
import Logger from '../logger/logger';
import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import * as ECPairFactory from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { Client } from 'pg';
import { time } from 'console';
// import { number } from 'bitcoinjs-lib/src/script'; // Removed unused import

type VOUT = {
    value: bigint;
    scriptPubKey: string;
};

type VIN = {
    txid: string;
    vout: number;
};

const dogecoinNetwork = {
    messagePrefix: '\x19Dogecoin Signed Message:\n',
    bech32: '', // Dogecoin does not use bech32, so set as empty string
    bip32: {
        public: 0x02facafd,
        private: 0x02fac398
    },
    pubKeyHash: 0x1e,
    scriptHash: 0x16,
    wif: 0x9e,
};

class DepositRuntime {
    private l1RpcUrl: string;

    private l2RpcUrl: string;
    private wif: string;
    private txCount: number;
    private dbUrl: string;
    private network: string;
    private amountPerTxInSatoshi: bigint;
    private depositTarget: string;
    private l2provider: JsonRpcProvider;
    private blockbookUrl: string;
    private dbClient: Client;
    private l1MasterAddress: string = '';

    constructor(
        l1RpcUrl: string,
        l2RpcUrl: string,
        wif: string,
        txCount: number,
        dbUrl: string,
        network: string,
        amountPerTxInSatoshi: bigint,
        depositTarget: string,
        blockbookUrl: string
    ) {
        this.l1RpcUrl = l1RpcUrl;
        this.l2RpcUrl = l2RpcUrl;
        this.wif = wif;
        this.txCount = txCount;
        this.dbUrl = dbUrl;
        this.network = network;
        this.amountPerTxInSatoshi = amountPerTxInSatoshi;
        this.depositTarget = depositTarget;
        this.blockbookUrl = blockbookUrl;

        this.l2provider = new JsonRpcProvider(l2RpcUrl);
        this.dbClient = new Client({ connectionString: this.dbUrl });
    }
    /*
    transactions 表
    txid string primary
    broadcast_at int,null
    l1_block_height int,null
    l2_block_height int,null
    l2_txhash string, null

    l1_header 表，有另外的服务负责创建和更新，本程序不需要处理
    CREATE TABLE IF NOT EXISTS l1_block_headers (
    height BIGINT PRIMARY KEY,
    hash VARCHAR(64) NOT NULL UNIQUE,
    previous_hash VARCHAR(64) NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::BIGINT),
    size_bytes INTEGER DEFAULT 0,
    tx_count INTEGER DEFAULT 0,
    confirmations INTEGER DEFAULT 0
  
    l2_block_headers 表
    baseFeePerGas        15680008
    difficulty           1
    extraData            0x
    gasLimit             10000000000
    gasUsed              21000
    hash                 0xdb984d9acb7d5d37e7fe9beb8fe9d6c656b8ed7714d6e24b73273109e4d6b6cc
    logsBloom            0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
    miner                0x0000000000000000000000000000000000000000
    mixHash              0x0000000000000000000000000000000000000000000000000000000000000000
    nonce                0x0000000000000000
    number               85872
    parentHash           0x80c5b71841f328f72999f65d98aa401a7ceba7f159aa0edbe1f4f3b7a3a66dae
    transactionsRoot     0x3687f1f5e5420cca893f679ca739f2fc4c75431d376bbd91e7cedcca60f4faed
    receiptsRoot         0xf78dfb743fbd92ade140711c8bbc542b5e307f0ab7984eff35d751969fe57efa
    sha3Uncles           0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347
    size                 703
    stateRoot            0xcb1aa561c6a07b5fa8e45b5559a54efa824f9ddce3234a717e543975f912ba92
    timestamp            1758429082
    withdrawalsRoot      
    totalDifficulty      85873
    blobGasUsed          
    excessBlobGas        
    requestsHash         
    */


    public async run() {

        Logger.title('🔍 Starting Deposit Stress Test 🔍');

        try {
            // 1. 连接并检查所有服务
            Logger.info(`Connecting to database at ${this.dbUrl}...`);
            await this.dbClient.connect();
            Logger.success('Database connection successful.');
            await this.initializeDbSchema();

            Logger.info(`Checking L1 RPC connection at ${this.l1RpcUrl}...`);
            try {
                // Use axios for Dogecoin RPC which is different from Ethereum's
                await axios.post(this.l1RpcUrl, {
                    jsonrpc: '1.0',
                    id: 'pandoras-box-l1-check',
                    method: 'getblockchaininfo',
                    params: [],
                });
                Logger.success('L1 RPC connection successful.');
            } catch (e: any) {
                throw new Error(`L1 RPC connection failed: ${e.message}`);
            }

            Logger.info(`Checking L2 RPC connection at ${this.l2RpcUrl}...`);
            await this.l2provider.getNetwork();
            Logger.success('L2 RPC connection successful.');

            // 2. 准备 UTXOs
            await this.prepareUtxosForDeposit();

            // 3. 发送压力测试交易
            await this.sendStressTransactions();

            // 4. 收集并处理区块数据
            await this.collectingBlockData();

            // 5. 生成并显示报告
            await this.report();

            Logger.success('\n✅ Deposit stress test finished successfully.');
        } catch (error: any) {
            Logger.error('An error occurred during the deposit stress test:');
            Logger.error(error.message);
            if (error.stack) {
                Logger.debug(error.stack);
            }
        } finally {
            if (this.dbClient) {
                await this.dbClient.end();
                Logger.info('Database connection closed.');
            }
        }
    }

    private async initializeDbSchema() {
        Logger.info('Initializing database schema if not exists...');

        const createTransactionsTable = `
        CREATE TABLE IF NOT EXISTS transactions (
            txid VARCHAR(64) PRIMARY KEY,
            raw_hex TEXT,
            broadcast_at BIGINT,
            l1_block_height BIGINT,
            l2_block_height BIGINT,
            l2_txhash VARCHAR(66)
        );`;

        const createL2BlockHeadersTable = `
        CREATE TABLE IF NOT EXISTS l2_block_headers (
            height BIGINT PRIMARY KEY,
            hash VARCHAR(66) NOT NULL UNIQUE,
            parent_hash VARCHAR(66) NOT NULL,
            timestamp BIGINT NOT NULL,
            base_fee_per_gas NUMERIC,
            gas_limit NUMERIC,
            gas_used NUMERIC,
            miner VARCHAR(42),
            state_root VARCHAR(66),
            transactions_root VARCHAR(66),
            receipts_root VARCHAR(66)
        );`;

        await this.dbClient.query(createTransactionsTable);
        await this.dbClient.query(createL2BlockHeadersTable);

        Logger.success('Database schema is ready.');
    }

    private async prepareUtxosForDeposit() {
        Logger.info('\n🔧 Preparing UTXOs for deposit...');
        // TODO: Implement the logic below


        // 1. 从 dogecoin rpc 获取 master account 的 utxos
        Logger.info(`Fetching UTXOs for master account ${this.l1MasterAddress} from ${this.l1RpcUrl}...`);

        const url = new URL(this.l1RpcUrl);
        const auth = (url.username || url.password) ? {
            username: url.username,
            password: url.password
        } : undefined;
        // The URL for axios should not contain credentials
        const axiosUrl = `${url.protocol}//${url.host}${url.pathname}`;

        const payload = {
            jsonrpc: '1.0',
            id: 'pandoras-box-listunspent',
            method: 'listunspent',
            params: [
                1, // minconf
                999999999, // maxconf
                [this.l1MasterAddress] // addresses
            ],
        };

        let utxos = [];

        let txid2RawHex = new Map<string, string>();
        try {
            const response = await axios.post(axiosUrl, payload, {
                headers: { 'Content-Type': 'application/json' },
                auth: auth,
            });

            if (response.data.error) {
                throw new Error(`RPC error: ${response.data.error.message} (Code: ${response.data.error.code})`);
            }

            utxos = response.data.result;
            Logger.success(`Found ${utxos.length} UTXOs for the master account.`);
            utxos.forEach((utxo: any) => {
                utxo.amount = BigInt(Math.round(utxo.amount * 1e8));
                txid2RawHex.set(utxo.txid, "");
            });
        } catch (error: any) {
            let errorMessage = `Failed to fetch UTXOs: ${error.message}`;
            if (error.response) {
                errorMessage += ` - ${JSON.stringify(error.response.data)}`;
            }
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        let payload2 = [];
        let txids = [];
        for (const [txid, w] of txid2RawHex) {
            payload2.push(
                {
                    jsonrpc: '1.0',
                    id: 'pandoras-box-listunspent',
                    method: 'getrawtransaction',
                    params: [txid]
                }
            );
            txids.push(txid)
        }

        try {
            const response = await axios.post(axiosUrl, payload2, {
                headers: { 'Content-Type': 'application/json' },
                auth: auth,
            });

            if (response.data.error) {
                throw new Error(`RPC error: ${response.data.error.message} (Code: ${response.data.error.code})`);
            }

            let results = response.data;
            if (txids.length != results.length) {
                Logger.error("txids.length != results.length");
            }
            for (let i = 0; i < txids.length; i++) {
                if (results[i].error != null) {
                    Logger.error(`txid=${txids[i]} fetch rawHex fail.`);
                    continue;
                }
                txid2RawHex.set(txids[i], results[i].result)
            }
        } catch (error: any) {
            let errorMessage = `Failed to fetch rawhex: ${error.message}`;
            if (error.response) {
                errorMessage += ` - ${JSON.stringify(error.response.data)}`;
            }
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        let balance = BigInt(0);
        for (const utxo of utxos) {
            balance += utxo.amount;
        }
        if (balance < this.amountPerTxInSatoshi * BigInt(this.txCount)) {
            let errorMessage = "master address balance is not enough";
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const maxOutCount = 2048;
        const consolidationTxCount = Math.floor(this.txCount / maxOutCount) + 1;
        Logger.info(`Creating ${consolidationTxCount} consolidation transactions to generate ${this.txCount} UTXOs...`);

        let psbt = new bitcoin.Psbt({ network: dogecoinNetwork });
        //const txb = new bitcoin.Transaction()
        for (const input of utxos) {
            psbt.addInput({
                hash: input.txid,
                index: input.vout,
                nonWitnessUtxo: Buffer.from(txid2RawHex.get(input.txid) ?? '', 'hex')
            });
        }

        for (let i = 0; i < consolidationTxCount - 1; i++) {
            psbt.addOutput(
                {
                    address: this.l1MasterAddress,
                    value: Number(this.amountPerTxInSatoshi * BigInt(maxOutCount))
                }
            );
        }
        psbt.addOutput(
            {
                address: this.l1MasterAddress,
                value: Number(this.amountPerTxInSatoshi * BigInt(this.txCount % maxOutCount))
            }
        );

        let fee0 = BigInt(1e6 + (utxos.length + consolidationTxCount + 1) * 1e5);
        let balanceleft = balance - this.amountPerTxInSatoshi * BigInt(this.txCount);
        if (balanceleft > fee0) {
            psbt.addOutput(
                {
                    address: this.l1MasterAddress,
                    value: Number(balanceleft - fee0)
                }
            );
        }


        const ECPair = ECPairFactory.ECPairFactory(ecc);
        const keyPair = ECPair.fromWIF(this.wif, dogecoinNetwork);
        for (let i = 0; i < utxos.length; i++) {
            const keyPairBuffer = {
                publicKey: Buffer.from(keyPair.publicKey),
                sign: (hash: Buffer) => keyPair.sign(hash)
            };
            psbt.signInput(i, keyPairBuffer);
        }

        psbt.finalizeAllInputs();

        const rawHex0 = psbt.extractTransaction().toHex();
        const txid0 = psbt.extractTransaction().getId();
        this.sendRawTransaction(rawHex0);

        let startTime = new Date();
        while (true) {
            const response = await axios.post(axiosUrl, {
                jsonrpc: '1.0',
                id: Date().toString(),
                method: 'gettransaction',
                params: [
                    txid0
                ],
            }, {
                headers: { 'Content-Type': 'application/json' },
                auth: auth,
            });

            if (response.data.error) {
                if ((new Date().getTime() - startTime.getTime()) > 5 * 60 * 1000) {
                    throw new Error('Timeout: Transaction not confirmed after 5 minutes');
                } else {
                    Logger.info("waiting transaction 0 ...");
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
            } else {
                Logger.success("transaction 0 success!")
                break;
            }
        }

        let rawHexs = []
        for (let i = 0; i < consolidationTxCount; i++) {
            let psbt = new bitcoin.Psbt({ network: dogecoinNetwork });
            psbt.addInput({
                hash: txid0,
                index: i,
                nonWitnessUtxo: Buffer.from(rawHex0)
            });
            let planCount = i == consolidationTxCount - 1 ? consolidationTxCount % 2048 : maxOutCount;
            for (let j = 0; j < planCount; j++) {
                psbt.addOutput({
                    address: this.l1MasterAddress,
                    value: Number(this.amountPerTxInSatoshi - BigInt(1e6))
                });
            }
            const keyPairBuffer = {
                publicKey: Buffer.from(keyPair.publicKey),
                sign: (hash: Buffer) => keyPair.sign(hash)
            };
            psbt.signInput(0, keyPairBuffer);
            psbt.finalizeAllInputs();
            const rawHex = psbt.extractTransaction().toHex();
            const txid = psbt.extractTransaction().getId();
            await this.dbClient.query(
                'INSERT INTO transactions (txid, raw_hex, broadcast_at, l1_block_height, l2_block_height, l2_txhash) VALUES ($1, $2, NULL, NULL, NULL, NULL) ON CONFLICT (txid) DO NOTHING',
                [txid, rawHex]
            );
            Logger.success(`Inserted transaction: ${txid}`);
            rawHexs.push(rawHex);
            this.sendRawTransaction(rawHex);
        }
    }


    private async sendRawTransaction(rawHex: string) {
        const url = new URL(this.l1RpcUrl);
        const auth = (url.username || url.password) ? {
            username: url.username,
            password: url.password
        } : undefined;
        // The URL for axios should not contain credentials
        const axiosUrl = `${url.protocol}//${url.host}${url.pathname}`;

        const payload = {
            jsonrpc: '1.0',
            id: Date().toString(),
            method: 'sendrawtransaction',
            params: [
                rawHex
            ],
        };

        try {
            const response = await axios.post(axiosUrl, payload, {
                headers: { 'Content-Type': 'application/json' },
                auth: auth,
            });

            if (response.data.error) {
                throw new Error(`RPC error: ${response.data.error.message} (Code: ${response.data.error.code})`);
            }
            return response.data;

        } catch (error: any) {
            let errorMessage = `Failed to fetch UTXOs: ${error.message}`;
            if (error.response) {
                errorMessage += ` - ${JSON.stringify(error.response.data)}`;
            }
            Logger.error(errorMessage);
            return null;
        }
    }

    private async sendStressTransactions() {
        Logger.info('\n🚀 Sending stress transactions...');
        // TODO: Implement the logic below

        // 1. 记录 l1_start_test_height,l2_start_test_height
        // TODO: Get L1 start height using Dogecoin RPC ('getblockcount')
        const l2StartHeight = await this.l2provider.getBlockNumber();
        // For now, we only log L2 height
        Logger.info(`Starting at L2 block height: ${l2StartHeight}`);

        // 2. 从transactions中 读交易，按照指定速率每秒发送 Rate 个交易到 l1RpcUrl
        Logger.info(`Broadcasting ${this.txCount} transactions to L1...`);

        Logger.success('All stress transactions have been broadcasted.');
    }

    private async collectingBlockData() {
        Logger.info('\n📊 Collecting and processing block data...');
        // TODO: Implement the logic below

        // 1. 从 l1_start_test_height 开始顺序获取每个l1区块h，解析出其中交易，如果交易的 txid 在transactions中，更新字段 l1_block_height=h
        // 2. 从 l2_start_test_height 开始顺序获取每个l2区块h, 将区块header存入表 l2_block_headers 中, 解析出其中交易，会得到 2 个字段，txid和 txhash。 如果交易的 txid 在transactions 中，更新其字段 l2_block_height=h
        Logger.info('Waiting for transactions to be included in L1 and L2 blocks...');

        Logger.success('Block data collection complete.');
    }

    private async report() {
        Logger.info('\n📈 Generating report...');
        // TODO: Implement the logic below

        // 1. 统计每个交易
        Logger.info('Analyzing transaction data from database...');

        Logger.success('Report generated.');
    }

}

export default DepositRuntime;
// Standalone test entry
if (require.main === module) {
    (async () => {
        // TODO: Replace these with your actual test parameters
        const l1RpcUrl = process.env.L1_RPC_URL || 'http://localhost:44555';
        const l2RpcUrl = process.env.L2_RPC_URL || 'http://localhost:8545';
        const wif = process.env.WIF || 'ciCWUwnkp21uK3Mm12UcGT27HNXCMFa6U1kFogJjsp9W51BVRgnX';
        const txCount = Number(process.env.TX_COUNT || 3000);
        const dbUrl = process.env.DB_URL || 'postgresql://postgres:123456@localhost:5432/dogeos';
        const network = process.env.NETWORK || 'testnet';
        const amountPerTxInSatoshi = BigInt(process.env.AMOUNT_PER_TX || 1e8);
        const depositTarget = process.env.DEPOSIT_TARGET || 'nmNf4f5kyvCFrfyUBoQU3TKN3Dyc5kcMoH';
        const blockbookUrl = process.env.BLOCKBOOK_URL || '';

        const runtime = new DepositRuntime(
            l1RpcUrl,
            l2RpcUrl,
            wif,
            txCount,
            dbUrl,
            network,
            amountPerTxInSatoshi,
            depositTarget,
            blockbookUrl
        );
        await runtime.run();
    })();
}
