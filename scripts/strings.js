// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Pull ASCII strings out of a DLL/EXE and grep them — used to confirm which editor exec commands
// and commandlets the shipped KF binaries actually implement.
const fs = require("fs");
const buf = fs.readFileSync(process.argv[2]);
const pats = process.argv.slice(3).map((p) => new RegExp(p, "i"));
const out = new Set();
let cur = "";
for (let i = 0; i < buf.length; i++) {
  const c = buf[i];
  if (c >= 0x20 && c < 0x7f) { cur += String.fromCharCode(c); continue; }
  if (cur.length >= 4 && pats.some((p) => p.test(cur))) out.add(cur);
  cur = "";
}
for (const s of [...out].sort()) console.log(s);
