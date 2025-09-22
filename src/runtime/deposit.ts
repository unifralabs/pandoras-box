import { JsonRpcProvider } from '@ethersproject/providers';
import Logger from '../logger/logger';
import axios from 'axios';
import * as bitcoin from 'bitcoinjs-lib';
import * as ECPairFactory from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { Client } from 'pg';
import { SingleBar } from 'cli-progress';
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
const ECPair = ECPairFactory.ECPairFactory(ecc);

const feeRate = 1000;
const dogecoinTestNetwork = {
    messagePrefix: '\x19Dogecoin Signed Message:\n',
    bech32: '', // Dogecoin does not use bech32, so set as empty string
    bip32: {
        public: 0x043587cf,
        private: 0x04358394
    },
    pubKeyHash: 0x71,
    scriptHash: 0xc4,
    wif: 0xf1,
};

const maxOutCount = 3;

class DepositRuntime {
    private l1RpcUrl: string;

    private l2RpcUrl: string;
    private masterWif: string;
    private agentWif: string;
    private txCount: number;
    private dbUrl: string;
    private network: string;
    private amountPerTxInSatoshi: bigint;
    private bridgeAddress: string;
    private l2provider: JsonRpcProvider;
    private dbClient: Client;
    private l1MasterAddress: string = '';
    private l1AgentAddress: string = '';
    private depositTargetAddress: string = '';
    private blockBookUrl = "https://blockbook.perf.unifra.xyz/api/";

    constructor(
        l1RpcUrl: string,
        l2RpcUrl: string,
        masterWif: string,
        agentWif: string,
        txCount: number,
        dbUrl: string,
        network: string,
        amountPerTxInSatoshi: bigint,
        bridgeAddress: string,
        depositTargetAddress: string
    ) {
        this.l1RpcUrl = l1RpcUrl;
        this.l2RpcUrl = l2RpcUrl;
        this.masterWif = masterWif;
        this.agentWif = agentWif
        this.txCount = txCount;
        this.dbUrl = dbUrl;
        this.network = network;
        this.amountPerTxInSatoshi = amountPerTxInSatoshi;
        this.bridgeAddress = bridgeAddress;
        this.depositTargetAddress = depositTargetAddress;

        this.l2provider = new JsonRpcProvider(l2RpcUrl);
        this.dbClient = new Client({ connectionString: this.dbUrl });

        // Derive L1 master address from WIF
        {
            const keyPair = ECPair.fromWIF(this.masterWif, dogecoinTestNetwork);
            const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(keyPair.publicKey), network: dogecoinTestNetwork });
            if (!address) {
                throw new Error('Could not derive L1 master address from WIF.');
            }
            this.l1MasterAddress = address;
            Logger.success(`L1 Master Address: ${this.l1MasterAddress}`);
        }
        {
            const keyPair2 = ECPair.fromWIF(this.agentWif, dogecoinTestNetwork);
            const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(keyPair2.publicKey), network: dogecoinTestNetwork });
            if (!address) {
                throw new Error('Could not derive agent address from WIF.');
            }

            this.l1AgentAddress = address;
            Logger.success(`L1 Agent Address: ${this.l1AgentAddress}`);
        }
    }
    /*
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
    logsBloom            0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
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
            await this.l1RpcRequest({ jsonrpc: '1.0', id: 'pandoras-box-l1-check', method: 'getblockchaininfo', params: [] });
            Logger.success('L1 RPC connection successful.');

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
        CREATE TABLE IF NOT EXISTS deposit_transactions (
            txid VARCHAR(64) PRIMARY KEY,
            raw_hex TEXT,
            type VARCHAR(20),
            broadcast_at BIGINT,
            l1_block_height BIGINT,
            l1_block_hash VARCHAR(66),
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
        await this.dbClient.query("delete from deposit_transactions;");
        await this.dbClient.query("delete from l2_block_headers;");

        Logger.success('Database schema is ready.');
    }

    private async queryUtxos(address: string): Promise<any[]> {
        // this.blockbookUrl+`/v2/utxo/${address}`
        const url = `${this.blockBookUrl}/v2/utxo/${address}`;
        try {
            const response = await axios.get(url);
            if (response.data && Array.isArray(response.data)) {
                return response.data.map((utxo: any) => ({
                    txid: utxo.txid,
                    vout: utxo.vout,
                    amount: BigInt(utxo.value), // value is already in satoshis
                }));
            }
            return [];
        } catch (error: any) {
            let errorMessage = `Failed to fetch UTXOs from blockbook for address ${address}: ${error.message}`;
            if (error.response) {
                errorMessage += ` - ${JSON.stringify(error.response.data)}`;
            }
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }
    }

    private async prepareUtxosForDeposit() {
        Logger.info('\n🔧 Preparing UTXOs for deposit...');

        // 1. 从 dogecoin rpc 获取 master account 的 utxos
        Logger.info(`Fetching UTXOs for master account ${this.l1MasterAddress} from ${this.blockBookUrl}...`);

        let utxos: any[] = [];
        let txid2RawHex = new Map<string, string>();
        try {
            utxos = await this.queryUtxos(this.l1MasterAddress);
            Logger.success(`Found ${utxos.length} UTXOs for the master account.`);
            utxos.forEach((utxo: any) => {
                txid2RawHex.set(utxo.txid, "");
            });
        } catch (error: any) {
            // Error is already logged in queryUtxos, just rethrow.
            throw error;
        }

        let balance = BigInt(0);
        for (const utxo of utxos) {
            balance += utxo.amount;
        }
        if (balance < this.amountPerTxInSatoshi * BigInt(this.txCount)) {
            let errorMessage = "master address balance is not enough";
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
            const results = await this.l1RpcRequest(payload2);
            if (txids.length != results.length) {
                // This check might be incorrect if the RPC returns a single error object instead of an array of results/errors
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


        const consolidationTxCount = Math.ceil(this.txCount / maxOutCount);
        Logger.info(`Creating ${consolidationTxCount} consolidation transactions to generate ${this.txCount} UTXOs...`);

        utxos.sort((a: { amount: number; }, b: { amount: number; }) => {
            if (a.amount < b.amount) return 1;
            if (a.amount > b.amount) return -1;
            return 0;
        });

        let psbt = new bitcoin.Psbt({ network: dogecoinTestNetwork, maximumFeeRate: 6000 });
        //const txb = new bitcoin.Transaction()
        let inputTotal = BigInt(0);
        for (const input of utxos) {
            psbt.addInput({
                hash: input.txid,
                index: input.vout,
                nonWitnessUtxo: Buffer.from(txid2RawHex.get(input.txid) ?? '', 'hex')
            });
            inputTotal += input.amount;
            if (inputTotal > this.amountPerTxInSatoshi * BigInt(maxOutCount)) {
                break;
            }
        }
        Logger.success("addInput done");

        for (let i = 0; i < consolidationTxCount - 1; i++) {
            psbt.addOutput(
                {
                    address: this.l1MasterAddress,
                    value: Number(this.amountPerTxInSatoshi * BigInt(maxOutCount))
                }
            );
        }

        const sumOutNoChange = BigInt(this.txCount) * this.amountPerTxInSatoshi;
        const lastOutputCount = (this.txCount % maxOutCount) || maxOutCount;
        psbt.addOutput({
            address: this.l1MasterAddress,
            value: Number(this.amountPerTxInSatoshi * BigInt(lastOutputCount))
        });

        Logger.success("addOutput done");

        const masterKeyPair = ECPair.fromWIF(this.masterWif, dogecoinTestNetwork);
        const masterKeyPairBuffer = {
            publicKey: Buffer.from(masterKeyPair.publicKey),
            sign: (hash: Buffer) => Buffer.from(masterKeyPair.sign(hash))
        };

        let psbtTmp = psbt.clone()
        psbtTmp.addOutput({
            address: this.l1MasterAddress,
            value: Number(1)
        });

        for (let i = 0; i < psbt.inputCount; i++) {
            psbtTmp.signInput(i, masterKeyPairBuffer);
        }
        Logger.success("simulate signInput done");

        psbtTmp.finalizeAllInputs();
        Logger.success("simulate finalizeAllInputs done");

        const tempTx = psbtTmp.extractTransaction(true);
        Logger.success("extractTransaction done");
        const txSize = tempTx.virtualSize();

        const estimatedFee = BigInt(txSize * feeRate);
        const changeAmount = inputTotal - sumOutNoChange - estimatedFee;

        Logger.info(`Estimated fee: ${estimatedFee}, Change amount: ${changeAmount}`);

        if (changeAmount > 546) {
            psbt.addOutput({
                address: this.l1MasterAddress,
                value: Number(changeAmount)
            });
        }

        for (let i = 0; i < psbt.inputCount; i++) {
            psbt.signInput(i, masterKeyPairBuffer);
        }
        psbt.finalizeAllInputs();


        const rawHex0 = psbt.extractTransaction().toHex();
        const txid0 = psbt.extractTransaction().getId();
        Logger.info(`sending tx0 ${txid0}`);
        let ret = await this.dbClient.query(
            'INSERT INTO deposit_transactions (txid, raw_hex,type, broadcast_at, l1_block_height, l2_block_height, l2_txhash) VALUES ($1, $2,$3, $4, NULL, NULL, NULL) ON CONFLICT (txid) DO NOTHING',
            [txid0, rawHex0, "consolidation", Math.floor(Date.now() / 1000)]
        );
        this.sendRawTransaction(rawHex0);
        /////////////////////////////////////////////////////////////////////////////////////////////////////////
        let startTime = new Date();
        while (true) {
            const data = await this.l1RpcRequest({
                jsonrpc: '1.0',
                id: Date.now().toString(), // JSON-RPC 1.0 spec requires id to be a string, number, or null.
                method: 'gettransaction',
                params: [txid0],
            });
            const response = { data }; // Mock axios response structure for compatibility

            if (response.data.error) {
                if ((new Date().getTime() - startTime.getTime()) > 5 * 60 * 1000) {
                    throw new Error('Timeout: Transaction not confirmed after 5 minutes');
                } else {
                    Logger.info("waiting transaction 0 ...");
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
            } else {
                let respose = JSON.stringify(response.data);
                Logger.success(`transaction 0 success! ${txid0}, ${respose}`)
                break;
            }
        }

        const feePerOut = 10000;
        const depositSize = 222;
        try {
            Logger.info('Starting consolidation transaction insertions within a DB transaction.');
            let txids: string[] = [];
            const agentKeyPair = ECPair.fromWIF(this.agentWif, dogecoinTestNetwork);
            const agentKeyPairBuffer = {
                publicKey: Buffer.from(agentKeyPair.publicKey),
                sign: (hash: Buffer) => Buffer.from(agentKeyPair.sign(hash))
            };

            for (let i = 0; i < consolidationTxCount; i++) {
                Logger.success(`processing consolidation transaction:${i.toString()}`);
                let psbtToAgent = new bitcoin.Psbt({ network: dogecoinTestNetwork, maximumFeeRate: 50000000 });

                psbtToAgent.addInput({
                    hash: txid0,
                    index: i,
                    nonWitnessUtxo: Buffer.from(rawHex0, "hex")
                });

                let planCount = maxOutCount;
                if (i === consolidationTxCount - 1) {
                    planCount = (this.txCount % maxOutCount) || maxOutCount;
                }

                await this.dbClient.query("BEGIN");
                let valueToAgent = Number(this.amountPerTxInSatoshi) - feePerOut;
                for (let j = 0; j < planCount; j++) {
                    psbtToAgent.addOutput({
                        address: this.l1AgentAddress,
                        value: valueToAgent
                    });
                }

                psbtToAgent.signAllInputs(masterKeyPairBuffer);
                psbtToAgent.finalizeAllInputs();
                const rawHex = psbtToAgent.extractTransaction().toHex();
                const txid = psbtToAgent.extractTransaction().getId();
                txids.push(txid);
                let ret = await this.dbClient.query(
                    'INSERT INTO deposit_transactions (txid, raw_hex,type, broadcast_at, l1_block_height, l2_block_height, l2_txhash) VALUES ($1, $2,$3, $4, NULL, NULL, NULL) ON CONFLICT (txid) DO NOTHING',
                    [txid, rawHex, "splitting", Math.floor(Date.now() / 1000)]
                );
                if (ret.rowCount === 0) {
                    Logger.warn(`Transaction with txid ${txid} already exists, skipping insertion.`);
                }
                await this.sendRawTransaction(rawHex);

                for (let j = 0; j < planCount; j++) {
                    let psbtDeposit = new bitcoin.Psbt({ network: dogecoinTestNetwork, maximumFeeRate: 50000000 });
                    psbtDeposit.addInput({
                        hash: txid,
                        index: j,
                        nonWitnessUtxo: Buffer.from(rawHex, "hex")
                    });
                    psbtDeposit.addOutput({
                        address: this.bridgeAddress,
                        value: valueToAgent - depositSize * feeRate
                    });
                    //OP_RETURN
                    const data = Buffer.from(this.depositTargetAddress.toLowerCase().replace(/^0x/, '00'), 'hex');
                    const embed = bitcoin.payments.embed({ data: [data] });
                    if (!embed.output) {
                        throw new Error('Could not create OP_RETURN script.');
                    }
                    psbtDeposit.addOutput({
                        script: embed.output,
                        value: 0, // OP_RETURN outputs must have a value of 0
                    });

                    psbtDeposit.signAllInputs(agentKeyPairBuffer);
                    psbtDeposit.finalizeAllInputs();
                    const rawHex2 = psbtDeposit.extractTransaction().toHex();
                    const txid2 = psbtDeposit.extractTransaction().getId();
                    this.dbClient.query(
                        'INSERT INTO deposit_transactions (txid, raw_hex,type, broadcast_at, l1_block_height, l2_block_height, l2_txhash) VALUES ($1, $2,$3, NULL, NULL, NULL, NULL) ON CONFLICT (txid) DO NOTHING',
                        [txid2, rawHex2, "deposit"]
                    );
                    this.dbClient.query("COMMIT");
                    //this.sendRawTransaction(rawHex2);
                }
            }
            Logger.success('All consolidation transactions inserted and DB transaction committed.');
        } catch (error) {
            throw error; // Re-throw the error after rolling back
        }

        const consolidationBar = new SingleBar({
            format: 'Consolidating [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} txs',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });
        consolidationBar.start(consolidationTxCount, 0);
        while (txids.length > 0) {
            for (const txid of [...txids]) {
                try {
                    this.l1RpcRequest({
                        jsonrpc: '1.0',
                        id: Date.now().toString(), // JSON-RPC 1.0 spec requires id to be a string, number, or null.
                        method: 'gettransaction',
                        params: [txid],
                    }).then((data) => {
                        // Remove txid from array if confirmed
                        const idx = txids.indexOf(txid);
                        consolidationBar.increment();
                        if (idx !== -1) {
                            txids.splice(idx, 1);
                            this.dbClient.query(
                                'UPDATE deposit_transactions SET l1_block_hash = $1 WHERE txid = $2',
                                [data.result.blockhash, txid]);
                        } else {
                            Logger.error("txids not found");
                        }
                    });
                } catch (error) {
                    // Ignore errors and continue
                }
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        consolidationBar.stop();

    }



    private async l1RpcRequest(payload: any): Promise<any> {
        const url = new URL(this.l1RpcUrl);
        const auth = (url.username || url.password) ? {
            username: url.username,
            password: url.password
        } : undefined;
        const axiosUrl = `${url.protocol}//${url.host}${url.pathname}`;

        try {
            const response = await axios.post(axiosUrl, payload, {
                headers: { 'Content-Type': 'application/json' },
                auth: auth,
            });

            // Handle single request error
            if (!Array.isArray(response.data) && response.data.error) {
                throw new Error(`RPC error: ${response.data.error.message} (Code: ${response.data.error.code})`);
            }
            return response.data;
        } catch (error: any) {
            let errorMessage = `L1 RPC request failed: ${error.message}`;
            if (error.response) {
                errorMessage += ` - ${JSON.stringify(error.response.data)}`;
            }
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }
    }

    private async sendRawTransaction(rawHex: string) {
        try {
            return await this.l1RpcRequest({
                jsonrpc: '1.0',
                id: Date.now().toString(), // JSON-RPC 1.0 spec requires id to be a string, number, or null.
                method: 'sendrawtransaction',
                params: [
                    rawHex
                ],
            });
        } catch (e) { return null; } // Maintain original behavior of returning null on error
    }

    private async sendStressTransactions() {
        Logger.info('\n🚀 Sending stress transactions...');
        // TODO: Implement the logic below

        // 1. 记录 l1_start_test_height,l2_start_test_height
        // TODO: Get L1 start height using Dogecoin RPC ('getblockcount')
        const l2StartHeight = await this.l2provider.getBlockNumber();
        const getblockcountReturn = await this.l1RpcRequest({
            jsonrpc: '1.0',
            id: Date.now().toString(),
            method: 'getblockcount',
            params: []
        });

        if (getblockcountReturn.error) {
            throw new Error(`L1 RPC request failed: ${getblockcountReturn.error.message} (Code: ${getblockcountReturn.error.code})`);
        }
        const l1StartHeight = getblockcountReturn.result;
        Logger.info(`Starting at L2 block height: ${l2StartHeight}, L1 block height: ${l1StartHeight}`);

        Logger.info(`Broadcasting ${this.txCount} transactions to L1...`);

        const res = await this.dbClient.query("SELECT * FROM deposit_transactions WHERE type='deposit';");
        const depositTxs = res.rows;

        for (const tx of depositTxs) {
            const result = await this.sendRawTransaction(tx.raw_hex);
            if (result && !result.error) {
                Logger.debug(`Broadcasted deposit tx: ${tx.txid}`);
            } else {
                Logger.error(`Failed to broadcast tx: ${tx.txid} - ${result?.error?.message || 'Unknown error'}`);
            }
            await new Promise(resolve => setTimeout(resolve, 200)); // 恒定速率
        }

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
        const l1RpcUrl = process.env.L1_RPC_URL || 'https://gIiXOF7h:WxkMni1FAZc77cvZ@dogecoin.perf.unifra.xyz';
        const l2RpcUrl = process.env.L2_RPC_URL || 'https://rpc.perf.unifra.xyz';
        const masterWif = process.env.WIF || 'ciCWUwnkp21uK3Mm12UcGT27HNXCMFa6U1kFogJjsp9W51BVRgnX';
        const agentWif = process.env.WIF || 'co89zv3jhdCm2sr2s3151EjUBLtd7oH82FRcUdgTmWzBLuq9HtjM';
        const txCount = Number(process.env.TX_COUNT || 7);
        const dbUrl = process.env.DB_URL || 'postgresql://postgres:123456@localhost:5432/dogeos';
        const network = process.env.NETWORK || 'testnet';
        const amountPerTxInSatoshi = BigInt(process.env.AMOUNT_PER_TX || 210000000);
        const bridgeAddress = process.env.BRIDGE_ADDRESS || '2N7bYHnFeAbYSy7mxDssy7Kt7vrTbcV7iMn';
        const depositTargetAddress = process.env.DEPOSIT_TARGET_ADDRESS || '0xd98f41da0f5b229729ed7bf469ea55d98d11f467';

        const runtime = new DepositRuntime(
            l1RpcUrl,
            l2RpcUrl,
            masterWif,
            agentWif,
            txCount,
            dbUrl,
            network,
            amountPerTxInSatoshi,
            bridgeAddress,
            depositTargetAddress,
        );
        await runtime.run();
    })();
}
