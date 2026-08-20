// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// The two image formats a Quake 3 client stores its textures in: Targa and JPEG.
//
// Node has neither, and adding a dependency for a converter that ships no other one is a bad
// trade - so both are decoded here. What is implemented is exactly what id shipped: TGA types 2,
// 3 and 10 at 8/24/32 bits, and BASELINE JPEG (SOF0). Measured across both games' archives:
// 1201 .jpg, every one of them SOF0; 2339 .tga, types 2 (2220), 10 (116) and 3 (3).
//
// Everything returns { width, height, rgb, alpha } with rgb tightly packed and alpha null when the
// image has none - the shape the rest of the converter passes to unreal/texture.js.
"use strict";

// --- Targa ----------------------------------------------------------------------------------------
function decodeTga(buf) {
  const idLen = buf[0], cmapType = buf[1], type = buf[2];
  const width = buf.readUInt16LE(12), height = buf.readUInt16LE(14);
  const bpp = buf[16], descriptor = buf[17];
  if (cmapType !== 0) throw new Error("colour-mapped TGA not supported");
  if (type !== 2 && type !== 3 && type !== 10) throw new Error("TGA type " + type + " not supported");
  if (bpp !== 8 && bpp !== 24 && bpp !== 32) throw new Error("TGA " + bpp + " bpp not supported");
  const bytes = bpp >> 3;
  const px = width * height;
  const raw = Buffer.alloc(px * bytes);
  let o = 18 + idLen;
  if (type === 10) {
    // RLE: a packet header byte, high bit set for a run of one pixel, clear for a literal count.
    let at = 0;
    while (at < px) {
      const head = buf[o++];
      const count = (head & 0x7f) + 1;
      if (head & 0x80) {
        for (let i = 0; i < count && at < px; i++, at++) buf.copy(raw, at * bytes, o, o + bytes);
        o += bytes;
      } else {
        const n = Math.min(count, px - at);
        buf.copy(raw, at * bytes, o, o + n * bytes);
        o += count * bytes; at += n;
      }
    }
  } else {
    buf.copy(raw, 0, o, o + px * bytes);
  }
  const rgb = Buffer.alloc(px * 3);
  const alpha = bpp === 32 ? Buffer.alloc(px) : null;
  // Bit 5 of the descriptor is "top-left origin"; without it the rows are stored bottom-up.
  const flip = !(descriptor & 0x20);
  for (let y = 0; y < height; y++) {
    const srcRow = flip ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const s = (srcRow * width + x) * bytes, d = (y * width + x);
      if (bpp === 8) { rgb[d * 3] = rgb[d * 3 + 1] = rgb[d * 3 + 2] = raw[s]; continue; }
      // BGR(A) on disk.
      rgb[d * 3] = raw[s + 2]; rgb[d * 3 + 1] = raw[s + 1]; rgb[d * 3 + 2] = raw[s];
      if (alpha) alpha[d] = raw[s + 3];
    }
  }
  return { width, height, rgb, alpha };
}

// --- baseline JPEG --------------------------------------------------------------------------------
const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// The spec's own canonical-Huffman decoder tables (F.2.2.3): for each code length, the smallest and
// largest code of that length and where its values start.
function buildHuffman(bits, values) {
  const mincode = new Int32Array(17), maxcode = new Int32Array(17).fill(-1), valptr = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += bits[l - 1];
    k += bits[l - 1];
    maxcode[l] = bits[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { mincode, maxcode, valptr, values };
}

class BitReader {
  constructor(buf, at) { this.buf = buf; this.at = at; this.bits = 0; this.n = 0; this.eof = false; }
  bit() {
    if (this.n === 0) {
      let b = this.buf[this.at++];
      if (b === undefined) { this.eof = true; b = 0; }
      // 0xFF is the marker escape: 0xFF00 is a literal 0xFF, anything else ends the entropy stream.
      if (b === 0xff) {
        const next = this.buf[this.at];
        if (next === 0x00) this.at++;
        else { this.eof = true; this.at--; b = 0; }
      }
      this.bits = b; this.n = 8;
    }
    this.n--;
    return (this.bits >> this.n) & 1;
  }
  receive(len) { let v = 0; for (let i = 0; i < len; i++) v = (v << 1) | this.bit(); return v; }
  align() { this.n = 0; }
  decode(h) {
    let code = this.bit();
    for (let l = 1; l <= 16; l++) {
      if (h.maxcode[l] >= 0 && code <= h.maxcode[l]) return h.values[h.valptr[l] + code - h.mincode[l]];
      code = (code << 1) | this.bit();
    }
    return 0;
  }
}

const extend = (v, t) => (t === 0 ? 0 : v < 1 << (t - 1) ? v - (1 << t) + 1 : v);

// Separable float IDCT. The textures are at most 512x512, so the fast integer variants buy nothing
// worth the extra hundred lines.
const IDCT_COS = (() => {
  const c = new Float32Array(64);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) c[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2;
  }
  return c;
})();

function idct(block, out) {
  const tmp = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += IDCT_COS[u * 8 + x] * block[y * 8 + u];
      tmp[y * 8 + x] = s;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += IDCT_COS[v * 8 + y] * tmp[v * 8 + x];
      const p = Math.round(s) + 128;
      out[y * 8 + x] = p < 0 ? 0 : p > 255 ? 255 : p;
    }
  }
}

function decodeJpeg(buf) {
  let o = 2;                                     // past SOI
  const quant = [], huffDC = [], huffAC = [];
  let frame = null, restartInterval = 0;
  if (buf.readUInt16BE(0) !== 0xffd8) throw new Error("not a JPEG");

  while (o < buf.length) {
    if (buf[o] !== 0xff) { o++; continue; }
    const marker = buf[o + 1];
    o += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(o);
    const end = o + len;
    const body = o + 2;

    if (marker === 0xdb) {                       // DQT
      let p = body;
      while (p < end) {
        const pq = buf[p] >> 4, tq = buf[p] & 15;
        p++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) { t[ZIGZAG[i]] = pq ? buf.readUInt16BE(p + i * 2) : buf[p + i]; }
        p += pq ? 128 : 64;
        quant[tq] = t;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {          // SOF0 / SOF1
      const height = buf.readUInt16BE(body + 1), width = buf.readUInt16BE(body + 3);
      const n = buf[body + 5];
      const comps = [];
      for (let i = 0; i < n; i++) {
        const p = body + 6 + i * 3;
        comps.push({ id: buf[p], h: buf[p + 1] >> 4, v: buf[p + 1] & 15, tq: buf[p + 2] });
      }
      frame = { width, height, comps };
    } else if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error("only baseline JPEG is supported (SOF marker 0x" + marker.toString(16) + ")");
    } else if (marker === 0xc4) {                // DHT
      let p = body;
      while (p < end) {
        const tc = buf[p] >> 4, th = buf[p] & 15;
        p++;
        const bits = [];
        let total = 0;
        for (let i = 0; i < 16; i++) { bits.push(buf[p + i]); total += buf[p + i]; }
        p += 16;
        const values = buf.subarray(p, p + total);
        p += total;
        (tc === 0 ? huffDC : huffAC)[th] = buildHuffman(bits, values);
      }
    } else if (marker === 0xdd) {                // DRI
      restartInterval = buf.readUInt16BE(body);
    } else if (marker === 0xda) {                // SOS - the entropy-coded scan follows
      if (!frame) throw new Error("JPEG scan before frame header");
      const ns = buf[body];
      const scan = [];
      for (let i = 0; i < ns; i++) {
        const cs = buf[body + 1 + i * 2], td = buf[body + 2 + i * 2] >> 4, ta = buf[body + 2 + i * 2] & 15;
        const c = frame.comps.find((x) => x.id === cs);
        scan.push({ c, dc: huffDC[td], ac: huffAC[ta] });
      }
      o = decodeScan(buf, end, frame, scan, quant, restartInterval);
      continue;
    }
    o = end;
  }
  if (!frame || !frame.planes) throw new Error("JPEG has no image data");
  return toRgb(frame);
}

function decodeScan(buf, start, frame, scan, quant, restartInterval) {
  const hMax = Math.max(...frame.comps.map((c) => c.h)), vMax = Math.max(...frame.comps.map((c) => c.v));
  const mcuW = hMax * 8, mcuH = vMax * 8;
  const mcusX = Math.ceil(frame.width / mcuW), mcusY = Math.ceil(frame.height / mcuH);
  for (const c of frame.comps) {
    c.lineW = mcusX * c.h * 8;
    c.plane = new Uint8Array(c.lineW * mcusY * c.v * 8);
    c.pred = 0;
  }
  const br = new BitReader(buf, start);
  const block = new Int32Array(64);
  const pixels = new Uint8Array(64);
  let mcu = 0;
  const total = mcusX * mcusY;
  while (mcu < total) {
    const run = restartInterval ? Math.min(restartInterval, total - mcu) : total - mcu;
    for (const s of scan) s.c.pred = 0;
    for (let k = 0; k < run; k++, mcu++) {
      const my = (mcu / mcusX) | 0, mx = mcu % mcusX;
      for (const s of scan) {
        const c = s.c, q = quant[c.tq];
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            block.fill(0);
            const t = br.decode(s.dc);
            const diff = t ? extend(br.receive(t), t) : 0;
            c.pred += diff;
            block[0] = c.pred * q[0];
            let i = 1;
            while (i < 64) {
              const rs = br.decode(s.ac);
              const r = rs >> 4, sz = rs & 15;
              if (sz === 0) { if (r !== 15) break; i += 16; continue; }
              i += r;
              if (i > 63) break;
              const z = ZIGZAG[i];
              block[z] = extend(br.receive(sz), sz) * q[z];
              i++;
            }
            idct(block, pixels);
            const ox = (mx * c.h + bx) * 8, oy = (my * c.v + by) * 8;
            for (let y = 0; y < 8; y++) {
              c.plane.set(pixels.subarray(y * 8, y * 8 + 8), (oy + y) * c.lineW + ox);
            }
          }
        }
      }
    }
    // Restart marker between intervals: byte-align and step over it.
    if (mcu < total) {
      br.align();
      while (br.at < buf.length - 1 && !(buf[br.at] === 0xff && buf[br.at + 1] >= 0xd0 && buf[br.at + 1] <= 0xd7)) br.at++;
      br.at += 2;
      br.eof = false;
    }
  }
  frame.planes = true;
  frame.hMax = hMax; frame.vMax = vMax;
  // Where the next marker starts: skip whatever is left of the entropy stream.
  let at = br.at;
  while (at < buf.length - 1 && !(buf[at] === 0xff && buf[at + 1] !== 0x00 && !(buf[at + 1] >= 0xd0 && buf[at + 1] <= 0xd7))) at++;
  return at;
}

function toRgb(frame) {
  const { width, height, comps, hMax, vMax } = frame;
  const rgb = Buffer.alloc(width * height * 3);
  const sample = (c, x, y) => c.plane[((y * c.v / vMax) | 0) * c.lineW + ((x * c.h / hMax) | 0)];
  if (comps.length === 1) {
    const c = comps[0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = sample(c, x, y), d = (y * width + x) * 3;
        rgb[d] = rgb[d + 1] = rgb[d + 2] = v;
      }
    }
    return { width, height, rgb, alpha: null };
  }
  const [cy, cb, cr] = comps;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const Y = sample(cy, x, y), Cb = sample(cb, x, y) - 128, Cr = sample(cr, x, y) - 128;
      const d = (y * width + x) * 3;
      const r = Y + 1.402 * Cr, g = Y - 0.344136 * Cb - 0.714136 * Cr, b = Y + 1.772 * Cb;
      rgb[d] = r < 0 ? 0 : r > 255 ? 255 : r;
      rgb[d + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      rgb[d + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
  return { width, height, rgb, alpha: null };
}

function decode(name, buf) {
  if (/\.tga$/i.test(name)) return decodeTga(buf);
  if (/\.jpe?g$/i.test(name)) return decodeJpeg(buf);
  throw new Error("unsupported image format: " + name);
}

module.exports = { decode, decodeTga, decodeJpeg };
