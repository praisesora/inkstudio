/**
 * Zero-dependency standard LZ4 raw block compressor and strictly bounds-checked decompressor.
 * Used for BINARY_TILE raster synchronization across Tauri desktop and WebSocket browser guests.
 */

const HASH_LOG = 14;
const HASH_SIZE = 1 << HASH_LOG;
const HASH_SHIFT = 32 - HASH_LOG;
const HASH_MULT = 2654435761; // Knuth multiplicative hash (standard LZ4)
const MIN_MATCH = 4;
const MF_LIMIT = 12;
const LAST_LITERALS = 5;
const MAX_DISTANCE = 65535;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MB safety ceiling

// Reusable hash table to avoid per-tile GC churn on the hot path
const sharedHashTable = new Int32Array(HASH_SIZE);

export function lz4CompressBound(inputLength: number): number {
  return inputLength + ((inputLength / 255) | 0) + 16;
}

/**
 * Compresses raw bytes into a standard LZ4 block (without prepended size header).
 */
export function lz4CompressBlock(src: Uint8Array): Uint8Array {
  const srcLen = src.byteLength;
  if (srcLen === 0) return new Uint8Array(0);

  const dst = new Uint8Array(lz4CompressBound(srcLen));
  let op = 0;

  if (srcLen < MF_LIMIT + 1) {
    op = emitLastLiterals(src, 0, srcLen, dst, op);
    return dst.subarray(0, op);
  }

  sharedHashTable.fill(-1);

  const mflimit = srcLen - MF_LIMIT;
  const matchLimit = srcLen - LAST_LITERALS;
  let anchor = 0;
  let ip = 0;

  while (ip <= mflimit) {
    // Search for a 4-byte match using step acceleration on incompressible spans
    let ref = -1;
    let forwardIp = ip;
    let step = 1;
    let searchMatchNb = 1 << 6;

    while (true) {
      ip = forwardIp;
      forwardIp += step;
      step = searchMatchNb++ >> 6;

      if (forwardIp > mflimit) {
        op = emitLastLiterals(src, anchor, srcLen - anchor, dst, op);
        return dst.subarray(0, op);
      }

      const seq =
        src[ip] |
        (src[ip + 1] << 8) |
        (src[ip + 2] << 16) |
        (src[ip + 3] << 24);
      const h = Math.imul(seq, HASH_MULT) >>> HASH_SHIFT;
      ref = sharedHashTable[h];
      sharedHashTable[h] = ip;

      if (
        ref >= 0 &&
        ip - ref <= MAX_DISTANCE &&
        src[ref] === src[ip] &&
        src[ref + 1] === src[ip + 1] &&
        src[ref + 2] === src[ip + 2] &&
        src[ref + 3] === src[ip + 3]
      ) {
        break;
      }
    }

    // Catch up backwards if previous bytes also match
    while (ip > anchor && ref > 0 && src[ip - 1] === src[ref - 1]) {
      ip--;
      ref--;
    }

    // Emit token + literal length + literals
    const litLen = ip - anchor;
    let tokenPos = op++;
    if (litLen >= 15) {
      dst[tokenPos] = 0xf0;
      let rem = litLen - 15;
      while (rem >= 255) {
        dst[op++] = 255;
        rem -= 255;
      }
      dst[op++] = rem;
    } else {
      dst[tokenPos] = litLen << 4;
    }

    if (litLen > 0) {
      dst.set(src.subarray(anchor, ip), op);
      op += litLen;
    }

    // Emit match sequence(s)
    while (true) {
      const offset = ip - ref;
      dst[op++] = offset & 0xff;
      dst[op++] = (offset >>> 8) & 0xff;

      ip += MIN_MATCH;
      ref += MIN_MATCH;
      const matchStart = ip;
      while (ip < matchLimit && src[ip] === src[ref]) {
        ip++;
        ref++;
      }

      const matchCode = ip - matchStart;
      if (matchCode >= 15) {
        dst[tokenPos] |= 0x0f;
        let rem = matchCode - 15;
        while (rem >= 255) {
          dst[op++] = 255;
          rem -= 255;
        }
        dst[op++] = rem;
      } else {
        dst[tokenPos] |= matchCode;
      }

      anchor = ip;

      if (ip > mflimit) {
        op = emitLastLiterals(src, anchor, srcLen - anchor, dst, op);
        return dst.subarray(0, op);
      }

      // Update hash at ip - 2
      const prevIdx = ip - 2;
      const prevSeq =
        src[prevIdx] |
        (src[prevIdx + 1] << 8) |
        (src[prevIdx + 2] << 16) |
        (src[prevIdx + 3] << 24);
      sharedHashTable[Math.imul(prevSeq, HASH_MULT) >>> HASH_SHIFT] = prevIdx;

      // Test immediate next position for chained match
      const nextSeq =
        src[ip] |
        (src[ip + 1] << 8) |
        (src[ip + 2] << 16) |
        (src[ip + 3] << 24);
      const nextH = Math.imul(nextSeq, HASH_MULT) >>> HASH_SHIFT;
      ref = sharedHashTable[nextH];
      sharedHashTable[nextH] = ip;

      if (
        ref >= 0 &&
        ip - ref <= MAX_DISTANCE &&
        src[ref] === src[ip] &&
        src[ref + 1] === src[ip + 1] &&
        src[ref + 2] === src[ip + 2] &&
        src[ref + 3] === src[ip + 3]
      ) {
        tokenPos = op++;
        dst[tokenPos] = 0;
        continue;
      }

      ip++;
      break;
    }
  }

  op = emitLastLiterals(src, anchor, srcLen - anchor, dst, op);
  return dst.subarray(0, op);
}

function emitLastLiterals(
  src: Uint8Array,
  anchor: number,
  litLen: number,
  dst: Uint8Array,
  op: number
): number {
  if (litLen >= 15) {
    dst[op++] = 0xf0;
    let rem = litLen - 15;
    while (rem >= 255) {
      dst[op++] = 255;
      rem -= 255;
    }
    dst[op++] = rem;
  } else {
    dst[op++] = litLen << 4;
  }
  if (litLen > 0) {
    dst.set(src.subarray(anchor, anchor + litLen), op);
    op += litLen;
  }
  return op;
}

/**
 * Strictly bounds-checked LZ4 raw block decompressor.
 * Returns null on any corrupt, truncated, or out-of-bounds input (guards against LZ4 bombs).
 */
export function lz4DecompressBlock(
  src: Uint8Array,
  uncompressedLength: number,
  maxOutputBytes: number = DEFAULT_MAX_OUTPUT_BYTES
): Uint8Array | null {
  if (
    !Number.isInteger(uncompressedLength) ||
    uncompressedLength < 0 ||
    uncompressedLength > maxOutputBytes
  ) {
    return null;
  }
  if (uncompressedLength === 0) {
    return src.byteLength === 0 ? new Uint8Array(0) : null;
  }

  const srcLen = src.byteLength;
  if (srcLen === 0) return null;

  const dst = new Uint8Array(uncompressedLength);
  let ip = 0;
  let op = 0;

  while (ip < srcLen) {
    const token = src[ip++];

    // 1. Literal length
    let litLen = token >>> 4;
    if (litLen === 15) {
      let s: number;
      do {
        if (ip >= srcLen) return null;
        s = src[ip++];
        litLen += s;
        if (op + litLen > uncompressedLength) return null;
      } while (s === 255);
    }

    if (ip + litLen > srcLen || op + litLen > uncompressedLength) {
      return null;
    }
    if (litLen > 0) {
      dst.set(src.subarray(ip, ip + litLen), op);
      ip += litLen;
      op += litLen;
    }

    // End of block: last sequence has no offset/match
    if (ip === srcLen) {
      break;
    }

    // 2. Match offset (uint16 LE)
    if (ip + 2 > srcLen) return null;
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) {
      return null;
    }

    // 3. Match length
    let matchLen = (token & 0x0f) + MIN_MATCH;
    if ((token & 0x0f) === 15) {
      let s: number;
      do {
        if (ip >= srcLen) return null;
        s = src[ip++];
        matchLen += s;
        if (op + matchLen > uncompressedLength) return null;
      } while (s === 255);
    }

    if (op + matchLen > uncompressedLength) {
      return null;
    }

    // Copy match (supports overlapping copies such as offset=1 or offset=4 RGBA solid runs)
    let ref = op - offset;
    if (offset >= matchLen) {
      dst.set(dst.subarray(ref, ref + matchLen), op);
      op += matchLen;
    } else {
      for (let i = 0; i < matchLen; i++) {
        dst[op++] = dst[ref++];
      }
    }
  }

  return op === uncompressedLength ? dst : null;
}
