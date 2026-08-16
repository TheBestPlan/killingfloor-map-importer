// Reading a UTexture out of a Lineage 2 package.
//
// Same object Killing Floor stores, one file version older: a tagged property block that carries
// Format/USize/VSize, then the mip array. Each mip is a TLazyArray of bytes - an absolute skip
// offset, the count, the data - followed by its own size and the log2 of it.
//
// The formats that matter here are the ones the client actually ships (see stats in RESEARCH):
// DXT1/3/5 for everything the eye sees, G16 for the terrain heightmap, P8 for a few old textures.
// DXT blocks are the same bytes Killing Floor wants, so those travel across without being decoded.
"use strict";

const { Rd } = require("../unreal/read");

// ETextureFormat, unchanged between UE2.0 and UE2.5.
const TEXF = {
  P8: 0, RGBA7: 1, RGB16: 2, DXT1: 3, RGB8: 4, RGBA8: 5, NODATA: 6,
  DXT3: 7, DXT5: 8, L8: 9, G16: 10, RRRGGGBBB: 11,
};
const FORMAT_NAME = Object.fromEntries(Object.entries(TEXF).map(([k, v]) => [v, k]));

const PROP_SIZE = { 0: 1, 1: 2, 2: 4, 3: 12, 4: 16 };

// The tagged properties, decoded far enough to answer what the pixels are. Values we do not know how
// to read are skipped by their declared size, which is what the size code is there for.
function readProps(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  const out = {};
  for (let g = 0; g < 200; g++) {
    const name = pkg.names[r.cidx()];
    if (name === undefined || name === "None") break;
    const info = r.u8(), type = info & 0x0f, sc = (info >> 4) & 7;
    if (type === 10) r.cidx();
    let size = PROP_SIZE[sc];
    if (sc === 5) size = r.u8(); else if (sc === 6) size = r.u16(); else if (sc === 7) size = r.u32();
    if ((info & 0x80) && type !== 3) r.u8();
    if (type === 3) { out[name] = !!((info >> 7) & 1); continue; }
    const at = r.pos;
    if (type === 1) out[name] = pkg.buf[at];                                  // byte / enum
    else if (type === 2) out[name] = pkg.buf.readInt32LE(at);
    else if (type === 4) out[name] = pkg.buf.readFloatLE(at);
    else if (type === 5) out[name] = new Rd(pkg.buf, at).cidx();              // object ref
    else if (type === 6) out[name] = pkg.names[new Rd(pkg.buf, at).cidx()];
    r.pos = at + size;
  }
  return { props: out, pos: r.pos };
}

// The mip array, from `at`. Returns null when the walk does not land exactly on the object's end,
// which is what tells the caller it started from the wrong byte.
function walkMips(pkg, exp, at) {
  const r = new Rd(pkg.buf, at);
  const end = exp.serialOffset + exp.serialSize;
  const mips = [];
  const n = r.cidx();
  if (n < 0 || n > 24) return null;
  for (let i = 0; i < n; i++) {
    if (r.pos + 8 > end) return null;
    r.i32();                                        // TLazyArray skip offset, absolute - not needed
    const len = r.cidx();
    if (len < 0 || r.pos + len + 10 > end) return null;
    const from = r.pos;
    r.skip(len);
    const w = r.i32(), h = r.i32();
    r.u8(); r.u8();                                 // UBits, VBits
    if (w <= 0 || h <= 0 || w > 8192 || h > 8192) return null;
    mips.push({ data: pkg.buf.subarray(from, from + len), width: w, height: h });
  }
  return r.pos === end ? mips : null;
}

function readTexture(pkg, exp) {
  const { props, pos } = readProps(pkg, exp);
  const end = exp.serialOffset + exp.serialSize;
  // Interlude puts one INT between the properties and the mips that Killing Floor's own version does
  // not have. Rather than key off the file version - the licensee number varies per file and means
  // nothing - try both and keep the walk that lands exactly on the end of the object.
  let mips = walkMips(pkg, exp, pos);
  let lead = 0;
  if (!mips) { mips = walkMips(pkg, exp, pos + 4); lead = 4; }
  if (!mips) { mips = []; lead = -1; }
  const r = { pos: mips.length ? end : pos };
  const format = props.Format === undefined ? TEXF.P8 : props.Format;
  return {
    name: exp.name,
    format, formatName: FORMAT_NAME[format] || ("?" + format),
    width: props.USize || (mips[0] && mips[0].width) || 0,
    height: props.VSize || (mips[0] && mips[0].height) || 0,
    paletteRef: props.Palette || 0,
    mips, lead,
    exact: lead >= 0,
  };
}

// The 16-bit heightfield a TerrainInfo points at. One texel per terrain vertex, so a 256x256 map is
// a 255x255 grid of quads.
function readHeightmap(pkg, exp) {
  const t = readTexture(pkg, exp);
  if (t.format !== TEXF.G16) throw new Error(t.name + ": terrain map is " + t.formatName + ", expected G16");
  const m = t.mips[0];
  if (!m || m.data.length < t.width * t.height * 2) {
    throw new Error(t.name + ": heightmap mip is " + (m ? m.data.length : 0) + " bytes for " + t.width + "x" + t.height);
  }
  const h = new Uint16Array(t.width * t.height);
  for (let i = 0; i < h.length; i++) h[i] = m.data.readUInt16LE(i * 2);
  return { width: t.width, height: t.height, heights: h };
}

// UPalette: a count and that many BGRA entries, after an empty property block.
function readPalette(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  r.cidx();                                         // property block: "None"
  const n = r.cidx();
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const rr = r.u8(), g = r.u8(), b = r.u8(); r.u8();
    out[i * 3] = rr; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return { count: n, rgb: out };
}

// What a material reference finally paints with.
//
// Half of what a Lineage 2 surface points at is not a texture but a node of the material graph: the
// sky is `ColorModifier`s over a panner over a texture, doors are `Shader`s with a Diffuse and an
// Opacity. Killing Floor understands those classes, but rebuilding the graph means carrying every
// node across; following it down to the one texture that does the painting gets the picture with
// nothing else to go wrong. The tint or the panning is what is lost.
const FOLLOW = {
  ColorModifier: ["Material"],
  TexPanner: ["Material"],
  TexRotator: ["Material"],
  TexOscillator: ["Material"],
  TexScaler: ["Material"],
  TexEnvMap: ["Material"],
  FinalBlend: ["Material"],
  Shader: ["Diffuse", "SelfIllumination", "Opacity"],
  Combiner: ["Material1", "Material2"],
  MaterialSequence: [],
};

// `open(name)` hands back another package by name; the walk can leave the file it started in.
function followMaterial(pkg, exp, open, depth) {
  if (!exp) return null;
  const cls = pkg.classOf(exp);
  if (cls === "Texture") return { pkg, exp };
  const next = FOLLOW[cls];
  if (!next || (depth || 0) > 6) return null;
  const { readTags, pick, val, refTarget } = require("./props");
  const { tags } = readTags(pkg, exp.serialOffset, exp.serialOffset + exp.serialSize);
  for (const name of next) {
    const t = pick(tags, name);
    if (!t) continue;
    const target = refTarget(pkg, val.ref(pkg, t));
    if (!target) continue;
    if (target.local) {
      const hit = followMaterial(pkg, target.local, open, (depth || 0) + 1);
      if (hit) return hit;
      continue;
    }
    const other = open && target.pkg ? open(target.pkg) : null;
    if (!other) continue;
    const oexp = other.exports.find((e) => e.name === target.name);
    const hit = followMaterial(other, oexp, open, (depth || 0) + 1);
    if (hit) return hit;
  }
  return null;
}

module.exports = { readTexture, readHeightmap, readPalette, readProps, followMaterial, TEXF, FORMAT_NAME };
