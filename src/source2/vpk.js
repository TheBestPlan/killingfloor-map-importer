// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Source 2 VPK v2 archive reader (CS2 / Dota 2 / HL:Alyx maps).
//
// A Source 2 map ships as one `<name>.vpk` (magic 0x55AA1234, version 2): a directory tree of
// (extension, path, filename) -> entry, followed by an embedded data section. A big pack may spill
// data into side files `<name>_000.vpk`, `<name>_001.vpk`, ... indexed by the entry's archiveIndex;
// a single-file map keeps everything at archiveIndex 0x7FFF in the section right after the tree. This
// reads the tree, then hands back each file's bytes (preload prefix + data body) on demand.
"use strict";

const fs = require("fs");
const path = require("path");

const EMBEDDED = 0x7fff;

class Vpk {
  constructor(file) {
    this.file = file;
    this.buf = fs.readFileSync(file);
    const b = this.buf;
    if (b.readUInt32LE(0) !== 0x55aa1234) throw new Error(path.basename(file) + ": not a Source 2 VPK (magic 0x" + b.readUInt32LE(0).toString(16) + ")");
    this.version = b.readUInt32LE(4);
    if (this.version !== 2) throw new Error(path.basename(file) + ": VPK version " + this.version + " unsupported (need 2)");
    const treeSize = b.readUInt32LE(8);
    // v2 header also carries fileDataSize, archiveMD5Size, otherMD5Size, signatureSize - not needed here.
    let p = 28;
    const treeStart = p;
    this.dataBase = treeStart + treeSize;
    this.entries = new Map();       // lowercased "path" -> entry
    this.byExt = new Map();         // ext -> [entry]
    const cstr = () => { let e = p; while (b[e] !== 0) e++; const s = b.toString("latin1", p, e); p = e + 1; return s; };
    while (true) {
      const ext = cstr(); if (ext === "") break;
      while (true) {
        const dir = cstr(); if (dir === "") break;
        while (true) {
          const name = cstr(); if (name === "") break;
          const crc = b.readUInt32LE(p); p += 4;
          const preload = b.readUInt16LE(p); p += 2;
          const archiveIndex = b.readUInt16LE(p); p += 2;
          const entryOffset = b.readUInt32LE(p); p += 4;
          const entryLength = b.readUInt32LE(p); p += 4;
          p += 2;                   // terminator 0xFFFF
          const preloadOffset = p; p += preload;
          const full = (dir === " " ? "" : dir + "/") + name + "." + ext;
          const entry = { path: full, ext, crc, preload, preloadOffset, archiveIndex, entryOffset, entryLength };
          this.entries.set(full.toLowerCase(), entry);
          if (!this.byExt.has(ext)) this.byExt.set(ext, []);
          this.byExt.get(ext).push(entry);
        }
      }
    }
  }

  list(ext) { return this.byExt.get(ext) || []; }
  get(p) { return this.entries.get(String(p).toLowerCase()) || null; }

  // The file's bytes: preload prefix (stored inline in the tree) then the data body, from the
  // embedded section or a side archive `<name>_NNN.vpk`.
  read(entry) {
    const parts = [];
    if (entry.preload) parts.push(this.buf.subarray(entry.preloadOffset, entry.preloadOffset + entry.preload));
    if (entry.entryLength) {
      if (entry.archiveIndex === EMBEDDED) {
        const off = this.dataBase + entry.entryOffset;
        parts.push(this.buf.subarray(off, off + entry.entryLength));
      } else {
        const side = this.file.replace(/_dir\.vpk$/i, ".vpk").replace(/\.vpk$/i, "_" + String(entry.archiveIndex).padStart(3, "0") + ".vpk");
        const sbuf = fs.readFileSync(side);
        parts.push(sbuf.subarray(entry.entryOffset, entry.entryOffset + entry.entryLength));
      }
    }
    return Buffer.concat(parts);
  }
}

module.exports = { Vpk };
