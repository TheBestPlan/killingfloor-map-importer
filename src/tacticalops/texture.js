// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Reading a UTexture out of an Unreal Engine 1 package, and turning one into a Killing Floor
// material.
//
// UT99 textures are palettised: 2863 of the 3017 in a Tactical Ops install are TEXF_P8 with a
// UPalette beside them, and the handful that carry a `CompMips` DXT1 cache carry the P8 master as
// well - so the palette path is the only one that has to work. The mip array is the same shape
// Killing Floor writes (a lazy-array skip offset, the bytes, then USize/VSize/UBits/VBits), which is
// what lets the walk be checked against the object's own end.
"use strict";

const { Rd } = require("../unreal/read");
const { addTexture, addRgbTexture, sanitizeName } = require("../unreal/texture");

const TEXF = { P8: 0, DXT1: 3, RGB8: 4, RGBA8: 5 };
const PROP_SIZE = { 0: 1, 1: 2, 2: 4, 3: 12, 4: 16 };

// The tagged properties, far enough to answer what the pixels are.
function readProps(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  const out = {};
  for (let g = 0; g < 200 && r.pos < end; g++) {
    const name = pkg.names[r.cidx()];
    if (name === undefined || name === "None") break;
    const info = r.u8(), type = info & 0x0f, sc = (info >> 4) & 7;
    if (type === 10) r.cidx();                            // struct: its name
    let size = PROP_SIZE[sc];
    if (sc === 5) size = r.u8(); else if (sc === 6) size = r.u16(); else if (sc === 7) size = r.u32();
    if ((info & 0x80) && type !== 3) r.u8();               // array index
    if (type === 3) { out[name] = !!((info >> 7) & 1); continue; }
    const at = r.pos;
    if (type === 1) out[name] = pkg.buf[at];
    else if (type === 2) out[name] = pkg.buf.readInt32LE(at);
    else if (type === 4) out[name] = pkg.buf.readFloatLE(at);
    else if (type === 5) out[name] = new Rd(pkg.buf, at).cidx();
    else if (type === 6) out[name] = pkg.names[new Rd(pkg.buf, at).cidx()];
    r.pos = at + size;
  }
  return { props: out, pos: r.pos };
}

// One TArray<FMipmap> from `at`, or null when the walk does not stay inside the object - which is
// how the caller learns it started from the wrong byte.
function walkMips(pkg, exp, at, lazy) {
  const r = new Rd(pkg.buf, at);
  const end = exp.serialOffset + exp.serialSize;
  const n = r.cidx();
  if (n < 0 || n > 24) return null;
  const mips = [];
  for (let i = 0; i < n; i++) {
    if (lazy) { if (r.pos + 4 > end) return null; r.i32(); }   // absolute skip offset, not needed
    const len = r.cidx();
    if (len < 0 || r.pos + len + 10 > end) return null;
    const from = r.pos;
    r.skip(len);
    const w = r.i32(), h = r.i32();
    r.u8(); r.u8();                                       // UBits, VBits
    if (w <= 0 || h <= 0 || w > 8192 || h > 8192) return null;
    mips.push({ data: pkg.buf.subarray(from, from + len), width: w, height: h });
  }
  return { mips, pos: r.pos };
}

// UPalette: an empty property block, a count, then that many RGBA entries.
function readPalette(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  r.cidx();
  const n = r.cidx();
  const rgb = Buffer.alloc(256 * 3);
  for (let i = 0; i < n && i < 256; i++) {
    rgb[i * 3] = r.u8(); rgb[i * 3 + 1] = r.u8(); rgb[i * 3 + 2] = r.u8(); r.u8();
  }
  return rgb;
}

function readTexture(pkg, exp) {
  const { props, pos } = readProps(pkg, exp);
  const end = exp.serialOffset + exp.serialSize;
  // Version 61 packages - three of Tactical Ops' texture files still are - write the mip bytes
  // without the lazy-array skip offset in front of them.
  let walk = walkMips(pkg, exp, pos, true) || walkMips(pkg, exp, pos, false);
  const mips = walk ? walk.mips : [];
  const format = props.Format === undefined ? TEXF.P8 : props.Format;
  const palRef = props.Palette || 0;
  const palExp = palRef > 0 ? pkg.exports[palRef - 1] : null;
  return {
    name: exp.name,
    format,
    width: props.USize || (mips[0] && mips[0].width) || 0,
    height: props.VSize || (mips[0] && mips[0].height) || 0,
    mips,
    palette: palExp && pkg.classOf(palExp) === "Palette" ? readPalette(pkg, palExp) : null,
    // The texture's own answer. UT99 ORs a texture's PolyFlags into the surface's before drawing,
    // so bMasked cuts the texture out whether or not the surface carries PF_Masked - which most of
    // them do not: 19 of TO-GlasgowKiss' 36 surfaces on `1tbmsk1` have the flag and 17 do not.
    masked: !!props.bMasked,
    // A WetTexture (UE1's water) generates its pixels at run time from the still image named here.
    sourceTexture: props.SourceTexture || 0,
    // A flipbook: AnimNext chains one frame to the next, and the last points back at the first.
    animNext: props.AnimNext || 0,
    // Anything after the mips is the optional DXT cache UT99 keeps beside the palettised master; it
    // is not read, so a texture that has one still ends its walk early.
    exact: !!walk && (walk.pos === end || !!props.bHasComp),
  };
}

// How bright a texel is, on the scale UE1 blends by. Rec. 601 luma, which is what the engine's own
// fixed-point translucency table is built from.
const luma = (r, g, b) => (r * 77 + g * 151 + b * 28) >> 8;

// The top mip as tight RGB, plus an alpha channel when the surface needs one.
//
//   "mask"  - Unreal masks on palette index 0, so index 0 becomes alpha 0.
//   "luma"  - UE1's translucency IS the texel's brightness: a black pane is invisible and a white
//             highlight is solid. Baking that into the alpha channel is what lets a Killing Floor
//             Shader reproduce it (see convert.js), and it is the difference between a museum case
//             you can see the exhibit through and a slab of black.
function topAsRgba(tex, alphaMode) {
  const m = tex.mips[0];
  if (!m || !tex.width || !tex.height) return null;
  const masked = alphaMode === true || alphaMode === "mask";
  const byLuma = alphaMode === "luma";
  const n = tex.width * tex.height;
  if (tex.format === TEXF.P8) {
    if (!tex.palette || m.data.length < n) return null;
    const rgb = Buffer.alloc(n * 3);
    const alpha = masked || byLuma ? Buffer.alloc(n, 255) : null;
    for (let i = 0; i < n; i++) {
      const c = m.data[i];
      const r = tex.palette[c * 3], g = tex.palette[c * 3 + 1], b = tex.palette[c * 3 + 2];
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      if (masked && c === 0) alpha[i] = 0;
      else if (byLuma) alpha[i] = luma(r, g, b);
    }
    return { rgb, alpha };
  }
  const { topAsRgb } = require("../unreal/texture");
  const rgb = topAsRgb(tex);
  if (!rgb) return null;
  if (!byLuma) return { rgb, alpha: null };
  const alpha = Buffer.alloc(tex.width * tex.height, 255);
  for (let i = 0; i < alpha.length; i++) alpha[i] = luma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  return { rgb, alpha };
}

// A UE1 texture written into the Killing Floor package.
//
// A CUT-OUT goes through the GoldSrc writer rather than being decoded here: that writer builds the
// mip chain from the indexed pixels, bleeds colour into the transparent texels so a fence has no
// fringe, and encodes DXT3 - all of which a cut-out needs and none of which is worth writing twice.
// It masks on palette index 255, the way Half-Life does, so a UE1 cut-out (which masks on 0) is
// handed over with the two swapped and comes out the other side exactly as it went in.
//
// Everything else is decoded and written as DXT1: an opaque wall has no use for the alpha channel,
// it is half the bytes, and a projector landing on a DXT3 surface repaints the whole thing white
// (GOTCHAS 5.16).
function addUE1Texture(pkg, refs, tex, opts) {
  const masked = !!(opts && opts.masked);
  const byLuma = !!(opts && opts.lumaAlpha);
  const name = (opts && opts.name) || tex.name;
  const gain = (opts && opts.gain) || 1;
  // Under 4 in either dimension the indexed writer's DXT3 output is a texture D3D will not create,
  // so those go out through the RGB path, which drops to RGBA8 for exactly this case.
  const tiny = tex.width < 4 || tex.height < 4;
  if (masked && !tiny && gain === 1 && tex.format === TEXF.P8 && tex.palette && tex.mips.length) {
    const palette = Buffer.from(tex.palette);
    for (let c = 0; c < 3; c++) {
      const t = palette[c]; palette[c] = palette[255 * 3 + c]; palette[255 * 3 + c] = t;
    }
    const mips = tex.mips.map((m) => {
      const d = Buffer.from(m.data);
      for (let i = 0; i < d.length; i++) { if (d[i] === 0) d[i] = 255; else if (d[i] === 255) d[i] = 0; }
      return { width: m.width, height: m.height, data: d };
    });
    return addTexture(pkg, refs, {
      name: sanitizeName(name), width: tex.width, height: tex.height, mips, palette,
    }, { masked, dxt: true });
  }
  const img = topAsRgba(tex, byLuma ? "luma" : masked ? "mask" : null);
  if (!img) return null;
  const rec = addRgbTexture(pkg, refs, name, {
    width: tex.width, height: tex.height, rgb: img.rgb, alpha: img.alpha,
  }, gain, { wrap: true, dxt3: true });
  return Object.assign({ origWidth: tex.width, origHeight: tex.height, masked }, rec);
}

module.exports = { readTexture, readPalette, readProps, topAsRgba, addUE1Texture, TEXF };
