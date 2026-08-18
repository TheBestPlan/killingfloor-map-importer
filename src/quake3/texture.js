// Quake 3 surfaces -> Killing Floor textures.
//
// A BSP surface names a SHADER; shader.js says which image file that is and how it blends. What is
// left for this module is the pixels: decode the .tga/.jpg, make it a power of two, and hand it to
// the package writer as a DXT texture that TILES (a world surface's UVs run well past 0..1).
"use strict";

const { decode } = require("./image");
const { resample } = require("../build/upscale");
const { addRgbTexture } = require("../unreal/texture");
const { CONTENTS } = require("./bsp");

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// A visible stand-in for a shader whose image is nowhere in the client: magenta chequer, the same
// thing the GoldSrc route uses for a missing WAD.
function placeholder() {
  const side = 64;
  const rgb = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const on = ((x >> 3) + (y >> 3)) & 1;
      const o = (y * side + x) * 3;
      rgb[o] = on ? 255 : 40; rgb[o + 1] = 0 + (on ? 0 : 40); rgb[o + 2] = on ? 255 : 40;
    }
  }
  return { width: side, height: side, rgb, alpha: null };
}

// Alpha that is only ever 0 or 255 is a cut-out; anything in between is real translucency. A .tga
// whose alpha channel is solid 255 has none at all and would cost four times the bytes for nothing.
function alphaKind(alpha) {
  if (!alpha) return "none";
  let min = 255, max = 0, mid = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a < min) min = a;
    if (a > max) max = a;
    if (a > 8 && a < 247) mid++;
  }
  if (min >= 247) return "none";
  return mid > alpha.length / 64 ? "graded" : "cutout";
}

// Builds one record per BSP texture index:
//   { ref, kind, twoSided, liquid, name, width, height }   or null for something that never draws.
function loadTextures(pkg, refs, bsp, opts) {
  const { gamefs, shaders, log } = opts;
  const maxSize = opts.maxSize || 512;
  const byFile = new Map();                   // resolved image path + flags -> { texRef, ... }
  const out = new Map();
  const stats = { used: 0, images: 0, missing: 0, tool: 0, sky: 0, resampled: 0, cutout: 0, graded: 0 };
  const missingNames = [];

  const used = new Set();
  for (const f of bsp.faces) used.add(f.texture);

  for (const idx of used) {
    const t = bsp.textures[idx];
    if (!t) continue;
    if (t.tool) { stats.tool++; out.set(idx, null); continue; }
    stats.used++;
    const r = shaders.resolve(t.name, gamefs);
    // Fog volumes and sky are not surfaces this converter draws: the sky is a cube of its own and a
    // fog brush has no picture at all.
    if (r.kind === "sky") { stats.sky++; out.set(idx, { ref: 0, kind: "sky", name: t.name }); continue; }
    if (r.shader && r.shader.params.has("fog")) { out.set(idx, null); continue; }

    const liquid = !!(t.contents & (CONTENTS.WATER | CONTENTS.LAVA | CONTENTS.SLIME));
    let img = null;
    if (r.file) {
      try { img = decode(r.file, gamefs.read(r.file)); }
      catch (e) { if (log) log("texture unreadable: " + r.file + " (" + e.message + ")"); }
    }
    if (!img) { stats.missing++; if (missingNames.length < 12) missingNames.push(t.name); img = placeholder(); }

    let kind = r.kind === "masked" ? "masked" : r.kind === "additive" ? "additive"
      : r.kind === "translucent" ? "translucent" : "normal";
    const ak = alphaKind(img.alpha);
    // The shader is the authority on WHETHER a surface has holes; the image is the authority on
    // whether it has the alpha to make them. A jpg has none, so a shader that alpha-tests one is
    // simply opaque.
    if (kind === "masked" && ak === "none") kind = "normal";
    if (kind === "normal" && ak === "cutout") kind = "masked";
    if (ak === "none") img = { width: img.width, height: img.height, rgb: img.rgb, alpha: null };
    if (kind === "masked") stats.cutout++;
    if (ak === "graded" && kind === "normal") stats.graded++;

    const key = (r.file || "?" + t.name) + "|" + kind;
    let rec = byFile.get(key);
    if (!rec) {
      let w = Math.min(maxSize, nextPow2(img.width)), h = Math.min(maxSize, nextPow2(img.height));
      if (w !== img.width || h !== img.height) { img = resample(img, w, h); stats.resampled++; }
      // Block-compressed by default. `raw` is the diagnostic: it tells a fault in the pixels apart
      // from a fault in the compression, at four times the bytes.
      const tex = addRgbTexture(pkg, refs, "q3_" + t.name.replace(/^textures\//, "").replace(/[^A-Za-z0-9_]/g, "_"),
        img, 1, { wrap: true, dxt3: !opts.rawTextures, raw: !!opts.rawTextures });
      rec = { texRef: tex.texRef, width: w, height: h };
      byFile.set(key, rec);
      stats.images++;
    }
    out.set(idx, {
      ref: rec.texRef, texRef: rec.texRef, kind, liquid, name: t.name,
      width: rec.width, height: rec.height,
      twoSided: r.twoSided || liquid || kind === "masked",
    });
  }

  if (log) {
    log("textures: " + stats.images + " image(s) for " + stats.used + " surface shader(s) (" +
      stats.tool + " tool, " + stats.sky + " sky, " + stats.cutout + " cut-out, " +
      stats.resampled + " resampled to power-of-two" +
      (stats.missing ? ", " + stats.missing + " MISSING -> placeholder: " + missingNames.join(" ") : "") + ")");
  }
  return { textures: out, stats };
}

module.exports = { loadTextures };
