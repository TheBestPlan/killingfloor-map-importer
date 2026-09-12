// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// BC7 (BPTC) block decompression -> RGBA. CS2 prop/foliage color textures compile to BC7, so decoding
// it is needed to texture ~a fifth of a Source 2 map's surfaces. Faithful port of Sergii Kudlai's
// public-domain bcdec.h (github.com/iOrange/bcdec) BC7 path: 8 modes, 2/3-subset partition tables, per-
// endpoint or shared P-bits, primary + (mode 4/5) secondary index sets, and channel rotation. The 128-bit
// block is pulled LSB-first, so the bitstream is a BigInt pair like the reference's low/high 64-bit words.
"use strict";

// Partition tables (64 shapes x 16 texels). A value's 0x80 bit marks the subset's fix-up (anchor) texel;
// the low 2 bits are the subset index. Generated from bcdec.h's partition_sets.
const P2 = [
  128,0,1,1,0,0,1,1,0,0,1,1,0,0,1,129, 128,0,0,1,0,0,0,1,0,0,0,1,0,0,0,129, 128,1,1,1,0,1,1,1,0,1,1,1,0,1,1,129,
  128,0,0,1,0,0,1,1,0,0,1,1,0,1,1,129, 128,0,0,0,0,0,0,1,0,0,0,1,0,0,1,129, 128,0,1,1,0,1,1,1,0,1,1,1,1,1,1,129,
  128,0,0,1,0,0,1,1,0,1,1,1,1,1,1,129, 128,0,0,0,0,0,0,1,0,0,1,1,0,1,1,129, 128,0,0,0,0,0,0,0,0,0,0,1,0,0,1,129,
  128,0,1,1,0,1,1,1,1,1,1,1,1,1,1,129, 128,0,0,0,0,0,0,1,0,1,1,1,1,1,1,129, 128,0,0,0,0,0,0,0,0,0,0,1,0,1,1,129,
  128,0,0,1,0,1,1,1,1,1,1,1,1,1,1,129, 128,0,0,0,0,0,0,0,1,1,1,1,1,1,1,129, 128,0,0,0,1,1,1,1,1,1,1,1,1,1,1,129,
  128,0,0,0,0,0,0,0,0,0,0,0,1,1,1,129, 128,0,0,0,1,0,0,0,1,1,1,0,1,1,1,129, 128,1,129,1,0,0,0,1,0,0,0,0,0,0,0,0,
  128,0,0,0,0,0,0,0,129,0,0,0,1,1,1,0, 128,1,129,1,0,0,1,1,0,0,0,1,0,0,0,0, 128,0,129,1,0,0,0,1,0,0,0,0,0,0,0,0,
  128,0,0,0,1,0,0,0,129,1,0,0,1,1,1,0, 128,0,0,0,0,0,0,0,129,0,0,0,1,1,0,0, 128,1,1,1,0,0,1,1,0,0,1,1,0,0,0,129,
  128,0,129,1,0,0,0,1,0,0,0,1,0,0,0,0, 128,0,0,0,1,0,0,0,129,0,0,0,1,1,0,0, 128,1,129,0,0,1,1,0,0,1,1,0,0,1,1,0,
  128,0,129,1,0,1,1,0,0,1,1,0,1,1,0,0, 128,0,0,1,0,1,1,1,129,1,1,0,1,0,0,0, 128,0,0,0,1,1,1,1,129,1,1,1,0,0,0,0,
  128,1,129,1,0,0,0,1,1,0,0,0,1,1,1,0, 128,0,129,1,1,0,0,1,1,0,0,1,1,1,0,0, 128,1,0,1,0,1,0,1,0,1,0,1,0,1,0,129,
  128,0,0,0,1,1,1,1,0,0,0,0,1,1,1,129, 128,1,0,1,1,0,129,0,0,1,0,1,1,0,1,0, 128,0,1,1,0,0,1,1,129,1,0,0,1,1,0,0,
  128,0,129,1,1,1,0,0,0,0,1,1,1,1,0,0, 128,1,0,1,0,1,0,1,129,0,1,0,1,0,1,0, 128,1,1,0,1,0,0,1,0,1,1,0,1,0,0,129,
  128,1,0,1,1,0,1,0,1,0,1,0,0,1,0,129, 128,1,129,1,0,0,1,1,1,1,0,0,1,1,1,0, 128,0,0,1,0,0,1,1,129,1,0,0,1,0,0,0,
  128,0,129,1,0,0,1,0,0,1,0,0,1,1,0,0, 128,0,129,1,1,0,1,1,1,1,0,1,1,1,0,0, 128,1,129,0,1,0,0,1,1,0,0,1,0,1,1,0,
  128,0,1,1,1,1,0,0,1,1,0,0,0,0,1,129, 128,1,1,0,0,1,1,0,1,0,0,1,1,0,0,129, 128,0,0,0,0,1,129,0,0,1,1,0,0,0,0,0,
  128,1,0,0,1,1,129,0,0,1,0,0,0,0,0,0, 128,0,129,0,0,1,1,1,0,0,1,0,0,0,0,0, 128,0,0,0,0,0,129,0,0,1,1,1,0,0,1,0,
  128,0,0,0,0,1,0,0,129,1,1,0,0,1,0,0, 128,1,1,0,1,1,0,0,1,0,0,1,0,0,1,129, 128,0,1,1,0,1,1,0,1,1,0,0,1,0,0,129,
  128,1,129,0,0,0,1,1,1,0,0,1,1,1,0,0, 128,0,129,1,1,0,0,1,1,1,0,0,0,1,1,0, 128,1,1,0,1,1,0,0,1,1,0,0,1,0,0,129,
  128,1,1,0,0,0,1,1,0,0,1,1,1,0,0,129, 128,1,1,1,1,1,1,0,1,0,0,0,0,0,0,129, 128,0,0,1,1,0,0,0,1,1,1,0,0,1,1,129,
  128,0,0,0,1,1,1,1,0,0,1,1,0,0,1,129, 128,0,129,1,0,0,1,1,1,1,1,1,0,0,0,0, 128,0,129,0,0,0,1,0,1,1,1,0,1,1,1,0,
  128,1,0,0,0,1,0,0,0,1,1,1,0,1,1,129,
];
const P3 = [
  128,0,1,129,0,0,1,1,0,2,2,1,2,2,2,130, 128,0,0,129,0,0,1,1,130,2,1,1,2,2,2,1, 128,0,0,0,2,0,0,1,130,2,1,1,2,2,1,129,
  128,2,2,130,0,0,2,2,0,0,1,1,0,1,1,129, 128,0,0,0,0,0,0,0,129,1,2,2,1,1,2,130, 128,0,1,129,0,0,1,1,0,0,2,2,0,0,2,130,
  128,0,2,130,0,0,2,2,1,1,1,1,1,1,1,129, 128,0,1,1,0,0,1,1,130,2,1,1,2,2,1,129, 128,0,0,0,0,0,0,0,129,1,1,1,2,2,2,130,
  128,0,0,0,1,1,1,1,129,1,1,1,2,2,2,130, 128,0,0,0,1,1,129,1,2,2,2,2,2,2,2,130, 128,0,1,2,0,0,129,2,0,0,1,2,0,0,1,130,
  128,1,1,2,0,1,129,2,0,1,1,2,0,1,1,130, 128,1,2,2,0,129,2,2,0,1,2,2,0,1,2,130, 128,0,1,129,0,1,1,2,1,1,2,2,1,2,2,130,
  128,0,1,129,2,0,0,1,130,2,0,0,2,2,2,0, 128,0,0,129,0,0,1,1,0,1,1,2,1,1,2,130, 128,1,1,129,0,0,1,1,130,0,0,1,2,2,0,0,
  128,0,0,0,1,1,2,2,129,1,2,2,1,1,2,130, 128,0,2,130,0,0,2,2,0,0,2,2,1,1,1,129, 128,1,1,129,0,1,1,1,0,2,2,2,0,2,2,130,
  128,0,0,129,0,0,0,1,130,2,2,1,2,2,2,1, 128,0,0,0,0,0,129,1,0,1,2,2,0,1,2,130, 128,0,0,0,1,1,0,0,130,2,129,0,2,2,1,0,
  128,1,2,130,0,129,2,2,0,0,1,1,0,0,0,0, 128,0,1,2,0,0,1,2,129,1,2,2,2,2,2,130, 128,1,1,0,1,2,130,1,129,2,2,1,0,1,1,0,
  128,0,0,0,0,1,129,0,1,2,130,1,1,2,2,1, 128,0,2,2,1,1,0,2,129,1,0,2,0,0,2,130, 128,1,1,0,0,129,1,0,2,0,0,2,2,2,2,130,
  128,0,1,1,0,1,2,2,0,1,130,2,0,0,1,129, 128,0,0,0,2,0,0,0,130,2,1,1,2,2,2,129, 128,0,0,0,0,0,0,2,129,1,2,2,1,2,2,130,
  128,2,2,130,0,0,2,2,0,0,1,2,0,0,1,129, 128,0,1,129,0,0,1,2,0,0,2,2,0,2,2,130, 128,1,2,0,0,129,2,0,0,1,130,0,0,1,2,0,
  128,0,0,0,1,1,129,1,2,2,130,2,0,0,0,0, 128,1,2,0,1,2,0,1,130,0,129,2,0,1,2,0, 128,1,2,0,2,0,1,2,129,130,0,1,0,1,2,0,
  128,0,1,1,2,2,0,0,1,1,130,2,0,0,1,129, 128,0,1,1,1,1,130,2,2,2,0,0,0,0,1,129, 128,1,0,129,0,1,0,1,2,2,2,2,2,2,2,130,
  128,0,0,0,0,0,0,0,130,1,2,1,2,1,2,129, 128,0,2,2,1,129,2,2,0,0,2,2,1,1,2,130, 128,0,2,130,0,0,1,1,0,0,2,2,0,0,1,129,
  128,2,2,0,1,2,130,1,0,2,2,0,1,2,2,129, 128,1,0,1,2,2,130,2,2,2,2,2,0,1,0,129, 128,0,0,0,2,1,2,1,130,1,2,1,2,1,2,129,
  128,1,0,129,0,1,0,1,0,1,0,1,2,2,2,130, 128,2,2,130,0,1,1,1,0,2,2,2,0,1,1,129, 128,0,0,2,1,129,1,2,0,0,0,2,1,1,1,130,
  128,0,0,0,2,129,1,2,2,1,1,2,2,1,1,130, 128,2,2,2,0,129,1,1,0,1,1,1,0,2,2,130, 128,0,0,2,1,1,1,2,129,1,1,2,0,0,0,130,
  128,1,1,0,0,129,1,0,0,1,1,0,2,2,2,130, 128,0,0,0,0,0,0,0,2,1,129,2,2,1,1,130, 128,1,1,0,0,129,1,0,2,2,2,2,2,2,2,130,
  128,0,2,2,0,0,1,1,0,0,129,1,0,0,2,130, 128,0,2,2,1,1,2,2,129,1,2,2,0,0,2,130, 128,0,0,0,0,0,0,0,0,0,0,0,2,129,1,130,
  128,0,0,130,0,0,0,1,0,0,0,2,0,0,0,129, 128,2,2,2,1,2,2,2,0,2,2,2,129,2,2,130, 128,1,0,129,2,2,2,2,2,2,2,2,2,2,2,130,
  128,1,1,129,2,0,1,1,130,2,0,1,2,2,2,0,
];

const AW2 = [0, 21, 43, 64];
const AW3 = [0, 9, 18, 27, 37, 46, 55, 64];
const AW4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
// endpoint colour bits / alpha bits per mode; which modes carry P-bits (0b11001011 -> modes 0,1,3,6,7).
const RGB_BITS = [4, 6, 5, 7, 5, 7, 7, 5];
const ALPHA_BITS = [0, 0, 0, 0, 6, 8, 7, 5];
const MODE_HAS_PBITS = 0b11001011;

const interp = (a, b, w, i) => (a * (64 - w[i]) + b * w[i] + 32) >> 6;

// Decode one 16-byte BC7 block, calling put(px, py, r, g, b, a) for each of the 16 texels.
function decodeBlock(buf, off, put) {
  let low = buf.readBigUInt64LE(off), high = buf.readBigUInt64LE(off + 8);
  const read = (n) => {
    const nb = BigInt(n), mask = (1n << nb) - 1n;
    const bits = Number(low & mask);
    low = (low >> nb) | ((high & mask) << (64n - nb));
    high >>= nb;
    return bits;
  };

  let mode = 0;
  while (mode < 8 && read(1) === 0) mode++;
  if (mode >= 8) { for (let i = 0; i < 16; i++) put(i & 3, i >> 2, 0, 0, 0, 0); return; }

  let partition = 0, numPartitions = 1, rotation = 0, indexSelectionBit = 0;
  if (mode === 0 || mode === 1 || mode === 2 || mode === 3 || mode === 7) {
    numPartitions = (mode === 0 || mode === 2) ? 3 : 2;
    partition = read(mode === 0 ? 4 : 6);
  }
  const numEndpoints = numPartitions * 2;
  if (mode === 4 || mode === 5) { rotation = read(2); if (mode === 4) indexSelectionBit = read(1); }

  const ep = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const cb = RGB_BITS[mode], ab = ALPHA_BITS[mode];
  for (let i = 0; i < 3; i++) for (let j = 0; j < numEndpoints; j++) ep[j][i] = read(cb);
  if (ab > 0) for (let j = 0; j < numEndpoints; j++) ep[j][3] = read(ab);

  const hasP = (MODE_HAS_PBITS >> mode) & 1;
  if (mode === 0 || mode === 1 || mode === 3 || mode === 6 || mode === 7) {
    for (let i = 0; i < numEndpoints; i++) for (let j = 0; j < 4; j++) ep[i][j] <<= 1;
    if (mode === 1) {
      const p0 = read(1), p1 = read(1);
      for (let k = 0; k < 3; k++) { ep[0][k] |= p0; ep[1][k] |= p0; ep[2][k] |= p1; ep[3][k] |= p1; }
    } else if (hasP) {
      for (let i = 0; i < numEndpoints; i++) { const p = read(1); for (let k = 0; k < 4; k++) ep[i][k] |= p; }
    }
  }
  for (let i = 0; i < numEndpoints; i++) {
    let j = cb + hasP;
    for (let k = 0; k < 3; k++) { ep[i][k] = (ep[i][k] << (8 - j)) & 0xff; ep[i][k] |= ep[i][k] >> j; }
    j = ab + hasP;
    ep[i][3] = (ep[i][3] << (8 - j)) & 0xff; ep[i][3] |= ep[i][3] >> j;
  }
  if (!ab) for (let j = 0; j < numEndpoints; j++) ep[j][3] = 0xff;

  const indexBits = (mode === 0 || mode === 1) ? 3 : (mode === 6 ? 4 : 2);
  const indexBits2 = mode === 4 ? 3 : (mode === 5 ? 2 : 0);
  const weights = indexBits === 2 ? AW2 : (indexBits === 3 ? AW3 : AW4);
  const weights2 = indexBits2 === 2 ? AW2 : AW3;
  const table = numPartitions === 1 ? null : (numPartitions === 2 ? P2 : P3);

  // Pass 1: primary indices (the subset anchor texel uses one fewer bit).
  const idx = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const set = numPartitions === 1 ? ((i | j) ? 0 : 128) : table[partition * 16 + i * 4 + j];
    let ib = indexBits; if (set & 0x80) ib--;
    idx[i * 4 + j] = read(ib);
  }
  // Pass 2: secondary indices (modes 4/5), interpolate, apply channel rotation.
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const set = (numPartitions === 1 ? ((i | j) ? 0 : 128) : table[partition * 16 + i * 4 + j]) & 0x03;
    const index = idx[i * 4 + j];
    const e0 = ep[set * 2], e1 = ep[set * 2 + 1];
    let r, g, b, a;
    if (!indexBits2) {
      r = interp(e0[0], e1[0], weights, index); g = interp(e0[1], e1[1], weights, index);
      b = interp(e0[2], e1[2], weights, index); a = interp(e0[3], e1[3], weights, index);
    } else {
      const index2 = read((i | j) ? indexBits2 : indexBits2 - 1);
      if (!indexSelectionBit) {
        r = interp(e0[0], e1[0], weights, index); g = interp(e0[1], e1[1], weights, index);
        b = interp(e0[2], e1[2], weights, index); a = interp(e0[3], e1[3], weights2, index2);
      } else {
        r = interp(e0[0], e1[0], weights2, index2); g = interp(e0[1], e1[1], weights2, index2);
        b = interp(e0[2], e1[2], weights2, index2); a = interp(e0[3], e1[3], weights, index);
      }
    }
    if (rotation === 1) { const t = a; a = r; r = t; }
    else if (rotation === 2) { const t = a; a = g; g = t; }
    else if (rotation === 3) { const t = a; a = b; b = t; }
    put(j, i, r, g, b, a);
  }
}

// Decode a BC7 image -> { rgb, alpha, hasAlpha }, matching the DXT decoder's shape.
function decodeBc7(data, w, h) {
  const rgb = Buffer.alloc(w * h * 3), alpha = Buffer.alloc(w * h).fill(255);
  let hasAlpha = false, p = 0;
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (p + 16 > data.length) return { rgb, alpha, hasAlpha };
    const px0 = bx * 4, py0 = by * 4, base = p;
    decodeBlock(data, base, (lx, ly, r, g, b, a) => {
      const x = px0 + lx, y = py0 + ly; if (x >= w || y >= h) return;
      const o = y * w + x; rgb[o * 3] = r; rgb[o * 3 + 1] = g; rgb[o * 3 + 2] = b;
      alpha[o] = a; if (a < 255) hasAlpha = true;
    });
    p += 16;
  }
  return { rgb, alpha, hasAlpha };
}

module.exports = { decodeBc7 };

// Self-check: a hand-built mode-6 block with both endpoints equal (value 64, p-bit 0) and all indices 0
// must decode to one flat colour across all 16 texels. Endpoint 64 -> (64<<1)|0 = 128, replicated = 128.
if (require.main === module) {
  const assert = require("assert");
  let bits = 0n, at = 0n;
  const put = (val, n) => { bits |= (BigInt(val) & ((1n << BigInt(n)) - 1n)) << at; at += BigInt(n); };
  put(1 << 6, 7);                                  // mode 6: six 0 bits then a 1
  for (let k = 0; k < 8; k++) put(64, 7);          // R0,R1,G0,G1,B0,B1,A0,A1 all = 64
  put(0, 2);                                       // two p-bits = 0
  put(0, 3);                                       // anchor index (3 bits)
  for (let k = 1; k < 16; k++) put(0, 4);          // remaining indices (4 bits each)
  const block = Buffer.alloc(16);
  block.writeBigUInt64LE(bits & ((1n << 64n) - 1n), 0);
  block.writeBigUInt64LE(bits >> 64n, 8);
  const out = decodeBc7(block, 4, 4);
  for (let i = 0; i < 16; i++) {
    assert.strictEqual(out.rgb[i * 3], 128, "bc7 mode6 flat R");
    assert.strictEqual(out.rgb[i * 3 + 1], 128, "bc7 mode6 flat G");
    assert.strictEqual(out.rgb[i * 3 + 2], 128, "bc7 mode6 flat B");
    assert.strictEqual(out.alpha[i], 128, "bc7 mode6 flat A");
  }
  console.log("bc7.js: self-check passed");
}
