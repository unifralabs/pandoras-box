import BetterSqlite3 from "better-sqlite3";
import cliProgress from "cli-progress";
import Table from "cli-table3";
import { Command } from 'commander';
import crypto from "crypto";
import { ethers } from "ethers";
import process from "node:process";
import { Subscriber } from "zeromq";
import MoatABI from "../abi/moat";
import Logger from "../logger/logger";
type DB = InstanceType<typeof BetterSqlite3>;
const { utils, providers } = ethers as any;
const Interface = (utils && utils.Interface) || (ethers as any).Interface;
const parseEther = (ethers as any).utils?.parseEther || ((value: string) => {
    // Convert "0.1" to "100000000000000000" (0.1 ETH in wei)
    const parts = value.split('.');
    if (parts.length === 1) {
        return BigInt(value + '000000000000000000');
    } else {
        const whole = parts[0];
        const decimal = parts[1].padEnd(18, '0').substring(0, 18);
        return BigInt(whole + decimal);
    }
});

type TransactionRequest = any;

/** Decode Bitcoin-style VarInt. Returns [value, newOffset] */
function readVarInt(buf: Buffer, offset: number): [number, number] {
    const first = buf[offset];
    if (first < 0xfd) return [first, offset + 1];
    if (first === 0xfd) return [buf.readUInt16LE(offset + 1), offset + 3];
    if (first === 0xfe) return [buf.readUInt32LE(offset + 1), offset + 5];
    // first === 0xff
    const lo = buf.readUInt32LE(offset + 1);
    const hi = buf.readUInt32LE(offset + 5);
    return [hi * 0x100000000 + lo, offset + 9];
}

function extractHeightFromBlock(block: Buffer): number | null {
    let offset = 80; // skip header
    // tx count
    const [txCount, off1] = readVarInt(block, offset);
    if (txCount === 0) return null;
    offset = off1;
    // Parse first (coinbase) tx
    // version
    offset += 4;
    // input count
    const [vinCnt, off2] = readVarInt(block, offset);
    offset = off2;
    if (vinCnt === 0) return null;
    // prev txid + vout
    offset += 32 + 4;
    // script length
    const [scriptLen, off3] = readVarInt(block, offset);
    offset = off3;
    const scriptStart = offset;
    const script = block.subarray(scriptStart, scriptStart + scriptLen);
    if (script.length === 0) return null;
    const pushLen = script[0];
    if (pushLen === 0 || pushLen + 1 > script.length) return null;
    const heightBytes = script.subarray(1, 1 + pushLen);
    // little-endian to int
    let height = 0;
    for (let i = heightBytes.length - 1; i >= 0; i--) {
        height = (height << 8) | heightBytes[i];
    }
    return height;
}

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

function parseDogeCoinTransactions(block: Buffer): ParsedTx[] {
    const txs: ParsedTx[] = [];
    let offset = 80; // header
    const [txCount, off1] = readVarInt(block, offset);
    offset = off1;

    for (let i = 0; i < txCount; i++) {
        const txStart = offset;

        // version
        offset += 4;

        // Dogecoin currently has no segwit, so directly read vin count
        const [vinCnt, offVinCnt] = readVarInt(block, offset);
        offset = offVinCnt;
        for (let vi = 0; vi < vinCnt; vi++) {
            // prev hash + index
            offset += 32 + 4;
            // script len
            const [scriptLen, offSL] = readVarInt(block, offset);
            offset = offSL + scriptLen;
            // sequence
            offset += 4;
        }

        // vout count
        const [voutCnt, offVoutCnt] = readVarInt(block, offset);
        offset = offVoutCnt;
        const vouts: VoutInfo[] = [];

        for (let vo = 0; vo < voutCnt; vo++) {
            // value (8) little-endian satoshis
            const valueLE = block.readBigUInt64LE(offset);
            offset += 8;
            const [pkLen, offPK] = readVarInt(block, offset);
            offset = offPK;
            const script = block.subarray(offset, offset + pkLen);
            offset += pkLen;
            const p2pkh = isP2PKH(script);
            const addrHash = p2pkh ? script.subarray(3, 23).toString("hex") : "";

            vouts.push({
                value: valueLE,
                scriptHex: script.toString("hex"),
                isP2PKH: p2pkh,
                addrHash: addrHash,
                uid: valueLE,
            });
        }

        // locktime
        offset += 4;

        const txEnd = offset;
        const txBuf = block.subarray(txStart, txEnd);
        const txHash = crypto
            .createHash("sha256")
            .update(crypto.createHash("sha256").update(txBuf).digest())
            .digest()
            .reverse()
            .toString("hex");
        txs.push({ hash: txHash, vouts });
    }
    return txs;
}

/**
 * Simple script to test Dogecoin's ZMQ interface.
 *
 * Make sure your `dogecoind` instance is started with the following option:
 *   -zmqpubrawblock=tcp://127.0.0.1:28332
 *
 * Then run this script with ts-node or after transpiling to JavaScript.
 */
export function createTxDatabase(dbPath = "doge_headers.db"): DB {
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
    targetAddrHash: string = ""
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

    const sock = new Subscriber();
    sock.connect(zmqEndpoint);
    sock.subscribe("rawblock");

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

    const progressBar = new cliProgress.SingleBar({
        format: '[L1] Progressed block {blockHeight} |{bar}| {percentage}% | {value}/{total} tx',
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        stopOnComplete: false,
        clearOnComplete: false,
        stream: process.stderr,
        linewrap: true,
        noTTYOutput: true
    });
    progressBar.start(totalCount.count, initialCompleted, { blockHeight: "N/A" });

    for await (const [_topic, message] of sock) {
        Logger.debug(`[doge-zmq] Received rawblock message (${message.length} bytes)`);
        if (message.length < 80) {
            Logger.warn(`[doge-zmq] Received short rawblock message (${message.length} bytes), expected >= 80. Skipping.`);
            continue;
        }

        const header = message.subarray(0, 80);
        const hashBuffer = crypto
            .createHash("sha256")
            .update(
                crypto.createHash("sha256").update(header).digest()
            )
            .digest();
        const blockHash = Buffer.from(hashBuffer).reverse().toString("hex");

        const height = extractHeightFromBlock(message);

        const heightInfo = height !== null ? `height=${height}` : "height=unknown";

        const parsedTxs = parseDogeCoinTransactions(message);
        const txHashes = parsedTxs.map((t) => t.hash);

        if (height !== null) {
            const version = message.readInt32LE(0);
            const prevHash = Buffer.from(message.subarray(4, 36)).reverse().toString("hex");
            const merkleRoot = Buffer.from(message.subarray(36, 68)).reverse().toString("hex");
            const timestamp = message.readUInt32LE(68);
            const bits = message.readUInt32LE(72);
            const nonce = message.readUInt32LE(76);

            const nowTs = Math.floor(Date.now() / 1000);
            const headerRow = {
                height,
                hash: blockHash,
                version,
                prev_hash: prevHash,
                merkle_root: merkleRoot,
                timestamp,
                create_at: nowTs,
                bits,
                nonce,
                size_bytes: message.length,
            };

            let rowsToUpdate = [];
            for (const ptx of parsedTxs) {
                for (const vout of ptx.vouts) {
                    Logger.debug(`[doge-zmq] vout.addrHash: ${vout.addrHash}, targetAddrHash: ${targetAddrHash},vout.uid: ${vout.uid}`);
                    if (vout.addrHash === targetAddrHash) {
                        rowsToUpdate.push({
                            uid: Number(vout.uid),
                            l1_txhash: ptx.hash,
                            l1_height: height,
                            l1_timestamp: nowTs,
                        });
                    }
                }
            }
            insertBlockData(headerRow, rowsToUpdate);

            const completedCount = (completedCountStmt.get() as { count: number }).count;
            progressBar.update(completedCount, { blockHeight: height });

            if (rowsToUpdate.length > 0) {
                Logger.debug(`[l1] updated ${rowsToUpdate.length} transactions, progress: ${completedCount}/${totalCount.count}`);
            }

            // After inserting/updating, check again if all transactions now have L1 info.
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
        }
        Logger.debug(
            `[doge-zmq] New block processed: ${blockHash} ${heightInfo} (txs=${txHashes.length}) (size: ${message.length} bytes)`
        );
    }
}

// L2 listener placeholder (e.g., for EVM chain via WebSocket)
export async function startL2Listener(
    db: DB,
    rpcEndpoint: string,
    moatAddress: string
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
    let pumping = false;
    let lastProcessed = latestTarget;
    let lastHash = await provider.getBlock(latestTarget).then((block: any) => block.hash);
    Logger.debug(`[l2-listener] lastProcessed,lastHash: ${lastProcessed},${lastHash}`);

    // Get total transaction count for progress tracking
    const totalCount = db.prepare(`SELECT COUNT(*) as count FROM txs`).get() as { count: number };
    Logger.info(`[l2-listener] Starting with ${totalCount.count} total transactions to track`);

    // Create progress bar
    const progressBar = new cliProgress.SingleBar({
        format: '[L2] Progress |{bar}| {percentage}% | {value}/{total} tx',
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
        stopOnComplete: false,   // keep the bar visible after completion
        clearOnComplete: false,  // do not clear the bar so user can see final state
        stream: process.stderr,  // use stderr so it doesn't clash with other stdout bars
        linewrap: true,          // keep bar on its own line
        noTTYOutput: true        // force rendering even if TTY detection fails
    });
    progressBar.start(totalCount.count, 0);
    progressBar.render(); // render immediately

    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (lastProcessed < latestTarget) {
                const nextHeight = lastProcessed + 1;
                const block = await provider.getBlock(nextHeight, true);
                if (!block) break; // wait for node to have the block

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
                Logger.debug(`[l2] processing block ${nextHeight} with ${block.transactions.length} transactions`);

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
                    clearHeight.run(nextHeight);
                    for (const txData of txsToUpdate) updateL2Tx.run(txData);
                    insertL2Header.run({ height: nextHeight, hash: block.hash, timestamp: block.timestamp, create_at: Math.floor(Date.now() / 1000) });
                })();

                lastProcessed = nextHeight;
                lastHash = block.hash;
                Logger.debug(`[l2-listener] processed block ${nextHeight}`);

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
                    return;
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
    l1TargetHash: string;          // 20-byte hex without 0x
    zmqEndpoint: string;
    l2Rpc: string;
    moatAddress: string;
    dbPath?: string;
    transactions: TransactionRequest[]
}): Promise<void> {
    const { l1TargetHash, zmqEndpoint, l2Rpc, moatAddress, dbPath } = opts;
    const db = createTxDatabase(dbPath);
    // db.prepare(`DELETE FROM txs`).run();

    for (const tx of opts.transactions) {
        if (!tx.value) continue;
        const uid: bigint = (BigInt(tx.value.toString()) - BigInt(parseEther("0.1").toString())) / BigInt(1e10);
        db.prepare(`INSERT INTO txs (uid) VALUES (@uid)`).run({ uid });
    }

    const endpoint = zmqEndpoint;
    const l1Promise = startL1Listener(db, endpoint, l1TargetHash).catch((e) => {
        Logger.error(`L1 listener error ${e instanceof Error ? e.stack || e.message : String(e)}`);
        throw e;
    });
    const l2Promise = startL2Listener(db, l2Rpc, moatAddress).catch((e) => {
        Logger.error(`L2 listener error ${e instanceof Error ? e.stack || e.message : String(e)}`);
        throw e;
    });

    return Promise.all([l1Promise, l2Promise]).then(() => {
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
        const avg = delays.reduce((a,b)=>a+b,0)/delays.length;
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
        const table = new Table({ head: ["Layer", "Max Tx/Block", "Max TPS", "Avg TPS"] });
        table.push([layer.toUpperCase(), maxTxPerBlock, maxTps, avgTps.toFixed(2)]);
        Logger.title(`\n${layer.toUpperCase()} throughput:` + "\n" + table.toString());
    }

    function calcLayerStats(db: DB, layer: Layer) {
        const prefix = layer === 'l1' ? 'l1' : 'l2';
        const blockCol = `${prefix}_height`;
        const tsCol = `${prefix}_timestamp`;

        const blockRows = db.prepare(`SELECT ${blockCol} as height, COUNT(*) as cnt FROM txs WHERE ${blockCol} IS NOT NULL GROUP BY ${blockCol}`).all() as { height: number, cnt: number }[];
        if (blockRows.length === 0) {
            Logger.warn(`[statistic] No ${layer.toUpperCase()} block data.`);
            return;
        }
        const maxTxPerBlock = Math.max(...blockRows.map(r => r.cnt));

        
        const blockRowsWithTs = db.prepare(`SELECT ${blockCol} as height, COUNT(*) as cnt, MAX(${tsCol}) as ts FROM txs WHERE ${blockCol} IS NOT NULL GROUP BY ${blockCol} ORDER BY ${blockCol}`).all() as { height: number, cnt: number, ts: number }[];
        let instantaneousTps: number[] = [];
        for (let i = 1; i < blockRowsWithTs.length; i++) {
            const deltaT = blockRowsWithTs[i].ts - blockRowsWithTs[i - 1].ts;
            if (deltaT <= 0) continue;
            instantaneousTps.push(blockRowsWithTs[i].cnt / deltaT);
        }
        const maxTps = instantaneousTps.length ? Math.max(...instantaneousTps) : 0;

        
        const blockTable = new Table({ head: ["Block", "Txs", "Δt(s)", "TPS"] });
        for (let i = 0; i < blockRowsWithTs.length; i++) {
            const row = blockRowsWithTs[i];
            if (i === 0) {
                // Try to get the previous block's timestamp to calculate Δt for the first block
                const prevBlockHeight = row.height - 1;
                const headerTable = layer === 'l1' ? 'l1_headers' : 'l2_headers';
                const prevBlockHeader = db.prepare(`SELECT timestamp as ts FROM ${headerTable} WHERE height = ?`).get(prevBlockHeight) as { ts: number } | undefined;

                if (prevBlockHeader && prevBlockHeader.ts > 0) {
                    const deltaT = row.ts - prevBlockHeader.ts || 1;
                    const tps = (row.cnt / deltaT).toFixed(2);
                    blockTable.push([row.height, row.cnt, deltaT, tps]);
                } else {
                    // Fallback if previous block is not in our DB
                    blockTable.push([row.height, row.cnt, "-", "-"]);
                }
            } else {
                const deltaT = row.ts - blockRowsWithTs[i - 1].ts || 1;
                const tps = (row.cnt / deltaT).toFixed(2);
                blockTable.push([row.height, row.cnt, deltaT, tps]);
            }
        }

        Logger.title(`\n${layer.toUpperCase()} per-block stats:` + "\n" + blockTable.toString());

        // --- 仍保留平均 TPS (按秒窗口) ---
        const tsRows = db.prepare(`SELECT ${tsCol} as ts FROM txs WHERE ${tsCol} IS NOT NULL`).all() as { ts: number }[];
        const perSecondCount: Record<number, number> = {};
        for (const r of tsRows) {
            perSecondCount[r.ts] = (perSecondCount[r.ts] || 0) + 1;
        }
        const counts = Object.values(perSecondCount);
        const avgTps = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;

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
    const program = new Command();
    program
        .option('--l1-target-hash <hash>', '20-byte hex L1 target address hash', "bc7656b9d24943793cbdd73fe392aca6ba7a9c3a")
        .option('--zmq-endpoint <endpoint>', 'Dogecoin ZMQ endpoint', "tcp://10.8.0.25:30495")
        .option('--l2-rpc <url>', 'L2 RPC endpoint', "https://rpc.dg.unifra.xyz")
        .option('--moat-address <address>', 'Moat contract address', "0x3eD6eD3c572537d668F860d4d556B8E8BF23E1E2")
        .option('--db-path <path>', 'Path to SQLite database file', "doge_headers.db")
        .parse(process.argv);

    const options = program.opts();

    (async () => {
        await startCrossChainListeners({
            l1TargetHash: options.l1TargetHash,
            zmqEndpoint: options.zmqEndpoint,
            l2Rpc: options.l2Rpc,
            moatAddress: options.moatAddress,
            dbPath: options.dbPath,
            transactions: [] // Standalone mode doesn't pre-populate transactions
        });
    })().catch((e) => {
        Logger.error(`cross-chain listeners terminated with error: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    });
}
