// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Source engine BSP -> Killing Floor .rom. Reads the world geometry (src/source/bsp.js) into the
// glTF route's scene shape and hands it to that route's builder, so the whole KF skeleton, texture,
// sky, light and verify path is shared. Source is Z-up like GoldSrc, so it feeds axes [0,1,2] with a
// Y flip and the GoldSrc pawn-fit scale.
"use strict";

const fs = require("fs");
const path = require("path");
const { loadSourceScene, angleMatrix } = require("./bsp");
const { openGameVpks } = require("./vpk");
const gltf = require("../gltf/convert");

const SCALE = 1.9165;   // GoldSrc units -> Unreal; Source uses the same units

// A model becomes one or more shared StaticMeshes: its vertices are the source-local geometry mapped
// to KF space (mirror Y + scale, winding reversed); the per-instance rotation is on the actor. The
// index stream and section firstIndex are 16-bit, so a model over ~65000 indices is split into parts
// (each keeps the full vertex pool - the models this hits have <65000 verts). Returns an array of
// mesh objects (usually one).
const MAX_IDX = 63000;
const MAX_VERTS = 65000;

// A prop over the 16-bit vertex limit: split it into parts that each keep only the vertices their own
// triangles use (a per-part remap), so nothing is dropped. Kept separate from the fast common path
// below - only models over 65000 vertices reach here, and none of the tested maps do, so this must
// not perturb the ordinary case. Reversed winding matches buildPropMesh. (test/source.test.js checks
// the split on a synthetic oversized mesh.)
function splitLargeProp(pm, scale) {
  const tv = (v) => ({ pos: [v.pos[0] * scale, -v.pos[1] * scale, v.pos[2] * scale], normal: [v.normal[0], -v.normal[1], v.normal[2]], uv: v.uv });
  const parts = [];
  let cur = null;
  const start = () => { cur = { vertices: [], uvs: [], colors: [], indices: [], sections: [], materialIndices: [], remap: new Map(), curMat: -1, secFirst: 0 }; parts.push(cur); };
  const closeSection = () => {
    if (cur && cur.curMat >= 0 && cur.indices.length > cur.secFirst) {
      cur.sections.push({ f0: 0, firstIndex: cur.secFirst, firstVertex: 0, lastVertex: cur.vertices.length - 1, u4: 0, numFaces: (cur.indices.length - cur.secFirst) / 3 });
      cur.materialIndices.push(cur.curMat);
    }
  };
  const vidx = (oldI) => {
    let ni = cur.remap.get(oldI);
    if (ni === undefined) { const v = tv(pm.verts[oldI]); ni = cur.vertices.length; cur.vertices.push({ pos: v.pos, normal: v.normal }); cur.uvs.push(v.uv); cur.colors.push([0, 0, 0, 255]); cur.remap.set(oldI, ni); }
    return ni;
  };
  for (const sm of pm.submeshes) {
    for (let i = 0; i + 2 < sm.indices.length; i += 3) {
      if (!cur || cur.vertices.length + 3 > MAX_VERTS || cur.indices.length / 3 + 1 > MAX_IDX / 3) { closeSection(); start(); }
      if (cur.curMat !== sm.material) { closeSection(); cur.curMat = sm.material; cur.secFirst = cur.indices.length; }
      cur.indices.push(vidx(sm.indices[i]), vidx(sm.indices[i + 2]), vidx(sm.indices[i + 1]));   // reversed winding
    }
  }
  closeSection();
  return parts.filter((p) => p.vertices.length >= 3 && p.indices.length >= 3).map((p) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of p.vertices) for (let k = 0; k < 3; k++) { if (v.pos[k] < lo[k]) lo[k] = v.pos[k]; if (v.pos[k] > hi[k]) hi[k] = v.pos[k]; }
    const center = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    return { vertices: p.vertices, uvs: p.uvs, colors: p.colors, indices: p.indices, sections: p.sections, materialIndices: p.materialIndices, bbox: { min: lo, max: hi }, center, radius: Math.hypot(hi[0] - center[0], hi[1] - center[1], hi[2] - center[2]) };
  });
}

function buildPropMesh(pm, scale) {
  if (pm.verts.length > 65000) return splitLargeProp(pm, scale);   // split rather than drop
  const vertices = pm.verts.map((v) => ({ pos: [v.pos[0] * scale, -v.pos[1] * scale, v.pos[2] * scale], normal: [v.normal[0], -v.normal[1], v.normal[2]] }));
  const uvs = pm.verts.map((v) => v.uv);
  const colors = pm.verts.map(() => [0, 0, 0, 255]);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) for (let k = 0; k < 3; k++) { if (v.pos[k] < lo[k]) lo[k] = v.pos[k]; if (v.pos[k] > hi[k]) hi[k] = v.pos[k]; }
  const center = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const bbox = { min: lo, max: hi }, radius = Math.hypot(hi[0] - center[0], hi[1] - center[1], hi[2] - center[2]);

  const parts = [];
  let cur = null;
  const startPart = () => { cur = { indices: [], sections: [], materialIndices: [] }; parts.push(cur); };
  for (const sm of pm.submeshes) {
    const tris = [];
    for (let i = 0; i + 2 < sm.indices.length; i += 3) tris.push(sm.indices[i], sm.indices[i + 2], sm.indices[i + 1]);   // reversed winding
    let off = 0;
    while (off < tris.length) {
      if (!cur || cur.indices.length >= MAX_IDX - 3) startPart();
      const take = Math.min(Math.floor((MAX_IDX - cur.indices.length) / 3) * 3, tris.length - off);
      const firstIndex = cur.indices.length;
      for (let k = 0; k < take; k++) cur.indices.push(tris[off + k]);
      cur.sections.push({ f0: 0, firstIndex, firstVertex: 0, lastVertex: vertices.length - 1, u4: 0, numFaces: take / 3 });
      cur.materialIndices.push(sm.material);
      off += take;
    }
  }
  return parts.map((part) => ({ vertices, uvs, colors, indices: part.indices, sections: part.sections, materialIndices: part.materialIndices, bbox, center, radius }));
}

// The prop's Source rotation, expressed as a KF (Unreal) rotator (pitch, yaw, roll in 65536 units).
//
// Source AngleMatrix stores the prop's axes in its COLUMNS (forward = col 0, up = col 2). The KF map
// mirrors Y (A = diag(1,-1,1)), so each axis transforms as A·axis - and mirroring turns the
// right-handed frame left-handed, so the right axis is rebuilt as up x forward to stay a proper
// rotation KF can express. Unreal's rotation matrix keeps the axes in its ROWS, so the rotator reads
// straight off f/right/up. This matches the -yaw the player-start code already uses; the earlier
// row/column mix-up only looked right on rotationally symmetric props (trees, rocks) and skewed the
// oriented ones (crates, railings).
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function kfRotator(angles) {
  const M = angleMatrix(angles);
  const F = [M[0][0], M[1][0], M[2][0]];   // Source forward (column 0)
  const U = [M[0][2], M[1][2], M[2][2]];   // Source up (column 2)
  const f = norm3([F[0], -F[1], F[2]]);    // KF forward, mirrored on Y
  const up = norm3([U[0], -U[1], U[2]]);   // KF up
  const right = norm3(cross3(up, f));       // Unreal right = up x forward (left-handed)
  const yaw = Math.atan2(f[1], f[0]);
  const pitch = Math.atan2(f[2], Math.hypot(f[0], f[1]));
  const roll = Math.atan2(-right[2], up[2]);
  const u = (a) => Math.round(a / Math.PI * 32768) & 0xffff;
  return [u(pitch), u(yaw), u(roll)];
}

// Where the map's textures live: any ancestor folder with a *_dir.vpk (the game's own content -
// cstrike/, left4dead2/, garrysmod/), plus Half-Life 2/hl2 for the shared Source base textures.
function findVpkDirs(bspFile) {
  const dirs = [];
  let d = path.dirname(path.resolve(bspFile));
  for (let i = 0; i < 5 && d; i++) {
    try { if (fs.readdirSync(d).some((f) => /_dir\.vpk$/i.test(f))) dirs.push(d); } catch (e) { }
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  const m = /^(.*[\\/]common)[\\/]/i.exec(path.resolve(bspFile));
  if (m) for (const base of ["Half-Life 2/hl2", "Half-Life 2/hl2_textures"]) {
    const p = path.join(m[1], base); try { if (fs.existsSync(p)) dirs.push(p); } catch (e) { }
  }
  return dirs;
}

function convert(opts) {
  const o = Object.assign({}, opts);
  const gameVpks = o.noTextures ? null : openGameVpks(findVpkDirs(o.file), o.log);
  if (o.log && gameVpks) o.log("textures: searching " + gameVpks.count + " game VPK archive(s) + the map's pakfile");
  const scene = loadSourceScene(o.file, o.log, { gameVpks, grass: o.grass });
  const baseName = path.basename(o.file).replace(/\.bsp$/i, "");
  const S = o.scale || SCALE;
  // Source spawns -> KF space (axes [0,1,2] flip Y); +44 lifts the pawn's centre off the floor, and
  // the Y mirror reverses the yaw.
  const spawns = (scene.spawns || []).slice(0, 32).map((s) => ({
    loc: [s.origin[0] * S, -s.origin[1] * S, s.origin[2] * S + 44],
    yaw: Math.round((-s.yaw / 360) * 65536) & 0xffff,
  }));
  // Static props: one shared StaticMesh per model, a lightweight actor per placement. A prop the map
  // marked SOLID_NONE (grass, foliage) is placed without collision so the player can walk through it.
  const propMeshes = (scene.propModels || []).map((pm) => buildPropMesh(pm, S));
  const propInstances = (scene.propInstances || []).map((pi) => ({
    model: pi.model, location: [pi.origin[0] * S, -pi.origin[1] * S, pi.origin[2] * S], rotation: kfRotator(pi.angles),
    collide: pi.solid !== 0,
  }));
  // Source maps carry no KF lights, so they lean on the zone ambient + per-actor glow; with the
  // ~2.5x unlit overbright that reads as a white-out (the "пересвечено" reports). Dial texture gain
  // and the ambient/glow floors down for this route - midway between the raw values and the first
  // (too-dark) pass - unless the caller/env overrides them.
  const bright = {
    texGain: o.texGain !== undefined ? o.texGain : +(process.env.KF_TEX_GAIN || 0.57),
    ambient: o.ambient !== undefined ? o.ambient : +(process.env.KF_AMBIENT || 52),
    glow: o.glow !== undefined ? o.glow : +(process.env.KF_GLOW || 34),
  };
  // A DBD realm is a few hundred thousand prop triangles; KF has no automatic distance culling, so far
  // props tank the framerate when looking down a long sightline. Cull each prop actor past a distance
  // (0 = never); the world brushes always draw so the level shell never pops.
  const cullDistance = o.cullDistance !== undefined ? o.cullDistance : +(process.env.KF_CULL_DIST || 8000);
  return gltf.convert(Object.assign({}, o, bright, {
    scene, file: null, baseName, cullDistance,
    axes: [0, 1, 2], flip: [0, 1, 0],
    scale: S, spawns, propMeshes, propInstances,
    title: baseName + " (Source)",
  }));
}

module.exports = { convert, kfRotator, splitLargeProp };
