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
function readIpl(files) {
  const inst = [];
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
      inst.push({
        model, id: parseInt(cols[0], 10),
        pos: [t[0], t[1], t[2]], scale: [t[3], t[4], t[5]], quat: [t[6], t[7], t[8], t[9]],
      });
    }
  }
  return inst;
}

// Every .ide / .ipl under a game's root (data\ and data\maps\ hold them).
function findDataFiles(root) {
  const ide = [], ipl = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, depth + 1);
      else if (/\.ide$/i.test(d.name)) ide.push(p);
      else if (/\.ipl$/i.test(d.name)) ipl.push(p);
    }
  };
  walk(path.join(root, "data"), 0);
  return { ide, ipl };
}

module.exports = { readIde, readIpl, findDataFiles };
