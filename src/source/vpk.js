// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Valve Pak (VPK) v1/v2 reader - the archive format the Source games keep their materials in.
//
// A `<name>_dir.vpk` holds a directory tree; a file's bytes live either inline (preload), in the
// _dir.vpk after the tree, or in a numbered `<name>_NNN.vpk` sibling. Used to pull a map's .vmt/.vtf
// out of the game's VPKs when they are not embedded in the map's own pakfile lump.
"use strict";

const fs = require("fs");
const path = require("path");

const SIG = 0x55aa1234;

class Vpk {
  constructor(dirFile) {
    this.dir = dirFile;
    this.base = dirFile.replace(/_dir\.vpk$/i, "");   // sibling archives are <base>_NNN.vpk
    this.index = new Map();                            // "path/name.ext" (lowercase) -> entry
    this._read();
  }

  _read() {
    const fd = fs.openSync(this.dir, "r");
    const head = Buffer.alloc(28);
    fs.readSync(fd, head, 0, 28, 0);
    if (head.readUInt32LE(0) !== SIG) { fs.closeSync(fd); throw new Error("not a VPK: " + this.dir); }
    const version = head.readUInt32LE(4);
    const treeSize = head.readUInt32LE(8);
    const headerSize = version >= 2 ? 28 : 12;
    this.dataStart = headerSize + treeSize;            // where inline (archive 0x7fff) data begins
    const tree = Buffer.alloc(treeSize);
    fs.readSync(fd, tree, 0, treeSize, headerSize);
    fs.closeSync(fd);

    let p = 0;
    const str = () => { const s = p; while (tree[p] !== 0) p++; const v = tree.toString("latin1", s, p); p++; return v; };
    for (;;) {
      const ext = str(); if (ext === "") break;
      for (;;) {
        const dir = str(); if (dir === "") break;
        for (;;) {
          const name = str(); if (name === "") break;
          const crc = tree.readUInt32LE(p); p += 4;
          const preloadBytes = tree.readUInt16LE(p); p += 2;
          const archiveIndex = tree.readUInt16LE(p); p += 2;
          const entryOffset = tree.readUInt32LE(p); p += 4;
          const entryLength = tree.readUInt32LE(p); p += 4;
          p += 2;                                       // terminator 0xffff
          const preload = preloadBytes ? tree.subarray(p, p + preloadBytes) : Buffer.alloc(0);
          p += preloadBytes;
          const full = (dir === " " ? name : dir + "/" + name) + "." + ext;
          this.index.set(full.toLowerCase(), { archiveIndex, entryOffset, entryLength, preload });
        }
      }
    }
  }

  has(name) { return this.index.has(name.toLowerCase()); }

  // Read a file's full bytes (preload + archive data).
  read(name) {
    const e = this.index.get(name.toLowerCase());
    if (!e) return null;
    if (!e.entryLength) return Buffer.from(e.preload);
    const src = e.archiveIndex === 0x7fff ? this.dir : this.base + "_" + String(e.archiveIndex).padStart(3, "0") + ".vpk";
    const at = e.archiveIndex === 0x7fff ? this.dataStart + e.entryOffset : e.entryOffset;
    const fd = fs.openSync(src, "r");
    const body = Buffer.alloc(e.entryLength);
    fs.readSync(fd, body, 0, e.entryLength, at);
    fs.closeSync(fd);
    return e.preload.length ? Buffer.concat([e.preload, body]) : body;
  }
}

// Open every _dir.vpk in a list of game content folders (e.g. cstrike/, hl2/) once, as a search set.
function openGameVpks(dirs, log) {
  const vpks = [];
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => /_dir\.vpk$/i.test(f)); } catch (e) { continue; }
    for (const f of files) { try { vpks.push(new Vpk(path.join(d, f))); } catch (e) { if (log) log("  vpk: " + f + " - " + e.message); } }
  }
  return {
    read(name) { for (const v of vpks) { if (v.has(name)) return v.read(name); } return null; },
    count: vpks.length,
  };
}

module.exports = { Vpk, openGameVpks };
