// Minimal VMT (Valve MaTerial) reader: which .vtf a material draws, and the render flags that decide
// whether it is opaque, cut out ($alphatest), blended ($translucent) or two-sided ($nocull).
// A VMT is a small KeyValues text file; $basetexture names the texture (without materials/ or .vtf).
// "patch" materials point at another VMT via include/replace - followed once.
"use strict";

function findKey(text, key) {
  const re = new RegExp('"?\\$?' + key + '"?\\s+"?([^"\\r\\n{}]+?)"?\\s*[\\r\\n}]', "i");
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}
// A boolean flag is "1"/"0"; treat any non-zero as set. Absent -> false.
function flag(text, key) { const v = findKey(text, key); return v != null && v.trim() !== "0"; }

// Returns { basetexture } (+ translucent/alphatest/nocull flags), or { include } to follow.
function parseVmt(text) {
  const translucent = flag(text, "translucent");
  const alphatest = flag(text, "alphatest");
  const nocull = flag(text, "nocull");
  const base = findKey(text, "basetexture");
  if (base) return { basetexture: base.replace(/\\/g, "/"), translucent, alphatest, nocull };
  const inc = findKey(text, "include");
  if (inc) return { include: inc.replace(/\\/g, "/"), translucent, alphatest, nocull };
  return { translucent, alphatest, nocull };
}

module.exports = { parseVmt };
