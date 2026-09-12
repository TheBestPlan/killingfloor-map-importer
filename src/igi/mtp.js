// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Project IGI level material-texture pool (.mtp): an IFF FORM 'MTP ' with big-endian chunk sizes. The
// per-model texture assignment lives here (format from github artiom-rotari/igipy docs/igi2/formats/dat_mtp.md,
// verified byte-for-byte on IGI1 level2): INST is a flat stream of records `[model_index u32][count u32]
// [texIdx u32 * count]` in MODS order; each .mef DNER render group carries a material index (@16) that
// selects one entry from its model's list. TEXF holds the texture base names (with pixel-format suffix,
// e.g. glass_argb8888) - the .tex file on disk uses that exact stem. Returns { texByModel, texNames }.
"use strict";

function readMtp(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "FORM") return null;
  const ch = {};
  let p = 12;                                          // skip FORM + u32 size + 4-char form type
  while (p + 8 <= buf.length) { const id = buf.toString("latin1", p, p + 4); const sz = buf.readUInt32BE(p + 4); ch[id] = { off: p + 8, size: sz }; p = p + 8 + sz + (sz & 1); }
  const names = (c) => { const out = []; if (!c) return out; let q = c.off; const e = c.off + c.size; while (q < e) { let x = q; while (x < e && buf[x] !== 0) x++; if (x > q) out.push(buf.toString("latin1", q, x).toLowerCase()); q = x + 1; } return out; };
  const texNames = names(ch.TEXF);
  const texByModel = [];
  if (ch.INST) {
    let o = ch.INST.off; const e = ch.INST.off + ch.INST.size;
    while (o + 8 <= e) {
      const mi = buf.readUInt32LE(o), cnt = buf.readUInt32LE(o + 4); o += 8;
      const idxs = []; for (let k = 0; k < cnt && o + 4 <= e; k++) { idxs.push(buf.readUInt32LE(o)); o += 4; }
      texByModel[mi] = idxs;
    }
  }
  return { texByModel, texNames };
}

module.exports = { readMtp };

// Self-check: a synthetic FORM 'MTP ' with a TEXF (2 names) and an INST (model0 -> [1,0]) round-trips.
if (require.main === module) {
  const be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
  const le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const texf = Buffer.from("a_argb8888\0b_argb1555\0", "latin1");
  const inst = Buffer.concat([le(0), le(2), le(1), le(0)]);   // model0: count 2, indices [1,0]
  const body = Buffer.concat([Buffer.from("MTP ", "latin1"), Buffer.from("TEXF", "latin1"), be(texf.length), texf, Buffer.from("INST", "latin1"), be(inst.length), inst]);
  const buf = Buffer.concat([Buffer.from("FORM", "latin1"), be(body.length), body]);
  const r = readMtp(buf);
  const assert = (c, m) => { if (!c) throw new Error("mtp self-check: " + m); };
  assert(r && r.texNames.length === 2 && r.texNames[0] === "a_argb8888", "texNames " + JSON.stringify(r && r.texNames));
  assert(r.texByModel[0] && r.texByModel[0][0] === 1 && r.texByModel[0][1] === 0, "texByModel " + JSON.stringify(r.texByModel[0]));
  console.log("mtp.js: FORM/MTP INST+TEXF parse OK");
}
