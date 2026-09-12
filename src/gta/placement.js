// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GTA III / Vice City map placement: the text .ide (item definitions: id -> model/txd name) and .ipl
// (item placement: instances of a model at a position/rotation). A game's map is a handful of each,
// listed in gta.dat/default.dat; this just reads every .ide and .ipl under the data folder, which is
// the same set. Only what the geometry needs is parsed - the id->model map and the instance
// transforms; paths, zones, cull volumes and the rest of each file are ignored.
"use strict";

const fs = require("fs");
const path = require("path");

// Split a data file into sections: a bare keyword line opens a section, `end` closes it.
function* rows(text) {
  let section = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (!section) { section = line.toLowerCase(); continue; }
    if (line.toLowerCase() === "end") { section = null; continue; }
    yield { section, cols: line.split(",").map((s) => s.trim()) };
  }
}

// id -> { model, txd, drawDist } lowercased names, from every objs/tobj row across the .ide files.
// objs: id, model, txd, meshCount, drawDist[meshCount], flags. The first draw distance drives GTA's LOD:
// a model with drawDist > 300 (re3's LOD_DISTANCE) is a "big building" - a low-detail stand-in the engine
// draws only at range, and the detailed model in its place up close. tobj adds two time fields at the end.
function readIde(files) {
  const idToDef = new Map();
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, "latin1"); } catch (e) { continue; }
    for (const { section, cols } of rows(text)) {
      if (section !== "objs" && section !== "tobj") continue;
      const id = parseInt(cols[0], 10);
      if (Number.isNaN(id) || !cols[1]) continue;
      const meshCount = parseInt(cols[3], 10) || 1;
      const drawDist = parseFloat(cols[4]) || 0;   // cols[4 .. 4+meshCount-1] are the per-LOD distances
      idToDef.set(id, { model: cols[1].toLowerCase(), txd: (cols[2] || "").toLowerCase(), drawDist });
    }
  }
  return idToDef;
}

// Instances from the inst section of every .ipl. GTA III: id, model, x,y,z, sx,sy,sz, qx,qy,qz,qw.
// Vice City inserts an `interior` column after the model, so the numeric fields shift by one - detect
// by counting. LOD stand-ins (model name starting "lod") are dropped: they duplicate the real mesh.
//
// Duplicate placements are dropped SPATIALLY. A raw install carries flat copies of each map beside its
// canonical subfolder one (data\maps\comNtop.ipl next to comNtop\comNtop.ipl), and some of those copies
// were re-authored a fraction of a metre off (industNE's tenements sit 0.1-0.5 m apart), so an exact
// position match misses them - a visibly doubled building/sign/rail, z-fighting. Instead an instance is a
// duplicate of one already kept when it is the SAME model at the SAME orientation within DUP_DIST. Bucketing
// on model + rounded quaternion is what keeps a dense hedge of ONE bush model at VARYING rotations intact -
// those land in different buckets - while collapsing same-facing repeats; and it keeps the genuinely
// distinct road-network and suburb IPLs a stripped gta3.dat would lose.
const DUP_DIST = 0.6;                       // metres; observed duplicate offsets are 0.1-0.5 m
function readIpl(files) {
  const inst = [];
  const buckets = new Map();                // model|quat -> Map(cell -> [ [x,y,z] kept ])
  const isDup = (grid, p) => {
    const gx = Math.floor(p[0] / DUP_DIST), gy = Math.floor(p[1] / DUP_DIST), gz = Math.floor(p[2] / DUP_DIST);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get((gx + dx) + "," + (gy + dy) + "," + (gz + dz)); if (!arr) continue;
      for (const q of arr) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < DUP_DIST * DUP_DIST) return true;
    }
    return false;
  };
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, "latin1"); } catch (e) { continue; }
    for (const { section, cols } of rows(text)) {
      if (section !== "inst") continue;
      const model = (cols[1] || "").toLowerCase();
      if (!model || /^lod/i.test(model)) continue;
      // Numeric tail is the last 10 fields: x,y,z, sx,sy,sz, qx,qy,qz,qw (VC's interior sits before them).
      const n = cols.map(Number);
      const t = n.slice(cols.length - 10);
      if (t.length < 10 || t.some((v) => Number.isNaN(v))) continue;
      const pos = [t[0], t[1], t[2]];
      const bkey = model + "|" + Math.round(t[6] * 50) + "," + Math.round(t[7] * 50) + "," + Math.round(t[8] * 50) + "," + Math.round(t[9] * 50);
      let grid = buckets.get(bkey); if (!grid) buckets.set(bkey, grid = new Map());
      if (isDup(grid, pos)) continue;
      const ck = Math.floor(pos[0] / DUP_DIST) + "," + Math.floor(pos[1] / DUP_DIST) + "," + Math.floor(pos[2] / DUP_DIST);
      let cell = grid.get(ck); if (!cell) grid.set(ck, cell = []); cell.push(pos);
      inst.push({ model, id: parseInt(cols[0], 10), pos, scale: [t[3], t[4], t[5]], quat: [t[6], t[7], t[8], t[9]] });
    }
  }
  return inst;
}

// Every .ide / .ipl under a game's root (data\ and data\maps\ hold them). Reading all of them, rather than
// following the level .dat's file list, is deliberate: a stripped or modded gta3.dat can omit whole
// districts (this machine's install leaves the entire Shoreside Vale suburb and the road-network IPLs out
// of its .dat), and dropping those left buildings with no ground and banners over voids.
//
// A real install carries a flat COPY of each district beside its canonical subfolder version
// (data\maps\industNE.ipl next to data\maps\industne\industNE.ipl). The two are near-identical, but a few
// instances differ by a metre or two between them, so reading both places those doubled - a visibly
// duplicated sign or building that survives a position dedup. When a basename exists in both places keep only
// the DEEPER (subfolder) file, the one gta3.dat references; files with no twin (the suburb and road IPLs) are
// untouched. readIpl still spatially dedups whatever repeats remain within a file.
function findDataFiles(root) {
  const allIde = [], allIpl = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, depth + 1);
      else if (/\.ide$/i.test(d.name)) allIde.push(p);
      else if (/\.ipl$/i.test(d.name)) allIpl.push(p);
    }
  };
  walk(path.join(root, "data"), 0);
  // Drop the map files that are not gameplay world geometry: `overview` is the flat top-down radar/map
  // graphic the engine floats high above the city (z ~ 225) and only shows on the pause map - in a converted
  // level it hangs upside-down in the sky; `making` and `temppart` are developer test scraps. gta3.dat does
  // not load making/temppart at all, and overview only for the map screen.
  const SKIP = /^(overview|making|temppart)\.(ipl|ide)$/i;
  const keep = (files) => files.filter((f) => !SKIP.test(path.basename(f)));
  // Keep the deepest path per basename (subfolder over flat copy).
  const dedupeByBasename = (files) => {
    const best = new Map();
    for (const f of files) {
      const key = path.basename(f).toLowerCase();
      const cur = best.get(key);
      if (!cur || f.split(/[\\/]/).length > cur.split(/[\\/]/).length) best.set(key, f);
    }
    return [...best.values()];
  };
  return { ide: dedupeByBasename(keep(allIde)), ipl: dedupeByBasename(keep(allIpl)) };
}

// Named map zones: the game's own district labels (GTA III HARWOOD/REDLIGH/CHINA/STADIUM..., Vice City
// DTOWN/BEACH/STARI/A_PORT...). Row: `NAME, type, x1,y1,z1, x2,y2,z2, level`. Only type 0 (the navigation
// districts) is kept; other types are road-bridge, radar-box and info sub-zones. GTA III keeps them in
// gta3.zon; Vice City in navig.zon (its gta_vc.zon does not exist - map.zon is radar boxes, info.zon is
// too granular). First file with any type-0 zone wins. Used to label a tile by the district it covers.
function readZones(root) {
  const zones = [];
  for (const name of ["gta3.zon", "gta_vc.zon", "navig.zon"]) {
    let text; try { text = fs.readFileSync(path.join(root, "data", name), "latin1"); } catch (e) { continue; }
    for (const { section, cols } of rows(text)) {
      if (section !== "zone") continue;
      if (cols.length < 9 || parseInt(cols[1], 10) !== 0) continue;
      const c = cols.map(Number);
      const x0 = Math.min(c[2], c[5]), y0 = Math.min(c[3], c[6]), x1 = Math.max(c[2], c[5]), y1 = Math.max(c[3], c[6]);
      if ([x0, y0, x1, y1].some(Number.isNaN)) continue;
      zones.push({ name: cols[0].replace(/[^A-Za-z0-9]/g, ""), x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) });
    }
    if (zones.length) break;
  }
  return zones;
}

// The district label for a world (x,y): the smallest zone box that contains it, else the nearest zone's,
// else "". Uppercase, filename-safe.
function zoneNameAt(zones, x, y) {
  let inside = null, nearest = null, nd = Infinity;
  for (const z of zones) {
    if (x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) { if (!inside || z.area < inside.area) inside = z; }
    const cx = (z.x0 + z.x1) / 2, cy = (z.y0 + z.y1) / 2, d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < nd) { nd = d; nearest = z; }
  }
  return (inside || nearest || { name: "" }).name;
}

module.exports = { readIde, readIpl, findDataFiles, readZones, zoneNameAt };
