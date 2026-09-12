// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// WAD3 reader plus the shared miptex decoder. GoldSrc stores map textures either inside the BSP's
// TEXTURES lump or, more often, in external WAD3 files listed in worldspawn's "wad" key. The lump
// body is byte-identical in both cases, so one decoder serves both.
"use strict";

const fs = require("fs");
const path = require("path");

// miptex at `off` inside `buf`. Returns the 4 stored mip levels (palette indices) and the palette.
function readMiptex(buf, off) {
  const name = buf.toString("latin1", off, off + 16).replace(/\0[\s\S]*$/, "");
  const width = buf.readUInt32LE(off + 16), height = buf.readUInt32LE(off + 20);
  const offsets = [0, 1, 2, 3].map((i) => buf.readUInt32LE(off + 24 + i * 4));
  if (!offsets[0]) return { name, width, height, mips: null, palette: null };
  const mips = [];
  for (let i = 0; i < 4; i++) {
    const w = Math.max(1, width >> i), h = Math.max(1, height >> i);
    const at = off + offsets[i];
    mips.push({ width: w, height: h, data: buf.subarray(at, at + w * h) });
  }
  // palette sits right after the last mip: uint16 count (256) then count*3 RGB
  const palAt = off + offsets[0] + ((width * height * 85) >> 6);
  const count = buf.readUInt16LE(palAt);
  const palette = Buffer.alloc(256 * 3);
  buf.copy(palette, 0, palAt + 2, palAt + 2 + Math.min(count, 256) * 3);
  return { name, width, height, mips, palette };
}

class WadSet {
  constructor() { this.lumps = new Map(); this.files = []; this.missing = []; }

  addFile(file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { this.missing.push(path.basename(file)); return false; }
    if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "WAD3") { this.missing.push(path.basename(file) + " (not WAD3)"); return false; }
    const numlumps = buf.readUInt32LE(4), infotableofs = buf.readUInt32LE(8);
    let added = 0;
    for (let i = 0; i < numlumps; i++) {
      const o = infotableofs + i * 32;
      if (o + 32 > buf.length) break;
      const filepos = buf.readUInt32LE(o), type = buf[o + 12];
      const name = buf.toString("latin1", o + 16, o + 32).replace(/\0[\s\S]*$/, "").toLowerCase();
      if (type !== 0x43) continue;                    // 0x43 = miptex; fonts/qpics are not map textures
      if (!this.lumps.has(name)) { this.lumps.set(name, { buf, filepos }); added++; }
    }
    this.files.push({ file: path.basename(file), lumps: added });
    return true;
  }

  // Search a list of directories for each WAD named in worldspawn.
  addFromWorldspawn(wadNames, searchDirs) {
    for (const w of wadNames) {
      let found = false;
      for (const d of searchDirs) {
        const p = path.join(d, w);
        if (fs.existsSync(p) && this.addFile(p)) { found = true; break; }
      }
      if (!found) this.missing.push(w);
    }
    return this;
  }

  get(name) {
    const rec = this.lumps.get(String(name).toLowerCase());
    if (!rec) return null;
    return readMiptex(rec.buf, rec.filepos);
  }
}

// Expand palette indices to RGB8. `transparentIndex` (if given) is emitted as pure black.
function expandRGB(indices, palette, width, height) {
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const p = indices[i] * 3;
    out[i * 3] = palette[p]; out[i * 3 + 1] = palette[p + 1]; out[i * 3 + 2] = palette[p + 2];
  }
  return out;
}

// Point-sample an 8-bit indexed image to half size. GoldSrc's own mips are built the same way, so
// continuing the chain like this keeps the look consistent and never invents colours.
function halveIndexed(data, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = Buffer.alloc(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = data[Math.min(y * 2, h - 1) * w + Math.min(x * 2, w - 1)];
  return { data: out, width: nw, height: nh };
}

module.exports = { WadSet, readMiptex, expandRGB, halveIndexed };
