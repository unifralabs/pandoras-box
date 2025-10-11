import 'dotenv/config';
import { Subscriber } from 'zeromq';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import { getBlockHashFromRawBlock } from './blockhash';
import Logger from '../logger/logger';
interface MonitorState {
  lastBlockHeight: number;
  lastBlockHash: string;
  previousblockhash: string;
}

type DB = Database<sqlite3.Database, sqlite3.Statement>;

export async function ensureTables(db: DB): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS l1_block_headers (
    height BIGINT PRIMARY KEY,
    hash VARCHAR(64) NOT NULL UNIQUE,
    previous_hash VARCHAR(64) NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
    size_bytes INTEGER DEFAULT 0,
    tx_count INTEGER DEFAULT 0,
    confirmations INTEGER DEFAULT 0
  )`);

  await db.exec(`CREATE TABLE IF NOT EXISTS anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type VARCHAR(64) NOT NULL,
    detail TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`);
}

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


export async function handleBlock(message: Buffer, db: DB, state: MonitorState): Promise<void> {
  if (message.length < 80) {
    Logger.debug(`[doge-zmq] Received short rawblock message (${message.length} bytes), expected >= 80. Skipping.`);
    return;
  }

  const blockHash = getBlockHashFromRawBlock(message);
  const height = extractHeightFromBlock(message);
  if (!height) {
    return;
  }
  const version = message.readInt32LE(0);
  const prevHash = Buffer.from(message.subarray(4, 36)).reverse().toString("hex");
  const merkleRoot = Buffer.from(message.subarray(36, 68)).reverse().toString("hex");
  const timestamp = message.readUInt32LE(68);
  const bits = message.readUInt32LE(72);
  const nonce = message.readUInt32LE(76);

  let nowSec = Math.floor(Date.now() / 1000);
  await db.run(
    `INSERT INTO l1_block_headers (height, hash, previous_hash, timestamp, size_bytes, tx_count, confirmations, created_at)
     VALUES ($height, $hash, $previous_hash, $timestamp, $size_bytes, $tx_count, $confirmations, $created_at)
     ON CONFLICT (height) DO UPDATE SET
       hash = EXCLUDED.hash,
       previous_hash = EXCLUDED.previous_hash,
       timestamp = EXCLUDED.timestamp,
       size_bytes = EXCLUDED.size_bytes,
       tx_count = EXCLUDED.tx_count,
       confirmations = EXCLUDED.confirmations,
       created_at = EXCLUDED.created_at
    `
  , {
    $height: height,
    $hash: blockHash,
    $previous_hash: prevHash,
    $timestamp: timestamp,
    $size_bytes: message.length,
    $tx_count: 0,
    $confirmations: null,
    $created_at: nowSec
  });

  if (state.lastBlockHeight >= 0 && (height <= state.lastBlockHeight) && blockHash !== state.lastBlockHash) {
    await db.run(
      `INSERT INTO anomalies (type, detail, created_at) VALUES ($type, $detail, $created_at)`,
      {
        $type: 'reorg',
        $detail: JSON.stringify({ height, blockHash, previousblockhash: state.previousblockhash, lastBlockHeight: state.lastBlockHeight, lastBlockHash: state.lastBlockHash }),
        $created_at: timestamp
      });

    Logger.debug(`Reorg detected: ${height} ${blockHash}`);
  }

  state.lastBlockHeight = height;
  state.lastBlockHash = blockHash;
  Logger.debug(`New block: ${height} ${blockHash}`);
}

async function runZmqLoop(db: DB, zmqUrl: string, state: MonitorState, shutdownSignal: { stop: boolean }): Promise<void> {
  while (true) {
    const sub = new Subscriber();
    try {
      sub.connect(zmqUrl);
      sub.subscribe('rawblock');
      Logger.debug(`ZMQ connected to ${zmqUrl}, waiting for blocks...`);
      for await (const [topic, msg] of sub) { // handleBlock is sync, but the loop is async
        if (shutdownSignal.stop) {
          const maybeClose = (sub as any).close;
          if (typeof maybeClose === 'function') {
            try { maybeClose.call(sub); } catch (_) { /* ignore */ }
          }
          Logger.debug('ZMQ listener stopped.');
          return;
        }
        if (topic.toString() === 'rawblock') {
          await handleBlock(msg, db, state);
        } else {
          Logger.debug(`new envent: ${topic.toString()}`)
        }
      }
    } catch (err) {
      console.error('ZMQ loop error, preparing to reconnect:', err);
      // Gracefully close socket before exiting loop (zeromq@6 has close())
      const maybeClose = (sub as any).close;
      if (typeof maybeClose === 'function') {
        try { maybeClose.call(sub); } catch (_) { /* ignore */ }
      }
      if (shutdownSignal.stop) {
        Logger.debug('ZMQ listener stopped during error handling.');
        return;
      }
      await new Promise(r => setTimeout(r, 3000));
      continue; // retry
    }
  }
}

export async function startDogeMonitor(options: { db: DB; zmqUrl: string; }) {
  const { db, zmqUrl } = options;
  
  await ensureTables(db);

  const state: MonitorState = {
    lastBlockHeight: -1,
    lastBlockHash: '',
    previousblockhash: '',
  };

  const shutdownSignal = { stop: false };

  const loopPromise = runZmqLoop(db, zmqUrl, state, shutdownSignal);

  const shutdown = () => {
    Logger.debug('Shutdown initiated for Doge monitor...');
    shutdownSignal.stop = true;
    // The responsibility of closing the DB connection is now with the caller.
  };

  return {
    shutdown,
    // You can await this promise if you want to know when the loop finishes
    finished: loopPromise,
  };
}

// Example of how to run this if the file is executed directly
async function main() {
  const ZMQ_URL: string = process.env.ZMQ_URL ?? 'tcp://localhost:28332';
  const SQLITE_PATH: string = process.env.SQLITE_PATH ?? 'doge-monitor.db';
  
  const db = await open({
    filename: SQLITE_PATH,
    driver: sqlite3.Database
  });
  await db.exec('PRAGMA journal_mode = WAL;');
  Logger.debug(`SQLite database connected at ${SQLITE_PATH}`);

  const monitor = await startDogeMonitor({ db, zmqUrl: ZMQ_URL });

  const gracefulShutdown = async () => {
    monitor.shutdown();
    
    // The `open` property does not exist on the `sqlite` Database object
    if (db) {
      await db.close();
      Logger.debug('SQLite database connection closed.');
    }    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  await monitor.finished;
  Logger.debug("Monitor loop has finished.");
}

if (require.main === module) {
  main().catch(e => {
    console.error('Main program error:', e);
    process.exit(1);
  });
}
