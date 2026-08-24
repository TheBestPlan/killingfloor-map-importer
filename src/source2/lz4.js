// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// LZ4 block decompression - the codec Source 2's binary KV3 uses (compressionMethod 1). Node ships
// zstd and brotli but not LZ4, so this is the standard block format decoder: a sequence is a token
// byte (high nibble = literal length, low nibble = match length - 4), optional extra length bytes
// (0xFF continuation), the literals, then a 2-byte little-endian back-offset and the (possibly
// overlapping) match copy. The last sequence is literals only. `dstLen` is known from the caller
// (KV3 stores the uncompressed size), so no end marker is needed.
"use strict";

function decompressBlock(src, dstLen, srcStart, srcEnd) {
  let s = srcStart || 0;
  const end = srcEnd == null ? src.length : srcEnd;
  const dst = Buffer.allocUnsafe(dstLen);
  let d = 0;
  while (s < end) {
    const token = src[s++];
    let litLen = token >> 4;
    if (litLen === 15) { let b; do { b = src[s++]; litLen += b; } while (b === 255); }
    // literals
    src.copy(dst, d, s, s + litLen); s += litLen; d += litLen;
    if (s >= end) break;           // final sequence: literals only
    const offset = src[s] | (src[s + 1] << 8); s += 2;
    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) { let b; do { b = src[s++]; matchLen += b; } while (b === 255); }
    let m = d - offset;
    if (m < 0) throw new Error("lz4: bad match offset " + offset + " at d=" + d);
    // overlapping copy must be byte-by-byte (offset may be < matchLen)
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++];
  }
  if (d !== dstLen) throw new Error("lz4: produced " + d + " bytes, expected " + dstLen);
  return dst;
}

// Self-test: a hand-rolled block that exercises a literal run and an overlapping match (RLE).
function demo() {
  const assert = require("assert");
  // "abcabcabcabc": 3 literals "abc", then match offset 3 length 9 (overlapping)
  const token = (3 << 4) | (9 - 4);
  const block = Buffer.from([token, 0x61, 0x62, 0x63, 0x03, 0x00]);
  const out = decompressBlock(block, 12);
  assert.strictEqual(out.toString("latin1"), "abcabcabcabc", "lz4 overlapping RLE");
  // pure literals, no match
  const lit = Buffer.from([(5 << 4), 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.strictEqual(decompressBlock(lit, 5).toString("latin1"), "hello", "lz4 literals only");
  console.log("lz4.js: self-check passed");
}

module.exports = { decompressBlock, demo };
if (require.main === module) demo();
