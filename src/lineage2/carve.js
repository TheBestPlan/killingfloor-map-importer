// Subtracting Lineage 2's carved volumes out of the polygons that are drawn.
//
// A doorway, a cave mouth, a window in a stone wall: none of them is modelled. The wall is one
// additive brush and the hole through it is a SUBTRACTIVE brush that the compiler carved out. This
// converter draws the additive brushes and skipped the subtractive ones, so every one of those holes
// came across filled in - a cave with no entrance, a house you cannot walk into (Screenshot_59).
//
// Full CSG is a subsystem. This is not that: it is the one operation those holes need, which is to
// take a convex polygon and remove the part of it that lies inside a convex volume. Clip the polygon
// against the volume's planes one at a time and the piece in FRONT of each plane is, by definition,
// outside the volume - so it is kept and the piece behind carries on to the next plane. Whatever is
// still behind after the last plane is inside the volume, and that is the piece that goes.
//
// What is NOT produced is the inside faces of the hole - the reveal of a doorway, the walls of a
// tunnel. The subtractive brush's own polygons are those faces, but they belong to the volume, not
// to the wall, and putting them in would need the CSG this deliberately is not.
"use strict";

// PF_Invisible | PF_Portal | PF_FakeBackdrop - the three that mean "not a surface" (brush.js).
const NOT_A_SURFACE = 0x00000001 | 0x04000000 | 0x00000080;
const EPS = 0.5;                                   // half a unit: a face lying ON the cut stays
// How much of a face a single volume may take before it stops counting as a hole through it.
const KEEP = 0.6;

// Area of a planar ring, signed onto its own normal.
function areaOf(ring, n) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    x += p[1] * q[2] - p[2] * q[1];
    y += p[2] * q[0] - p[0] * q[2];
    z += p[0] * q[1] - p[1] * q[0];
  }
  return Math.abs(x * n[0] + y * n[1] + z * n[2]) / 2;
}

function boxOf(vertices) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let a = 0; a < 3; a++) {
      if (v[a] < min[a]) min[a] = v[a];
      if (v[a] > max[a]) max[a] = v[a];
    }
  }
  return { min, max };
}
const overlaps = (a, b, pad) => (
  a.min[0] <= b.max[0] + pad && a.max[0] >= b.min[0] - pad &&
  a.min[1] <= b.max[1] + pad && a.max[1] >= b.min[1] - pad &&
  a.min[2] <= b.max[2] + pad && a.max[2] >= b.min[2] - pad);

// The convex volumes a set of brush polygons describes, one per brush. Fewer than four faces cannot
// enclose anything, so those are not volumes at all.
function hullsOf(polys) {
  const byBrush = new Map();
  for (const p of polys) {
    if (p.brush === undefined || p.vertices.length < 3) continue;
    if (!byBrush.has(p.brush)) byBrush.set(p.brush, []);
    byBrush.get(p.brush).push(p);
  }
  const out = [];
  for (const list of byBrush.values()) {
    if (list.length < 4) continue;
    const planes = list.map((p) => {
      const n = p.normal, v = p.vertices[0];
      return [n[0], n[1], n[2], n[0] * v[0] + n[1] * v[1] + n[2] * v[2]];
    });
    const all = [];
    for (const p of list) for (const v of p.vertices) all.push(v);
    out.push({
      planes, box: boxOf(all), brush: list[0].brush,
      seq: list[0].seq === undefined ? -1 : list[0].seq,
    });
  }
  return out;
}

// Split a ring by a plane. Returns the part in front (outside) and the part behind (inside); either
// can be null. A vertex within EPS of the plane belongs to both, which is what keeps a face that is
// coplanar with the cut from being sliced into slivers.
function split(ring, plane) {
  const d = ring.map((v) => plane[0] * v[0] + plane[1] * v[1] + plane[2] * v[2] - plane[3]);
  let front = false, back = false;
  for (const x of d) { if (x > EPS) front = true; else if (x < -EPS) back = true; }
  if (!back) return { front: ring, back: null };
  if (!front) return { front: null, back: ring };
  const f = [], b = [];
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const a = ring[i], c = ring[j], da = d[i], dc = d[j];
    if (da >= -EPS) f.push(a);
    if (da <= EPS) b.push(a);
    if ((da > EPS && dc < -EPS) || (da < -EPS && dc > EPS)) {
      const t = da / (da - dc);
      const mid = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
      f.push(mid); b.push(mid);
    }
  }
  // Drop points a split put in twice - a vertex sitting on the plane lands in both halves and again
  // as the crossing point, and a ring with a doubled point fans into a bow tie.
  const tidy = (ring) => {
    const out = [];
    for (const v of ring) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev[0] - v[0]) < 1e-3 && Math.abs(prev[1] - v[1]) < 1e-3 && Math.abs(prev[2] - v[2]) < 1e-3) continue;
      out.push(v);
    }
    const first = out[0], last = out[out.length - 1];
    if (out.length > 1 && Math.abs(first[0] - last[0]) < 1e-3 && Math.abs(first[1] - last[1]) < 1e-3 &&
      Math.abs(first[2] - last[2]) < 1e-3) out.pop();
    return out.length >= 3 ? out : null;
  };
  return { front: tidy(f), back: tidy(b) };
}

// Every additive polygon with the carved volumes taken out of it.
//
// `maxPieces` bounds what one polygon may become: a floor crossing a dozen carves is a dozen splits
// deep and the count multiplies. Past the bound the polygon is kept whole - a hole left filled is a
// worse map, an explosion of slivers is a broken one.
function carve(polys, hulls, opts) {
  const maxPieces = (opts && opts.maxPieces) || 64;
  // A volume that removes a whole face is a ROOM being hollowed out, and this converter already
  // shows those rooms from the inside - taking the face away leaves the player standing on nothing.
  // A volume that leaves a ring of the face behind is a DOORWAY. Keeping only the second kind is
  // what makes the operation safe without knowing the order CSG ran in.
  const holesOnly = !(opts && opts.removeWhole);
  if (!hulls.length) return { polys, opened: [], cut: 0, removed: 0, gaveUp: 0, whole: 0 };
  const out = [];
  let cut = 0, removed = 0, gaveUp = 0, whole = 0;
  const opened = [];                               // the walls a volume really punched through
  for (const poly of polys) {
    if (poly.vertices.length < 3) { out.push(poly); continue; }
    // Walls only. A doorway is a hole through something vertical; a hole through a floor is a room
    // being hollowed out, and 16_12's dungeon floor is one face far bigger than the hall carved into
    // it - punched through, it left 2 of 57 spawns with anything to stand on.
    if (Math.abs(poly.normal[2]) > 0.5) { out.push(poly); continue; }
    let pieces = [poly.vertices];
    let touched = false, bailed = false;
    const box = boxOf(poly.vertices);
    const startArea = areaOf(poly.vertices, poly.normal);
    for (const hull of hulls) {
      if (!overlaps(box, hull.box, EPS)) continue;
      // A plane the face lies ON decides nothing, and must not be allowed to: a doorway is cut flush
      // with the wall it goes through, so the carve's near face is coplanar with the wall's. Left in,
      // every vertex reads as "in front of it" and the whole wall counts as outside the volume -
      // which is why 25_14's cave mouth stayed sealed with the hole sitting right there in the file.
      const planes = hull.planes.filter((pl) => {
        for (const v of poly.vertices) {
          if (Math.abs(pl[0] * v[0] + pl[1] * v[1] + pl[2] * v[2] - pl[3]) > EPS) return true;
        }
        return false;
      });
      if (!planes.length) continue;
      const next = [];
      let inside = false;
      for (const ring of pieces) {
        let remaining = ring;
        for (const plane of planes) {
          if (!remaining) break;
          const s = split(remaining, plane);
          if (s.front) next.push(s.front);
          remaining = s.back;
        }
        if (remaining) inside = true;              // that part was inside the volume
      }
      if (!inside) continue;                       // the volume does not reach this face at all
      // How much of the face this volume would take. A doorway takes a corner of a wall; a volume
      // that eats most of a face is a room being hollowed out and only LOOKS like a hole because a
      // sliver survives. Measured on 25_14: the real doorway costs its wall 1%, the carves that ate
      // the cave took 60, 74, 91 and 98% and left it full of holes to the void.
      const keptArea = next.reduce((n, ring) => n + areaOf(ring, poly.normal), 0);
      if (keptArea < startArea * KEEP) { whole++; continue; }
      // Nothing left means the volume swallowed the face whole: that is a room being hollowed out,
      // not a doorway, and this converter draws those rooms from the inside. Ignore the volume and
      // carry on - the doorway carves are the ones that leave a ring behind, and they come later in
      // the list. Without this the first brush of a level, one huge subtract that hollows the world
      // out of solid rock, ends every carve before it starts.
      if (holesOnly && !next.length) { whole++; continue; }
      pieces = next;
      touched = true;
      if (pieces.length > maxPieces) { bailed = true; break; }
      if (!pieces.length) break;
    }
    if (bailed) { out.push(poly); gaveUp++; continue; }
    if (!touched) { out.push(poly); continue; }
    if (!pieces.length) {
      if (holesOnly) { out.push(poly); whole++; continue; }
      removed++; continue;
    }
    cut++;
    for (const ring of pieces) out.push(Object.assign({}, poly, { vertices: ring }));
  }
  return { polys: out, opened, cut, removed, gaveUp, whole };
}

// The walls, floor and ceiling of a carved room.
//
// `carve` above only takes material away. The other half is that a subtractive brush's own polygons
// ARE the surfaces of the room it hollowed out, and without them a cave is open to the sky wherever
// the static meshes standing in it happen not to cover (Screenshot_85).
//
// A Lineage 2 square is a SUBTRACTIVE world, the Unreal default: solid rock until a brush carves it
// away - 25_14 spends 210 subtractive brushes against 49 additive. So a void's face borders rock
// everywhere EXCEPT where something else already took that rock away:
//
//   - another void overlapping it. There is no material between two carved volumes, and a face drawn
//     there is a wall across an open passage;
//   - an additive brush - rock put back, and the face is buried inside it;
//   - another void it lies FLUSH against, facing into it. Two rooms carved edge to edge share a wall
//     plane with no rock in it; the clip cannot see that (every vertex reads as "in front of" the
//     plane), so the two normals decide.
//
// And never in the plane of a wall the carve OPENED. A doorway is cut flush with its wall, so the
// volume's cap sits exactly in the wall's plane - emitted, it seals the doorway again, and because
// it faces into the rock it is invisible from outside: the cave mouth became an invisible wall.
// Those are the doorway planes, and only those - matching every wall instead capped everything.
function interiors(carved, addHulls, subHulls, addPolys, opts) {
  const maxPieces = (opts && opts.maxPieces) || 64;
  // Every Unreal level opens by subtracting the universe, and 25_14's is 655360 x 524288 x 32768
  // around the origin. It is not a room: used as a remover it swallows all 210 of the others, and
  // its own six faces are a box around the world. A square is 32768 across.
  const huge = (opts && opts.huge) || 32768;
  const isWorld = (b) => b.max[0] - b.min[0] > huge && b.max[1] - b.min[1] > huge;
  const rooms = subHulls.filter((h) => !isWorld(h.box));
  const world = new Set(subHulls.filter((h) => isWorld(h.box)).map((h) => h.brush));
  const walls = (addPolys || []).map((p) => ({
    plane: [p.normal[0], p.normal[1], p.normal[2],
      p.normal[0] * p.vertices[0][0] + p.normal[1] * p.vertices[0][1] + p.normal[2] * p.vertices[0][2]],
    box: boxOf(p.vertices),
  }));
  const out = [];
  let faces = 0, gaveUp = 0, capped = 0, upright = 0;
  const onPlane = (pl, vertices) => {
    for (const v of vertices) {
      if (Math.abs(pl[0] * v[0] + pl[1] * v[1] + pl[2] * v[2] - pl[3]) > EPS) return false;
    }
    return true;
  };
  for (const poly of carved) {
    if (poly.vertices.length < 3) continue;
    // A volume's own faces carry the mapper's instructions to the compiler the same way an additive
    // brush's do: invisible, portal and backdrop faces are not surfaces.
    if (poly.polyFlags & NOT_A_SURFACE) continue;
    if (world.has(poly.brush)) continue;
    // Floors and ceilings only. A horizontal face can close a hole in the ground and can never
    // block a passage; a vertical one is a wall, and a wall in the wrong place is the invisible
    // barrier that sealed 25_14's cave mouth twice over.
    if (Math.abs(poly.normal[2]) <= 0.5) { upright++; continue; }
    const box = boxOf(poly.vertices);
    let inWall = false;
    for (const w of walls) {
      if (!overlaps(box, w.box, EPS)) continue;
      if (onPlane(w.plane, poly.vertices)) { inWall = true; break; }
    }
    if (inWall) { capped++; continue; }
    let pieces = [poly.vertices];
    let bailed = false;
    for (const list of [addHulls]) {
      for (const hull of list) {
        if (!pieces.length) break;

        if (!overlaps(box, hull.box, EPS)) continue;
        let flush = 0;
        for (const pl of hull.planes) {
          if (!onPlane(pl, poly.vertices)) continue;
          flush = pl[0] * poly.normal[0] + pl[1] * poly.normal[1] + pl[2] * poly.normal[2] < 0 ? -1 : 1;
          break;
        }
        if (flush < 0) { pieces = []; break; }
        if (flush > 0) continue;
        const next = [];
        for (const ring of pieces) {
          let remaining = ring;
          for (const plane of hull.planes) {
            if (!remaining) break;
            const s = split(remaining, plane);
            if (s.front) next.push(s.front);
            remaining = s.back;
          }
        }
        pieces = next;
        if (pieces.length > maxPieces) { bailed = true; break; }
      }
      if (bailed) break;
    }
    if (bailed) { gaveUp++; continue; }
    for (const ring of pieces) {
      out.push(Object.assign({}, poly, {
        vertices: ring.slice().reverse(),
        normal: [-poly.normal[0], -poly.normal[1], -poly.normal[2]],
      }));
      faces++;
    }
  }
  return { polys: out, faces, gaveUp, capped, upright };
}

module.exports = { carve, interiors, hullsOf, split, boxOf };
