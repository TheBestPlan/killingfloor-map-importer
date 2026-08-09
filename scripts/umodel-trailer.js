// Full UE2.5 (v128) UModel reader — including the trailer that carries the baked BSP lighting.
// Order (UT2004-era UModel::Serialize, Ver>=110 path):
//   Vectors, Points, Nodes, Surfs, Verts, NumSharedSides, NumZones, Zones[NumZones], Polys,
//   Bounds, LeafHulls, Leaves, Lights, RootOutside, Linked, Sections, LightMaps, LightMapTextures
// Oracle: the walk must land exactly on serialOffset+serialSize. Run over every map to validate.
const fs = require("fs");
const path = require("path");
const KFRom = require("./_kfrom");

function Rd(u8, pos) {
  this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.pos = pos;
}
Rd.prototype.byte = function () { return this.u8[this.pos++]; };
Rd.prototype.i32 = function () { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; };
Rd.prototype.f32 = function () { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; };
Rd.prototype.skip = function (n) { this.pos += n; };
Rd.prototype.cidx = function () {
  let b = this.u8[this.pos++]; const neg = (b & 0x80) !== 0; let val = b & 0x3f;
  if (b & 0x40) { let sh = 6; for (; ;) { b = this.u8[this.pos++]; val |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; } }
  return neg ? -val : val;
};

function readModelFull(pkg, exp) {
  const r = new Rd(pkg.u8, exp.serialOffset);
  const end = exp.serialOffset + exp.serialSize;
  const bad = (why) => { throw new Error(why + " @" + r.pos + " (end " + end + ")"); };
  const count = (what, max) => { const n = r.cidx(); if (n < 0 || n > max) bad(what + " count " + n); return n; };

  r.skip(1 + 25 + 16);                                  // props "None" + FBox + FSphere
  const nVectors = count("Vectors", 1 << 22); r.skip(nVectors * 12);
  const nPoints = count("Points", 1 << 22); r.skip(nPoints * 12);
  const nNodes = count("Nodes", 1 << 22);
  for (let i = 0; i < nNodes; i++) { r.skip(16 + 8 + 1); for (let k = 0; k < 7; k++) r.cidx(); r.skip(16 + 2 + 1 + 8 + 12); }
  const nSurfs = count("Surfs", 1 << 22);
  for (let i = 0; i < nSurfs; i++) { r.cidx(); r.skip(4); for (let k = 0; k < 6; k++) r.cidx(); r.skip(16 + 4); }
  const nVerts = count("Verts", 1 << 23);
  for (let i = 0; i < nVerts; i++) { r.cidx(); r.cidx(); }

  const geomEnd = r.pos;
  const NumSharedSides = r.i32();
  const NumZones = r.i32();
  if (NumZones < 0 || NumZones > 64) bad("NumZones " + NumZones);
  const zones = [];
  for (let i = 0; i < NumZones; i++) {
    const zoneActor = r.cidx();
    const conn = [r.i32(), r.i32()], vis = [r.i32(), r.i32()];
    const lastRender = r.f32();
    zones.push({ zoneActor, conn, vis, lastRender });
  }
  const polys = r.cidx();
  const nBounds = count("Bounds", 1 << 22); r.skip(nBounds * 25);
  const nLeafHulls = count("LeafHulls", 1 << 24); r.skip(nLeafHulls * 4);
  const nLeaves = count("Leaves", 1 << 22);
  for (let i = 0; i < nLeaves; i++) { r.cidx(); r.cidx(); r.cidx(); r.skip(8); }
  const nLights = count("Lights", 1 << 20);
  for (let i = 0; i < nLights; i++) r.cidx();
  const rootOutside = r.i32(), linked = r.i32();

  // Sections: TArray<FBspSection>; FBspSection = FBspVertexStream + Material ref + NumNodes + PolyFlags + iLightMapTexture
  const nSections = count("Sections", 1 << 20);
  let sectionVerts = 0;
  for (let i = 0; i < nSections; i++) {
    const nv = count("Section.Vertices", 1 << 23);
    r.skip(nv * 40);                                    // FBspVertex: Pos(12) U,V(8) U2,V2(8) Normal(12)
    r.i32();                                            // Revision
    sectionVerts += nv;
    r.cidx();                                           // Material
    r.i32(); r.i32(); r.i32();                          // NumNodes, PolyFlags, iLightMapTexture
  }

  // LightMaps: TArray<FLightMap>
  const nLightMaps = count("LightMaps", 1 << 22);
  let bitmapBytes = 0, bitmapCount = 0;
  for (let i = 0; i < nLightMaps; i++) {
    for (let k = 0; k < 7; k++) r.cidx();               // iTexture,iSurf,iZone,OffsetX,OffsetY,SizeX,SizeY
    r.skip(64);                                         // FMatrix WorldToLightMap
    r.skip(36);                                         // LightMapBase, LightMapX, LightMapY
    const nb = count("LightMap.Bitmaps", 1 << 16);
    for (let b = 0; b < nb; b++) {
      r.cidx();                                         // LightActor
      const nbits = count("Bitmap.Bits", 1 << 26); r.skip(nbits);
      r.skip(4 * 3);                                    // SizeX, SizeY, Stride
      r.skip(4 * 4);                                    // MinX, MinY, MaxX, MaxY
      bitmapBytes += nbits; bitmapCount++;
    }
    r.cidx();                                           // Level
    r.i32();                                            // Revision
  }

  // LightMapTextures: TArray<FLightMapTexture>
  const nLMTex = count("LightMapTextures", 1 << 16);
  let atlasBytes = 0;
  const atlases = [];
  for (let i = 0; i < nLMTex; i++) {
    r.cidx();                                           // Level
    const nl = count("LMTex.LightMaps", 1 << 22); r.skip(nl * 4);
    r.skip(8);                                          // CacheId (QWORD)
    r.i32();                                            // Revision
    // FStaticLightMapTexture: TLazyArray<BYTE> Data[0], Data[1], BYTE Format, INT Width, Height, Revision
    const mips = [];
    for (let m = 0; m < 2; m++) {
      r.i32();                                          // lazy-array skip offset
      const n = count("LMTex.Data", 1 << 26); r.skip(n); mips.push(n); atlasBytes += n;
    }
    const fmt = r.byte(), w = r.i32(), h = r.i32(); r.i32();
    atlases.push({ fmt, w, h, mips });
  }

  return {
    ok: r.pos === end, pos: r.pos, end, geomBytes: geomEnd - exp.serialOffset, trailerBytes: end - geomEnd,
    nVectors, nPoints, nNodes, nSurfs, nVerts, NumSharedSides, NumZones, polys,
    nBounds, nLeafHulls, nLeaves, nLights, rootOutside, linked, nSections, sectionVerts,
    nLightMaps, bitmapCount, bitmapBytes, nLMTex, atlasBytes, atlases,
  };
}

const targets = [];
for (const a of process.argv.slice(2)) {
  if (fs.statSync(a).isDirectory()) for (const f of fs.readdirSync(a)) { if (f.toLowerCase().endsWith(".rom")) targets.push(path.join(a, f)); }
  else targets.push(a);
}
let ok = 0, fail = 0;
const fails = [];
for (const file of targets) {
  let res, err = null;
  try {
    const u8 = new Uint8Array(fs.readFileSync(file));
    const pkg = KFRom.parsePackage(u8);
    const exp = KFRom.findWorldModel(pkg);
    if (!exp) continue;
    res = readModelFull(pkg, exp);
  } catch (e) { err = e.message; }
  if (err || !res.ok) { fail++; fails.push(path.basename(file) + "  " + (err || ("off by " + (res.pos - res.end)))); continue; }
  ok++;
  if (targets.length <= 6) {
    const fmtName = { 0: "P8", 3: "DXT1", 4: "RGB8", 5: "RGBA8", 7: "DXT3", 8: "DXT5" };
    console.log("=== " + path.basename(file) + "  EXACT FIT");
    console.log("  geom " + (res.geomBytes / 1024).toFixed(0) + " KB   trailer " + (res.trailerBytes / 1024).toFixed(0) + " KB");
    console.log("  nodes " + res.nNodes + " surfs " + res.nSurfs + " verts " + res.nVerts +
      "  zones " + res.NumZones + "  bounds " + res.nBounds + "  leafHulls " + res.nLeafHulls +
      "  leaves " + res.nLeaves + "  lights " + res.nLights);
    console.log("  sections " + res.nSections + " (" + res.sectionVerts + " render verts)");
    console.log("  LightMaps " + res.nLightMaps + "  shadow bitmaps " + res.bitmapCount + " (" + (res.bitmapBytes / 1024).toFixed(0) + " KB)");
    console.log("  LightMapTextures " + res.nLMTex + " (" + (res.atlasBytes / 1024).toFixed(0) + " KB): " +
      res.atlases.slice(0, 4).map((a) => (fmtName[a.fmt] || a.fmt) + " " + a.w + "x" + a.h).join(", ") + (res.nLMTex > 4 ? ", ..." : ""));
  }
}
console.log("\nEXACT FIT: " + ok + "/" + (ok + fail) + " maps");
for (const f of fails.slice(0, 15)) console.log("  FAIL " + f);
