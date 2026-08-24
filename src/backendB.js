// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Backend B: the editor-assisted route. Emits what UnrealEd/KFEd can import by hand —
//   <name>.ase   world geometry as one static mesh, per-vertex baked lighting, multi-material
//   <name>.t3d   level skeleton: world shell brush, player starts, converted light actors
//   textures/    8-bit BMPs the ASE material list points at
// Slower to use than the .rom backend (one manual import pass) but it goes through the editor's own
// importers, so it is the fallback when a generated package is not accepted.
//
// ponytail: lighting is sampled per polygon vertex, not per luxel — a large flat face gets one
// colour per corner. Tessellate on the 16-unit luxel grid if that shows.
"use strict";

const fs = require("fs");
const path = require("path");
const bspReader = require("./goldsrc/bsp");
const { WadSet, readMiptex } = require("./goldsrc/wad");
const { sanitizeName } = require("./unreal/texture");

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function writeBMP8(file, indices, palette, width, height) {
  const rowSize = Math.ceil(width / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels[(height - 1 - y) * rowSize + x] = indices[y * width + x];
  }
  const head = Buffer.alloc(14 + 40 + 1024);
  head.write("BM", 0, "latin1");
  head.writeUInt32LE(head.length + pixels.length, 2);
  head.writeUInt32LE(head.length, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(width, 18); head.writeInt32LE(height, 22);
  head.writeUInt16LE(1, 26); head.writeUInt16LE(8, 28);
  head.writeUInt32LE(pixels.length, 34);
  head.writeUInt32LE(256, 46); head.writeUInt32LE(256, 50);
  for (let i = 0; i < 256; i++) {
    head[54 + i * 4] = palette[i * 3 + 2]; head[54 + i * 4 + 1] = palette[i * 3 + 1];
    head[54 + i * 4 + 2] = palette[i * 3]; head[54 + i * 4 + 3] = 0;
  }
  fs.writeFileSync(file, Buffer.concat([head, pixels]));
}

function collect(bspFile, opts) {
  const map = bspReader.load(bspFile);
  const S = opts.scale || 2;
  const wads = new WadSet();
  if (map.wads.length) wads.addFromWorldspawn(map.wads, opts.wadDirs || []);
  const toUE = (p) => [p[0] * S, -p[1] * S, p[2] * S];

  const mats = [];                       // { name, width, height, miptex }
  const matIndex = new Map();
  const verts = [], faces = [], tverts = [], tfaces = [], cverts = [], cfaces = [];

  for (const face of map.faces) {
    const ti = map.texinfo[face.texinfo];
    const mt = map.miptex[ti.miptex];
    if (!mt || mt.kind === "tool") continue;
    let mi = matIndex.get(ti.miptex);
    if (mi === undefined) {
      let src = mt.embedded ? readMiptex(map.buf, mt.base) : wads.get(mt.name);
      mi = mats.length;
      mats.push({ name: sanitizeName(mt.name), width: mt.width, height: mt.height, src });
      matIndex.set(ti.miptex, mi);
    }
    const ring = map.faceVertices(face);
    if (ring.length < 3) continue;
    const lm = map.faceLightmapRGB(face);
    const base = verts.length;
    for (const p of ring) {
      verts.push(toUE(p));
      const s = dot(p, ti.s) + ti.sShift, t = dot(p, ti.t) + ti.tShift;
      tverts.push([s / mt.width, 1 - t / mt.height]);
      let col = [200, 200, 200];
      if (lm) {
        const lx = Math.max(0, Math.min(lm.width - 1, Math.round(s / 16 - lm.baseS)));
        const ly = Math.max(0, Math.min(lm.height - 1, Math.round(t / 16 - lm.baseT)));
        const o = (ly * lm.width + lx) * 3;
        col = [lm.rgb[o], lm.rgb[o + 1], lm.rgb[o + 2]];
      }
      cverts.push(col);
    }
    for (let i = 2; i < ring.length; i++) {
      faces.push([base, base + i - 1, base + i, mi]);
      tfaces.push([base, base + i - 1, base + i]);
      cfaces.push([base, base + i - 1, base + i]);
    }
  }
  return { map, mats, verts, faces, tverts, tfaces, cverts, cfaces, S };
}

function writeAse(bspFile, outFile, opts) {
  const g = collect(bspFile, opts);
  const texDir = path.join(path.dirname(outFile), "textures");
  fs.mkdirSync(texDir, { recursive: true });
  for (const m of g.mats) {
    if (!m.src || !m.src.mips) continue;
    writeBMP8(path.join(texDir, m.name + ".bmp"), m.src.mips[0].data, m.src.palette, m.src.width, m.src.height);
  }

  const L = [];
  L.push("*3DSMAX_ASCIIEXPORT\t200");
  L.push("*COMMENT \"converted from " + path.basename(bspFile) + "\"");
  L.push("*MATERIAL_LIST {");
  L.push("\t*MATERIAL_COUNT " + g.mats.length);
  g.mats.forEach((m, i) => {
    L.push("\t*MATERIAL " + i + " {");
    L.push("\t\t*MATERIAL_NAME \"" + m.name + "\"");
    L.push("\t\t*MATERIAL_CLASS \"Standard\"");
    L.push("\t\t*MATERIAL_SHADING Blinn");
    L.push("\t\t*MAP_DIFFUSE {");
    L.push("\t\t\t*MAP_NAME \"" + m.name + "\"");
    L.push("\t\t\t*MAP_CLASS \"Bitmap\"");
    L.push("\t\t\t*BITMAP \"" + path.join(texDir, m.name + ".bmp").replace(/\\/g, "\\\\") + "\"");
    L.push("\t\t\t*UVW_U_TILING 1.0");
    L.push("\t\t\t*UVW_V_TILING 1.0");
    L.push("\t\t}");
    L.push("\t}");
  });
  L.push("}");
  L.push("*GEOMOBJECT {");
  L.push("\t*NODE_NAME \"" + path.basename(outFile, ".ase") + "\"");
  L.push("\t*MESH {");
  L.push("\t\t*TIMEVALUE 0");
  L.push("\t\t*MESH_NUMVERTEX " + g.verts.length);
  L.push("\t\t*MESH_NUMFACES " + g.faces.length);
  L.push("\t\t*MESH_VERTEX_LIST {");
  g.verts.forEach((v, i) => L.push("\t\t\t*MESH_VERTEX " + i + "\t" + v[0].toFixed(4) + "\t" + v[1].toFixed(4) + "\t" + v[2].toFixed(4)));
  L.push("\t\t}");
  L.push("\t\t*MESH_FACE_LIST {");
  g.faces.forEach((f, i) => L.push("\t\t\t*MESH_FACE " + i + ": A: " + f[0] + " B: " + f[1] + " C: " + f[2] +
    " AB: 1 BC: 1 CA: 1\t*MESH_SMOOTHING 1\t*MESH_MTLID " + f[3]));
  L.push("\t\t}");
  L.push("\t\t*MESH_NUMTVERTEX " + g.tverts.length);
  L.push("\t\t*MESH_TVERTLIST {");
  g.tverts.forEach((t, i) => L.push("\t\t\t*MESH_TVERT " + i + "\t" + t[0].toFixed(6) + "\t" + t[1].toFixed(6) + "\t0.0000"));
  L.push("\t\t}");
  L.push("\t\t*MESH_NUMTVFACES " + g.tfaces.length);
  L.push("\t\t*MESH_TFACELIST {");
  g.tfaces.forEach((t, i) => L.push("\t\t\t*MESH_TFACE " + i + "\t" + t[0] + "\t" + t[1] + "\t" + t[2]));
  L.push("\t\t}");
  L.push("\t\t*MESH_NUMCVERTEX " + g.cverts.length);
  L.push("\t\t*MESH_CVERTLIST {");
  g.cverts.forEach((c, i) => L.push("\t\t\t*MESH_VERTCOL " + i + "\t" + (c[0] / 255).toFixed(4) + "\t" + (c[1] / 255).toFixed(4) + "\t" + (c[2] / 255).toFixed(4)));
  L.push("\t\t}");
  L.push("\t\t*MESH_NUMCVFACES " + g.cfaces.length);
  L.push("\t\t*MESH_CFACELIST {");
  g.cfaces.forEach((t, i) => L.push("\t\t\t*MESH_CFACE " + i + "\t" + t[0] + "\t" + t[1] + "\t" + t[2]));
  L.push("\t\t}");
  L.push("\t}");
  L.push("\t*MATERIAL_REF 0");
  L.push("}");
  fs.writeFileSync(outFile, L.join("\r\n") + "\r\n");
  return { vertices: g.verts.length, faces: g.faces.length, materials: g.mats.length, textures: texDir };
}

const fv = (v) => v.map((x) => (x < 0 ? "-" : "+") + Math.abs(x).toFixed(6).padStart(12, "0")).join(",");

function writeT3d(bspFile, outFile, opts) {
  const map = bspReader.load(bspFile);
  const S = opts.scale || 2;
  const toUE = (p) => [p[0] * S, -p[1] * S, p[2] * S];
  const lo = toUE(map.models[0].mins), hi = toUE(map.models[0].maxs);
  const min = [Math.min(lo[0], hi[0]) - 256, Math.min(lo[1], hi[1]) - 256, Math.min(lo[2], hi[2]) - 256];
  const max = [Math.max(lo[0], hi[0]) + 256, Math.max(lo[1], hi[1]) + 256, Math.max(lo[2], hi[2]) + 256];

  const L = ["Begin Map"];
  // One subtractive box around everything: Unreal starts solid, so the world has to be carved out
  // before the imported static mesh has somewhere to sit.
  L.push("Begin Actor Class=Brush Name=WorldShell");
  L.push("    CsgOper=CSG_Subtract");
  L.push("    Begin Brush Name=ModelWorldShell");
  L.push("       Begin PolyList");
  const corners = [
    { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, -1], p: [min[0], min[1], min[2]], quad: [[min[0], min[1], min[2]], [min[0], min[1], max[2]], [min[0], max[1], max[2]], [min[0], max[1], min[2]]] },
    { n: [1, 0, 0], u: [0, -1, 0], v: [0, 0, -1], p: [max[0], max[1], min[2]], quad: [[max[0], max[1], min[2]], [max[0], max[1], max[2]], [max[0], min[1], max[2]], [max[0], min[1], min[2]]] },
    { n: [0, -1, 0], u: [-1, 0, 0], v: [0, 0, -1], p: [max[0], min[1], min[2]], quad: [[max[0], min[1], min[2]], [max[0], min[1], max[2]], [min[0], min[1], max[2]], [min[0], min[1], min[2]]] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], p: [min[0], max[1], min[2]], quad: [[min[0], max[1], min[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]], [max[0], max[1], min[2]]] },
    { n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0], p: [min[0], max[1], min[2]], quad: [[min[0], max[1], min[2]], [max[0], max[1], min[2]], [max[0], min[1], min[2]], [min[0], min[1], min[2]]] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], p: [min[0], min[1], max[2]], quad: [[min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]]] },
  ];
  for (const c of corners) {
    L.push("          Begin Polygon Flags=0");
    L.push("             Origin   " + fv(c.p));
    L.push("             Normal   " + fv(c.n));
    L.push("             TextureU " + fv(c.u));
    L.push("             TextureV " + fv(c.v));
    for (const q of c.quad) L.push("             Vertex   " + fv(q));
    L.push("          End Polygon");
  }
  L.push("       End PolyList");
  L.push("    End Brush");
  L.push("    Brush=Model'MyLevel.ModelWorldShell'");
  L.push("End Actor");

  let n = 0;
  for (const e of map.entities) {
    if (e.classname !== "info_player_start" && e.classname !== "info_player_deathmatch") continue;
    const o = bspReader.num3(e.origin, [0, 0, 0]);
    const loc = toUE(o);
    const yaw = Math.round(((parseFloat(e.angle || 0) || 0) / 360) * 65536);
    L.push("Begin Actor Class=PlayerStart Name=PlayerStart" + n);
    L.push("    Location=(X=" + loc[0].toFixed(3) + ",Y=" + loc[1].toFixed(3) + ",Z=" + (loc[2] + 40).toFixed(3) + ")");
    L.push("    Rotation=(Yaw=" + yaw + ")");
    L.push("End Actor");
    n++;
  }

  let li = 0;
  for (const e of map.entities) {
    if (e.classname !== "light" && e.classname !== "light_spot") continue;
    const o = bspReader.num3(e.origin, [0, 0, 0]);
    const loc = toUE(o);
    const parts = (e._light || "255 255 255 200").trim().split(/\s+/).map(Number);
    const r = parts[0] || 255, g = parts.length > 1 ? parts[1] : r, b = parts.length > 2 ? parts[2] : r;
    const bright = parts.length > 3 ? parts[3] : 200;
    const mx = Math.max(r, g, b) || 1;
    // Unreal lights are HSV; brightness 0..255 and radius in 25-unit steps.
    const hsv = rgbToHsv(r / mx, g / mx, b / mx);
    L.push("Begin Actor Class=Light Name=Light" + li);
    L.push("    LightBrightness=" + Math.min(255, Math.round(bright * 0.6)).toFixed(6));
    L.push("    LightHue=" + Math.round(hsv[0] * 255));
    L.push("    LightSaturation=" + Math.round((1 - hsv[1]) * 255));
    L.push("    LightRadius=" + Math.min(255, Math.round((bright * S) / 25)));
    L.push("    Location=(X=" + loc[0].toFixed(3) + ",Y=" + loc[1].toFixed(3) + ",Z=" + loc[2].toFixed(3) + ")");
    L.push("End Actor");
    li++;
  }
  L.push("End Map");
  fs.writeFileSync(outFile, L.join("\r\n") + "\r\n");
  return { playerStarts: n, lights: li };
}

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h /= 6; if (h < 0) h += 1;
  return [h, mx ? d / mx : 0, mx];
}

module.exports = { writeAse, writeT3d, writeBMP8 };
