import BetterSqlite3 from "better-sqlite3";
import cliProgress from "cli-progress";
import Table from "cli-table3";
import { Command } from "commander";
import { ethers } from "ethers";
import process from "node:process";
import { Subscriber } from "zeromq";
import MoatABI from "../abi/moat";
import { Block, Transaction } from "bitcoinjs-lib";
import Logger from "../logger/logger";

type DB = InstanceType<typeof BetterSqlite3>;
const { utils, providers } = ethers as any;
const Interface = (utils && utils.Interface) || (ethers as any).Interface;
const parseEther =
    (ethers as any).utils?.parseEther ||
    ((value: string) => {
        // Convert "0.1" to "100000000000000000" (0.1 ETH in wei)
        const parts = value.split(".");
        if (parts.length === 1) {
            return BigInt(value + "000000000000000000");
        } else {
            const whole = parts[0];
            const decimal = parts[1].padEnd(18, "0").substring(0, 18);
            return BigInt(whole + decimal);
        }
    });

type TransactionRequest = any;

interface VoutInfo {
    value: bigint;
    scriptHex: string;
    isP2PKH: boolean;
    addrHash?: string | null;
    uid: bigint;
}

interface ParsedTx {
    hash: string;
    vouts: VoutInfo[];
}

function isP2PKH(script: Buffer): boolean {
    return (
        script.length === 25 &&
        script[0] === 0x76 && // OP_DUP
        script[1] === 0xa9 && // OP_HASH160
        script[2] === 0x14 && // push 20 bytes
        script[23] === 0x88 && // OP_EQUALVERIFY
        script[24] === 0xac // OP_CHECKSIG
    );
}

/**
 * Simple script to test Dogecoin's ZMQ interface.
 *
 * Make sure your `dogecoind` instance is started with the following option:
 *   -zmqpubrawblock=tcp://127.0.0.1:28332
 *
 * Then run this script with ts-node or after transpiling to JavaScript.
 */
export function createTxDatabase(dbPath: string): DB {
    const db = new BetterSqlite3(dbPath);
    db.exec(
        `CREATE TABLE IF NOT EXISTS l1_headers (
            height      INTEGER PRIMARY KEY,
            hash        TEXT    NOT NULL,
            version     INTEGER NOT NULL,
            prev_hash   TEXT    NOT NULL,
            merkle_root TEXT    NOT NULL,
            timestamp   INTEGER NOT NULL,
            create_at   INTEGER NOT NULL,
            bits        INTEGER NOT NULL,
            nonce       INTEGER NOT NULL,
            size_bytes  INTEGER NOT NULL
        );`
    );
    db.exec(
        `CREATE TABLE IF NOT EXISTS txs (
            uid           INTEGER PRIMARY KEY,
            l2_txhash     TEXT,
            l2_height     INTEGER,
            l2_timestamp  INTEGER,
            l1_txhash     TEXT,
            l1_height     INTEGER,
            l1_timestamp  INTEGER
        );`
    );
    db.exec(
        `CREATE TABLE IF NOT EXISTS l2_headers (
            height      INTEGER PRIMARY KEY,
            hash        TEXT    NOT NULL,
            timestamp   INTEGER NOT NULL,
            create_at   INTEGER NOT NULL
        );`
    );
    return db;
}
/**
 * 
 * @param db 
 * @param zmqEndpoint 
 * @param targetAddrHash 20-byte hex without 0x
 * @returns 
 */
export async function startL1Listener(
    db: DB,
    zmqEndpoint: string,
    rpcUrl: string,
    rpcUser: string,
    rpcPass: string,
    targetAddrHash: string = "",
    bars?: cliProgress.MultiBar
) {
    Logger.debug(`[l1-listener] startL1Listener zmqEndpoint: ${zmqEndpoint}, targetAddrHash: ${targetAddrHash}`);
    // previous db.exec moved to createTxDatabase, so assume db ready
    const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO l1_headers (height, hash, version, prev_hash, merkle_root, timestamp, create_at, bits, nonce, size_bytes)
         VALUES (@height, @hash, @version, @prev_hash, @merkle_root, @timestamp, @create_at, @bits, @nonce, @size_bytes)`
    );

    const updateTxStmt = db.prepare(
        `UPDATE txs SET l1_txhash=@l1_txhash, l1_height=@l1_height, l1_timestamp=@l1_timestamp WHERE uid=@uid`
    );

    const insertBlockData = db.transaction((header: any, txRows: { uid: number; l1_txhash: string; l1_height: number; l1_timestamp: number }[]) => {
        insertStmt.run(header);
        for (const row of txRows) updateTxStmt.run(row);
    });

    const processBlock = (blockJson: any) => {
        const height = blockJson.height;
        if (!height) {
            Logger.warn(`[l1-listener] Block JSON is missing height. Skipping.`);
            return;
        }

        const blockHash = blockJson.hash;

        const nowSec = Math.floor(Date.now() / 1000);
        const nowMs = Date.now();
        const headerRow = {
            height,
            hash: blockHash,
            version: blockJson.version,
            prev_hash: blockJson.previousblockhash,
            merkle_root: blockJson.merkleroot,
            timestamp: blockJson.time,
            create_at: nowMs,
            bits: parseInt(blockJson.bits, 16),
            nonce: blockJson.nonce,
            size_bytes: blockJson.size,
        };

        const rowsToUpdate: { uid: number; l1_txhash: string; l1_height: number; l1_timestamp: number }[] = [];
        const transactions = blockJson.tx || [];

        for (const tx of transactions) {
            const txHash = tx.txid;
            for (const vout of tx.vout) {
                const valueInSatoshis = BigInt(Math.round(vout.value * 1e8));
                const scriptPubKey = vout.scriptPubKey;
                if (!scriptPubKey || !scriptPubKey.hex) continue;
                const scriptBuffer = Buffer.from(scriptPubKey.hex, 'hex');
                const p2pkh = isP2PKH(scriptBuffer);
                const addrHash = p2pkh ? scriptBuffer.subarray(3, 23).toString("hex") : "";

                if (addrHash === targetAddrHash) {
                    rowsToUpdate.push({ uid: Number(valueInSatoshis), l1_txhash: txHash, l1_height: height, l1_timestamp: nowSec });
                }
            }
        }
        insertBlockData(headerRow, rowsToUpdate);
    };

    const sock = new Subscriber();
    sock.connect(zmqEndpoint);
    sock.subscribe("hashblock"); // Subscribe to block hashes instead of raw blocks

    Logger.debug(`[doge-zmq] Subscribed to rawblock on ${zmqEndpoint}`);

    // Check if there are any transactions lacking L1 information. If none, we can skip starting the listener entirely.
    const remainingL1Stmt = db.prepare(
        `SELECT COUNT(*) as cnt FROM txs WHERE l1_txhash IS NULL`
    );

    let remainingL1 = (remainingL1Stmt.get() as { cnt: number }).cnt;
    if (remainingL1 === 0) {
        Logger.info('[l1-listener] All transactions already have L1 info. Listener will not start.');
        return;
    }

    const totalCount = db.prepare(`SELECT COUNT(*) as count FROM txs`).get() as { count: number };
    const completedCountStmt = db.prepare(`SELECT COUNT(*) as count FROM txs WHERE l1_txhash IS NOT NULL`);
    const initialCompleted = (completedCountStmt.get() as { count: number }).count;

    Logger.info(`[l1-listener] Starting with ${totalCount.count} total transactions to track for L1 info.`);

    const l1BarOptions = {
        format: '[L1] Progressed block {blockHeight} |{bar}| {percentage}% | {value}/{total} tx | Elapsed: {duration_formatted}',
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        stopOnComplete: false,
        clearOnComplete: false,
        stream: process.stderr,
        linewrap: true,
        noTTYOutput: true
    } as const;

    const progressBar = bars
        ? bars.create(totalCount.count, initialCompleted, { blockHeight: "N/A" }, l1BarOptions as any)
        : new cliProgress.SingleBar(l1BarOptions as any);
    if (!(bars)) {
        (progressBar as cliProgress.SingleBar).start(totalCount.count, initialCompleted, { blockHeight: "N/A" });
    }

    for await (const [_topic, msg] of sock) {
        const blockHash = msg.toString('hex');
        Logger.debug(`[doge-zmq] Received block hash: ${blockHash}`);

        try {
            const blockJson = await dogeRpc(rpcUrl, rpcUser, rpcPass, 'getblock', [blockHash, 2]);
            processBlock(blockJson);

            const completedCount = (completedCountStmt.get() as { count: number }).count;
            progressBar.update(completedCount, { blockHeight: blockJson.height });

            Logger.info(
                `[l1-zmq] Block processed: ${blockHash} height=${blockJson.height} (txs=${blockJson.tx.length}) (size: ${blockJson.size} bytes)`
            );

            remainingL1 = (remainingL1Stmt.get() as { cnt: number }).cnt;
            if (remainingL1 === 0) {
                progressBar.stop();
                Logger.info('[l1-listener] All transactions have obtained L1 info. Stopping listener.');
                // Gracefully close socket before exiting loop (zeromq@6 has close())
                const maybeClose = (sock as any).close;
                if (typeof maybeClose === 'function') {
                    try { maybeClose.call(sock); } catch (_) { /* ignore */ }
                }
                break; // exit the for-await loop
            }
        } catch (e) {
            Logger.error(`[l1-zmq] Error processing block ${blockHash}: ${e instanceof Error ? e.stack || e.message : String(e)}`);
        }
    }
}

async function dogeRpc(url: string, user: string, pass: string, method: string, params: any[]): Promise<any> {
    const { URL } = require('url');
    const rpcUrl = new URL(url);
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
        },
    };
    const http = rpcUrl.protocol === 'https:' ? require('https') : require('http');

    return new Promise((resolve, reject) => {
        const req = http.request(rpcUrl, options, (res: any) => {
            let data = '';
            res.on('data', (chunk: any) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        reject(new Error(`RPC Error: ${JSON.stringify(json.error)}`));
                    } else {
                        resolve(json.result);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', (e: any) => {
            reject(e);
        });

        req.write(JSON.stringify({
            jsonrpc: '1.0',
            id: 'gemini-l1-listener',
            method: method,
            params: params
        }));
        req.end();
    });
}


export async function startL1ListenerRpc(
    db: DB,
    rpcUrl: string,
    rpcUser: string,
    rpcPass: string,
    targetAddrOrHash: string = "",
    bars?: cliProgress.MultiBar,
    startHeight?: number
) {
    Logger.debug(`[l1-listener-rpc] startL1ListenerRpc rpcUrl: ${rpcUrl}, targetAddrHash: ${targetAddrOrHash}`);

    const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO l1_headers (height, hash, version, prev_hash, merkle_root, timestamp, create_at, bits, nonce, size_bytes)
         VALUES (@height, @hash, @version, @prev_hash, @merkle_root, @timestamp, @create_at, @bits, @nonce, @size_bytes)`
    );

    const updateTxStmt = db.prepare(
        `UPDATE txs SET l1_txhash=@l1_txhash, l1_height=@l1_height, l1_timestamp=@l1_timestamp WHERE uid=@uid`
    );

    const insertBlockData = db.transaction((header: any, txRows: { uid: number; l1_txhash: string; l1_height: number; l1_timestamp: number }[]) => {
        insertStmt.run(header);
        for (const row of txRows) updateTxStmt.run(row);
    });

    const remainingL1Stmt = db.prepare(
        `SELECT COUNT(*) as cnt FROM txs WHERE l1_txhash IS NULL`
    );

    let remainingL1 = (remainingL1Stmt.get() as { cnt: number }).cnt;
    if (remainingL1 === 0) {
        Logger.info('[l1-listener-rpc] All transactions already have L1 info. Listener will not start.');
        return;
    }

    const totalCount = db.prepare(`SELECT COUNT(*) as count FROM txs`).get() as { count: number };
    const completedCountStmt = db.prepare(`SELECT COUNT(*) as count FROM txs WHERE l1_txhash IS NOT NULL`);
    const initialCompleted = (completedCountStmt.get() as { count: number }).count;

    Logger.info(`[l1-listener-rpc] Starting with ${totalCount.count} total transactions to track for L1 info.`);

    const l1BarOptions = {
        format: '[L1-RPC] Block {blockHeight} |{bar}| {percentage}% | {value}/{total} tx | Elapsed: {duration_formatted}',
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        stopOnComplete: false,
        clearOnComplete: false,
        stream: process.stderr,
        linewrap: true,
        noTTYOutput: true
    } as const;

    const progressBar = bars
        ? bars.create(totalCount.count, initialCompleted, { blockHeight: "N/A" }, l1BarOptions as any)
        : new cliProgress.SingleBar(l1BarOptions as any);
    if (!(bars)) {
        (progressBar as cliProgress.SingleBar).start(totalCount.count, initialCompleted, { blockHeight: "N/A" });
    }

    const processBlock = (blockJson: any) => {
        const height = blockJson.height;
        if (!height) {
            Logger.warn(`[l1-listener-rpc] Block JSON is missing height. Skipping.`);
            return;
        }

        // The block hash from the RPC response is the correct one, even for AuxPoW blocks.
        const blockHash = blockJson.hash;

        const nowSec = Math.floor(Date.now() / 1000);
        const nowMs = Date.now();
        const headerRow = {
            height,
            hash: blockHash,
            version: blockJson.version,
            prev_hash: blockJson.previousblockhash,
            merkle_root: blockJson.merkleroot,
            timestamp: blockJson.time,
            create_at: nowMs,
            bits: parseInt(blockJson.bits, 16), // bits is a hex string
            nonce: blockJson.nonce,
            size_bytes: blockJson.size,
        };

        const rowsToUpdate: { uid: number; l1_txhash: string; l1_height: number; l1_timestamp: number }[] = [];
        const transactions = blockJson.tx || [];
        Logger.info(`===============\n${JSON.stringify(transactions)}`)

        for (const tx of transactions) {
            const txHash = tx.txid;
            for (const vout of tx.vout) {
                // vout.value is in DOGE (float), convert to satoshis (integer)
                const valueInSatoshis = BigInt(Math.round(vout.value * 1e8));

                const scriptPubKey = vout.scriptPubKey;
                if (!scriptPubKey || !scriptPubKey.hex) continue;

                if (scriptPubKey.hex.toLowerCase().substring(6, 46) === targetAddrOrHash ||
                    vout.scriptPubKey.addresses?.includes(targetAddrOrHash)
                ) {
                    rowsToUpdate.push({
                        uid: Number(valueInSatoshis), // Assuming uid is the value in satoshis
                        l1_txhash: txHash,
                        l1_height: height,
                        l1_timestamp: blockJson.time,
                    });
                }
            }
        }
        insertBlockData(headerRow, rowsToUpdate);

        const completedCount = (completedCountStmt.get() as { count: number }).count;
        progressBar.update(completedCount, { blockHeight: height });

        if (rowsToUpdate.length > 0) {
            Logger.info(`[l1-rpc] updated ${rowsToUpdate.length} transactions, progress: ${completedCount}/${totalCount.count}`);
        }

        Logger.info(
            `[l1-rpc] Block processed: ${blockHash} height=${height} (txs=${transactions.length}) (size: ${blockJson.size} bytes)`
        );
    };

    let currentHeight: number;
    if (startHeight && startHeight > 0) {
        currentHeight = startHeight;
        Logger.info(`[l1-listener-rpc] Starting scan from specified height ${currentHeight}`);
    } else {
        const latestHeaderStmt = db.prepare(`SELECT MAX(height) as height FROM l1_headers`);
        const latestHeader = latestHeaderStmt.get() as { height: number | null };

        currentHeight = (latestHeader.height ?? 0);
        if (currentHeight > 0) {
            currentHeight++;
            Logger.info(`[l1-listener-rpc] Resuming scan from block ${currentHeight}`);
        } else {
            currentHeight = 1;
            Logger.info(`[l1-listener-rpc] Starting scan from block 1 (no previous data or start height specified)`);
        }
    }


    while (true) {
        try {
            const latestBlockCount = await dogeRpc(rpcUrl, rpcUser, rpcPass, 'getblockcount', []);

            while (currentHeight <= latestBlockCount) {
                const blockHash = await dogeRpc(rpcUrl, rpcUser, rpcPass, 'getblockhash', [currentHeight]);
                // Use verbosity 2 to get a detailed JSON object with parsed transactions
                const blockJson = await dogeRpc(rpcUrl, rpcUser, rpcPass, 'getblock', [blockHash, 2]);

                processBlock(blockJson);

                remainingL1 = (remainingL1Stmt.get() as { cnt: number }).cnt;
                if (remainingL1 === 0) {
                    progressBar.stop();
                    Logger.info('[l1-listener-rpc] All transactions have obtained L1 info. Stopping listener.');
                    return;
                }

                currentHeight++;
            }

        } catch (e) {
            Logger.error(`[l1-listener-rpc] Error during block processing loop: ${e instanceof Error ? e.stack || e.message : String(e)}`);
        }

        // Wait for a bit before polling for new blocks
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
    }
}

// L2 listener placeholder (e.g., for EVM chain via WebSocket)
export async function startL2Listener(
    db: DB,
    rpcEndpoint: string,
    moatAddress: string,
    bars?: cliProgress.MultiBar
): Promise<void> {
    const provider = new (ethers as any).JsonRpcProvider(rpcEndpoint as any);
    provider.pollingInterval = 500;

    const iface = new Interface(MoatABI);
    const topic0 = iface.getEvent("WithdrawalQueued").topicHash;
    const moatLower = moatAddress.toLowerCase();

    const updateL2Tx = db.prepare(
        `UPDATE txs SET l2_txhash=@tx, l2_height=@h, l2_timestamp=@ts WHERE uid=@uid`
    );
    const clearHeight = db.prepare(
        `UPDATE txs SET l2_txhash=NULL, l2_height=NULL, l2_timestamp=NULL WHERE l2_height = ?`
    );
    const insertL2Header = db.prepare(
        `INSERT OR REPLACE INTO l2_headers (height, hash, timestamp, create_at) VALUES (@height, @hash, @timestamp, @create_at)`
    );
    const deleteL2Header = db.prepare(
        `DELETE FROM l2_headers WHERE height = ?`
    );

    // 3) Pump loop triggered by new heads; guarantees sequential processing
    let latestTarget = await provider.getBlockNumber();
    latestTarget=50018;
    let pumping = false;
    let lastProcessed = latestTarget;
    let lastHash = await provider.getBlock(latestTarget).then((block: any) => block.hash);
    Logger.debug(`[l2-listener] lastProcessed,lastHash: ${lastProcessed},${lastHash}`);

    // Get total transaction count for progress tracking
    const totalCount = db.prepare(`SELECT COUNT(*) as count FROM txs`).get() as { count: number };
    Logger.info(`[l2-listener] Starting with ${totalCount.count} total transactions to track`);

    // Create progress bar
    const l2BarOptions = {
        format: '[L2] Progress |{bar}| {percentage}% | {value}/{total} tx | Elapsed: {duration_formatted}',
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        stopOnComplete: false,   // keep the bar visible after completion
        clearOnComplete: false,  // do not clear the bar so user can see final state
        stream: process.stderr,  // use stderr so it doesn't clash with other stdout bars
        linewrap: true,          // keep bar on its own line
        noTTYOutput: true        // force rendering even if TTY detection fails
    } as const;

    const progressBar = bars
        ? bars.create(totalCount.count, 0, {}, l2BarOptions as any)
        : new cliProgress.SingleBar(l2BarOptions as any);
    if (!(bars)) {
        (progressBar as cliProgress.SingleBar).start(totalCount.count, 0);
        (progressBar as cliProgress.SingleBar).render();
    }

    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (lastProcessed < latestTarget) {
                const nextHeight = lastProcessed + 1;
                const block = await provider.getBlock(nextHeight, true);
                if (!block) {
                    Logger.error(`l2 get block ${nextHeight} failed`);
                    break;
                } // wait for node to have the block

                // Reorg detection: parent of next must equal hash of lastProcessed
                if (lastProcessed > 0 && lastHash && block.parentHash !== lastHash) {
                    Logger.warn(`[l2-listener] reorg at ${nextHeight}: parent ${block.parentHash} != expected ${lastHash}. Rolling back ${lastProcessed}`);
                    // In a reorg, the 'lastProcessed' block is now orphaned.
                    // We must delete its header and clear its txs from our DB.
                    const rollback = db.transaction((h: number) => {
                        deleteL2Header.run(h);
                        clearHeight.run(h);
                    });
                    rollback(lastProcessed);

                    // Step back one block
                    lastProcessed -= 1;

                    // Reload the hash for the new 'lastProcessed' height from our DB.
                    if (lastProcessed > 0) {
                        const newLastHeader = db.prepare(`SELECT hash FROM l2_headers WHERE height = ?`).get(lastProcessed) as { hash: string } | undefined;
                        lastHash = newLastHeader?.hash ?? null;
                        // As a fallback if DB is somehow inconsistent, fetch from RPC.
                        if (!lastHash) {
                            const prev = await provider.getBlock(lastProcessed);
                            lastHash = prev?.hash ?? null;
                        }
                    } else {
                        lastHash = null;
                    }
                    continue; // try again with the new nextHeight
                }

                const txsToUpdate: { uid: number; tx: string; h: number; ts: number }[] = [];
                Logger.info(`[l2] processing block ${nextHeight} with ${block.transactions.length} transactions`);

                let receiptMap: Record<string, any> = {};
                try {
                    const receipts: any[] = await provider.send("eth_getBlockReceipts", [block.hash]);
                    if (Array.isArray(receipts)) {
                        for (const r of receipts) receiptMap[(r.transactionHash as string).toLowerCase()] = r;
                        Logger.debug(`[l2] fetched ${receipts.length} receipts via eth_getBlockReceipts`);
                    }
                } catch (e) {
                    // node may not support; silently fallback
                }

                for (const raw of block.transactions as any[]) {
                    Logger.debug(`[l2] tx candidate: ${typeof raw === "string" ? raw : JSON.stringify({ hash: raw.hash, to: raw.to, from: raw.from, value: raw.value })}`);
                    let tx: any;
                    if (typeof raw === "string") {
                        tx = await provider.getTransaction(raw);
                    } else {
                        tx = raw;
                    }
                    if (!tx) continue;


                    if (tx.to?.toLowerCase() !== moatLower) {
                        Logger.debug(`[l2] skipping tx ${tx.hash} (to: ${tx.to})`);
                        continue;
                    }
                    Logger.debug(`[l2] found moat tx ${tx.hash}`);
                    // obtain receipt: from map or rpc
                    let receipt = receiptMap[tx.hash.toLowerCase()];
                    if (!receipt) continue; // if not in map, skip (node should support batch receipts)

                    const matchingLogs = receipt.logs.filter((l: any) => l.address.toLowerCase() === moatLower && l.topics[0] === topic0);
                    if (matchingLogs.length === 0) continue;

                    for (const log of matchingLogs) {
                        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
                        const amount: bigint = parsed.args.amount ?? parsed.args[2];
                        const uidBig = (amount) / BigInt(1e10);
                        const uidNum = Number(uidBig);
                        txsToUpdate.push({ uid: uidNum, tx: tx.hash, h: nextHeight, ts: block.timestamp });
                        Logger.debug(`[l2] updating uid ${uidNum} -> ${tx.hash}`);
                    }
                }

                db.transaction(() => {
                    //clearHeight.run(nextHeight);
                    for (const txData of txsToUpdate) updateL2Tx.run(txData);
                    insertL2Header.run({ height: nextHeight, hash: block.hash, timestamp: block.timestamp, create_at: Math.floor(Date.now() / 1000) });
                })();

                lastProcessed = nextHeight;
                lastHash = block.hash;
                Logger.info(`[l2-listener] processed block ${nextHeight}`);

                if (txsToUpdate.length > 0) {
                    const completedCount = db.prepare(`SELECT COUNT(*) as count FROM txs WHERE l2_txhash IS NOT NULL AND l2_txhash != ''`).get() as { count: number };
                    progressBar.update(completedCount.count);
                    Logger.debug(`[l2] updated ${txsToUpdate.length} transactions, progress: ${completedCount.count}/${totalCount.count}`);
                } else {
                    progressBar.render();
                    const completedCount = db.prepare(`SELECT COUNT(*) as count FROM txs WHERE l2_txhash IS NOT NULL AND l2_txhash != ''`).get() as { count: number };
                    Logger.debug(`[l2] no updates in block ${nextHeight}, progress: ${completedCount.count}/${totalCount.count}`);
                }

                const pendingCount = db.prepare(`SELECT COUNT(*) as count FROM txs WHERE l2_txhash IS NULL OR l2_txhash = ''`).get() as { count: number };
                if (pendingCount.count === 0) {
                    progressBar.update(totalCount.count);
                    progressBar.stop();
                    Logger.info(`[l2-listener] All transactions have L2 information. Stopping L2 listener.`);
                    provider.removeAllListeners();
                    break;
                }
            }
        } catch (e) {
            Logger.error(`[l2-listener] pump error ${e instanceof Error ? e.stack || e.message : String(e)}`);
        } finally {
            pumping = false;
        }
    }

    provider.on("block", async (bn: number) => {
        latestTarget = Math.max(latestTarget, bn);
        await pump();
    });

    // Kick off once at startup to catch up to current head
    await pump();

    Logger.debug(`[l2-listener] started on ${rpcEndpoint}`);
}

// Unified entry
export function startCrossChainListeners(opts: {
    l1TargetHashOrAddr: string;          // 20-byte hex without 0x
    l1ListenMode: 'zmq' | 'rpc';
    zmqEndpoint?: string;
    l1RpcUrl?: string;
    l1RpcUser?: string;
    l1RpcPass?: string;
    l1StartHeight?: number;
    l2Rpc: string;
    moatAddress: string;
    dbPath?: string;
    transactions: TransactionRequest[]
}): Promise<void> {
    const { l1TargetHashOrAddr: l1TargetHash, l1ListenMode, zmqEndpoint, l1RpcUrl, l1RpcUser, l1RpcPass, l1StartHeight, l2Rpc, moatAddress } = opts;
    const db = createTxDatabase(opts.dbPath ?? "withdrawal.db");
    // db.prepare(`DELETE FROM txs`).run();

    for (const tx of opts.transactions) {
        if (!tx.value) continue;
        const uid: bigint = (BigInt(tx.value.toString()) - BigInt(parseEther("0.1").toString())) / BigInt(1e10);
        db.prepare(`INSERT OR IGNORE INTO txs (uid) VALUES (@uid)`).run({ uid });
    }

    // Shared MultiBar to prevent bars overwriting each other
    const bars = new cliProgress.MultiBar({
        clearOnComplete: false,
        hideCursor: true,
        stopOnComplete: false,
        stream: process.stderr,
        noTTYOutput: true,
        format: '{bar} {percentage}% | {value}/{total}'
    }, cliProgress.Presets.shades_grey);

    let l1Promise: Promise<void>;
    if (l1ListenMode === 'rpc') {
        if (!l1RpcUrl || !l1RpcUser || !l1RpcPass) {
            throw new Error('L1 RPC URL, user, and password are required for rpc mode.');
        }
        const l1PromiseTask = async () => {
            if (!opts.l1StartHeight || opts.l1StartHeight === 0) {
                opts.l1StartHeight = await dogeRpc(l1RpcUrl, l1RpcUser, l1RpcPass, 'getblockcount', []);
                Logger.info(`[cross-chain] l1StartHeight not provided, using current L1 block height: ${opts.l1StartHeight}`);
            }
            return startL1ListenerRpc(db, l1RpcUrl, l1RpcUser, l1RpcPass, l1TargetHash, bars, opts.l1StartHeight);
        };
        l1Promise = l1PromiseTask().catch(e => {
            Logger.error(`L1 (RPC) listener error ${e instanceof Error ? e.stack || e.message : String(e)}`);
            throw e;
        });
    } else {
        if (!zmqEndpoint || !l1RpcUrl || !l1RpcUser || !l1RpcPass) {
            throw new Error('ZMQ endpoint and L1 RPC credentials are required for zmq mode.');
        }
        l1Promise = startL1Listener(db, zmqEndpoint, l1RpcUrl, l1RpcUser, l1RpcPass, l1TargetHash, bars).catch(e => {
            Logger.error(`L1 (ZMQ) listener error ${e instanceof Error ? e.stack || e.message : String(e)}`);
            throw e;
        });
    }
    const l2PromiseTask = startL2Listener(db, l2Rpc, moatAddress, bars).catch((e) => {
        Logger.error(`L2 listener error ${e instanceof Error ? e.stack || e.message : String(e)}`);
        throw e;
    });

    return Promise.all([l1Promise, l2PromiseTask]).then(() => {
        try { bars.stop(); } catch (_) { }
        Logger.info('[cross-chain] Both listeners finished. Executing statistic().');
        statistic(db);
    });
}

export function statistic(_db: DB): void {
    type Layer = 'l1' | 'l2';

    function percentile(sortedArr: number[], p: number): number {
        if (sortedArr.length === 0) return 0;
        const idx = (p / 100) * (sortedArr.length - 1);
        const lower = Math.floor(idx);
        const upper = Math.ceil(idx);
        if (lower === upper) return sortedArr[lower];
        const weight = idx - lower;
        return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
    }

    function printDelayTable(delays: number[]) {
        const table = new Table({ head: ["Metric", "Seconds"] });
        delays.sort((a, b) => a - b);
        const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
        table.push(
            ["Max", delays[delays.length - 1] ?? "N/A"],
            ["Min", delays[0] ?? "N/A"],
            ["Avg", avg.toFixed(2)],
            ["Median", percentile(delays, 50)],
            ["P95", percentile(delays, 95)],
            ["P99", percentile(delays, 99)]
        );
        Logger.title("\nDelay Statistics (L2 → L1):\n" + table.toString());
    }

    function printLayerTable(layer: Layer, maxTxPerBlock: number, maxTps: number, avgTps: number) {
        const table = new Table({ head: ["Layer", "Max Tx/Block", "Max block TPS", "Avg TPS"] });
        table.push([layer.toUpperCase(), maxTxPerBlock, maxTps, avgTps.toFixed(2)]);
        Logger.title(`\n${layer.toUpperCase()} throughput:` + "\n" + table.toString());
    }

    function calcLayerStats(db: DB, layer: Layer) {
        const prefix = layer === 'l1' ? 'l1' : 'l2';
        const blockCol = `${prefix}_height`;

        const blockRows = db.prepare(`SELECT ${blockCol} as height, COUNT(*) as cnt FROM txs WHERE ${blockCol} IS NOT NULL GROUP BY ${blockCol}`).all() as { height: number, cnt: number }[];
        if (blockRows.length === 0) {
            Logger.warn(`[statistic] No ${layer.toUpperCase()} block data.`);
            return;
        }
        const maxTxPerBlock = Math.max(...blockRows.map(r => r.cnt));

        // Build counts by height and ensure we always use consecutive header timestamps (no skipping empty blocks)
        const blockRowsWithCnt = db.prepare(`SELECT ${blockCol} as height, COUNT(*) as cnt FROM txs WHERE ${blockCol} IS NOT NULL GROUP BY ${blockCol} ORDER BY ${blockCol}`).all() as { height: number, cnt: number }[];

        const minHeight = blockRowsWithCnt[0].height;
        const maxHeight = blockRowsWithCnt[blockRowsWithCnt.length - 1].height;
        const headerTable = layer === 'l1' ? 'l1_headers' : 'l2_headers';
        const timeCol = 'timestamp';

        // Fetch header timestamps for [minHeight-1, maxHeight]
        const headerRows = db.prepare(`SELECT height, ${timeCol} as ts FROM ${headerTable} WHERE height BETWEEN ${minHeight - 1} AND ${maxHeight} ORDER BY height`).all() as { height: number, ts: number }[];
        const headerTs: Record<number, number> = {};
        for (const h of headerRows) headerTs[h.height] = h.ts;

        // If L1 and the create_at looks like ms (>= 1e11), normalize to seconds
        const looksMs = layer === 'l1' && Object.values(headerTs).some(v => typeof v === 'number' && v >= 1e11);
        const toSec = (v: number) => looksMs ? (v / 1000) : v;

        const blockTable = new Table({ head: ["Block height", "Tx count", "Δt(s)", "Block TPS"] });
        const instantaneousTps: number[] = [];
        const missingPrev: number[] = [];
        const missingCurr: number[] = [];
        for (const row of blockRowsWithCnt) {
            const currTsRaw = headerTs[row.height];
            const prevTsRaw = headerTs[row.height - 1];
            const currTs: number | undefined = typeof currTsRaw === 'number' ? toSec(currTsRaw) : undefined;
            const prevTs: number | undefined = typeof prevTsRaw === 'number' ? toSec(prevTsRaw) : undefined;
            if (typeof currTs === 'number' && typeof prevTs === 'number') {
                const deltaT = currTs - prevTs;
                if (deltaT > 0) {
                    const tpsVal = row.cnt / deltaT;
                    instantaneousTps.push(tpsVal);
                    blockTable.push([row.height, row.cnt, Number(deltaT.toFixed(2)), tpsVal.toFixed(2)]);
                } else {
                    // Non-positive delta (equal or out-of-order timestamps)
                    blockTable.push([row.height, row.cnt, "-", "-"]);
                }
            } else {
                // Missing header(s)
                if (typeof currTs !== 'number') missingCurr.push(row.height);
                if (typeof prevTs !== 'number') missingPrev.push(row.height - 1);
                blockTable.push([row.height, row.cnt, "-", "-"]);
            }
        }

        Logger.title(`\n${layer.toUpperCase()} per-block stats:` + "\n" + blockTable.toString());

        // Diagnostics for missing headers
        const uniq = (arr: number[]) => Array.from(new Set(arr)).sort((a, b) => a - b);
        const missPrevUniq = uniq(missingPrev);
        const missCurrUniq = uniq(missingCurr);
        if (missPrevUniq.length || missCurrUniq.length) {
            const sample = (xs: number[]) => xs.slice(0, 10).join(', ') + (xs.length > 10 ? ` ... (+${xs.length - 10})` : '');
            if (missPrevUniq.length) Logger.warn(`[statistic] Missing previous headers (${layer.toUpperCase()}): ${sample(missPrevUniq)}`);
            if (missCurrUniq.length) Logger.warn(`[statistic] Missing current headers (${layer.toUpperCase()}): ${sample(missCurrUniq)}`);
            Logger.warn(`[statistic] Missing headers cause '-' in Δt/TPS. Fill ${layer.toUpperCase()} headers for consecutive heights to compute instantaneous TPS.`);
        }

        const maxTps = instantaneousTps.length ? Math.max(...instantaneousTps) : 0;

        // New Avg TPS definition: total tracked txs divided by time span between earliest & latest tx blocks
        const totalTrackedTx = blockRowsWithCnt.reduce((sum, r) => sum + r.cnt, 0);
        const firstHeight = blockRowsWithCnt[0].height;
        const lastHeight = blockRowsWithCnt[blockRowsWithCnt.length - 1].height;
        const firstTsRaw = headerTs[firstHeight];
        const lastTsRaw = headerTs[lastHeight];
        let avgTps: number = 0;
        if (typeof firstTsRaw === 'number' && typeof lastTsRaw === 'number') {
            const span = toSec(lastTsRaw) - toSec(firstTsRaw);
            if (span > 0) avgTps = totalTrackedTx / span;
            else Logger.warn(`[statistic] Non-positive time span (${span}) for ${layer.toUpperCase()} average TPS calculation.`);
        } else {
            Logger.warn(`[statistic] Missing timestamps for first (${firstHeight}) or last (${lastHeight}) block; Avg TPS set to 0.`);
        }

        printLayerTable(layer, maxTxPerBlock, maxTps, avgTps);
    }

    function printBasicStats(total: number, l2Success: number, l1Success: number) {
        const table = new Table({ head: ["Metric", "Count"] });
        const successRate = total > 0 ? (l1Success / l2Success * 100).toFixed(2) + "%" : "N/A";
        table.push(
            ["Sent (Total)", total],
            ["L2 Success", l2Success],
            ["L1 Success", l1Success],
            ["Success Rate", successRate]
        );
        Logger.title("\nBasic Transaction Stats:\n" + table.toString());
    }

    const db = _db;

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM txs`).get() as { cnt: number };
    const l2Success = db.prepare(`SELECT COUNT(*) as cnt FROM txs WHERE l2_txhash IS NOT NULL`).get() as { cnt: number };
    const l1Success = db.prepare(`SELECT COUNT(*) as cnt FROM txs WHERE l1_txhash IS NOT NULL`).get() as { cnt: number };
    printBasicStats(total.cnt, l2Success.cnt, l1Success.cnt);


    const delayRows = db.prepare(`SELECT l2_timestamp, l1_timestamp FROM txs WHERE l1_timestamp IS NOT NULL AND l2_timestamp IS NOT NULL`).all() as { l2_timestamp: number, l1_timestamp: number }[];
    const delays = delayRows.map(r => r.l1_timestamp - r.l2_timestamp).filter(d => d >= 0);
    if (delays.length === 0) {
        Logger.warn('[statistic] No completed cross-chain transactions found.');
    } else {
        printDelayTable(delays);
    }

    calcLayerStats(db, 'l2');
    calcLayerStats(db, 'l1');
}

// Standalone execution
if (require.main === module) {
    const bs58check = require('bs58check');
    const program = new Command();
    program
        .option('--l1-target-addr <hash>', 'dogecoin address', "ngFbQoFBoeTrxM5MBoMsopunoFsBKHtQdb")
        .option('--l1-listen-mode <mode>', 'L1 listener mode: zmq or rpc', 'rpc')
        .option('--zmq-endpoint <endpoint>', 'Dogecoin ZMQ endpoint (for zmq mode)', "tcp://localhost:28332")
        .option('--l1-rpc-url <url>', 'Dogecoin RPC URL (for rpc mode)', 'http://127.0.0.1:44555')
        .option('--l1-rpc-user <user>', 'Dogecoin RPC username (for rpc mode)', 'dogecoin')
        .option('--l1-rpc-pass <pass>', 'Dogecoin RPC password (for rpc mode)', 'dogecoin')
        .option('--l1-start-height <height>', 'Specify L1 block height to start scanning from (for rpc mode)', (val) => parseInt(val, 10))
        .option('--l2-rpc <url>', 'L2 RPC endpoint', "https://rpc.dg.unifra.xyz")
        .option('--moat-address <address>', 'Moat contract address', "0x3eD6eD3c572537d668F860d4d556B8E8BF23E1E2")
        .option('--db-path <path>', 'Path to SQLite database file', "withdrawal.db")
        .parse(process.argv);

    const options = program.opts();

    (async () => {
        // Decode base58 address to 20-byte hex (skip version byte)
        // const decoded = bs58check.decode(options.l1TargetAddr);
        // const targetHash = Buffer.from(decoded.subarray(1)).toString('hex');
        // Logger.info(`Decoded target address ${options.l1TargetAddr} to ${targetHash}`);
        await startCrossChainListeners({
            l1TargetHashOrAddr: options.l1TargetAddr,
            l1ListenMode: options.l1ListenMode,
            zmqEndpoint: options.zmqEndpoint,
            l1RpcUrl: options.l1RpcUrl,
            l1RpcUser: options.l1RpcUser,
            l1RpcPass: options.l1RpcPass,
            l1StartHeight: options.l1StartHeight,
            l2Rpc: options.l2Rpc,
            moatAddress: options.moatAddress,
            dbPath: options.dbPath,
            transactions: [] // Standalone mode doesn't pre-populate transactions
        });
    })().catch((e) => {
        Logger.error(`cross-chain listeners terminated with error: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    });
}
