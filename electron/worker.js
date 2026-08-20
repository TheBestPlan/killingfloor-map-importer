// Runs one conversion in a child process and reports back over IPC.
"use strict";

const path = require("path");
const fs = require("fs");
const { convert } = require("../src/convert");
const { verify } = require("../src/verify");
const { clientRoots } = require("../src/resources");

// Lineage 2: the input is a client folder and the name of a world square, so it has its own
// converter rather than a flag on the GoldSrc one. Everything downstream - the verifier, the
// reporting, the child process - is shared.
function convertL2(job, log) {
  const l2 = require("../src/lineage2/convert");
  const res = l2.convert({
    clientDir: job.clientDir, square: job.square, mapName: job.name || null,
    outDir: job.outDir || null,
    // The Lineage 2 panel has a scale of its own: the two games' rulers differ by a different amount
    // than Half-Life's and Unreal's do.
    scale: job.l2Scale, terrainStep: job.terrainStep, ambient: job.ambient, glow: job.glow,
    grass: job.grass, blend: job.blend, carve: job.carve,
    log,
  });
  const v = verify(res.out);
  for (const line of v.report.split("\n")) log(line);
  process.send({
    kind: "done", ok: v.ok, out: res.out, mapName: res.mapName,
    size: fs.statSync(res.out).size,
    nodes: res.model ? res.model.nodes.length : 0,
    surfs: res.model ? res.model.surfs.length : 0,
    lightMaps: 0, atlases: 0,
    textures: res.textures || 0, missingTextures: 0,
    terrain: res.terrain,
  });
}

// Quake 3: the input is a client folder and a map name inside its .pk3 archives, so this too has a
// converter of its own rather than a flag on the GoldSrc one.
function convertQ3(job, log) {
  const q3 = require("../src/quake3/convert");
  const res = q3.convert({
    clientDir: job.clientDir, map: job.map, mod: job.mod, mapName: job.name || null,
    outDir: job.outDir || null,
    scale: job.q3Scale, patchLevel: job.patchLevel,
    ambient: job.ambient, glow: job.glow, lightGain: job.lightGain,
    terrainLayers: job.terrainLayers !== false,
    emitPlayerStarts: job.emitPlayerStarts !== false,
    log,
  });
  const v = verify(res.out);
  for (const line of v.report.split("\n")) log(line);
  process.send({
    kind: "done", ok: v.ok, out: res.out, mapName: res.mapName,
    size: fs.statSync(res.out).size,
    nodes: res.model ? res.model.nodes.length : 0,
    surfs: res.model ? res.model.surfs.length : 0,
    lightMaps: 0, atlases: res.lightmapPages || 0,
    textures: 0, missingTextures: 0,
    quake3: { triangles: res.stats.triangles, meshes: res.meshes, pages: res.lightmapPages },
  });
}

// Tactical Ops: an Unreal Engine 1 client and a map name inside it - the same shape as Quake 3.
function convertTO(job, log) {
  const to = require("../src/tacticalops/convert");
  const res = to.convert({
    clientDir: job.clientDir, map: job.map, mapName: job.name || null,
    outDir: job.outDir || null,
    scale: job.toScale, ambient: job.ambient, glow: job.glow, lightGain: job.lightGain,
    emitPlayerStarts: job.emitPlayerStarts !== false,
    log,
  });
  const v = verify(res.out);
  for (const line of v.report.split("\n")) log(line);
  process.send({
    kind: "done", ok: v.ok, out: res.out, mapName: res.mapName,
    size: fs.statSync(res.out).size,
    nodes: res.model ? res.model.nodes.length : 0,
    surfs: res.model ? res.model.surfs.length : 0,
    lightMaps: 0, atlases: res.lightmapPages || 0,
    textures: 0, missingTextures: 0,
    tacticalops: { triangles: Math.round(res.stats.triangles), meshes: res.meshes, pages: res.lightmapPages },
  });
}

// Source engine BSP (CS:Source / CS:GO, Half-Life 2, Garry's Mod, Left 4 Dead 1 & 2): a loose .bsp.
function convertSource(job, log) {
  const src = require("../src/source/convert");
  const res = src.convert({
    file: job.bspFile, mapName: job.name || null, outDir: job.outDir || null,
    scale: job.sourceScale, emitPlayerStarts: job.emitPlayerStarts !== false, log,
  });
  const v = verify(res.out);
  for (const line of v.report.split("\n")) log(line);
  process.send({
    kind: "done", ok: v.ok, out: res.out, mapName: res.mapName, size: fs.statSync(res.out).size,
    nodes: 0, surfs: 0, lightMaps: 0, atlases: 0, textures: 0, missingTextures: 0,
    mesh: { triangles: res.stats ? res.stats.tris || res.stats.triangles : 0, meshes: res.meshes },
  });
}

// 3D model: a scene exported to glTF/GLB/OBJ (Sketchfab, CGTrader, a Blender .blend, a decompiled map).
function convertModel(job, log) {
  const g = require("../src/gltf/convert");
  const res = g.convert({
    file: job.file, mapName: job.name || null, outDir: job.outDir || null,
    scale: job.modelScale, emitPlayerStarts: job.emitPlayerStarts !== false, log,
  });
  const v = verify(res.out);
  for (const line of v.report.split("\n")) log(line);
  process.send({
    kind: "done", ok: v.ok, out: res.out, mapName: res.mapName, size: fs.statSync(res.out).size,
    nodes: 0, surfs: 0, lightMaps: 0, atlases: 0, textures: 0, missingTextures: 0,
    mesh: { triangles: res.stats ? res.stats.triangles : 0, meshes: res.meshes, lights: res.lights },
  });
}

const GAME_CONVERTERS = { l2: convertL2, q3: convertQ3, to: convertTO, source: convertSource, model: convertModel };

process.on("message", (job) => {
  const log = (t) => process.send({ kind: "log", text: t });
  if (GAME_CONVERTERS[job.game]) {
    try { GAME_CONVERTERS[job.game](job, log); } catch (e) {
      log("ERROR: " + e.message);
      process.send({ kind: "done", ok: false, error: e.message });
    }
    process.exit(0);
    return;
  }
  // The picked Counter-Strike folder goes first: its stock WADs and gfx/env skyboxes are what a
  // downloaded .bsp is missing. convert() still adds the map's own neighbourhood after these.
  const wadDirs = [...clientRoots(job.csDir), ...(job.wadDirs || [])];
  try {
    const res = convert({
      bspFile: job.bspFile,
      outFile: job.outDir ? path.join(job.outDir, (job.name || ("KF-" + path.basename(job.bspFile).replace(/\.bsp$/i, ""))) + ".rom") : null,
      mapName: job.name || null,
      scale: job.scale, lightMapScale: job.lightMapScale, healthScale: job.healthScale, lighting: job.lighting, lightScale: job.lightScale,
      wadDirs, emitPlayerStarts: job.emitPlayerStarts !== false, log,
    });

    if (job.emitAse) {
      const { writeAse, writeT3d } = require("../src/backendB");
      const base = res.out.replace(/\.rom$/i, "");
      const a = writeAse(job.bspFile, base + ".ase", { scale: job.scale, wadDirs });
      const t = writeT3d(job.bspFile, base + ".t3d", { scale: job.scale });
      log("backend B: " + a.faces + " triangles, " + a.materials + " materials, " + t.playerStarts + " starts, " + t.lights + " lights");
    }

    const v = verify(res.out);
    for (const line of v.report.split("\n")) log(line);

    process.send({
      kind: "done", ok: v.ok, out: res.out, mapName: res.mapName,
      size: fs.statSync(res.out).size,
      nodes: res.model ? res.model.nodes.length : 0,
      surfs: res.model ? res.model.surfs.length : 0,
      lightMaps: res.model ? res.model.lightMaps.length : 0,
      atlases: res.model ? res.model.lightMapTextures.length : 0,
      textures: res.textures, missingTextures: res.missingTextures,
    });
  } catch (e) {
    log("ERROR: " + e.message);
    process.send({ kind: "done", ok: false, error: e.message });
  }
  process.exit(0);
});
