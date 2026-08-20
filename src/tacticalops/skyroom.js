// Tactical Ops' sky room -> six cube faces, rendered here rather than carried as geometry.
//
// UT99 draws a sky by rendering a small room - the one holding the `SkyZoneInfo` - through every
// `PF_FakeBackdrop` surface, from a camera locked to the player's rotation but never to his
// position. There is no parallax and no distance: whatever the room contains is at infinity.
//
// Carrying that room across as a scaled-up model, which is what this route did first, cannot
// reproduce either property. The room grows around the level, so its own contents end up INSIDE the
// playable space: TO-RapidWaters' sky room has a sea plane, and enlarged it cut through the map as a
// flat teal sheet you could walk through. The seams of the room show for the same reason.
//
// So the room is rendered instead - once, offline, from the SkyZoneInfo's own position, into the six
// faces of a cube. That is exactly what the GoldSrc and Quake 3 routes already draw, so the mesh
// builder is shared; what is new here is the renderer, because the pictures do not exist as files.
"use strict";

const { PF } = require("./model");

// The six faces, in the axes Unreal uses. `d` is the direction the face looks, `up` its up vector.
const FACES = [
  { side: "rt", d: [1, 0, 0], up: [0, 0, 1] },
  { side: "lf", d: [-1, 0, 0], up: [0, 0, 1] },
  { side: "bk", d: [0, 1, 0], up: [0, 0, 1] },
  { side: "ft", d: [0, -1, 0], up: [0, 0, 1] },
  { side: "up", d: [0, 0, 1], up: [1, 0, 0] },
  { side: "dn", d: [0, 0, -1], up: [-1, 0, 0] },
];

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Clip a convex polygon in camera space against the near plane. The camera sits INSIDE the room, so
// most of its surfaces cross the plane and dropping them whole would leave holes in the sky.
function clipNear(poly, near) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ain = a.z >= near, bin = b.z >= near;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (near - a.z) / (b.z - a.z);
      out.push({
        x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: near,
        u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t,
      });
    }
  }
  return out;
}

// One face of the cube.
//
// opts: { size, camera (TO units), nodes: [{ ring: [{pos,u,v}], tex, kind, dist }] }
// `tex` is { rgb, width, height, indexed } - `indexed` is the palette index per texel, so a cut-out
// can drop index 0 the way UE1 does.
function renderFace(face, surfaces, size) {
  const right = cross(face.d, face.up);
  const rgb = Buffer.alloc(size * size * 3);
  const depth = new Float64Array(size * size).fill(Infinity);
  const half = size / 2;
  const near = 1;

  // Opaque first with a depth buffer, then everything that blends, farthest first, over the top.
  const opaque = surfaces.filter((s) => s.kind === "opaque" || s.kind === "masked");
  const blended = surfaces.filter((s) => s.kind !== "opaque" && s.kind !== "masked")
    .sort((a, b) => b.dist - a.dist);

  const draw = (s, blend) => {
    const cam = s.ring.map((p) => ({
      x: dot(p.rel, right), y: dot(p.rel, face.up), z: dot(p.rel, face.d), u: p.u, v: p.v,
    }));
    const poly = clipNear(cam, near);
    if (poly.length < 3) return;
    const scr = poly.map((p) => ({
      x: half + (p.x / p.z) * half, y: half - (p.y / p.z) * half,
      iz: 1 / p.z, uz: p.u / p.z, vz: p.v / p.z,
    }));
    for (let k = 2; k < scr.length; k++) {
      const a = scr[0], b = scr[k - 1], c = scr[k];
      const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5;
          let w0 = ((b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)) / area;
          let w1 = ((px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y)) / area;
          let w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const iz = w2 * a.iz + w1 * b.iz + w0 * c.iz;
          if (iz <= 0) continue;
          const at = y * size + x;
          const z = 1 / iz;
          if (!blend && z >= depth[at]) continue;
          const u = (w2 * a.uz + w1 * b.uz + w0 * c.uz) / iz;
          const v = (w2 * a.vz + w1 * b.vz + w0 * c.vz) / iz;
          const t = s.tex;
          // Bilinear, wrapped. The room's textures are magnified several times over by the time they
          // fill a cube face, and point sampling them is what makes the sky read as a mosaic of
          // squares rather than as a sky.
          const fx = u * t.width - 0.5, fy = v * t.height - 0.5;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const ax = fx - x0, ay = fy - y0;
          const wrap = (n, m) => ((n % m) + m) % m;
          const xs = [wrap(x0, t.width), wrap(x0 + 1, t.width)];
          const ys = [wrap(y0, t.height), wrap(y0 + 1, t.height)];
          const ti = ys[0] * t.width + xs[0];
          if (s.kind === "masked" && t.indexed && t.indexed[ti] === 0) continue;
          let r = 0, g = 0, bl = 0;
          for (let j = 0; j < 2; j++) {
            for (let i2 = 0; i2 < 2; i2++) {
              const wgt = (i2 ? ax : 1 - ax) * (j ? ay : 1 - ay);
              const o = (ys[j] * t.width + xs[i2]) * 3;
              r += t.rgb[o] * wgt; g += t.rgb[o + 1] * wgt; bl += t.rgb[o + 2] * wgt;
            }
          }
          if (blend) {
            // UE1's translucency is the texel's own brightness, and a modulated layer multiplies.
            if (s.kind === "modulated") {
              rgb[at * 3] = (rgb[at * 3] * r) / 255;
              rgb[at * 3 + 1] = (rgb[at * 3 + 1] * g) / 255;
              rgb[at * 3 + 2] = (rgb[at * 3 + 2] * bl) / 255;
            } else {
              const alpha = (r * 77 + g * 151 + bl * 28) / 65280;    // luma, 0..1
              rgb[at * 3] = rgb[at * 3] * (1 - alpha) + r * alpha;
              rgb[at * 3 + 1] = rgb[at * 3 + 1] * (1 - alpha) + g * alpha;
              rgb[at * 3 + 2] = rgb[at * 3 + 2] * (1 - alpha) + bl * alpha;
            }
          } else {
            depth[at] = z;
            rgb[at * 3] = r; rgb[at * 3 + 1] = g; rgb[at * 3 + 2] = bl;
          }
        }
      }
    }
  };

  for (const s of opaque) draw(s, false);
  for (const s of blended) draw(s, true);
  return { width: size, height: size, rgb };
}

// Render the whole cube.
//
//   model      the world UModel
//   nodes      the sky room's nodes
//   camera     where the SkyZoneInfo stands, in the map's own units
//   pixelsOf   (iSurf) -> { rgb, width, height, indexed, kind } | null
//   size       face resolution
//
// Returns { faces: { rt, lf, bk, ft, up, dn } } or null when nothing could be drawn.
function renderSkyCube(model, nodes, camera, pixelsOf, size) {
  const surfaces = [];
  for (const node of nodes) {
    if (node.numVertices < 3) continue;
    const surf = model.surfs[node.iSurf];
    if (!surf) continue;
    if (surf.polyFlags & PF.Invisible) continue;
    const tex = pixelsOf(node.iSurf, surf);
    if (!tex) continue;
    const base = model.points[surf.pBase];
    const axisU = model.vectors[surf.vTextureU];
    const axisV = model.vectors[surf.vTextureV];
    if (!base || !axisU || !axisV) continue;
    const ring = [];
    let ok = true, dist = 0;
    for (let i = 0; i < node.numVertices; i++) {
      const v = model.verts[node.iVertPool + i];
      const p = v && model.points[v.pVertex];
      if (!p) { ok = false; break; }
      const rel = sub(p, base);
      ring.push({
        rel: sub(p, camera),
        u: (dot(rel, axisU) + surf.panU) / (tex.origWidth || tex.width),
        v: (dot(rel, axisV) + surf.panV) / (tex.origHeight || tex.height),
      });
      dist += Math.hypot(p[0] - camera[0], p[1] - camera[1], p[2] - camera[2]);
    }
    if (!ok || ring.length < 3) continue;
    surfaces.push({ ring, tex, kind: tex.kind || "opaque", dist: dist / ring.length });
  }
  if (!surfaces.length) return null;
  const faces = {};
  for (const f of FACES) faces[f.side] = renderFace(f, surfaces, size);
  return { faces, surfaces: surfaces.length };
}

module.exports = { renderSkyCube, FACES };
