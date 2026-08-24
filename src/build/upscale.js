// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Lanczos-3 upscaling for the skybox images.
//
// A GoldSrc sky face is 256x256 and, spread across a 90-degree field of view, that is roughly 3
// pixels per degree - it reads as a blur. Upscaling cannot invent detail, but the filter decides
// whether what is there arrives crisp or smeared:
//
//   nearest   - blocky, keeps edges but shows the source grid
//   bilinear  - what the GPU already does; upscaling with it changes nothing
//   bicubic   - softer than Lanczos, slight overshoot
//   Lanczos-3 - sharpest of the separable filters, the standard choice for photographic content
//
// Separable (rows, then columns) so a 256 -> 1024 pass is ~4M taps per axis rather than the 3.5G a
// naive 2D kernel would need: tens of milliseconds, once, at convert time.
"use strict";

const A = 3;                                     // Lanczos window

function sinc(x) {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

function kernel(x) {
  const ax = Math.abs(x);
  if (ax >= A) return 0;
  return sinc(x) * sinc(x / A);
}

// Pre-compute, for each destination pixel, which source pixels contribute and how much.
function weightsFor(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const support = scale > 1 ? A * scale : A;      // widen the window when downscaling
  const rows = [];
  for (let d = 0; d < dstLen; d++) {
    const centre = (d + 0.5) * scale - 0.5;
    const from = Math.max(0, Math.ceil(centre - support));
    const to = Math.min(srcLen - 1, Math.floor(centre + support));
    const idx = [], wts = [];
    let sum = 0;
    for (let s = from; s <= to; s++) {
      const w = kernel(scale > 1 ? (s - centre) / scale : s - centre);
      if (w === 0) continue;
      idx.push(s); wts.push(w); sum += w;
    }
    // Normalise, so flat areas keep their exact value and nothing darkens at the edges.
    for (let i = 0; i < wts.length; i++) wts[i] /= sum || 1;
    rows.push({ idx, wts });
  }
  return rows;
}

// One channel through the same two passes. Used for a sprite's alpha, which must survive the
// resize to power-of-two or the whole sprite turns into an opaque square.
function resampleChannel(src, sw, sh, dstW, dstH, cols, rows) {
  const mid = new Float32Array(dstW * sh);
  for (let y = 0; y < sh; y++) {
    for (let d = 0; d < dstW; d++) {
      const { idx, wts } = cols[d];
      let v = 0;
      for (let k = 0; k < idx.length; k++) v += src[y * sw + idx[k]] * wts[k];
      mid[y * dstW + d] = v;
    }
  }
  const out = Buffer.alloc(dstW * dstH);
  for (let d = 0; d < dstH; d++) {
    const { idx, wts } = rows[d];
    for (let x = 0; x < dstW; x++) {
      let v = 0;
      for (let k = 0; k < idx.length; k++) v += mid[idx[k] * dstW + x] * wts[k];
      out[d * dstW + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return out;
}

// img: { width, height, rgb, alpha? }. Returns a new image of the requested size.
function resample(img, dstW, dstH) {
  const { width: sw, height: sh, rgb } = img;
  const cols = weightsFor(sw, dstW);
  const rows = weightsFor(sh, dstH);

  // horizontal pass into a float buffer, then vertical
  const mid = new Float32Array(dstW * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let d = 0; d < dstW; d++) {
      const { idx, wts } = cols[d];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < idx.length; k++) {
        const s = (y * sw + idx[k]) * 3, w = wts[k];
        r += rgb[s] * w; g += rgb[s + 1] * w; b += rgb[s + 2] * w;
      }
      const o = (y * dstW + d) * 3;
      mid[o] = r; mid[o + 1] = g; mid[o + 2] = b;
    }
  }

  const out = Buffer.alloc(dstW * dstH * 3);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let d = 0; d < dstH; d++) {
    const { idx, wts } = rows[d];
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < idx.length; k++) {
        const s = (idx[k] * dstW + x) * 3, w = wts[k];
        r += mid[s] * w; g += mid[s + 1] * w; b += mid[s + 2] * w;
      }
      const o = (d * dstW + x) * 3;
      out[o] = clamp(r); out[o + 1] = clamp(g); out[o + 2] = clamp(b);
    }
  }
  const res = { width: dstW, height: dstH, rgb: out };
  if (img.alpha) res.alpha = resampleChannel(img.alpha, sw, sh, dstW, dstH, cols, rows);
  return res;
}

// Upscale to `factor`x, capped so a sky face never exceeds `max` pixels a side.
function upscale(img, factor, max) {
  const f = Math.max(1, factor || 1);
  const w = Math.min(max || 2048, Math.round(img.width * f));
  const h = Math.min(max || 2048, Math.round(img.height * f));
  if (w === img.width && h === img.height) return img;
  return resample(img, w, h);
}

module.exports = { upscale, resample };
