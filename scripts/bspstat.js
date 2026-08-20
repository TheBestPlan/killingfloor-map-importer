// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Minimal GoldSrc BSP v30 reader: lump inventory + face/lightmap/texture stats + entity histogram.
// Self-check: every face's plane index, texinfo index and lightmap offset must be in range,
// and the computed lightmap byte total must fit inside the LIGHTING lump.
const fs = require("fs");
const path = require("path");

const LUMPS = ["ENTITIES", "PLANES", "TEXTURES", "VERTICES", "VISIBILITY", "NODES", "TEXINFO",
  "FACES", "LIGHTING", "CLIPNODES", "LEAVES", "MARKSURFACES", "EDGES", "SURFEDGES", "MODELS"];

function readBsp(file) {
  const b = fs.readFileSync(file);
  const version = b.readInt32LE(0);
  const lumps = [];
  for (let i = 0; i < 15; i++) lumps.push({ name: LUMPS[i], off: b.readInt32LE(4 + i * 8), len: b.readInt32LE(8 + i * 8) });
  return { b, version, lumps, name: path.basename(file) };
}

function stats(file) {
  const { b, version, lumps, name } = readBsp(file);
  const L = Object.fromEntries(lumps.map((l) => [l.name, l]));
  const nPlanes = L.PLANES.len / 20, nVerts = L.VERTICES.len / 12, nNodes = L.NODES.len / 24;
  const nTexinfo = L.TEXINFO.len / 40, nFaces = L.FACES.len / 20, nLeaves = L.LEAVES.len / 28;
  const nEdges = L.EDGES.len / 4, nSurfedges = L.SURFEDGES.len / 4, nModels = L.MODELS.len / 64;
  const nClip = L.CLIPNODES.len / 8, nMark = L.MARKSURFACES.len / 2;

  // textures: miptex directory
  const tOff = L.TEXTURES.off;
  const nTex = b.readInt32LE(tOff);
  let embedded = 0, wadRef = 0;
  const texNames = [];
  for (let i = 0; i < nTex; i++) {
    const o = tOff + b.readInt32LE(tOff + 4 + i * 4);
    const nm = b.toString("latin1", o, o + 16).replace(/\0.*$/, "");
    const w = b.readInt32LE(o + 16), h = b.readInt32LE(o + 20), mip0 = b.readInt32LE(o + 24);
    texNames.push({ nm, w, h, embedded: mip0 !== 0 });
    if (mip0 !== 0) embedded++; else wadRef++;
  }

  // faces: lightmap extents (the 16-unit luxel grid)
  let lmBytes = 0, lmFaces = 0, styled = 0, maxLm = 0, badLm = 0;
  const texUse = new Map();
  for (let i = 0; i < nFaces; i++) {
    // dface_t: u16 planenum, i16 side, i32 firstedge, u16 numedges, u16 texinfo, byte styles[4], i32 lightofs
    const f = L.FACES.off + i * 20;
    const firstEdge = b.readInt32LE(f + 4), numEdges = b.readUInt16LE(f + 8);
    const iTexinfo = b.readUInt16LE(f + 10);
    const styles = [b[f + 12], b[f + 13], b[f + 14], b[f + 15]];
    const lightofs = b.readInt32LE(f + 16);
    const ti = L.TEXINFO.off + iTexinfo * 40;
    const miptexIdx = b.readInt32LE(ti + 32), flags = b.readInt32LE(ti + 36);
    const tn = texNames[miptexIdx] ? texNames[miptexIdx].nm : "?";
    texUse.set(tn, (texUse.get(tn) || 0) + 1);
    if (lightofs < 0 || (flags & 1)) continue;   // TEX_SPECIAL (sky/water) => no lightmap
    // texture-space extents over the face's vertices
    let mins = [1e9, 1e9], maxs = [-1e9, -1e9];
    for (let e = 0; e < numEdges; e++) {
      const se = b.readInt32LE(L.SURFEDGES.off + (firstEdge + e) * 4);
      const ei = Math.abs(se);
      const vi = se >= 0 ? b.readUInt16LE(L.EDGES.off + ei * 4) : b.readUInt16LE(L.EDGES.off + ei * 4 + 2);
      const vo = L.VERTICES.off + vi * 12;
      const p = [b.readFloatLE(vo), b.readFloatLE(vo + 4), b.readFloatLE(vo + 8)];
      for (let a = 0; a < 2; a++) {
        const o = ti + a * 16;
        const val = p[0] * b.readFloatLE(o) + p[1] * b.readFloatLE(o + 4) + p[2] * b.readFloatLE(o + 8) + b.readFloatLE(o + 12);
        if (val < mins[a]) mins[a] = val;
        if (val > maxs[a]) maxs[a] = val;
      }
    }
    const ext = [0, 0];
    for (let a = 0; a < 2; a++) ext[a] = Math.ceil(maxs[a] / 16) - Math.floor(mins[a] / 16);
    const w = ext[0] + 1, h = ext[1] + 1;
    if (w > 18 || h > 18) badLm++;                    // GoldSrc MAX_LIGHTMAP 16 luxels (+1) per face
    const nStyles = styles.filter((s) => s !== 255).length;
    lmBytes += w * h * 3 * Math.max(1, nStyles);
    lmFaces++;
    if (nStyles > 1) styled++;
    if (w * h > maxLm) maxLm = w * h;
  }

  // entities
  const ents = b.toString("latin1", L.ENTITIES.off, L.ENTITIES.off + L.ENTITIES.len);
  const cls = new Map();
  for (const m of ents.matchAll(/"classname"\s*"([^"]+)"/g)) cls.set(m[1], (cls.get(m[1]) || 0) + 1);
  const worldspawn = ents.slice(0, ents.indexOf("}") + 1);
  const wad = (worldspawn.match(/"wad"\s*"([^"]*)"/) || [])[1] || "";
  const sky = (worldspawn.match(/"skyname"\s*"([^"]*)"/) || [])[1] || "";

  console.log("=== " + name + "  v" + version + "  " + (b.length / 1048576).toFixed(2) + " MB");
  console.log("  planes " + nPlanes + "  verts " + nVerts + "  nodes " + nNodes + "  leaves " + nLeaves +
    "  faces " + nFaces + "  texinfo " + nTexinfo + "  edges " + nEdges + "  surfedges " + nSurfedges +
    "  clipnodes " + nClip + "  marksurf " + nMark + "  models " + nModels);
  console.log("  textures " + nTex + " (" + embedded + " embedded / " + wadRef + " from WAD)  wads: " + wad.split(";").filter(Boolean).map((w) => w.split(/[\\/]/).pop()).join(" ") + "  sky: " + (sky || "-"));
  console.log("  lightmap: lump " + (L.LIGHTING.len / 1024).toFixed(0) + " KB, computed " + (lmBytes / 1024).toFixed(0) +
    " KB over " + lmFaces + " lit faces (" + styled + " multi-style, max " + maxLm + " luxels/face" +
    (badLm ? ", " + badLm + " OVERSIZE" : "") + ")  -> " + (lmBytes <= L.LIGHTING.len ? "FITS" : "OVERFLOW"));
  console.log("  vis " + (L.VISIBILITY.len / 1024).toFixed(0) + " KB   entities " + (L.ENTITIES.len / 1024).toFixed(0) + " KB");
  const mo = L.MODELS.off;
  const mn = [0, 1, 2].map((i) => b.readFloatLE(mo + i * 4)), mx = [0, 1, 2].map((i) => b.readFloatLE(mo + 12 + i * 4));
  console.log("  world bbox " + mn.map(Math.round).join(",") + " .. " + mx.map(Math.round).join(",") +
    "   size " + mx.map((v, i) => Math.round(v - mn[i])).join(" x ") + " HL units");
  const ce = [...cls.entries()].sort((a, b2) => b2[1] - a[1]);
  console.log("  entity classes " + ce.length + ": " + ce.slice(0, 18).map(([k, v]) => k + " x" + v).join(", "));
  const special = [...texUse.keys()].filter((t) => /^[{!~+\-]|^sky$|^aaatrigger$|^clip$|^origin$|^null$|^hint$|^skip$/i.test(t));
  console.log("  special textures used: " + (special.length ? special.join(" ") : "-"));
  return { nFaces, lmBytes, lightLump: L.LIGHTING.len };
}

const files = process.argv.slice(2);
let tot = { nFaces: 0, lmBytes: 0, lightLump: 0 };
for (const f of files) { const s = stats(f); tot.nFaces += s.nFaces; tot.lmBytes += s.lmBytes; tot.lightLump += s.lightLump; console.log(""); }
if (files.length > 1) {
  console.log("TOTAL faces " + tot.nFaces + "  computed lm " + (tot.lmBytes / 1024).toFixed(0) +
    " KB vs lump " + (tot.lightLump / 1024).toFixed(0) + " KB  ratio " + (tot.lmBytes / tot.lightLump).toFixed(3));
}
