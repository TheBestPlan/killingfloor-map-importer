// Minimal ZIP reader for a BSP's PAKFILE lump - where a Source map embeds its own materials/models.
// Handles stored (0) and deflate (8), which is all bspzip writes. Central-directory driven.
"use strict";

const zlib = require("zlib");

class Zip {
  constructor(buf) {
    this.buf = buf || Buffer.alloc(0);
    this.entries = new Map();   // name(lowercase) -> { offset, method, compSize, uncompSize }
    if (this.buf.length >= 22) this._readCentral();
  }

  _readCentral() {
    const buf = this.buf;
    // find End Of Central Directory (0x06054b50), scanning back from the end
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return;
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);   // central dir offset
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const uncompSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOff = buf.readUInt32LE(p + 42);
      const name = buf.toString("latin1", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
      this.entries.set(name.toLowerCase(), { localOff, method, compSize, uncompSize });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name.toLowerCase()); }

  read(name) {
    const e = this.entries.get(name.toLowerCase());
    if (!e) return null;
    const buf = this.buf;
    // local header: 30 + nameLen + extraLen, then the data
    const nameLen = buf.readUInt16LE(e.localOff + 26);
    const extraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + nameLen + extraLen;
    const comp = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(comp);
    if (e.method === 8) { try { return zlib.inflateRawSync(comp); } catch (err) { return null; } }
    return null;
  }
}

module.exports = { Zip };
