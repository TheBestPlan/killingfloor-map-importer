// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// End-to-end: one glTF/GLB scene -> Killing Floor .rom.
//
// The "3D model" route: a scene exported to glTF/GLB (Sketchfab, CGTrader, a Blender .blend, an
// Open3DLab rip, or a decompiled Source map). The KF level skeleton below (LevelInfo, the builder
// brush, the world box, the zone, Level) is the same one convert.js / lineage2 / quake3 write - a
// copy, because each file is the flow of one source around the same actors.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { loadScene } = require("./read");
const { loadObj } = require("./obj");
const { buildMeshes, toKF } = require("./mesh");
const { Package, RF } = require("../unreal/package");
const { Writer, writeStateFrame } = require("../unreal/writer");
const { emptyModel, emptyPolys, writeModel } = require("../unreal/model");
const { writePolys, boxPolys } = require("../unreal/polys");
const { addRgbTexture, sanitizeName } = require("../unreal/texture");
const { buildMeshExport, buildMeshInstance } = require("../unreal/staticmesh");
const { buildModel } = require("../build/model");
const { resample } = require("../build/upscale");
const { buildSkyboxMesh } = require("../build/skyboxmesh");

const manifest = require("../../package.json");
const TOOL_NAME = manifest.productName;
const TOOL_URL = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

const DEFAULTS = {
  scale: 1.0,          // glTF units -> Unreal units. Tune per model (Sketchfab metres vs UE cm differ).
  ambient: 64,         // the zone lights the player and the zeds
  glow: 48,            // the mesh actors' own glow lights the world
  texGain: 0.7,        // pre-divide world textures: an unlit surface draws at ~2.5x (UE2 overbright + KF bloom), so a mid-bright texture blows to white without this
  lightGain: 0.6,      // KHR_lights_punctual intensity is candela/lux; no physical map to a byte, so this is a knob
  maxTexture: 512,
};

function hueOf(rgb, max, min) {
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === rgb[0]) h = ((rgb[1] - rgb[2]) / d) % 6;
  else if (max === rgb[1]) h = (rgb[2] - rgb[0]) / d + 2;
  else h = (rgb[0] - rgb[1]) / d + 4;
  return Math.round(((h + 6) % 6) * 255 / 6);
}
function satOf(max, min) { return max ? Math.max(0, Math.min(255, Math.round(255 - 255 * (max - min) / max))) : 255; }
function pot(n, cap) { let p = 1; while (p * 2 <= n && p * 2 <= cap) p *= 2; return Math.max(1, p); }

function convert(opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  for (const k of Object.keys(DEFAULTS)) if (o[k] === undefined) o[k] = DEFAULTS[k];
  const log = o.log || (() => { });
  const t0 = Date.now();

  if (!o.file && !o.scene) throw new Error("give a .glb, .gltf or .obj file (or a pre-built scene)");
  const baseName = o.baseName || (o.file ? path.basename(o.file).replace(/\.(glb|gltf|obj)$/i, "") : "scene");
  const mapName = o.mapName || ("KF-" + sanitizeName(baseName));
  // A pre-built scene (e.g. from the Source BSP route) skips file loading and reuses everything below.
  const scene = o.scene || (/\.obj$/i.test(o.file) ? loadObj(o.file, log) : loadScene(o.file, log));

  // Scale: an explicit number, or auto-fit the pawn to the model's buildings (o.autoScale / --scale auto).
  let scale = o.scale;
  if (o.autoScale) { scale = autoScale(scene); log("auto scale: " + scale.toFixed(1) + " (pawn ~ door height vs the model's buildings)"); }

  let crop = null;
  if (o.crop) { const [cx, cy, half] = o.crop.split(",").map(Number); crop = { cx: cx * scale, cy: cy * scale, half: half * scale }; log("crop: " + (half * 2) + " uu square at (" + cx + ", " + cy + ")"); }

  const meshBuild = buildMeshes(scene, {
    scale, applyMat4: scene.applyMat4, applyMat3: scene.applyMat3, crop, axes: o.axes, flip: o.flip,
    autoColor: !!o.autoColor, groundUp: o.groundUp === true,
    matKind: (mi) => (scene.materials[mi] && /MASK/i.test(scene.materials[mi].alphaMode)) ? "masked" : null,
  });
  const st = meshBuild.stats;
  log("mesh: " + st.triangles + " triangles from " + st.prims + " primitive(s) in " + meshBuild.meshes.length + " mesh(es) (" + st.skipped + " skipped, " + st.flat3 + " collinear" + (st.cropped ? ", " + st.cropped + " cropped" : "") + ")");
  if (!meshBuild.meshes.length) throw new Error("no geometry after conversion (wrong axis/scale, or crop excluded everything?)");

  const guid = crypto.createHash("md5").update(mapName).digest();
  const pkg = new Package({ guid });
  const refs = {
    Texture: pkg.importClass("Engine", "Texture"),
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
    Light: pkg.importClass("Engine", "Light"),
    Sunlight: pkg.importClass("Gameplay", "Sunlight"),
    flagsGame: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
  };
  const ACTOR = RF.GAME | RF.HasStack;
  const ACTOR_ED = RF.EDITOR_ONLY | RF.HasStack;
  const holder = {};
  const nameCount = new Map();
  const named = (cls) => { const n = nameCount.get(cls) || 0; nameCount.set(cls, n + 1); return cls + n; };

  // --- materials -> textures ----------------------------------------------------------------------
  // A colour key is `materialIndex|bucket`: bucket is empty for a textured or normally-flat material and
  // one of roof/wall/ground/foliage when auto-colour split a textureless material by geometry. Each key
  // becomes one texture; props always carry an empty bucket.
  const usedKeys = new Set();
  for (const m of meshBuild.meshes) usedKeys.add(m.mat + "|" + (m.bucket || ""));
  for (const parts of (o.propMeshes || [])) for (const pm of (parts || [])) for (const mi of pm.materialIndices) usedKeys.add(mi + "|");
  const matRef = new Map();   // colourKey -> texture ref
  const flatColor = (rgb) => { const side = 8, buf = Buffer.alloc(side * side * 3); for (let i = 0; i < side * side; i++) { buf[i * 3] = rgb[0]; buf[i * 3 + 1] = rgb[1]; buf[i * 3 + 2] = rgb[2]; } return { width: side, height: side, rgb: buf }; };
  // A noisy fill for the auto-colour buckets: deterministic per-texel brightness variation around the base
  // colour so a textureless model reads as a rough surface (grass/road/roof) instead of a flat poster.
  const clamp8 = (v) => v < 0 ? 0 : v > 255 ? 255 : v | 0;
  const noiseColor = (base) => {
    const side = 64, buf = Buffer.alloc(side * side * 3), seed = base[0] + base[1] * 3 + base[2] * 7;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ seed;
      h = Math.imul(h ^ (h >>> 13), 1274126177); h = (h ^ (h >>> 16)) & 0xff;
      const n = (h / 255 - 0.5) * 42;                         // +-21 brightness
      const o = (y * side + x) * 3;
      buf[o] = clamp8(base[0] + n); buf[o + 1] = clamp8(base[1] + n * 0.92); buf[o + 2] = clamp8(base[2] + n * 0.82);
    }
    return { width: side, height: side, rgb: buf };
  };
  // Auto-colour palette (calibrated for the model route's texGain 0.7 x the ~2.5x unlit overbright): a
  // green for foliage, terracotta roofs, beige walls, grey-tan ground.
  const bucketColor = (b) => ({ foliage: [45, 62, 32], roof: [90, 54, 43], wall: [100, 94, 82], ground: [72, 68, 60] }[b] || [130, 130, 130]);
  // A material draws cut-out when it carries $alphatest/$translucent (Source) or alphaMode MASK/BLEND
  // (glTF); a $nocull / doubleSided one draws two-sided. Both only take effect when the image has an
  // alpha channel to threshold.
  const isMasked = (mat) => !!(mat && (mat.mask || /MASK|BLEND/i.test(mat.alphaMode || "")));
  const isTwoSided = (mat) => !!(mat && (mat.twoSided || mat.doubleSided));
  let textured = 0, flat = 0;
  for (const key of usedKeys) {
    const bar = key.indexOf("|");
    const mi = parseInt(key.slice(0, bar), 10), bucket = key.slice(bar + 1);
    const mat = mi >= 0 ? scene.materials[mi] : null;
    const nm = "tex_" + (bucket ? bucket + "_" : "") + (mat && mat.name ? sanitizeName(mat.name) : "m" + (mi + 1));
    // Imported models routinely ship one-sided ground/water planes wound the wrong way for KF, so from
    // above they backface-cull to nothing (the missing terrain). o.twoSided draws both faces - cheap on
    // a single model and the safe default for the model route.
    const two = !!(o.twoSided || isTwoSided(mat));
    if (bucket) {   // auto-colour: paint the geometry bucket (noisy fill), ignore the material's flat grey factor
      const rec = addRgbTexture(pkg, refs, nm, noiseColor(bucketColor(bucket)), o.texGain, { wrap: true, twoSided: two });
      matRef.set(key, rec.texRef); flat++;
      continue;
    }
    let img = null;
    if (mat && mat.imageIndex !== null && mat.imageIndex !== undefined) {
      try { img = scene.decodeMaterialImage(mat.imageIndex); } catch (e) { log("  texture " + nm + ": " + e.message + " - flat colour"); }
    }
    if (img) {
      const w = pot(img.width, o.maxTexture), h = pot(img.height, o.maxTexture);
      if (w !== img.width || h !== img.height) img = resample(img, w, h);
      const masked = isMasked(mat) && !!img.alpha;
      const rec = addRgbTexture(pkg, refs, nm, { width: img.width, height: img.height, rgb: img.rgb, alpha: masked ? img.alpha : undefined }, o.texGain, { wrap: true, masked, twoSided: two });
      matRef.set(key, rec.texRef); textured++;
    } else {
      const c = mat ? mat.factor.slice(0, 3).map((v) => Math.round(v * 255)) : [160, 160, 160];
      const rec = addRgbTexture(pkg, refs, nm, flatColor(c), o.texGain, { wrap: true, twoSided: two });
      matRef.set(key, rec.texRef); flat++;
    }
  }
  log("textures: " + textured + " image(s), " + flat + " flat colour(s)");
  for (const m of meshBuild.meshes) m.materials = [matRef.get(m.mat + "|" + (m.bucket || ""))];

  // --- world bounds -------------------------------------------------------------------------------
  const wlo = [Infinity, Infinity, Infinity], whi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshBuild.meshes) for (let k = 0; k < 3; k++) { if (m.origin[k] + m.bbox.min[k] < wlo[k]) wlo[k] = m.origin[k] + m.bbox.min[k]; if (m.origin[k] + m.bbox.max[k] > whi[k]) whi[k] = m.origin[k] + m.bbox.max[k]; }
  const MARGIN = 512;
  const box = { min: wlo.map((v) => v - MARGIN), max: whi.map((v) => v + MARGIN) };
  holder.killZ = wlo[2] - 2000;

  // --- level skeleton -----------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date(t0);
  const stamp = now.getFullYear() + "." + pad(now.getMonth() + 1) + "." + pad(now.getDate()) + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
  const title = o.title || (baseName + " (glTF)");
  const writeCredits = (pr) => { pr.str("Title", title); pr.str("Author", TOOL_NAME); pr.str("Description", stamp); pr.str("DecoTextName", TOOL_URL); pr.int("IdealPlayerCountMin", 1); pr.int("IdealPlayerCountMax", 6); pr.str("ExtraInfo", TOOL_URL); };

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
      pr.float("KillZ", holder.killZ);
      if (holder.starts && holder.starts.length) pr.object("NavigationPointList", holder.starts[0]);
      pr.float("BloomRatio", 1); pr.float("BloomRatioMinimum", 0.2); pr.float("BloomRatioMaximum", 0.5);
      pr.float("BloomContrast", 1); pr.float("BloomBlurMult", 1);
      pr.actorCommon(levelInfoRef, holder.physVolRef, "LevelInfo");
      pr.end();
      return w;
    },
  });

  const hideRef = addRgbTexture(pkg, refs, "InvisibleWorld", { width: 8, height: 8, rgb: Buffer.alloc(8 * 8 * 3), alpha: Buffer.alloc(8 * 8) }, 1, { dxt3: true }).texRef;

  const BUILDER = 256;
  const brushPolysRef = pkg.addExport({ classRef: refs.Polys, name: "BrushPolys", flags: RF.EDITOR_ONLY, serialize: (p) => writePolys(p, boxPolys([-BUILDER, -BUILDER, -BUILDER], [BUILDER, BUILDER, BUILDER]).map((poly, i) => Object.assign(poly, { texture: hideRef, iLink: i }))) });
  const brushModelRef = pkg.addExport({ classRef: refs.Model, name: "BrushModel", flags: RF.EDITOR_ONLY, serialize: (p) => emptyModel(p, brushPolysRef, { rootOutside: 1, linked: 1, numSharedSides: 4, bbox: { min: [-BUILDER, -BUILDER, -BUILDER], max: [BUILDER, BUILDER, BUILDER], valid: 1 } }) });
  const brushRef = pkg.addExport({
    classRef: refs.Brush, name: named("Brush"), flags: ACTOR_ED,
    serialize: (p) => { const w = new Writer(192); writeStateFrame(w, refs.Brush); const pr = p.props(w); pr.actorCommon(levelInfoRef, holder.physVolRef, "Brush"); pr.vector("Location", [0, 0, 0]); pr.object("Brush", brushModelRef); pr.end(); return w; },
  });

  const physVolRef = pkg.addExport({
    classRef: refs.DefaultPhysicsVolume, name: "DefaultPhysicsVolume0", flags: ACTOR,
    serialize: (p) => { const w = new Writer(128); writeStateFrame(w, refs.DefaultPhysicsVolume); const pr = p.props(w); pr.int("Priority", -1000000); pr.actorCommon(levelInfoRef, physVolRef, "DefaultPhysicsVolume"); pr.end(); return w; },
  });
  holder.physVolRef = physVolRef;

  const ambient = Math.max(0, Math.min(255, Math.round(o.ambient * (o.lightScale || 1))));
  const glow = Math.max(0, Math.min(254, Math.round(o.glow * (o.lightScale || 1))));
  // Distance fog, tied to the prop CullDistance so one knob drives both: the fog reaches full opacity a
  // little before the cull distance, so a culled prop is already lost in the fog instead of popping out.
  // bClearToFogColor paints everything past the fog that same colour, which also hides the skybox seam
  // and the white far-plane. Off when nothing is being culled; fog colour tracks the flat sky so the
  // horizon blends. `o.fog === false` disables it; fogColor/fogStart/fogEnd override the derivation.
  // Fog end: from the prop cull (Source route) or, for a big model map, a bit inside KF's ~20000 far
  // plane so the horizon dissolves into sky instead of clipping to the white backbuffer (a model map can
  // now be up to 30000 wide - past the far plane at the edges).
  const mapHalf = Math.hypot((box.max[0] - box.min[0]) / 2, (box.max[1] - box.min[1]) / 2);
  const bigModel = !o.cullDistance && mapHalf > 15000;   // model map wider than the far plane
  let fogEnd = o.fogEnd;
  if (fogEnd === undefined) fogEnd = o.cullDistance > 0 ? Math.round(o.cullDistance * 0.92) : (bigModel ? 19000 : 0);
  // A model-map fog only veils the last stretch before the far plane (start at 0.8x end) so the scene is
  // not washed out; the cull-paired Source fog keeps its softer 0.5x ramp.
  const fogStart = o.fogStart !== undefined ? o.fogStart : Math.round(fogEnd * (bigModel ? 0.8 : 0.5));
  const fogColor = o.fogColor || [110, 130, 170];
  const fogOn = o.fog !== false && fogEnd > 0;
  const zoneInfoRef = holder.zoneInfoRef = pkg.addExport({
    classRef: refs.ZoneInfo, name: "ZoneInfo0", flags: ACTOR,
    serialize: (p) => {
      const w = new Writer(192); writeStateFrame(w, refs.ZoneInfo); const pr = p.props(w);
      pr.byte("AmbientBrightness", ambient);
      if (fogOn) { pr.bool("bDistanceFog", true); pr.bool("bClearToFogColor", true); pr.color("DistanceFogColor", fogColor); pr.float("DistanceFogStart", fogStart); pr.float("DistanceFogEnd", fogEnd); }
      pr.actorCommon(levelInfoRef, physVolRef, "ZoneInfo", 1, zoneInfoRef); pr.vector("Location", [0, 0, 0]); pr.end(); return w;
    },
  });
  if (fogOn && o.log) o.log("distance fog: " + fogStart + "-" + fogEnd + " uu, colour " + fogColor.join(","));

  const csgBrushes = [];
  {
    const h = [0, 1, 2].map((a) => (box.max[a] - box.min[a]) / 2);
    const at = [0, 1, 2].map((a) => (box.max[a] + box.min[a]) / 2);
    const polysRef = pkg.addExport({ classRef: refs.Polys, name: named("Polys"), flags: RF.EDITOR_ONLY, serialize: (p) => writePolys(p, boxPolys(h.map((v) => -v), h).map((poly, i) => Object.assign(poly, { texture: hideRef, polyFlags: 0x80, iLink: i }))) });
    const modelRef = pkg.addExport({ classRef: refs.Model, name: named("Model"), flags: RF.EDITOR_ONLY, serialize: (p) => emptyModel(p, polysRef, { rootOutside: 1, linked: 1, numSharedSides: 4, bbox: { min: h.map((v) => -v), max: h, valid: 1 } }) });
    csgBrushes.push(pkg.addExport({
      classRef: refs.Brush, name: named("Brush"), flags: ACTOR_ED,
      serialize: (p) => {
        const w = new Writer(256); writeStateFrame(w, refs.Brush); const pr = p.props(w);
        pr.byte("CsgOper", 2); pr.bool("bStatic", true);
        const identity = (ip) => { ip.vector("Scale", [1, 1, 1]); ip.float("SheerRate", 0); ip.byte("SheerAxis", 5); ip.end(); };
        pr.structBlock("MainScale", "Scale", identity); pr.structBlock("PostScale", "Scale", identity);
        pr.actorCommon(levelInfoRef, physVolRef, "Brush", 1, zoneInfoRef); pr.vector("Location", at); pr.object("Brush", modelRef); pr.end();
        return w;
      },
    }));
  }

  const worldPolysRef = pkg.addExport({ classRef: refs.Polys, name: "WorldPolys", flags: RF.GAME, serialize: (p) => emptyPolys(p) });
  const built = {};
  const worldModelRef = pkg.addExport({
    classRef: refs.Model, name: "WorldModel", flags: RF.GAME,
    serialize: (p) => {
      const stub = { faces: [], texinfo: [], entities: [], leafs: [], nodes: [], planes: [], clipnodes: [], markSurfaces: [], surfedges: [], edges: [], vertexes: [], models: [{ mins: [0, 0, 0], maxs: [0, 0, 0], firstface: 0, numfaces: 0 }] };
      const r = buildModel(stub, { scale, lightMapScale: 32, texByMiptex: new Map(), texByRef: new Map(), levelRef: p.names.none, minimalWorld: true, worldBox: box, hideMaterialRef: hideRef, brushEntities: false, polysRef: worldPolysRef, zoneInfoRef });
      built.model = r.model;
      return writeModel(p, r.model);
    },
  });

  // --- mesh actors --------------------------------------------------------------------------------
  const meshActors = [];
  meshBuild.meshes.forEach((mesh, i) => {
    const meshRef = pkg.addExport({ classRef: refs.StaticMesh, name: mapName.replace(/[^A-Za-z0-9_]/g, "") + "_geo" + i, flags: refs.flagsGame, serialize: (p) => buildMeshExport(p, mesh) });
    const instRef = pkg.addExport({ classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame, serialize: (p) => buildMeshInstance(p, mesh) });
    meshActors.push(pkg.addExport({
      classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256); writeStateFrame(w, refs.StaticMeshActor); const pr = p.props(w);
        pr.object("StaticMesh", meshRef); pr.object("StaticMeshInstance", instRef);
        pr.bool("bStatic", true); pr.bool("bStaticLighting", true); pr.byte("AmbientGlow", glow); pr.bool("bWorldGeometry", true);
        pr.bool("bCollideActors", true); pr.bool("bBlockActors", true); pr.bool("bBlockPlayers", true);
        pr.bool("bBlockZeroExtentTraces", true); pr.bool("bBlockNonZeroExtentTraces", true);
        pr.bool("bBlockKarma", !process.env.KF_NO_KARMA);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", mesh.origin); pr.vector("Location", mesh.origin); pr.end();
        return w;
      },
    }));
  });

  // --- static prop instances (Source): one shared StaticMesh per model, an actor per placement -----
  if (o.propMeshes && o.propMeshes.length) {
    // Each model is one or more StaticMesh parts (a big model is split to fit the 16-bit streams).
    const modelParts = o.propMeshes.map((parts, i) => (parts || []).map((pm, j) => {
      pm.materials = pm.materialIndices.map((mi) => matRef.get(mi + "|"));
      const meshRef = pkg.addExport({ classRef: refs.StaticMesh, name: mapName.replace(/[^A-Za-z0-9_]/g, "") + "_prop" + i + "_" + j, flags: refs.flagsGame, serialize: (p) => buildMeshExport(p, pm) });
      const instRef = pkg.addExport({ classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame, serialize: (p) => buildMeshInstance(p, pm) });
      return { meshRef, instRef };
    }));
    let placed = 0, models = 0;
    for (const parts of modelParts) if (parts.length) models++;
    for (const inst of (o.propInstances || [])) {
      const parts = modelParts[inst.model]; if (!parts || !parts.length) continue;
      placed++;
      // A prop the source marked SOLID_NONE (grass, small foliage) is decoration the player walks
      // through - emit it without collision so it does not wall the map off.
      const collide = inst.collide !== false;
      for (const mr of parts) {
        meshActors.push(pkg.addExport({
          classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
          serialize: (p) => {
            const w = new Writer(256); writeStateFrame(w, refs.StaticMeshActor); const pr = p.props(w);
            pr.object("StaticMesh", mr.meshRef); pr.object("StaticMeshInstance", mr.instRef);
            pr.bool("bStatic", true); pr.bool("bStaticLighting", true); pr.byte("AmbientGlow", glow); pr.bool("bWorldGeometry", true);
            pr.bool("bCollideActors", collide); pr.bool("bBlockActors", collide); pr.bool("bBlockPlayers", collide);
            pr.bool("bBlockZeroExtentTraces", collide); pr.bool("bBlockNonZeroExtentTraces", collide);
            pr.bool("bBlockKarma", collide && !process.env.KF_NO_KARMA);
            pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
            pr.vector("ColLocation", inst.location); pr.vector("Location", inst.location);
            pr.rotator("Rotation", inst.rotation);
            if (o.cullDistance > 0) pr.float("CullDistance", o.cullDistance);   // drop far props (perf)
            pr.end();
            return w;
          },
        }));
      }
    }
    log("props: " + models + " model(s) instanced " + placed + " time(s)");
  }

  // --- a plain sky --------------------------------------------------------------------------------
  if (!o.noSky) {
    const SKY = [50, 63, 84];   // daylight blue, pre-divided for the ~2.5x unlit overbright
    const side = 8, rgb = Buffer.alloc(side * side * 3);
    for (let i = 0; i < side * side; i++) { rgb[i * 3] = SKY[0]; rgb[i * 3 + 1] = SKY[1]; rgb[i * 3 + 2] = SKY[2]; }
    const skyTex = addRgbTexture(pkg, refs, "sky_flat", { width: side, height: side, rgb }, 1, {});
    const skyCentre = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2);
    const half = [0, 1, 2].map((a) => (box.max[a] - box.min[a]) / 2);
    // Capped: past ~20000 UU the cube's far corners cross KF's far plane and the renderer drops those
    // cells, showing the white backbuffer. A level wider than that is past the view distance anyway.
    const skyR = Math.min(20000, Math.max(8000, Math.hypot(half[0], half[1]) * 1.4));
    const skySides = {};
    for (const s of ["up", "dn", "lf", "rt", "ft", "bk"]) skySides[s] = { texRef: skyTex.texRef, width: side, height: side };
    // Our axis map is a reflection with reversed winding (like the GoldSrc Y-mirror), so the cube wants
    // the mirrored winding too, or half its faces cull and show the white backbuffer through.
    const sky = buildSkyboxMesh(skyCentre, skyR, skySides, { grid: 4, mirrorY: true });
    const skyMeshRef = pkg.addExport({ classRef: refs.StaticMesh, name: "SkyBox", flags: refs.flagsGame, serialize: (p) => buildMeshExport(p, sky) });
    const skyInstRef = pkg.addExport({ classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame, serialize: (p) => buildMeshInstance(p, sky) });
    meshActors.push(pkg.addExport({
      classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256); writeStateFrame(w, refs.StaticMeshActor); const pr = p.props(w);
        pr.object("StaticMesh", skyMeshRef); pr.object("StaticMeshInstance", skyInstRef);
        pr.bool("bUnlit", true); pr.bool("bStatic", true); pr.bool("bWorldGeometry", true);
        pr.bool("bCollideActors", false); pr.bool("bBlockActors", false); pr.bool("bBlockKarma", false);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", skyCentre); pr.vector("Location", [0, 0, 0]); pr.end();
        return w;
      },
    }));
    log("sky: flat cube, half-size " + Math.round(skyR));
  }

  // --- lights: KHR_lights_punctual -> Engine.Light / Gameplay.Sunlight ----------------------------
  const lightRefs = [];
  if (o.lights !== false) {
    const gain = o.lightGain * (o.lightScale || 1);
    for (const L of scene.lights) {
      const def = L.def;
      const rgb = (def.color || [1, 1, 1]).map((v) => Math.round(v * 255));
      const mx = Math.max(...rgb), mn = Math.min(...rgb);
      const bright = Math.max(1, Math.min(255, Math.round((def.intensity || 100) * gain)));
      if (def.type === "directional") {
        const dir = normSub(scene.applyMat4(L.matrix, [0, 0, -1]), L.pos);
        const dirKF = toKFdir(dir);
        const pitch = Math.round(Math.asin(Math.max(-1, Math.min(1, dirKF[2]))) / (2 * Math.PI) * 65536);
        const yaw = Math.round(Math.atan2(dirKF[1], dirKF[0]) / (2 * Math.PI) * 65536);
        lightRefs.push(pkg.addExport({
          classRef: refs.Sunlight, name: named("Sunlight"), flags: ACTOR,
          serialize: (p) => {
            const w = new Writer(224); writeStateFrame(w, refs.Sunlight); const pr = p.props(w);
            pr.bool("bStatic", true); pr.bool("bActorShadows", true);
            pr.byte("LightBrightness", bright); pr.byte("LightHue", hueOf(rgb, mx, mn)); pr.byte("LightSaturation", satOf(mx, mn)); pr.byte("LightRadius", 255);
            pr.actorCommon(levelInfoRef, physVolRef, "Sunlight", 1, zoneInfoRef);
            pr.rotator("Rotation", [pitch, yaw, 0]);
            pr.vector("Location", [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, whi[2] - 64]);
            pr.end(); return w;
          },
        }));
      } else {
        const radiusUU = def.range ? def.range * scale : 512;
        const lr = Math.max(4, Math.min(255, Math.round(radiusUU / 25) - 1));
        lightRefs.push(pkg.addExport({
          classRef: refs.Light, name: named("Light"), flags: ACTOR,
          serialize: (p) => {
            const w = new Writer(224); writeStateFrame(w, refs.Light); const pr = p.props(w);
            pr.byte("LightBrightness", bright); pr.byte("LightRadius", lr); pr.byte("LightHue", hueOf(rgb, mx, mn)); pr.byte("LightSaturation", satOf(mx, mn));
            pr.actorCommon(levelInfoRef, physVolRef, "Light", 1, zoneInfoRef);
            pr.vector("Location", toKF(L.pos, scale));
            pr.end(); return w;
          },
        }));
      }
    }
    log("lights: " + lightRefs.length + " from KHR_lights_punctual");
  }

  // --- player start -------------------------------------------------------------------------------
  const starts = [];
  if (o.emitPlayerStarts !== false) {
    const at = process.env.KF_SPAWN_AT && process.env.KF_SPAWN_AT.split(",").map(Number);
    // KF_SPAWN_AT overrides; else the map's own spawns (Source entities); else one over the middle.
    let places;
    if (at) places = [{ loc: at.slice(0, 3), yaw: at[3] !== undefined ? Math.round((-at[3] / 360) * 65536) & 0xffff : 0 }];
    else if (o.spawns && o.spawns.length) places = o.spawns;
    else {
      // Drop the synthetic spawn onto the geometry near the middle of the map, so the player lands on a
      // central floor/roof instead of falling from the sky (a fall death) or standing on the single
      // tallest tower. Use the geometry centroid (a POI's mass is often nowhere near its bbox centre);
      // cast down there, and if that column is a gap, sample a grid and take the surface nearest the
      // centroid.
      let gx = 0, gy = 0, gn = 0;
      for (const m of meshBuild.meshes) { gx += m.origin[0]; gy += m.origin[1]; gn++; }
      gx = gn ? gx / gn : (box.min[0] + box.max[0]) / 2; gy = gn ? gy / gn : (box.min[1] + box.max[1]) / 2;
      let pick = null;   // { x, y, z, d2 }
      const consider = (x, y) => { const z = topSurfaceAt(meshBuild.meshes, x, y); if (z === null) return; const d2 = (x - gx) * (x - gx) + (y - gy) * (y - gy); if (!pick || d2 < pick.d2) pick = { x, y, z, d2 }; };
      consider(gx, gy);
      if (!pick) { const N = 9; for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) consider(box.min[0] + (box.max[0] - box.min[0]) * i / N, box.min[1] + (box.max[1] - box.min[1]) * j / N); }
      places = pick ? [{ loc: [pick.x, pick.y, pick.z + 60], yaw: 0 }] : [{ loc: [gx, gy, whi[2] + 60], yaw: 0 }];
      log("spawn: " + (pick ? "on surface at z=" + Math.round(pick.z) + " near centre" : "over centre (no surface found)"));
    }
    for (const pl of places) {
      starts.push(pkg.addExport({
        classRef: refs.PlayerStart, name: named("PlayerStart"), flags: ACTOR,
        serialize: (p) => { const w = new Writer(160); writeStateFrame(w, refs.PlayerStart); const pr = p.props(w); pr.actorCommon(levelInfoRef, physVolRef, "PlayerStart", 1, zoneInfoRef); pr.vector("Location", pl.loc); pr.rotator("Rotation", [0, pl.yaw || 0, 0]); pr.end(); return w; },
      }));
    }
    holder.starts = starts;
    log("player start: " + starts.length + (at ? " (KF_SPAWN_AT)" : (o.spawns && o.spawns.length) ? " (from map entities)" : " (synthetic)"));
  }

  holder.summaryRef = pkg.addExport({ classRef: refs.LevelSummary, name: "LevelSummary", flags: refs.flagsGame, serialize: (p) => { const w = new Writer(256); const pr = p.props(w); writeCredits(pr); pr.end(); return w; } });

  const actors = [levelInfoRef, brushRef, physVolRef, zoneInfoRef, ...csgBrushes, ...starts, ...lightRefs, ...meshActors];
  pkg.addExport({
    classRef: refs.Level, name: "myLevel", flags: RF.GAME,
    serialize: (p) => {
      const w = new Writer(512);
      w.cidx(p.names.none); w.i32(actors.length).i32(actors.length);
      for (const a of actors) w.cidx(a);
      w.fstring("unreal").fstring("").fstring(mapName + ".rom"); w.cidx(0); w.fstring(""); w.i32(7777).i32(1); w.cidx(worldModelRef); w.f32(0).i32(0);
      for (let i = 0; i < 14; i++) w.u8(0);
      return w;
    },
  });

  const buf = pkg.build();
  const out = o.outFile || path.join(o.outDir || (o.file ? path.dirname(o.file) : process.cwd()), mapName + ".rom");
  fs.writeFileSync(out, buf);
  log("wrote " + out + "  " + (buf.length / 1048576).toFixed(2) + " MB in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  return { out, size: buf.length, mapName, meshes: meshBuild.meshes.length, lights: lightRefs.length, stats: st, model: built.model };
}

// Pick a scale so the KF pawn stands about door-height against the model's buildings, whatever unit the
// model was authored in (Sketchfab rips range from metres to a 0.00006 node scale). Method: bucket the
// matrix-applied vertices into a 60x60 XY grid, take the 85th-percentile column height as the typical
// BUILDING height (above the flat ground/grass that dominates the lower percentiles), and scale it to
// ~2.6 pawn heights. Capped so the map still fits inside KF's view distance.
function autoScale(scene) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const pts = [];
  for (const prim of scene.prims) {
    const P = prim.pos.data;
    for (let i = 0; i < prim.pos.count; i++) {
      const w = scene.applyMat4(prim.matrix, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
      pts.push(w);
      for (let k = 0; k < 3; k++) { if (w[k] < lo[k]) lo[k] = w[k]; if (w[k] > hi[k]) hi[k] = w[k]; }
    }
  }
  if (!pts.length) return 1;
  const up = 1;   // glTF is Y-up; the two horizontal axes are 0 and 2
  const extH = Math.max(hi[0] - lo[0], hi[2] - lo[2]) || 1;
  const cell = extH / 60;
  const cells = new Map();
  for (const w of pts) { const k = Math.floor(w[0] / cell) + "," + Math.floor(w[2] / cell); let c = cells.get(k); if (!c) { c = [Infinity, -Infinity]; cells.set(k, c); } if (w[up] < c[0]) c[0] = w[up]; if (w[up] > c[1]) c[1] = w[up]; }
  const hts = [...cells.values()].map((c) => c[1] - c[0]).filter((h) => h > 0).sort((a, b) => a - b);
  const feat = hts.length ? hts[Math.floor(hts.length * 0.85)] : extH / 40;
  // Target: a typical building ~8 pawn heights, so the player reads as a small figure among tall
  // structures (the "player = door height, buildings tower" the maps want). Capped so the map stays
  // within the enlarged sky/fog distance; a very flat POI (Pochinki) hits the cap and stays a bit small.
  let scale = (96 * 8) / (feat || 1);
  const width = extH * scale;
  if (width > 30000) scale *= 30000 / width;
  return scale;
}

// Highest surface Z at world (x,y) across every mesh triangle (barycentric point-in-triangle in XY),
// or null if nothing covers that column. Used to stand a synthetic spawn on the geometry.
function topSurfaceAt(meshes, x, y) {
  let best = -Infinity;
  for (const m of meshes) {
    const o = m.origin, V = m.vertices, I = m.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const A = V[I[t]].pos, B = V[I[t + 1]].pos, C = V[I[t + 2]].pos;
      const ax = A[0] + o[0], ay = A[1] + o[1], bx = B[0] + o[0], by = B[1] + o[1], cx = C[0] + o[0], cy = C[1] + o[1];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-6) continue;
      const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      const wc = 1 - wa - wb;
      if (wa < -0.001 || wb < -0.001 || wc < -0.001) continue;
      const z = wa * (A[2] + o[2]) + wb * (B[2] + o[2]) + wc * (C[2] + o[2]);
      if (z > best) best = z;
    }
  }
  return best === -Infinity ? null : best;
}

function toKFdir(d) { const u = toKF(d, 1); const len = Math.hypot(u[0], u[1], u[2]) || 1; return [u[0] / len, u[1] / len, u[2] / len]; }
function normSub(a, b) { const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; const len = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / len, d[1] / len, d[2] / len]; }

module.exports = { convert, DEFAULTS };
