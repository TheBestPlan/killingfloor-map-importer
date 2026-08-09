// Read back the tagged property block of a .rom's LevelSummary - the fields KFEd shows under
// Level Properties. Use it to check what a converted map signs itself with, and to see how the
// shipped maps spell a field before writing it (DecoTextName and ExtraInfo are Str, not Name).
//
// Run: node scripts/summary.js <map.rom | Maps dir> [ClassName]
"use strict";

const fs = require("fs");
const path = require("path");
const R = require("../src/unreal/read");

const TYPE = { 1: "Byte", 2: "Int", 3: "Bool", 4: "Float", 5: "Object", 6: "Name", 8: "Class",
  9: "Array", 10: "Struct", 11: "Vector", 12: "Rotator", 13: "Str", 14: "Map" };
const SIZE = [1, 2, 4, 12, 16, 0, 0, 0];

// UE1/UE2 property tag: name, an info byte packing type/size/array, then the value.
// An actor carries RF_HasStack, and then an FStateFrame comes first (GOTCHAS 1.2).
const RF_HAS_STACK = 0x02000000;
function properties(pkg, exp) {
  const r = new R.Rd(pkg.buf, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  if (exp.objectFlags & RF_HAS_STACK) {
    const node = r.cidx(); r.cidx();
    r.skip(12);                                           // ProbeMask, LatentAction
    if (node !== 0) r.cidx();                             // Offset, only when Node != None
  }
  const out = [];
  while (r.pos < end) {
    const name = pkg.names[r.cidx()];
    if (name === "None" || name === undefined) break;
    const info = pkg.buf[r.pos++];
    const type = info & 0x0f, sizeCode = (info >> 4) & 0x07, flag = (info & 0x80) !== 0;
    const structName = type === 10 ? pkg.names[r.cidx()] : null;
    let size = SIZE[sizeCode];
    if (sizeCode === 5) size = pkg.buf[r.pos++];
    else if (sizeCode === 6) { size = pkg.buf.readUInt16LE(r.pos); r.pos += 2; }
    else if (sizeCode === 7) { size = pkg.buf.readUInt32LE(r.pos); r.pos += 4; }
    if (flag && type !== 3) r.pos++;                        // array index
    let value = "";
    if (type === 13) {                                      // FString: compact length, then latin1
      const at = r.pos, n = r.cidx();
      value = JSON.stringify(pkg.buf.toString("latin1", r.pos, r.pos + Math.max(0, n - 1)));
      r.pos = at + size;
    } else if (type === 2) { value = String(pkg.buf.readInt32LE(r.pos)); r.pos += size; }
    else if (type === 3) { value = String(flag); }
    else r.pos += size;
    out.push("   " + name + " : " + (TYPE[type] || type) + (structName ? "<" + structName + ">" : "") +
      (value ? " = " + value : ""));
  }
  return out;
}

const target = process.argv[2];
const want = process.argv[3] || "LevelSummary";
if (!target) { console.error("usage: node scripts/summary.js <map.rom | Maps dir> [ClassName]"); process.exit(2); }

const isFile = fs.statSync(target).isFile();
const dir = isFile ? path.dirname(target) : target;
const files = isFile ? [path.basename(target)] : fs.readdirSync(dir).filter((n) => /\.rom$/i.test(n));

for (const f of files) {
  let pkg;
  try { pkg = R.load(path.join(dir, f)); } catch (e) { console.log(f + "  unreadable: " + e.message); continue; }
  for (const e of pkg.exports.filter((x) => pkg.classOf(x) === want && x.serialSize > 0)) {
    console.log(f + "  " + e.name);
    for (const line of properties(pkg, e)) console.log(line);
  }
}
