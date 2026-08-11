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
    else if (t === "--stock-sky") a.stockSky = argv[++i];
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
    else if (t === "--hull-max") a.hullMax = parseInt(argv[++i], 10);
    else if (t.startsWith("--")) throw new Error("unknown option " + t);
    else a._.push(t);
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a._.length) {
    console.log("usage: node src/cli.js <map.bsp> [--out <dir|file>] [--name KF-Name] [--scale 2]");
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
    sky: a.sky, stockSky: a.stockSky, noSky: a.noSky, noExtras: a.noExtras, noLight: a.noLight, brushEntities: !a.noBrushEntities, noMasked: a.noMasked, noSections: a.noSections, emptyWorld: a.emptyWorld, noHulls: a.noHulls, stockTexture: a.stockTexture, textureFormat: a.textureFormat, faceLimit: a.faceLimit, maxDepth: a.maxDepth, spawnLimit: a.spawnLimit, spawnIndex: a.spawnIndex, noSplitPolys: a.noSplitPolys, treeTranslate: a.treeTranslate, geometry: a.geometry || undefined, hullMax: a.hullMax, bare: a.bare, noSwim: a.noSwim, wade: a.wade, healthScale: a.healthScale, lighting: a.lighting, lightScale: a.lightScale,
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
