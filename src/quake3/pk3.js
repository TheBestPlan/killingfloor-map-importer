// Quake 3 .pk3 archives, and the layered file system the engine builds out of them.
//
// A .pk3 is a plain zip. Everything a map needs that is not in the .bsp - the wall textures, the
// .shader scripts that name them, the sky images - lives in one, so reading a map means reading the
// client's archives the way the engine does: the mod folder over baseq3, and inside each folder the
// highest-numbered pak wins.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

// The end-of-central-directory record sits at the tail, behind a comment of up to 64 KB.
function findEocd(fd, size) {
  const back = Math.min(size, 0xffff + 22);
  const buf = Buffer.alloc(back);
  fs.readSync(fd, buf, 0, back, size - back);
  for (let i = back - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return { count: buf.readUInt16LE(i + 10), cdSize: buf.readUInt32LE(i + 12), cdOff: buf.readUInt32LE(i + 16) };
    }
  }
  return null;
}

class Pk3 {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, "r");
    const size = fs.fstatSync(this.fd).size;
    const eocd = findEocd(this.fd, size);
    if (!eocd) throw new Error("not a zip: " + file);
    const cd = Buffer.alloc(eocd.cdSize);
    fs.readSync(this.fd, cd, 0, eocd.cdSize, eocd.cdOff);
    this.entries = new Map();
    let o = 0;
    for (let i = 0; i < eocd.count && o + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(o) !== CEN_SIG) break;
      const nameLen = cd.readUInt16LE(o + 28), extraLen = cd.readUInt16LE(o + 30), cmtLen = cd.readUInt16LE(o + 32);
      const name = cd.toString("latin1", o + 46, o + 46 + nameLen).replace(/\\/g, "/");
      // Directory records carry no data and would shadow a real file of the same name.
      if (!/\/$/.test(name)) {
        this.entries.set(name.toLowerCase(), {
          method: cd.readUInt16LE(o + 10), csize: cd.readUInt32LE(o + 20),
          size: cd.readUInt32LE(o + 24), header: cd.readUInt32LE(o + 42),
        });
      }
      o += 46 + nameLen + extraLen + cmtLen;
    }
  }

  read(e) {
    // The local header repeats the name and carries its own extra field, so where the bytes start
    // cannot be taken from the central directory alone.
    const head = Buffer.alloc(30);
    fs.readSync(this.fd, head, 0, 30, e.header);
    const at = e.header + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = Buffer.alloc(e.csize);
    fs.readSync(this.fd, raw, 0, e.csize, at);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error("unsupported zip compression method " + e.method + " in " + this.file);
  }

  close() { fs.closeSync(this.fd); }
}

// The engine's search path, flattened: every archive of every folder plus the loose files beside
// them, with the later ones winning. Q3 loads pk3s in reverse alphabetical order and lets loose
// files override an archive, which is the same thing as adding them in this order and overwriting.
class GameFs {
  constructor(dirs, log) {
    this.paks = [];
    this.index = new Map();               // "textures/base_wall/x.jpg" -> { pak, entry } | { file }
    for (const dir of dirs) {
      if (!dir || !fs.existsSync(dir)) continue;
      const pk3s = fs.readdirSync(dir).filter((f) => /\.pk3$/i.test(f)).sort();
      for (const f of pk3s) {
        let pak;
        try { pak = new Pk3(path.join(dir, f)); } catch (err) { if (log) log("pk3 unreadable: " + f + " (" + err.message + ")"); continue; }
        this.paks.push(pak);
        for (const [name, entry] of pak.entries) this.index.set(name, { pak, entry });
      }
      // Loose files last: an extracted texture beside the archives is what the engine picks up.
      this._addLoose(dir, dir);
    }
  }

  _addLoose(root, dir, depth) {
    if ((depth || 0) > 6) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) this._addLoose(root, full, (depth || 0) + 1);
      else if (!/\.pk3$/i.test(d.name)) {
        this.index.set(path.relative(root, full).replace(/\\/g, "/").toLowerCase(), { file: full });
      }
    }
  }

  has(name) { return this.index.has(name.replace(/\\/g, "/").toLowerCase()); }

  read(name) {
    const hit = this.index.get(name.replace(/\\/g, "/").toLowerCase());
    if (!hit) return null;
    return hit.file ? fs.readFileSync(hit.file) : hit.pak.read(hit.entry);
  }

  // Every path matching a pattern, in the order the index has them.
  list(re) { return [...this.index.keys()].filter((k) => re.test(k)); }

  close() { for (const p of this.paks) p.close(); }
}

// The folders Quake 3 itself would search, mod first so its files win.
function searchDirs(clientDir, mod) {
  const out = [];
  if (mod && mod !== "baseq3") out.push(path.join(clientDir, "baseq3"));
  out.push(path.join(clientDir, mod || "baseq3"));
  return out;
}

module.exports = { Pk3, GameFs, searchDirs };
