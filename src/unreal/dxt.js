// DXT3 encode/decode. Killing Floor stores its baked BSP lightmap atlases as DXT3 512x512
// (ETextureFormat 7), so that is what this tool writes. Lightmaps are smooth, so the cheap
// min/max endpoint fit is visually adequate; the decoder exists to check the encoder.
"use strict";

const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = (c) => {
  const r = (c >> 11) & 0x1f, g = (c >> 5) & 0x3f, b = c & 0x1f;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
};

// rgb: tightly packed RGB8, width*height*3. Returns DXT3 blocks (16 bytes per 4x4).
function encodeDXT3(rgb, width, height, alpha) {
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  const out = Buffer.alloc(bw * bh * 16);
  let o = 0;
  const px = new Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const x = Math.min(bx * 4 + i, width - 1), y = Math.min(by * 4 + j, height - 1);
          const s = (y * width + x) * 3;
          px[j * 4 + i] = [rgb[s], rgb[s + 1], rgb[s + 2]];
        }
      }
      // alpha block, 4 bits per texel
      if (!alpha) { for (let k = 0; k < 8; k++) out[o + k] = 0xff; }
      else {
        for (let j = 0; j < 4; j++) {
          let lo4 = 0;
          for (let i = 0; i < 4; i++) {
            const x = Math.min(bx * 4 + i, width - 1), y = Math.min(by * 4 + j, height - 1);
            lo4 |= (alpha[y * width + x] >> 4) << (i * 4);
          }
          out.writeUInt16LE(lo4, o + j * 2);
        }
      }
      // colour endpoints: extremes along the block's dominant axis, approximated by luminance
      let lo = 0, hi = 0, loL = 1e9, hiL = -1e9;
      for (let k = 0; k < 16; k++) {
        const L = px[k][0] * 299 + px[k][1] * 587 + px[k][2] * 114;
        if (L < loL) { loL = L; lo = k; }
        if (L > hiL) { hiL = L; hi = k; }
      }
      let c0 = to565(px[hi][0], px[hi][1], px[hi][2]);
      let c1 = to565(px[lo][0], px[lo][1], px[lo][2]);
      if (c0 === c1) {
        // flat block: single colour, indices all 0
        out.writeUInt16LE(c0, o + 8); out.writeUInt16LE(c1, o + 10);
        out.writeUInt32LE(0, o + 12);
        o += 16; continue;
      }
      if (c0 < c1) { const t = c0; c0 = c1; c1 = t; }
      const e0 = from565(c0), e1 = from565(c1);
      const pal = [
        e0, e1,
        [(2 * e0[0] + e1[0]) / 3, (2 * e0[1] + e1[1]) / 3, (2 * e0[2] + e1[2]) / 3],
        [(e0[0] + 2 * e1[0]) / 3, (e0[1] + 2 * e1[1]) / 3, (e0[2] + 2 * e1[2]) / 3],
      ];
      let bits = 0;
      for (let k = 15; k >= 0; k--) {
        let best = 0, bestD = Infinity;
        for (let p = 0; p < 4; p++) {
          const d = (px[k][0] - pal[p][0]) ** 2 + (px[k][1] - pal[p][1]) ** 2 + (px[k][2] - pal[p][2]) ** 2;
          if (d < bestD) { bestD = d; best = p; }
        }
        bits = (bits << 2) | best;
      }
      out.writeUInt16LE(c0, o + 8); out.writeUInt16LE(c1, o + 10);
      out.writeUInt32LE(bits >>> 0, o + 12);
      o += 16;
    }
  }
  return out;
}

// Returns RGBA8, width*height*4.
function decodeDXT3(data, width, height) {
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  const out = Buffer.alloc(width * height * 4, 255);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const c0 = data.readUInt16LE(o + 8), c1 = data.readUInt16LE(o + 10);
      const bits = data.readUInt32LE(o + 12);
      const e0 = from565(c0), e1 = from565(c1);
      const pal = c0 > c1
        ? [e0, e1,
          [(2 * e0[0] + e1[0]) / 3 | 0, (2 * e0[1] + e1[1]) / 3 | 0, (2 * e0[2] + e1[2]) / 3 | 0],
          [(e0[0] + 2 * e1[0]) / 3 | 0, (e0[1] + 2 * e1[1]) / 3 | 0, (e0[2] + 2 * e1[2]) / 3 | 0]]
        : [e0, e1,
          [(e0[0] + e1[0]) >> 1, (e0[1] + e1[1]) >> 1, (e0[2] + e1[2]) >> 1], [0, 0, 0]];
      for (let k = 0; k < 16; k++) {
        const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2);
        if (x >= width || y >= height) continue;
        const c = pal[(bits >>> (k * 2)) & 3];
        const d = (y * width + x) * 4;
        out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = 255;
      }
      o += 16;
    }
  }
  return out;
}

// Box-filter an RGB8 image to half size (used to build the atlas's second mip).
function halveRGB(rgb, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = Buffer.alloc(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      for (let c = 0; c < 3; c++) {
        const x0 = Math.min(x * 2, w - 1), x1 = Math.min(x * 2 + 1, w - 1);
        const y0 = Math.min(y * 2, h - 1), y1 = Math.min(y * 2 + 1, h - 1);
        out[(y * nw + x) * 3 + c] = (rgb[(y0 * w + x0) * 3 + c] + rgb[(y0 * w + x1) * 3 + c] +
          rgb[(y1 * w + x0) * 3 + c] + rgb[(y1 * w + x1) * 3 + c]) >> 2;
      }
    }
  }
  return { rgb: out, width: nw, height: nh };
}

module.exports = { encodeDXT3, decodeDXT3, halveRGB, to565, from565 };
