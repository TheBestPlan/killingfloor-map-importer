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
    out.push({ planes, box: boxOf(all), seq: list[0].seq === undefined ? -1 : list[0].seq });
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
  if (!hulls.length) return { polys, cut: 0, removed: 0, gaveUp: 0, whole: 0 };
  const out = [];
  let cut = 0, removed = 0, gaveUp = 0, whole = 0;
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
  return { polys: out, cut, removed, gaveUp, whole };
}

module.exports = { carve, hullsOf, split, boxOf };
