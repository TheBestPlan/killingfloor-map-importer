// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Savage (Silverback) .s2g texture reader. Reverse-engineered (no public spec; verified by decoding
// props/ruins/*.s2g to correct images). Layout: "S2Graphic" magic + a small header, then the pixel data
// as a DXT (S3TC) or raw-RGBA mip chain, top mip first. Width sits at u16 offset 26 but the reliable
// signal is the total size: for a square W and a given (format, has-mips) exactly one combination leaves
// a small positive header, which pins the format and the top-mip offset. Only the top (largest) mip is
// decoded. Returns { width, height, rgb, alpha? } like the other texture readers, or null if unrecognised.
"use strict";

const { decodeDxt } = require("../gta/txd");

// bytes of one mip level w*h in a format
function mipBytes(w, h, fmt) {
  if (fmt === "RGBA") return w * h * 4;
  const blocks = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4));
  return blocks * (fmt === "DXT1" ? 8 : 16);
}
function chainBytes(W, fmt) { let s = 0, w = W, h = W; while (true) { s += mipBytes(w, h, fmt); if (w === 1 && h === 1) break; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); } return s; }

function readS2g(buf) {
  if (buf.length < 32 || buf.toString("latin1", 0, 9) !== "S2Graphic") return null;
  const size = buf.length, w26 = buf.readUInt16LE(26);
  // Find (W, fmt, mips): the combination whose data size leaves an 8..320-byte header. Prefer the
  // highest-resolution reading, and one whose W matches the width field when it does.
  const cands = [];
  for (const W of [2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4]) for (const fmt of ["DXT5", "DXT1", "RGBA"]) {
    for (const [mips, data] of [[true, chainBytes(W, fmt)], [false, mipBytes(W, W, fmt)]]) {
      const hdr = size - data;
      if (hdr >= 8 && hdr <= 320) cands.push({ W, fmt, hdr, top: mipBytes(W, W, fmt) });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (b.W === w26) - (a.W === w26) || b.top - a.top || a.hdr - b.hdr);
  const { W, fmt, hdr, top } = cands[0];
  const off = hdr;
  if (fmt === "RGBA") {
    const rgb = Buffer.alloc(W * W * 3), alpha = Buffer.alloc(W * W); let hasA = false;
    for (let i = 0; i < W * W; i++) { const o = off + i * 4; rgb[i * 3] = buf[o]; rgb[i * 3 + 1] = buf[o + 1]; rgb[i * 3 + 2] = buf[o + 2]; alpha[i] = buf[o + 3]; if (buf[o + 3] < 255) hasA = true; }
    return { width: W, height: W, rgb, alpha: hasA ? alpha : undefined };
  }
  const r = decodeDxt(buf.subarray(off, off + top), W, W, fmt === "DXT1" ? 1 : 5);
  return { width: W, height: W, rgb: r.rgb, alpha: r.hasAlpha ? r.alpha : undefined };
}

module.exports = { readS2g };

// Self-check: a synthetic "S2Graphic" wrapping one 4x4 DXT5 block must be detected as 4x4 and decoded.
if (require.main === module) {
  const dxt = Buffer.from([0xff, 0xff, 0, 0, 0, 0, 0, 0, 0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]);   // 4x4 DXT5, red-ish
  const hdr = Buffer.alloc(30); hdr.write("S2Graphic", 0, "latin1"); hdr.writeUInt16LE(4, 26);
  const t = readS2g(Buffer.concat([hdr, dxt]));
  const assert = (c, m) => { if (!c) throw new Error("s2g self-check: " + m); };
  assert(t, "returned null");
  assert(t.width === 4 && t.height === 4, "size " + t.width + "x" + t.height);
  assert(t.rgb.length === 4 * 4 * 3, "rgb length " + t.rgb.length);
  assert(t.rgb[0] > 200 && t.rgb[1] < 60 && t.rgb[2] < 60, "expected red-ish top-left, got " + t.rgb[0] + "," + t.rgb[1] + "," + t.rgb[2]);
  console.log("s2g.js: S2Graphic 4x4 DXT5 detect+decode OK");
}
