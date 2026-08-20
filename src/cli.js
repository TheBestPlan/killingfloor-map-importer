#!/usr/bin/env node
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
    else if (t === "--scale") a.scale = parseFloat(argv[++i]);
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
    else if (t.startsWith("--")) throw new Error("unknown option " + t);
    else a._.push(t);
  }
  return a;
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
      console.log("       [--out <dir>] [--name KF-Name] [--scale 1.8634] [--patch-level 4] [--verify]");
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

  // Tactical Ops: a map is a .unr inside an installed client, or a loose one with the client
  // alongside it for the textures.
  if (/^(to|tacticalops|tactical ?ops)$/i.test(a.game || "")) {
    const to = require("./tacticalops/convert");
    const clientDir = a.clientDir || (a.map ? a._[0] : null);
    const mapFile = a.map ? null : a._.find((t) => /\.unr$/i.test(t));
    if (!mapFile && !a.map) {
      console.log("usage: node src/cli.js --game to --client <Tactical Ops folder> --map TO-Crossfire");
      console.log("       node src/cli.js --game to <TO-Crossfire.unr> --client <Tactical Ops folder>");
      console.log("       [--out <dir>] [--name KF-Name] [--scale 1.3397] [--verify]");
      console.log("       [--light-gain 3] [--light-floor 20] [--ambient 32] [--glow 64]");
      console.log("       [--no-light] [--no-sky] [--no-movers] [--no-water] [--spawn-limit N]");
      process.exit(1);
    }
    if (a.out && !/\.rom$/i.test(a.out)) fs.mkdirSync(a.out, { recursive: true });
    const res = to.convert({
      clientDir, map: a.map, mapFile, mapName: a.name,
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
