// Which of the terrain's layers paints which quad.
//
// A Lineage 2 square blends up to ten layers, each with a texture and an `AlphaMap` - a real texture
// (DXT1 1024x1024 for the big ones, P8 512x512 for some) whose grey level is that layer's weight.
// The blend is per texel; a static mesh has one material per section, so the ground takes the layer
// that wins each quad instead. Hard edges where the original fades, and every layer's own tiling
// kept - against baking one texture for the whole square, which would give 4x4 texels per quad.
"use strict";

const { readTexture, readPalette, TEXF } = require("./texture");
const { decodeDXT1Gray, decodeDXT3 } = require("../unreal/dxt");

// A layer's alpha map as a grey plane, whatever it is stored as.
function readAlpha(client, pkg, target) {
  if (!target || !target.pkg) return null;
  const src = client.get(target.pkg);
  if (!src) return null;
  const exp = src.exports.find((e) => e.name === target.name && src.classOf(e) === "Texture");
  if (!exp) return null;
  let t;
  try { t = readTexture(src, exp); } catch (e) { return null; }
  const m = t.mips[0];
  if (!t.exact || !m) return null;
  const { width, height } = t;
  if (t.format === TEXF.DXT1) return { width, height, data: decodeDXT1Gray(m.data, width, height) };
  if (t.format === TEXF.DXT3 || t.format === TEXF.DXT5) {
    const rgba = decodeDXT3(m.data, width, height);
    const out = Buffer.alloc(width * height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
    return { width, height, data: out };
  }
  if (t.format === TEXF.L8) return { width, height, data: Buffer.from(m.data.subarray(0, width * height)) };
  if (t.format === TEXF.P8) {
    // The palette turns the index into a grey; L2's alpha palettes are a black-to-white ramp, so the
    // red channel of the entry is the weight.
    const palExp = t.paletteRef ? src.exports[t.paletteRef - 1] : null;
    if (!palExp) return null;
    const pal = readPalette(src, palExp);
    const out = Buffer.alloc(width * height);
    for (let i = 0; i < out.length; i++) out[i] = pal.rgb[m.data[i] * 3] || 0;
    return { width, height, data: out };
  }
  if (t.format === TEXF.RGBA8) {
    const out = Buffer.alloc(width * height);
    for (let i = 0; i < out.length; i++) out[i] = m.data[i * 4 + 2];   // stored BGRA
    return { width, height, data: out };
  }
  return null;
}

// quads x quads of layer indices. Layer 0 is the base and wins where nothing else is painted.
function layerMap(client, pkg, terrain) {
  const quads = terrain.width - 1;
  const alphas = terrain.layers.map((l) => (l.index === 0 ? null : readAlpha(client, pkg, l.alphaMap)));
  const usable = terrain.layers.map((l, i) => !!(l.texture && l.texture.pkg) && (i === 0 || !!alphas[i]));
  const map = new Uint8Array(quads * quads);
  const used = new Set([0]);
  let painted = 0;
  for (let y = 0; y < quads; y++) {
    for (let x = 0; x < quads; x++) {
      let best = 0, bestW = 8;                     // a layer has to beat the base by a real margin
      for (let i = 1; i < terrain.layers.length; i++) {
        if (!usable[i] || !alphas[i]) continue;
        const a = alphas[i];
        // The alpha map covers the square, so a quad is one texel of it scaled by its own size.
        const ax = Math.min(a.width - 1, Math.floor((x / quads) * a.width));
        const ay = Math.min(a.height - 1, Math.floor((y / quads) * a.height));
        const w = a.data[ay * a.width + ax];
        if (w > bestW) { bestW = w; best = i; }
      }
      map[y * quads + x] = best;
      if (best) { painted++; used.add(best); }
    }
  }
  return {
    quads, map, used: [...used].sort((a, b) => a - b), painted,
    layers: terrain.layers.map((l, i) => ({ ...l, usable: usable[i], alpha: !!alphas[i] })),
    at(x, y) { return this.map[Math.min(this.quads - 1, y) * this.quads + Math.min(this.quads - 1, x)]; },
    // How strongly layer `i` paints the terrain VERTEX (x, y), 0..255. The alpha map covers the whole
    // square, so a vertex is one texel of it scaled by its own size - the same lookup `at` does per
    // quad, asked per corner instead, which is what a blend needs.
    weightAt(i, x, y) {
      const a = alphas[i];
      if (!a) return 0;
      const ax = Math.min(a.width - 1, Math.round((x / quads) * a.width));
      const ay = Math.min(a.height - 1, Math.round((y / quads) * a.height));
      return a.data[ay * a.width + ax];
    },
  };
}

module.exports = { layerMap, readAlpha };
