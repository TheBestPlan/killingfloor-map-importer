// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GTA III / Vice City RenderWare texture dictionary (.txd). A TexDictionary (chunk 0x16) holds a count
// then that many TextureNative (0x15) rasters. GTA III map textures are 8-bit palettised (a 256-entry
// BGRA palette + one index per texel); a few are raw 16/32-bit or DXT. This decodes each named raster's
// top mip to { width, height, rgb, alpha? } - all the KF texture writer needs.
"use strict";

// --- DXT (S3TC) decode: Vice City compresses its rasters (raster comp byte 1=DXT1, 2/3=DXT3, 4/5=DXT5) ---
function color565(c, out, o) { out[o] = ((c >> 11) & 31) * 255 / 31 | 0; out[o + 1] = ((c >> 5) & 63) * 255 / 63 | 0; out[o + 2] = (c & 31) * 255 / 31 | 0; }
function decodeDxt(data, w, h, dxt) {
  const rgb = Buffer.alloc(w * h * 3), alpha = Buffer.alloc(w * h).fill(255);
  const blockBytes = dxt === 1 ? 8 : 16, colorOff = dxt === 1 ? 0 : 8;
  let hasAlpha = false, p = 0;
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
  const c = [0, 0, 0, 0], g = [new Uint8Array(3), new Uint8Array(3), new Uint8Array(3), new Uint8Array(3)];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (p + blockBytes > data.length) break;
    // alpha
    let a4 = null, a8 = null;
    if (dxt === 3) { a4 = data.subarray(p, p + 8); }
    else if (dxt === 5) { const a0 = data[p], a1 = data[p + 1]; a8 = new Uint8Array(8); a8[0] = a0; a8[1] = a1; if (a0 > a1) { for (let i = 1; i < 7; i++) a8[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0; } else { for (let i = 1; i < 5; i++) a8[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0; a8[6] = 0; a8[7] = 255; } }
    const co = p + colorOff;
    const c0 = data.readUInt16LE(co), c1 = data.readUInt16LE(co + 2);
    color565(c0, g[0], 0); color565(c1, g[1], 0);
    if (dxt !== 1 || c0 > c1) { for (let k = 0; k < 3; k++) { g[2][k] = (2 * g[0][k] + g[1][k]) / 3 | 0; g[3][k] = (g[0][k] + 2 * g[1][k]) / 3 | 0; } }
    else { for (let k = 0; k < 3; k++) { g[2][k] = (g[0][k] + g[1][k]) / 2 | 0; g[3][k] = 0; } }
    const bits = data.readUInt32LE(co + 4);
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const x = bx * 4 + px, y = by * 4 + py; if (x >= w || y >= h) continue;
      const ci = (bits >> (2 * (py * 4 + px))) & 3; const oi = (y * w + x); const o = oi * 3;
      rgb[o] = g[ci][0]; rgb[o + 1] = g[ci][1]; rgb[o + 2] = g[ci][2];
      let av = 255;
      if (dxt === 1 && c0 <= c1 && ci === 3) { av = 0; }
      else if (dxt === 3) { const nib = a4[py * 2 + (px >> 1)]; av = ((px & 1) ? (nib >> 4) : (nib & 0xf)) * 17; }
      else if (dxt === 5) { const abits = data[p + 2] | (data[p + 3] << 8) | (data[p + 4] << 16); const abits2 = data[p + 5] | (data[p + 6] << 8) | (data[p + 7] << 16); const idx = py * 4 + px; const ai = idx < 8 ? (abits >> (3 * idx)) & 7 : (abits2 >> (3 * (idx - 8))) & 7; av = a8[ai]; }
      alpha[oi] = av; if (av < 255) hasAlpha = true;
    }
    p += blockBytes;
  }
  return { rgb, alpha, hasAlpha };
}

function hdr(d, o) { return { type: d.readUInt32LE(o), size: d.readUInt32LE(o + 4), data: o + 12 }; }
function find(d, off, end, type) { let p = off; while (p + 12 <= end) { const h = hdr(d, p); if (h.type === type) return h; p = h.data + h.size; } return null; }

// rasterFormat flags
const FMT_PAL8 = 0x2000, FMT_PAL4 = 0x4000;
const FMT_MASK = 0x0f00;   // 0x0100 default, 0x0200 1555, 0x0300 565, 0x0400 4444, 0x0500 lum8, 0x0600 8888, 0x0700 888, 0x0800 555

// One TextureNative -> { name, width, height, rgb, alpha? } or null.
function readTextureNative(d, tn) {
  const st = find(d, tn.data, tn.data + tn.size, 0x01);
  if (!st) return null;
  let p = st.data;
  const platform = d.readUInt32LE(p); p += 4; p += 4;                    // platform, filter/addressing
  const name = d.toString("latin1", p, p + 32).replace(/\0.*$/, "").toLowerCase(); p += 32;
  p += 32;                                                               // mask name
  const rasterFmt = d.readUInt32LE(p); p += 4;
  const alphaOrD3d = d.readUInt32LE(p); p += 4;                          // D3D8: hasAlpha; D3D9: fourCC
  const w = d.readUInt16LE(p); p += 2; const h = d.readUInt16LE(p); p += 2;
  const depth = d[p++], numLevels = d[p++], rasterType = d[p++], comp = d[p++];
  const fmt = rasterFmt & FMT_MASK;
  const pal8 = !!(rasterFmt & FMT_PAL8), pal4 = !!(rasterFmt & FMT_PAL4);

  let palette = null;
  if (pal8) { palette = d.subarray(p, p + 256 * 4); p += 256 * 4; }
  else if (pal4) { palette = d.subarray(p, p + 32 * 4); p += 32 * 4; }

  const mipSize = d.readUInt32LE(p); p += 4;
  const data = d.subarray(p, p + mipSize);

  if (comp) {   // DXT compressed (Vice City): comp 1=DXT1, 2/3=DXT3, 4/5=DXT5
    const dxt = comp === 1 ? 1 : comp <= 3 ? 3 : 5;
    const out = decodeDxt(data, w, h, dxt);
    return { name, width: w, height: h, rgb: out.rgb, alpha: out.hasAlpha ? out.alpha : undefined };
  }

  const rgb = Buffer.alloc(w * h * 3); const alpha = Buffer.alloc(w * h); let hasAlpha = false;
  const put = (i, r, g, b, a) => { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; alpha[i] = a; if (a < 255) hasAlpha = true; };

  if (palette) {
    // The palette is RGBA (verified against named colours - `yellow` = 169,160,2,128 is R,G,B,A), UNLIKE
    // the 32-bit direct rasters below, which are BGRA. Reading the palette as BGRA swapped R<->B, which
    // turned every warm colour blue (amber traffic lights -> cyan, yellow road lines -> blue).
    for (let i = 0; i < w * h; i++) { const idx = pal8 ? data[i] : 0; const o = idx * 4; put(i, palette[o], palette[o + 1], palette[o + 2], palette[o + 3]); }
  } else if (depth === 32 && (fmt === 0x600 || fmt === 0x700)) {
    for (let i = 0; i < w * h; i++) { const o = i * 4; put(i, data[o + 2], data[o + 1], data[o], fmt === 0x600 ? data[o + 3] : 255); }   // BGRA
  } else if (depth === 16 && fmt === 0x200) {                             // 1555
    for (let i = 0; i < w * h; i++) { const v = data.readUInt16LE(i * 2); put(i, ((v >> 10) & 31) * 8, ((v >> 5) & 31) * 8, (v & 31) * 8, (v & 0x8000) ? 255 : 0); }
  } else if (depth === 16 && fmt === 0x300) {                             // 565
    for (let i = 0; i < w * h; i++) { const v = data.readUInt16LE(i * 2); put(i, ((v >> 11) & 31) * 8, ((v >> 5) & 63) * 4, (v & 31) * 8, 255); }
  } else {
    return null;   // DXT / other compressed rasters not decoded here (rare on GTA III) - flat fallback
  }
  return { name, width: w, height: h, rgb, alpha: hasAlpha ? alpha : undefined };
}

// Parse a .txd -> Map(lowercased name -> { width, height, rgb, alpha? }).
function readTxd(buf) {
  const out = new Map();
  const dict = hdr(buf, 0);
  if (dict.type !== 0x16) return out;
  const st = find(buf, dict.data, dict.data + dict.size, 0x01);
  if (!st) return out;
  const n = buf.readUInt16LE(st.data);
  let p = st.data + st.size;
  for (let i = 0; i < n; i++) {
    const tn = find(buf, p, dict.data + dict.size, 0x15);
    if (!tn) break;
    try { const t = readTextureNative(buf, tn); if (t) out.set(t.name, t); } catch (e) { /* skip bad raster */ }
    p = tn.data + tn.size;
  }
  return out;
}

// Just the texture NAMES in a .txd (no decode) - to index which txd holds a given texture, for the
// parent-chain fallback (GTA shares vegetation/generic rasters across a txd other than the model's own).
function readTxdNames(buf) {
  const names = [];
  const dict = hdr(buf, 0);
  if (dict.type !== 0x16) return names;
  const st = find(buf, dict.data, dict.data + dict.size, 0x01);
  if (!st) return names;
  const n = buf.readUInt16LE(st.data);
  let p = st.data + st.size;
  for (let i = 0; i < n; i++) {
    const tn = find(buf, p, dict.data + dict.size, 0x15);
    if (!tn) break;
    const tst = find(buf, tn.data, tn.data + tn.size, 0x01);
    if (tst) { const nm = buf.toString("latin1", tst.data + 8, tst.data + 40).replace(/\0.*$/, "").toLowerCase(); if (nm) names.push(nm); }
    p = tn.data + tn.size;
  }
  return names;
}

module.exports = { readTxd, readTxdNames, decodeDxt };
