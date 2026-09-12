// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GTA III / Vice City water. The sea is not placed as model instances - the engine draws it from
// data\water.dat, a text list of horizontal rectangles, one per line: `level, xLeft, yBottom, xRight, yTop`
// (comment lines start with ';', the file ends with a '*' line). Most rectangles sit at sea level 0; a few
// name a higher body (the Shoreside dam reservoir at 63.2). Without this the converted map shows a blue void
// wherever the city opens onto water. This reads the rectangles and, per tile, emits each one clipped to the
// tile's bounds as a flat quad at its level - land geometry sits above sea level and occludes it, so the
// plane only shows through where the ground actually opens to water.
"use strict";

const fs = require("fs");
const path = require("path");

// Parse data\water.dat into rectangles { level, x0, y0, x1, y1 } (x0<x1, y0<y1). Empty if absent.
function parseWater(root) {
  const p = path.join(root, "data", "water.dat");
  let text; try { text = fs.readFileSync(p, "latin1"); } catch (e) { return []; }
  const rects = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === ";" || line[0] === "*") continue;
    const n = line.split(/[,\s]+/).map(Number);
    if (n.length < 5 || n.slice(0, 5).some((v) => Number.isNaN(v))) continue;
    const [level, a, b, c, d] = n;
    rects.push({ level, x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) });
  }
  return rects;
}

// Open-water surface, over OPEN water only. The water.dat rectangles are flat sea planes that blanket dry
// land too, so a quad the size of each rectangle draws a bright slab across the whole city that pokes up
// between the road pieces (the reported blue "holes"). Instead, sample each rectangle on a `cellM`-metre grid
// against `groundAt(x,y)` (the tile's highest solid floor there, or null), keep only cells that are genuinely
// submerged - no floor, or a floor more than `openDrop` below the surface - and merge the open cells in each
// row into strips. Returns { verts, tris, strips } in GTA world coordinates (Z = the level), strips being the
// same rectangles for the swim volumes. Empty verts if no open water falls in the bounds.
function openWater(rects, bx0, by0, bx1, by1, groundAt, cellM, openDrop) {
  const verts = [], tris = [], strips = [];
  let base = 0;
  for (const r of rects) {
    const x0 = Math.max(r.x0, bx0), y0 = Math.max(r.y0, by0), x1 = Math.min(r.x1, bx1), y1 = Math.min(r.y1, by1);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
    const nx = Math.max(1, Math.round((x1 - x0) / cellM)), ny = Math.max(1, Math.round((y1 - y0) / cellM));
    for (let j = 0; j < ny; j++) {
      const cy0 = y0 + (y1 - y0) * j / ny, cy1 = y0 + (y1 - y0) * (j + 1) / ny, myc = (cy0 + cy1) / 2;
      let run = -1;   // start column of an open run
      for (let i = 0; i <= nx; i++) {
        let open = false;
        if (i < nx) {
          const mxc = x0 + (x1 - x0) * (i + 0.5) / nx;
          const g = groundAt(mxc, myc);
          open = g === null || g === undefined || g < r.level - openDrop;
        }
        if (open && run < 0) run = i;
        if ((!open || i === nx) && run >= 0) {
          const rx0 = x0 + (x1 - x0) * run / nx, rx1 = x0 + (x1 - x0) * i / nx, z = r.level;
          verts.push(rx0, cy0, z, rx1, cy0, z, rx1, cy1, z, rx0, cy1, z);
          tris.push([base, base + 1, base + 2, 0], [base, base + 2, base + 3, 0]);
          base += 4;
          strips.push({ x0: rx0, y0: cy0, x1: rx1, y1: cy1, level: r.level });
          run = -1;
        }
      }
    }
  }
  return { verts: new Float32Array(verts), tris, strips };
}

module.exports = { parseWater, openWater };
