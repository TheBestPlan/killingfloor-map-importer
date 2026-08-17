// GoldSrc skybox -> one big inward-facing textured cube, as a static mesh.
//
// A GoldSrc sky is six images (gfx/env/<name>{up,dn,lf,rt,ft,bk}). The right way to show them in KF
// is a cube far enough out that its parallax is negligible across a CS-sized map, drawn unlit so it
// reads at exactly its own brightness. Projecting the images onto the map's own sky brushes (the
// earlier approach) stretched a 256px image over the whole level and blew it to white.
//
// Which image goes on which face is NOT what the compass names suggest - it is Quake's layout,
// which GoldSrc inherited:
//
//     rt +X    lf -X    bk +Y    ft -Y    up +Z    dn -Z
//
// Measured, not assumed: laying the images out by name (ft +X, bk -X, lf +Y, rt -Y) leaves a seam
// error no amount of rotating can remove, because a wrong face assignment is not a rotation. Mean
// seam error over the 12 cube edges, best rotation set in each case:
//
//     sky      by-name   quake
//     city1      32.5     21.0
//     des        42.8     13.9
//     green      42.9      6.4
//
// The per-image rotation on top of this is solved from the pictures - see build/skyboxorient.js.
"use strict";

const FACES = [
  { side: "rt", d: [1, 0, 0], up: [0, 0, 1] },
  { side: "lf", d: [-1, 0, 0], up: [0, 0, 1] },
  { side: "bk", d: [0, 1, 0], up: [0, 0, 1] },
  { side: "ft", d: [0, -1, 0], up: [0, 0, 1] },
  { side: "up", d: [0, 0, 1], up: [1, 0, 0] },
  { side: "dn", d: [0, 0, -1], up: [-1, 0, 0] },
];

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// center: cube centre in UE space. R: half-size. skySides: { side -> { texRef, width, height } }.
//
// `opts.grid` splits every face into that many cells a side. A face as one quad is one pair of
// triangles whose corners are R*sqrt(3) from the middle of the cube, and the renderer drops a
// triangle whose vertices are past the far plane rather than clipping it to the plane - so on a
// world big enough to need a big cube, whole half-faces vanish and leave the un-cleared backbuffer
// showing through as white wedges. Cut the face up and only the cells that are really too far go.
function buildSkyboxMesh(center, R, skySides, opts) {
  const grid = Math.max(1, Math.round((opts && opts.grid) || 1));
  const vertices = [], uvs = [], colors = [], indices = [], sections = [], materials = [];

  for (const f of FACES) {
    const tex = skySides[f.side];
    if (!tex) continue;
    const right = cross(f.d, f.up);
    // Half a texel in from each edge: sampling exactly on the border of a clamped texture is what
    // draws a bright line along every cube edge.
    const inset = 0.5 / (tex.width || 256);
    const firstIndex = indices.length, firstVertex = vertices.length;
    const at = (u, v) => {
      const su = u * 2 - 1;                     // -1 left .. +1 right
      const sv = 1 - v * 2;                     // +1 top .. -1 bottom
      const hl = [0, 1, 2].map((a) => f.d[a] * R + right[a] * su * R + f.up[a] * sv * R);
      // GoldSrc -> UE mirrors Y, exactly as the world geometry does.
      vertices.push({
        pos: [center[0] + hl[0], center[1] - hl[1], center[2] + hl[2]],
        normal: [-f.d[0], f.d[1], -f.d[2]],     // inward, through the same mirror
      });
      uvs.push([u * (1 - 2 * inset) + inset, v * (1 - 2 * inset) + inset]);
      colors.push([255, 255, 255, 255]);
      return vertices.length - 1;
    };

    // ONE winding, and it must be this one. Emitting both was meant as insurance against getting
    // the convention wrong; it caused the white flashes instead. Two exactly coplanar triangles
    // z-fight, and wherever the back-facing copy wins the depth test the pixel is culled and left
    // showing an un-cleared backbuffer - white, moving as the view turns. Measured: with only the
    // other winding the whole sky is white, with this one it draws. See ../../docs/GOTCHAS.md 5.25.
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const u0 = i / grid, u1 = (i + 1) / grid, v0 = j / grid, v1 = (j + 1) / grid;
        const a = at(u0, v0), b = at(u1, v0), c = at(u1, v1), d = at(u0, v1);
        indices.push(c, b, a, d, c, a);
      }
    }
    sections.push({
      f0: 0, firstIndex, firstVertex,
      lastVertex: vertices.length - 1, u4: 0, numFaces: 2 * grid * grid,
    });
    materials.push(tex.texRef);
  }

  const bbox = { min: [center[0] - R, center[1] - R, center[2] - R], max: [center[0] + R, center[1] + R, center[2] + R] };
  return { materials, vertices, uvs, colors, indices, sections, bbox, center, radius: R * Math.sqrt(3) };
}

// The four corners of each face in GoldSrc space, in the image's (0,0),(1,0),(1,1),(0,1) order.
// Used to work out which faces share which edge when auto-orienting the images.
function faceCorners(R) {
  return FACES.map((f) => {
    const right = cross(f.d, f.up);
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
      const su = u * 2 - 1, sv = 1 - v * 2;
      return [0, 1, 2].map((a) => f.d[a] * R + right[a] * su * R + f.up[a] * sv * R);
    });
    return { side: f.side, corners };
  });
}

module.exports = { buildSkyboxMesh, faceCorners, FACES };
