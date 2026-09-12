// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GTA III / Vice City IMG archive (RenderWare VER1: a separate `<name>.dir` index + `<name>.img` blob).
// The .dir is a flat table of 32-byte entries { u32 offsetSectors, u32 sizeSectors, char[24] name };
// each file's bytes live at offsetSectors*2048 in the .img for sizeSectors*2048 bytes (zero-padded to
// the sector). Names are looked up case-insensitively without their extension so an .ide's "ind_land101"
// finds "ind_land101.dff". (VER2 - San Andreas - embeds the dir in the img with a "VER2" magic; GTA III
// and Vice City are VER1, which is all this handles.)
"use strict";

const fs = require("fs");
const path = require("path");

const SECTOR = 2048;

class Img {
  constructor(imgFile) {
    this.imgFile = imgFile;
    const dirFile = imgFile.replace(/\.img$/i, ".dir");
    const dir = fs.readFileSync(dirFile);
    this.buf = fs.readFileSync(imgFile);
    this.entries = new Map();          // full lowercased name (with ext) -> { offset, size, name }
    this.byBase = new Map();            // base name -> { dff?, txd?, any } - a .dff and a .txd share a base
    for (let p = 0; p + 32 <= dir.length; p += 32) {
      const offset = dir.readUInt32LE(p) * SECTOR;
      const size = dir.readUInt32LE(p + 4) * SECTOR;
      let e = p + 8; while (e < p + 32 && dir[e] !== 0) e++;
      const name = dir.toString("latin1", p + 8, e);
      if (!name) continue;
      const full = name.toLowerCase();
      this.entries.set(full, { offset, size, name });
      // A model and its texture dictionary share a base name (roadsign.dff + roadsign.txd). Keying only by
      // the base let the second overwrite the first, so half the signs/buildings read their TXD as a model
      // and failed to parse. Keep both, resolved by the extension the caller asks for.
      const base = full.replace(/\.[^.]+$/, ""), ext = (full.match(/\.([^.]+)$/) || [])[1];
      let rec = this.byBase.get(base); if (!rec) { rec = {}; this.byBase.set(base, rec); }
      if (ext) rec[ext] = { offset, size };
      if (!rec.any) rec.any = { offset, size };
    }
  }

  has(name) { return this.byBase.has(String(name).toLowerCase().replace(/\.[^.]+$/, "")); }
  // read(name, ext): ext is the caller's intent - "dff" for a model, "txd" for a texture dictionary. With a
  // base name that has both, this picks the right one instead of whichever loaded last. Defaults to the .dff.
  read(name, ext) {
    const rec = this.byBase.get(String(name).toLowerCase().replace(/\.[^.]+$/, ""));
    if (!rec) return null;
    const pick = (ext && rec[ext]) || rec.dff || rec.txd || rec.any;
    if (!pick) return null;
    return this.buf.subarray(pick.offset, pick.offset + pick.size);
  }
}

module.exports = { Img };
