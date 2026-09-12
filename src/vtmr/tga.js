// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Truevision TGA decoder for Vampire: The Masquerade - Redemption level textures. The game's textures
// live in LMaterials.nob as uncompressed (type 2) or RLE (type 10) 24/32-bit Targa images. Returns the
// top mip as { width, height, rgb, alpha? } - all the KF texture writer needs.
"use strict";

// Decode a .tga buffer -> { width, height, rgb, alpha? } or null for an unsupported layout.
function decodeTga(b) {
  if (b.length < 18) return null;
  const idlen = b[0], imgType = b[2];
  const w = b.readUInt16LE(12), h = b.readUInt16LE(14), bpp = b[16], desc = b[17];
  if (!w || !h || (bpp !== 24 && bpp !== 32)) return null;
  if (imgType !== 2 && imgType !== 10) return null;          // only truecolor raw / RLE
  const bytespp = bpp >> 3, topOrigin = (desc & 0x20) !== 0;
  let p = 18 + idlen;
  const n = w * h;
  const px = new Uint8Array(n * 4);                          // BGRA source order
  if (imgType === 2) {
    for (let i = 0; i < n; i++) { px[i * 4] = b[p]; px[i * 4 + 1] = b[p + 1]; px[i * 4 + 2] = b[p + 2]; px[i * 4 + 3] = bytespp === 4 ? b[p + 3] : 255; p += bytespp; }
  } else {                                                   // RLE (type 10)
    let i = 0;
    while (i < n && p < b.length) {
      const c = b[p++], cnt = (c & 0x7f) + 1;
      if (c & 0x80) {                                        // run packet: one pixel repeated
        const B = b[p], G = b[p + 1], R = b[p + 2], A = bytespp === 4 ? b[p + 3] : 255; p += bytespp;
        for (let k = 0; k < cnt && i < n; k++, i++) { px[i * 4] = B; px[i * 4 + 1] = G; px[i * 4 + 2] = R; px[i * 4 + 3] = A; }
      } else {                                               // raw packet
        for (let k = 0; k < cnt && i < n; k++, i++) { px[i * 4] = b[p]; px[i * 4 + 1] = b[p + 1]; px[i * 4 + 2] = b[p + 2]; px[i * 4 + 3] = bytespp === 4 ? b[p + 3] : 255; p += bytespp; }
      }
    }
  }
  const rgb = Buffer.alloc(n * 3), alpha = Buffer.alloc(n); let hasAlpha = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const src = ((topOrigin ? y : h - 1 - y) * w + x) * 4, o = y * w + x;
    rgb[o * 3] = px[src + 2]; rgb[o * 3 + 1] = px[src + 1]; rgb[o * 3 + 2] = px[src];   // BGR -> RGB
    alpha[o] = px[src + 3]; if (px[src + 3] < 255) hasAlpha = true;
  }
  return { width: w, height: h, rgb, alpha: hasAlpha ? alpha : undefined };
}

module.exports = { decodeTga };
