// End-to-end conversion: one Quake 3 / Team Arena map -> Killing Floor .rom.
//
// The Killing Floor level skeleton below (LevelInfo, the builder brush, the world box, the zone,
// Level) is the third copy of what convert.js writes for the GoldSrc route and lineage2/convert.js
// for Lineage 2. It stays a copy for the same reason it did there: those files are the flow of one
// source game around the same twelve actors, and pulling them out from under two working converters
// is a change of its own.
//
// What is different here is the light. Quake 3 ships its lightmap as finished 128x128 PAGES with a
// UV per vertex, which is exactly the shape UE2.5 wants for a second texture channel - so the map's
// own baked light goes across as a Combiner(texture x atlas) with no repacking at all, and the
// shadows on a converted wall are the ones q3map baked in 1999.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Q3 = require("./bsp");
const { GameFs, searchDirs } = require("./pk3");
const { ShaderSet } = require("./shader");
const { loadTextures } = require("./texture");
const { buildMeshes } = require("./mesh");
const { loadSky, SIDES } = require("./sky");
const { Package, RF } = require("../unreal/package");
const { Writer, writeStateFrame } = require("../unreal/writer");
const { writeModel, emptyModel, emptyPolys } = require("../unreal/model");
const { writePolys, boxPolys } = require("../unreal/polys");
const { addRgbTexture, sanitizeName } = require("../unreal/texture");
const { buildMeshExport, buildMeshInstance } = require("../unreal/staticmesh");
const { buildModel } = require("../build/model");
const { installedQuake3 } = require("../resources");
const { buildSkyboxMesh, faceCorners } = require("../build/skyboxmesh");
const { orientSkybox } = require("../build/skyboxorient");
const { upscale } = require("../build/upscale");
const brushEnts = require("../build/brushents");

const manifest = require("../../package.json");
const TOOL_NAME = manifest.productName;
const TOOL_URL = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const GAME = Q3.GAME;

const DEFAULTS = {
  // Both engines' own constants bracket this. Floor: a Quake 3 player is 30 x 56 (playerMins
  // {-15,-15,-24}, playerMaxs {15,15,32}), so the tightest passage a mapper may build is 56 tall and
  // KFHumanPawn's 100 has to fit it - 100/56 = 1.7857. Ceiling: MAXSTEPHEIGHT is 35 uu against
  // Quake 3's STEPSIZE of 18, so 35/18 = 1.9444, above which a stock staircase stops being
  // climbable and locks the player out of half of q3dm7. The geometric mean sits at equal relative
  // margin from both: sqrt(100/56 * 35/18) = 1.863390.
  //
  // Two constraints that do not bind, but were checked: a crouched KFHumanPawn (68 uu) through
  // Quake 3's ducked hull (maxs[2] drops to 16, so 40 tall) wants 1.7000, and a 52-uu-wide specimen
  // through a 30-unit passage wants 1.7333. Independent corroboration: Quake 3's eye is 50 uu off
  // the floor (MINS_Z -24 + DEFAULT_VIEWHEIGHT 26) against KFHumanPawn's 94, and 94/50 = 1.88 lands
  // within 1% of the mean. See ../../docs/games/quake3.md Q3.10.
  //
  // What does NOT survive the scale is the jump: 325 JumpZ against KF's gravity clears 55.6 uu,
  // where Quake 3's JUMP_VELOCITY 270 against its own gravity of 800 clears 45.6 map units = 85 uu
  // here. Ledges a Quake player hops onto need a run-up, and the rocket-jump ones are out of reach.
  scale: 1.8634,
  patchLevel: 4,            // bezier tessellation: (L+1)^2 vertices per 3x3 control patch
  // The two together are what lights the world, and the zone's share alone is what lights the
  // player, his hands and the zeds (GOTCHAS 4.11a) - so the split is "what the pawn needs" against
  // "what the walls need minus that". 40 + 96 was judged on q3dm1 against 12+40 (a black corridor),
  // 40+128 (the lit half burning out) and 96+72.
  ambient: 40,
  glow: 96,
  // Quake 3 lightmaps are dark on purpose: measured over both games' stock maps the mean luxel is
  // 20-35 of 255, with a third of them at pure black, because the engine doubles the lightmap on
  // load (r_mapOverBrightBits) and the hardware gamma ramp lifts it again. Nothing here does either,
  // so the atlas is scaled on the way in. 4.0 lands the mean where the GoldSrc route's own atlas
  // sits, which is what the material and the glow above were tuned against.
  lightGain: 4.0,
  // The floor under the atlas. A luxel q3map left at 0 multiplies the wall's texture to black, and
  // no torch and no muzzle flash can reach it - which is a third of every stock map.
  lightFloor: 20,
};

// The engine draws an unlit surface at roughly 2.4x its texture (UE2 overbright plus KF bloom), so
// the sky - which is unlit by definition - is pre-divided or it arrives as white glare.
const SKY_GAIN = 1 / 2.4;
const FLAT_SKY = [120, 148, 188];

// Where a player appears. Quake 3's own two, plus the team spawns Team Arena and CTF use.
const SPAWN_CLASSES = /^(info_player_(start|deathmatch)|team_ctf_(red|blue)(player|spawn))$/i;
// A Quake 3 player's origin sits 24 units above his feet (the bbox is -24..+32).
const Q3_FEET = 24;
// ...and a KFHumanPawn's Location sits 50 above his, plus a little air so a start snapped to the
// floor in Radiant does not arrive inside it.
const KF_HALF_HEIGHT = 50, SPAWN_CLEAR = 6;

// Unreal stores light colour as byte hue/saturation rather than RGB.
function hueOf(rgb, max, min) {
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === rgb[0]) h = ((rgb[1] - rgb[2]) / d) % 6;
  else if (max === rgb[1]) h = (rgb[2] - rgb[0]) / d + 2;
  else h = (rgb[0] - rgb[1]) / d + 4;
  return Math.round(((h + 6) % 6) * 255 / 6);
}

// Which folder of the client a map belongs to. A Team Arena map lives in `missionpack` and reads
// baseq3 underneath it; a stock Quake 3 map is baseq3 alone.
function findMap(clientDir, name, mod, log) {
  const wanted = "maps/" + name.replace(/\.bsp$/i, "").toLowerCase() + ".bsp";
  const tries = mod ? [mod] : ["baseq3", "missionpack"];
  for (const m of tries) {
    const fsys = new GameFs(searchDirs(clientDir, m), log);
    if (fsys.has(wanted)) return { fsys, mod: m, entry: wanted };
    fsys.close();
  }
  throw new Error("no map called " + name + " in " + clientDir + " (looked in " + tries.join(", ") + ")");
}

function convert(opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  for (const k of Object.keys(DEFAULTS)) if (o[k] === undefined) o[k] = DEFAULTS[k];
  const log = o.log || (() => { });
  const t0 = Date.now();
  const scale = o.scale;

  // Either a loose .bsp on disk, or a map name inside a client's archives.
  let fsys, bsp, baseName, mod = o.mod || null;
  const clientDir = o.clientDir || installedQuake3()[0] || null;
  if (o.bspFile) {
    baseName = path.basename(o.bspFile).replace(/\.bsp$/i, "");
    bsp = Q3.load(o.bspFile);
    // A loose .bsp still needs the client for its textures; without one every surface is a
    // placeholder, which is a map you can walk but not look at.
    fsys = new GameFs(clientDir ? searchDirs(clientDir, mod || "baseq3") : [], log);
    if (!clientDir) log("no Quake III client given or found - every surface will be a placeholder (--client <folder>)");
  } else {
    if (!clientDir || !o.map) throw new Error("give either a .bsp file or --client <folder> --map <name>");
    const found = findMap(clientDir, o.map, mod, log);
    fsys = found.fsys; mod = found.mod;
    baseName = o.map.replace(/\.bsp$/i, "");
    bsp = new Q3.Bsp(fsys.read(found.entry), baseName);
  }
  const mapName = o.mapName || ("KF-" + sanitizeName(baseName));
  const s = bsp.stats();
  log("read " + baseName + ".bsp" + (mod ? " (" + mod + ")" : "") + ": " + s.faces + " faces (" +
    s.patches + " patch, " + s.meshes + " mesh), " + s.vertexes + " vertices, " + s.textures +
    " shaders, " + s.lightmaps + " lightmap page(s), " + s.entities + " entities");

  const shaders = new ShaderSet(fsys, log);
  log("shader scripts: " + shaders.files.length + " file(s), " + shaders.shaders.size + " shader(s)");

  const guid = crypto.createHash("md5").update(mapName).digest();
  const pkg = new Package({ guid });
  const refs = {
    Texture: pkg.importClass("Engine", "Texture"),
    Palette: pkg.importClass("Engine", "Palette"),
    Shader: pkg.importClass("Engine", "Shader"),
    ConstantColor: pkg.importClass("Engine", "ConstantColor"),
    Combiner: pkg.importClass("Engine", "Combiner"),
    TexCoordSource: pkg.importClass("Engine", "TexCoordSource"),
    Model: pkg.importClass("Engine", "Model"),
    Polys: pkg.importClass("Engine", "Polys"),
    Brush: pkg.importClass("Engine", "Brush"),
    LevelInfo: pkg.importClass("Engine", "LevelInfo"),
    LevelSummary: pkg.importClass("Engine", "LevelSummary"),
    Level: pkg.importClass("Engine", "Level"),
    DefaultPhysicsVolume: pkg.importClass("Engine", "DefaultPhysicsVolume"),
    PlayerStart: pkg.importClass("Engine", "PlayerStart"),
    StaticMesh: pkg.importClass("Engine", "StaticMesh"),
    StaticMeshActor: pkg.importClass("Engine", "StaticMeshActor"),
    StaticMeshInstance: pkg.importClass("Engine", "StaticMeshInstance"),
    ZoneInfo: pkg.importClass("Engine", "ZoneInfo"),
    DoorMover: pkg.importClass("KFMod", "KFDoorMover"),
    UseTrigger: pkg.importClass("KFMod", "KFUseTrigger"),
    flagsGame: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
  };
  const ACTOR = RF.GAME | RF.HasStack;
  const ACTOR_ED = RF.EDITOR_ONLY | RF.HasStack;
  const holder = {};
  const nameCount = new Map();
  const named = (cls) => { const n = nameCount.get(cls) || 0; nameCount.set(cls, n + 1); return cls + n; };

  // --- textures -----------------------------------------------------------------------------------
  const { textures } = loadTextures(pkg, refs, bsp, {
    gamefs: fsys, shaders, log, maxSize: o.maxTexture || 512, rawTextures: o.textureFormat === "raw",
  });
  // A sky record carries no material and is handed through anyway: the mesh builder has to know a
  // face is sky to cut it out rather than count it as a surface it could not resolve.
  const texOf = (idx) => {
    const t = textures.get(idx);
    return t && (t.ref || t.kind === "sky") ? t : null;
  };

  // --- the sky ------------------------------------------------------------------------------------
  // The first sky surface the map actually uses decides it; a map with two skies is a map with one
  // cube, which is what the engine draws anyway.
  const skySides = {};
  let skyReport = null;
  if (!o.noSky) {
    const usedSky = new Set();
    for (const f of bsp.faces) {
      const t = bsp.textures[f.texture];
      if (t && !t.tool && (t.flags & Q3.SURF.SKY)) usedSky.add(t.name);
    }
    let box = null;
    for (const name of usedSky) {
      box = loadSky(fsys, shaders.resolve(name, fsys));
      if (box) { skyReport = name + " -> " + box.name + " (" + box.kind + ")"; break; }
    }
    if (box) {
      // Which image goes on which face is Quake's layout, and how each is rotated is a convention
      // easy to get wrong from memory - so it is solved from the pictures instead. A single-image
      // cloud sky has nothing to solve and nothing to gain from trying.
      const images = box.kind === "farbox" ? orientSkybox(faceCorners(1), box.sides).images : box.sides;
      for (const side of SIDES) {
        const img = upscale(images[side] || box.sides[side], 2, 512);
        skySides[side] = addRgbTexture(pkg, refs, "sky_" + sanitizeName(baseName) + "_" + side,
          { width: img.width, height: img.height, rgb: img.rgb }, SKY_GAIN);
      }
      log("sky: " + skyReport + ", " + box.sides.up.width + "x" + box.sides.up.height +
        (box.kind === "clouds" ? " - Quake 3's scrolling cloud layers become one still image on all six faces" : " x6"));
    } else if (usedSky.size) {
      const side = 8;
      const rgb = Buffer.alloc(side * side * 3);
      for (let i = 0; i < side * side; i++) rgb.set(FLAT_SKY, i * 3);
      const flat = addRgbTexture(pkg, refs, "sky_flat", { width: side, height: side, rgb }, SKY_GAIN);
      for (const sd of SIDES) skySides[sd] = flat;
      log("sky MISSING: " + [...usedSky].join(" ") + " - no images found, a flat sky stands in");
    }
  }
  const hasSkybox = Object.keys(skySides).length > 0;

  // --- geometry -----------------------------------------------------------------------------------
  // Doors get an actor of their own so a corridor a Quake 3 door closes is not a corridor sealed for
  // good; everything else a brush entity owns is carried as static geometry where it stands.
  const doors = [];
  if (o.doors !== false) {
    bsp.entities.forEach((e) => {
      const mm = /^\*(\d+)$/.exec(e.model || "");
      if (!mm || !/^func_door$/i.test(e.classname || "")) return;
      const model = bsp.models[+mm[1]];
      if (!model || model.nFaces <= 0) return;
      // Quake 3's func_door leaves `lip` at 8 where Half-Life's leaves it at 0, and build/brushents
      // reads the Half-Life default.
      doors.push({ kind: "door", e: Object.assign({ lip: "8" }, e), model, mi: +mm[1] });
    });
  }
  const separate = new Map(doors.map((d, i) => [d.mi, i]));

  const meshBuild = buildMeshes(bsp, { scale, texOf, patchLevel: o.patchLevel, separate });
  const st = meshBuild.stats;
  log("mesh: " + st.faces + " faces -> " + st.triangles + " triangles in " + meshBuild.meshes.length +
    " mesh(es) (" + st.patches + " patch, " + st.skipped + " skipped, " + st.sky + " sky cut out for the cube" +
    (st.billboards ? ", " + st.billboards + " billboard flares dropped" : "") +
    (st.flat3 ? ", " + st.flat3 + " collinear triangles dropped" : "") + ")");

  // --- the world box ------------------------------------------------------------------------------
  const wm = bsp.models[0];
  const extent = [
    [wm.mins[0] * scale, -wm.maxs[1] * scale, wm.mins[2] * scale],
    [wm.maxs[0] * scale, -wm.mins[1] * scale, wm.maxs[2] * scale],
  ];
  const skyCentre = [0, 1, 2].map((a) => (extent[0][a] + extent[1][a]) / 2);
  const half = [0, 1, 2].map((a) => (extent[1][a] - extent[0][a]) / 2);
  // Far enough out that walking the level barely turns the sky: 6x the level radius moves it under
  // ten degrees end to end, and the cap is the renderer's far plane.
  const skyR = +process.env.KF_SKY_R || Math.max(12000, Math.min(30000, Math.hypot(half[0], half[1], half[2]) * 6));
  const MARGIN = 512;
  const box = {
    min: [0, 1, 2].map((a) => Math.min(extent[0][a] - MARGIN, hasSkybox ? skyCentre[a] - skyR - MARGIN : Infinity)),
    max: [0, 1, 2].map((a) => Math.max(extent[1][a] + MARGIN, hasSkybox ? skyCentre[a] + skyR + MARGIN : -Infinity)),
  };

  // --- the level skeleton -------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date(t0);
  const stamp = now.getFullYear() + "." + pad(now.getMonth() + 1) + "." + pad(now.getDate()) +
    " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
  const title = (bsp.worldspawn.message || baseName) + " (" + GAME + (mod === "missionpack" ? " - Team Arena" : "") + ")";
  const writeCredits = (pr) => {
    pr.str("Title", title);
    pr.str("Author", TOOL_NAME);
    pr.str("Description", stamp);
    pr.str("DecoTextName", TOOL_URL);
    pr.int("IdealPlayerCountMin", 1);
    pr.int("IdealPlayerCountMax", 6);
    pr.str("ExtraInfo", TOOL_URL);
  };

  const levelInfoRef = pkg.addExport({
    classRef: refs.LevelInfo, name: "LevelInfo0", flags: ACTOR,
    serialize: (p) => {
      const w = new Writer(256);
      writeStateFrame(w, refs.LevelInfo);
      const pr = p.props(w);
      pr.float("TimeSeconds", 0);
      writeCredits(pr);
      pr.object("Summary", holder.summaryRef);
      pr.str("DefaultGameType", "KFmod.KFGameType");
      // LevelInfo.KillZ defaults to 0, and a Quake 3 map sits below the origin as often as not.
      pr.float("KillZ", holder.killZ === undefined ? box.min[2] - 1000 : holder.killZ);
      if (holder.starts && holder.starts.length) pr.object("NavigationPointList", holder.starts[0]);
      pr.float("BloomRatio", 1);
      pr.float("BloomRatioMinimum", 0.2);
      pr.float("BloomRatioMaximum", 0.5);
      pr.float("BloomContrast", 1);
      pr.float("BloomBlurMult", 1);
      pr.actorCommon(levelInfoRef, holder.physVolRef, "LevelInfo");
      pr.end();
      return w;
    },
  });

  // A fully masked-out 8x8 stand-in. The BSP is the level's skeleton and draws nothing, so every
  // surface of it points here.
  const hideRef = addRgbTexture(pkg, refs, "InvisibleWorld",
    { width: 8, height: 8, rgb: Buffer.alloc(8 * 8 * 3), alpha: Buffer.alloc(8 * 8) }, 1, { dxt3: true }).texRef;

  // The red builder brush the editor validates on load - a plain 256 cube, as every shipped map has.
  const BUILDER = 256;
  const brushPolysRef = pkg.addExport({
    classRef: refs.Polys, name: "BrushPolys", flags: RF.EDITOR_ONLY,
    serialize: (p) => writePolys(p, boxPolys([-BUILDER, -BUILDER, -BUILDER], [BUILDER, BUILDER, BUILDER])
      .map((poly, i) => Object.assign(poly, { texture: hideRef, iLink: i }))),
  });
  const brushModelRef = pkg.addExport({
    classRef: refs.Model, name: "BrushModel", flags: RF.EDITOR_ONLY,
    serialize: (p) => emptyModel(p, brushPolysRef, {
      rootOutside: 1, linked: 1, numSharedSides: 4,
      bbox: { min: [-BUILDER, -BUILDER, -BUILDER], max: [BUILDER, BUILDER, BUILDER], valid: 1 },
    }),
  });
  const brushRef = pkg.addExport({
    classRef: refs.Brush, name: named("Brush"), flags: ACTOR_ED,
    serialize: (p) => {
      const w = new Writer(192);
      writeStateFrame(w, refs.Brush);
      const pr = p.props(w);
      pr.actorCommon(levelInfoRef, holder.physVolRef, "Brush");
      pr.vector("Location", [0, 0, 0]);
      pr.object("Brush", brushModelRef);
      pr.end();
      return w;
    },
  });

  // The subtract that makes the level a place rather than solid rock, and the brush KFEd replays to
  // get it back on a rebuild.
  const csgBrushes = [];
  {
    const h = [0, 1, 2].map((a) => (box.max[a] - box.min[a]) / 2);
    const at = [0, 1, 2].map((a) => (box.max[a] + box.min[a]) / 2);
    const polysRef = pkg.addExport({
      classRef: refs.Polys, name: named("Polys"), flags: RF.EDITOR_ONLY,
      serialize: (p) => writePolys(p, boxPolys(h.map((v) => -v), h)
        .map((poly, i) => Object.assign(poly, { texture: (skySides.up && skySides.up.texRef) || hideRef, polyFlags: 0x80, iLink: i }))),
    });
    const modelRef = pkg.addExport({
      classRef: refs.Model, name: named("Model"), flags: RF.EDITOR_ONLY,
      serialize: (p) => emptyModel(p, polysRef, {
        rootOutside: 1, linked: 1, numSharedSides: 4,
        bbox: { min: h.map((v) => -v), max: h, valid: 1 },
      }),
    });
    csgBrushes.push(pkg.addExport({
      classRef: refs.Brush, name: named("Brush"), flags: ACTOR_ED,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.Brush);
        const pr = p.props(w);
        pr.byte("CsgOper", 2);                        // CSG_Subtract
        pr.bool("bStatic", true);
        const identity = (ip) => { ip.vector("Scale", [1, 1, 1]); ip.float("SheerRate", 0); ip.byte("SheerAxis", 5); ip.end(); };
        pr.structBlock("MainScale", "Scale", identity);
        pr.structBlock("PostScale", "Scale", identity);
        pr.actorCommon(levelInfoRef, holder.physVolRef, "Brush", 1, holder.zoneInfoRef);
        pr.vector("Location", at);
        pr.object("Brush", modelRef);
        pr.end();
        return w;
      },
    }));
  }

  const physVolRef = pkg.addExport({
    classRef: refs.DefaultPhysicsVolume, name: "DefaultPhysicsVolume0", flags: ACTOR,
    serialize: (p) => {
      const w = new Writer(128);
      writeStateFrame(w, refs.DefaultPhysicsVolume);
      const pr = p.props(w);
      pr.int("Priority", -1000000);
      pr.actorCommon(levelInfoRef, physVolRef, "DefaultPhysicsVolume");
      pr.end();
      return w;
    },
  });
  holder.physVolRef = physVolRef;

  // worldspawn's `ambient` is q3map's own fill light, and `_color` its colour - the one number in a
  // Quake 3 map that says how dark the mapper meant the shadows to be.
  const wsAmbient = Math.max(0, Math.min(64, parseFloat(bsp.worldspawn.ambient || "0") || 0));
  const ambient = Math.max(0, Math.min(255, Math.round((o.ambient + wsAmbient * 0.5) * (o.lightScale || 1))));
  const glow = Math.max(0, Math.min(254, Math.round(o.glow * (o.lightScale || 1))));
  const wsColor = (bsp.worldspawn._color || "").trim().split(/\s+/).map(Number);
  const tint = wsColor.length === 3 && wsColor.every((v) => isFinite(v)) ? wsColor.map((v) => v * 255) : null;
  const zoneInfoRef = holder.zoneInfoRef = pkg.addExport({
    classRef: refs.ZoneInfo, name: "ZoneInfo0", flags: ACTOR,
    serialize: (p) => {
      const w = new Writer(192);
      writeStateFrame(w, refs.ZoneInfo);
      const pr = p.props(w);
      pr.byte("AmbientBrightness", ambient);
      if (tint) {
        const mx = Math.max(...tint), mn = Math.min(...tint);
        pr.byte("AmbientHue", hueOf(tint, mx, mn));
        // UE2's AmbientSaturation is inverted: 255 is grey, 0 is fully saturated.
        pr.byte("AmbientSaturation", mx > 0 ? Math.max(0, Math.min(255, Math.round(255 - 255 * (mx - mn) / mx))) : 255);
      }
      pr.actorCommon(levelInfoRef, physVolRef, "ZoneInfo", 1, zoneInfoRef);
      pr.vector("Location", [0, 0, 0]);
      pr.end();
      return w;
    },
  });

  // --- the world model ----------------------------------------------------------------------------
  // Six inward-facing quads around the level and nothing else: the meshes are the world, and the BSP
  // exists so the renderer has a tree to walk and PointRegion has an answer (GOTCHAS 2.12).
  const worldPolysRef = pkg.addExport({
    classRef: refs.Polys, name: "WorldPolys", flags: RF.GAME, serialize: (p) => emptyPolys(p),
  });
  const built = {};
  const worldModelRef = pkg.addExport({
    classRef: refs.Model, name: "WorldModel", flags: RF.GAME,
    serialize: (p) => {
      // buildModel reads a GoldSrc map to insert its faces; on the minimal route it inserts none, so
      // an empty one of everything it indexes is enough to get the box tree out of it.
      const stub = {
        faces: [], texinfo: [], entities: [], leafs: [], nodes: [], planes: [], clipnodes: [],
        markSurfaces: [], surfedges: [], edges: [], vertexes: [],
        models: [{ mins: [0, 0, 0], maxs: [0, 0, 0], firstface: 0, numfaces: 0 }],
      };
      const r = buildModel(stub, {
        scale, lightMapScale: 32, texByMiptex: new Map(), texByRef: new Map(), levelRef: p.names.none,
        minimalWorld: true, worldBox: box, hideMaterialRef: hideRef,
        // Zone 1's ZoneActor. Without it the model's zone table points at nothing, the renderer has
        // no ZoneInfo for the level, and AmbientBrightness reaches neither the world nor the player:
        // measured at ambient 254 with glow 0, which drew a completely black frame.
        brushEntities: false, polysRef: worldPolysRef, zoneInfoRef,
      });
      built.model = r.model;
      return writeModel(p, r.model);
    },
  });

  // --- the map's own light, as a texture -----------------------------------------------------------
  // One UTexture per Quake 3 lightmap page, one TexCoordSource that reads it through UV channel 1,
  // and one Combiner per (texture, page) pair that multiplies the two.
  const gain = o.lightGain * (o.lightScale || 1);
  const floor = Math.max(0, Math.min(255, Math.round(o.lightFloor * (o.lightScale || 1))));
  const pagesUsed = new Set();
  for (const m of meshBuild.meshes) if (m.lightPage !== undefined) pagesUsed.add(m.lightPage);
  const lmCoord = new Map();
  let lmMean = 0, lmSamples = 0;
  for (const page of pagesUsed) {
    const src = bsp.lightmap(page);
    if (!src) continue;
    const size = Q3.LIGHTMAP_SIZE;
    const rgb = Buffer.alloc(size * size * 3);
    for (let i = 0; i < size * size * 3; i++) {
      const v = Math.round(src[i] * gain) + floor;
      rgb[i] = v > 255 ? 255 : v;
      lmMean += src[i];
    }
    lmSamples += size * size * 3;
    // UNCOMPRESSED, unlike every other texture here. A lightmap page is 128x128 stretched over a
    // whole room, so a DXT1 block covers several feet of wall and its two endpoint colours show as
    // coloured speckle across every surface - measured on q3dm1, where it read as film grain on the
    // stonework. At 128x128 the raw page is 87 KB with its mips, which is the cheapest place in the
    // map to spend them.
    const tex = addRgbTexture(pkg, refs, mapName.replace(/[^A-Za-z0-9_]/g, "") + "_lm" + page,
      { width: size, height: size, rgb }, 1, { raw: true });
    lmCoord.set(page, pkg.addExport({
      classRef: refs.TexCoordSource, name: "LightCoords" + page, flags: refs.flagsGame,
      serialize: (p) => {
        const w = new Writer(96);
        const pr = p.props(w);
        pr.object("Material", tex.texRef);
        pr.byte("TexCoordSource", 1);                 // TCS_Stream1
        pr.end();
        return w;
      },
    }));
  }
  if (pagesUsed.size) {
    log("lightmap: " + pagesUsed.size + " page(s) of " + Q3.LIGHTMAP_SIZE + "x" + Q3.LIGHTMAP_SIZE +
      ", raw mean luxel " + (lmSamples ? (lmMean / lmSamples).toFixed(1) : "0") +
      " x" + gain.toFixed(2) + " + " + floor);
  }

  const combiners = new Map();
  const litMaterial = (texRef, page) => {
    const key = texRef + "@" + page;
    if (combiners.has(key)) return combiners.get(key);
    const coord = lmCoord.get(page);
    if (!coord) return texRef;
    const ref = pkg.addExport({
      classRef: refs.Combiner, name: "Lit" + combiners.size, flags: refs.flagsGame,
      serialize: (p) => {
        const w = new Writer(128);
        const pr = p.props(w);
        pr.object("Material1", texRef);
        pr.object("Material2", coord);
        pr.byte("CombineOperation", 2);               // CO_Multiply
        pr.byte("AlphaOperation", 3);                 // AO_Use_Alpha_From_Material1
        pr.end();
        return w;
      },
    });
    combiners.set(key, ref);
    return ref;
  };

  // Anything that draws with its own blending cannot just be multiplied: how a material blends is a
  // property of its OUTPUT and a Combiner has none, so a masked grate wrapped in one comes back as a
  // solid slab. Hang the combiner off a Shader instead, with the blending the surface had.
  const seeThrough = new Set();
  const blends = new Map();
  let flatOpacity = 0;
  const blendedMaterial = (rec, diffuse) => {
    const key = diffuse + "|" + rec.kind + "|" + (rec.liquid ? "l" : "");
    if (blends.has(key)) return blends.get(key);
    // A jpg has no alpha channel, so a shader that asked to blend one needs a constant instead.
    const graded = rec.liquid || rec.kind === "translucent";
    if (graded && !flatOpacity) {
      flatOpacity = pkg.addExport({
        classRef: refs.ConstantColor, name: "Opacity0", flags: refs.flagsGame,
        serialize: (p) => {
          const w = new Writer(64);
          const pr = p.props(w);
          pr.color("Color", [255, 255, 255, 150]);
          pr.end();
          return w;
        },
      });
    }
    const ref = pkg.addExport({
      classRef: refs.Shader, name: (rec.kind === "masked" ? "Masked" : "Blend") + blends.size, flags: refs.flagsGame,
      serialize: (p) => {
        const w = new Writer(128);
        const pr = p.props(w);
        pr.object("Diffuse", diffuse);
        pr.object("Opacity", rec.kind === "masked" ? rec.texRef : flatOpacity);
        // OB_Masked / OB_Translucent / OB_Brighten
        pr.byte("OutputBlending", rec.kind === "masked" ? 1 : rec.kind === "additive" ? 5 : 3);
        // A cut-out is drawn one-sided in Quake 3 too; a pane and a water surface are not.
        if (rec.kind !== "masked" || rec.twoSided) pr.bool("TwoSided", true);
        pr.end();
        return w;
      },
    });
    blends.set(key, ref);
    if (rec.kind !== "masked") seeThrough.add(ref);
    return ref;
  };

  // --- mesh actors --------------------------------------------------------------------------------
  const meshActors = [];
  let lowest = Infinity;
  const byRef = new Map();
  for (const [, rec] of textures) if (rec && rec.ref) byRef.set(rec.ref, rec);

  meshBuild.meshes.forEach((mesh, i) => {
    const rec = byRef.get(mesh.materials[0]);
    const lit = mesh.lightPage !== undefined && lmCoord.has(mesh.lightPage);
    let mat = mesh.materials[0];
    if (lit) mat = litMaterial(mat, mesh.lightPage);
    if (rec && (rec.kind === "masked" || rec.kind === "translucent" || rec.kind === "additive" || rec.liquid)) {
      mat = blendedMaterial(rec, mat);
    }
    mesh.materials = mesh.materials.map(() => mat);
    if (!lit) mesh.lightPage = undefined;              // no second UV stream without an atlas
    lowest = Math.min(lowest, mesh.origin[2] + mesh.bbox.min[2]);

    const meshRef = pkg.addExport({
      classRef: refs.StaticMesh, name: mapName.replace(/[^A-Za-z0-9_]/g, "") + "_geo" + i,
      flags: refs.flagsGame,
      serialize: (p) => buildMeshExport(p, mesh),
    });
    const instRef = pkg.addExport({
      classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame,
      serialize: (p) => buildMeshInstance(p, mesh),
    });

    if (mesh.ent !== undefined && doors[mesh.ent]) {
      const item = doors[mesh.ent];
      const motion = brushEnts.doorMotion(item, scale);
      const doorTag = "Q3Door" + mesh.ent;
      const hb = [0, 1, 2].map((k) => (mesh.bbox.max[k] - mesh.bbox.min[k]) / 2);
      // A KFDoorMover only wakes up when a KFUseTrigger whose Event matches its Tag stands next to
      // it (KFDoorMover.PostBeginPlay looks for exactly that).
      meshActors.push(pkg.addExport({
        classRef: refs.UseTrigger, name: named("KFUseTrigger"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(256);
          writeStateFrame(w, refs.UseTrigger);
          const pr = p.props(w);
          pr.nameProp("Event", doorTag);
          pr.float("CollisionRadius", Math.max(96, Math.hypot(hb[0], hb[1]) + 48));
          pr.float("CollisionHeight", Math.max(64, hb[2] + 24));
          pr.float("MaxWeldStrength", 400);
          pr.bool("bCollideActors", true);
          pr.actorCommon(levelInfoRef, physVolRef, "DoorTrigger" + mesh.ent, 1, zoneInfoRef);
          pr.vector("ColLocation", mesh.origin);
          pr.vector("Location", mesh.origin);
          pr.end();
          return w;
        },
      }));
      meshActors.push(pkg.addExport({
        classRef: refs.DoorMover, name: named("KFDoorMover"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(384);
          writeStateFrame(w, refs.DoorMover);
          const pr = p.props(w);
          pr.object("StaticMesh", meshRef);
          pr.object("StaticMeshInstance", instRef);
          pr.byte("DrawType", 8);                     // DT_StaticMesh
          pr.vectorAt("KeyPos", 1, motion.pos);
          pr.rotatorAt("KeyRot", 1, motion.rot);
          pr.float("MoveTime", motion.moveTime);
          pr.float("StayOpenTime", motion.stayOpen);
          pr.bool("bDynamicLightMover", false);
          pr.bool("bShadowCast", false);
          pr.bool("bBlockKarma", false);
          if (glow) pr.byte("AmbientGlow", glow);
          pr.actorCommon(levelInfoRef, physVolRef, doorTag, 1, zoneInfoRef);
          pr.vector("BasePos", mesh.origin);
          pr.rotator("BaseRot", [0, 0, 0]);
          pr.vector("ColLocation", mesh.origin);
          pr.vector("Location", mesh.origin);
          pr.end();
          return w;
        },
      }));
      return;
    }

    meshActors.push(pkg.addExport({
      classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.StaticMeshActor);
        const pr = p.props(w);
        pr.object("StaticMesh", meshRef);
        pr.object("StaticMeshInstance", instRef);
        pr.bool("bStatic", true);
        // A statically lit actor only ever shows light baked into its StaticMeshInstance, which
        // nothing writes until KFEd builds lighting - and the map's own light is in the material
        // here, so the actor has to be lit the ordinary way for the torch to reach it too.
        pr.bool("bStaticLighting", true);
        // The world's share of the level's light, per ACTOR so it reaches the walls and nobody
        // standing between them. A mesh with no atlas carries Quake 3's own per-vertex light in its
        // colour stream instead (mesh.js), and that stream ADDS - so it takes no glow on top.
        if (lit) pr.byte("AmbientGlow", glow);
        // A projector - KF's bullet decal, the torch's own spot - drawn onto a see-through surface
        // repaints the whole surface instead of marking it.
        if (seeThrough.has(mat)) pr.bool("bAcceptsProjectors", false);
        pr.bool("bWorldGeometry", true);
        // Water is drawn but never blocks: in Quake 3 you swim through it, and a water mesh with
        // collision would be an invisible wall across the pool.
        pr.bool("bCollideActors", !mesh.liquid);
        pr.bool("bBlockActors", !mesh.liquid);
        pr.bool("bBlockPlayers", !mesh.liquid);
        pr.bool("bBlockZeroExtentTraces", !mesh.liquid);
        pr.bool("bBlockNonZeroExtentTraces", !mesh.liquid);
        // This is the floor corpses rest on, so it is the one that has to block Karma.
        pr.bool("bBlockKarma", !mesh.liquid && !process.env.KF_NO_KARMA);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", mesh.origin);
        pr.vector("Location", mesh.origin);
        pr.end();
        return w;
      },
    }));
  });
  if (Number.isFinite(lowest)) holder.killZ = lowest - 2000;
  if (doors.length) log("doors: " + doors.length + " func_door as KFDoorMover + KFUseTrigger (use key, weldable)");

  // --- the skybox cube ----------------------------------------------------------------------------
  if (hasSkybox) {
    const sky = buildSkyboxMesh(skyCentre, skyR, skySides, { grid: 4 });
    const skyMeshRef = pkg.addExport({
      classRef: refs.StaticMesh, name: "SkyBox", flags: refs.flagsGame,
      serialize: (p) => buildMeshExport(p, sky),
    });
    const skyInstRef = pkg.addExport({
      classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame,
      serialize: (p) => buildMeshInstance(p, sky),
    });
    meshActors.push(pkg.addExport({
      classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.StaticMeshActor);
        const pr = p.props(w);
        pr.object("StaticMesh", skyMeshRef);
        pr.object("StaticMeshInstance", skyInstRef);
        pr.bool("bUnlit", true);
        // The cube encloses the level, so in KFEd every viewport ends up inside it and shows nothing
        // but sky. bHiddenEd does not affect the game.
        pr.bool("bHiddenEd", true);
        pr.bool("bStatic", true);
        pr.bool("bWorldGeometry", true);
        pr.bool("bCollideActors", false);
        pr.bool("bBlockActors", false);
        pr.bool("bBlockKarma", false);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", skyCentre);
        pr.vector("Location", [0, 0, 0]);
        pr.end();
        return w;
      },
    }));
    log("skybox mesh: cube half-size " + Math.round(skyR) + " (level radius " + Math.round(Math.hypot(half[0], half[1], half[2])) + ")");
  }

  // --- player starts ------------------------------------------------------------------------------
  const starts = [];
  if (o.emitPlayerStarts !== false) {
    const at = process.env.KF_SPAWN_AT && process.env.KF_SPAWN_AT.split(",").map(Number);
    const spawns = at ? [{ _at: at.slice(0, 3), _yaw: at[3] }]
      : bsp.entities.filter((e) => SPAWN_CLASSES.test(e.classname || ""));
    const wanted = spawns.slice(0, o.spawnLimit || 32);
    for (const e of wanted) {
      const org = Q3.num3(e.origin, [0, 0, 0]);
      const loc = e._at || [org[0] * scale, -org[1] * scale, (org[2] - Q3_FEET) * scale + KF_HALF_HEIGHT + SPAWN_CLEAR];
      const yawDeg = e._at ? (e._yaw || 0) : (parseFloat(e.angle !== undefined ? e.angle : (e.angles || "0 0 0").split(/\s+/)[1]) || 0);
      // The Y mirror reverses the sense of a yaw.
      const yaw = Math.round((-yawDeg / 360) * 65536) & 0xffff;
      starts.push(pkg.addExport({
        classRef: refs.PlayerStart, name: named("PlayerStart"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(160);
          writeStateFrame(w, refs.PlayerStart);
          const pr = p.props(w);
          pr.actorCommon(levelInfoRef, physVolRef, "PlayerStart", 1, zoneInfoRef);
          pr.vector("Location", loc);
          pr.rotator("Rotation", [0, yaw, 0]);
          pr.end();
          return w;
        },
      }));
    }
    holder.starts = starts;
    log("player starts: " + starts.length + (spawns.length > wanted.length ? " of " + spawns.length : ""));
  }

  holder.summaryRef = pkg.addExport({
    classRef: refs.LevelSummary, name: "LevelSummary", flags: refs.flagsGame,
    serialize: (p) => {
      const w = new Writer(256);
      const pr = p.props(w);
      writeCredits(pr);
      pr.end();
      return w;
    },
  });

  // Actor order is the CSG order: UnrealEd rebuilds the world by replaying the level's brushes from
  // the top, skipping the builder brush at index 1.
  const actors = [levelInfoRef, brushRef, physVolRef, zoneInfoRef, ...csgBrushes, ...starts, ...meshActors];
  pkg.addExport({
    classRef: refs.Level, name: "myLevel", flags: RF.GAME,
    serialize: (p) => {
      const w = new Writer(512);
      w.cidx(p.names.none);
      w.i32(actors.length).i32(actors.length);
      for (const a of actors) w.cidx(a);
      w.fstring("unreal").fstring("").fstring(mapName + ".rom");
      w.cidx(0);
      w.fstring("");
      w.i32(7777).i32(1);
      w.cidx(worldModelRef);
      w.f32(0).i32(0);
      for (let i = 0; i < 14; i++) w.u8(0);
      return w;
    },
  });

  const buf = pkg.build();
  const out = o.outFile || path.join(o.outDir || (o.bspFile ? path.dirname(o.bspFile) : process.cwd()), mapName + ".rom");
  fs.writeFileSync(out, buf);
  fsys.close();
  log("wrote " + out + "  " + (buf.length / 1048576).toFixed(2) + " MB in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

  return {
    out, size: buf.length, mapName, map: baseName, mod,
    stats: meshBuild.stats, meshes: meshBuild.meshes.length, lightmapPages: pagesUsed.size,
    model: built.model,
  };
}

module.exports = { convert, DEFAULTS, GAME };
