// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Source 2 compiled resource container (.vwrld_c / .vmdl_c / .vmesh_c / .vtex_c ...). A small header
// points at a table of blocks, each a 4-char tag (DATA, RERL, MVTX, MIDX, MDAT, CTRL, VBIB, ...) with
// an offset and size. This slices out each block; the meaning of a block is the caller's business.
"use strict";

function readResource(data) {
  const fileSize = data.readUInt32LE(0);
  const headerVersion = data.readUInt16LE(4);
  const resourceVersion = data.readUInt16LE(6);
  const blockOffset = data.readUInt32LE(8);
  const blockCount = data.readUInt32LE(12);
  const blocks = [];
  let bp = 8 + blockOffset;                  // blockOffset is relative to the field at byte 8
  for (let i = 0; i < blockCount; i++) {
    const base = bp;
    const type = data.toString("latin1", bp, bp + 4); bp += 4;
    const off = data.readUInt32LE(bp); bp += 4;   // relative to this offset field (base + 4)
    const size = data.readUInt32LE(bp); bp += 4;
    const abs = base + 4 + off;
    blocks.push({ type, offset: abs, size, data: data.subarray(abs, abs + size) });
  }
  return { fileSize, headerVersion, resourceVersion, blocks, block: (t) => blocks.find((b) => b.type === t) };
}

module.exports = { readResource };
