// UPolys: the convex faces a brush actor is made of.
//
// A Volume or a Mover is an ABrush, and an ABrush with `Brush = None` has no shape at all - it
// loads, it sits in the level, and nothing ever touches it. That is why the first attempt at
// swimmable water did nothing: a PhysicsVolume with only CollisionRadius/Height set is inert. The
// shape has to come from a UModel whose Polys hold the brush's faces.
//
// Layout (UE1's, still in use at v128 - the count comes FIRST, before Base):
//   cidx NumVertices, FVector Base, Normal, TextureU, TextureV, FVector Vertices[NumVertices],
//   DWORD PolyFlags, cidx Actor, cidx Texture, cidx ItemName, cidx iLink, cidx iBrushPoly,
//   SWORD PanU, SWORD PanV
// Confirmed byte-exact against 70k polys in 12 shipped maps (test/selfcheck.js repeats the check).
"use strict";

const { Writer } = require("./writer");

// A poly's own texture axes. Any orthogonal pair works - a volume is never drawn - but they must
// not be degenerate, because the editor divides by them.
function axesFor(normal) {
  const up = Math.abs(normal[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = [
    up[1] * normal[2] - up[2] * normal[1],
    up[2] * normal[0] - up[0] * normal[2],
    up[0] * normal[1] - up[1] * normal[0],
  ];
  const v = [
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ];
  return [u, v];
}

// The six faces of an axis-aligned box, normals pointing OUT of the solid, in brush-local space.
function boxPolys(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    { n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { n: [1, 0, 0], v: [[x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [x1, y0, z0]] },
    { n: [0, -1, 0], v: [[x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y0, z0]] },
    { n: [0, 1, 0], v: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
    { n: [0, 0, -1], v: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
    { n: [0, 0, 1], v: [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]] },
  ];
  return faces.map((f) => {
    const [u, v] = axesFor(f.n);
    return { base: f.v[0], normal: f.n, textureU: u, textureV: v, vertices: f.v };
  });
}

function writePolys(pkg, polys) {
  const w = new Writer(64 + polys.length * 160);
  w.cidx(pkg.names.none);                          // empty property block
  w.i32(polys.length).i32(polys.length);           // Num, Max
  for (const p of polys) {
    w.cidx(p.vertices.length);
    w.vec(p.base); w.vec(p.normal); w.vec(p.textureU); w.vec(p.textureV);
    for (const v of p.vertices) w.vec(v);
    w.u32(p.polyFlags || 0);
    w.cidx(p.actor || 0).cidx(p.texture || 0).cidx(p.itemName || 0);
    w.cidx(p.iLink === undefined ? -1 : p.iLink).cidx(p.iBrushPoly === undefined ? -1 : p.iBrushPoly);
    w.i16(0).i16(0);                               // PanU, PanV
  }
  return w;
}

// The BSP a brush actor needs, for a box.
//
// Polys alone are not enough: a Volume whose Brush model has zero nodes is inert (measured - the
// map rendered identically with the volumes removed). The 71-byte models in the shipped maps are
// the red builder brush; a working BlockingVolume's model carries 6 nodes, 6 surfs, 8 points, a
// leaf hull and rootOutside = 1. This reproduces that shape.
//
// The six planes face OUT, the solid is behind all of them, so the tree is a chain down iBack.
// Collision comes from the leaf hull hanging off the last node: the six node indices, a -1, and the
// bounding box as six floats (see ../../docs/GOTCHAS.md 2.3).
const HALF_WORLD = 262144;

function boxBrushModel(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  // Order and sign as the shipped models use: -X, +Y, +X, -Y, +Z, -Z.
  const planes = [
    [-1, 0, 0, -x0], [0, 1, 0, y1], [1, 0, 0, x1], [0, -1, 0, -y0], [0, 0, 1, z1], [0, 0, -1, -z0],
  ];
  const corners = [];
  const pointIndex = (p) => {
    for (let i = 0; i < corners.length; i++) {
      if (Math.abs(corners[i][0] - p[0]) < 1e-4 && Math.abs(corners[i][1] - p[1]) < 1e-4 && Math.abs(corners[i][2] - p[2]) < 1e-4) return i;
    }
    corners.push(p);
    return corners.length - 1;
  };
  const faceCorners = [
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [x1, y0, z0]],
    [[x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]],
  ];

  const vectors = [], points = [], nodes = [], surfs = [], verts = [];
  const vecIndex = (v) => {
    for (let i = 0; i < vectors.length; i++) {
      if (Math.abs(vectors[i][0] - v[0]) < 1e-6 && Math.abs(vectors[i][1] - v[1]) < 1e-6 && Math.abs(vectors[i][2] - v[2]) < 1e-6) return i;
    }
    vectors.push(v);
    return vectors.length - 1;
  };

  planes.forEach((pl, i) => {
    const n = [pl[0], pl[1], pl[2]];
    let ring = faceCorners[i];
    // Wind the ring so the cross product of its first two edges points along the plane normal;
    // getting this backwards makes the brush inside out and it stops enclosing anything.
    const e1 = [ring[1][0] - ring[0][0], ring[1][1] - ring[0][1], ring[1][2] - ring[0][2]];
    const e2 = [ring[2][0] - ring[1][0], ring[2][1] - ring[1][1], ring[2][2] - ring[1][2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] < 0) ring = ring.slice().reverse();

    const iVertPool = verts.length;
    const idx = ring.map((p) => pointIndex(p));
    for (const k of idx) verts.push({ pVertex: k, iSide: -1 });

    const [u, v] = axesFor(n);
    surfs.push({
      material: 0, polyFlags: 0,
      pBase: idx[0], vNormal: vecIndex(n), vTextureU: vecIndex(u), vTextureV: vecIndex(v),
      iLightMap: -1, actor: 0, plane: pl, lightMapScale: 32,
    });
    const centre = ring.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
    nodes.push({
      plane: pl, zoneMask: [0, 0], nodeFlags: 0,
      iVertPool, iSurf: i,
      iBack: i < 5 ? i + 1 : -1, iFront: -1, iPlane: -1,
      iCollisionBound: i === 5 ? 0 : -1,
      iRenderBound: i < 5 ? 4 - i : -1,
      sphere: { center: centre, radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 },
      iZone: [0, 0], numVertices: 4, iLeaf: [-1, -1],
      iSection: -1, iFirstVertex: 0, iLightMap: -1,
    });
  });
  for (const c of corners) points.push(c);

  // The hull the collision trace actually uses: node indices, terminator, then the box as floats.
  const f2i = (f) => { const b = Buffer.alloc(4); b.writeFloatLE(f); return b.readInt32LE(); };
  const leafHulls = [0, 1, 2, 3, 4, 5, -1, f2i(x0), f2i(y0), f2i(z0), f2i(x1), f2i(y1), f2i(z1)];
  const wide = { min: [-HALF_WORLD, -HALF_WORLD, -HALF_WORLD], max: [HALF_WORLD, HALF_WORLD, HALF_WORLD], valid: 1 };

  return {
    bbox: { min, max, valid: 1 },
    bsphere: { center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 },
    vectors, points, nodes, surfs, verts,
    numSharedSides: 4, zones: [], polys: 0,
    bounds: [wide, wide, wide, wide, wide], leafHulls, leaves: [], lights: [],
    rootOutside: 1, linked: 0, sections: [], lightMaps: [], lightMapTextures: [],
  };
}

module.exports = { writePolys, boxPolys, boxBrushModel };
