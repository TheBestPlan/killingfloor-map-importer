// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GTA III / Vice City map -> Killing Floor .rom. The map is a set of instances (.ipl) of RenderWare
// models (.dff, in the game's IMG archive) named by item definitions (.ide). This reads every
// instance, decodes each referenced model once, transforms its geometry by the instance's
// position / scale / rotation, and hands the world triangles to the glTF route's builder - the same
// KF skeleton, auto-colour, spawn-drop and verify path the model and Source routes use. GTA is Z-up
// and metre-scaled, so it feeds axes [0,1,2] with a Y flip.
//
// A whole GTA city is millions of triangles across kilometres - far too big for one KF map. Three ways
// to size it down:
//   - default: one walkable district (the densest 100 m grid cell), half a set radius.
//   - --crop cx,cy,half / --whole: a named area, or the entire city.
//   - --tile <m>: split the WHOLE map into <m>-metre squares and write one .rom per populated square
//     (KF-GTA3-01, KF-GTA3-02, ...). Each instance is placed WHOLE into the square its origin falls in
//     (models are never cut mid-mesh), and a small overlap margin pulls in the neighbouring context so a
//     lamp keeps the wall behind it and a building keeps its base - no floating meshes at the seam.
"use strict";

const fs = require("fs");
const path = require("path");
const { Img } = require("./img");
const { readDff } = require("./dff");
const { readTxd, readTxdNames } = require("./txd");
const { readIde, readIpl, findDataFiles, readZones, zoneNameAt } = require("./placement");
const { parseWater, openWater } = require("./water");
const gltf = require("../gltf/convert");

// A small raster of one RGB colour (glass tint). Giving glass/water their own image keeps auto-colour off
// them (only imageless materials are geometry-painted) and gives the translucent Shader a Diffuse to tint by.
const solidRgb = (r, g, b) => { const buf = Buffer.alloc(4 * 4 * 3); for (let i = 0; i < 16; i++) { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b; } return buf; };

// A 64x64 tileable water surface: a teal base broken up by two crossed sine ripples and a little value noise,
// so the sea reads as moving water rather than a flat blue slab. GTA III's water is a shader/vertex effect
// with no plain raster to lift, so this is a stand-in that at least gives the surface texture and depth.
const WATER_TEX = (() => {
  const n = 64, buf = Buffer.alloc(n * n * 3);
  const base = [38, 86, 118];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const ripple = Math.sin((x / n) * Math.PI * 4 + (y / n) * Math.PI * 2) * 0.5 + Math.sin((y / n) * Math.PI * 6 - (x / n) * Math.PI * 3) * 0.5;
    const noise = (((x * 73 + y * 151) % 17) / 17 - 0.5);
    const s = 1 + ripple * 0.22 + noise * 0.12;
    const o = (y * n + x) * 3;
    buf[o] = Math.max(0, Math.min(255, base[0] * s));
    buf[o + 1] = Math.max(0, Math.min(255, base[1] * s));
    buf[o + 2] = Math.max(0, Math.min(255, base[2] * s + ripple * 10));
  }
  return { width: n, height: n, rgb: buf };
})();
// GTA metres a water volume reaches below its surface. Kept shallow on purpose: the water.dat rectangles are
// the game's global sea plane and blanket the land too (25 of 41 tiles are >60% covered), so a deep box would
// flood anything below sea level - most of the subway (origin ~ -11.5) sits inside a water rect. 6 m lets the
// player wade/swim at the surface (their centre must drop below Z=0 to count as in-water) without reaching the
// tunnels. Fixed depth, not the real per-body sea bed - a deep dive falls through to the floor below it.
const WATER_DEPTH = 6;
const WATER_CELL = 8;         // metres: grid cell for the ground-height field and open-water sampling
const WATER_OPEN_DROP = 4;    // metres the floor must sit below the surface to count as open water (shores/crests stay dry)

// GTA metres -> KF units, by character parity (same principle as Lineage2's 100/46 and CS): the GTA player
// ped mesh is 1.665 m tall (player.dff bbox Z; other peds 1.63-1.71) and KFHumanPawn is 100 uu, so
// 100 / 1.665 = 60.06 stands the KF pawn in the world at a real ped's height. The earlier 40 left the pawn
// oversized against the world. --scale overrides.
const SCALE = 60.06;
const TILE_METERS = 400;      // default --tile square size: a ~400 m block matches the old default district (~160k tris), which stays whole without decimation
const TILE_OVERLAP_FRAC = 0.12; // how far past the square edge to pull neighbouring instances, so seam objects keep their context
const MIN_TILE_INSTANCES = 12;  // a square with fewer instance origins than this is open water / empty - skip it
const TILE_MAX_TEXTURE = 256;   // tiles carry the whole area's textures; 256 keeps each .rom light and quick to load (like the de_dust2 fix)
const TILE_HEAVY_TRIS = 800000; // a doubled tile past this loads slowly in KF - warn and suggest a smaller square
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const applyMat4 = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const applyMat3 = (m, n) => [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];

// Rotate a vector by a quaternion (x,y,z,w). GTA IPL quaternions place the instance.
function quatRotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

function findImg(root) {
  for (const rel of ["models/gta3.img", "models/gta_int.img"]) {
    const p = path.join(root, rel);
    if (fs.existsSync(p) && fs.existsSync(p.replace(/\.img$/i, ".dir"))) return p;
  }
  throw new Error("no models/gta3.img (+ .dir) under " + root);
}

// Parse the game data once and hand back the instance list plus a scene builder. buildScene(subset) turns
// any subset of instances into a KF scene with its OWN material registry (so a tile's .rom carries only the
// textures it uses); the decoded-model and txd caches are shared across every call.
function loadGtaCommon(root, log) {
  const img = new Img(findImg(root));
  const files = findDataFiles(root);
  const idToModel = readIde(files.ide);
  const allInstances = readIpl(files.ipl);
  // Drop big-building / LOD stand-ins (draw distance > 300 = re3's LOD_DISTANCE). GTA draws these only at
  // range, with the detailed model in their place up close; in a static close-range KF export they instead
  // OVERLAP the real geometry as crude low-detail stand-ins - glowing-window LOD blocks over the real
  // building, flat 2D tree cards over the real trees, the distant-island skyline block. The name-prefix
  // "lod" filter in readIpl catches most; this catches the rest (islandlod*, *_vlo, unprefixed big builds).
  const LOD_DRAWDIST = 300;
  const instances = allInstances.filter((i) => { const d = idToModel.get(i.id); return !d || !(d.drawDist > LOD_DRAWDIST); });
  log("gta: " + img.entries.size + " archived files, " + idToModel.size + " item definitions, " + instances.length + " instances (" + (allInstances.length - instances.length) + " LOD/big-building dropped)");

  const dffCache = new Map();       // model name -> decoded geometries (or null on failure)
  const getModel = (name) => {
    if (dffCache.has(name)) return dffCache.get(name);
    let geos = null;
    const data = img.read(name, "dff");
    if (data) { try { geos = readDff(data).geometries; } catch (e) { geos = null; } }
    dffCache.set(name, geos);
    return geos;
  };

  // Bounding radius of an instance's model from its own origin, in GTA metres (max vertex distance times
  // the instance's largest scale). Rotation-invariant, so a yaw'd piece needs no re-measure. Tiling uses it
  // to include an instance in every square its GEOMETRY reaches, not just the one its origin lands in - a
  // 120 m road slab or terrain sheet centred one tile over still floors the neighbour, so decorations no
  // longer hang over a hole where the ground's origin fell outside the square.
  const radiusCache = new Map();
  const radiusOf = (inst) => {
    const def = idToModel.get(inst.id); const name = def ? def.model : inst.model;
    let r = radiusCache.get(name);
    if (r === undefined) {
      // HORIZONTAL radius only. Tile membership is an XY test: measuring Z too gave a 200 m skyscraper a
      // 200 m "radius", dragging towers from far past the tile border in - while their low road/ground
      // slabs (true 25 m reach) stayed out. The result was buildings hovering over void at every tile edge.
      const geos = getModel(name); r = 0;
      if (geos) for (const g of geos) { if (!g.verts) continue; for (let i = 0; i < g.verts.length; i += 3) { const d2 = g.verts[i] * g.verts[i] + g.verts[i + 1] * g.verts[i + 1]; if (d2 > r) r = d2; } }
      r = Math.sqrt(r);
      radiusCache.set(name, r);
    }
    return r * Math.max(Math.abs(inst.scale[0]), Math.abs(inst.scale[1]), Math.abs(inst.scale[2]));
  };

  // FLAT models - road slabs, pavements, ground sheets (physically thin) - get extra reach across the tile
  // border. Buildings whose origin sits just inside a tile poke well past it, and if the neighbouring road
  // stopped at its own footprint the street ended mid-block: a hole in the road with intact buildings around
  // it. Ground reaching ~45 m further than anything tall keeps every kept building standing on pavement, and
  // the tile edge reads "city block ends at the street", not "road torn off".
  // Border reach past the tile square. EVERY instance gets APRON_ALL: a model whose bounding circle just
  // misses the square is often the one carrying the ground under its neighbours (archedbuilding is the
  // cathedral plaza - it missed by 3 m and left a plaza-sized void with the buildings around it intact).
  // Ground models get FLAT_EXTRA on top, so the floor always reaches further than anything standing on it.
  const APRON_ALL = 130;
  const FLAT_EXTRA = 120;
  const flatCache = new Map();
  const isFlat = (inst) => {
    const def = idToModel.get(inst.id); const name = def ? def.model : inst.model;
    let f = flatCache.get(name);
    if (f === undefined) {
      const geos = getModel(name); let lo = Infinity, hi = -Infinity;
      if (geos) for (const g of geos) { if (!g.verts) continue; for (let i = 2; i < g.verts.length; i += 3) { const z = g.verts[i]; if (z < lo) lo = z; if (z > hi) hi = z; } }
      // Ground is judged by PROPORTION, not absolute thinness: a com_land terrain sheet undulates 3-10 m
      // over a 100+ m footprint and is still ground (a hard 3 m cutoff left park squares out of the border
      // apron - benches floating on air), while a 15 m-tall building on a 15 m footprint is not.
      f = geos ? (hi - lo) < Math.max(3, radiusOf(inst) * 0.3) : false;
      flatCache.set(name, f);
    }
    return f;
  };
  const reachOf = (inst) => radiusOf(inst) + APRON_ALL + (isFlat(inst) ? FLAT_EXTRA : 0);

  // Textures: each model names a .txd in its .ide; the .dff materials name a raster inside it.
  const txdCache = new Map();
  const getTxd = (name) => { if (txdCache.has(name)) return txdCache.get(name); let m = null; const data = name && img.read(name, "txd"); if (data) { try { m = readTxd(data); } catch (e) { } } txdCache.set(name, m); return m; };
  // Parent-chain fallback: a model's raster often lives in a shared txd (vegetation, generic), not the
  // model's own. Index every referenced txd's names once (headers only, no decode) so a miss resolves.
  let globalIdx = null;
  const findTxdFor = (texName) => {
    if (!globalIdx) {
      globalIdx = new Map(); const seen = new Set();
      for (const def of idToModel.values()) {
        if (!def.txd || seen.has(def.txd)) continue; seen.add(def.txd);
        const data = img.read(def.txd, "txd"); if (!data) continue;
        try { for (const nm of readTxdNames(data)) if (!globalIdx.has(nm)) globalIdx.set(nm, def.txd); } catch (e) { }
      }
    }
    return globalIdx.get(texName);
  };

  const waterRects = parseWater(root);

  // buildScene(subset, bounds) turns an instance subset into a KF scene. `bounds` (GTA world x0,y0,x1,y1),
  // when given, fills the sea: every water.dat rectangle is clipped to it and laid as a flat quad, so a tile
  // that opens onto water gets a surface instead of a void.
  const buildScene = (subset, bounds) => {
    // One KF material per resolved raster (material 0 is the flat fallback for untextured / unresolved).
    const materials = [{ name: "untextured", imageIndex: null, alphaMode: "OPAQUE", factor: [0.55, 0.55, 0.55, 1] }];
    const texList = [null];            // texList[i] is the image for materials[i]
    const texKey = new Map();
    const resolveTexMat = (txdName, mat, glassModel) => {
      const texName = mat && mat.tex;
      // Glass: either a glassfx* panel (GTA's breakable glass - the model IS glass; its material carries the
      // tint colour, e.g. cyan 49,223,255, at an opaque in-file alpha) or an untextured material that is
      // itself semi-transparent (mansion/bridge glass, alpha < 245). Both get a translucent material of that
      // colour instead of dropping to the grey auto-colour fallback, which is why the showroom read as flat
      // grey. glassfx panels are forced to a see-through alpha; a material that already carries one keeps it.
      if (!texName && mat && mat.rgba && (mat.rgba[3] < 245 || glassModel)) {
        // Halve the tint and keep the pane fairly clear: the Shader's OB_Translucent ADDS the diffuse over
        // whatever is behind, so a bright cyan at a high alpha reads as a glowing slab, not a window.
        const r = Math.round(mat.rgba[0] * 0.35), g = Math.round(mat.rgba[1] * 0.35), b = Math.round(mat.rgba[2] * 0.35);
        const a = mat.rgba[3] < 245 ? Math.min(mat.rgba[3], 64) : 60;
        const key = "glass|" + r + "," + g + "," + b + "," + a;
        if (texKey.has(key)) return texKey.get(key);
        const mi = materials.length;
        texList.push({ name: "glass", width: 4, height: 4, rgb: solidRgb(r, g, b), alpha: Buffer.alloc(16, 255) });
        materials.push({ name: "glass", imageIndex: mi, alphaMode: "BLEND", factor: [r / 255, g / 255, b / 255, a / 255], translucent: true });
        texKey.set(key, mi);
        return mi;
      }
      if (!texName) return 0;
      const key = txdName + "|" + texName;
      if (texKey.has(key)) return texKey.get(key);
      let im = null; const txd = getTxd(txdName); if (txd) im = txd.get(texName);
      if (!im) { const alt = findTxdFor(texName); if (alt && alt !== txdName) { const t2 = getTxd(alt); if (t2) im = t2.get(texName); } }   // parent-chain fallback
      const mi = materials.length;
      texList.push(im || null);
      materials.push({ name: texName, imageIndex: im ? mi : null, alphaMode: im && im.alpha ? "MASK" : "OPAQUE", factor: [0.55, 0.55, 0.55, 1] });
      texKey.set(key, mi);
      return mi;
    };

    const prims = [];
    let placed = 0, missing = 0, tris = 0;
    for (const inst of subset) {
      const def = idToModel.get(inst.id) || { model: inst.model, txd: "" };
      const geos = getModel(def.model);
      if (!geos) { missing++; continue; }
      const glassModel = /glassfx/i.test(def.model);   // GTA's breakable glass panels: render translucent
      // The IPL stores the CONJUGATE of the instance's world orientation (verified against GTA tooling -
      // opensa, quarry), so the rotation must be conjugated (negate x,y,z) before it is applied. Skipping
      // this yawed every rotated object the wrong way - traffic-light arms and road pieces faced backwards
      // and would not line up - while identity / 180 degree instances (conjugate-invariant) looked fine and
      // hid the bug.
      const qr = inst.quat, q = [-qr[0], -qr[1], -qr[2], qr[3]], s = inst.scale, pos = inst.pos;
      for (const g of geos) {
        const n = g.verts.length / 3;
        const world = new Float32Array(g.verts.length);
        for (let i = 0; i < n; i++) {
          const lv = [g.verts[i * 3] * s[0], g.verts[i * 3 + 1] * s[1], g.verts[i * 3 + 2] * s[2]];
          const r = quatRotate(q, lv);
          world[i * 3] = r[0] + pos[0]; world[i * 3 + 1] = r[1] + pos[1]; world[i * 3 + 2] = r[2] + pos[2];
        }
        const uv = g.uvs ? { data: g.uvs } : null;
        // one prim per material used by this geometry, sharing the world vertex buffer
        const byMat = new Map();
        for (const t of g.tris) {
          const mi = resolveTexMat(def.txd, g.materials && g.materials[t[3]], glassModel);
          let arr = byMat.get(mi); if (!arr) { arr = []; byMat.set(mi, arr); }
          arr.push(t[0], t[1], t[2]);
        }
        for (const [mi, idxArr] of byMat) {
          prims.push({ matrix: IDENTITY, pos: { data: world, count: n }, nrm: null, uv, indices: Uint32Array.from(idxArr), material: mi });
          tris += idxArr.length / 3;
        }
      }
      placed++;
    }

    // Water surface + swim volumes, over OPEN water only. First a coarse ground-height field from the city's
    // own floor triangles (highest near-horizontal surface per WATER_CELL cell); the sea/river is then drawn
    // only where the ground is missing or well below the waterline, so it never blankets the city as a bright
    // slab poking up between the road pieces.
    let waterVolumes = [];
    if (bounds && waterRects.length) {
      const gz = new Map();
      for (const p of prims) {
        const V = p.pos.data, I = p.indices;
        for (let t = 0; t + 2 < I.length; t += 3) {
          const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
          const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2], vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
          const nz = ux * vy - uy * vx, nl = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz) || 1;
          if (Math.abs(nz / nl) < 0.5) continue;   // wall, not floor
          const mx = (V[a] + V[b] + V[c]) / 3, my = (V[a + 1] + V[b + 1] + V[c + 1]) / 3, mz = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
          const k = Math.floor(mx / WATER_CELL) + "," + Math.floor(my / WATER_CELL);
          const cur = gz.get(k); if (cur === undefined || mz > cur) gz.set(k, mz);
        }
      }
      const groundAt = (x, y) => gz.get(Math.floor(x / WATER_CELL) + "," + Math.floor(y / WATER_CELL));
      const wm = openWater(waterRects, bounds.x0, bounds.y0, bounds.x1, bounds.y1, groundAt, WATER_CELL, WATER_OPEN_DROP);
      // The SURFACE is drawn as the full clipped rectangles - the depth buffer cuts it against the shore
      // exactly like the original engine, so the waterline meets the terrain instead of the ragged grid-cell
      // outline the open-water strips would leave. The strips only drive the swim volumes.
      const fullVerts = [], fullTris = [];
      let fb = 0;
      for (const r of waterRects) {
        const x0 = Math.max(Math.min(r.x0, r.x1), bounds.x0), y0 = Math.max(Math.min(r.y0, r.y1), bounds.y0);
        const x1 = Math.min(Math.max(r.x0, r.x1), bounds.x1), y1 = Math.min(Math.max(r.y0, r.y1), bounds.y1);
        if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
        fullVerts.push(x0, y0, r.level, x1, y0, r.level, x1, y1, r.level, x0, y1, r.level);
        fullTris.push(fb, fb + 1, fb + 2, fb, fb + 2, fb + 3);
        fb += 4;
      }
      if (fullVerts.length) {
        const mi = materials.length;
        texList.push({ name: "water", width: WATER_TEX.width, height: WATER_TEX.height, rgb: WATER_TEX.rgb });
        materials.push({ name: "water", imageIndex: mi, alphaMode: "BLEND", factor: [1, 1, 1, 0.9], translucent: true });
        const fv = new Float32Array(fullVerts);
        const uvw = new Float32Array(fv.length / 3 * 2);
        for (let i = 0; i < fv.length / 3; i++) { uvw[i * 2] = fv[i * 3] / 8; uvw[i * 2 + 1] = fv[i * 3 + 1] / 8; }
        prims.push({ matrix: IDENTITY, pos: { data: fv, count: fv.length / 3 }, nrm: null, uv: { data: uvw }, indices: Uint32Array.from(fullTris), material: mi });
        tris += fullTris.length / 3;
      }
      waterVolumes = wm.strips;   // open-water only; the glTF builder just boxes each strip
    }
    waterVolumes.depth = WATER_DEPTH;

    return {
      prims, materials, lights: [], waterVolumes, applyMat4, applyMat3, decodeMaterialImage: (i) => texList[i],
      stats: { placed, missing, triangles: tris, textures: texList.filter(Boolean).length },
    };
  };

  return { instances, buildScene, radiusOf, reachOf };
}

// The densest 100 m grid cell (a built-up area, never open water), for the default single-district crop.
function densestDistrict(instances, o, log) {
  const cells = new Map();
  for (const inst of instances) { const k = Math.round(inst.pos[0] / 100) + "," + Math.round(inst.pos[1] / 100); cells.set(k, (cells.get(k) || 0) + 1); }
  let best = null, bestN = -1;
  for (const [k, n] of cells) if (n > bestN) { bestN = n; best = k; }
  const [cx, cy] = best.split(",").map(Number).map((v) => v * 100);
  // 220 m keeps the doubled tri count (~260k) under maxTris so the district is NOT decimated - decimation
  // was cutting 40% of the walls and punching the holes seen in-game. A complete 440 m district beats a
  // holed 700 m one; --crop cx,cy,half overrides for a bigger area, --tile splits the whole city.
  const crop = { cx, cy, half: o.cropHalf || 220 };
  log("gta: no --crop/--tile given - defaulting to the densest district at (" + cx + ", " + cy + ") half " + crop.half + " m; --tile <m> splits the whole city into squares");
  return crop;
}

// Populated <size>-metre squares (a square is populated when >= minInst instance ORIGINS fall in it), each
// with the geometry that renders a COMPLETE square. An instance belongs to every square its bounding sphere
// (pos, radiusOf) reaches into, expanded by the seam margin - so a big road/terrain slab centred one tile
// over still floors this one and the square has no holes; whole models, never a mid-mesh cut. radiusOf(i)=0
// (model unreadable) reduces to the old origin-in-square test.
function tileInstances(instances, size, overlap, minInst, radiusOf) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of instances) { const x = i.pos[0], y = i.pos[1]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const col = (x) => Math.floor((x - minX) / size), row = (y) => Math.floor((y - minY) / size);
  const count = new Map();
  for (const i of instances) { const k = col(i.pos[0]) + "," + row(i.pos[1]); count.set(k, (count.get(k) || 0) + 1); }
  const cells = [...count.entries()].filter(([, n]) => n >= minInst).map(([k]) => k.split(",").map(Number))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);      // row-major: row (y) then col (x)
  const half = size / 2 + overlap;
  // Cache each instance's sphere radius once (keyed by array index) - a model resolves to one radius reused
  // across every tile test.
  const rad = instances.map((i) => radiusOf ? radiusOf(i) : 0);
  return {
    span: [Math.round(maxX - minX), Math.round(maxY - minY)],
    tiles: cells.map(([c, r]) => {
      const cx = minX + (c + 0.5) * size, cy = minY + (r + 0.5) * size;
      const subset = instances.filter((i, k) => {
        const dx = Math.max(Math.abs(i.pos[0] - cx) - half, 0), dy = Math.max(Math.abs(i.pos[1] - cy) - half, 0);
        return dx * dx + dy * dy <= rad[k] * rad[k];
      });
      return { col: c, row: r, cx: Math.round(cx), cy: Math.round(cy), subset };
    }),
  };
}

function convert(opts) {
  const o = Object.assign({}, opts);
  const log = o.log || (() => { });
  const root = o.clientDir || o.file;
  const baseName = o.game === "vc" ? "ViceCity" : "GTA3";
  const S = o.scale || SCALE;
  const common = loadGtaCommon(root, log);

  const gltfConvert = (scene, mapName, extra) => gltf.convert(Object.assign({}, o, {
    scene, file: null, baseName, mapName,
    axes: [0, 1, 2], flip: [0, 1, 0], scale: S,
    spawnClearance: true,   // GTA tiles are dense - pick a wall-free, open floor and face open space (no spawn-in-wall death)
    groundFriction: +(process.env.KF_GTA_FRICTION || 14),   // > KF's default 8: the big-scale StaticMesh floors felt icy (player glided after stopping); higher friction stops the skate

    autoColor: o.autoColor !== false,
    twoSided: o.twoSided !== false, groundUp: false,   // GTA .dff faces are single-sided - two-side them so buildings/roads aren't see-through (holes in walls)
    maxTris: o.maxTris !== undefined ? o.maxTris : +(process.env.KF_GTA_MAX_TRIS || 400000),   // doubling makes a district ~660k tris (170 MB); cap it
    // KF draws unlit surfaces ~2.5x overbright (texture.js), so a light/white wall clips to a glaring white.
    // 0.45 pre-divides enough that a near-white GTA facade reads as light grey, not a glow, while the darker
    // road/brick textures stay visible; the lower AmbientGlow cuts the self-illumination that added to it.
    texGain: o.texGain !== undefined ? o.texGain : 0.45,
    dimBright: 0.7,   // near-white rasters (shop windows, white facades) still clip to a glare through KF's ~2.5x overbright; squeeze just the top of the range
    ambient: o.ambient !== undefined ? o.ambient : 56, glow: o.glow !== undefined ? o.glow : 24,
    cullDistance: o.cullDistance !== undefined ? o.cullDistance : +(process.env.KF_CULL_DIST || 12000),
    crop: null,   // crop is applied in world units above, before scaling, not in the glTF builder
    title: baseName + (o.game === "vc" ? " (Grand Theft Auto: Vice City)" : " (Grand Theft Auto III)"),
  }, extra || {}));

  // --tile <m>: split the whole city into squares, one .rom per populated square. Returns an ARRAY.
  const tileSize = o.tile === true ? TILE_METERS : (typeof o.tile === "number" && o.tile > 0 ? o.tile : 0);
  if (tileSize) {
    if (o.outFile) { o.outDir = o.outDir || path.dirname(o.outFile); o.outFile = null; }   // one file name can't hold many tiles - write into its folder
    const overlap = o.tileOverlap !== undefined ? o.tileOverlap : Math.round(tileSize * TILE_OVERLAP_FRAC);
    const minInst = o.minInstances !== undefined ? o.minInstances : MIN_TILE_INSTANCES;
    const { span, tiles } = tileInstances(common.instances, tileSize, overlap, minInst, common.reachOf);
    log("gta: tiling " + span[0] + "x" + span[1] + " m into " + tileSize + " m squares - " + tiles.length + " populated tile(s) (>= " + minInst + " instances each), " + overlap + " m overlap");
    // A dense tile is decimated to the triangle budget the same way the district is - coverage-preserving
    // vertex clustering, so a capped tile keeps its walls instead of holing out (src/gltf/decimate). Its
    // textures are capped smaller than the district's so the many .rom files stay light and quick to load.
    // A tile still over the heavy mark after that is flagged so the user can shrink --tile.
    const tileMaxTex = o.maxTexture !== undefined ? o.maxTexture : TILE_MAX_TEXTURE;
    const results = [];
    const tileHalf = tileSize / 2 + overlap;
    const zones = readZones(root);   // name each tile by the GTA district it sits in (HARWOOD, REDLIGH, ...)
    let idx = 0;
    for (const t of tiles) {
      const scene = common.buildScene(t.subset, { x0: t.cx - tileHalf, y0: t.cy - tileHalf, x1: t.cx + tileHalf, y1: t.cy + tileHalf });
      if (!scene.prims.length) continue;
      idx++;
      const nn = String(idx).padStart(2, "0");
      // --only "1,2": rebuild just the named tile numbers (numbering unchanged - idx already advanced), for
      // a quick fix-verify loop on one square instead of the whole city.
      if (o.tileOnly && !String(o.tileOnly).split(",").some((v) => parseInt(v, 10) === idx)) continue;
      const zone = zoneNameAt(zones, t.cx, t.cy);
      const mapName = (o.mapName ? o.mapName + "-" + nn : "KF-" + baseName + "-" + nn) + (zone ? "-" + zone : "");
      log("gta: tile " + nn + " grid(" + t.col + "," + t.row + ") centre(" + t.cx + "," + t.cy + ") - " +
        scene.stats.placed + " instances, " + Math.round(scene.stats.triangles) + " tris, " + scene.stats.textures + " textures" +
        (scene.stats.missing ? ", " + scene.stats.missing + " model(s) missing" : ""));
      const r = gltfConvert(scene, mapName, { maxTexture: tileMaxTex });
      if (r.stats && r.stats.triangles > TILE_HEAVY_TRIS) log("gta:   tile " + nn + " is heavy (" + r.stats.triangles + " tris) - a smaller --tile loads faster");
      results.push(r);
    }
    if (!results.length) throw new Error("no populated tiles (raise --tile size or lower --min-instances)");
    return results;
  }

  // Single-scene default: one district (densest cell), or --crop / --whole.
  let crop = o.crop ? (() => { const [cx, cy, half] = o.crop.split(",").map(Number); return { cx, cy, half }; })() : null;
  if (!crop && !o.whole) crop = densestDistrict(common.instances, o, log);
  const subset = crop ? common.instances.filter((i) => Math.abs(i.pos[0] - crop.cx) <= crop.half && Math.abs(i.pos[1] - crop.cy) <= crop.half) : common.instances;
  let bounds;
  if (crop) bounds = { x0: crop.cx - crop.half, y0: crop.cy - crop.half, x1: crop.cx + crop.half, y1: crop.cy + crop.half };
  else { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const i of subset) { if (i.pos[0] < a) a = i.pos[0]; if (i.pos[1] < b) b = i.pos[1]; if (i.pos[0] > c) c = i.pos[0]; if (i.pos[1] > d) d = i.pos[1]; } bounds = { x0: a, y0: b, x1: c, y1: d }; }
  const scene = common.buildScene(subset, bounds);
  log("gta: placed " + scene.stats.placed + " instances (" + Math.round(scene.stats.triangles) + " triangles), " + scene.stats.textures + " textures" +
    (scene.stats.missing ? ", " + scene.stats.missing + " model(s) missing" : "") + (crop ? " within crop" : ""));
  if (!scene.prims.length) throw new Error("no geometry placed (wrong folder, or crop excluded everything)");
  return gltfConvert(scene, o.mapName);
}

module.exports = { convert, loadGtaCommon };
