// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Tactical Ops: Assault on Terror - an Unreal Tournament 99 total conversion, so its files are plain
// Unreal Engine 1 packages (file version 69, tag 0x9E2A83C1) with no encryption of any kind.
//
// A map names the packages it draws from ("to-wartorn", "richchurch") without a path or an
// extension, exactly as Lineage 2 does, so the same trick applies: index every package the install
// holds by lowercased name and let the extension fall out of where the file lives. The mod's own
// folder is searched before the UT99 base install underneath it, which is the order the engine uses
// and the reason TO's `Textures\TO-Skybox.utx` wins over anything of that name in the root.
"use strict";

const fs = require("fs");
const path = require("path");
const { parsePackage } = require("../unreal/read");

// Every extension the engine loads a package from. `.unr` is in the list because TO ships one of its
// sky packages - TacticalOps\Textures\TO-SnowSkybox.unr - as a level file full of textures.
const EXT = new Set([".unr", ".utx", ".u", ".uax", ".umx", ".usx", ".uvx"]);
// The mod's own tree first, then the UT99 install it sits in.
const ROOTS = ["TacticalOps", "."];
const FOLDERS = ["Maps", "Textures", "System", "Sounds", "Music", "StaticMeshes"];

function load(file) {
  const pkg = parsePackage(fs.readFileSync(file));
  if (pkg.header.tag !== (0x9e2a83c1 >>> 0) && pkg.header.tag !== (0x9e2a83c2 >>> 0)) {
    throw new Error(path.basename(file) + ": not an Unreal package (tag 0x" + pkg.header.tag.toString(16) + ")");
  }
  pkg.file = file;
  pkg.pkgName = path.basename(file).replace(/\.[^.]+$/, "");
  return pkg;
}

class Client {
  constructor(root) {
    this.root = root;
    this.byName = new Map();
    this.open = new Map();
    for (const sub of ROOTS) {
      for (const folder of FOLDERS) {
        const dir = path.join(root, sub, folder);
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { continue; }
        for (const n of names) {
          if (!EXT.has(path.extname(n).toLowerCase())) continue;
          const key = path.basename(n, path.extname(n)).toLowerCase();
          if (!this.byName.has(key)) this.byName.set(key, path.join(dir, n));
        }
      }
    }
  }

  has(name) { return this.byName.has(String(name).toLowerCase()); }
  pathOf(name) { return this.byName.get(String(name).toLowerCase()) || null; }

  // Packages stay open: one map's surfaces come back to the same dozen .utx thousands of times.
  get(name) {
    const key = String(name).toLowerCase();
    if (this.open.has(key)) return this.open.get(key);
    const file = this.byName.get(key);
    let pkg = null;
    try { pkg = file ? load(file) : null; } catch (e) { pkg = null; }
    this.open.set(key, pkg);
    return pkg;
  }

  // The game's own maps: TO-*.unr in a Maps folder, without the menu backdrops (Entry, Intro,
  // CreditsTO). The folder test is not decoration - TO ships one of its sky packages as
  // `Textures\TO-SnowSkybox.unr`, which is a level file holding textures and nothing else.
  maps() {
    const out = [];
    for (const [key, file] of this.byName) {
      if (path.extname(file).toLowerCase() !== ".unr") continue;
      if (!/[\\/]maps[\\/][^\\/]+$/i.test(file)) continue;
      if (!/^to[-_]/i.test(key)) continue;
      out.push({ name: path.basename(file, path.extname(file)), file });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

// An object reference out of a map - a surface's texture, an actor's brush - resolved to the export
// that holds it, following the import into whatever package of the client it lives in.
//
// The property reader is the Lineage 2 route's: the tagged property block and the import chain are
// the engine's, not that game's, and a UT99 package writes the same bytes.
// `prefer(className)` breaks a tie: a package can hold a Texture and a Palette of the same name -
// GreatFire's `anchot` is both - and the caller knows which of the two it came looking for.
function resolveRef(pkg, ref, client, prefer) {
  const { refTarget } = require("../lineage2/props");
  const t = refTarget(pkg, ref);
  if (!t) return null;
  if (t.local) return { pkg, exp: t.local };
  const other = t.pkg && client ? client.get(t.pkg) : null;
  if (!other) return null;
  // A package names its objects inside groups ("richchurch.Base.stonerough1"), and two groups can
  // hold the same name - so the group is matched when it is known, and the bare name is the
  // fallback for the packages that have none.
  const wanted = String(t.name).toLowerCase();
  const group = t.group && t.group.length ? String(t.group[t.group.length - 1]).toLowerCase() : null;
  const inGroup = (e) => {
    if (!group) return true;
    const outer = e.packageIndex > 0 ? other.exports[e.packageIndex - 1] : null;
    return !!outer && String(outer.name).toLowerCase() === group;
  };
  const hits = other.exports.filter((e) => String(e.name).toLowerCase() === wanted && e.serialSize > 0);
  const rank = (e) => (inGroup(e) ? 0 : 2) + (prefer && !prefer(other.classOf(e)) ? 1 : 0);
  const best = hits.sort((a, b) => rank(a) - rank(b))[0];
  return best ? { pkg: other, exp: best } : null;
}

module.exports = { load, Client, resolveRef };
