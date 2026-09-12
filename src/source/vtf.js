// Valve Texture Format (VTF) decoder -> { width, height, rgb, alpha }.
//
// A .vtf stores mipmaps smallest-first, so the full-size image is the last chunk. Only the formats
// world/prop materials actually use are decoded: DXT1/3/5 and the plain BGR/BGRA/RGBA byte layouts.
// The alpha channel is carried out too (DXT1's one bit, DXT3's explicit nibble, DXT5's interpolated
// ramp, and the four-byte layouts) so a $alphatest / $translucent material can cut its foliage out;
// `alpha` is null when the format has none. Anything else returns null and the caller falls back to a
// flat colour.
"use strict";

const FMT = { RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, BGRA8888: 12, DXT1: 13, DXT3: 14, DXT5: 15, BGRX8888: 16, ARGB8888: 11 };

function formatSize(fmt, w, h) {
  if (fmt === FMT.DXT1) return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 8;
  if (fmt === FMT.DXT3 || fmt === FMT.DXT5) return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 16;
  if (fmt === FMT.RGB888 || fmt === FMT.BGR888) return w * h * 3;
  if (fmt === FMT.RGBA8888 || fmt === FMT.ABGR8888 || fmt === FMT.BGRA8888 || fmt === FMT.BGRX8888 || fmt === FMT.ARGB8888) return w * h * 4;
  return -1;   // unsupported
}

// DXT colour block -> 16 RGB pixels, and (for DXT1) the 1-bit alpha the c0<=c1 block encodes.
function decodeDxtColor(data, off, out, ox, oy, width, alpha) {
  const c0 = data.readUInt16LE(off), c1 = data.readUInt16LE(off + 2);
  const bits = data.readUInt32LE(off + 4);
  const r = [0, 0, 0, 0], g = [0, 0, 0, 0], b = [0, 0, 0, 0];
  const unpack = (c, i) => { r[i] = ((c >> 11) & 0x1f) * 255 / 31; g[i] = ((c >> 5) & 0x3f) * 255 / 63; b[i] = (c & 0x1f) * 255 / 31; };
  unpack(c0, 0); unpack(c1, 1);
  const punch = c0 <= c1;   // DXT1: this block carries a transparent index 3
  if (!punch) {
    r[2] = (2 * r[0] + r[1]) / 3; g[2] = (2 * g[0] + g[1]) / 3; b[2] = (2 * b[0] + b[1]) / 3;
    r[3] = (r[0] + 2 * r[1]) / 3; g[3] = (g[0] + 2 * g[1]) / 3; b[3] = (b[0] + 2 * b[1]) / 3;
  } else {
    r[2] = (r[0] + r[1]) / 2; g[2] = (g[0] + g[1]) / 2; b[2] = (b[0] + b[1]) / 2;
    r[3] = 0; g[3] = 0; b[3] = 0;
  }
  for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
    const idx = (bits >> (2 * (py * 4 + px))) & 3;
    const x = ox + px, y = oy + py;
    const o = (y * width + x) * 3;
    out[o] = r[idx]; out[o + 1] = g[idx]; out[o + 2] = b[idx];
    if (alpha) alpha[y * width + x] = (punch && idx === 3) ? 0 : 255;
  }
}

// DXT3: 8 bytes of explicit 4-bit alpha (one nibble per texel) precede the colour block.
function decodeDxt3Alpha(data, off, out, ox, oy, width) {
  for (let i = 0; i < 16; i++) {
    const byte = data[off + (i >> 1)];
    const nib = (i & 1) ? (byte >> 4) : (byte & 0x0f);
    const x = ox + (i & 3), y = oy + (i >> 2);
    out[y * width + x] = nib * 17;
  }
}

// DXT5: two endpoint alphas + a 3-bit index ramp (48 bits) in the block's first 8 bytes.
function decodeDxt5Alpha(data, off, out, ox, oy, width) {
  const a0 = data[off], a1 = data[off + 1];
  const a = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) { for (let i = 1; i <= 6; i++) a[i + 1] = ((7 - i) * a0 + i * a1) / 7; }
  else { for (let i = 1; i <= 4; i++) a[i + 1] = ((5 - i) * a0 + i * a1) / 5; a[6] = 0; a[7] = 255; }
  let lo = data.readUInt32LE(off + 2), hi = data.readUInt16LE(off + 6);
  const bitsAt = (i) => (i < 10 ? (lo >>> (i * 3)) : ((i === 10 ? ((lo >>> 30) | (hi << 2)) : (hi >>> (i * 3 - 32))))) & 7;
  for (let i = 0; i < 16; i++) {
    const x = ox + (i & 3), y = oy + (i >> 2);
    out[y * width + x] = Math.round(a[bitsAt(i)]);
  }
}

function decodeDxt(data, off, w, h, blockBytes, fmt) {
  const rgb = Buffer.alloc(w * h * 3);
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
  const colorOff = blockBytes === 16 ? 8 : 0;   // DXT3/5: 8 alpha bytes precede the colour block
  const hasAlpha = fmt === FMT.DXT1 || fmt === FMT.DXT3 || fmt === FMT.DXT5;
  const alpha = hasAlpha ? Buffer.alloc(w * h, 255) : null;
  let anyCut = false;
  let p = off;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (fmt === FMT.DXT3) decodeDxt3Alpha(data, p, alpha, bx * 4, by * 4, w);
    else if (fmt === FMT.DXT5) decodeDxt5Alpha(data, p, alpha, bx * 4, by * 4, w);
    decodeDxtColor(data, p + colorOff, rgb, bx * 4, by * 4, w, fmt === FMT.DXT1 ? alpha : null);
    p += blockBytes;
  }
  // DXT1 with no punch-through block is fully opaque - do not carry a dead alpha channel.
  if (fmt === FMT.DXT1 && alpha) { for (let i = 0; i < alpha.length; i++) if (alpha[i] !== 255) { anyCut = true; break; } if (!anyCut) return { width: w, height: h, rgb, alpha: null }; }
  return { width: w, height: h, rgb, alpha };
}

function decodeVtf(buf) {
  if (buf.toString("latin1", 0, 4) !== "VTF\0" && buf.toString("latin1", 0, 3) !== "VTF") return null;
  const headerSize = buf.readUInt32LE(12);
  const width = buf.readUInt16LE(16), height = buf.readUInt16LE(18);
  const fmt = buf.readInt32LE(52);
  if (!width || !height) return null;
  const sz = formatSize(fmt, width, height);
  if (sz < 0) return null;                       // unsupported format -> flat colour
  // The full-size mip is the last image chunk in the file.
  const off = buf.length - sz;
  if (off < headerSize) return null;
  if (fmt === FMT.DXT1) return decodeDxt(buf, off, width, height, 8, fmt);
  if (fmt === FMT.DXT3 || fmt === FMT.DXT5) return decodeDxt(buf, off, width, height, 16, fmt);
  // plain byte layouts -> RGB (+ alpha for the four-byte ones)
  const rgb = Buffer.alloc(width * height * 3);
  const hasA = fmt === FMT.RGBA8888 || fmt === FMT.ABGR8888 || fmt === FMT.BGRA8888 || fmt === FMT.ARGB8888;
  const alpha = hasA ? Buffer.alloc(width * height, 255) : null;
  let anyCut = false;
  for (let i = 0; i < width * height; i++) {
    if (fmt === FMT.BGR888) { rgb[i * 3] = buf[off + i * 3 + 2]; rgb[i * 3 + 1] = buf[off + i * 3 + 1]; rgb[i * 3 + 2] = buf[off + i * 3]; }
    else if (fmt === FMT.RGB888) { rgb[i * 3] = buf[off + i * 3]; rgb[i * 3 + 1] = buf[off + i * 3 + 1]; rgb[i * 3 + 2] = buf[off + i * 3 + 2]; }
    else if (fmt === FMT.BGRA8888) { rgb[i * 3] = buf[off + i * 4 + 2]; rgb[i * 3 + 1] = buf[off + i * 4 + 1]; rgb[i * 3 + 2] = buf[off + i * 4]; alpha[i] = buf[off + i * 4 + 3]; }
    else if (fmt === FMT.BGRX8888) { rgb[i * 3] = buf[off + i * 4 + 2]; rgb[i * 3 + 1] = buf[off + i * 4 + 1]; rgb[i * 3 + 2] = buf[off + i * 4]; }
    else if (fmt === FMT.RGBA8888) { rgb[i * 3] = buf[off + i * 4]; rgb[i * 3 + 1] = buf[off + i * 4 + 1]; rgb[i * 3 + 2] = buf[off + i * 4 + 2]; alpha[i] = buf[off + i * 4 + 3]; }
    else if (fmt === FMT.ABGR8888) { rgb[i * 3] = buf[off + i * 4 + 3]; rgb[i * 3 + 1] = buf[off + i * 4 + 2]; rgb[i * 3 + 2] = buf[off + i * 4 + 1]; alpha[i] = buf[off + i * 4]; }
    else if (fmt === FMT.ARGB8888) { rgb[i * 3] = buf[off + i * 4 + 1]; rgb[i * 3 + 1] = buf[off + i * 4 + 2]; rgb[i * 3 + 2] = buf[off + i * 4 + 3]; alpha[i] = buf[off + i * 4]; }
    else return null;
  }
  if (alpha) { for (let i = 0; i < alpha.length; i++) if (alpha[i] !== 255) { anyCut = true; break; } if (!anyCut) return { width, height, rgb, alpha: null }; }
  return { width, height, rgb, alpha };
}

module.exports = { decodeVtf, formatSize, FMT };
