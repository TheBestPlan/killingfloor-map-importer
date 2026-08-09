// Work out how each skybox image has to be rotated/flipped, by matching the pictures themselves.
//
// The six GoldSrc sky images sit on known faces (ft +X, bk -X, lf +Y, rt -Y, up +Z, dn -Z), but the
// rotation of each image is a convention that is easy to get wrong from memory - and getting it
// wrong shows up as clouds that break across a cube edge rather than as anything obviously broken.
// Two earlier attempts (a half-remembered Quake table, then hand-reasoned axes) both landed wrong.
//
// So do not guess: neighbouring faces of a cube share an edge, and a sky image is continuous across
// it. Try each face in its 8 orientations (4 rotations x optional mirror) and keep the one whose
// border pixels best match the neighbours already placed. The Y mirror the converter applies to the
// world is exactly why a mirrored orientation has to be in the candidate set.
"use strict";

// One rotation/flip of an image. k = quarter turns, mirror flips horizontally first.
function transform(img, k, mirror) {
  const { width: w, height: h, rgb } = img;
  const swap = k % 2 === 1;
  const ow = swap ? h : w, oh = swap ? w : h;
  const out = Buffer.alloc(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let sx, sy;
      if (k === 0) { sx = x; sy = y; }
      else if (k === 1) { sx = y; sy = h - 1 - x; }
      else if (k === 2) { sx = w - 1 - x; sy = h - 1 - y; }
      else { sx = w - 1 - y; sy = x; }
      if (mirror) sx = w - 1 - sx;
      const s = (sy * w + sx) * 3, d = (y * ow + x) * 3;
      out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2];
    }
  }
  return { width: ow, height: oh, rgb: out };
}

// Border pixels of a face, walked in the order the edge is traversed (see the side table below).
function border(img, side) {
  const { width: w, height: h, rgb } = img;
  const out = [];
  const push = (x, y) => { const s = (y * w + x) * 3; out.push(rgb[s], rgb[s + 1], rgb[s + 2]); };
  if (side === 0) for (let x = 0; x < w; x++) push(x, 0);              // top, left to right
  else if (side === 1) for (let y = 0; y < h; y++) push(w - 1, y);     // right, top to bottom
  else if (side === 2) for (let x = w - 1; x >= 0; x--) push(x, h - 1); // bottom, right to left
  else for (let y = h - 1; y >= 0; y--) push(0, y);                    // left, bottom to top
  return out;
}

const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;

// corners[face] = [c00, c10, c11, c01] in world space; the sides are the four consecutive pairs.
function edgesOf(corners) {
  return [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
}

// Returns { side -> { width, height, rgb } }, each rotated into place.
// faces: [{ side, corners }] in world space; images: { side -> img }.
function orientSkybox(faces, images) {
  const idx = new Map(faces.map((f, i) => [f.side, i]));
  const edges = faces.map((f) => edgesOf(f.corners));

  // Which faces touch, and along which side of each.
  const adj = faces.map(() => []);
  for (let a = 0; a < faces.length; a++) {
    for (let b = a + 1; b < faces.length; b++) {
      for (let sa = 0; sa < 4; sa++) {
        for (let sb = 0; sb < 4; sb++) {
          const [p, q] = edges[a][sa], [r, s] = edges[b][sb];
          // Neighbouring faces walk a shared edge in opposite directions.
          if (same(p, s) && same(q, r)) { adj[a].push({ other: b, sa, sb }); adj[b].push({ other: a, sa: sb, sb: sa }); }
        }
      }
    }
  }

  const CAND = [];
  for (let k = 0; k < 4; k++) for (const m of [false, true]) CAND.push({ k, m });

  const chosen = new Array(faces.length).fill(null);
  const variants = faces.map((f) => (images[f.side] ? CAND.map((c) => transform(images[f.side], c.k, c.m)) : null));

  const mismatch = (imgA, sa, imgB, sb) => {
    const A = border(imgA, sa), B = border(imgB, sb);
    const n = Math.min(A.length, B.length);
    let sum = 0;
    // The shared edge is traversed in opposite directions, so B is compared reversed in pixel
    // triples (not per byte).
    for (let i = 0; i < n; i += 3) {
      const j = n - 3 - i;
      sum += Math.abs(A[i] - B[j]) + Math.abs(A[i + 1] - B[j + 1]) + Math.abs(A[i + 2] - B[j + 2]);
    }
    return sum / (n / 3);
  };

  // Exhaustive, not greedy. A cube has 12 edges and each face has 8 candidate orientations, so
  // pre-computing the cost of every (edge, orientation, orientation) triple is 12*8*8 = 768 strip
  // comparisons; the 8^6 = 262144 whole-cube combinations are then just table lookups. Greedy
  // growth from one anchor face gets stuck - it fixes a face before seeing the neighbours that
  // would have contradicted it.
  const uniq = [];
  const seenEdge = new Set();
  for (let a = 0; a < faces.length; a++) {
    for (const link of adj[a]) {
      const key = Math.min(a, link.other) + ":" + Math.max(a, link.other) + ":" + (a < link.other ? link.sa + ":" + link.sb : link.sb + ":" + link.sa);
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      if (a < link.other) uniq.push({ a, b: link.other, sa: link.sa, sb: link.sb });
    }
  }

  const cost = uniq.map((e) => {
    const t = [];
    for (let ca = 0; ca < CAND.length; ca++) {
      t.push([]);
      for (let cb = 0; cb < CAND.length; cb++) {
        t[ca].push(variants[e.a] && variants[e.b] ? mismatch(variants[e.a][ca], e.sa, variants[e.b][cb], e.sb) : 0);
      }
    }
    return t;
  });

  const pick = new Array(faces.length).fill(0);
  let bestTotal = Infinity;
  const nFaces = faces.length;
  const walk = (i) => {
    if (i === nFaces) {
      let total = 0;
      for (let e = 0; e < uniq.length; e++) total += cost[e][pick[uniq[e].a]][pick[uniq[e].b]];
      if (total < bestTotal) { bestTotal = total; for (let k = 0; k < nFaces; k++) chosen[k] = pick[k]; }
      return;
    }
    if (!variants[i]) { pick[i] = 0; walk(i + 1); return; }
    // The cube can be rotated as a whole without changing any seam, so pin the first face and only
    // search the rest - 8x fewer combinations and a stable, reproducible answer.
    const range = i === 0 ? 1 : CAND.length;
    for (let c = 0; c < range; c++) { pick[i] = c; walk(i + 1); }
  };
  walk(0);

  const out = {};
  const report = [];
  faces.forEach((f, i) => {
    if (!variants[i]) return;
    const c = CAND[chosen[i] === null ? 0 : chosen[i]];
    out[f.side] = variants[i][chosen[i] === null ? 0 : chosen[i]];
    report.push(f.side + (c.k ? ":rot" + c.k * 90 : "") + (c.m ? ":mirror" : ""));
  });
  return { images: out, report };
}

module.exports = { orientSkybox, transform };
