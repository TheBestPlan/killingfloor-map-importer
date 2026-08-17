// Reads a produced .rom back with the independent reader and checks the invariants that decide
// whether Killing Floor and KFEd will accept it. A converted map that fails these will not open.
"use strict";

const R = require("./unreal/read");

// Enough of a UTexture to answer "how big is it and how many mips did we store". Walks the tagged
// property block by size, so it does not need to understand any particular property.
const PROP_SIZE = { 0: 1, 1: 2, 2: 4, 3: 12, 4: 16 };
function readTextureHeader(pkg, exp) {
  const r = new R.Rd(pkg.buf, exp.serialOffset);
  let format = 0, usize = 0, vsize = 0;
  for (let guard = 0; guard < 64; guard++) {
    const name = pkg.names[r.cidx()];
    if (name === undefined || name === "None") break;
    const info = r.u8(), type = info & 0x0f, sizeCode = (info >> 4) & 0x07;
    if (type === 10) r.cidx();                      // struct name
    let size = PROP_SIZE[sizeCode];
    if (sizeCode === 5) size = r.u8();
    else if (sizeCode === 6) size = r.u16();
    else if (sizeCode === 7) size = r.u32();
    if ((info & 0x80) && type !== 3) r.u8();         // array index
    if (type === 3) continue;                        // bool: value rides in the info byte
    const at = r.pos;
    if (name === "Format") format = pkg.buf[at];
    else if (name === "USize") usize = pkg.buf.readInt32LE(at);
    else if (name === "VSize") vsize = pkg.buf.readInt32LE(at);
    r.pos = at + size;
  }
  return { format, usize, vsize, mips: r.cidx() };
}

function verify(file) {
  const lines = [];
  let ok = true;
  const check = (name, cond, detail) => {
    if (!cond) ok = false;
    lines.push("  " + (cond ? "ok  " : "FAIL") + " " + name + (detail ? "  (" + detail + ")" : ""));
  };

  let pkg;
  try { pkg = R.load(file); } catch (e) { return { ok: false, report: "  FAIL package parse: " + e.message }; }

  check("package tag / version", pkg.header.tag === 0x9e2a83c2 && pkg.header.fileVersion === 128 && pkg.header.licenseeVersion === 29,
    "0x" + pkg.header.tag.toString(16) + " v" + pkg.header.fileVersion + "/" + pkg.header.licenseeVersion);
  check("generation counts match tables",
    pkg.header.generations.length > 0 && pkg.header.generations[0].exportCount === pkg.exports.length &&
    pkg.header.generations[0].nameCount === pkg.names.length);

  // every export's serial range must sit inside the file and not overlap the tables
  let bad = 0, maxEnd = 0;
  for (const e of pkg.exports) {
    if (e.serialSize <= 0) continue;
    if (e.serialOffset < 64 || e.serialOffset + e.serialSize > pkg.buf.length) bad++;
    maxEnd = Math.max(maxEnd, e.serialOffset + e.serialSize);
  }
  check("export serial ranges inside file", bad === 0, bad + " bad");

  // object references must resolve
  let badRef = 0;
  for (const e of pkg.exports) {
    if (e.classIndex < 0 ? -e.classIndex - 1 >= pkg.imports.length : e.classIndex - 1 >= pkg.exports.length) badRef++;
  }
  for (const im of pkg.imports) if (im.packageIndex < 0 && -im.packageIndex - 1 >= pkg.imports.length) badRef++;
  check("class / outer references resolve", badRef === 0, badRef + " unresolved");

  // An export whose class is 0 IS "in range" - index 0 is the null reference - and it is fatal:
  // the engine binds the object as a UClass and dies on the first one it loads ("Assertion failed:
  // GIsEditor || GetSuperClass()"). It costs a whole test round to find that way, and one `refs`
  // entry misspelled or missing produces it, so it is checked here rather than in the client.
  let classless = 0, firstClassless = "";
  for (const e of pkg.exports) {
    if (e.classIndex !== 0) continue;
    classless++;
    if (!firstClassless) firstClassless = e.name;
  }
  check("every export names a class", classless === 0,
    classless ? classless + " with class None, first " + firstClassless : "0 with class None");

  const need = ["LevelInfo", "Level", "Model", "Polys", "Brush"];
  const present = new Set(pkg.exports.map((e) => pkg.classOf(e)));
  check("required object classes present", need.every((n) => present.has(n)), [...present].slice(0, 12).join(","));

  const exp = R.findWorldModel(pkg);
  check("world model found", !!exp, exp ? (exp.serialSize / 1024).toFixed(0) + " KB" : "none");
  if (!exp) return { ok: false, report: lines.join("\n") };

  let m;
  try { m = R.readModel(pkg, exp); } catch (e) { check("world model parses (exact serial size)", false, e.message); return { ok: false, report: lines.join("\n") }; }
  check("world model parses (exact serial size)", true,
    m.nodes.length + " nodes, " + m.surfs.length + " surfs, " + m.sections.length + " sections, " + m.lightMaps.length + " lightmaps");

  // Non-finite floats anywhere in the geometry corrupt the renderer rather than failing cleanly.
  const finite3 = (v) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
  let nan = 0, huge = 0;
  const LIMIT = 1e7;
  for (const p of m.points) { if (!finite3(p)) nan++; else if (Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])) > LIMIT) huge++; }
  for (const v of m.vectors) { if (!finite3(v)) nan++; else if (Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])) > LIMIT) huge++; }
  for (const n of m.nodes) { if (!finite3(n.plane) || !Number.isFinite(n.plane[3]) || !Number.isFinite(n.sphere.radius) || !finite3(n.sphere.center)) nan++; }
  for (const s of m.surfs) { if (!finite3(s.plane) || !Number.isFinite(s.plane[3]) || !Number.isFinite(s.lightMapScale)) nan++; }
  for (const sec of m.sections) for (const v of sec.vertices) {
    if (!finite3(v.pos) || !finite3(v.normal) || !Number.isFinite(v.u) || !Number.isFinite(v.v) || !Number.isFinite(v.u2) || !Number.isFinite(v.v2)) nan++;
  }
  check("no NaN / Inf in geometry", nan === 0, nan + " non-finite");
  check("coordinates within sane range", huge === 0, huge + " beyond +-1e7");

  // index ranges the renderer dereferences without checking
  let refBad = 0;
  for (const s of m.surfs) {
    if (s.pBase < 0 || s.pBase >= m.points.length) refBad++;
    for (const vi of [s.vNormal, s.vTextureU, s.vTextureV]) if (vi < 0 || vi >= m.vectors.length) refBad++;
  }
  for (const v of m.verts) if (v.pVertex < 0 || v.pVertex >= m.points.length) refBad++;
  for (const n of m.nodes) {
    for (const l of n.iLeaf) if (l >= m.leaves.length) refBad++;
    for (const z of n.iZone) if (z >= m.zones.length) refBad++;
    if (n.iBack >= m.nodes.length || n.iFront >= m.nodes.length || n.iPlane >= m.nodes.length) refBad++;
    if (n.iSurf >= m.surfs.length) refBad++;
  }
  for (const l of m.leaves) if (l.iZone >= m.zones.length) refBad++;
  for (const sec of m.sections) if (sec.iLightMapTexture >= m.lightMapTextures.length) refBad++;
  check("every structural index resolves", refBad === 0, refBad + " out of range");

  // geometry sanity: node planes are unit length and their polygons lie on them
  let unit = 0, onPlane = 0, poly = 0, idxBad = 0;
  for (const n of m.nodes) {
    if (Math.abs(Math.hypot(n.plane[0], n.plane[1], n.plane[2]) - 1) < 1e-3) unit++;
    if (n.iSurf < 0 || n.iSurf >= m.surfs.length) idxBad++;
    if (n.numVertices < 3) continue;
    poly++;
    let good = true;
    for (let i = 0; i < n.numVertices; i++) {
      const fv = m.verts[n.iVertPool + i];
      if (!fv || fv.pVertex < 0 || fv.pVertex >= m.points.length) { idxBad++; good = false; break; }
      const p = m.points[fv.pVertex];
      if (Math.abs(p[0] * n.plane[0] + p[1] * n.plane[1] + p[2] * n.plane[2] - n.plane[3]) > 1.0) good = false;
    }
    if (good) onPlane++;
  }
  check("node planes are unit vectors", unit === m.nodes.length, unit + "/" + m.nodes.length);
  if (poly > 0) check("polygon vertices lie on their node plane", onPlane === poly, onPlane + "/" + poly);
  check("node/vertex indices in range", idxBad === 0, idxBad + " out of range");

  // right-handed Newell normal must equal the plane normal (the UE2.5 convention)
  let wind = 0;
  for (const n of m.nodes) {
    if (n.numVertices < 3) continue;
    let nx = 0, ny = 0, nz = 0;
    const ring = [];
    for (let i = 0; i < n.numVertices; i++) ring.push(m.points[m.verts[n.iVertPool + i].pVertex]);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    if ((nx * n.plane[0] + ny * n.plane[1] + nz * n.plane[2]) / l > 0.9) wind++;
  }
  if (poly > 0) check("polygon winding matches UE2.5 convention", wind === poly, wind + "/" + poly);

  // section / lightmap wiring
  let secBad = 0, lmBad = 0, uvOut = 0;
  for (const n of m.nodes) {
    if (n.numVertices < 3) continue;
    if (n.iSection < 0 || n.iSection >= m.sections.length) { secBad++; continue; }
    const sec = m.sections[n.iSection];
    if (n.iFirstVertex + n.numVertices > sec.vertices.length) { secBad++; continue; }
    const v = sec.vertices[n.iFirstVertex];
    const p = m.points[m.verts[n.iVertPool].pVertex];
    if (Math.hypot(v.pos[0] - p[0], v.pos[1] - p[1], v.pos[2] - p[2]) > 0.5) secBad++;
    if (n.iLightMap >= 0) {
      if (n.iLightMap >= m.lightMaps.length) lmBad++;
      else for (let i = 0; i < n.numVertices; i++) {
        const sv = sec.vertices[n.iFirstVertex + i];
        if (sv.u2 < -0.001 || sv.u2 > 1.001 || sv.v2 < -0.001 || sv.v2 > 1.001) { uvOut++; break; }
      }
    }
  }
  check("sections mirror node polygons", secBad === 0, secBad + " mismatched");

  // The two invariants that made the engine trash its heap and die in RenderLevel. The renderer
  // follows iSection and iLightMap without checking NumVertices or for -1, so an index of -1 (or
  // any index into an empty array) is a wild read.
  let secNeg = 0, lmNeg = 0;
  for (const n of m.nodes) {
    if (m.sections.length && (n.iSection < 0 || n.iSection >= m.sections.length)) secNeg++;
    if (n.numVertices >= 3 && m.lightMaps.length && (n.iLightMap < 0 || n.iLightMap >= m.lightMaps.length)) lmNeg++;
  }
  check("every node has a valid iSection (split-only nodes too)", secNeg === 0, secNeg + " with -1");
  check("every drawable node has a valid iLightMap", lmNeg === 0, lmNeg + " with -1");
  check("lightmap indices in range", lmBad === 0, lmBad + " bad");
  check("lightmap UVs inside the atlas", uvOut === 0, uvOut + " nodes outside 0..1");

  let atlasBad = 0;
  for (const t of m.lightMapTextures) {
    const blocks = (t.width / 4) * (t.height / 4);
    if (t.format !== 7 || t.mips[0].length !== blocks * 16 || t.mips[1].length !== blocks * 4) atlasBad++;
  }
  check("lightmap atlases are well-formed DXT3", atlasBad === 0,
    m.lightMapTextures.length + " atlas(es) " + m.lightMapTextures.map((t) => t.width + "x" + t.height).join(","));

  // Tree shape: the renderer walks iFront/iBack/iPlane recursively. A node reachable twice means a
  // shared subtree or a cycle, and the walk never terminates.
  {
    const seen = new Int32Array(m.nodes.length);
    let twice = 0, cycles = 0, maxDepth = 0;
    const stack = [];
    const walk = (i, depth) => {
      if (i < 0 || i >= m.nodes.length) return;
      if (stack.includes(i)) { cycles++; return; }
      if (seen[i]++) { twice++; return; }
      if (depth > maxDepth) maxDepth = depth;
      if (depth > 4000) { cycles++; return; }
      stack.push(i);
      const n = m.nodes[i];
      walk(n.iFront, depth + 1); walk(n.iBack, depth + 1); walk(n.iPlane, depth + 1);
      stack.pop();
    };
    walk(0, 0);
    const unreached = [...seen].filter((v) => v === 0).length;
    check("BSP tree is a tree (no node reached twice)", twice === 0 && cycles === 0,
      twice + " reached twice, " + cycles + " cycles, depth " + maxDepth);
    check("every node reachable from the root", unreached === 0, unreached + " unreachable of " + m.nodes.length);
  }

  // Collision hulls: a point just inside the solid (behind the polygon) must score <= 0 against
  // every plane of that node's hull. This is the same test the shipped maps pass.
  let hullNodes = 0, hullOk = 0, hullMissing = 0;
  for (let i = 0; i < m.nodes.length; i++) {
    const n = m.nodes[i];
    if (n.numVertices < 3) continue;
    if (n.iCollisionBound < 0) { hullMissing++; continue; }
    hullNodes++;
    let c = [0, 0, 0];
    for (let k = 0; k < n.numVertices; k++) {
      const p = m.points[m.verts[n.iVertPool + k].pVertex];
      c = [c[0] + p[0] / n.numVertices, c[1] + p[1] / n.numVertices, c[2] + p[2] / n.numVertices];
    }
    // Probe just under the surface: the hull describes the convex cell behind the face, and that
    // cell can be thinner than a few units on slivers and thin brushes.
    const inside = [c[0] - n.plane[0] * 0.25, c[1] - n.plane[1] * 0.25, c[2] - n.plane[2] * 0.25];
    let good = true;
    for (let k = n.iCollisionBound; k < m.leafHulls.length; k++) {
      const v = m.leafHulls[k];
      if (v === -1) break;
      const nd = m.nodes[v & ~0x40000000];
      if (!nd) { good = false; break; }
      const s = (v & 0x40000000) ? -1 : 1;
      const d = (inside[0] * nd.plane[0] + inside[1] * nd.plane[1] + inside[2] * nd.plane[2] - nd.plane[3]) * s;
      if (d > 0.5) { good = false; break; }
    }
    if (good) hullOk++;
  }
  if (hullNodes > 0) check("collision hulls enclose the solid side", hullOk === hullNodes,
    hullOk + "/" + hullNodes + " nodes" + (hullMissing ? ", " + hullMissing + " without a hull" : ""));

  const leafBad = m.leaves.length === 0 && m.nodes.length > 0;
  check("leaves present", !leafBad, m.leaves.length + " leaves, " + m.zones.length + " zones");

  // A texture must carry EVERY mip down to 1x1. The engine derives the level count from
  // USize/VSize, not from the array, so a short chain makes it index past the end and sample
  // uninitialized memory - the whole world drawn white for a frame. See ../docs/GOTCHAS.md 5.33.
  {
    let checked = 0, short_ = 0, first = "";
    for (const e of pkg.exports) {
      if (pkg.classOf(e) !== "Texture" || !e.serialSize) continue;
      let t;
      try { t = readTextureHeader(pkg, e); } catch (err) { continue; }
      if (!t.usize || !t.vsize) continue;
      checked++;
      const want = Math.log2(Math.max(t.usize, t.vsize)) + 1;
      if (t.mips !== want) { short_++; if (!first) first = e.name + " " + t.usize + "x" + t.vsize + " has " + t.mips + " of " + want; }
    }
    check("every texture has a full mip chain", short_ === 0,
      checked + " textures" + (short_ ? ", " + short_ + " short: " + first : ""));
  }

  // Every actor's tagged property block must terminate, and so must every block nested in a struct.
  //
  // The engine reads properties until the name "None", not until the declared size runs out, so a
  // block that forgets its terminator - including the one INSIDE a struct value - reads on into the
  // next object and the load dies with "Serial size mismatch: Got 124, Expected 123". The game
  // never noticed, because the object that had it was RF_NotForClient and only KFEd ever read it.
  //
  // The walk covers the property types this writer emits. Shipped maps trip it on content we never
  // produce (a TerrainInfo's native data, an actor left with bDeleteMe), so it is an invariant for
  // our own output, not a general reader.
  {
    const RF_HAS_STACK = 0x02000000;
    const SIZE = [1, 2, 4, 12, 16, 0, 0, 0];
    // Structs the engine serializes as raw bytes instead of a tagged block. Everything else - a
    // PointRegion, a Scale - carries properties of its own and must terminate like any block.
    const RAW = new Set(["Vector", "Rotator", "Color", "Plane", "Quat", "Matrix", "Guid", "Box"]);

    // Walks a tagged block and returns the offset just past its None, or -1 if it never found one.
    const walkBlock = (start, end) => {
      const r = new R.Rd(pkg.buf, start);
      for (;;) {
        if (r.pos >= end) return -1;
        if (pkg.names[r.cidx()] === "None") return r.pos;
        const info = pkg.buf[r.pos++];
        const type = info & 0x0f, sizeCode = (info >> 4) & 0x07;
        const structName = type === 10 ? pkg.names[r.cidx()] : null;
        // A Bool carries its value in the tag's high bit and occupies no bytes of its own.
        let size = type === 3 ? 0 : SIZE[sizeCode];
        if (sizeCode === 5) size = pkg.buf[r.pos++];
        else if (sizeCode === 6) { size = pkg.buf.readUInt16LE(r.pos); r.pos += 2; }
        else if (sizeCode === 7) { size = pkg.buf.readUInt32LE(r.pos); r.pos += 4; }
        if ((info & 0x80) !== 0 && type !== 3) r.pos++;
        if (type === 10 && !RAW.has(structName) && walkBlock(r.pos, r.pos + size) !== r.pos + size) return -1;
        r.pos += size;
        if (r.pos > end) return -1;
      }
    };

    let walked = 0, mismatched = 0, first = "";
    for (const e of pkg.exports) {
      if (!(e.objectFlags & RF_HAS_STACK) || !e.serialSize) continue;   // actors always carry properties
      const end = e.serialOffset + e.serialSize;
      const r = new R.Rd(pkg.buf, e.serialOffset);
      let where;
      try {
        const node = r.cidx(); r.cidx(); r.skip(12);
        if (node !== 0) r.cidx();
        where = walkBlock(r.pos, end);
      } catch (err) { where = -1; }
      walked++;
      // Terminating inside the object is the invariant, not terminating exactly at its end: a few
      // engine classes (TerrainInfo) write native data after their properties, and shipped maps
      // rely on that. Never finding the None, or finding it past the object, is the fault.
      if (where < 0 || where > end) {
        mismatched++;
        if (!first) first = e.name + " (" + e.serialSize + " bytes)";
      }
    }
    check("actor property blocks terminate inside the object", mismatched === 0,
      walked + " actors" + (mismatched ? ", " + mismatched + " broken: " + first : ""));

    // A spawn below KillZ kills the player the moment the level starts.
    //
    // The engine drops any actor under `LevelInfo.KillZ`, and the converter sets it from the floor of
    // the world box - so a level whose box was drawn round the wrong thing spawns the player straight
    // into it. On 20_21 the box was sized around the heightfield and the only spawn is in a dungeon
    // 2900 units below its floor: "Elapsed Time: 00:01" and a corpse. Nothing else catches this - the
    // file is structurally perfect.
    const scalar = (exp, want) => {
      const end = exp.serialOffset + exp.serialSize;
      const r = new R.Rd(pkg.buf, exp.serialOffset);
      const node = r.cidx(); r.cidx(); r.skip(12);
      if (node !== 0) r.cidx();
      for (;;) {
        if (r.pos >= end) return null;
        const name = pkg.names[r.cidx()];
        if (name === "None" || name === undefined) return null;
        const info = pkg.buf[r.pos++];
        const type = info & 0x0f, sizeCode = (info >> 4) & 0x07;
        if (type === 10) r.cidx();
        let size = type === 3 ? 0 : SIZE[sizeCode];
        if (sizeCode === 5) size = pkg.buf[r.pos++];
        else if (sizeCode === 6) { size = pkg.buf.readUInt16LE(r.pos); r.pos += 2; }
        else if (sizeCode === 7) { size = pkg.buf.readUInt32LE(r.pos); r.pos += 4; }
        if ((info & 0x80) !== 0 && type !== 3) r.pos++;
        if (name === want) return { type, at: r.pos, size };
        r.pos += size;
      }
    };
    let killZ = null;
    for (const e of pkg.exports) {
      if (pkg.classOf(e) !== "LevelInfo" || !e.serialSize) continue;
      const t = scalar(e, "KillZ");
      if (t && t.type === 4) killZ = pkg.buf.readFloatLE(t.at);
      break;
    }
    if (killZ !== null) {
      let starts = 0, doomed = 0, lowest = Infinity;
      for (const e of pkg.exports) {
        if (pkg.classOf(e) !== "PlayerStart" || !e.serialSize) continue;
        const t = scalar(e, "Location");
        if (!t || t.size < 12) continue;
        starts++;
        const z = pkg.buf.readFloatLE(t.at + 8);
        if (z < lowest) lowest = z;
        if (z <= killZ) doomed++;
      }
      check("every spawn is above KillZ", doomed === 0,
        starts + " start(s), lowest at " + Math.round(lowest) + ", KillZ " + Math.round(killZ) +
        (doomed ? ", " + doomed + " below it" : ""));
    }
  }

  return { ok, report: lines.join("\n"), model: m, pkg };
}

module.exports = { verify };
