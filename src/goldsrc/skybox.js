// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GoldSrc skyboxes are not in the .bsp: worldspawn's `skyname` names six images under
// gfx/env/<name>{up,dn,lf,rt,ft,bk}.tga, and the brushes that show them are textured with a 16x16
// placeholder called `sky`. Converting that placeholder is what turns the sky into a white wall.
"use strict";

const fs = require("fs");
const path = require("path");

const SIDES = ["up", "dn", "lf", "rt", "ft", "bk"];

// Uncompressed or RLE 24/32-bit TGA, which is all the shipped skyboxes use.
function readTga(file) {
  const b = fs.readFileSync(file);
  const idLen = b[0], type = b[2];
  const width = b.readUInt16LE(12), height = b.readUInt16LE(14), bpp = b[16], desc = b[17];
  if (type !== 2 && type !== 10) return null;
  if (bpp !== 24 && bpp !== 32) return null;
  const bytes = bpp / 8;
  const px = Buffer.alloc(width * height * bytes);
  let src = 18 + idLen, dst = 0;
  if (type === 2) {
    b.copy(px, 0, src, src + px.length);
  } else {
    while (dst < px.length) {
      const packet = b[src++];
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        for (let i = 0; i < count; i++) { b.copy(px, dst, src, src + bytes); dst += bytes; }
        src += bytes;
      } else {
        b.copy(px, dst, src, src + count * bytes); dst += count * bytes; src += count * bytes;
      }
    }
  }
  // TGA stores BGR, and bottom-up unless bit 5 of the descriptor says otherwise.
  const flip = (desc & 0x20) === 0;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const sy = flip ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const s = (sy * width + x) * bytes, d = (y * width + x) * 3;
      rgb[d] = px[s + 2]; rgb[d + 1] = px[s + 1]; rgb[d + 2] = px[s];
    }
  }
  return { width, height, rgb };
}

// A missing WALL, built as a mirrored copy of a wall that exists. Row-by-row averaging was tried
// instead - it keeps the horizon at exactly its neighbours' height - and it looked worse: a flat
// band next to painted clouds draws more attention than a seam between two pictures.
function mirrorX(img) {
  const rgb = Buffer.alloc(img.rgb.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + (img.width - 1 - x)) * 3, d = (y * img.width + x) * 3;
      rgb[d] = img.rgb[s]; rgb[d + 1] = img.rgb[s + 1]; rgb[d + 2] = img.rgb[s + 2];
    }
  }
  return { width: img.width, height: img.height, rgb };
}

// One flat colour, for a missing lid or floor: the average of the row of the walls that meets it.
function flatFrom(img, edge) {
  const sum = [0, 0, 0];
  const rows = Math.max(1, Math.round(img.height / 8));
  for (let r = 0; r < rows; r++) {
    const y = edge === "top" ? r : img.height - 1 - r;
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 3;
      sum[0] += img.rgb[s]; sum[1] += img.rgb[s + 1]; sum[2] += img.rgb[s + 2];
    }
  }
  const n = rows * img.width;
  const c = sum.map((v) => Math.round(v / n));
  const side = 64;
  const rgb = Buffer.alloc(side * side * 3);
  for (let i = 0; i < side * side; i++) { rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; }
  return { width: side, height: side, rgb };
}

// Find <dir>/gfx/env/<skyname><side>.tga for each side, searching the map's game folders.
//
// Incomplete sets ship in the wild: gg_33_mario asks for `toon`, and neither the map's own folder
// nor a full Counter-Strike install has `toonrt.tga` - five files, never six. Refusing anything but
// a complete set cost that map its entire sky, so stand the absent sides in instead: a wall gets
// a mirrored copy of a wall that does exist, a lid or floor the flat colour of the row that
// meets it. `missing` is non-enumerable so the six-side maps stay six-side maps for every consumer.
function loadSkybox(skyname, roots) {
  if (!skyname) return null;
  const out = {};
  const missing = [];
  for (const side of SIDES) {
    let found = null;
    for (const root of roots) {
      for (const ext of [".tga", ".TGA"]) {
        const p = path.join(root, "gfx", "env", skyname + side + ext);
        if (fs.existsSync(p)) { found = p; break; }
      }
      if (found) break;
    }
    const img = found && readTga(found);
    if (img) out[side] = img; else missing.push(side);
  }
  if (missing.length === SIDES.length) return null;
  const walls = ["lf", "rt", "ft", "bk"];
  const anyWall = walls.find((s) => out[s]);
  for (const side of missing) {
    if (side === "up") out.up = flatFrom(out[anyWall] || out.dn, "top");
    else if (side === "dn") out.dn = flatFrom(out[anyWall] || out.up, "bottom");
    else out[side] = mirrorX(out[anyWall] || out.up || out.dn);
  }
  Object.defineProperty(out, "missing", { value: missing, enumerable: false });
  return out;
}

module.exports = { loadSkybox, readTga, SIDES };
