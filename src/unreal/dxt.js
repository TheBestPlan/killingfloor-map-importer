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
      // Colour endpoints: the extremes along the block's OWN principal axis.
      //
      // Luminance is the wrong axis whenever a block's colours do not vary along it. Taking the
      // darkest and brightest texel and using their full RGB puts the interpolation line through
      // colours the block never contained, and on a red stone wall whose darkest texel happens to
      // be greenish that line runs red-to-green: the four palette entries are then all off-hue and
      // the wall wears green and magenta confetti. Measured on Quake 3's gothic_block set, where it
      // was the single worst artefact in a converted map.
      //
      // The fix is the standard one: mean, covariance, a few power iterations for the dominant
      // eigenvector, then project. Eight iterations converge on any 16-texel block, and the whole
      // thing costs about as much as the index search that follows it.
      const mean = [0, 0, 0];
      for (let k = 0; k < 16; k++) for (let c = 0; c < 3; c++) mean[c] += px[k][c] / 16;
      const cov = [0, 0, 0, 0, 0, 0];        // xx, xy, xz, yy, yz, zz
      for (let k = 0; k < 16; k++) {
        const dr = px[k][0] - mean[0], dg = px[k][1] - mean[1], db = px[k][2] - mean[2];
        cov[0] += dr * dr; cov[1] += dr * dg; cov[2] += dr * db;
        cov[3] += dg * dg; cov[4] += dg * db; cov[5] += db * db;
      }
      // Start from the covariance ROW with the most weight, not from the sum of the rows: on a
      // block whose colours run red-up/blue-down the rows cancel exactly and the sum is the zero
      // vector, which iterates to nothing and silently falls back to the luminance axis this is
      // here to replace (caught by the round-trip check in test/selfcheck.js).
      const rows = [[cov[0], cov[1], cov[2]], [cov[1], cov[3], cov[4]], [cov[2], cov[4], cov[5]]];
      let best = rows[0], bestN = -1;
      for (const r of rows) {
        const n = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
        if (n > bestN) { bestN = n; best = r; }
      }
      let ax = best[0], ay = best[1], az = best[2];
      for (let it = 0; it < 8; it++) {
        const nx = cov[0] * ax + cov[1] * ay + cov[2] * az;
        const ny = cov[1] * ax + cov[3] * ay + cov[4] * az;
        const nz = cov[2] * ax + cov[4] * ay + cov[5] * az;
        const m = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
        if (m < 1e-6) break;
        ax = nx / m; ay = ny / m; az = nz / m;
      }
      const len = Math.hypot(ax, ay, az);
      // A block of one colour has no axis; luminance is as good as anything for the degenerate case.
      if (len < 1e-6) { ax = 0.299; ay = 0.587; az = 0.114; }
      else { ax /= len; ay /= len; az /= len; }
      let tLo = Infinity, tHi = -Infinity;
      for (let k = 0; k < 16; k++) {
        const t = (px[k][0] - mean[0]) * ax + (px[k][1] - mean[1]) * ay + (px[k][2] - mean[2]) * az;
        if (t < tLo) tLo = t;
        if (t > tHi) tHi = t;
      }
      const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
      const endpoint = (t) => [clamp255(mean[0] + ax * t), clamp255(mean[1] + ay * t), clamp255(mean[2] + az * t)];
      const eHi = endpoint(tHi), eLo = endpoint(tLo);
      let c0 = to565(eHi[0], eHi[1], eHi[2]);
      let c1 = to565(eLo[0], eLo[1], eLo[2]);
      if (c0 === c1) {
        // flat block: single colour, indices all 0
        out.writeUInt16LE(c0, o + 8); out.writeUInt16LE(c1, o + 10);
        out.writeUInt32LE(0, o + 12);
        o += 16; continue;
      }
      if (c0 < c1) { const t = c0; c0 = c1; c1 = t; }

      // Assign indices, then re-solve the endpoints for the indices just assigned, twice.
      //
      // 5:6:5 quantisation of the endpoints is the whole artefact: it shifts a block's hue by up to
      // 3% in red and blue against 1.5% in green, uniformly across all sixteen texels, so a wall of
      // detailed stone comes out in block-sized patches of green and magenta. Refitting after the
      // rounding lets the endpoints land where they cancel the shift instead of carrying it.
      const idx = new Int32Array(16);
      const palOf = (a, b) => [a, b,
        [(2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3, (2 * a[2] + b[2]) / 3],
        [(a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3, (a[2] + 2 * b[2]) / 3]];
      // How much each endpoint weighs in each palette entry.
      const WA = [1, 0, 2 / 3, 1 / 3], WB = [0, 1, 1 / 3, 2 / 3];
      const assign = (pal) => {
        for (let k = 0; k < 16; k++) {
          let bp = 0, bd = Infinity;
          for (let p = 0; p < 4; p++) {
            const d = (px[k][0] - pal[p][0]) ** 2 + (px[k][1] - pal[p][1]) ** 2 + (px[k][2] - pal[p][2]) ** 2;
            if (d < bd) { bd = d; bp = p; }
          }
          idx[k] = bp;
        }
      };
      assign(palOf(from565(c0), from565(c1)));
      for (let pass = 0; pass < 2; pass++) {
        let aa = 0, ab = 0, bb = 0;
        const ac = [0, 0, 0], bc = [0, 0, 0];
        for (let k = 0; k < 16; k++) {
          const a = WA[idx[k]], b = WB[idx[k]];
          aa += a * a; ab += a * b; bb += b * b;
          for (let c = 0; c < 3; c++) { ac[c] += a * px[k][c]; bc[c] += b * px[k][c]; }
        }
        const det = aa * bb - ab * ab;
        if (Math.abs(det) < 1e-6) break;                 // every texel on one endpoint: nothing to fit
        const n0 = [0, 0, 0], n1 = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          n0[c] = clamp255((bb * ac[c] - ab * bc[c]) / det);
          n1[c] = clamp255((aa * bc[c] - ab * ac[c]) / det);
        }
        let q0 = to565(n0[0], n0[1], n0[2]), q1 = to565(n1[0], n1[1], n1[2]);
        if (q0 === q1) break;
        if (q0 < q1) { const t = q0; q0 = q1; q1 = t; }
        c0 = q0; c1 = q1;
        assign(palOf(from565(c0), from565(c1)));
      }
      let bits = 0;
      for (let k = 15; k >= 0; k--) bits = (bits << 2) | idx[k];
      out.writeUInt16LE(c0, o + 8); out.writeUInt16LE(c1, o + 10);
      out.writeUInt32LE(bits >>> 0, o + 12);
      o += 16;
    }
  }
  return out;
}

// DXT1 (ETextureFormat 3) is the same colour block without the alpha half: 8 bytes per 4x4 instead
// of 16, a quarter of the bytes RGBA8 needs. The six sky faces were the biggest thing in a
// converted map by a wide margin - 1.33 MB each as RGBA8, 8 MB of an 11 MB file - and a hand-built
// port ships the same sky at 1024 in DXT1 for 0.5 MB a face. Resolution buys back what block
// compression costs on a gradient.
function encodeDXT1(rgb, width, height) {
  const dxt3 = encodeDXT3(rgb, width, height, null);
  const out = Buffer.alloc(dxt3.length / 2);
  for (let b = 0, o = 0; b < dxt3.length; b += 16, o += 8) dxt3.copy(out, o, b + 8, b + 16);
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

// DXT1 to tight RGB. The colour half of a DXT3 block with none of the alpha half in front of it -
// the endpoints and the two-bit indices are the same eight bytes.
function decodeDXT1(data, width, height) {
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  const out = Buffer.alloc(width * height * 3);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (o + 8 > data.length) return out;
      const c0 = data.readUInt16LE(o), c1 = data.readUInt16LE(o + 2);
      const bits = data.readUInt32LE(o + 4);
      const e0 = from565(c0), e1 = from565(c1);
      const pal = c0 > c1
        ? [e0, e1,
          [(2 * e0[0] + e1[0]) / 3 | 0, (2 * e0[1] + e1[1]) / 3 | 0, (2 * e0[2] + e1[2]) / 3 | 0],
          [(e0[0] + 2 * e1[0]) / 3 | 0, (e0[1] + 2 * e1[1]) / 3 | 0, (e0[2] + 2 * e1[2]) / 3 | 0]]
        : [e0, e1, [(e0[0] + e1[0]) >> 1, (e0[1] + e1[1]) >> 1, (e0[2] + e1[2]) >> 1], [0, 0, 0]];
      for (let k = 0; k < 16; k++) {
        const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2);
        if (x >= width || y >= height) continue;
        const c = pal[(bits >>> (k * 2)) & 3];
        const d = (y * width + x) * 3;
        out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2];
      }
      o += 8;
    }
  }
  return out;
}

// DXT1 to a single channel. Used for the terrain layer masks, which are grey images stored as
// colour: what a layer is worth at a texel is the same in all three channels, so red is the weight
// and there is no reason to expand to RGBA first.
function decodeDXT1Gray(data, width, height) {
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4);
  const out = Buffer.alloc(width * height);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (o + 8 > data.length) return out;
      const c0 = data.readUInt16LE(o), c1 = data.readUInt16LE(o + 2);
      const bits = data.readUInt32LE(o + 4);
      const e0 = from565(c0), e1 = from565(c1);
      const g = (c) => (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;
      const pal = c0 > c1
        ? [g(e0), g(e1), (2 * g(e0) + g(e1)) / 3, (g(e0) + 2 * g(e1)) / 3]
        : [g(e0), g(e1), (g(e0) + g(e1)) / 2, 0];
      for (let k = 0; k < 16; k++) {
        const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2);
        if (x >= width || y >= height) continue;
        out[y * width + x] = Math.max(0, Math.min(255, Math.round(pal[(bits >>> (k * 2)) & 3])));
      }
      o += 8;
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

module.exports = { encodeDXT1, encodeDXT3, decodeDXT3, decodeDXT1, decodeDXT1Gray, halveRGB, to565, from565 };
