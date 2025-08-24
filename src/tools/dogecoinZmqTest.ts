import { Subscriber } from "zeromq";
import crypto from "crypto";
import axios from "axios";
import Database from "better-sqlite3";

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
}

interface ParsedTx {
    hash: string;
    vouts: VoutInfo[];
    uid: bigint
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

function parseTransactions(block: Buffer, targetAddress: string): ParsedTx[] {
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
        let uid: bigint = BigInt(0);
        for (let vo = 0; vo < voutCnt; vo++) {
            // value (8) little-endian satoshis
            const valueLE = block.readBigUInt64LE(offset);
            offset += 8;
            const [pkLen, offPK] = readVarInt(block, offset);
            offset = offPK;
            const script = block.subarray(offset, offset + pkLen);
            offset += pkLen;
            const p2pkh = isP2PKH(script);
            let addrHash = p2pkh ? "" : script.subarray(3, 23).toString("hex");
            if (addrHash === targetAddress) {
                uid = valueLE;
            }
            vouts.push({
                value: valueLE,
                scriptHex: script.toString("hex"),
                isP2PKH: p2pkh,
                addrHash: p2pkh ? addrHash : null,
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
        txs.push({ hash: txHash, vouts, uid });
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
export function createTxDatabase(dbPath = "doge_headers.db"): Database {
    const db = new Database(dbPath);
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
    return db;
}

export async function startDogecoinListener(
    db: Database,
    zmqEndpoint = process.env.DOGE_ZMQ_ENDPOINT || "tcp://10.8.0.25:30495",
    targetAddrHash: string = ""
) {
    // previous db.exec moved to createTxDatabase, so assume db ready
    const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO l1_headers (height, hash, version, prev_hash, merkle_root, timestamp, create_at, bits, nonce, size_bytes)
         VALUES (@height, @hash, @version, @prev_hash, @merkle_root, @timestamp, @create_at, @bits, @nonce, @size_bytes)`
    );

    const insertTxStmt = db.prepare(
        `INSERT INTO txs (uid, l2_txhash, l2_height, l2_timestamp, l1_txhash, l1_height, l1_timestamp)
         VALUES (@uid, @l2_txhash, @l2_height, @l2_timestamp, @l1_txhash, @l1_height, @l1_timestamp)
         ON CONFLICT(uid) DO UPDATE SET
           l1_txhash=excluded.l1_txhash,
           l1_height=excluded.l1_height,
           l1_timestamp=excluded.l1_timestamp`);

    const insertBlockData = db.transaction((header: any, txRows: { uid: number; l2_txhash: string; l2_height: number; l2_timestamp: number; l1_txhash: string; l1_height: number; l1_timestamp: number }[]) => {
        insertStmt.run(header);
        for (const row of txRows) insertTxStmt.run(row);
    });

    const sock = new Subscriber();
    sock.connect(zmqEndpoint);
    sock.subscribe("rawblock");

    console.log(`[doge-zmq] Subscribed to rawblock on ${zmqEndpoint}`);

    for await (const [_topic, message] of sock) {
        if (message.length < 80) {
            console.warn(`[doge-zmq] Received short rawblock message (${message.length} bytes), expected >= 80. Skipping.`);
            continue;
        }
        // The message payload is the raw block in binary form.
        // Compute block hash (double SHA256 of header, displayed in little-endian).
        const header = message.subarray(0, 80);
        const hashBuffer = crypto
            .createHash("sha256")
            .update(
                crypto.createHash("sha256").update(header).digest()
            )
            .digest();
        // Reverse byte order for display (little-endian)
        const blockHash = Buffer.from(hashBuffer).reverse().toString("hex");

        const height = extractHeightFromBlock(message);

        const heightInfo = height !== null ? `height=${height}` : "height=unknown";

        const parsedTxs = parseTransactions(message, targetAddrHash);
        const txHashes = parsedTxs.map((t) => t.hash);

        // Store header if height known
        if (height !== null) {
            // Parse header fields
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

            const rows = parsedTxs.map((ptx) => ({
                uid: Number(ptx.uid),
                l2_txhash: "",
                l2_height: 0,
                l2_timestamp: 0,
                l1_txhash: ptx.hash,
                l1_height: height,
                l1_timestamp: nowTs,
            }));
            insertBlockData(headerRow, rows);
        }

        // Example log of first tx vouts
        if (parsedTxs.length > 0) {
            const firstTx = parsedTxs[0];
            console.debug(`[doge-zmq] First tx ${firstTx.hash} vouts=${firstTx.vouts.length}`);
        }

        console.log(
            `[doge-zmq] New block: ${blockHash} ${heightInfo} (txs=${txHashes.length}) (size: ${message.length} bytes)`
        );

        // Optional: print hashes or store as needed
        // console.log(txHashes);
        // 把区块头信息写入sqlite中，表名 l1_headers

    }
}

// L2 listener placeholder (e.g., for EVM chain via WebSocket)
export async function startL2Listener(
    db: Database,
    wsEndpoint: string,
    targetAddr: string
) {
    // TODO: implement actual L2 subscription logic.
    // Example: using ethers WebSocketProvider to listen for transactions to target address,
    // then update txs table filling l2_* columns where uid matches.
}

// Standalone execution
if (require.main === module) {
    const db = createTxDatabase();
    startDogecoinListener(db).catch((err) => {
        console.error("[doge-zmq] Error:", err);
        process.exit(1);
    });
}
