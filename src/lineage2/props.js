// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// The UE2 tagged property block, read as a LIST rather than a map.
//
// A map object needs the array index (`Layers` is eight entries under one name) and the raw span of
// a struct (a TerrainLayer is another tagged block nested inside), neither of which survives being
// flattened into { name: value }.
"use strict";

const { Rd } = require("../unreal/read");

const SIZE = { 0: 1, 1: 2, 2: 4, 3: 12, 4: 16 };
const TYPE = { Byte: 1, Int: 2, Bool: 3, Float: 4, Object: 5, Name: 6, Class: 8, Array: 9, Struct: 10, Str: 13 };
const RF_HasStack = 0x02000000;

// `end` bounds the walk; without it a misread size runs off into the next object.
function readTags(pkg, at, end, opts) {
  const r = new Rd(pkg.buf, at);
  const out = [];
  for (let g = 0; g < 4000 && r.pos < end; g++) {
    const nameIdx = r.cidx();
    const name = pkg.names[nameIdx];
    if (name === undefined || name === "None") break;
    const info = r.u8(), type = info & 0x0f, sc = (info >> 4) & 7;
    const structName = type === TYPE.Struct ? pkg.names[r.cidx()] : null;
    let size = SIZE[sc];
    if (sc === 5) size = r.u8(); else if (sc === 6) size = r.u16(); else if (sc === 7) size = r.u32();
    let index = 0;
    if ((info & 0x80) && type !== TYPE.Bool) index = r.u8();
    if (type === TYPE.Bool) { out.push({ name, type, index, bool: !!((info >> 7) & 1) }); continue; }
    out.push({ name, type, index, structName, at: r.pos, size });
    r.skip(size);
  }
  return { tags: out, pos: r.pos };
}

// The state frame RF_HasStack puts in front of an actor's properties.
function bodyStart(pkg, exp) {
  const r = new Rd(pkg.buf, exp.serialOffset);
  if (exp.objectFlags & RF_HasStack) {
    const node = r.cidx(); r.cidx(); r.i32(); r.i32(); r.i32();
    if (node !== 0) r.cidx();
  }
  return r.pos;
}

function tagsOf(pkg, exp) {
  return readTags(pkg, bodyStart(pkg, exp), exp.serialOffset + exp.serialSize);
}

const val = {
  byte: (pkg, t) => pkg.buf[t.at],
  int: (pkg, t) => pkg.buf.readInt32LE(t.at),
  float: (pkg, t) => pkg.buf.readFloatLE(t.at),
  ref: (pkg, t) => new Rd(pkg.buf, t.at).cidx(),
  name: (pkg, t) => pkg.names[new Rd(pkg.buf, t.at).cidx()],
  vector: (pkg, t) => [pkg.buf.readFloatLE(t.at), pkg.buf.readFloatLE(t.at + 4), pkg.buf.readFloatLE(t.at + 8)],
  rotator: (pkg, t) => [pkg.buf.readInt32LE(t.at), pkg.buf.readInt32LE(t.at + 4), pkg.buf.readInt32LE(t.at + 8)],
  bytes: (pkg, t) => pkg.buf.subarray(t.at, t.at + t.size),
};

// One tag by name (and array index), or undefined.
const pick = (tags, name, index) => tags.find((t) => t.name === name && (index === undefined || t.index === index));
// Every tag of that name, in array order.
const all = (tags, name) => tags.filter((t) => t.name === name).sort((a, b) => a.index - b.index);

// An object reference resolved to { pkg, name, group } - `pkg` is the package NAME, not the file.
// An import chains outward through its outer until the top-level package object.
function refTarget(pkg, ref) {
  if (ref === 0) return null;
  if (ref > 0) {
    const e = pkg.exports[ref - 1];
    return e ? { pkg: pkg.pkgName || null, name: e.name, local: e } : null;
  }
  let im = pkg.imports[-ref - 1];
  if (!im) return null;
  const name = im.name;
  const groups = [];
  let outer = im.packageIndex;
  while (outer < 0) {
    const o = pkg.imports[-outer - 1];
    if (!o) break;
    groups.unshift(o.name);
    outer = o.packageIndex;
  }
  // The outermost group IS the package; anything between it and the object is a group inside it.
  const pkgName = groups.length ? groups[0] : null;
  return { pkg: pkgName, group: groups.slice(1), name, className: im.className };
}

module.exports = { readTags, tagsOf, bodyStart, pick, all, val, refTarget, TYPE };
