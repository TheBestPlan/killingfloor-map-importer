// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GoldSrc BSP -> UE2.5 UModel.
//
// The two trees are the same kind of object (convex-leaf BSP with faces attached to nodes), so the
// tree is translated rather than rebuilt. Per GoldSrc node with k faces this emits one primary
// Unreal node carrying the children plus k-1 coplanar nodes chained through iPlane, which is
// exactly how Unreal represents coplanar polygons.
//
// Coordinates: GoldSrc is right-handed, Unreal is left-handed, so Y is mirrored; the mirror also
// flips the winding, which cancels the two engines' opposite polygon-winding conventions (verified
// on 2673 shipped Unreal polygons and 8589 GoldSrc faces — see test/selfcheck.js).
"use strict";

const brushEnts = require("./brushents");

const PF = {
  Invisible: 0x00000001, Masked: 0x00000002, Translucent: 0x00000004, NotSolid: 0x00000008,
  Semisolid: 0x00000020, Modulated: 0x00000040, FakeBackdrop: 0x00000080, TwoSided: 0x00000100,
  Unlit: 0x00400000, Portal: 0x04000000,
};
const INDEX_NONE = -1;

// The level extent in Unreal units, per axis. GoldSrc -> Unreal mirrors Y, which swaps that
// axis' min and max.
const skyMin = (world, S, a) => (a === 1 ? -world.maxs[1] : world.mins[a]) * S;
const skyMax = (world, S, a) => (a === 1 ? -world.mins[1] : world.maxs[a]) * S;

// The room the whole level lives in. A Killing Floor map is built the other way round from a
// GoldSrc one: the world starts as solid rock and a mapper subtracts a cube to make space, then
// puts everything inside it. That cube is the map's foundation - without it the engine calls every
// point solid, so nothing draws, nothing spawns, and KFEd's Map Check reports every navigation
// point "imbedded in level geometry". Both the shipped BSP and the CSG brush KFEd rebuilds from
// come from this one box, so it is computed in one place.
const BOX_MARGIN = 8192;                            // Unreal units of air around the level
const BOX_CLAMP = 120000;                           // stay well inside HALF_WORLD_MAX
function worldBox(map, scale) {
  const world = map.models[0];
  const clamp = (v) => Math.max(-BOX_CLAMP, Math.min(BOX_CLAMP, v));
  return {
    min: [0, 1, 2].map((a) => clamp(skyMin(world, scale, a) - BOX_MARGIN)),
    max: [0, 1, 2].map((a) => clamp(skyMax(world, scale, a) + BOX_MARGIN)),
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Solve the 3x3 system rows*X = rhs (Cramer). Returns null if near-singular.
function solve3(rows, rhs) {
  const [a, b, c] = rows;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (Math.abs(det) < 1e-9) return null;
  const d = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const col = (i) => [0, 1, 2].map((r) => rows[r].map((v, k) => (k === i ? rhs[r] : v)));
  return [d(col(0)) / det, d(col(1)) / det, d(col(2)) / det];
}

class Dedup {
  constructor(eps) { this.list = []; this.map = new Map(); this.eps = eps || 100; }
  add(v) {
    const k = Math.round(v[0] * this.eps) + "," + Math.round(v[1] * this.eps) + "," + Math.round(v[2] * this.eps);
    let i = this.map.get(k);
    if (i === undefined) { i = this.list.length; this.list.push(v); this.map.set(k, i); }
    return i;
  }
}

// Shelf packer for the 512x512 lightmap atlases.
class AtlasPacker {
  constructor(size) { this.size = size; this.pages = []; this.newPage(); }
  newPage() { this.pages.push({ shelfY: 0, shelfH: 0, x: 0 }); return this.pages.length - 1; }
  alloc(w, h) {
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (p.x + w <= this.size && p.shelfY + Math.max(p.shelfH, h) <= this.size) {
        const at = { page: i, x: p.x, y: p.shelfY };
        p.x += w; p.shelfH = Math.max(p.shelfH, h);
        return at;
      }
      if (p.shelfY + p.shelfH + h <= this.size) {
        p.shelfY += p.shelfH; p.shelfH = h; p.x = w;
        return { page: i, x: 0, y: p.shelfY };
      }
    }
    const i = this.newPage();
    const p = this.pages[i];
    p.x = w; p.shelfH = h; p.shelfY = 0;
    return { page: i, x: 0, y: 0 };
  }
}

function buildModel(map, opts) {
  const S = opts.scale;
  const LMS = opts.lightMapScale;
  const ATLAS = 512;
  const MAX_LUXELS = 64;                       // per axis; keeps one face from eating a whole atlas
  const texOf = opts.texByMiptex;              // miptex index -> { ref, width, height, kind }
  const levelRef = opts.levelRef;

  const toUE = (p) => [p[0] * S, -p[1] * S, p[2] * S];

  const points = new Dedup(16);
  const vectors = new Dedup(4096);
  const nodes = [], surfs = [], verts = [], lightMaps = [];
  const faceBlocks = [];                        // lightmap allocation requests
  const stats = { faces: 0, skipped: {}, splitOnly: 0, sky: 0, masked: 0, lit: 0, unlit: 0 };

  const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };
  const EPS = 0.1;                              // plane-side tolerance for polygon clipping

  // --- surfaces ---------------------------------------------------------------------------------
  // `offsetHL` is the brush entity's `origin`: hlcsg stores a brush entity's vertices relative to
  // it, so world position is vertex + origin and the plane distance shifts with it.
  function makeSurf(face, offsetHL, matOf) {
    const ti = map.texinfo[face.texinfo];
    const tex = texOf.get(ti.miptex);
    if (!tex) { skip("no texture"); return null; }
    if (tex.kind === "tool") { skip("tool texture " + tex.name); return null; }

    // On the mesh route the meshes are the world and the BSP only has to exist (for PointRegion)
    // and carry the sky. Every other face is dropped rather than "hidden": a surface pointed at a
    // fully masked texture is still drawn, and it comes out white over the meshes.
    if (opts.skyOnly && tex.kind !== "sky") { skip("mesh route: BSP keeps sky only"); return null; }

    const O = offsetHL || [0, 0, 0];
    const N = map.faceNormal(face), D = map.faceDist(face) + dot(N, O);
    // Texture origin: the world point where GoldSrc's (s,t) are both zero and which lies on the
    // face plane. Unreal measures UV from pBase, so putting pBase there reproduces the shift exactly.
    let base = solve3([ti.s, ti.t, N], [-ti.sShift + dot(ti.s, O), -ti.tShift + dot(ti.t, O), D]);
    if (!base) base = add(map.faceVertices(face)[0], O);

    // The GoldSrc axes are in original-texture texels; if the texture was resampled to a power of
    // two, scale them so dividing by the new USize still gives the same 0..1 coordinate.
    const uAxUE = mul([ti.s[0], -ti.s[1], ti.s[2]], (tex.uScale || 1) / S);
    const vAxUE = mul([ti.t[0], -ti.t[1], ti.t[2]], (tex.vScale || 1) / S);
    const nUE = [N[0], -N[1], N[2]];
    const baseUE = toUE(base);

    // A sky brush face gets the matching side of the real skybox, projected across the level's own
    // extent. GoldSrc side convention: rt=+X, lf=-X, bk=+Y, ft=-Y, up=+Z, dn=-Z, in GoldSrc axes.
    if (tex.kind === "sky" && opts.skySides) {
      stats.sky++;
      const ax = Math.abs(N[0]) > Math.abs(N[1]) && Math.abs(N[0]) > Math.abs(N[2]) ? 0
        : Math.abs(N[1]) > Math.abs(N[2]) ? 1 : 2;
      const side = ax === 2 ? (N[2] > 0 ? "dn" : "up") : ax === 0 ? (N[0] > 0 ? "lf" : "rt") : (N[1] > 0 ? "ft" : "bk");
      const skyTex = opts.skySides[side];
      if (skyTex) {
        // Span the level's bounding box on the two axes the face does not point along, so the six
        // images tile the sky brush once rather than repeating with the placeholder's 16x16 scale.
        const ext = opts.skyExtent;                 // [minUE, maxUE] in Unreal units
        const u = ax === 0 ? 1 : 0, v = ax === 2 ? 1 : 2;
        const span = (i) => Math.max(1, ext[1][i] - ext[0][i]);
        const uAx = [0, 0, 0], vAx = [0, 0, 0];
        uAx[u] = skyTex.width / span(u);
        vAx[v] = -skyTex.height / span(v);          // Unreal V grows downward
        const baseSky = [0, 0, 0];
        baseSky[u] = ext[0][u]; baseSky[v] = ext[1][v]; baseSky[ax] = 0;
        const iSurfSky = surfs.length;
        surfs.push({
          // Never hidden: on the mesh route the meshes draw the world and the BSP draws only the
          // sky, so this is the one surface class that must keep its real texture.
          material: skyTex.ref, polyFlags: 0,
          pBase: points.add(baseSky), vNormal: vectors.add([N[0], -N[1], N[2]]),
          vTextureU: vectors.add(uAx), vTextureV: vectors.add(vAx),
          iLightMap: INDEX_NONE, actor: 0,
          plane: [N[0], -N[1], N[2], D * S], lightMapScale: LMS,
        });
        return {
          iSurf: iSurfSky, tex: skyTex, ti, nUE: [N[0], -N[1], N[2]], baseUE: baseSky,
          // flags 0, not PF_Unlit: planLightmap gives unlit faces a flat 255 block, and 255 is
          // double brightness in UE - that is what blew the sky out to solid white.
          uAxUE: uAx, vAxUE: vAx, flags: 0, dist: D * S, offsetHL: O, sky: true,
        };
      }
    }

    let flags = 0;
    if (tex.kind === "sky") {
      stats.sky++;
      // A PF_FakeBackdrop surface makes the renderer project the level's sky zone; without a
      // SkyZoneInfo actor there is nothing to project. Default is to draw the sky texture normally
      // lit — PF_Unlit made it blow out to white.
      if (opts.sky === "backdrop") flags |= PF.FakeBackdrop;
      else if (opts.sky === "invisible") flags |= PF.Invisible;
      else if (opts.sky === "unlit") flags |= PF.Unlit;
    }
    // Only flags the shipped maps actually put on a BSP surface. Cut-outs come from the texture's
    // own bMasked (which is how the stock maps do it), not from PF_Masked, and PF_TwoSided never
    // appears on stock BSP either.
    if (tex.kind === "masked") stats.masked++;
    if (tex.kind === "liquid") flags |= PF.Translucent | PF.NotSolid;

    // The static-mesh route keeps the BSP purely as the level's skeleton - zones, leaves, collision
    // and the point-region lookup that ULevel::SpawnActor needs - while the visible surfaces come
    // from the meshes. Drawing both would z-fight, so the BSP gets a fully masked-out texture.
    // PF_Invisible is not the way: the engine draws those surfaces flat white instead of skipping.
    // A FakeBackdrop surface has to keep its own material: the hide pass below recognises a hidden
    // node by its material being the mask, and a sky surface with zeroed NumVertices never reaches
    // a render section, so the backdrop is never projected through it.
    // A brush entity the mapper gave a render mode (glass, mostly) brings its own translucent
    // material; nothing else about the surface changes.
    const material = (tex.kind === "sky" && opts.sky === "backdrop") ? tex.ref
      : (opts.hideMaterialRef || (matOf && matOf(tex)) || tex.ref);

    const iSurf = surfs.length;
    surfs.push({
      material, polyFlags: flags,
      pBase: points.add(baseUE), vNormal: vectors.add(nUE),
      vTextureU: vectors.add(uAxUE), vTextureV: vectors.add(vAxUE),
      iLightMap: INDEX_NONE, actor: 0,
      plane: [nUE[0], nUE[1], nUE[2], D * S], lightMapScale: LMS,
    });
    return { iSurf, tex, ti, nUE, baseUE, uAxUE, vAxUE, flags, dist: D * S, offsetHL: O };
  }

  // --- lightmap block for one face ---------------------------------------------------------------
  function planLightmap(face, info, ringUE) {
    if (opts.noLight) return null;
    // Every drawable node must end up with a valid iLightMap: the renderer follows the index the
    // same way it follows iSection, and -1 sends it off the front of the array. Faces with no
    // GoldSrc lighting (sky, water) get a flat block instead of being left unlit.
    let hl = map.faceLightmapRGB(face);
    if (!hl) {
      const flat = (info.flags & (PF.FakeBackdrop | PF.Unlit | PF.Invisible)) ? 255 : 128;
      hl = { width: 2, height: 2, baseS: 0, baseT: 0, styles: 1, offset: -1, rgb: Buffer.alloc(2 * 2 * 3, flat), flat: true };
    }

    // Lightmap basis: the texture U direction plus its in-plane perpendicular. It must be
    // ORTHONORMAL — the engine reconstructs luxel coordinates by inverting base/xAxis/yAxis, and a
    // skewed texture projection would then disagree with the UVs written into the section vertices.
    const uDir = mul(info.uAxUE, 1 / (len(info.uAxUE) || 1));
    const vDir = cross(info.nUE, uDir);
    const vl = len(vDir) || 1;
    vDir[0] /= vl; vDir[1] /= vl; vDir[2] /= vl;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const p of ringUE) {
      const u = dot(p, uDir), v = dot(p, vDir);
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    const extU = Math.max(uMax - uMin, 1e-3), extV = Math.max(vMax - vMin, 1e-3);
    // Unreal maps the polygon into [1, size-1] of the block, i.e. a one-luxel border all round.
    const sizeX = Math.min(MAX_LUXELS, Math.max(3, Math.ceil(extU / LMS) + 2));
    const sizeY = Math.min(MAX_LUXELS, Math.max(3, Math.ceil(extV / LMS) + 2));
    const stepU = extU / (sizeX - 2), stepV = extV / (sizeY - 2);
    const xAxis = mul(uDir, stepU), yAxis = mul(vDir, stepV);
    // origin of luxel (0,0): one step outside the polygon's minimum corner
    const corner = add(add(mul(uDir, uMin), mul(vDir, vMin)), mul(info.nUE, dot(ringUE[0], info.nUE)));
    const baseWorld = sub(corner, add(xAxis, yAxis));
    return { hl, sizeX, sizeY, xAxis, yAxis, baseWorld, uDir, vDir, uMin, vMin, stepU, stepV, iSurf: info.iSurf, offsetHL: info.offsetHL };
  }

  // Sample the GoldSrc lightmap at an Unreal world position (bilinear, clamped at the edges).
  function sampleHL(hl, ti, worldUE, out, offsetHL) {
    if (hl.flat) { out[0] = hl.rgb[0]; out[1] = hl.rgb[1]; out[2] = hl.rgb[2]; return; }
    const O = offsetHL || [0, 0, 0];
    const p = sub([worldUE[0] / S, -worldUE[1] / S, worldUE[2] / S], O);
    const s = dot(p, ti.s) + ti.sShift, t = dot(p, ti.t) + ti.tShift;
    let fx = s / 16 - hl.baseS, fy = t / 16 - hl.baseT;
    fx = Math.max(0, Math.min(hl.width - 1, fx));
    fy = Math.max(0, Math.min(hl.height - 1, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(hl.width - 1, x0 + 1), y1 = Math.min(hl.height - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 3; c++) {
      const v00 = hl.rgb[(y0 * hl.width + x0) * 3 + c], v10 = hl.rgb[(y0 * hl.width + x1) * 3 + c];
      const v01 = hl.rgb[(y1 * hl.width + x0) * 3 + c], v11 = hl.rgb[(y1 * hl.width + x1) * 3 + c];
      out[c] = ((v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay) | 0;
    }
  }

  // --- node emission ------------------------------------------------------------------------------
  function emitPolyNode(info, ringUE) {
    const iVertPool = verts.length;
    for (const p of ringUE) verts.push({ pVertex: points.add(p), iSide: INDEX_NONE });
    let cx = 0, cy = 0, cz = 0;
    for (const p of ringUE) { cx += p[0]; cy += p[1]; cz += p[2]; }
    const c = [cx / ringUE.length, cy / ringUE.length, cz / ringUE.length];
    let rad = 0;
    for (const p of ringUE) rad = Math.max(rad, len(sub(p, c)));
    const idx = nodes.length;
    nodes.push({
      plane: [info.nUE[0], info.nUE[1], info.nUE[2], info.dist],
      zoneMask: [0xffffffff, 0xffffffff], nodeFlags: 0,
      iVertPool, iSurf: info.iSurf, iBack: INDEX_NONE, iFront: INDEX_NONE, iPlane: INDEX_NONE,
      iCollisionBound: INDEX_NONE, iRenderBound: INDEX_NONE,
      sphere: { center: c, radius: rad }, iZone: [0, 1], numVertices: ringUE.length,
      iLeaf: [INDEX_NONE, INDEX_NONE], iSection: INDEX_NONE, iFirstVertex: 0, iLightMap: INDEX_NONE,
    });
    return idx;
  }

  // A GoldSrc node can carry no drawable face while still splitting space. No shipped map contains
  // a node with NumVertices == 0, so instead of leaving one, build the polygon the splitting plane
  // actually spans inside its cell (clip a large quad by the ancestor half-spaces) and mark it
  // invisible and non-solid — flags the stock maps do use.
  let invisibleSurf = INDEX_NONE;
  function getInvisibleSurf(planeUE, distUE) {
    const iSurf = surfs.length;
    const anyTex = [...texOf.values()].find((t) => t.ref) || { ref: 0 };
    const uAx = Math.abs(planeUE[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const vAx = cross(planeUE, uAx);
    surfs.push({
      material: anyTex.ref, polyFlags: PF.Invisible | PF.NotSolid,
      pBase: points.add(mul(planeUE, distUE)), vNormal: vectors.add(planeUE),
      vTextureU: vectors.add(uAx), vTextureV: vectors.add(vAx),
      iLightMap: INDEX_NONE, actor: 0,
      plane: [planeUE[0], planeUE[1], planeUE[2], distUE], lightMapScale: LMS,
    });
    return iSurf;
  }

  function emitSplitNode(gnode, path) {
    const pl = map.planes[gnode.planenum];
    const nUE = [pl.normal[0], -pl.normal[1], pl.normal[2]];
    const dUE = pl.dist * S;
    const mid = [(gnode.mins[0] + gnode.maxs[0]) / 2, (gnode.mins[1] + gnode.maxs[1]) / 2, (gnode.mins[2] + gnode.maxs[2]) / 2];
    // Clamp to the level's own extent: an unclipped quad (the root has no ancestors to clip it)
    // would otherwise stretch far past the map and inflate its bounding box.
    const wm = map.models[0];
    const worldHalf = Math.max(...[0, 1, 2].map((i) => (wm.maxs[i] - wm.mins[i]))) / 2 * S;
    const half = Math.min(worldHalf,
      Math.max(64, len([gnode.maxs[0] - gnode.mins[0], gnode.maxs[1] - gnode.mins[1], gnode.maxs[2] - gnode.mins[2]]) / 2) * S);

    // start with a big quad on the plane, centred on the node's own bounds
    const centre = add(mul(nUE, dUE), sub(toUE(mid), mul(nUE, dot(toUE(mid), nUE))));
    const uAx = Math.abs(nUE[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const u = cross(nUE, uAx), v = cross(nUE, u);
    const ul = len(u) || 1, vl = len(v) || 1;
    const U = mul(u, half * 2 / ul), V = mul(v, half * 2 / vl);
    let ring = [
      add(add(centre, U), V), add(sub(centre, U), V), sub(sub(centre, U), V), sub(add(centre, U), V),
    ];
    for (const p of path) {
      const nd = nodes[p.node];
      if (!nd) continue;
      // keep the side the descent went to
      const pln = p.front ? nd.plane : [-nd.plane[0], -nd.plane[1], -nd.plane[2], -nd.plane[3]];
      ring = splitPoly(ring, pln).front;
      if (ring.length < 3) break;
    }

    const idx = nodes.length;
    if (!opts.noSplitPolys && ring.length >= 3 && ring.length <= 12) {
      if (invisibleSurf === INDEX_NONE) invisibleSurf = getInvisibleSurf(nUE, dUE);
      const iVertPool = verts.length;
      for (const p of ring) verts.push({ pVertex: points.add(p), iSide: INDEX_NONE });
      nodes.push({
        plane: [nUE[0], nUE[1], nUE[2], dUE], zoneMask: [0xffffffff, 0xffffffff], nodeFlags: 0,
        iVertPool, iSurf: invisibleSurf, iBack: INDEX_NONE, iFront: INDEX_NONE, iPlane: INDEX_NONE,
        iCollisionBound: INDEX_NONE, iRenderBound: INDEX_NONE,
        sphere: { center: centre, radius: half * 2 }, iZone: [0, 1], numVertices: ring.length,
        iLeaf: [INDEX_NONE, INDEX_NONE], iSection: INDEX_NONE, iFirstVertex: 0, iLightMap: INDEX_NONE,
      });
    } else {
      nodes.push({
        plane: [nUE[0], nUE[1], nUE[2], dUE], zoneMask: [0xffffffff, 0xffffffff], nodeFlags: 0,
        iVertPool: 0, iSurf: 0, iBack: INDEX_NONE, iFront: INDEX_NONE, iPlane: INDEX_NONE,
        iCollisionBound: INDEX_NONE, iRenderBound: INDEX_NONE,
        sphere: { center: centre, radius: half * 2 }, iZone: [0, 1], numVertices: 0,
        iLeaf: [INDEX_NONE, INDEX_NONE], iSection: INDEX_NONE, iFirstVertex: 0, iLightMap: INDEX_NONE,
      });
    }
    stats.splitOnly++;
    return idx;
  }

  // Unreal keeps no leaves for solid space: the back of a surface simply terminates the tree with
  // iBack = -1, iLeaf = -1, iZone = 0. Only open leaves get an entry, and they all live in zone 1.
  const solidLeaf = (gLeafIdx) => !map.leafs[gLeafIdx] || map.leafs[gLeafIdx].contents === -2;
  const leafRemap = new Int32Array(map.leafs.length).fill(INDEX_NONE);
  let openLeafCount = 0;
  for (let i = 0; i < map.leafs.length; i++) if (!solidLeaf(i)) leafRemap[i] = openLeafCount++;
  const sideOf = (r) => {
    if (r.node !== INDEX_NONE) return { node: r.node, leaf: INDEX_NONE, zone: 1 };
    if (solidLeaf(r.leaf)) return { node: INDEX_NONE, leaf: INDEX_NONE, zone: 0 };
    return { node: INDEX_NONE, leaf: leafRemap[r.leaf], zone: 1 };
  };

  // Ancestor chain per emitted polygon node, used to build the collision hulls below.
  const hullPath = new Map();

  // Depth-first translation. Reserves the primary node index before recursing so children can be
  // linked afterwards.
  function translate(gIdx, depth, path) {
    if (gIdx < 0) return { node: INDEX_NONE, leaf: -gIdx - 1 };
    if (opts.maxDepth && depth >= opts.maxDepth) return { node: INDEX_NONE, leaf: 0 };
    const g = map.nodes[gIdx];
    if (!g) return { node: INDEX_NONE, leaf: 0 };

    const emitted = [];
    let flipTree = false, haveOrientation = false;
    for (let i = 0; i < g.numfaces; i++) {
      const face = map.faces[g.firstface + i];
      if (!face) continue;
      stats.faces++;
      if (opts.faceLimit && surfs.length >= opts.faceLimit) { skip("face limit"); continue; }
      const info = makeSurf(face);
      if (!info) continue;
      const ring = map.faceVertices(face).map(toUE);
      if (ring.length < 3) { skip("degenerate"); surfs.pop(); continue; }
      const idx = emitPolyNode(info, ring);
      hullPath.set(idx, path);
      // A node's plane is its POLYGON's plane. GoldSrc's children are ordered by the splitting
      // plane, so when the face opposes it (dface_t.side != 0) the two children swap over.
      if (!haveOrientation) { flipTree = !!face.side; haveOrientation = true; }
      const plan = planLightmap(face, info, ring);
      if (plan) { faceBlocks.push({ ...plan, node: idx, ti: map.texinfo[face.texinfo] }); stats.lit++; }
      else stats.unlit++;
      emitted.push(idx);
    }

    const primary = emitted.length ? emitted[0] : emitSplitNode(g, path);
    for (let i = 1; i < emitted.length; i++) nodes[emitted[i - 1]].iPlane = emitted[i];

    const gFront = flipTree ? g.children[1] : g.children[0];
    const gBack = flipTree ? g.children[0] : g.children[1];
    const front = translate(gFront, depth + 1, path.concat([{ node: primary, front: true }]));
    const back = translate(gBack, depth + 1, path.concat([{ node: primary, front: false }]));
    const f = sideOf(front), b = sideOf(back);
    const n = nodes[primary];
    n.iFront = f.node; n.iBack = b.node;
    n.iLeaf[1] = f.leaf; n.iLeaf[0] = b.leaf;
    n.iZone[1] = f.zone; n.iZone[0] = b.zone;
    return { node: primary, leaf: INDEX_NONE };
  }

  const world = map.models[0];

  // Two ways to build the tree:
  //
  //  flat (default) — one root node, then every polygon pushed down through insertPoly, splitting
  //  where it straddles. This is the only shape that has been observed to render reliably: a
  //  faithfully translated GoldSrc tree corrupts the engine's heap from some viewpoints, and after
  //  fixing four separate index bugs the remaining cause did not yield to black-box bisection.
  //  The cost is no PVS culling — everything in the level is drawn — which a CS-sized map affords.
  //
  //  translated (--tree-translate) — the 1:1 GoldSrc tree. Kept for further work on that bug.
  //
  //  minimal (--minimal-world, the mesh route) — a single node far below the level, drawing
  //  nothing. On that route the meshes are the world and their kDOP is the collision, so the only
  //  thing still asked of the BSP is PointRegion, and one node answers it as well as 3570 do. The
  //  flat tree is not free: the engine walks it every frame with no PVS to prune it.
  const flat = !opts.emptyWorld && !opts.minimalWorld && opts.treeTranslate !== true;
  let rootNode = INDEX_NONE;
  let rooms = null;                                  // set by the box route: the convex rooms it carved
  if (opts.emptyWorld) rootNode = INDEX_NONE;
  else if (opts.minimalWorld) {
    // A BOX around the level, not one quad under it.
    //
    // The renderer reaches the level's actors by walking this tree: it visits the nodes, decides
    // which of them the view frustum touches, and only then draws what belongs to their zone. With
    // a single horizontal quad far below the map, looking up points the frustum where that quad is
    // not - the walk finds nothing, and the whole world goes unrendered for that frame. What is
    // left on screen is the HUD and the first-person weapon, which are drawn afterwards by the HUD
    // pass, over a frame that is either the clear colour or whatever the buffer held. That is the
    // white/coloured flash, and it is why it happens when the view goes up.
    //
    // Six quads facing inwards, wrapped around the level, are always partly in front of the camera
    // whichever way it looks. They are invisible and non-solid; all six carry zone 1 on both sides,
    // so PointRegion still answers 1 anywhere and nothing about the zoning changes.
    // Built to match the room in skybox-how-to/Sky_CS.rom, which is a real CSG-subtracted cube from
    // an experienced mapper - the only known-good example of this shape for this engine. Its nodes
    // read iZone [0, 1] (solid behind the surface, the room in front) and iLeaf [-1, -1], with only
    // the LAST node's front side pointing at the single leaf. This converter used to write [1, 1]
    // and [0, 0] on every node: every side of every plane declared open and landing in the same
    // leaf. The renderer decides what to draw by walking exactly these fields.
    // The rooms are nested, not siblings: the sky room is carved out of the world room's air, so a
    // point reaches it only after passing every world plane. Behind any plane of room k lies room
    // k-1's air, and behind room 0's lies solid rock. That makes one chain of planes whose back
    // sides terminate at the enclosing room's leaf, which is a real (if crude) BSP for two convex
    // rooms - and the shape KFEd itself writes for two subtracts.
    rooms = [{
      box: opts.worldBox || worldBox(map, S), zone: 1, leaf: 0,
      // Killing Floor's own sky: the room's walls carry PF_FakeBackdrop and the engine draws the
      // sky zone's contents through them, at infinity, with no parallax. Without a backdrop they
      // are just the invisible shell that keeps the tree in front of the camera whichever way it
      // looks (see 2.12 - a single quad below the level is not).
      flags: opts.skyBackdrop2 ? (PF.FakeBackdrop | PF.Unlit | PF.NotSolid) : (PF.Invisible | PF.NotSolid),
      material: (opts.skyBackdrop2 && opts.skyMaterialRef) || opts.hideMaterialRef || 0,
    }];
    if (opts.skyRoomBox) rooms.push({
      box: opts.skyRoomBox, zone: 2, leaf: 1,
      flags: PF.Invisible | PF.NotSolid, material: opts.hideMaterialRef || 0,
    });

    const first = nodes.length;
    const sideCount = 6 * rooms.length;
    rooms.forEach((room, k) => {
      const lo = room.box.min, hi = room.box.max;
      // axis, sign, and the four corners of that side of the box
      const sides = [
        { n: [0, 0, 1], d: lo[2], ring: [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]]] },
        { n: [0, 0, -1], d: -hi[2], ring: [[lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], lo[1], hi[2]], [lo[0], lo[1], hi[2]]] },
        { n: [1, 0, 0], d: lo[0], ring: [[lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [lo[0], lo[1], hi[2]]] },
        { n: [-1, 0, 0], d: -hi[0], ring: [[hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]], [hi[0], lo[1], lo[2]]] },
        { n: [0, 1, 0], d: lo[1], ring: [[lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], lo[1], lo[2]], [lo[0], lo[1], lo[2]]] },
        { n: [0, -1, 0], d: -hi[1], ring: [[lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]] },
      ];
      const centre = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
      const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
      const outside = k === 0 ? { zone: 0, leaf: INDEX_NONE } : { zone: rooms[k - 1].zone, leaf: rooms[k - 1].leaf };
      sides.forEach((s, i) => {
        const seq = k * 6 + i;                       // position in the whole chain
        const plane = [s.n[0], s.n[1], s.n[2], s.d];
        const iSurf = surfs.length;
        // A real material and lightmap index: the node carries a polygon, so it reaches the section
        // pass, and both are followed there without a null/-1 check.
        const up = Math.abs(s.n[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1];
        surfs.push({
          material: room.material, polyFlags: room.flags,
          pBase: points.add(s.ring[0]), vNormal: vectors.add(s.n),
          vTextureU: vectors.add(up), vTextureV: vectors.add(cross(s.n, up)),
          iLightMap: INDEX_NONE, actor: 0, plane, lightMapScale: LMS,
        });
        const iVertPool = verts.length;
        for (const p of s.ring) verts.push({ pVertex: points.add(p), iSide: INDEX_NONE });
        const last = seq === sideCount - 1;
        nodes.push({
          plane, zoneMask: [3, 0], nodeFlags: 0,
          iVertPool, iSurf,
          iBack: INDEX_NONE, iFront: last ? INDEX_NONE : first + seq + 1, iPlane: INDEX_NONE,
          iCollisionBound: INDEX_NONE, iRenderBound: INDEX_NONE,
          sphere: { center: centre, radius },
          // NumVertices must be a real polygon count, never 0. UModel::LineCheck clips the ray against
          // the node's polygon and walks Verts(iVertPool .. iVertPool + NumVertices - 1); with 0 that
          // upper bound is iVertPool - 1, and the read runs off the array. It only faults when a trace
          // actually reaches this node, which is why the crash was intermittent (~1 in 10) and always
          // from a trace: Pawn.UpdateEyeHeight -> SingleLineCheck -> UModel::LineCheck.
          // EVERY node names the leaf on each of its sides, not just the last one in the chain.
          // The hand-built room in skybox-how-to/Sky_CS.rom hangs its single leaf off the last node
          // alone, and copying that makes the level vanish by view angle: a static mesh is reached
          // through the leaf of a node the walk actually visits, so a leaf that hangs off one node
          // in one corner is found only when the camera looks at that corner. In a real BSP the
          // geometry IS the tree and one leaf at the end costs nothing; here the geometry is actors.
          // This is a separate cause from 2.12 and survives it - both had to be fixed.
          iZone: [outside.zone, room.zone], numVertices: 4,
          iLeaf: [outside.leaf, room.leaf], keepPolygon: true,
          iSection: INDEX_NONE, iFirstVertex: 0, iLightMap: INDEX_NONE,
        });
      });
    });
    rootNode = first;
  }
  else if (!flat) rootNode = translate(world.headnode[0], 0, []).node;
  else {
    const g = map.nodes[world.headnode[0]] || map.nodes[0];
    rootNode = emitSplitNode(g, []);
    // both sides of the root are open space: one leaf, one zone
    nodes[rootNode].iLeaf = [0, 0];
    nodes[rootNode].iZone = [1, 1];
  }

  // --- brush entities (func_wall, func_illusionary, doors …) -------------------------------------
  // Their faces live in their own submodels and are not part of the world tree, but they are a
  // quarter of the visible geometry on some maps. Each polygon is pushed down the existing tree,
  // split where it straddles a plane, and turned into a node at the leaf it lands in.

  function splitPoly(ring, plane) {
    const front = [], back = [];
    const d = ring.map((p) => p[0] * plane[0] + p[1] * plane[1] + p[2] * plane[2] - plane[3]);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      if (d[i] >= -EPS) front.push(ring[i]);
      if (d[i] <= EPS) back.push(ring[i]);
      if ((d[i] > EPS && d[j] < -EPS) || (d[i] < -EPS && d[j] > EPS)) {
        const t = d[i] / (d[i] - d[j]);
        const mid = add(ring[i], mul(sub(ring[j], ring[i]), t));
        front.push(mid); back.push(mid);
      }
    }
    return { front, back };
  }

  let inserted = 0, fragments = 0, dropped = 0;

  // Attach the polygon at `parent`'s empty child slot, taking over the leaf that was there.
  function attach(parent, sideFront, ring, info, path) {
    const leaf = sideFront ? nodes[parent].iLeaf[1] : nodes[parent].iLeaf[0];
    // Brush-entity geometry was never carved out of the world, so a fragment can land on a side the
    // world tree calls solid. It is still visible geometry, and no shipped map has a drawable node
    // in zone 0, so put it in the open zone regardless.
    const zone = 1;
    const idx = emitPolyNode(info, ring);
    hullPath.set(idx, path);
    // The node does not really divide the space it sits in: its front keeps the open leaf it
    // replaced and its back reads as solid, exactly like an ordinary world surface.
    nodes[idx].iLeaf = [INDEX_NONE, leaf];
    nodes[idx].iZone = [0, zone];
    if (sideFront) { nodes[parent].iFront = idx; nodes[parent].iLeaf[1] = INDEX_NONE; }
    else { nodes[parent].iBack = idx; nodes[parent].iLeaf[0] = INDEX_NONE; }
    const plan = planLightmap(info._face, info, ring);
    if (plan) faceBlocks.push({ ...plan, node: idx, ti: info.ti });
    fragments++;
  }

  function insertPoly(parent, sideFront, ring, info, depth, path) {
    if (ring.length < 3 || depth > 600) { dropped++; return; }
    const next = path.concat([{ node: parent, front: sideFront }]);
    const child = sideFront ? nodes[parent].iFront : nodes[parent].iBack;
    if (child === INDEX_NONE) attach(parent, sideFront, ring, info, next);
    else descend(child, ring, info, depth + 1, next);
  }

  function descend(nodeIdx, ring, info, depth, path) {
    if (ring.length < 3 || depth > 600) { dropped++; return; }
    const pl = nodes[nodeIdx].plane;
    let anyFront = false, anyBack = false;
    for (const p of ring) {
      const d = p[0] * pl[0] + p[1] * pl[1] + p[2] * pl[2] - pl[3];
      if (d > EPS) anyFront = true; else if (d < -EPS) anyBack = true;
    }
    if (anyFront && anyBack) {
      const s = splitPoly(ring, pl);
      insertPoly(nodeIdx, true, s.front, info, depth, path);
      insertPoly(nodeIdx, false, s.back, info, depth, path);
    } else insertPoly(nodeIdx, !anyBack, ring, info, depth, path);
  }

  // On the static-mesh route the BSP is a token, EXCEPT for the sky. A Killing Floor sky is not a
  // box around the level: the sky surfaces are BSP surfaces flagged PF_FakeBackdrop, and the engine
  // draws the contents of the SkyZoneInfo's room through them, at infinity. Every shipped map is
  // built that way - KF-Bedlam has 151 such surfaces, KF-Crash 21, KF-Farm 5, and exactly one
  // SkyZoneInfo each. So insert the CS map's sky faces, and only those, into the token tree.
  const skyOnly = opts.minimalWorld && opts.skyBackdrop;
  if (rootNode !== INDEX_NONE && (!opts.minimalWorld || skyOnly)) {
    // In flat mode the world's own faces go through the same insertion path; in translated mode
    // they are already on the tree and only the brush entities are inserted.
    const jobs = [];
    if ((flat || skyOnly) && opts.faceLimit !== 0) {
      jobs.push({ model: world, offset: [0, 0, 0], nonSolid: false, world: true });
    }
    if (!skyOnly && opts.brushEntities !== false) {
      for (const ent of map.entities) {
        const mm = /^\*(\d+)$/.exec(ent.model || "");
        if (!mm) continue;
        const sm = map.models[+mm[1]];
        if (!sm || sm.numfaces <= 0) continue;
        // A trigger, or a zone the mapper drew in tool textures, is a shape the engine tests
        // against and never a surface it draws.
        if (brushEnts.invisible(ent, brushEnts.modelIsToolOnly(map, sm))) continue;
        const org = ent.origin ? ent.origin.trim().split(/\s+/).map(Number) : [0, 0, 0];
        jobs.push({
          model: sm, offset: [org[0] || 0, org[1] || 0, org[2] || 0],
          nonSolid: /illusionary/.test(ent.classname || ""),
          world: false, mat: opts.materialOf ? opts.materialOf(ent) : null,
        });
      }
    }
    for (const job of jobs) {
      for (let fi = job.model.firstface; fi < job.model.firstface + job.model.numfaces; fi++) {
        const face = map.faces[fi];
        if (!face) continue;
        if (skyOnly) {
          const ti = map.texinfo[face.texinfo];
          const mt = ti && map.miptex[ti.miptex];
          if (!mt || mt.kind !== "sky") continue;
        }
        stats.faces++;
        if (opts.faceLimit && surfs.length >= opts.faceLimit) { skip("face limit"); continue; }
        const info = makeSurf(face, job.offset, job.mat);
        if (!info) continue;
        if (job.nonSolid) { surfs[info.iSurf].polyFlags |= PF.NotSolid; info.flags |= PF.NotSolid; }
        info._face = face;
        const ring = map.faceVertices(face).map((p) => toUE(add(p, job.offset)));
        if (ring.length < 3) { skip("degenerate"); surfs.pop(); continue; }
        descend(rootNode, ring, info, 0, []);
        inserted++;
      }
    }
    stats.insertedFaces = inserted;
    stats.fragments = fragments;
    stats.droppedFragments = dropped;
  }

  // --- lightmap atlases ---------------------------------------------------------------------------
  const packer = new AtlasPacker(ATLAS);
  const pageRGB = [];
  const px = [0, 0, 0];
  for (const blk of faceBlocks) {
    const at = packer.alloc(blk.sizeX, blk.sizeY);
    while (pageRGB.length <= at.page) pageRGB.push(Buffer.alloc(ATLAS * ATLAS * 3));
    const page = pageRGB[at.page];
    for (let j = 0; j < blk.sizeY; j++) {
      for (let i = 0; i < blk.sizeX; i++) {
        const world_ = add(add(blk.baseWorld, mul(blk.xAxis, i)), mul(blk.yAxis, j));
        sampleHL(blk.hl, blk.ti, world_, px, blk.offsetHL);
        const d = ((at.y + j) * ATLAS + (at.x + i)) * 3;
        page[d] = px[0]; page[d + 1] = px[1]; page[d + 2] = px[2];
      }
    }
    const Xn = mul(blk.xAxis, 1 / Math.max(1e-9, dot(blk.xAxis, blk.xAxis)));
    const Yn = mul(blk.yAxis, 1 / Math.max(1e-9, dot(blk.yAxis, blk.yAxis)));
    const Zn = mul(surfs[blk.iSurf].plane, -1);
    const B = blk.baseWorld;
    const iLightMap = lightMaps.length;
    lightMaps.push({
      iTexture: at.page, iSurf: blk.iSurf, iZone: 1,
      offsetX: at.x, offsetY: at.y, sizeX: blk.sizeX, sizeY: blk.sizeY,
      worldToLightMap: [
        Xn[0], Yn[0], Zn[0], 0,
        Xn[1], Yn[1], Zn[1], 0,
        Xn[2], Yn[2], Zn[2], 0,
        -dot(B, Xn), -dot(B, Yn), 0, 1,
      ],
      base: B, xAxis: blk.xAxis, yAxis: blk.yAxis, bitmaps: [], level: levelRef, revision: 1,
    });
    surfs[blk.iSurf].iLightMap = iLightMap;
    nodes[blk.node].iLightMap = iLightMap;
    blk.atlas = at;
  }

  // The synthetic split-plane polygons never go through planLightmap, so give them an existing
  // block: the surface is invisible, only the index has to be real.
  // EVERY node, drawable or not — the renderer follows iLightMap without checking NumVertices,
  // exactly as it does with iSection.
  if (lightMaps.length) {
    for (const n of nodes) if (n.iLightMap < 0) n.iLightMap = 0;
    for (const s of surfs) if (s.iLightMap < 0) s.iLightMap = 0;
  }

  // On the mesh route the meshes are the world; the BSP must exist (the renderer reaches actors
  // through it) but must draw nothing except the sky. The BSP renders from render-sections, so the
  // real fix is to zero NumVertices on every hidden node BEFORE sections are built - that keeps its
  // surface out of every section. Masking the texture, PF_Invisible, or hiding after the fact all
  // leave the surface in its section, and it draws flat white over the meshes. Sky keeps its poly.
  if (opts.hideMaterialRef) {
    for (const n of nodes) {
      // The minimal-world node must keep its polygon: UModel::LineCheck walks Verts for every node
      // it visits, and a NumVertices of 0 makes that walk run off the array (see the node itself).
      if (n.keepPolygon) continue;
      const s = surfs[n.iSurf];
      if (s && s.material !== opts.hideMaterialRef) continue;      // sky and split-planes keep theirs
      n.numVertices = 0;
    }
  }

  // --- render sections -----------------------------------------------------------------------------
  const sections = [];
  const sectionKey = new Map();
  for (const n of nodes) {
    if (opts.noSections) break;
    if (n.numVertices < 3) continue;
    const s = surfs[n.iSurf];
    const lmTex = n.iLightMap >= 0 ? lightMaps[n.iLightMap].iTexture : INDEX_NONE;
    const key = s.material + "|" + s.polyFlags + "|" + lmTex;
    let si = sectionKey.get(key);
    if (si === undefined) {
      si = sections.length;
      sections.push({ vertices: [], revision: 1, material: s.material, numNodes: 0, polyFlags: s.polyFlags, iLightMapTexture: lmTex });
      sectionKey.set(key, si);
    }
    const sec = sections[si];
    n.iSection = si;
    n.iFirstVertex = sec.vertices.length;
    sec.numNodes++;
    const uAx = vectors.list[s.vTextureU], vAx = vectors.list[s.vTextureV], base = points.list[s.pBase];
    const tex = opts.texByRef.get(s.material) || { width: 256, height: 256 };
    const lm = n.iLightMap >= 0 ? lightMaps[n.iLightMap] : null;
    const nrm = vectors.list[s.vNormal];
    for (let k = 0; k < n.numVertices; k++) {
      const p = points.list[verts[n.iVertPool + k].pVertex];
      const rel = sub(p, base);
      let u2 = 0, v2 = 0;
      if (lm) {
        // luxel coordinates within the block, then into the atlas. Clamped because a sliver face
        // with near-zero extent can project a fraction of a luxel outside its own block.
        const clamp = (x, hi_) => (x < 0 ? 0 : x > hi_ ? hi_ : x);
        const li = clamp(dot(sub(p, lm.base), mul(lm.xAxis, 1 / dot(lm.xAxis, lm.xAxis))), lm.sizeX - 1);
        const lj = clamp(dot(sub(p, lm.base), mul(lm.yAxis, 1 / dot(lm.yAxis, lm.yAxis))), lm.sizeY - 1);
        u2 = (lm.offsetX + li) / ATLAS;
        v2 = (lm.offsetY + lj) / ATLAS;
      }
      sec.vertices.push({
        pos: p, u: dot(rel, uAx) / tex.width, v: dot(rel, vAx) / tex.height,
        u2, v2, normal: nrm,
      });
    }
  }

  // --- collision hulls ---------------------------------------------------------------------------
  // Non-zero-extent traces (anything with a bounding box, i.e. every pawn) clip against the convex
  // hull hanging off FBspNode.iCollisionBound. Encoding, read off the shipped maps: a run of node
  // indices terminated by -1, bit 0x40000000 meaning "use the flipped plane", and the planes point
  // OUT of the solid — a point inside scores <= 0 against every one of them.
  // The hull of a polygon node is: its own plane un-flipped (solid is behind the face) plus, for
  // each ancestor, that ancestor's plane flipped when the descent went to its front side.
  // Each run is: node indices, the -1 terminator, and then SIX MORE ENTRIES holding the float bits
  // of the region's bounding box. Leaving that box out makes the engine read the following run —
  // and past the end of the array on the last hull — which corrupts the heap and later blows up
  // inside the renderer.
  const MAX_HULL = opts.hullMax || 11;                     // longest run observed in shipped maps
  const HALF_WORLD = 262144;                               // Unreal's world limit, and the box default
  const leafHulls = [];
  const fbits = Buffer.alloc(4);
  const pushFloat = (v) => { fbits.writeFloatLE(v, 0); leafHulls.push(fbits.readInt32LE(0)); };
  for (let i = 0; i < nodes.length && !opts.noHulls; i++) {
    const n = nodes[i];
    if (n.numVertices < 3) continue;
    const path = hullPath.get(i) || [];
    const entries = path.map((p) => (p.front ? (p.node | 0x40000000) : p.node));
    entries.push(i);
    // keep the tightest planes: the node's own plus its nearest ancestors
    const trimmed = entries.length > MAX_HULL ? entries.slice(entries.length - MAX_HULL) : entries;

    // AABB of the half-space intersection: tightened by whichever planes are axis aligned, left at
    // the world limit elsewhere. Too large only costs extra collision tests; too small misses hits.
    const bmin = [-HALF_WORLD, -HALF_WORLD, -HALF_WORLD];
    const bmax = [HALF_WORLD, HALF_WORLD, HALF_WORLD];
    for (const e of trimmed) {
      const nd = nodes[e & ~0x40000000];
      const s = (e & 0x40000000) ? -1 : 1;
      const comp = [nd.plane[0] * s, nd.plane[1] * s, nd.plane[2] * s], w = nd.plane[3] * s;
      for (let ax = 0; ax < 3; ax++) {
        if (comp[ax] > 0.999) bmax[ax] = Math.min(bmax[ax], w);
        else if (comp[ax] < -0.999) bmin[ax] = Math.max(bmin[ax], -w);
      }
    }
    n.iCollisionBound = leafHulls.length;
    for (const e of trimmed) leafHulls.push(e);
    leafHulls.push(-1);
    pushFloat(bmin[0]); pushFloat(bmin[1]); pushFloat(bmin[2]);
    pushFloat(bmax[0]); pushFloat(bmax[1]); pushFloat(bmax[2]);
  }

  // Both sides of every node are the open zone.
  //
  // UModel::PointRegion walks the tree and, at the first node whose child on the point's side is
  // INDEX_NONE, returns that side's iZone. In a real BSP the back side of a wall is solid, so
  // iZone[0] = 0 is correct there. This tree is not a real BSP - polygons are pushed into a flat
  // tree, so "behind a polygon's plane" says nothing about solidity - and leaving iZone[0] at 0
  // makes PointRegion answer "zone 0 / solid" for most of the level. Everything that asks the
  // world where a point is then breaks at once:
  //   - actors are drawn per visible zone, so no static mesh is ever drawn (the BSP still is,
  //     because surfaces are drawn by tree traversal instead);
  //   - ULevel::SpawnActor refuses to place the pawn: "Couldn't spawn player ...";
  //   - KFEd's Map Check reports "Navigation point imbedded in level geometry" for every spawn.
  //
  // NOT for the box route: those rooms ARE real convex rooms, and a room says the outside of its
  // walls is solid. skybox-how-to/Sky_CS.rom - a room built by hand in the editor - carries
  // iZone [0, 1] on every one of its six nodes, and forcing [1, 1] over it destroys the only
  // information the traversal has about which side of a wall the viewer is on. It also destroys the
  // sky: a second zone cannot exist if every node claims zone 1 on both sides. So the box route
  // keeps its own zoning ONLY when it was asked to build a sky zone - see the leaf pass below for
  // why that shape is still not the default.
  if (!(rooms && rooms.length > 1)) for (const n of nodes) { n.iZone = [1, 1]; }

  // No shipped map contains a node with NumVertices == 0, so the renderer is not guaranteed to
  // check before following iSection. Split-only nodes get a valid (empty) slot instead of -1.
  if (sections.length) {
    for (const n of nodes) {
      if (n.numVertices >= 3) continue;
      n.iSection = 0;
      n.iFirstVertex = 0;
      if (n.iSurf < 0 || n.iSurf >= surfs.length) n.iSurf = 0;
    }
  }

  // --- leaves, zones, bounds -------------------------------------------------------------------------
  // Model.Lights is a pool of concatenated, None-terminated light lists; a leaf's iPermeating and
  // iVolumetric are start indices into it. Put every light in one list at 0 and a bare terminator
  // after it, so "lights reaching this leaf" is all of them and "volumetric" is empty.
  const lights = [...(opts.lightRefs || []), 0];
  const VOLUMETRIC = lights.length - 1;
  const leaf = (zone) => ({ iZone: zone, iPermeating: 0, iVolumetric: VOLUMETRIC, visibleZones: [0xffffffff, 0xffffffff] });
  const leaves = rooms ? rooms.map((r) => leaf(r.zone)) : [leaf(1)];

  // Every node's open side terminates at that leaf. The renderer reaches a static-mesh actor
  // through the leaf its Region resolves to, so a tree whose iLeaf is INDEX_NONE everywhere draws
  // its BSP surfaces (tree traversal) but never draws a single actor.
  // Same exception: the room already points only its LAST node's open side at the leaf, exactly
  // as the hand-built reference does. Every node claiming leaf 0 on both sides is a flat-tree fix.
  //
  // Measured three times now, and the last two are not explained by 2.12 - that bug was already
  // fixed when they were taken. Any shape where a node does NOT claim leaf 0 on BOTH sides brings
  // back the frames where the world does not draw: hanging the leaf off the last node of the chain
  // (the hand-built room's shape), and naming the enclosing room's leaf on the back side. Both are
  // "correct" for a BSP whose geometry is its own surfaces. This level's geometry is actors, and an
  // actor is reached through the leaf of a node the walk visits, so the leaf has to be everywhere
  // the walk can land. Whatever else changes here, that stays.
  if (!(rooms && rooms.length > 1)) for (const n of nodes) n.iLeaf = [0, 0];

  // ZoneMask marks which zones live under a node; the renderer uses it to skip whole subtrees.
  // Computed bottom-up so it is exact rather than "all 64 zones".
  (function computeZoneMasks() {
    const seen = new Uint8Array(nodes.length);
    const visit = (idx) => {
      if (idx === INDEX_NONE || seen[idx]) return nodes[idx] ? nodes[idx].zoneMask[0] : 0;
      seen[idx] = 1;
      const n = nodes[idx];
      let mask = (1 << n.iZone[0]) | (1 << n.iZone[1]);
      mask |= visit(n.iFront) | visit(n.iBack) | visit(n.iPlane);
      n.zoneMask = [mask >>> 0, 0];
      return mask >>> 0;
    };
    for (let i = 0; i < nodes.length; i++) visit(i);
  })();
  // Zone 0 is the null zone (solid). Zone 1 is the level. A sky room, when there is one, is zone 2
  // and its ZoneActor is the SkyZoneInfo - that is the whole mechanism behind PF_FakeBackdrop: the
  // renderer draws the contents of the zone whose ZoneActor is a SkyZoneInfo through every backdrop
  // surface. A backdrop surface with no such zone to project draws solid white.
  const zones = [
    { zoneActor: 0, connectivity: [1, 0], visibility: [0xffffffff, 0xffffffff], lastRenderTime: 0 },
    { zoneActor: opts.zoneInfoRef || 0, connectivity: [2, 0], visibility: [0xffffffff, 0xffffffff], lastRenderTime: 0 },
  ];
  if (rooms && rooms.length > 1) {
    zones.push({ zoneActor: opts.skyZoneRef || 0, connectivity: [4, 0], visibility: [0xffffffff, 0xffffffff], lastRenderTime: 0 });
  }

  // Bounds: the box a node's WHOLE SUBTREE occupies, referenced by iRenderBound.
  //
  // This is a subtree bound, not the node's own polygon. The renderer tests it against the view
  // frustum and, when it misses, skips the node AND everything below it. Filling it with just the
  // node's own polygon is therefore not a smaller optimisation - it is a lie about where the rest
  // of the tree is, and the engine believes it: the moment the root node's own polygon left the
  // frustum, the entire level was culled. Nothing drew at all - no BSP surface, no static mesh, no
  // actor - while the HUD and the first-person weapon, which are not drawn through the tree, stayed
  // on screen. That is the flat frame that took this long to find, and it is why it depended on
  // where the view pointed, why it hit the mesh route and the BSP route alike, and why no shipped
  // map has it: their bounds come from the editor, which computes them bottom-up.
  const bounds = [];
  const subtree = new Array(nodes.length).fill(null);
  const inProgress = new Uint8Array(nodes.length);
  function boundOf(idx) {
    if (idx === INDEX_NONE || !nodes[idx]) return null;
    if (subtree[idx]) return subtree[idx];
    if (inProgress[idx]) return null;                 // guards against a malformed cycle
    inProgress[idx] = 1;
    const n = nodes[idx];
    const mn = [Infinity, Infinity, Infinity], mxb = [-Infinity, -Infinity, -Infinity];
    const eat = (b) => {
      if (!b) return;
      for (let c = 0; c < 3; c++) { if (b.min[c] < mn[c]) mn[c] = b.min[c]; if (b.max[c] > mxb[c]) mxb[c] = b.max[c]; }
    };
    for (let k = 0; k < n.numVertices; k++) {
      const p = points.list[verts[n.iVertPool + k].pVertex];
      for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mxb[c]) mxb[c] = p[c]; }
    }
    eat(boundOf(n.iFront)); eat(boundOf(n.iBack)); eat(boundOf(n.iPlane));
    inProgress[idx] = 0;
    subtree[idx] = Number.isFinite(mn[0]) ? { min: mn, max: mxb, valid: 1 } : null;
    return subtree[idx];
  }
  for (let i = 0; i < nodes.length; i++) boundOf(i);
  nodes.forEach((n, i) => {
    if (n.numVertices < 3 || !subtree[i]) return;
    n.iRenderBound = bounds.length;
    bounds.push(subtree[i]);
  });

  const bbMin = toUE(world.mins), bbMax = toUE(world.maxs);
  const lo = [Math.min(bbMin[0], bbMax[0]), Math.min(bbMin[1], bbMax[1]), Math.min(bbMin[2], bbMax[2])];
  const hi = [Math.max(bbMin[0], bbMax[0]), Math.max(bbMin[1], bbMax[1]), Math.max(bbMin[2], bbMax[2])];
  const centre = mul(add(lo, hi), 0.5);

  // Every shipped map stores an empty UPrimitive bounding box and sphere (valid = 0) — the engine
  // derives them itself. Writing a filled-in one is the single field where this differed.
  void lo; void hi; void centre;
  const model = {
    bbox: { min: [0, 0, 0], max: [0, 0, 0], valid: 0 },
    bsphere: { center: [0, 0, 0], radius: 0 },
    vectors: vectors.list, points: points.list, nodes, surfs, verts,
    numSharedSides: 0, zones, polys: opts.polysRef || 0,
    bounds, leafHulls, leaves, lights,
    // RootOutside says what the space OUTSIDE the tree is: 0 = solid rock, 1 = open air. Every
    // shipped map and every hand-built port carries 0, and that is not decoration - it is the
    // premise the editor's CSG works from. bspBrushCSG filters a subtract brush's polygons through
    // the world tree, and subtracting air from air produces nothing: Build Geometry composed our
    // one brush (measured: bspBrushCSG entered once) and came back with an empty model, every time.
    // KF_ROOT_OUTSIDE forces either value.
    rootOutside: process.env.KF_ROOT_OUTSIDE !== undefined ? +process.env.KF_ROOT_OUTSIDE : 0,
    linked: 0, sections, lightMaps, lightMapTextures: [],
  };

  return { model, atlasPages: pageRGB, atlasSize: ATLAS, stats };
}

module.exports = { buildModel, worldBox, PF, INDEX_NONE };
