// Inspect a KF .rom: what a shipped CS->KF port actually contains.
const fs = require("fs");
const path = require("path");
const KFRom = require("./_kfrom");

const file = process.argv[2];
const u8 = new Uint8Array(fs.readFileSync(file));
const pkg = KFRom.parsePackage(u8);

console.log("=== " + path.basename(file) + "  " + (u8.length / 1048576).toFixed(1) + " MB");
console.log("ver " + pkg.header.fileVersion + "/" + pkg.header.licenseeVersion +
  "  names " + pkg.header.nameCount + "  imports " + pkg.header.importCount + "  exports " + pkg.header.exportCount);

// class histogram + bytes per class
const hist = new Map();
for (const e of pkg.exports) {
  const c = pkg.classOf(e);
  const h = hist.get(c) || { n: 0, bytes: 0 };
  h.n++; h.bytes += e.serialSize; hist.set(c, h);
}
const top = [...hist.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25);
console.log("\n-- exports by class (top 25 by bytes)");
for (const [c, h] of top) console.log("   " + String(h.n).padStart(6) + "  " + (h.bytes / 1024).toFixed(0).padStart(8) + " KB  " + c);

// world model
const m = KFRom.findWorldModel(pkg);
if (m) {
  const model = KFRom.readModel(pkg, m);
  const rendered = model.nodes.filter((n) => n.numVertices >= 3).length;
  const zones = new Set(model.nodes.map((n) => n.zone));
  console.log("\n-- world Model '" + m.name + "' " + (m.serialSize / 1024).toFixed(0) + " KB");
  console.log("   points " + model.points.length + "  vectors " + model.vectors.length +
    "  nodes " + model.nodes.length + " (poly " + rendered + ")  surfs " + model.surfs.length +
    "  verts " + model.verts.length + "  zones " + zones.size);
  const bb = [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]];
  for (const p of model.points) for (let i = 0; i < 3; i++) { if (p[i] < bb[0][i]) bb[0][i] = p[i]; if (p[i] > bb[1][i]) bb[1][i] = p[i]; }
  console.log("   bbox " + bb[0].map(Math.round).join(",") + " .. " + bb[1].map(Math.round).join(",") +
    "   size " + bb[1].map((v, i) => Math.round(v - bb[0][i])).join(" x "));
}

// static meshes
const smAct = KFRom.readStaticMeshActors(pkg);
const meshRefs = new Map();
for (const a of smAct) meshRefs.set(a.meshRef, (meshRefs.get(a.meshRef) || 0) + 1);
let embedded = 0, imported = 0, triTotal = 0, vertTotal = 0;
for (const [ref, cnt] of meshRefs) {
  if (ref > 0) {
    embedded++;
    const e = pkg.exports[ref - 1];
    if (e && pkg.classOf(e) === "StaticMesh") {
      try { const sm = KFRom.readStaticMesh(pkg, e); if (sm) { triTotal += (sm.indices.length / 3) * cnt; vertTotal += sm.nVert; } } catch (err) { }
    }
  } else imported++;
}
console.log("\n-- static meshes: " + smAct.length + " actors, " + meshRefs.size + " unique (" +
  embedded + " embedded / " + imported + " imported)  ~" + Math.round(triTotal / 1000) + "k tris placed, " +
  Math.round(vertTotal / 1000) + "k unique verts");

// texture packages referenced
const files = new Map();
for (const im of pkg.imports) {
  if (!/Texture|Shader|Combiner|FinalBlend|Material|Modifier|Palette/.test(im.className)) continue;
  let outer = im.packageIndex, last = null;
  while (outer < 0) { const p = pkg.imports[-outer - 1]; if (!p) break; last = p.name; outer = p.packageIndex; }
  if (last) files.set(last, (files.get(last) || 0) + 1);
}
console.log("\n-- texture packages: " + [...files.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + "(" + v + ")").join(", "));

// embedded textures by format
const fmt = new Map();
for (const e of pkg.exports) {
  if (pkg.classOf(e) !== "Texture" || e.serialSize <= 0) continue;
  try {
    const t = KFRom.readTextureMip0(pkg, e);
    if (t) { const k = t.format + (t.masked ? "+mask" : ""); fmt.set(k, (fmt.get(k) || 0) + 1); }
  } catch (err) { }
}
if (fmt.size) console.log("-- embedded textures: " + [...fmt.entries()].map(([k, v]) => k + " x" + v).join(", "));

// lights + gameplay actors
const lit = KFRom.readActors(pkg, ["Light", "Spotlight", "TriggerLight", "Sunlight", "SkyZoneInfo", "ZoneInfo", "TerrainInfo",
  "PlayerStart", "PathNode", "KFTraderTeleporter", "ShopVolume", "WeaponLocker", "KFDoorMover", "Mover", "StaticMeshInstance"]);
const byCls = new Map();
for (const a of lit) byCls.set(a.cls, (byCls.get(a.cls) || 0) + 1);
console.log("-- actors: " + [...byCls.entries()].map(([k, v]) => k + " x" + v).join(", "));

// is there a StaticMeshInstance class (baked per-instance vertex lighting)?
const smi = pkg.exports.filter((e) => pkg.classOf(e) === "StaticMeshInstance");
console.log("-- StaticMeshInstance exports: " + smi.length + (smi.length ? "  (baked per-instance vertex lighting present)" : ""));
