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

// Find <dir>/gfx/env/<skyname><side>.tga for each side, searching the map's game folders.
function loadSkybox(skyname, roots) {
  if (!skyname) return null;
  const out = {};
  for (const side of SIDES) {
    let found = null;
    for (const root of roots) {
      for (const ext of [".tga", ".TGA"]) {
        const p = path.join(root, "gfx", "env", skyname + side + ext);
        if (fs.existsSync(p)) { found = p; break; }
      }
      if (found) break;
    }
    if (!found) return null;                    // all six or nothing
    const img = readTga(found);
    if (!img) return null;
    out[side] = img;
  }
  return out;
}

module.exports = { loadSkybox, readTga, SIDES };
