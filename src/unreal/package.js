// Assembles a complete Unreal Engine 2.5 package (Killing Floor .rom, file version 128 / licensee 29).
// Layout, matching the shipped maps: header(64) | name table | export data | import table | export table.
// Writing the data before the tables means every serial offset is known before the export table is
// emitted, so no fix-point pass over the compact-index widths is needed.
"use strict";

const { Writer, Props } = require("./writer");

const TAG = 0x9e2a83c2;
const FILE_VERSION = 128;
const LICENSEE_VERSION = 29;
// PKG_AllowDownload, and nothing else. Every shipped Killing Floor map and every hand-built CS port
// carries exactly 0x00000001; this writer shipped 0x21 for a long time and the extra bit is not one
// the engine documents. It is also the ONE byte test/repack.js could never reproduce on a shipped
// map - the difference was known and shrugged off. See GOTCHAS 1.7.
const PKG_FLAGS = 0x00000001;
const NAME_FLAGS = 0x00070010;

const RF = {
  Transactional: 0x00000001,
  Public: 0x00000004,
  LoadForClient: 0x00010000,
  LoadForServer: 0x00020000,
  LoadForEdit: 0x00040000,
  Standalone: 0x00080000,
  NotForClient: 0x00100000,
  NotForServer: 0x00200000,
  NotForEdit: 0x00400000,
  HasStack: 0x02000000,
};
// The two flag words every shipped map uses.
RF.GAME = RF.Transactional | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit;   // 0x00070001
RF.EDITOR_ONLY = RF.Transactional | RF.LoadForEdit | RF.NotForClient | RF.NotForServer; // 0x00340001

class Names {
  constructor() { this.list = []; this.index = new Map(); this.add("None"); }
  add(name) {
    if (typeof name !== "string") throw new Error("name must be a string: " + name);
    let i = this.index.get(name);
    if (i === undefined) { i = this.list.length; this.list.push(name); this.index.set(name, i); }
    return i;
  }
  get none() { return 0; }
}

class Package {
  constructor(opts) {
    this.names = new Names();
    this.imports = [];
    this.exports = [];
    this.importKey = new Map();
    this.guid = opts && opts.guid ? opts.guid : Buffer.alloc(16);
  }

  // Import a top-level package object (e.g. "Engine"), returning its negative ref.
  importPackage(pkgName) {
    return this._import("Core", "Package", 0, pkgName);
  }
  // Import a class living in a package, e.g. classRef("Engine", "PlayerStart").
  importClass(pkgName, className) {
    const outer = this.importPackage(pkgName);
    return this._import("Core", "Class", outer, className);
  }
  // Import a concrete object (e.g. a texture inside a .utx) — outer is another import ref.
  importObject(classPackage, className, outerRef, objectName) {
    return this._import(classPackage, className, outerRef, objectName);
  }
  _import(classPackage, className, outerRef, objectName) {
    const key = classPackage + "|" + className + "|" + outerRef + "|" + objectName;
    let ref = this.importKey.get(key);
    if (ref !== undefined) return ref;
    this.imports.push({ classPackage, className, packageIndex: outerRef, objectName });
    ref = -this.imports.length;
    this.importKey.set(key, ref);
    return ref;
  }

  // Declare an export up front so other objects can reference it; `serialize(pkg)` is called later
  // and must return a Writer.
  addExport(spec) {
    this.exports.push({
      classRef: spec.classRef, superRef: spec.superRef || 0, outer: spec.outer || 0,
      name: spec.name, flags: spec.flags === undefined ? RF.GAME : spec.flags,
      serialize: spec.serialize, _w: null,
    });
    return this.exports.length; // positive ref (1-based)
  }

  props(w) { return new Props(w, this.names); }
  // An object whose entire body is an empty property block.
  emptyBody() { const w = new Writer(4); w.cidx(this.names.none); return w; }

  build() {
    // Serializers add names as they run, and so do the import/export tables, so every name must be
    // registered before the name table itself is written.
    const bodies = this.exports.map((e) => (e.serialize ? e.serialize(this) : this.emptyBody()));
    for (const im of this.imports) {
      this.names.add(im.classPackage); this.names.add(im.className); this.names.add(im.objectName);
    }
    for (const e of this.exports) this.names.add(e.name);

    const nameTable = new Writer(1 << 14);
    for (const n of this.names.list) {
      const b = Buffer.from(n, "latin1");
      nameTable.cidx(b.length + 1).bytes(b).u8(0).u32(NAME_FLAGS);
    }

    const headerSize = 64;                       // one generation record
    const nameOffset = headerSize;
    const dataOffset = nameOffset + nameTable.len;

    // Place bodies and resolve their lazy-array skip offsets to absolute file positions.
    let cursor = dataOffset;
    const placed = [];
    bodies.forEach((w, i) => {
      const base = cursor;
      const buf = Buffer.from(w.out());
      for (const p of w.lazyPatches) {
        if (p.target < 0) throw new Error("unresolved lazy array in export " + this.exports[i].name);
        buf.writeInt32LE(base + p.target, p.at);
      }
      placed.push({ base, buf });
      cursor += buf.length;
    });
    const importOffset = cursor;

    const importTable = new Writer(1 << 12);
    for (const im of this.imports) {
      importTable.cidx(this.names.add(im.classPackage));
      importTable.cidx(this.names.add(im.className));
      importTable.i32(im.packageIndex);
      importTable.cidx(this.names.add(im.objectName));
    }
    const exportOffset = importOffset + importTable.len;

    const exportTable = new Writer(1 << 12);
    this.exports.forEach((e, i) => {
      const size = placed[i].buf.length;
      exportTable.cidx(e.classRef);
      exportTable.cidx(e.superRef);
      exportTable.i32(e.outer);
      exportTable.cidx(this.names.add(e.name));
      exportTable.u32(e.flags);
      exportTable.cidx(size);
      if (size > 0) exportTable.cidx(placed[i].base);
    });

    // Adding names while writing the tables would invalidate the table we already wrote, so assert
    // the name table did not grow after it was serialized.
    const nameBytesNow = (() => {
      const t = new Writer(1 << 14);
      for (const n of this.names.list) { const b = Buffer.from(n, "latin1"); t.cidx(b.length + 1).bytes(b).u8(0).u32(NAME_FLAGS); }
      return t.len;
    })();
    if (nameBytesNow !== nameTable.len) throw new Error("name table grew while writing tables — pre-register import/export names");

    const head = new Writer(headerSize);
    head.u32(TAG).u16(FILE_VERSION).u16(LICENSEE_VERSION).u32(PKG_FLAGS);
    head.u32(this.names.list.length).u32(nameOffset);
    head.u32(this.exports.length).u32(exportOffset);
    head.u32(this.imports.length).u32(importOffset);
    head.bytes(this.guid);
    head.u32(1).u32(this.exports.length).u32(this.names.list.length);
    if (head.len !== headerSize) throw new Error("header size " + head.len + " != " + headerSize);

    return Buffer.concat([
      Buffer.from(head.out()), Buffer.from(nameTable.out()),
      ...placed.map((p) => p.buf),
      Buffer.from(importTable.out()), Buffer.from(exportTable.out()),
    ]);
  }
}

module.exports = { Package, Names, RF, TAG, FILE_VERSION, LICENSEE_VERSION };
