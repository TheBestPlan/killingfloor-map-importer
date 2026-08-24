#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// CLI front end. Example:
//   node src/cli.js "D:/.../cstrike/maps/cs_assault.bsp" --out "D:/.../KillingFloor/Maps" --verify
"use strict";

const fs = require("fs");
const path = require("path");
const { convert, DEFAULTS } = require("./convert");
const { verify } = require("./verify");
const { clientRoots } = require("./resources");

function parseArgs(argv) {
  const a = { _: [], scale: DEFAULTS.scale, lightMapScale: DEFAULTS.lightMapScale, wadDirs: [], verify: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--out") a.out = argv[++i];
    else if (t === "--name") a.name = argv[++i];
    else if (t === "--scale") { const v = argv[++i]; if (/^auto$/i.test(v)) a.autoScale = true; else a.scale = parseFloat(v); }
    else if (t === "--lightmap-scale") a.lightMapScale = parseFloat(argv[++i]);
    else if (t === "--wad") a.wadDirs.push(argv[++i]);
    else if (t === "--cs-dir") a.csDir = argv[++i];
    else if (t === "--verify") a.verify = true;
    else if (t === "--ase") a.ase = true;
    else if (t === "--no-spawns") a.noSpawns = true;
    else if (t === "--no-swim") a.noSwim = true;
    else if (t === "--wade") a.wade = parseFloat(argv[++i]);
    else if (t === "--health-scale") a.healthScale = parseFloat(argv[++i]);
    else if (t === "--lighting") a.lighting = argv[++i];
    else if (t === "--light-scale") a.lightScale = parseFloat(argv[++i]);
    else if (t === "--bare") a.bare = true;
    else if (t === "--sky") a.sky = argv[++i];
    else if (t === "--no-sky") a.noSky = true;
    else if (t === "--no-extras") a.noExtras = true;
    else if (t === "--no-light") a.noLight = true;
    else if (t === "--no-brush-entities") a.noBrushEntities = true;
    else if (t === "--no-masked") a.noMasked = true;
    else if (t === "--no-sections") a.noSections = true;
    else if (t === "--empty-world") a.emptyWorld = true;
    else if (t === "--no-hulls") a.noHulls = true;
    else if (t === "--stock-texture") a.stockTexture = true;
    else if (t === "--texture-format") a.textureFormat = argv[++i];
    else if (t === "--face-limit") a.faceLimit = parseInt(argv[++i], 10);
    else if (t === "--max-depth") a.maxDepth = parseInt(argv[++i], 10);
    else if (t === "--spawn-limit") a.spawnLimit = parseInt(argv[++i], 10);
    else if (t === "--spawn-index") a.spawnIndex = parseInt(argv[++i], 10);
    else if (t === "--no-split-polys") a.noSplitPolys = true;
    else if (t === "--tree-translate") a.treeTranslate = true;
    else if (t === "--geometry") a.geometry = argv[++i];
    // Which game the map comes from. "cs" is the GoldSrc .bsp route and the default; "l2" reads a
    // Lineage 2 client instead, where a map is a square of the world rather than a file you point at.
    else if (t === "--game") a.game = argv[++i];
    else if (t === "--client") a.clientDir = argv[++i];
    else if (t === "--square") a.square = argv[++i];
    else if (t === "--terrain-step") a.terrainStep = parseInt(argv[++i], 10);
    else if (t === "--ambient") a.ambient = parseInt(argv[++i], 10);
    else if (t === "--glow") a.glow = parseInt(argv[++i], 10);
    else if (t === "--no-grass") a.grass = false;
    else if (t === "--cull-dist") a.cullDist = parseInt(argv[++i], 10);
    else if (t === "--no-fog") a.fog = false;
    else if (t === "--auto-color" || t === "--auto-colour") a.autoColor = true;
    else if (t === "--two-sided") a.twoSided = true;
    else if (t === "--no-ground-up") a.noGroundUp = true;
    else if (t === "--fog-color") a.fogColor = argv[++i].split(",").map(Number);
    else if (t === "--fog-start") a.fogStart = parseInt(argv[++i], 10);
    else if (t === "--fog-end") a.fogEnd = parseInt(argv[++i], 10);
    else if (t === "--no-blend") a.blend = false;
    else if (t === "--carve") a.carve = true;
    else if (t === "--hull-max") a.hullMax = parseInt(argv[++i], 10);
    // Quake 3: the map is a name inside the client's .pk3 archives, or a loose .bsp.
    else if (t === "--map") a.map = argv[++i];
    else if (t === "--mod") a.mod = argv[++i];
    else if (t === "--patch-level") a.patchLevel = parseInt(argv[++i], 10);
    else if (t === "--max-texture") a.maxTexture = parseInt(argv[++i], 10);
    else if (t === "--light-gain") a.lightGain = parseFloat(argv[++i]);
    else if (t === "--light-floor") a.lightFloor = parseFloat(argv[++i]);
    else if (t === "--no-doors") a.doors = false;
    // The second layer of a terrain shader is a second pass over the same triangles; a Team Arena
    // terrain map pays about 4% more of them for it, and this turns it off.
    else if (t === "--no-terrain-layers") a.terrainLayers = false;
    // Tactical Ops: the movers (doors, gates, glass) and the water volumes, for bisecting a build.
    else if (t === "--no-movers") a.movers = false;
    else if (t === "--no-water") a.water = false;
    // 3D model route (glTF/GLB/OBJ): crop one square of a big scene; pre-divide world textures.
    else if (t === "--crop") a.crop = argv[++i];
    else if (t === "--whole") a.whole = true;
    // GTA: split the whole city into <m>-metre squares, one .rom per populated square. Bare --tile uses
    // the default size; --tile-overlap / --min-instances tune the seam context and the empty-square cutoff.
    else if (t === "--tile") { const nx = argv[i + 1]; if (nx !== undefined && /^\d+$/.test(nx)) a.tile = parseInt(argv[++i], 10); else a.tile = true; }
    else if (t === "--tile-overlap") a.tileOverlap = parseInt(argv[++i], 10);
    else if (t === "--min-instances") a.minInstances = parseInt(argv[++i], 10);
    else if (t === "--level") a.level = argv[++i];
    else if (t === "--tex-gain") a.texGain = parseFloat(argv[++i]);
    else if (t.startsWith("--")) throw new Error("unknown option " + t);
    else a._.push(t);
  }
  return a;
}

// First-4-bytes engine sniff, so a mis-flagged file routes itself instead of throwing a raw magic
// error: "VBSP" is a Source 1 BSP, 0x55AA1234 is a Source 2 VPK. Returns null for anything else
// (a .glb, an unreadable path) so the caller keeps its own handling.
function sniffEngine(file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    if (b.toString("latin1") === "VBSP") return "source1";
    if (b.readUInt32LE(0) === 0x55aa1234) return "source2";
  } catch (e) { /* unreadable - let the caller report it */ }
  return null;
}

// Source 2 (CS2) map .vpk -> .rom. Shared by the --game source2 route and the sniff redirect from the
// Source 1 route.
function runSource2(a, vpkFile) {
  const s2 = require("./source2/convert");
  if (!vpkFile) {
    console.log("usage: node src/cli.js --game source2 <map.vpk> [--out <dir|file>] [--name KF-Name]");
    console.log("       [--scale 1.9165] [--ambient 52] [--glow 34] [--tex-gain 0.57] [--cull-dist 0] [--verify]");
    process.exit(1);
  }
  if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
  const res = s2.convert({
    file: vpkFile, mapName: a.name,
    outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
    outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
    scale: a.scale === DEFAULTS.scale ? undefined : a.scale,
    ambient: a.ambient, glow: a.glow, texGain: a.texGain,
    autoColor: a.autoColor !== false, cullDistance: a.cullDist,
    emitPlayerStarts: !a.noSpawns, noSky: a.noSky,
    log: (m) => console.log("  " + m),
  });
  if (a.verify) {
    const v = verify(res.out);
    console.log(v.report);
    process.exit(v.ok ? 0 : 2);
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));

  // Lineage 2: the input is a client folder and the name of a world square, not a file.
  if (/^(l2|lineage2?)$/i.test(a.game || "")) {
    const l2 = require("./lineage2/convert");
    const clientDir = a.clientDir || a._[0];
    if (!clientDir || !a.square) {
      console.log("usage: node src/cli.js --game l2 --client <Lineage 2 folder> --square 24_13");
      console.log("       [--out <dir>] [--name KF-Name] [--scale 2.1739] [--terrain-step 1]");
      console.log("       [--no-grass] [--no-blend] [--carve] [--verify]");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = l2.convert({
      clientDir, square: a.square, mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      scale: a.scale === DEFAULTS.scale ? undefined : a.scale,   // the CS default is not the L2 one
      terrainStep: a.terrainStep, ambient: a.ambient, glow: a.glow, grass: a.grass, blend: a.blend,
      carve: a.carve,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) {
      const v = verify(res.out);
      console.log(v.report);
      process.exit(v.ok ? 0 : 2);
    }
    return;
  }

  // Quake 3 / Team Arena: a map is a name inside the client's .pk3 archives, or a loose .bsp with
  // the client alongside it for the textures.
  if (/^(q3|quake3?|quake ?iii)$/i.test(a.game || "")) {
    const q3 = require("./quake3/convert");
    const clientDir = a.clientDir || (a.map ? a._[0] : null);
    const bspFile = a.map ? null : a._.find((t) => /\.bsp$/i.test(t));
    if (!bspFile && !a.map) {
      console.log("usage: node src/cli.js --game q3 --client <Quake III folder> --map q3dm6 [--mod missionpack]");
      console.log("       node src/cli.js --game q3 <map.bsp> --client <Quake III folder>");
      console.log("       [--out <dir>] [--name KF-Name] [--scale 1.8634] [--patch-level 0=auto] [--verify]");
      console.log("       [--light-gain 4] [--light-floor 20] [--ambient 40] [--glow 96] [--no-sky] [--no-doors]");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = q3.convert({
      clientDir, map: a.map, mod: a.mod, bspFile, mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      scale: a.scale === DEFAULTS.scale ? undefined : a.scale,   // the CS default is not the Q3 one
      patchLevel: a.patchLevel, maxTexture: a.maxTexture, textureFormat: a.textureFormat,
      ambient: a.ambient, glow: a.glow, lightGain: a.lightGain, lightFloor: a.lightFloor,
      lightScale: a.lightScale, noSky: a.noSky, doors: a.doors, terrainLayers: a.terrainLayers,
      emitPlayerStarts: !a.noSpawns, spawnLimit: a.spawnLimit,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) {
      const v = verify(res.out);
      console.log(v.report);
      process.exit(v.ok ? 0 : 2);
    }
    return;
  }

  // Tactical Ops and Unreal Tournament 99: both Unreal Engine 1, one converter, a profile picks the
  // install layout and map-name prefixes. A map is a .unr inside an installed client, or a loose one
  // with the client alongside it for the textures.
  const isTO = /^(to|tacticalops|tactical ?ops)$/i.test(a.game || "");
  const isUT99 = /^(ut99?|unreal ?tournament|ut ?goty)$/i.test(a.game || "");
  if (isTO || isUT99) {
    const to = require("./tacticalops/convert");
    const profile = isUT99 ? "ut99" : "to";
    const clientDir = a.clientDir || (a.map ? a._[0] : null);
    const mapFile = a.map ? null : a._.find((t) => /\.unr$/i.test(t));
    if (!mapFile && !a.map) {
      const g = profile, folder = isUT99 ? "Unreal Tournament" : "Tactical Ops", ex = isUT99 ? "DM-Deck16][" : "TO-Crossfire";
      console.log("usage: node src/cli.js --game " + g + " --client <" + folder + " folder> --map " + ex);
      console.log("       node src/cli.js --game " + g + " <" + ex + ".unr> --client <" + folder + " folder>");
      console.log("       [--out <dir>] [--name KF-Name] [--scale 1.3397] [--verify]");
      console.log("       [--light-gain 3] [--light-floor 20] [--ambient 32] [--glow 64]");
      console.log("       [--no-light] [--no-sky] [--no-movers] [--no-water] [--spawn-limit N]");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = to.convert({
      profile, clientDir, map: a.map, mapFile, mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      scale: a.scale === DEFAULTS.scale ? undefined : a.scale,   // the CS default is not the TO one
      ambient: a.ambient, glow: a.glow, lightGain: a.lightGain, lightFloor: a.lightFloor,
      lightScale: a.lightScale, noLight: a.noLight, noSky: a.noSky, movers: a.movers, water: a.water,
      emitPlayerStarts: !a.noSpawns, spawnLimit: a.spawnLimit,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) {
      const v = verify(res.out);
      console.log(v.report);
      process.exit(v.ok ? 0 : 2);
    }
    return;
  }

  // Source engine BSP: Counter-Strike: Source / CS:GO, Half-Life 2, Garry's Mod, Left 4 Dead. One
  // VBSP reader for all of them; the input is a loose .bsp file.
  if (/^(source|vbsp|css|cs:?source|csgo|cs:?go|gmod|garrys ?mod|l4d2?|left ?4 ?dead ?2?|hl2|half-?life ?2)$/i.test(a.game || "")) {
    const src = require("./source/convert");
    const bspFile = a._.find((t) => /\.bsp$/i.test(t)) || a._[0];
    if (!bspFile) {
      console.log("usage: node src/cli.js --game source <map.bsp> [--out <dir|file>] [--name KF-Name]");
      console.log("       [--scale 1.9165] [--crop cx,cy,half] [--ambient 64] [--glow 48] [--no-sky] [--no-spawns] [--verify]");
      process.exit(1);
    }
    // A Source 2 map handed to the Source 1 route: route it to the right reader instead of failing on
    // the VBSP magic check.
    if (sniffEngine(bspFile) === "source2") {
      console.log("note: " + path.basename(bspFile) + " is a Source 2 (CS2) .vpk, not a Source 1 BSP - using the Source 2 reader.");
      return runSource2(a, bspFile);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = src.convert({
      file: bspFile, mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      scale: a.scale === DEFAULTS.scale ? undefined : a.scale,
      crop: a.crop, ambient: a.ambient, glow: a.glow, lightScale: a.lightScale,
      texGain: a.texGain, maxTexture: a.maxTexture, lights: !a.noLight, noSky: a.noSky, emitPlayerStarts: !a.noSpawns,
      grass: a.grass, cullDistance: a.cullDist,
      fog: a.fog, fogColor: a.fogColor, fogStart: a.fogStart, fogEnd: a.fogEnd,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) {
      const v = verify(res.out);
      console.log(v.report);
      process.exit(v.ok ? 0 : 2);
    }
    return;
  }

  // CS2 / Source 2: the compiled world lives in a `.vpk` (v2), its geometry baked into embedded
  // .vmdl_c resources (KV3 + meshopt). Parsed natively (src/source2). Handed a decompiled
  // .glb/.gltf/.obj instead, this alias falls through to the model route below.
  if (/^(cs2|source ?2|cs:?2|vpk2)$/i.test(a.game || "") && a._.some((t) => /\.vpk$/i.test(t))) {
    const vpkFile = a._.find((t) => /\.vpk$/i.test(t));
    if (sniffEngine(vpkFile) === "source1") {
      console.log("note: " + path.basename(vpkFile) + " is a Source 1 BSP, not a Source 2 VPK - use --game source.");
      process.exit(1);
    }
    return runSource2(a, vpkFile);
  }

  // GTA III / Vice City: a RenderWare map. Point --client at the game's install root (the folder with
  // models\gta3.img and data\); one district is cropped out by default (--crop cx,cy,half in metres,
  // or --whole for the entire city).
  if (/^(gta3?|gta ?iii|vc|gtavc|vice ?city)$/i.test(a.game || "")) {
    const gta = require("./gta/convert");
    const root = a.clientDir || a._[0];
    if (!root) {
      console.log("usage: node src/cli.js --game gta3 --client <GTA III folder> [--out <dir>] [--verify]");
      console.log("       node src/cli.js --game vc   --client <Vice City folder> [--crop cx,cy,half] [--whole]");
      console.log("       --tile [m]         split the whole city into m-metre squares (default 500), one .rom each");
      console.log("       --tile-overlap m   extra margin pulled into each square so seam objects keep context");
      console.log("       --min-instances n  skip squares with fewer than n instances (empty water); default 12");
      console.log("       [--name KF-Name] [--scale 40] [--ambient 60] [--glow 40] [--cull-dist 12000]");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = gta.convert({
      clientDir: root, game: /^(vc|gtavc|vice)/i.test(a.game) ? "vc" : "gta3", mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      scale: a.scale === DEFAULTS.scale ? undefined : a.scale,
      crop: a.crop, whole: a.whole, tile: a.tile, tileOverlap: a.tileOverlap, minInstances: a.minInstances,
      ambient: a.ambient, glow: a.glow, texGain: a.texGain,
      cullDistance: a.cullDist, autoColor: a.autoColor, emitPlayerStarts: !a.noSpawns,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) {
      const list = Array.isArray(res) ? res : [res];   // --tile returns one result per square
      let allOk = true;
      for (const r of list) { const v = verify(r.out); console.log(path.basename(r.out) + ": " + (v.ok ? "verify OK" : "verify FAIL\n" + v.report)); if (!v.ok) allOk = false; }
      process.exit(allOk ? 0 : 2);
    }
    return;
  }

  // Project IGI: a level's models .res (ILFF), or a level/game folder to search for one.
  if (/^igi$/i.test(a.game || "")) {
    const igi = require("./igi/convert");
    const input = a.clientDir || a._.find((t) => /\.res$/i.test(t)) || a._[0];
    if (!input) {
      console.log("usage: node src/cli.js --game igi <level.res | level folder> [--out <dir>] [--verify]");
      console.log("       e.g. …/missions/location0/level2/models/level2.res  (or the level folder)");
      console.log("       [--name KF-Name] [--scale auto] [--ambient 60] [--glow 40]");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = igi.convert({
      file: input, mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      scale: a.autoScale ? undefined : (a.scale === DEFAULTS.scale ? undefined : a.scale),
      ambient: a.ambient, glow: a.glow, autoColor: a.autoColor, cullDistance: a.cullDist, emitPlayerStarts: !a.noSpawns,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) { const v = verify(res.out); console.log(v.report); process.exit(v.ok ? 0 : 2); }
    return;
  }

  // Vampire: The Masquerade - Redemption - a .nil level, or the Levels.nob archive (a ZIP of levels).
  if (/^(vtmr|vampire|redemption)$/i.test(a.game || "")) {
    const vtmr = require("./vtmr/convert");
    const input = a.clientDir || a._.find((t) => /\.(nil|nob)$/i.test(t)) || a._[0];
    if (!input) {
      console.log("usage: node src/cli.js --game vtmr <Levels.nob | level.nil> [--out <dir>] [--verify]");
      console.log("       [--level l1_brot] (pick one level from a .nob) [--name KF-Name] [--scale N]");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = vtmr.convert({
      file: input, level: a.level, mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      scale: a.autoScale ? undefined : (a.scale === DEFAULTS.scale ? undefined : a.scale),
      ambient: a.ambient, glow: a.glow, autoColor: a.autoColor, cullDistance: a.cullDist, emitPlayerStarts: !a.noSpawns,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) { const v = verify(res.out); console.log(v.report); process.exit(v.ok ? 0 : 2); }
    return;
  }

  // Savage: The Battle for Newerth - a .s2z map archive (its terrain heightfield).
  if (/^savage$/i.test(a.game || "")) {
    const sv = require("./savage/convert");
    const file = a._.find((t) => /\.s2z$/i.test(t)) || a._[0];
    if (!file) {
      console.log("usage: node src/cli.js --game savage <map.s2z> [--out <dir>] [--name KF-Name] [--verify]");
      console.log("       [--ambient 64] [--glow 44]   (terrain only; objects not carried yet)");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = sv.convert({
      file, mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      ambient: a.ambient, glow: a.glow, autoColor: a.autoColor, emitPlayerStarts: !a.noSpawns,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) { const v = verify(res.out); console.log(v.report); process.exit(v.ok ? 0 : 2); }
    return;
  }

  // 3D model route: a scene exported to glTF/GLB/OBJ (Sketchfab, CGTrader, a Blender .blend, an
  // Open3DLab rip, or a decompiled Source / Source 2 (CS2) map). The input is the .glb/.gltf/.obj file.
  if (/^(gltf|glb|obj|model|mesh|cs2|source ?2|cs:?2)$/i.test(a.game || "")) {
    const g = require("./gltf/convert");
    const file = a._.find((t) => /\.(glb|gltf|obj)$/i.test(t)) || a._[0];
    if (!file) {
      console.log("usage: node src/cli.js --game model <scene.glb|.gltf|.obj> [--out <dir|file>] [--name KF-Name]");
      console.log("       [--scale 1.0] [--crop cx,cy,half] [--ambient 64] [--glow 48] [--tex-gain 0.7]");
      console.log("       [--light-gain 0.6] [--max-texture 512] [--no-light] [--no-sky] [--no-spawns] [--verify]");
      console.log("  axis/scale knobs: KF_GLTF_AXES=\"0,2,1\" KF_GLTF_FLIP=\"0,0,0\" KF_CELL=2048 KF_SPAWN_AT=\"x,y,z,yaw\"");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = g.convert({
      file, mapName: a.name,
      outFile: a.out && /\.rom$/i.test(a.out) ? a.out : null,
      outDir: a.out && !/\.rom$/i.test(a.out) ? a.out : null,
      scale: a.scale === DEFAULTS.scale ? undefined : a.scale,   // the CS default is not the model one
      crop: a.crop, ambient: a.ambient, glow: a.glow, lightGain: a.lightGain, lightScale: a.lightScale,
      texGain: a.texGain, maxTexture: a.maxTexture, lights: !a.noLight, noSky: a.noSky, emitPlayerStarts: !a.noSpawns,
      twoSided: a.twoSided === true, groundUp: a.noGroundUp !== true, autoColor: a.autoColor, autoScale: a.autoScale,
      log: (m) => console.log("  " + m),
    });
    if (a.verify) {
      const v = verify(res.out);
      console.log(v.report);
      process.exit(v.ok ? 0 : 2);
    }
    return;
  }

  if (!a._.length) {
    console.log("usage: node src/cli.js <map.bsp> [--out <dir|file>] [--name KF-Name] [--scale 1.9165]");
    console.log("       [--lightmap-scale 32] [--wad <dir>]... [--verify] [--ase] [--no-spawns]");
    process.exit(1);
  }
  const bspFile = a._[0];
  // Extra folders only: convert() adds the map's own neighbourhood and any installed
  // Counter-Strike itself. See resources.js.
  const wadDirs = a.wadDirs.slice();
  if (a.csDir) wadDirs.unshift(...clientRoots(a.csDir));

  // Anything that is not explicitly a .rom file name is a directory, created if missing.
  const outIsDir = a.out && !/\.rom$/i.test(a.out);
  if (outIsDir) fs.mkdirSync(a.out, { recursive: true });
  const res = convert({
    bspFile, outFile: outIsDir ? null : a.out || null, outDir: outIsDir ? a.out : null,
    mapName: a.name, scale: a.scale, lightMapScale: a.lightMapScale,
    wadDirs, emitPlayerStarts: !a.noSpawns, log: (m) => console.log("  " + m),
    sky: a.sky, noSky: a.noSky, noExtras: a.noExtras, noLight: a.noLight, brushEntities: !a.noBrushEntities, noMasked: a.noMasked, noSections: a.noSections, emptyWorld: a.emptyWorld, noHulls: a.noHulls, stockTexture: a.stockTexture, textureFormat: a.textureFormat, faceLimit: a.faceLimit, maxDepth: a.maxDepth, spawnLimit: a.spawnLimit, spawnIndex: a.spawnIndex, noSplitPolys: a.noSplitPolys, treeTranslate: a.treeTranslate, geometry: a.geometry || undefined, hullMax: a.hullMax, bare: a.bare, noSwim: a.noSwim, wade: a.wade, healthScale: a.healthScale, lighting: a.lighting, lightScale: a.lightScale,
  });

  if (a.ase) {
    const { writeAse, writeT3d } = require("./backendB");
    const base = res.out.replace(/\.rom$/i, "");
    writeAse(bspFile, base + ".ase", { scale: a.scale, wadDirs });
    writeT3d(bspFile, base + ".t3d", { scale: a.scale });
    console.log("  backend B: " + base + ".ase / .t3d");
  }

  if (a.verify) {
    const v = verify(res.out);
    console.log(v.report);
    process.exit(v.ok ? 0 : 2);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
}
