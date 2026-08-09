// Where to look for the things a .bsp needs but does not contain: WADs, and the gfx/env skybox.
//
// A downloaded map is usually the .bsp on its own, with `worldspawn.wad` naming halflife.wad,
// cstrike.wad, de_aztec.wad and so on. Searching only beside the map turns every texture into the
// magenta placeholder, which reads as a broken converter rather than a missing file - so the search
// covers, in order: folders the user named, the map's own neighbourhood, and any installed
// Counter-Strike.
"use strict";

const fs = require("fs");
const path = require("path");

function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }   // unreadable or disconnected drive
}

// Steam's own idea of where its libraries are: the default install plus every extra library it
// records in steamapps/libraryfolders.vdf. Guessing drive letters would miss the interesting ones.
function steamLibraries() {
  const homes = [
    process.env.STEAM_PATH,
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Steam"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Steam"),
    process.env.HOME && path.join(process.env.HOME, ".steam", "steam"),
    process.env.HOME && path.join(process.env.HOME, "Library", "Application Support", "Steam"),
  ].filter(Boolean);
  const libs = [];
  for (const home of homes) {
    if (!exists(home)) continue;
    libs.push(home);
    try {
      const vdf = fs.readFileSync(path.join(home, "steamapps", "libraryfolders.vdf"), "utf8");
      for (const m of vdf.matchAll(/"path"\s*"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, "/"));
    } catch (e) { /* no library index here */ }
  }
  return libs.filter((p, i) => libs.indexOf(p) === i);
}

// First installed copy of a Steam game by its steamapps/common folder name, or null.
function steamApp(name) {
  for (const lib of steamLibraries()) {
    const p = path.join(lib, "steamapps", "common", name);
    if (exists(p)) return p;
  }
  return null;
}

// Installed Half-Life / Counter-Strike roots. KF_HALFLIFE overrides the search.
function installedHalfLife() {
  const guesses = [process.env.KF_HALFLIFE, steamApp("Half-Life")].filter(Boolean);
  return guesses.filter((p, i) => guesses.indexOf(p) === i && exists(path.join(p, "cstrike")));
}

// A folder the user picked in the UI ("my Counter-Strike is here"). They may point at the game root
// (hl.exe next to cstrike/), at cstrike itself, or at a download pack - accept all three.
function clientRoots(dir) {
  if (!dir) return [];
  return [
    dir,
    path.join(dir, "cstrike"), path.join(dir, "valve"),
    path.join(dir, "cstrike_downloads"), path.join(dir, "valve_downloads"),
    path.join(dir, "cstrike", "downloads"),
    path.join(dir, "gfx"), path.join(dir, "cstrike", "gfx"),
  ].filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

// A map dropped in from anywhere brings its own folder tree with it: <pack>/cstrike/maps/x.bsp is
// the common shape, so the mod folders sit one and two levels up.
function neighbourhoodOf(bspFile) {
  const dir = path.dirname(bspFile);
  const up1 = path.resolve(dir, "..");
  const up2 = path.resolve(dir, "..", "..");
  return [dir, up1, up2, path.join(up1, "gfx"), path.resolve(up2, "cstrike"), path.resolve(up2, "valve")];
}

// Directories to search for .wad files, best first.
function wadDirs(bspFile, extra) {
  const dirs = [...(extra || []), ...neighbourhoodOf(bspFile)];
  for (const root of installedHalfLife()) {
    dirs.push(path.join(root, "cstrike"), path.join(root, "cstrike_downloads"),
      path.join(root, "cstrike", "downloads"), path.join(root, "valve"), path.join(root, "valve_downloads"));
  }
  return dirs.filter((d, i) => d && dirs.indexOf(d) === i);
}

// Roots that may contain gfx/env/<skyname>{up,dn,...}. Same idea, one level higher: the skybox lives
// in the mod folder, not next to the map.
function skyRoots(bspFile, extra) {
  const dir = path.dirname(bspFile);
  const roots = [
    ...(extra || []),
    path.resolve(dir, ".."), path.resolve(dir, "..", ".."), path.resolve(dir, "..", "..", ".."),
  ];
  for (const root of installedHalfLife()) {
    roots.push(path.join(root, "cstrike"), path.join(root, "valve"), path.join(root, "cstrike_downloads"));
  }
  return roots.filter((d, i) => d && roots.indexOf(d) === i);
}

// A mod-relative path out of an entity key ("sprites/glow01.spr"), resolved against the same roots
// the skybox uses. Returns null when the file is nowhere to be found.
function modFile(bspFile, rel, extra) {
  const clean = String(rel || "").replace(/^[\\/]+/, "").replace(/\\/g, "/");
  if (!clean) return null;
  for (const root of skyRoots(bspFile, extra)) {
    const p = path.join(root, clean);
    try { if (fs.existsSync(p)) return p; } catch (e) { /* unreadable drive */ }
  }
  return null;
}

module.exports = { wadDirs, skyRoots, installedHalfLife, clientRoots, modFile, steamApp };
