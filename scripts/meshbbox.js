// For an existing CS->KF port: bounding box of the whole-level StaticMesh (x DrawScale) so the
// HL-units -> Unreal-units scale factor the porters actually used can be measured.
const fs = require("fs");
const path = require("path");
const KFRom = require("./_kfrom");

for (const file of process.argv.slice(2)) {
  const u8 = new Uint8Array(fs.readFileSync(file));
  const pkg = KFRom.parsePackage(u8);
  const meshes = pkg.exports.map((e, i) => ({ e, i })).filter((x) => pkg.classOf(x.e) === "StaticMesh" && x.e.serialSize > 0)
    .sort((a, b) => b.e.serialSize - a.e.serialSize);
  const acts = KFRom.readStaticMeshActors(pkg);
  console.log("=== " + path.basename(file));
  for (const { e, i } of meshes.slice(0, 3)) {
    let sm; try { sm = KFRom.readStaticMesh(pkg, e); } catch (err) { continue; }
    if (!sm) { console.log("  " + e.name + "  (unparsed)"); continue; }
    const bb = [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]];
    for (let v = 0; v < sm.nVert; v++) for (let a = 0; a < 3; a++) {
      const c = sm.positions[v * 3 + a];
      if (c < bb[0][a]) bb[0][a] = c;
      if (c > bb[1][a]) bb[1][a] = c;
    }
    const inst = acts.filter((a) => a.meshRef === i + 1);
    const sc = inst.length ? inst[0].drawScale * (inst[0].drawScale3D[0] || 1) : 1;
    console.log("  mesh '" + e.name + "'  " + (e.serialSize / 1024).toFixed(0) + " KB  verts " + sm.nVert +
      "  tris " + (sm.indices.length / 3) + "  instances " + inst.length + "  DrawScale " + sc.toFixed(3));
    console.log("     local size " + bb[1].map((v, a) => Math.round(v - bb[0][a])).join(" x ") +
      "   world size " + bb[1].map((v, a) => Math.round((v - bb[0][a]) * sc)).join(" x ") + " UU");
  }
}
