// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Source 2 compiled texture (.vtex_c) -> { width, height, rgb, alpha? }. A vtex resource is the same
// block container as any other .vXXX_c; its DATA block is a fixed header (dimensions, format, mip count)
// and the pixel data follows immediately after that block (DataOffset = block.offset + block.size).
// Mips are stored smallest-first, so mip 0 (full res) sits last. A COMPRESSED_MIP_SIZE extra-data entry,
// when present, gives each mip's on-disk size and whether the pixels are LZ4-packed. CS2 world/color
// textures are DXT1/DXT5, so those (plus raw RGBA/BGRA) are decoded; other GPU formats (BC7/BC6H/ETC2)
// fall through to null and the caller uses a flat colour. Layout ported from ValveResourceFormat Texture.cs.
"use strict";

const { readResource } = require("./resource");
const { decompressBlock } = require("./lz4");
const { decodeDxt } = require("../gta/txd");
const { decodeBc7 } = require("./bc7");

const FMT = { DXT1: 1, DXT5: 2, RGBA8888: 4, BC7: 20, BGRA8888: 28 };
const BLOCK_SIZE = { [FMT.DXT1]: 8, [FMT.DXT5]: 16, [FMT.RGBA8888]: 4, [FMT.BC7]: 16, [FMT.BGRA8888]: 4 };
const IS_BLOCK = { [FMT.DXT1]: true, [FMT.DXT5]: true, [FMT.BC7]: true };
const EXTRA_COMPRESSED_MIP = 4;

// Bytes one mip level occupies, matching VRF CalculateBufferSizeForMipLevel (2D, no cube/volume).
function mipBufferSize(fmt, blockSize, W, H, mip) {
  let w = Math.max(1, W >> mip), h = Math.max(1, H >> mip);
  if (IS_BLOCK[fmt]) {
    if (w % 4) w += 4 - (w % 4);
    if (h % 4) h += 4 - (h % 4);
    if (w < 4) w = 4;
    if (h < 4) h = 4;
    return ((w * h) >> 4) * blockSize;
  }
  return w * h * blockSize;
}

// Decode a .vtex_c buffer's top mip. Returns null for formats we don't handle.
function decodeVtex(buf) {
  const res = readResource(buf);
  const blk = res.block("DATA");
  if (!blk) return null;
  const base = blk.offset;                          // absolute start of the DATA block header
  // header: u16 version, u16 flags, float[4] reflectivity, u16 w, u16 h, u16 depth, u8 fmt, u8 numMips,
  //         u32 picmip, u32 extraDataOffset, u32 extraDataCount
  const width = buf.readUInt16LE(base + 20);
  const height = buf.readUInt16LE(base + 22);
  const format = buf[base + 26];
  const numMips = buf[base + 27];
  const extraDataOffset = buf.readUInt32LE(base + 32);
  const extraDataCount = buf.readUInt32LE(base + 36);
  const blockSize = BLOCK_SIZE[format];
  if (!blockSize) return null;                       // unhandled GPU format (BC7/BC6H/ETC2/...)

  // COMPRESSED_MIP_SIZE extra data: per-mip on-disk sizes + whether they are LZ4-packed.
  let compressedMips = null, isCompressed = false;
  if (extraDataCount > 0) {
    const table = base + 32 + extraDataOffset;       // offset is relative to the extraDataOffset field
    for (let i = 0; i < extraDataCount; i++) {
      const e = table + i * 12;
      const type = buf.readUInt32LE(e);
      const dataLoc = e + 4 + buf.readUInt32LE(e + 4);
      if (type === EXTRA_COMPRESSED_MIP) {
        isCompressed = buf.readUInt32LE(dataLoc) === 1;
        const mipsOffset = buf.readUInt32LE(dataLoc + 4);
        const mips = buf.readUInt32LE(dataLoc + 8);
        const arr = dataLoc + 4 + mipsOffset;
        compressedMips = [];
        for (let m = 0; m < mips; m++) compressedMips.push(buf.readInt32LE(arr + m * 4));
      }
    }
  }

  // Pixel data starts right after the DATA block; mip 0 sits last (mips are stored smallest-first).
  let pos = blk.offset + blk.size;
  const onDisk = (mip) => {
    const raw = mipBufferSize(format, blockSize, width, height, mip);
    if (compressedMips) return Math.min(raw, compressedMips[mip]);
    return raw;
  };
  for (let j = numMips - 1; j > 0; j--) pos += onDisk(j);   // skip down to mip 0

  const rawLen = mipBufferSize(format, blockSize, width, height, 0);
  let pixels;
  if (isCompressed && compressedMips && compressedMips[0] < rawLen) {
    pixels = decompressBlock(buf, rawLen, pos, pos + compressedMips[0]);
  } else {
    pixels = buf.subarray(pos, pos + rawLen);
  }

  if (format === FMT.DXT1 || format === FMT.DXT5) {
    const out = decodeDxt(pixels, width, height, format === FMT.DXT1 ? 1 : 5);
    return { width, height, rgb: out.rgb, alpha: out.hasAlpha ? out.alpha : undefined };
  }
  if (format === FMT.BC7) {
    const out = decodeBc7(pixels, width, height);
    return { width, height, rgb: out.rgb, alpha: out.hasAlpha ? out.alpha : undefined };
  }
  // RGBA8888 / BGRA8888: one texel per 4 bytes.
  const rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height);
  let hasAlpha = false;
  const bgra = format === FMT.BGRA8888;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    rgb[i * 3] = bgra ? pixels[o + 2] : pixels[o];
    rgb[i * 3 + 1] = pixels[o + 1];
    rgb[i * 3 + 2] = bgra ? pixels[o] : pixels[o + 2];
    alpha[i] = pixels[o + 3]; if (pixels[o + 3] < 255) hasAlpha = true;
  }
  return { width, height, rgb, alpha: hasAlpha ? alpha : undefined };
}

module.exports = { decodeVtex };

// Self-check: mip-size math against known DXT1/DXT5 values (the parser's one non-trivial arithmetic).
if (require.main === module) {
  const assert = require("assert");
  assert.strictEqual(mipBufferSize(FMT.DXT1, 8, 256, 256, 0), (256 / 4) * (256 / 4) * 8); // 131072
  assert.strictEqual(mipBufferSize(FMT.DXT1, 8, 256, 256, 8), 8);                          // 1x1 -> one 4x4 block
  assert.strictEqual(mipBufferSize(FMT.DXT5, 16, 8, 8, 0), (2 * 2) * 16);                  // 256
  assert.strictEqual(mipBufferSize(FMT.RGBA8888, 4, 4, 4, 0), 4 * 4 * 4);                  // 256
  console.log("vtex.js: self-check passed");
}
