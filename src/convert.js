// End-to-end conversion: Counter-Strike 1.6 .bsp -> Killing Floor .rom.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const bspReader = require("./goldsrc/bsp");
const resources = require("./resources");
const { WadSet, readMiptex } = require("./goldsrc/wad");
const { Package, RF } = require("./unreal/package");
const { Writer, writeStateFrame } = require("./unreal/writer");
const { writeModel, emptyModel, emptyPolys } = require("./unreal/model");
const { writePolys, boxPolys, boxBrushModel } = require("./unreal/polys");
const { addTexture, addRgbTexture, sanitizeName } = require("./unreal/texture");
const { loadSkybox, SIDES } = require("./goldsrc/skybox");
const { buildModel } = require("./build/model");
const { buildMeshes } = require("./build/mesh");
const { buildSkyboxMesh, faceCorners } = require("./build/skyboxmesh");
const { orientSkybox } = require("./build/skyboxorient");
const { upscale, resample } = require("./build/upscale");
const sprReader = require("./goldsrc/spr");
const brushEnts = require("./build/brushents");
const mdlReader = require("./goldsrc/mdl");
const { buildPropMesh } = require("./build/propmesh");
const { buildMeshExport, buildMeshInstance } = require("./unreal/staticmesh");
const dxt = require("./unreal/dxt");

// Measured overbright of an unlit surface in KF: 2.5x (see unreal/texture.js). Pre-divide the sky
// so it reads at the brightness Counter-Strike shows.
const SKY_GAIN = 1 / 2.4;

// Signed into every map's LevelSummary. Read from the manifest so a rename or a move of the
// repository cannot leave a stale URL baked into finished .rom files.
const manifest = require("../package.json");
const TOOL_NAME = manifest.productName;
const TOOL_URL = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

const DEFAULTS = {
  // 2.0 is what the shipped KF-CS-* ports measured at (cs_estate); 1.9 reads slightly closer to
  // the original in play, so that is the default. --scale overrides.
  scale: 1.9,
  lightMapScale: 32,      // UE2.5 default luxel size; at scale 2 it lands on GoldSrc's 16-unit grid
  mapName: null,
  wadDirs: [],
  emitPlayerStarts: true,
  // "mesh" (default): the static meshes draw the world and carry collision; the BSP is masked out
  // and survives as the level skeleton plus the sky. "both": BSP draws, meshes hidden and
  // collision-only. "bsp": BSP alone - nothing to stand on. See ../docs/GOTCHAS.md.
  geometry: "mesh",
};

// A visible stand-in so geometry still shows up when a WAD is missing.
function placeholderMiptex(name) {
  const w = 64, h = 64;
  const data = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = ((x >> 3) + (y >> 3)) & 1 ? 1 : 2;
  const palette = Buffer.alloc(768);
  palette[3] = 255; palette[4] = 0; palette[5] = 255;      // index 1: magenta
  palette[6] = 40; palette[7] = 40; palette[8] = 40;       // index 2: dark grey
  const mips = [{ width: w, height: h, data }];
  let cur = mips[0];
  for (let i = 1; i < 4; i++) {
    const nw = cur.width >> 1, nh = cur.height >> 1;
    const d = Buffer.alloc(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) d[y * nw + x] = cur.data[y * 2 * cur.width + x * 2];
    mips.push({ width: nw, height: nh, data: d });
    cur = mips[i];
  }
  return { name, width: w, height: h, mips, palette };
}

// Height of the first GoldSrc face directly below a point, or null over the void. Spawns come from
// CS at the player's centre; dropping a KF pawn from there is a 90-unit fall it does not always
// survive, so the converter puts the PlayerStart on the floor instead.
function floorUnder(map, pos) {
  let best = null;
  for (const face of map.faces) {
    const ring = map.faceVertices(face);
    if (ring.length < 3) continue;
    for (let i = 2; i < ring.length; i++) {
      const a = ring[0], b = ring[i - 1], c = ring[i];
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-6) continue;
      const l1 = ((b[1] - c[1]) * (pos[0] - c[0]) + (c[0] - b[0]) * (pos[1] - c[1])) / d;
      const l2 = ((c[1] - a[1]) * (pos[0] - c[0]) + (a[0] - c[0]) * (pos[1] - c[1])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -0.001 || l2 < -0.001 || l3 < -0.001) continue;
      const z = l1 * a[2] + l2 * b[2] + l3 * c[2];
      if (z <= pos[2] + 1 && (best === null || z > best)) best = z;
    }
  }
  return best;
}

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

function angleToYaw(ent) {
  const a = parseFloat(ent.angle || (ent.angles || "0 0 0").split(/\s+/)[1] || 0) || 0;
  return Math.round((a / 360) * 65536) & 0xffff;
}

function convert(opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!o.geometry) o.geometry = DEFAULTS.geometry;      // Object.assign copies an explicit undefined
  const log = o.log || (() => { });
  const t0 = Date.now();

  const map = bspReader.load(o.bspFile);
  const baseName = path.basename(o.bspFile).replace(/\.bsp$/i, "");
  const mapName = o.mapName || ("KF-" + sanitizeName(baseName));
  log("read " + path.basename(o.bspFile) + ": " + map.faces.length + " faces, " + map.miptex.length +
    " textures, " + map.entities.length + " entities, wads: " + (map.wads.join(" ") || "none"));

  // --- textures ---------------------------------------------------------------------------------
  const wads = new WadSet();
  // Search order: folders the caller named, then the map's own neighbourhood, then any installed
  // Counter-Strike. See resources.js.
  const searchDirs = resources.wadDirs(o.bspFile, o.wadDirs);
  if (map.wads.length) wads.addFromWorldspawn(map.wads, searchDirs);
  if (wads.files.length) log("wads: " + wads.files.map((f) => f.file + "(" + f.lumps + ")").join(" "));
  if (wads.missing.length) log("wads MISSING: " + wads.missing.join(" "));

  const usedMiptex = new Set();
  for (const f of map.faces) {
    const ti = map.texinfo[f.texinfo];
    if (ti) usedMiptex.add(ti.miptex);
  }

  const guid = crypto.createHash("md5").update(mapName).digest();
  const pkg = new Package({ guid });
  const refs = {
    Texture: pkg.importClass("Engine", "Texture"),
    Palette: pkg.importClass("Engine", "Palette"),
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
    SkyZoneInfo: pkg.importClass("Engine", "SkyZoneInfo"),
    SPLevelInfo: pkg.importClass("KFMod", "KFSPLevelInfo"),
    Light: pkg.importClass("Engine", "Light"),
    PhysicsVolume: pkg.importClass("Engine", "PhysicsVolume"),
    // Engine.Effects is the plain sprite billboard: DT_Sprite, unlit, no collision, no physics and
    // no script of its own - exactly what env_sprite/env_glow/cycler_sprite are.
    Effects: pkg.importClass("Engine", "Effects"),
    // func_door / func_door_rotating -> KFDoorMover plus its KFUseTrigger, so a door opens with the
    // use key and can be welded. func_breakable made of glass -> KFGlassMover, which breaks on shots.
    DoorMover: pkg.importClass("KFMod", "KFDoorMover"),
    UseTrigger: pkg.importClass("KFMod", "KFUseTrigger"),
    GlassMover: pkg.importClass("KFMod", "KFGlassMover"),
    // Stock embedded textures and meshes carry exactly these: without RF_Public a mesh material
    // does not resolve and the mesh draws as bare wireframe.
    flagsGame: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
  };

  // Diagnostic: point every surface at a texture that ships with the engine, to tell a problem in
  // the generated textures apart from a problem in the generated geometry.
  const stockTexRef = o.stockTexture
    ? pkg.importObject("Engine", "Texture", pkg.importPackage("Engine"), "DefaultTexture")
    : 0;

  const texByMiptex = new Map();
  const texByRef = new Map();
  let missingTex = 0, embeddedTex = 0, wadTex = 0, potResized = 0;
  for (const idx of usedMiptex) {
    const mt = map.miptex[idx];
    if (!mt) continue;
    let src = null;
    if (mt.embedded) { src = readMiptex(map.buf, mt.base); embeddedTex++; }
    else { src = wads.get(mt.name); if (src && src.mips) wadTex++; else src = null; }
    if (!src || !src.mips) { src = placeholderMiptex(mt.name); missingTex++; }
    const kind = mt.kind;
    if (kind === "tool") { texByMiptex.set(idx, { ref: 0, kind, name: mt.name, width: mt.width, height: mt.height }); continue; }
    if (o.stockTexture) {
      texByMiptex.set(idx, { ref: stockTexRef, kind, name: mt.name, width: 256, height: 256, uScale: 256 / mt.width, vScale: 256 / mt.height });
      texByRef.set(stockTexRef, { width: 256, height: 256 });
      continue;
    }
    const t = addTexture(pkg, refs, src, { masked: kind === "masked", liquid: kind === "liquid", dxt: o.textureFormat !== "p8" });
    if (t.width !== t.origWidth || t.height !== t.origHeight) potResized++;
    const rec = {
      ref: t.texRef, kind, name: t.name, width: t.width, height: t.height,
      origWidth: t.origWidth, origHeight: t.origHeight,
      uScale: t.width / t.origWidth, vScale: t.height / t.origHeight,
    };
    texByMiptex.set(idx, rec);
    texByRef.set(t.texRef, rec);
  }
  log("textures: " + texByMiptex.size + " used (" + embeddedTex + " embedded, " + wadTex + " from wad, " +
    missingTex + " missing -> placeholder, " + potResized + " resampled to power-of-two)");

  // The real skybox, from the six gfx/env images worldspawn names. Without it the sky brushes wear
  // the 16x16 `sky` placeholder from halflife.wad and read as a blown-out white wall.
  const skySides = {};
  const wm = map.models[0];
  // Level extent in Unreal units; the Y mirror swaps that axis' min and max.
  const skyExtent = [
    [wm.mins[0] * o.scale, -wm.maxs[1] * o.scale, wm.mins[2] * o.scale],
    [wm.maxs[0] * o.scale, -wm.mins[1] * o.scale, wm.maxs[2] * o.scale],
  ];
  {
    const world = map.entities[0] || {};
    const bspDir = path.dirname(o.bspFile);
    const roots = resources.skyRoots(o.bspFile, o.wadDirs);
    // A map that leaves skyname unset is not a map without a sky: the engine falls back to whatever
    // sv_skyname holds, which ships as "desert". a2k_aimskillz is one of these.
    const skyName = o.sky || world.skyname || "desert";
    const box = o.stockSky ? null : loadSkybox(skyName, roots);
    // Control experiment: --stock-sky "Package.Group.Name" puts a texture that ships with Killing
    // Floor on all six faces of the sky room instead of the converted ones. If an artefact survives
    // that, nothing about the converted sky images can be causing it.
    if (o.stockSky) {
      const parts = o.stockSky.split(".");
      let outer = pkg.importPackage(parts[0]);
      for (let i = 1; i < parts.length - 1; i++) outer = pkg.importObject("Core", "Package", outer, parts[i]);
      const texRef = pkg.importObject("Engine", "Texture", outer, parts[parts.length - 1]);
      for (const side of SIDES) skySides[side] = { texRef, name: o.stockSky, width: 512, height: 512 };
      log("skybox: STOCK " + o.stockSky + " on all six faces (control build)");
    } else if (box) {
      // How each sky image has to be rotated is a convention that is easy to get wrong from memory
      // - and getting it wrong shows up only as clouds breaking across a cube edge. Solve it from
      // the pictures instead: see build/skyboxorient.js.
      const oriented = orientSkybox(faceCorners(1), box);
      for (const side of SIDES) {
        // A 256px face spread over 90 degrees is about 3 pixels per degree - visibly blurry. Lanczos-3
        // to 1024 does not invent detail, but it stops the GPU's bilinear stretch from being the
        // only thing between the source and the screen. ~85 ms per face, once, at convert time.
        const img = upscale(oriented.images[side] || box[side], o.skyUpscale || 2, 512);
        const t = addRgbTexture(pkg, refs, "sky_" + skyName + "_" + side, img, SKY_GAIN);
        skySides[side] = t;
      }
      log("skybox: " + skyName + " (" + box.up.width + "x" + box.up.height + " x6) " + oriented.report.join(" "));
    } else {
      log("skybox MISSING: " + skyName + " - no gfx/env images found, sky faces keep the flat placeholder");
    }
  }

  // Fully masked-out 8x8 stand-in. Every world surface points at it on the static-mesh route, so
  // the BSP stays as the level's skeleton without drawing anything.
  let hideTexRef = 0;
  if (o.geometry === "mesh") {
    const side = 8;
    const invisible = {
      name: "InvisibleWorld", width: side, height: side, palette: Buffer.alloc(768),
      mips: [{ width: side, height: side, data: Buffer.alloc(side * side, 255) }],
    };
    hideTexRef = addTexture(pkg, refs, invisible, { masked: true }).texRef;   // stays P8: nothing draws it
    texByRef.set(hideTexRef, { width: side, height: side });
  }

  // --- exports ------------------------------------------------------------------------------------
  const ACTOR = RF.GAME | RF.HasStack;
  const ACTOR_ED = RF.EDITOR_ONLY | RF.HasStack;
  const holder = {};

  // Where the map came from and when. These fields live on BOTH objects in every shipped map, and
  // the two are read by different things: KFEd's Level Properties shows the copy on LevelInfo,
  // while the menus read the standalone LevelSummary without loading the level. Writing only one
  // leaves the other at "Untitled / Anonymous". Description carries the conversion time - a map
  // rebuilt after a converter fix is otherwise indistinguishable from the old one.
  const pad = (n) => String(n).padStart(2, "0");
  const t = new Date(t0);
  const stamp = t.getFullYear() + "." + pad(t.getMonth() + 1) + "." + pad(t.getDate()) +
    " " + pad(t.getHours()) + ":" + pad(t.getMinutes());
  const writeCredits = (pr) => {
    pr.str("Title", baseName + " (" + bspReader.GAME + ")");
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
      // Engine.LevelInfo.KillZ defaults to 0: anything below the origin dies the instant it spawns,
      // and GoldSrc maps sit below it as often as not. Put the floor under the geometry.
      if (holder.killZ !== undefined) pr.float("KillZ", holder.killZ);
      if (holder.starts && holder.starts.length) pr.object("NavigationPointList", holder.starts[0]);
      // Same three as ZoneInfo0, for when the HUD reads the LevelInfo instead - see there for why.
      {
        const fog = holder.fogColor || [76, 76, 76];
        pr.bool("bDistanceFog", true);
        pr.bool("bClearToFogColor", true);
        pr.bool("bNewKFColorCorrection", true);
        pr.color("KFOverlayColor", [fog[0], fog[1], fog[2], 0]);
        pr.color("DistanceFogColor", [fog[0], fog[1], fog[2], 0]);
        pr.float("DistanceFogStart", -2000);
        pr.float("DistanceFogEnd", 250000);   // past the skybox cube: the fog must not tint anything
      }
      // Bloom, with the numbers the shipped maps use. KF switches the effect on from the HUD
      // (HUDKillingFloor.DrawHud) between the world render and the first-person weapon, so bloom
      // lands on the world alone - which is the shape of the white flash. The engine defaults are
      // BloomRatio 0.5 / min 0 / max 0.5 and every shipped level overrides them; ours set none.
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

  const brushPolysRef = pkg.addExport({ classRef: refs.Polys, name: "BrushPolys", flags: RF.EDITOR_ONLY, serialize: (p) => emptyPolys(p) });
  const brushModelRef = pkg.addExport({ classRef: refs.Model, name: "BrushModel", flags: RF.EDITOR_ONLY, serialize: (p) => emptyModel(p, brushPolysRef) });
  const brushRef = pkg.addExport({
    classRef: refs.Brush, name: "Brush", flags: ACTOR_ED,
    serialize: (p) => {
      const w = new Writer(192);
      writeStateFrame(w, refs.Brush);
      const pr = p.props(w);
      pr.byte("CsgOper", 2);                      // CSG_Subtract, as the red builder brush ships
      pr.actorCommon(levelInfoRef, holder.physVolRef, "Brush");
      pr.vector("Location", [0, 0, 0]);
      pr.object("Brush", brushModelRef);
      pr.end();
      return w;
    },
  });

  const worldPolysRef = pkg.addExport({ classRef: refs.Polys, name: "WorldPolys", flags: RF.GAME, serialize: (p) => emptyPolys(p) });
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

  // Zone 1 needs a real ZoneInfo actor. Every shipped map has one, and without it the renderer
  // draws the BSP but skips every actor in the zone - including all of the level's static meshes.
  const zoneInfoRef = pkg.addExport({
    classRef: refs.ZoneInfo, name: "ZoneInfo0", flags: ACTOR,
    serialize: (p) => {
      const w = new Writer(192);
      writeStateFrame(w, refs.ZoneInfo);
      const pr = p.props(w);
      // Ambient taken from the average GoldSrc luxel of this very map, so the level lands at the
      // brightness it had in CS instead of at a guessed constant. Lighting the meshes through the
      // zone rather than marking them bUnlit also keeps dynamic light working (torch, muzzle flash).
      if (holder.ambient !== undefined) pr.byte("AmbientBrightness", holder.ambient);
      // ...and its colour. GoldSrc lightmaps are RGB, so taking only the brightness throws away the
      // map's whole cast - the warm afternoon of cs_italy against the cold overcast of cs_assault.
      if (holder.ambientHue !== undefined) {
        pr.byte("AmbientHue", holder.ambientHue);
        pr.byte("AmbientSaturation", holder.ambientSaturation);
      }
      // The zone's fog colour, because KF's HUD tints the screen with it - and that tint is what
      // the white flashes are.
      //
      // HUDKillingFloor.DrawModOverlay draws a full-screen tile in STY_Modulated before it draws
      // the first-person weapon, in the colour
      //     LastR + Round(LastR * (1 - LastR/255) - 2)
      // where LastR is this fog colour, or 0 when the zone declares no fog. At 0 the expression is
      // -2, which as a byte argument to SetDrawColor wraps to 254 - a modulate of x1.98. Draw that
      // tile more than once against the same frame and the scene doubles each time: x4, x8, x16.
      // Every channel above zero saturates to 255 and every channel at exactly zero stays 0, which
      // is why the bad frames hold nothing but the eight corners of the RGB cube, and why the sky
      // came out as flat black/green/cyan bands instead of a gradient.
      //
      // Proof it is this tile: with a reddish fog colour the flashes turned red.
      //
      // So aim the tile at 128, the neutral value for a modulate-2x blend - then redrawing it any
      // number of times changes nothing. LastR = 76 lands on 127. bClearToFogColor makes the engine
      // clear the colour buffer each frame as well, which is what stops the accumulation at source.
      {
        const fog = holder.fogColor || [76, 76, 76];
        pr.bool("bDistanceFog", true);
        pr.bool("bClearToFogColor", true);
        pr.bool("bNewKFColorCorrection", true);
        pr.color("KFOverlayColor", [fog[0], fog[1], fog[2], 0]);
        pr.color("DistanceFogColor", [fog[0], fog[1], fog[2], 0]);
        pr.float("DistanceFogStart", -2000);
        pr.float("DistanceFogEnd", 250000);   // past the skybox cube: the fog must not tint anything
      }
      pr.actorCommon(levelInfoRef, physVolRef, "ZoneInfo");
      pr.vector("Location", [0, 0, 0]);
      pr.end();
      return w;
    },
  });

  // GoldSrc light entities -> Engine.Light actors, also listed in Model.Lights the way every
  // shipped map lists its own. They are what KFEd rebuilds lighting from, and the engine reaches
  // for that list when it lights anything that is not BSP.
  const lightRefs = [];
  if (o.lights !== false && !o.noLight) {
    const LIGHT_CLASSES = /^light(_spot|_environment)?$/;
    for (const e of map.entities) {
      if (!LIGHT_CLASSES.test(e.classname || "")) continue;
      const org = bspReader.num3(e.origin, [0, 0, 0]);
      // "_light" is "R G B brightness"; HL's default falloff reaches roughly `brightness` units.
      const parts = (e._light || "255 255 255 200").trim().split(/\s+/).map(Number);
      const rgb = [parts[0] || 255, parts[1] || 255, parts[2] || 255];
      const power = parts.length > 3 ? (parts[3] || 200) : 200;
      const maxc = Math.max(rgb[0], rgb[1], rgb[2]) || 255;
      const min = Math.min(rgb[0], rgb[1], rgb[2]);
      const hue = hueOf(rgb, maxc, min);
      const ref = pkg.addExport({
        classRef: refs.Light, name: "Light" + lightRefs.length, flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(224);
          writeStateFrame(w, refs.Light);
          const pr = p.props(w);
          pr.byte("LightBrightness", Math.max(1, Math.min(255, Math.round(power * 255 / 300))));
          pr.byte("LightRadius", Math.max(4, Math.min(255, Math.round(power * o.scale / 25))));
          pr.byte("LightHue", hue);
          pr.byte("LightSaturation", maxc ? 255 - Math.round(255 * (maxc - min) / maxc) : 255);
          pr.actorCommon(levelInfoRef, physVolRef, "Light", 1, zoneInfoRef);
          pr.vector("Location", [org[0] * o.scale, -org[1] * o.scale, org[2] * o.scale]);
          pr.end();
          return w;
        },
      });
      lightRefs.push(ref);
    }
    log("lights: " + lightRefs.length + " converted from GoldSrc light entities");
  }

  // GoldSrc's `light_environment` is the sun: a direction (pitch + yaw) and a colour, with no
  // position. KF has no Sunlight class, but Engine.Light does the same job with
  // LightEffect = LE_Sunlight and bDirectional, taking its direction from the actor's Rotation.
  // It is the only light in a CS map that can cast the shape of the level, so it is what makes a
  // Build Lighting in KFEd produce shadows instead of flat fill.
  const sunRefs = [];
  for (const e of map.entities) {
    if (e.classname !== "light_environment" || o.noLight) continue;
    const parts = (e._light || "255 255 255 200").trim().split(/\s+/).map(Number);
    const rgb = [parts[0] || 255, parts[1] || 255, parts[2] || 255];
    const power = parts.length > 3 ? (parts[3] || 200) : 200;
    const mx = Math.max(rgb[0], rgb[1], rgb[2]), mn = Math.min(rgb[0], rgb[1], rgb[2]);
    // GoldSrc pitch is negative pointing down, Unreal's is positive pointing up; both measure
    // 65536 units to the turn. Yaw comes from `angles` as "0 yaw 0", and Y is mirrored.
    const pitchDeg = parseFloat(e.pitch !== undefined ? e.pitch : (e.angles || "0 0 0").split(/\s+/)[0]) || -45;
    const yawDeg = parseFloat((e.angles || "0 0 0").split(/\s+/)[1]) || 0;
    const rot = [Math.round((pitchDeg / 360) * 65536), Math.round((-yawDeg / 360) * 65536), 0];
    sunRefs.push(pkg.addExport({
      classRef: refs.Light, name: "Sunlight" + sunRefs.length, flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.Light);
        const pr = p.props(w);
        pr.byte("LightEffect", 19);                  // LE_Sunlight
        pr.bool("bDirectional", true);
        pr.bool("bStatic", true);
        pr.byte("LightBrightness", Math.max(1, Math.min(255, Math.round(power * 255 / 300))));
        pr.byte("LightHue", hueOf(rgb, mx, mn));
        pr.byte("LightSaturation", mx ? Math.max(0, Math.min(255, Math.round(255 - 255 * (mx - mn) / mx))) : 255);
        pr.byte("LightRadius", 255);
        pr.actorCommon(levelInfoRef, physVolRef, "Light", 1, zoneInfoRef);
        pr.vector("Location", [0, 0, holder.sunZ === undefined ? 4096 : holder.sunZ]);
        pr.rotator("Rotation", rot);
        pr.end();
        return w;
      },
    }));
    log("sunlight: pitch " + pitchDeg + ", yaw " + yawDeg + ", colour " + rgb.join(",") + " @ " + power);
  }

  // Water you can actually swim in. Translucent faces alone are just a picture - the player falls
  // straight through them. KF decides you are in water from a PhysicsVolume with bWaterVolume.
  //
  // The volume needs a Brush. A PhysicsVolume is an ABrush, and an ABrush whose `Brush` is None has
  // no shape: setting only CollisionRadius/CollisionHeight produced an actor that loaded, sat in
  // the level, and did nothing at all - an A/B build with the volumes removed rendered pixel for
  // pixel the same. Every Volume in every shipped map carries its own UModel + UPolys, so this one
  // does too: a box the size of the func_water brush. See unreal/polys.js.
  const waterVols = [], waterWhere = [];
  for (const e of map.entities) {
    if (e.classname !== "func_water" || process.env.KF_NO_WATERVOL) continue;
    const mm = /^\*(\d+)$/.exec(e.model || "");
    if (!mm) continue;
    const sm = map.models[+mm[1]];
    if (!sm) continue;
    const org = bspReader.num3(e.origin, [0, 0, 0]);
    const lo = [0, 1, 2].map((a) => (sm.mins[a] + org[a]) * o.scale);
    const hi = [0, 1, 2].map((a) => (sm.maxs[a] + org[a]) * o.scale);
    // GoldSrc -> UE mirrors Y, which swaps that axis' min and max.
    const centre = [(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const half = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
    const idx = waterVols.length;
    const polysRef = pkg.addExport({
      classRef: refs.Polys, name: "WaterPolys" + idx, flags: RF.GAME,
      serialize: (p) => writePolys(p, boxPolys(half.map((v) => -v), half)),
    });
    const modelRef = pkg.addExport({
      classRef: refs.Model, name: "WaterBrush" + idx, flags: RF.GAME,
      serialize: (p) => writeModel(p, Object.assign(boxBrushModel(half.map((v) => -v), half), { polys: polysRef })),
    });
    waterVols.push(pkg.addExport({
      classRef: refs.PhysicsVolume, name: "WaterVolume" + idx, flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(320);
        writeStateFrame(w, refs.PhysicsVolume);
        const pr = p.props(w);
        pr.bool("bWaterVolume", true);
        pr.float("FluidFriction", 2.4);
        pr.float("TerminalVelocity", 800);          // sinking at 2500 uu/s reads as falling, not swimming
        pr.int("Priority", 100000);                 // must win over DefaultPhysicsVolume
        // KF tints the screen from the volume the player is standing in, but only when the volume
        // says it has fog (HUDKillingFloor.Timer). It is what makes water look like water from the
        // inside - and it doubles as the only way to see from outside whether the volume took.
        pr.bool("bDistanceFog", true);
        pr.bool("bNewKFColorCorrection", true);
        pr.color("KFOverlayColor", [40, 90, 130, 0]);
        pr.color("DistanceFogColor", [40, 90, 130, 0]);
        pr.float("DistanceFogStart", 0);
        pr.float("DistanceFogEnd", 6000);           // ~3000 GoldSrc units: murky, not opaque
        pr.actorCommon(levelInfoRef, physVolRef, "PhysicsVolume", 1, zoneInfoRef);
        pr.vector("Location", centre);
        pr.object("Brush", modelRef);
        pr.end();
        return w;
      },
    }));
    waterWhere.push(centre.map(Math.round).join(",") + " " + half.map((v) => Math.round(v * 2)).join("x"));
  }
  if (waterVols.length) log("water volumes: " + waterVols.length + " (swimmable) at " + waterWhere.join(" | "));

  // Sprites: env_sprite, env_glow and cycler_sprite all name a .spr in their `model` key. They are
  // the lamp glows, the smoke puffs and the signs - small, but a map missing them looks unlit and
  // empty. A .spr that cannot be found is skipped and counted, never faked.
  const spriteActors = [];
  {
    const wanted = o.noExtras ? [] : map.entities.filter((e) =>
      (e.classname === "env_sprite" || e.classname === "env_glow" || e.classname === "cycler_sprite") &&
      /\.spr$/i.test(e.model || ""));
    const cache = new Map();
    let missing = 0;
    for (const e of wanted) {
      const rel = e.model.replace(/\\/g, "/").toLowerCase();
      if (!cache.has(rel)) {
        const file = resources.modFile(o.bspFile, rel, o.wadDirs);
        const spr = file && sprReader.load(file);
        if (!spr) { cache.set(rel, null); }
        else {
          // DT_Sprite draws the texture at USize x DrawScale units, so a resample to power-of-two
          // has to be undone in DrawScale or the sprite changes size.
          const pot = { w: 1 << Math.round(Math.log2(spr.width)), h: 1 << Math.round(Math.log2(spr.height)) };
          const img = (pot.w === spr.width && pot.h === spr.height) ? spr : resample(spr, pot.w, pot.h);
          const tex = addRgbTexture(pkg, refs, "spr_" + path.basename(rel, ".spr"),
            { width: pot.w, height: pot.h, rgb: img.rgb, alpha: img.alpha }, 1);
          cache.set(rel, { tex, spr, unit: spr.width / pot.w });
        }
      }
      const hit = cache.get(rel);
      if (!hit) { missing++; continue; }
      const org = bspReader.num3(e.origin, [0, 0, 0]);
      const loc = [org[0] * o.scale, -org[1] * o.scale, org[2] * o.scale];
      // Additive is how a glow reads; anything else keeps its own alpha.
      const style = (hit.spr.additive || e.rendermode === "5") ? 6 : 5;   // STY_Additive / STY_Alpha
      const drawScale = (parseFloat(e.scale) || 1) * o.scale * hit.unit;
      const glow = e.renderamt === undefined ? 1 : Math.max(0.05, (parseFloat(e.renderamt) || 255) / 255);
      spriteActors.push(pkg.addExport({
        classRef: refs.Effects, name: "Sprite" + spriteActors.length, flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(256);
          writeStateFrame(w, refs.Effects);
          const pr = p.props(w);
          pr.object("Texture", hit.tex.texRef);
          pr.byte("Style", style);
          pr.float("DrawScale", drawScale);
          pr.float("ScaleGlow", glow);
          pr.bool("bUnlit", true);
          pr.bool("bStatic", true);
          pr.actorCommon(levelInfoRef, physVolRef, "Effects", 1, zoneInfoRef);
          pr.vector("Location", loc);
          pr.end();
          return w;
        },
      }));
    }
    if (wanted.length) log("sprites: " + spriteActors.length + " placed from " +
      [...cache.keys()].filter((k) => cache.get(k)).length + " .spr file(s)" +
      (missing ? ", " + missing + " skipped (file not found)" : ""));
  }

  // Props: the .mdl models a map places as scenery. de_winter_austria puts 61 of them - the trees,
  // the barrels, the truck - so a map converted without them looks stripped. Same entities as the
  // sprites above, except their `model` names a .mdl; one StaticMesh per file, one actor per entity.
  const propActors = [];
  {
    const wanted = o.noExtras ? [] : map.entities.filter((e) => /\.mdl$/i.test(e.model || "") && !/^\*/.test(e.model));
    const cache = new Map();
    let missing = 0, propTris = 0;
    for (const e of wanted) {
      const rel = e.model.replace(/\\/g, "/").toLowerCase();
      if (!cache.has(rel)) {
        const file = resources.modFile(o.bspFile, rel, o.wadDirs);
        const model = file && mdlReader.load(file);
        let built = null;
        if (model) {
          const texRefs = new Map();
          const texRefOf = (t) => {
            if (!t) return null;
            if (!texRefs.has(t.name)) {
              const pot = { w: 1 << Math.round(Math.log2(t.width)), h: 1 << Math.round(Math.log2(t.height)) };
              const img = (pot.w === t.width && pot.h === t.height) ? t : resample(t, pot.w, pot.h);
              texRefs.set(t.name, addRgbTexture(pkg, refs, "mdl_" + path.basename(rel, ".mdl") + "_" + t.name.replace(/\.[a-z]+$/i, ""),
                { width: pot.w, height: pot.h, rgb: img.rgb, alpha: img.alpha }, 1).texRef);
            }
            return texRefs.get(t.name);
          };
          built = buildPropMesh(model, { scale: o.scale, texRefOf, light: [150, 150, 150] });
        }
        cache.set(rel, built && {
          mesh: built,
          meshRef: pkg.addExport({
            classRef: refs.StaticMesh, name: "prop_" + sanitizeName(path.basename(rel, ".mdl")) + "_" + cache.size,
            flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
            serialize: (p) => buildMeshExport(p, built),
          }),
          instRef: pkg.addExport({
            classRef: refs.StaticMeshInstance, name: "propLight" + cache.size,
            flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
            serialize: (p) => buildMeshInstance(p, built),
          }),
        });
        if (built) propTris += built.indices.length / 3;
      }
      const hit = cache.get(rel);
      if (!hit) { missing++; continue; }
      const org = bspReader.num3(e.origin, [0, 0, 0]);
      const loc = [org[0] * o.scale, -org[1] * o.scale, org[2] * o.scale];
      // GoldSrc `angles` is "pitch yaw roll" in degrees; the Y mirror reverses the sense of a yaw.
      // A cycler_sprite draws its model a quarter turn past the yaw it declares - measured, not
      // guessed: see GOTCHAS 5.31a and scripts/propyaw.js.
      const ang = (e.angles || "").trim().split(/\s+/).map(Number);
      const yawDeg = e.angle !== undefined ? parseFloat(e.angle) : (isFinite(ang[1]) ? ang[1] : 0);
      const deg = (d) => Math.round(((d || 0) / 360) * 65536);
      const rot = [deg(isFinite(ang[0]) ? ang[0] : 0), deg(-((yawDeg || 0) + 90)), deg(isFinite(ang[2]) ? ang[2] : 0)];
      propActors.push(pkg.addExport({
        classRef: refs.StaticMeshActor, name: "Prop" + propActors.length, flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(288);
          writeStateFrame(w, refs.StaticMeshActor);
          const pr = p.props(w);
          pr.object("StaticMesh", hit.meshRef);
          pr.object("StaticMeshInstance", hit.instRef);
          pr.bool("bStatic", true);
          pr.bool("bWorldGeometry", true);
          // Props are scenery: they collide so you cannot walk through the truck, but they are not
          // the floor, so the karma flag stays off (see GOTCHAS 4.8c).
          pr.bool("bCollideActors", true);
          pr.bool("bBlockActors", true);
          pr.bool("bBlockPlayers", true);
          pr.bool("bBlockZeroExtentTraces", true);
          pr.bool("bBlockNonZeroExtentTraces", true);
          pr.bool("bBlockKarma", false);
          pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
          pr.vector("ColLocation", loc);
          pr.vector("Location", loc);
          pr.rotator("Rotation", rot);
          pr.end();
          return w;
        },
      }));
    }
    if (wanted.length) log("props: " + propActors.length + " placed from " +
      [...cache.values()].filter(Boolean).length + " .mdl file(s), " + propTris + " triangles" +
      (missing ? ", " + missing + " skipped (file not found or unreadable)" : ""));
  }

  const starts = [];
  if (o.emitPlayerStarts) {
    // Harness hook: KF_SPAWN_AT="x,y,z" drops the player at one chosen spot instead of the map's
    // own spawns, so a specific thing (a pool, a corner) can be looked at without driving there.
    const spawnAt = process.env.KF_SPAWN_AT && process.env.KF_SPAWN_AT.split(",").map(Number);
    const at = spawnAt && spawnAt.slice(0, 3);
    const spawns = at
      ? [{ origin: "0 0 0", _at: at }]
      : map.entities.filter((e) => e.classname === "info_player_start" || e.classname === "info_player_deathmatch");
    spawns.slice(o.spawnIndex !== undefined ? o.spawnIndex : 0, o.spawnIndex !== undefined ? o.spawnIndex + 1 : (o.spawnLimit || 32)).forEach((e, i) => {
      const org = bspReader.num3(e.origin, [0, 0, 0]);
      const ground = floorUnder(map, org);
      const z = ground === null ? org[2] * o.scale + 40 : ground * o.scale + 46;
      // KF_SPAWN_AT is given in Unreal units; drop it onto the floor the same way a real spawn is,
      // or the pawn lands inside geometry or falls out of the level and the test proves nothing.
      let loc = e._at || [org[0] * o.scale, -org[1] * o.scale, z];
      if (e._at) {
        const g = floorUnder(map, [e._at[0] / o.scale, -e._at[1] / o.scale, e._at[2] / o.scale]);
        if (g !== null) loc = [e._at[0], e._at[1], g * o.scale + 46];
      }
      const yaw = e._at && spawnAt && spawnAt.length > 3 ? Math.round((spawnAt[3] / 360) * 65536) & 0xffff : angleToYaw(e);
      starts.push(pkg.addExport({
        classRef: refs.PlayerStart, name: "PlayerStart" + i, flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(160);
          writeStateFrame(w, refs.PlayerStart);
          const pr = p.props(w);
          pr.actorCommon(levelInfoRef, physVolRef, "PlayerStart");
          pr.vector("Location", loc);
          pr.rotator("Rotation", [0, yaw, 0]);
          pr.end();
          return w;
        },
      }));
    });
    holder.starts = starts;
    log("player starts: " + starts.length);
  }

  const summaryRef = pkg.addExport({
    classRef: refs.LevelSummary, name: "LevelSummary", flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
    serialize: (p) => {
      const w = new Writer(256);
      const pr = p.props(w);
      writeCredits(pr);
      pr.end();
      return w;
    },
  });
  holder.summaryRef = summaryRef;

  // The world model is built lazily so every export ref it needs already exists.
  const built = {};
  const worldModelRef = pkg.addExport({
    classRef: refs.Model, name: "WorldModel", flags: RF.GAME,
    serialize: (p) => {
      const r = buildModel(map, {
        scale: o.scale, lightMapScale: o.lightMapScale,
        texByMiptex, texByRef, levelRef: built.levelRef, polysRef: worldPolysRef, zoneInfoRef,
        emptyWorld: !!o.emptyWorld, minimalWorld: o.geometry === "mesh" && o.minimalWorld !== false, hideMaterialRef: hideTexRef, lightRefs,
        // On the mesh route the sky is a separate skybox mesh, so the BSP must hide its sky faces
        // too (otherwise the stretched, blown-out projection draws over it). Only the BSP/both
        // routes still project the sky onto the world model.
        skySides: (o.geometry !== "mesh" && Object.keys(skySides).length) ? skySides : null, skyExtent,
        // The sky stays in the BSP as PF_FakeBackdrop surfaces and the SkyZoneInfo's room is
        // projected through them - which is how every shipped KF map builds a sky. KF_SKY_BACKDROP=1
        // goes back to the old giant cube around the level.
        skyBackdrop: !!process.env.KF_SKY_BACKDROP,
        sky: process.env.KF_SKY_BACKDROP ? "backdrop" : (o.sky || "texture"),
        noLight: !!o.noLight, brushEntities: o.brushEntities !== false,
        // On the mesh route the BSP is skeleton only: its LeafHulls come from a flat tree that has
        // no solid leaves, and they trap or kill the pawn. Collision comes from the meshes' kDOP.
        noMasked: !!o.noMasked, noSections: !!o.noSections, noHulls: !!o.noHulls || o.geometry !== "bsp", faceLimit: o.faceLimit, maxDepth: o.maxDepth, noSplitPolys: !!o.noSplitPolys, treeTranslate: !!o.treeTranslate, hullMax: o.hullMax,
      });
      built.stats = r.stats;
      // Bake the packed atlases into DXT3 lightmap textures (2 mips, as every shipped map has).
      r.model.lightMapTextures = r.atlasPages.map((rgb, i) => {
        const mip0 = dxt.encodeDXT3(rgb, r.atlasSize, r.atlasSize);
        const half = dxt.halveRGB(rgb, r.atlasSize, r.atlasSize);
        const mip1 = dxt.encodeDXT3(half.rgb, half.width, half.height);
        return {
          level: built.levelRef, lightMaps: r.model.lightMaps.map((lm, k) => (lm.iTexture === i ? k : -1)).filter((k) => k >= 0),
          cacheId: [0x5f000000 + i, 0], revision: 1, mips: [mip0, mip1],
          format: 7, width: r.atlasSize, height: r.atlasSize, texRevision: 1,
        };
      });
      built.model = r.model;
      built.atlases = r.atlasPages.length;
      return writeModel(p, r.model);
    },
  });

  // --- world geometry as static meshes ------------------------------------------------------------
  // Second copy of the geometry, for KFEd: the editor draws actors in every viewport, so a level
  // whose content is only BSP looks empty there. In the game these currently render unlit (black),
  // which is why the BSP stays visible unless --geometry mesh is asked for. See ../docs/GOTCHAS.md.
  const meshActors = [];
  if (o.geometry !== "bsp") {
    // Doors and breakable glass become actors of their own; everything else merges into the world.
    const special = o.noExtras ? [] : brushEnts.collect(map);
    const separate = new Map(special.map((s, i) => [s.mi, i]));
    const meshBuild = buildMeshes(map, { scale: o.scale, texByMiptex, separate });
    // Zone ambient = the 25th PERCENTILE of the map's luxels, not the average.
    //
    // Ambient is the light that exists in shadow; the bright half of a GoldSrc lightmap comes from
    // direct light, which the ambient must not also account for. Averaging lets an open, sunlit map
    // drag the whole level up - cs_italy averages 102 against cs_assault's 75 and came out visibly
    // blown out, while the shadow level of the two is nearly the same (38 vs 38).
    holder.ambient = 96;
    if (meshBuild.stats.lumN) {
      const want = meshBuild.stats.lumN * 0.25;
      let seen = 0, q = 0;
      for (; q < 256 && seen < want; q++) seen += meshBuild.stats.lumHist[q];
      holder.ambient = Math.max(24, Math.min(120, q));
    }
    log("ambient: zone brightness " + holder.ambient + " (shadow level: 25th percentile of every GoldSrc luxel)");
    if (meshBuild.stats.lumN) {
      const r = meshBuild.stats.lumR / meshBuild.stats.lumN;
      const gch = meshBuild.stats.lumG / meshBuild.stats.lumN;
      const b = meshBuild.stats.lumB / meshBuild.stats.lumN;
      const mx = Math.max(r, gch, b), mn = Math.min(r, gch, b);
      holder.ambientHue = hueOf([r, gch, b], mx, mn);
      // UE2's AmbientSaturation is inverted: 255 is grey, 0 is fully saturated.
      holder.ambientSaturation = mx > 0 ? Math.max(0, Math.min(255, Math.round(255 - 255 * (mx - mn) / mx))) : 255;
      // The zone's fog colour, which is also what KF's screen overlay is tinted with. Keep the
      // map's own cast but land it in the range the shipped maps use (they sit at 40-80) - the
      // overlay brightens it, so a high value washes the screen out.
      // 76 is where KF's overlay lands on 128, the no-op value for its modulate blend.
      const mean = (r + gch + b) / 3;
      const norm = mean > 0 ? 76 / mean : 1;
            // Keep every channel within a few of 76: the map's cast is already carried by AmbientHue,
      // and a wide spread here is a per-channel gain that a repeated draw would still pull apart.
      holder.fogColor = [r, gch, b].map((v) => Math.max(72, Math.min(80, Math.round(v * norm))));
      log("ambient colour: hue " + holder.ambientHue + ", saturation " + holder.ambientSaturation +
        " (mean luxel " + [r, gch, b].map((v) => Math.round(v)).join(",") + "), fog/overlay " + holder.fogColor.join(","));
    }
    const lowest = meshBuild.meshes.reduce((z, m) => Math.min(z, m.bbox.min[2]), Infinity);
    if (Number.isFinite(lowest)) holder.killZ = lowest - 2000;
    log("mesh: " + meshBuild.stats.faces + " faces -> " + meshBuild.stats.triangles + " triangles in " +
      meshBuild.meshes.length + " mesh(es)" + (meshBuild.stats.skipped ? ", " + meshBuild.stats.skipped + " skipped" : "") +
      (meshBuild.stats.sky ? ", " + meshBuild.stats.sky + " sky faces cut out for the skybox" : "") +
      (meshBuild.stats.water ? ", " + meshBuild.stats.water + " water surfaces (translucent, no collision, " +
        (meshBuild.stats.waterHidden || 0) + " box sides dropped)" : ""));
    meshBuild.meshes.forEach((mesh, i) => {
      const meshRef = pkg.addExport({
        classRef: refs.StaticMesh, name: mapName.replace(/[^A-Za-z0-9_]/g, "") + "_geo" + i,
        flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
        serialize: (p) => buildMeshExport(p, mesh),
      });
      // Baked GoldSrc light rides in as the instance's per-vertex colours: that is where KF keeps
      // static-mesh lighting, and a level with no Light actors renders its meshes black without it.
      const instRef = pkg.addExport({
        classRef: refs.StaticMeshInstance, name: "GeoLight" + i,
        flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
        serialize: (p) => buildMeshInstance(p, mesh),
      });
      // A door or a pane of glass: same mesh, different actor.
      if (mesh.ent !== undefined && special[mesh.ent]) {
        const item = special[mesh.ent];
        const isDoor = item.kind === "door";
        const cls = isDoor ? refs.DoorMover : refs.GlassMover;
        const motion = isDoor ? brushEnts.doorMotion(item, o.scale) : null;
        const doorTag = "CSDoor" + mesh.ent;
        // KF doors are opened with the use key and can be welded shut; that behaviour lives in
        // KFDoorMover, and it only wakes up when a KFUseTrigger whose Event matches the mover's Tag
        // is standing next to it (KFDoorMover.PostBeginPlay looks for exactly that).
        if (isDoor) {
          const half = [0, 1, 2].map((k) => (mesh.bbox.max[k] - mesh.bbox.min[k]) / 2);
          const reach = Math.max(96, Math.hypot(half[0], half[1]) + 48);
          meshActors.push(pkg.addExport({
            classRef: refs.UseTrigger, name: "DoorTrigger" + mesh.ent, flags: ACTOR,
            serialize: (p) => {
              const w = new Writer(256);
              writeStateFrame(w, refs.UseTrigger);
              const pr = p.props(w);
              pr.nameProp("Event", doorTag);
              pr.float("CollisionRadius", reach);
              pr.float("CollisionHeight", Math.max(64, half[2] + 24));
              pr.float("MaxWeldStrength", 400);
              pr.bool("bCollideActors", true);
              pr.actorCommon(levelInfoRef, physVolRef, "DoorTrigger" + mesh.ent, 1, zoneInfoRef);
              pr.vector("ColLocation", mesh.origin);
              pr.vector("Location", mesh.origin);
              pr.end();
              return w;
            },
          }));
        }
        meshActors.push(pkg.addExport({
          classRef: cls, name: (isDoor ? "Door" : "Glass") + mesh.ent + "_" + i, flags: ACTOR,
          serialize: (p) => {
            const w = new Writer(384);
            writeStateFrame(w, cls);
            const pr = p.props(w);
            pr.object("StaticMesh", meshRef);
            pr.object("StaticMeshInstance", instRef);
            // DT_StaticMesh is 8, not 7 - EDrawType has DT_SpriteAnimOnce at 7. Verified against
            // a shipped KFDoorMover, which is also proof a Mover needs no Brush when it has a mesh.
            pr.byte("DrawType", 8);
            if (isDoor) {
              // Keyframe 0 is where it stands, keyframe 1 is open. KFDoorMover's own state is
              // TriggerToggle - the trigger above opens and closes it - so no bump handling here.
              pr.vectorAt("KeyPos", 1, motion.pos);
              pr.rotatorAt("KeyRot", 1, motion.rot);
              pr.float("MoveTime", motion.moveTime);
              pr.float("StayOpenTime", motion.stayOpen);
              pr.bool("bDynamicLightMover", false);
              pr.bool("bShadowCast", false);
            } else {
              pr.int("Health", Math.max(1, parseInt(item.e.health, 10) || 50));
              // CS glass is drawn with renderamt; without this it converts to an opaque slab.
              pr.byte("Style", 3);                      // STY_Translucent
              pr.float("ScaleGlow", Math.max(0.15, (parseFloat(item.e.renderamt) || 150) / 255));
            }
            pr.bool("bBlockKarma", false);
            pr.actorCommon(levelInfoRef, physVolRef, isDoor ? doorTag : "KFGlassMover", 1, zoneInfoRef);
            // A rotating door turns about its hinge, which GoldSrc stores as the entity's `origin`
            // brush. An actor turns about its Location and draws at Location - PrePivot, so put the
            // actor on the hinge and let PrePivot carry the mesh back where it belongs.
            const hinge = isDoor && item.e.origin ? bspReader.num3(item.e.origin, null) : null;
            const at = hinge ? [hinge[0] * o.scale, -hinge[1] * o.scale, hinge[2] * o.scale] : mesh.origin;
            if (hinge) pr.vector("PrePivot", [0, 1, 2].map((k) => at[k] - mesh.origin[k]));
            // Shipped movers carry BasePos/BaseRot explicitly; the keyframes are relative to them.
            if (isDoor) { pr.vector("BasePos", at); pr.rotator("BaseRot", [0, 0, 0]); }
            pr.vector("ColLocation", at);
            pr.vector("Location", at);
            pr.end();
            return w;
          },
        }));
        return;
      }
      meshActors.push(pkg.addExport({
        classRef: refs.StaticMeshActor, name: "GeoMesh" + i, flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(256);
          writeStateFrame(w, refs.StaticMeshActor);
          const pr = p.props(w);
          pr.object("StaticMesh", meshRef);
          pr.object("StaticMeshInstance", instRef);
          // In "both" the BSP draws the world and these carry collision only. They still render -
          // black, since nothing lights them - straight over the BSP, which is what the black
          // patches were. bHidden stops the draw; it does not affect collision, and KFEd draws
          // hidden actors anyway (it honours bHiddenEd instead).
          if (o.geometry === "both") pr.bool("bHidden", true);

          {
            pr.bool("bStatic", true);
            pr.bool("bWorldGeometry", true);
            // Spelled out rather than inherited: the level is nothing but these actors, so if the
            // class defaults ever disagree the whole map becomes a hole the player falls through.
            // Water is drawn but never blocks: in CS you walk and swim through it, so a water mesh
            // with the usual collision would be an invisible wall across the pool.
            pr.bool("bCollideActors", !mesh.water);
            pr.bool("bBlockActors", !mesh.water);
            pr.bool("bBlockPlayers", !mesh.water);
            pr.bool("bBlockZeroExtentTraces", !mesh.water);
            pr.bool("bBlockNonZeroExtentTraces", !mesh.water);
            // Karma is what killed the level: KInitActorKarma -> KCreateActorGeometry ->
            // KAggregateGeomInstance allocates until the process runs out of virtual memory when
            // the mesh has no karma primitives to build from. Nothing here needs rigid bodies.
            pr.bool("bBlockKarma", false);
          }
          pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
          // The mesh is authored around its own centre; put the actor where that centre belongs.
          pr.vector("ColLocation", mesh.origin);
          pr.vector("Location", mesh.origin);
          pr.end();
          return w;
        },
      }));
    });
    if (special.length) {
      const doors = special.filter((s) => s.kind === "door").length;
      log("brush entities: " + doors + " door(s) as KFDoorMover + KFUseTrigger (use key, weldable), " +
        (special.length - doors) + " glass pane(s) as KFGlassMover");
    }
    meshBuild.meshes.forEach((m, i) => log("  geo" + i + ": " + m.vertices.length + " verts, " +
      (m.indices.length / 3) + " tris, " + m.sections.length + " sections"));

    // The sky, the way Killing Floor builds one: a SMALL room parked away from the level with a
    // SkyZoneInfo at its centre. The renderer draws that room from the SkyZoneInfo's position using
    // the player's rotation, through every BSP surface flagged PF_FakeBackdrop - so it sits at
    // infinity, has no parallax, never intersects anything and is never clipped. Every shipped map
    // is built this way; the giant cube around the level was not how KF does it.
    if (o.geometry === "mesh" && Object.keys(skySides).length && process.env.KF_SKY_BACKDROP) {
      const R = 512;
      // Well clear of the level, and inside the world extent.
      const room = [skyExtent[0][0] - 20000, skyExtent[0][1] - 20000, skyExtent[0][2] - 20000];
      const sky = buildSkyboxMesh([0, 0, 0], R, skySides);
      const skyMeshRef = pkg.addExport({
        classRef: refs.StaticMesh, name: "SkyRoom",
        flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
        serialize: (p) => buildMeshExport(p, sky),
      });
      const skyInstRef = pkg.addExport({
        classRef: refs.StaticMeshInstance, name: "SkyRoomLight",
        flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
        serialize: (p) => buildMeshInstance(p, sky),
      });
      meshActors.push(pkg.addExport({
        classRef: refs.StaticMeshActor, name: "SkyRoomActor", flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(256);
          writeStateFrame(w, refs.StaticMeshActor);
          const pr = p.props(w);
          pr.object("StaticMesh", skyMeshRef);
          pr.object("StaticMeshInstance", skyInstRef);
          pr.bool("bUnlit", true);
          pr.bool("bStatic", true);
          pr.bool("bWorldGeometry", true);
          pr.bool("bCollideActors", false);
          pr.bool("bBlockActors", false);
          pr.bool("bBlockKarma", false);
          pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
          pr.vector("ColLocation", room);
          pr.vector("Location", room);
          pr.end();
          return w;
        },
      }));
      meshActors.push(pkg.addExport({
        classRef: refs.SkyZoneInfo, name: "SkyZoneInfo0", flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(224);
          writeStateFrame(w, refs.SkyZoneInfo);
          const pr = p.props(w);
          pr.byte("AmbientBrightness", 255);
          pr.actorCommon(levelInfoRef, physVolRef, "SkyZoneInfo", 1, zoneInfoRef);
          pr.vector("Location", room);
          pr.end();
          return w;
        },
      }));
      log("sky: SkyZoneInfo room at " + room.map(Math.round).join(",") +
        " (half-size " + R + "), projected through " + (built.model ? built.model.surfs.filter((s) => (s.polyFlags & 0x80) !== 0).length : "?") +
        " PF_FakeBackdrop surfaces");
    }
    // The cube around the level. Not how KF builds a sky - but a real KF sky needs the sky room to
    // be its OWN zone, and this degenerate BSP has none to give. Measured: PF_FakeBackdrop with
    // nowhere to project draws pure white. KF_SKY_BACKDROP=1 tries the KF way anyway.
    if (o.geometry === "mesh" && Object.keys(skySides).length && !o.noSky && !process.env.KF_SKY_BACKDROP) {
      const center = [(skyExtent[0][0] + skyExtent[1][0]) / 2, (skyExtent[0][1] + skyExtent[1][1]) / 2, (skyExtent[0][2] + skyExtent[1][2]) / 2];
      // How far away the cube sits is the whole look of the sky. Counter-Strike draws its skybox
      // around the camera, so the mountains never move; a real cube in the world has parallax, and
      // at 1.35x the map radius the mountains sat at wall height right behind the walls. Push it
      // out until walking across the level barely turns the sky: 6x the radius moves it under 10
      // degrees end to end.
      //
      // The cap is the renderer's far plane. Measured on a2k_aimskillz: half-size 32000 (far corner
      // 55000 units) still drew everywhere, including straight up; an earlier note in this file
      // blamed clipping for the white smears, which this run does not reproduce. 30000 keeps a
      // margin.
      const half = [0, 1, 2].map((a) => (skyExtent[1][a] - skyExtent[0][a]) / 2);
      const radius = Math.hypot(half[0], half[1], half[2]);
      const R = +process.env.KF_SKY_R || Math.max(12000, Math.min(30000, radius * 6));
      const sky = buildSkyboxMesh(center, R, skySides);
      const skyMeshRef = pkg.addExport({
        classRef: refs.StaticMesh, name: "SkyBox",
        flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
        serialize: (p) => buildMeshExport(p, sky),
      });
      const skyInstRef = pkg.addExport({
        classRef: refs.StaticMeshInstance, name: "SkyBoxLight",
        flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
        serialize: (p) => buildMeshInstance(p, sky),
      });
      meshActors.push(pkg.addExport({
        classRef: refs.StaticMeshActor, name: "SkyBoxActor", flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(256);
          writeStateFrame(w, refs.StaticMeshActor);
          const pr = p.props(w);
          pr.object("StaticMesh", skyMeshRef);
          pr.object("StaticMeshInstance", skyInstRef);
          pr.bool("bUnlit", true);
          // Editor-only hide. The cube encloses the whole level, so in KFEd every viewport ends up
          // inside it and shows nothing but sky - which reads as a plain white background and makes
          // the map impossible to work on. bHiddenEd does not affect the game.
          pr.bool("bHiddenEd", true);
          pr.bool("bStatic", true);
          pr.bool("bWorldGeometry", true);
          pr.bool("bBlockKarma", false);
          pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
          pr.vector("ColLocation", center);
          pr.vector("Location", [0, 0, 0]);
          pr.end();
          return w;
        },
      }));
      log("skybox mesh: cube half-size " + Math.round(R) + " (level radius " + Math.round(radius) + ")");
    }
  }

  // Render probe: a shipped KF mesh, read back and re-serialized by our own writer with only the
  // material block swapped. Separates "our mesh content is wrong" from "our package wiring is
  // wrong". KF_STOCK="pkgPath|MeshName|x,y,z".
  if (process.env.KF_STOCK) {
    const [pkgPath, meshName, where] = process.env.KF_STOCK.split("|");
    const R = require("./unreal/read");
    const { readMesh, writeMesh } = require("./unreal/staticmesh");
    const src2 = R.load(pkgPath);
    const exp = src2.exports.find((e) => src2.classOf(e) === "StaticMesh" && e.name === meshName);
    const m = readMesh(src2, exp);
    const at = where.split(",").map(Number);
    const texRef = [...texByRef.keys()].find((k) => k) || 0;
    const stockRef = pkg.addExport({
      classRef: refs.StaticMesh, name: "StockCopy", flags: refs.flagsGame,
      serialize: (p) => {
        const { Props, PropType, Writer: W } = require("./unreal/writer");
        const head = new W(1 << 12);
        const pr = new Props(head, p.names);
        const inner = new W(1 << 10);
        inner.cidx(m.sections.length);
        for (let i = 0; i < m.sections.length; i++) {
          const ip = new Props(inner, p.names);
          ip.bool("EnableCollision", true);
          ip.object("Material", texRef);
          ip.end();
        }
        pr._tag("Materials", PropType.Array, Buffer.from(inner.out()));
        pr.bool("UseSimpleBoxCollision", false);
        pr.bool("UseSimpleKarmaCollision", false);
        pr.end();
        return writeMesh(p, Object.assign({}, m, { props: Buffer.from(head.out()) }));
      },
    });
    meshActors.push(pkg.addExport({
      classRef: refs.StaticMeshActor, name: "StockCopyActor", flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.StaticMeshActor);
        const pr = p.props(w);
        pr.object("StaticMesh", stockRef);
        pr.bool("bStatic", true);
        pr.bool("bWorldGeometry", true);
        pr.bool("bCollideActors", !process.env.KF_NOCOL);
        pr.bool("bBlockActors", true);
        pr.bool("bBlockPlayers", true);
        pr.bool("bBlockZeroExtentTraces", true);
        pr.bool("bBlockNonZeroExtentTraces", true);
        pr.bool("bBlockKarma", false);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", at);
        pr.vector("Location", at);
        pr.end();
        return w;
      },
    }));
    log("stock mesh copy " + meshName + " (" + m.vertices.length + " verts) at " + at.join(","));
  }

  // Minimal render probe: one two-triangle quad, so a mesh that will not draw can be debugged
  // without 82k triangles in the way. KF_QUAD="x,y,z".
  if (process.env.KF_QUAD) {
    const at = process.env.KF_QUAD.split(",").map(Number);
    const texRef = [...texByRef.keys()].find((k) => k) || 0;
    const R = 400;
    // A cross of two big quads through the point, so whichever way the camera faces it is in view.
    const ring = (axis) => (axis === 0
      ? [[at[0] - R, at[1], at[2] - R], [at[0] + R, at[1], at[2] - R], [at[0] + R, at[1], at[2] + R], [at[0] - R, at[1], at[2] + R]]
      : [[at[0], at[1] - R, at[2] - R], [at[0], at[1] + R, at[2] - R], [at[0], at[1] + R, at[2] + R], [at[0], at[1] - R, at[2] + R]]);
    // Two crossing quads, each emitted with both windings, so the probe is visible from inside no
    // matter which way the camera faces.
    const verts = [], uvs = [], colors = [], indices = [], sections = [], materials = [];
    for (const axis of [0, 1]) {
      for (const flip of [false, true]) {
        const base = verts.length, firstIndex = indices.length;
        const n = axis === 0 ? [0, flip ? -1 : 1, 0] : [flip ? -1 : 1, 0, 0];
        for (const p of ring(axis)) { verts.push({ pos: p, normal: n }); colors.push([255, 255, 255, 255]); }
        uvs.push([0, 1], [1, 1], [1, 0], [0, 0]);
        if (flip) indices.push(base + 2, base + 1, base, base + 3, base + 2, base);
        else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        sections.push({ firstIndex, firstVertex: base, lastVertex: base + 3, numFaces: 2 });
        materials.push(texRef);
      }
    }
    const quad = {
      materials, vertices: verts, uvs, colors, indices, sections,
      bbox: { min: [at[0] - R, at[1] - R, at[2] - R], max: [at[0] + R, at[1] + R, at[2] + R] },
      center: at, radius: R * 1.5,
    };
    const qMesh = pkg.addExport({
      classRef: refs.StaticMesh, name: "ProbeQuad",
      flags: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
      serialize: (p) => buildMeshExport(p, quad),
    });
    const qInst = pkg.addExport({
      classRef: refs.StaticMeshInstance, name: "ProbeQuadLight",
      flags: RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
      serialize: (p) => buildMeshInstance(p, quad),
    });
    meshActors.push(pkg.addExport({
      classRef: refs.StaticMeshActor, name: "ProbeQuadActor", flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.StaticMeshActor);
        const pr = p.props(w);
        pr.object("StaticMesh", qMesh);
        pr.object("StaticMeshInstance", qInst);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", [0, 0, 0]);
        pr.vector("Location", [0, 0, 0]);
        pr.end();
        return w;
      },
    }));
    log("probe quad at " + at.join(","));
  }

  if (false) {
    [].forEach((m, i) => log("  geo" + i + ": " + m.vertices.length + " verts, " +
      (m.indices.length / 3) + " tris, " + m.sections.length + " sections"));
  }

  const actors = [levelInfoRef, brushRef, physVolRef, zoneInfoRef, ...lightRefs, ...sunRefs, ...waterVols, ...spriteActors, ...propActors, ...starts, ...meshActors];
  built.levelRef = pkg.addExport({
    classRef: refs.Level, name: "myLevel", flags: RF.GAME,
    serialize: (p) => {
      const w = new Writer(512);
      w.cidx(p.names.none);                       // empty property block
      w.i32(actors.length).i32(actors.length);
      for (const a of actors) w.cidx(a);
      w.fstring("unreal").fstring("").fstring(mapName + ".rom");
      w.cidx(0);                                  // URL.Op
      w.fstring("");                              // URL.Portal
      w.i32(7777).i32(1);                         // URL.Port, URL.Valid
      w.cidx(worldModelRef);
      w.f32(0).i32(0);                            // ApproxTime, FirstDeleted
      for (let i = 0; i < 14; i++) w.u8(0);        // TextBlocks refs + empty TravelInfo map
      return w;
    },
  });
  void summaryRef;

  const buf = pkg.build();
  const out = o.outFile || path.join(o.outDir || path.dirname(o.bspFile), mapName + ".rom");
  fs.writeFileSync(out, buf);

  const s = built.stats || {};
  log("model: " + (built.model ? built.model.nodes.length : 0) + " nodes, " +
    (built.model ? built.model.surfs.length : 0) + " surfs, " +
    (built.model ? built.model.points.length : 0) + " points, " +
    (built.model ? built.model.sections.length : 0) + " sections, " +
    (built.model ? built.model.lightMaps.length : 0) + " lightmaps in " + built.atlases + " atlas(es)");
  if (s.skipped && Object.keys(s.skipped).length) log("skipped faces: " + Object.entries(s.skipped).map(([k, v]) => k + " x" + v).join(", "));
  const ents = map.entities.filter((e) => /^\*/.test(e.model || "")).length;
  log("inserted " + (s.insertedFaces || 0) + " faces (world + " + ents + " brush entities) as " +
    (s.fragments || 0) + " fragments" + (s.droppedFragments ? ", " + s.droppedFragments + " dropped" : ""));
  const covered = (s.faces || 0) - Object.values(s.skipped || {}).reduce((a, b) => a + b, 0);
  log("face coverage: " + covered + "/" + map.faces.length + " (" + ((100 * covered) / map.faces.length).toFixed(1) + "%)");
  log("wrote " + out + "  " + (buf.length / 1048576).toFixed(2) + " MB in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

  return { out, size: buf.length, model: built.model, stats: s, mapName, textures: texByMiptex.size, missingTextures: missingTex };
}

module.exports = { convert, DEFAULTS };
