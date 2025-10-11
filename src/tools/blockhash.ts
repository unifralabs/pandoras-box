import { createHash } from 'crypto';

export function getBlockHashFromRawBlock(rawBlock: Buffer): string {
  // Dogecoin/Bitcoin block header is first 80 bytes
  const header = rawBlock.subarray(0, 80);
  // Double SHA256
  const hash1 = createHash('sha256').update(header).digest();
  const hash2 = createHash('sha256').update(hash1).digest();
  // Convert to hex, little-endian
  return Buffer.from(hash2).reverse().toString('hex');
}
