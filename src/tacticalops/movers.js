// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Movers: the doors, gates, lifts and glass panes a Tactical Ops map keeps OUT of its BSP.
//
// A mover is an actor with a UModel of its own, and the only copy of its geometry is that model's
// UPolys - the CSG source polygons, in the brush's own space, waiting to be placed by the actor's
// Location, Rotation and the two scales UnrealEd carries. So a mover is read the way the editor
// reads it: transform the polygons, triangulate, and hand back one mesh per mover.
//
// 400 movers over the 34 stock maps, 5569 polygons between them - and a third of the doors in
// TO-TerrorMansion alone.
"use strict";

const { readModel, readPolys, PF } = require("./model");
const { tagsOf, pick, all, val, readTags } = require("../lineage2/props");

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Unreal's rotator to the three axis vectors the editor builds a brush's coordinates from.
function axesOf(rot) {
  const t = Math.PI * 2 / 65536;
  const p = rot[0] * t, y = rot[1] * t, r = rot[2] * t;
  const SP = Math.sin(p), CP = Math.cos(p), SY = Math.sin(y), CY = Math.cos(y), SR = Math.sin(r), CR = Math.cos(r);
  return [
    [CP * CY, CP * SY, SP],
    [SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP],
    [-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP],
  ];
}

// The `Scale` struct is a tagged block of its own: a vector, a sheer rate and the axis it sheers on.
function scaleOf(pkg, tag) {
  if (!tag) return [1, 1, 1];
  const { tags } = readTags(pkg, tag.at, tag.at + tag.size);
  const v = pick(tags, "Scale");
  return v ? val.vector(pkg, v) : [1, 1, 1];
}

// Every mover in the package, with its geometry already in world space.
//
// `materialFor(textureRef, polyFlags)` is the caller's texture resolver - the same one the world
// surfaces go through, so a door shares its wall's texture rather than registering a second copy.
function readMovers(pkg, opts) {
  const scale = opts.scale;
  const materialFor = opts.materialFor;
  const out = [];
  const stats = { movers: 0, failed: 0, polys: 0, triangles: 0, doors: 0, glass: 0 };

  pkg.exports.forEach((exp, i) => {
    const cls = pkg.classOf(exp);
    if (!/Mover$/.test(cls) || exp.serialSize <= 0) return;
    let tags;
    try { tags = tagsOf(pkg, exp).tags; } catch (e) { stats.failed++; return; }
    const brushTag = pick(tags, "Brush");
    if (!brushTag) { stats.failed++; return; }
    let polys;
    try {
      const bRef = val.ref(pkg, brushTag);
      const bExp = bRef > 0 ? pkg.exports[bRef - 1] : null;
      const model = readModel(pkg, bExp);
      const pExp = model.polys > 0 ? pkg.exports[model.polys - 1] : null;
      polys = readPolys(pkg, pExp);
    } catch (e) { stats.failed++; return; }
    if (!polys.length) { stats.failed++; return; }

    const loc = pick(tags, "Location") ? val.vector(pkg, pick(tags, "Location")) : [0, 0, 0];
    const rot = pick(tags, "Rotation") ? val.rotator(pkg, pick(tags, "Rotation")) : [0, 0, 0];
    const prePivot = pick(tags, "PrePivot") ? val.vector(pkg, pick(tags, "PrePivot")) : [0, 0, 0];
    const main = scaleOf(pkg, pick(tags, "MainScale"));
    const post = scaleOf(pkg, pick(tags, "PostScale"));
    const axes = axesOf(rot);
    // The editor's own order: pre-pivot, main scale, rotation, post scale, then the location.
    const place = (v) => {
      const s = [(v[0] - prePivot[0]) * main[0], (v[1] - prePivot[1]) * main[1], (v[2] - prePivot[2]) * main[2]];
      const r = [0, 1, 2].map((k) => s[0] * axes[0][k] + s[1] * axes[1][k] + s[2] * axes[2][k]);
      return [0, 1, 2].map((k) => (loc[k] + r[k] * post[k]) * scale);
    };

    // One mesh per mover, sectioned by material: splitting a door by texture would give it two
    // halves that open independently.
    const mesh = {
      materials: [], vertices: [], uvs: [], uvs2: [], colors: [], indices: [], sections: [],
    };
    const byMaterial = new Map();
    for (const poly of polys) {
      if (poly.vertices.length < 3) continue;
      if (poly.polyFlags & PF.Invisible) continue;
      const tex = materialFor(poly.texture, poly.polyFlags);
      if (!tex || !tex.ref) continue;
      stats.polys++;
      let list = byMaterial.get(tex.ref);
      if (!list) { list = { tex, tris: [] }; byMaterial.set(tex.ref, list); }
      // UVs are computed in the brush's own space, where the poly's axes live; a rotation does not
      // change a dot product, and the scales are 1 on all but a handful of the stock movers.
      const ring = poly.vertices.map((v) => ({
        pos: place(v),
        uv: [
          (dot(sub(v, poly.base), poly.textureU) + poly.panU) / (tex.origWidth || 256),
          (dot(sub(v, poly.base), poly.textureV) + poly.panV) / (tex.origHeight || 256),
        ],
      }));
      const n = [0, 1, 2].map((k) => poly.normal[0] * axes[0][k] + poly.normal[1] * axes[1][k] + poly.normal[2] * axes[2][k]);
      // The fan runs AGAINST the poly's outward normal, and the vertex normal is that normal
      // negated: Killing Floor shows the side of a triangle its winding points away from, which is
      // why a world node's ring has to be reversed too (mesh.js). A poly's own ring may run either
      // way round, so this orients rather than reverses.
      const a = ring[0].pos, b = ring[1].pos, c = ring[2].pos;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const flip = cx * n[0] + cy * n[1] + cz * n[2] > 0;
      const facing = [-n[0], -n[1], -n[2]];
      for (let k = 2; k < ring.length; k++) {
        const tri = flip ? [ring[0], ring[k], ring[k - 1]] : [ring[0], ring[k - 1], ring[k]];
        const e1 = sub(tri[1].pos, tri[0].pos), e2 = sub(tri[2].pos, tri[0].pos);
        const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        if (nx * nx + ny * ny + nz * nz <= 1.0) continue;          // a sliver, as in mesh.js
        list.tris.push({ tri, normal: facing });
        stats.triangles++;
      }
    }
    if (!byMaterial.size) { stats.failed++; return; }

    for (const [ref, list] of byMaterial) {
      const firstIndex = mesh.indices.length, firstVertex = mesh.vertices.length;
      for (const t of list.tris) {
        for (const v of t.tri) {
          mesh.indices.push(mesh.vertices.length);
          mesh.vertices.push({ pos: v.pos, normal: t.normal });
          mesh.uvs.push(v.uv);
          mesh.uvs2.push([0, 0]);
          mesh.colors.push([0, 0, 0, 255]);
        }
      }
      mesh.materials.push(ref);
      mesh.sections.push({
        f0: 0, firstIndex, firstVertex, lastVertex: Math.max(firstVertex, mesh.vertices.length - 1),
        u4: 0, numFaces: list.tris.length,
      });
    }
    if (mesh.vertices.length < 3) { stats.failed++; return; }

    // Local space, like every other mesh here: the engine culls with a sphere around the ACTOR.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of mesh.vertices) for (let k = 0; k < 3; k++) {
      if (v.pos[k] < lo[k]) lo[k] = v.pos[k];
      if (v.pos[k] > hi[k]) hi[k] = v.pos[k];
    }
    const origin = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    for (const v of mesh.vertices) v.pos = [0, 1, 2].map((k) => v.pos[k] - origin[k]);
    mesh.origin = origin;
    mesh.bbox = { min: [0, 1, 2].map((k) => lo[k] - origin[k]), max: [0, 1, 2].map((k) => hi[k] - origin[k]) };
    mesh.center = [0, 0, 0];
    mesh.radius = Math.hypot(mesh.bbox.max[0], mesh.bbox.max[1], mesh.bbox.max[2]);

    // Where it moves to. UE1 keeps the keys as offsets from BasePos, so key 1 is the open position
    // relative to the closed one - which is exactly what a KFDoorMover's KeyPos(1) means too.
    const keys = all(tags, "KeyPos");
    const key1 = keys.find((t) => t.index === 1);
    const rots = all(tags, "KeyRot");
    const rot1 = rots.find((t) => t.index === 1);
    const move = key1 ? val.vector(pkg, key1).map((c) => c * scale) : [0, 0, 0];
    const turn = rot1 ? val.rotator(pkg, rot1) : [0, 0, 0];
    const moves = Math.hypot(move[0], move[1], move[2]) > 1 || turn.some((c) => c !== 0);
    const moveTime = pick(tags, "MoveTime") ? val.float(pkg, pick(tags, "MoveTime")) : 1;
    const glass = /Glass/i.test(cls);

    stats.movers++;
    if (glass) stats.glass++; else if (moves) stats.doors++;
    out.push({
      name: exp.name, cls, mesh,
      // Glass stays where it is: in Tactical Ops it is shot out rather than opened, and a pane that
      // swings aside on the use key is a door nobody built.
      door: moves && !glass,
      move, turn, moveTime: moveTime > 0 ? moveTime : 1,
      tag: "TOMover" + i,
    });
  });

  return { movers: out, stats };
}

module.exports = { readMovers, axesOf };
