// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Lineage 2's particle systems, read as a property tree that can be written back out.
//
// An `Emitter` is an ordinary actor holding an `Emitters` array of `SpriteEmitter` objects, and both
// engines call the fields the same things: of the 43 property names the client's emitters use, 39 are
// declared on Killing Floor's own `ParticleEmitter` (see docs/games/lineage2.md L2.19). So this does
// not interpret the effect - it copies the settings across and lets the other engine run them.
//
// The tree is generic on purpose. A `RangeVector` is three `Range`s, each its own tagged block, and
// `ColorScale` is an array of blocks; decoding those into named JavaScript shapes would be a schema
// to keep in step with two engines. Reading them as blocks and writing them back as blocks needs no
// schema at all - only the names have to be re-registered, because a name index means nothing outside
// the package it came from.
"use strict";

const { Rd } = require("../unreal/read");
const { readTags, tagsOf, pick, val, refTarget, TYPE } = require("./props");

// Structs the engine writes as their fields back to back, with no tags. Everything else is a nested
// tagged block - `Range`, `RangeVector`, `ParticleColorScale`, `PointRegion`.
const ATOMIC = new Set(["Vector", "Rotator", "Color", "Plane", "Quat", "Matrix", "Coords", "IntBox"]);

// A property block, decoded. Returns null when the walk does not land exactly on the end, which is
// what says the bytes are not a block at all.
function readBlock(pkg, at, end) {
  const { tags, pos } = readTags(pkg, at, end);
  if (pos !== end) return null;
  const out = [];
  for (const t of tags) {
    const p = decode(pkg, t);
    if (p) out.push(p);
  }
  return out;
}

function decode(pkg, t) {
  const base = { name: t.name, index: t.index };
  switch (t.type) {
    case TYPE.Byte: return Object.assign(base, { kind: "byte", value: val.byte(pkg, t) });
    case TYPE.Int: return Object.assign(base, { kind: "int", value: val.int(pkg, t) });
    case TYPE.Bool: return Object.assign(base, { kind: "bool", value: t.bool });
    case TYPE.Float: return Object.assign(base, { kind: "float", value: val.float(pkg, t) });
    case TYPE.Name: return Object.assign(base, { kind: "name", value: val.name(pkg, t) });
    case TYPE.Object: return Object.assign(base, { kind: "object", target: refTarget(pkg, val.ref(pkg, t)) });
    case TYPE.Str: {
      const r = new Rd(pkg.buf, t.at);
      const n = r.cidx();
      if (n < 0 || n > t.size) return null;
      return Object.assign(base, { kind: "str", value: pkg.buf.toString("latin1", r.pos, r.pos + Math.max(0, n - 1)) });
    }
    case TYPE.Struct: {
      if (!ATOMIC.has(t.structName)) {
        const block = readBlock(pkg, t.at, t.at + t.size);
        if (block) return Object.assign(base, { kind: "struct", structName: t.structName, block });
      }
      return Object.assign(base, { kind: "structRaw", structName: t.structName, bytes: pkg.buf.subarray(t.at, t.at + t.size) });
    }
    case TYPE.Array: {
      const r = new Rd(pkg.buf, t.at);
      const n = r.cidx();
      const end = t.at + t.size;
      if (n < 0 || n > 4096) return null;
      // An element is whatever the property's type says, and the file does not say. Two shapes turn
      // up here: blocks (ColorScale, SizeScale) and object references (Emitters). Try blocks, and
      // read object references only if the whole span divides into exactly that many of them.
      const items = [];
      let pos = r.pos, ok = n > 0;
      for (let i = 0; i < n && ok; i++) {
        const sub = readTags(pkg, pos, end);
        if (sub.pos > end || sub.pos === pos || !sub.tags.length) { ok = false; break; }
        const block = [];
        for (const st of sub.tags) { const p = decode(pkg, st); if (p) block.push(p); }
        items.push(block);
        pos = sub.pos;
      }
      if (ok && pos === end) return Object.assign(base, { kind: "array", items });
      const refs = [];
      const rr = new Rd(pkg.buf, r.pos);
      for (let i = 0; i < n; i++) refs.push(refTarget(pkg, rr.cidx()));
      if (rr.pos === end) return Object.assign(base, { kind: "objectArray", targets: refs });
      return null;
    }
    default: return null;
  }
}

// Every Emitter actor in a square, with the particle emitters it owns.
//
// `Emitters` names them, and each is a top-level export in the same file. A named emitter that is
// not a class this converter can write is reported rather than dropped silently.
function readEmitters(pkg, opts) {
  const want = (opts && opts.classes) || ["SpriteEmitter"];
  const out = [], skipped = new Map();
  for (const e of pkg.exports) {
    if (pkg.classOf(e) !== "Emitter" || !e.serialSize) continue;
    const { tags } = tagsOf(pkg, e);
    const list = pick(tags, "Emitters");
    if (!list) continue;
    const decoded = decode(pkg, list);
    const targets = decoded && decoded.kind === "objectArray" ? decoded.targets : [];
    const parts = [];
    for (const t of targets) {
      if (!t || !t.local) continue;
      const cls = pkg.classOf(t.local);
      if (!want.includes(cls)) { skipped.set(cls, (skipped.get(cls) || 0) + 1); continue; }
      const block = readBlock(pkg, t.local.serialOffset, t.local.serialOffset + t.local.serialSize);
      if (block) parts.push({ cls, name: t.local.name, block });
    }
    if (!parts.length) continue;
    const locTag = pick(tags, "Location"), rotTag = pick(tags, "Rotation"), dsTag = pick(tags, "DrawScale");
    out.push({
      name: e.name,
      location: locTag ? val.vector(pkg, locTag) : [0, 0, 0],
      rotation: rotTag ? val.rotator(pkg, rotTag) : null,
      drawScale: dsTag ? val.float(pkg, dsTag) : null,
      parts,
    });
  }
  return { emitters: out, skipped };
}

// Turn every object reference in the tree into a ref in the package being written.
//
// This runs BEFORE the package is serialised, not during: carrying a texture registers new exports,
// and an export added while the bodies are already being written is one the export table never hears
// about. `resolve(target)` returns a ref, or 0 for "drop this property".
function resolveObjects(block, resolve) {
  for (const p of block) {
    if (p.kind === "object") p.ref = resolve(p.target) || 0;
    else if (p.kind === "struct") resolveObjects(p.block, resolve);
    else if (p.kind === "array") for (const item of p.items) resolveObjects(item, resolve);
  }
  return block;
}

// Write a decoded block into a Killing Floor package. An object property with no ref is left out - a
// texture that could not be carried is better missing than pointing at nothing.
function writeBlock(pr, block) {
  for (const p of block) {
    const at = p.index || undefined;
    switch (p.kind) {
      case "byte": pr.byte(p.name, p.value); break;
      case "int": pr.int(p.name, p.value); break;
      case "bool": pr.bool(p.name, p.value); break;
      case "float": pr.float(p.name, p.value); break;
      case "name": pr.nameProp(p.name, p.value); break;
      case "str": pr.str(p.name, p.value); break;
      case "object": if (p.ref) pr.object(p.name, p.ref); break;
      case "structRaw": pr.structRaw(p.name, p.structName, p.bytes, at); break;
      case "struct": pr.structBlock(p.name, p.structName, (sub) => { writeBlock(sub, p.block); sub.end(); }); break;
      case "array":
        pr.arrayProp(p.name, p.items.length, (w, sub) => {
          for (const item of p.items) { writeBlock(sub, item); sub.end(); }
        });
        break;
      default: break;                                  // objectArray is rebuilt by the caller
    }
  }
}

module.exports = { readEmitters, readBlock, resolveObjects, writeBlock };
