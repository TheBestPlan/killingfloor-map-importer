// Serializer for the UE2.5 v128 UModel. Mirrors read.js field for field; the round-trip test in
// test/selfcheck.js reads a shipped map with read.js, writes it back with this, and compares bytes.
"use strict";

const { Writer } = require("./writer");

function writeModel(pkg, m) {
  const w = new Writer(1 << 20);
  w.cidx(pkg.names.none);                                  // empty property block
  w.box(m.bbox.min, m.bbox.max, m.bbox.valid);
  w.sphere(m.bsphere.center, m.bsphere.radius);

  w.cidx(m.vectors.length); for (const v of m.vectors) w.vec(v);
  w.cidx(m.points.length); for (const p of m.points) w.vec(p);

  w.cidx(m.nodes.length);
  for (const n of m.nodes) {
    w.plane(n.plane, n.plane[3]);
    w.u32(n.zoneMask[0]).u32(n.zoneMask[1]);
    w.u8(n.nodeFlags);
    w.cidx(n.iVertPool).cidx(n.iSurf);
    w.cidx(n.iBack).cidx(n.iFront).cidx(n.iPlane);
    w.cidx(n.iCollisionBound).cidx(n.iRenderBound);
    w.sphere(n.sphere.center, n.sphere.radius);
    w.u8(n.iZone[0]).u8(n.iZone[1]).u8(n.numVertices);
    w.i32(n.iLeaf[0]).i32(n.iLeaf[1]);
    w.i32(n.iSection).i32(n.iFirstVertex).i32(n.iLightMap);
  }

  w.cidx(m.surfs.length);
  for (const s of m.surfs) {
    w.cidx(s.material).u32(s.polyFlags);
    w.cidx(s.pBase).cidx(s.vNormal).cidx(s.vTextureU).cidx(s.vTextureV);
    w.cidx(s.iLightMap).cidx(s.actor);
    w.plane(s.plane, s.plane[3]);
    w.f32(s.lightMapScale);
  }

  w.cidx(m.verts.length);
  for (const v of m.verts) w.cidx(v.pVertex).cidx(v.iSide);

  w.i32(m.numSharedSides);
  w.i32(m.zones.length);
  for (const z of m.zones) {
    w.cidx(z.zoneActor);
    w.u32(z.connectivity[0]).u32(z.connectivity[1]);
    w.u32(z.visibility[0]).u32(z.visibility[1]);
    w.f32(z.lastRenderTime);
  }

  w.cidx(m.polys);
  w.cidx(m.bounds.length); for (const b of m.bounds) w.box(b.min, b.max, b.valid);
  w.cidx(m.leafHulls.length); for (const h of m.leafHulls) w.i32(h);
  w.cidx(m.leaves.length);
  for (const l of m.leaves) { w.cidx(l.iZone).cidx(l.iPermeating).cidx(l.iVolumetric).u32(l.visibleZones[0]).u32(l.visibleZones[1]); }
  w.cidx(m.lights.length); for (const l of m.lights) w.cidx(l);
  w.i32(m.rootOutside).i32(m.linked);

  w.cidx(m.sections.length);
  for (const s of m.sections) {
    w.cidx(s.vertices.length);
    for (const v of s.vertices) { w.vec(v.pos); w.f32(v.u).f32(v.v).f32(v.u2).f32(v.v2); w.vec(v.normal); }
    w.i32(s.revision);
    w.cidx(s.material).i32(s.numNodes).u32(s.polyFlags).i32(s.iLightMapTexture);
  }

  w.cidx(m.lightMaps.length);
  for (const lm of m.lightMaps) {
    w.cidx(lm.iTexture).cidx(lm.iSurf).cidx(lm.iZone);
    w.cidx(lm.offsetX).cidx(lm.offsetY).cidx(lm.sizeX).cidx(lm.sizeY);
    for (let i = 0; i < 16; i++) w.f32(lm.worldToLightMap[i]);
    w.vec(lm.base); w.vec(lm.xAxis); w.vec(lm.yAxis);
    w.cidx(lm.bitmaps.length);
    for (const b of lm.bitmaps) {
      w.cidx(b.lightActor);
      w.cidx(b.bits.length).bytes(b.bits);
      w.i32(b.sizeX).i32(b.sizeY).i32(b.stride).i32(b.minX).i32(b.minY).i32(b.maxX).i32(b.maxY);
    }
    w.cidx(lm.level).i32(lm.revision);
  }

  w.cidx(m.lightMapTextures.length);
  for (const t of m.lightMapTextures) {
    w.cidx(t.level);
    w.cidx(t.lightMaps.length); for (const i of t.lightMaps) w.i32(i);
    w.u32(t.cacheId[0]).u32(t.cacheId[1]);
    w.i32(t.revision);
    for (let mi = 0; mi < 2; mi++) {
      const rec = w.lazySkip();
      w.cidx(t.mips[mi].length).bytes(t.mips[mi]);
      w.resolveLazy(rec);
    }
    w.u8(t.format).i32(t.width).i32(t.height).i32(t.texRevision);
  }
  return w;
}

// A brush-model shell: no geometry, no lighting. 71 bytes, byte-identical to the builder-brush
// Model objects in the shipped maps.
function emptyModel(pkg, polysRef, opts) {
  const o = opts || {};
  const bbox = o.bbox || { min: [0, 0, 0], max: [0, 0, 0], valid: 0 };
  return writeModel(pkg, {
    bbox,
    bsphere: { center: [0, 0, 0], radius: o.bbox ? Math.hypot(...bbox.max) : 0 },
    vectors: [], points: [], nodes: [], surfs: [], verts: [],
    // A brush model with an INVALID bounding box is invisible to the editor's CSG: every shipped
    // brush, in stock maps and hand-built ports alike, carries a real box with IsValid = 1 and
    // NumSharedSides = 4 (GOTCHAS 2.13).
    numSharedSides: o.numSharedSides || 0, zones: [], polys: polysRef || 0,
    bounds: [], leafHulls: [], leaves: [], lights: [],
    // A brush model's shape lives entirely in its Polys - every shipped brush model has zero nodes
    // and rootOutside 1. Leave rootOutside at 0 and the volume encloses nothing.
    // Linked = 1 says the polys already carry valid iLink values; the hand-built CS ports set it on
    // every CSG brush, and with 0 the editor relinks them on load.
    rootOutside: o.rootOutside || 0, linked: o.linked || 0, sections: [], lightMaps: [], lightMapTextures: [],
  });
}

// UPolys with no elements: property block + INT Num + INT Max. 9 bytes, matching the shipped maps.
function emptyPolys(pkg) {
  const w = new Writer(16);
  w.cidx(pkg.names.none).i32(0).i32(0);
  return w;
}

module.exports = { writeModel, emptyModel, emptyPolys };
