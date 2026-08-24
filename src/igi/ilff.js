// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Project IGI ILFF container. An `.res` is `ILFF` (16-byte header) + a 4-char form type (`IRES`) then
// a flat list of chunks { name[4], size[4], align[4], next[4] } advanced by `next`. A model `.res`
// (IRES) is a sequence of NAME (a resource path like `LOCAL:models/210_01_1.mef`) + BODY (the bytes of
// that resource) pairs; each BODY is itself an ILFF whose form is `OCEM` - a `.mef` mesh. Chunk names
// are stored REVERSED (XTRV = VRTX, HSEM = MESH, DNER = REND, ...).
"use strict";

// Walk the chunks of an ILFF body between [start, end); each chunk carries its data offset + size.
function chunks(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 16 <= end) {
    const name = buf.toString("latin1", p, p + 4);
    if (!/^[\x20-\x7e]{4}$/.test(name)) break;
    const size = buf.readUInt32LE(p + 4), next = buf.readUInt32LE(p + 12);
    out.push({ name, size, data: p + 16 });
    if (next < 16) break;
    p += next;
  }
  return out;
}

// An ILFF file: returns { form, chunks } where chunks() walks the body after the 4-char form type.
function readIlff(buf, base) {
  base = base || 0;
  if (buf.toString("latin1", base, base + 4) !== "ILFF") throw new Error("not ILFF");
  const size = buf.readUInt32LE(base + 4);
  const form = buf.toString("latin1", base + 16, base + 20);
  return { form, chunks: chunks(buf, base + 20, base + 4 + size) };
}

// A model `.res` (IRES) -> [{ name, data (mef bytes offset), size }] from its NAME + BODY chunk pairs.
function readResPack(buf) {
  const { form, chunks: cs } = readIlff(buf, 0);
  if (form !== "IRES") throw new Error("not an IGI resource pack (form " + form + ")");
  const entries = [];
  for (let i = 0; i < cs.length - 1; i++) {
    if (cs[i].name === "NAME" && cs[i + 1].name === "BODY") {
      const name = buf.toString("latin1", cs[i].data, cs[i].data + cs[i].size).replace(/\0.*$/, "");
      entries.push({ name, offset: cs[i + 1].data, size: cs[i + 1].size });
    }
  }
  return entries;
}

module.exports = { readIlff, readResPack };
