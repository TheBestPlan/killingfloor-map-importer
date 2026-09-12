// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Project IGI .tex texture reader (reverse-engineered; verified by decoding to correct images). Layout:
// "LOOP" magic + a 32-byte header (width u16 @22, height u16 @24), then the top mip's pixels. The pixel
// format is 16-bit ARGB1555 (2 bytes/pixel) for most, or BGRA8888 (4 bytes/pixel) for the few named
// *_argb8888 - detected from bytes-per-pixel = (size - 32) / (w*h). Returns { width, height, rgb, alpha? }.
"use strict";

function readTex(buf) {
  if (buf.length < 34 || buf.toString("latin1", 0, 4) !== "LOOP") return null;
  const W = buf.readUInt16LE(22), H = buf.readUInt16LE(24);
  if (!W || !H || W > 4096 || H > 4096) return null;
  // Bytes-per-pixel across the whole file: ~2 for ARGB1555, ~4 for BGRA8888, and a bit more when the file
  // carries a mip chain (1555+mips ~3, 8888+mips ~5). The top (largest) mip is stored first, right after the
  // header, so decode only that: bpp<=3 -> ARGB1555 (n*2 bytes), bpp>=4 -> BGRA8888 (n*4 bytes).
  const px = 32, n = W * H, bpp = Math.round((buf.length - px) / n);
  const rgb = Buffer.alloc(n * 3), alpha = Buffer.alloc(n); let hasA = false;
  if (bpp >= 2 && bpp <= 3) {                          // ARGB1555 (top mip)
    if (px + n * 2 > buf.length) return null;
    for (let i = 0; i < n; i++) {
      const v = buf.readUInt16LE(px + i * 2);
      rgb[i * 3] = ((v >> 10) & 31) * 255 / 31 | 0; rgb[i * 3 + 1] = ((v >> 5) & 31) * 255 / 31 | 0; rgb[i * 3 + 2] = (v & 31) * 255 / 31 | 0;
      const a = (v & 0x8000) ? 255 : 0; alpha[i] = a; if (!a) hasA = true;
    }
  } else if (bpp >= 4) {                               // BGRA8888 (top mip)
    if (px + n * 4 > buf.length) return null;
    for (let i = 0; i < n; i++) { const o = px + i * 4; rgb[i * 3] = buf[o + 2]; rgb[i * 3 + 1] = buf[o + 1]; rgb[i * 3 + 2] = buf[o]; alpha[i] = buf[o + 3]; if (buf[o + 3] < 255) hasA = true; }
  } else return null;
  return { width: W, height: H, rgb, alpha: hasA ? alpha : undefined };
}

module.exports = { readTex };

// Self-check: a synthetic "LOOP" header (2x2, ARGB1555) with one opaque red pixel decodes to red.
if (require.main === module) {
  const b = Buffer.alloc(32 + 2 * 2 * 2); b.write("LOOP", 0, "latin1"); b.writeUInt16LE(2, 22); b.writeUInt16LE(2, 24);
  b.writeUInt16LE(0x8000 | (31 << 10), 32);          // ARGB1555: A=1, R=31, G=0, B=0
  const t = readTex(b);
  const assert = (c, m) => { if (!c) throw new Error("tex self-check: " + m); };
  assert(t && t.width === 2 && t.height === 2, "size");
  assert(t.rgb[0] === 255 && t.rgb[1] === 0 && t.rgb[2] === 0, "expected red, got " + t.rgb[0] + "," + t.rgb[1] + "," + t.rgb[2]);
  console.log("tex.js: LOOP ARGB1555 decode OK");
}
