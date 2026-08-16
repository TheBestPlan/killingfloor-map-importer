// End-to-end conversion: one Lineage 2 map square -> Killing Floor .rom.
//
// The two games run the same engine five package versions apart, so this front end is small: it
// reads the square, turns its heightfield into meshes, and hands everything to the same writer the
// Counter-Strike route uses. What it does NOT do is re-author the level - the geometry, the UVs and
// the pixels are the client's own.
//
// The Killing Floor level skeleton below (LevelInfo, the builder brush, the world box, the zone,
// Level) is a second copy of what convert.js writes for the GoldSrc route. It stays a copy on
// purpose for now: that file is 2000 lines of GoldSrc-specific flow around the same twelve actors,
// and pulling them out from under a working converter is a change of its own. Third front end and
// they come out into src/kf/.
"use strict";

const fs = require("fs");
const path = require("path");

const { Client } = require("./package");
const { readTerrain } = require("./terrain");
const { buildTerrainMeshes } = require("./terrainmesh");
const { layerMap } = require("./layers");
const { readTexture, followMaterial, materialInfo, alphaMode } = require("./texture");
const { readMesh, toKFMesh, readInstanceColors } = require("./mesh");
const { readBrushes } = require("./brush");
const { buildBrushMeshes } = require("./brushmesh");
const { tagsOf, pick, val, refTarget } = require("./props");
const { Package, RF } = require("../unreal/package");
const { Writer, writeStateFrame } = require("../unreal/writer");
const { writeModel, emptyModel, emptyPolys } = require("../unreal/model");
const { writePolys, boxPolys } = require("../unreal/polys");
const { addRawTexture, addRgbTexture, sanitizeName } = require("../unreal/texture");
const { buildMeshExport, buildMeshInstance } = require("../unreal/staticmesh");
const { buildModel } = require("../build/model");
const { buildSkyboxMesh } = require("../build/skyboxmesh");
const { SIDES } = require("../goldsrc/skybox");

const TOOL_NAME = "killingfloor-map-importer";
const TOOL_URL = "https://github.com/geekrainian/killingfloor-map-importer";
const GAME = "Lineage 2";

const DEFAULTS = {
  scale: 1,                 // both games measure in Unreal units; only the pawn sizes differ
  terrainStep: 1,           // 1 keeps every terrain vertex, 2 halves the grid
  // The zone lights the player and the zeds; the ground takes its own share through AmbientGlow, so
  // one number does not have to serve both (GOTCHAS 4.11a). Judged on 24_13 against 20 and 168: at
  // 20 the mountain is a black cut-out, at 168 the snow is white paper, and 72 is the picture.
  ambient: 32,
  glow: 40,
};
// A flat daylight blue for the sky, in screen values. Lineage 2 has real skies of its own; this is
// the stand-in until they are carried across, and it is a cube rather than nothing because an
// unfilled hole is the previous frame smeared over the screen (GOTCHAS 5.7b).
const FLAT_SKY = [120, 148, 188];
const SKY_GAIN = 1 / 2.4;

// Air around the level, and the ceiling the sky needs. A square is 32768 units across before scale.
const BOX_MARGIN = 4096;
const BOX_HEIGHT = 24000;

// What colour the square's air is, out of its zones' `DistanceFogColor`.
//
// It is the nearest thing a Lineage 2 square has to "what the sky looks like here": the client fogs
// the distance with it, so it is the colour everything far away goes to. A square carries dozens of
// zones - 20_21 has 42 - so the one that wins is the colour the most of them declare, and a zone
// that declares none is not a vote for grey.
function squareAir(pkg) {
  const votes = new Map();
  let zones = 0;
  for (const e of pkg.exports) {
    if (!/ZoneInfo$/.test(pkg.classOf(e)) || !e.serialSize) continue;
    const { tags } = tagsOf(pkg, e);
    const t = pick(tags, "DistanceFogColor");
    if (!t) continue;
    const b = val.bytes(pkg, t);
    const key = b[2] + "," + b[1] + "," + b[0];          // stored B,G,R
    votes.set(key, (votes.get(key) || 0) + 1);
    zones++;
  }
  if (!votes.size) return { colour: null, zones: 0 };
  const best = [...votes].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  return { colour: best, zones };
}

function convert(o) {
  const t0 = Date.now();
  const log = o.log || (() => {});
  const scale = o.scale === undefined ? DEFAULTS.scale : Math.max(0.05, o.scale);
  const step = Math.max(1, Math.round(o.terrainStep || DEFAULTS.terrainStep));

  const client = new Client(o.clientDir);
  const square = String(o.square || "").replace(/\.unr$/i, "");
  const src = client.get(square);
  if (!src) throw new Error("square " + square + " is not in " + o.clientDir);
  log("read " + path.basename(src.file) + ": version " + src.header.fileVersion + "/" +
    src.header.licenseeVersion + ", crypt " + src.crypt + ", " + src.exports.length + " objects");

  const terrain = readTerrain(client, src);
  if (!terrain) throw new Error(square + " has no TerrainInfo");
  const mapName = o.mapName || ("KF-L2-" + sanitizeName(square));

  const pkg = new Package();
  const ACTOR = RF.Transactional | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit | RF.HasStack;
  const ACTOR_ED = RF.Transactional | RF.LoadForEdit | RF.NotForClient | RF.NotForServer | RF.HasStack;
  const refs = {
    Texture: pkg.importClass("Engine", "Texture"),
    // What a surface with an opacity is wrapped in - water, a flame, a grate. Missing from this list
    // it was `undefined`, the export went out with a class reference of 0, and the engine read the
    // object as a CLASS: "Assertion failed: GIsEditor || GetSuperClass()" before the first frame.
    Shader: pkg.importClass("Engine", "Shader"),
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
    flagsGame: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
  };
  const nameCount = new Map();
  const named = (cls) => { const n = nameCount.get(cls) || 0; nameCount.set(cls, n + 1); return cls + n; };
  const holder = {};

  // --- the ground's material ----------------------------------------------------------------------
  // The first painted layer, carried across with its pixels untouched. A terrain is really eight
  // layers blended through alpha maps; this takes the one the map paints first, which is the ground
  // it is mostly made of. The blend is the next piece of work, not a thing to fake with a tint.
  let groundTex = null, groundName = null;
  for (const layer of terrain.layers) {
    if (!layer.texture || !layer.texture.pkg) continue;
    const lp = client.get(layer.texture.pkg);
    if (!lp) continue;
    const exp = lp.exports.find((e) => e.name === layer.texture.name && lp.classOf(e) === "Texture");
    if (!exp) continue;
    try {
      const t = readTexture(lp, exp);
      if (!t.exact || !t.mips.length) continue;
      groundTex = t;
      groundName = layer.texture.pkg + "." + layer.texture.name;
      break;
    } catch (e) { /* try the next layer */ }
  }
  let groundRef;
  if (groundTex) {
    groundRef = addRawTexture(pkg, refs, "l2_" + square + "_ground", groundTex).texRef;
    log("ground texture: " + groundName + " " + groundTex.formatName + " " +
      groundTex.width + "x" + groundTex.height + ", " + groundTex.mips.length + " mip(s), copied as-is");
  } else {
    // Nothing readable to paint with: a flat grey keeps the shape visible instead of failing.
    const side = 8;
    const rgb = Buffer.alloc(side * side * 3, 140);
    groundRef = addRgbTexture(pkg, refs, "l2_" + square + "_flat", { width: side, height: side, rgb }, 1).texRef;
    log("ground texture: none of the " + terrain.layers.length + " layers could be read - flat grey stands in");
  }

  // A fully masked 8x8, so the world box draws nothing. Same trick the GoldSrc route uses.
  const hideRef = addRgbTexture(pkg, refs, "InvisibleWorld", {
    width: 8, height: 8, rgb: Buffer.alloc(8 * 8 * 3), alpha: Buffer.alloc(8 * 8),
  }, 1, { raw: true }).texRef;

  const meshStats = { actors: 0, meshes: 0, textures: 0, masked: 0, blended: 0, frames: 0, triangles: 0, baked: 0, missingMesh: 0, missingTex: 0, failed: 0 };
  // One cache for every texture the square asks for, whatever asks: the brushes and the meshes share
  // packages, and a texture carried twice is megabytes twice.
  const texCache = new Map();                       // "pkg.name" -> { texRef, width, height } | null
  const matCache = new Map();                       // "pkg.name" -> the material a surface gets
  // The texture an AnimNext points at, wherever it lives.
  const frameHit = (from, ref) => {
    const t = refTarget(from, ref);
    if (!t) return null;
    if (t.local) return { pkg: from, exp: t.local };
    const other = t.pkg ? client.get(t.pkg) : null;
    const e = other && other.exports.find((x) => x.name === t.name && other.classOf(x) === "Texture");
    return e ? { pkg: other, exp: e } : null;
  };

  // One texture, carried across once however many surfaces ask for it.
  const carry = (hit, fallbackName) => {
    if (!hit) return null;
    const id = (hit.pkg.pkgName || fallbackName) + "_" + hit.exp.name;
    const key = id.toLowerCase();
    if (texCache.has(key)) return texCache.get(key);
    let out = null;
    try {
      const t = readTexture(hit.pkg, hit.exp);
      if (t.exact && t.mips.length) {
        const alpha = alphaMode(t);
        // A flame is sixteen textures, not one. The frame this is followed by is carried after this
        // one is in the cache, so the last frame's AnimNext finds the first already there and the
        // ring closes instead of recursing for ever.
        const link = { next: 0 };
        out = {
          texRef: addRawTexture(pkg, refs, "l2_" + id.replace(/\./g, "_"), t, {
            alpha: alpha !== "none",
            anim: t.animNext ? { next: () => link.next, minFrameRate: t.minFrameRate, maxFrameRate: t.maxFrameRate } : null,
          }).texRef,
          width: t.width, height: t.height, format: t.format, alpha,
        };
        if (t.animNext) {
          texCache.set(key, out);
          meshStats.textures++;
          const nxt = carry(frameHit(hit.pkg, t.animNext), fallbackName);
          if (nxt) { link.next = nxt.texRef; meshStats.frames++; }
          return out;
        }
      }
    } catch (e) { /* falls through to the missing count */ }
    texCache.set(key, out);
    if (out) meshStats.textures++;
    return out;
  };

  // What a surface is painted with, and how it is blended.
  //
  // Following a material down to one texture is not enough: a Lineage 2 `Shader` with an `Opacity`
  // is a surface you see THROUGH, and drawing it opaque is what put the flames on a black slab and
  // laid an opaque sea over 16_24's terrain. Where the client has an opacity, so does the output -
  // a Killing Floor `Shader` with the same two halves and an OutputBlending that says which kind.
  const resolveMaterial = (target, opts) => {
    if (!target || !target.pkg) return null;
    const key = target.pkg + "." + target.name + (opts && opts.water ? "|water" : "");
    if (matCache.has(key)) return matCache.get(key);
    let out = null;
    const tp = client.get(target.pkg);
    const exp0 = tp && tp.exports.find((e) => e.name === target.name);
    const info = exp0 ? materialInfo(tp, exp0, (n) => client.get(n)) : null;
    const tex = info && carry(info.texture, target.pkg);
    if (tex) {
      // A surface is see-through when the client says so with an Opacity, and ALSO when the texture
      // itself carries a real alpha channel and nothing else says what to do with it - a banner, a
      // leaf, a window in a wall.
      const mask = info.opacity ? carry(info.opacity, target.pkg) : (tex.alpha !== "none" ? tex : null);
      // How it is blended, in this order: what the client says, then what the alpha looks like.
      //
      // The client's own OutputBlending is worth more than any guess from the pixels. A flame is a
      // black picture with no alpha at all, drawn with OB_Brighten so the black adds nothing - read
      // as a texture it has nothing to say, and that is how the torches came out as black slabs
      // (Screenshot_14). Only where the client is silent does the alpha decide: OB_Translucent for
      // a real gradient, OB_Masked for the cut-out that nearly every alpha channel here is.
      const said = info.blending;
      const blending = (opts && opts.water) ? 3
        : said !== undefined && said !== 0 ? said
          : mask ? (mask.alpha === "blend" ? 3 : 1) : 0;
      out = { texRef: tex.texRef, width: tex.width, height: tex.height, blend: "opaque" };
      if (blending) {
        const shaderRef = pkg.addExport({
          classRef: refs.Shader, name: sanitizeName("L2Sh_" + key.replace(/[^A-Za-z0-9_]/g, "_")),
          flags: refs.flagsGame,
          serialize: (p) => {
            const w = new Writer(160);
            const pr = p.props(w);
            pr.object("Diffuse", tex.texRef);
            // OB_Brighten and OB_Modulate take the whole picture; only the cut-out and see-through
            // kinds read an opacity, and handing them one they do not want costs a texture fetch.
            if (mask && (blending === 1 || blending === 3)) pr.object("Opacity", mask.texRef);
            pr.byte("OutputBlending", blending);
            pr.bool("TwoSided", true);
            pr.end();
            return w;
          },
        });
        out = { texRef: shaderRef, width: tex.width, height: tex.height, blend: blending === 1 ? "masked" : "translucent" };
        if (blending === 1) meshStats.masked++; else meshStats.blended++;
      }
    }
    if (!out) meshStats.missingTex++;
    matCache.set(key, out);
    return out;
  };
  const resolveTexture = (target) => resolveMaterial(target);

  // --- the level's box ----------------------------------------------------------------------------
  const lo = terrain.vertex(0, 0), hi = terrain.vertex(terrain.width - 1, terrain.height - 1);
  let zMin = Infinity, zMax = -Infinity;
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const z = terrain.vertex(x, y)[2];
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
  }
  // Everything is emitted around the square's own centre, so the map sits at the origin rather than
  // 150000 units out where Lineage 2 keeps it - the further from the origin, the coarser the float
  // grid the whole level is quantised on.
  const centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0];
  const toKF = (p) => [(p[0] - centre[0]) * scale, (p[1] - centre[1]) * scale, (p[2] - centre[2]) * scale];
  const box = {
    min: [(lo[0] - centre[0] - BOX_MARGIN) * scale, (lo[1] - centre[1] - BOX_MARGIN) * scale, (zMin - centre[2] - BOX_MARGIN) * scale],
    max: [(hi[0] - centre[0] + BOX_MARGIN) * scale, (hi[1] - centre[1] + BOX_MARGIN) * scale, (zMax - centre[2] + BOX_HEIGHT) * scale],
  };

  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date(t0);
  const stamp = now.getFullYear() + "." + pad(now.getMonth() + 1) + "." + pad(now.getDate()) +
    " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
  const writeCredits = (pr) => {
    pr.str("Title", square + " (" + GAME + ")");
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
      pr.float("KillZ", box.min[2] - 1000);
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

  // The subtract that makes the level a place rather than solid rock, and the brush a rebuild in
  // KFEd replays to get it back.
  const csgBrushes = [];
  {
    const half = [0, 1, 2].map((a) => (box.max[a] - box.min[a]) / 2);
    const at = [0, 1, 2].map((a) => (box.max[a] + box.min[a]) / 2);
    const polysRef = pkg.addExport({
      classRef: refs.Polys, name: named("Polys"), flags: RF.GAME,
      serialize: (p) => writePolys(p, boxPolys(half.map((v) => -v), half)
        .map((poly, i) => Object.assign(poly, { texture: hideRef, iLink: i, flags: 0x00000009 }))),
    });
    const modelRef = pkg.addExport({
      classRef: refs.Model, name: named("Model"), flags: RF.GAME,
      serialize: (p) => emptyModel(p, polysRef, {
        rootOutside: 1, linked: 1, numSharedSides: 4,
        bbox: { min: half.map((v) => -v), max: half, valid: 1 },
      }),
    });
    csgBrushes.push(pkg.addExport({
      classRef: refs.Brush, name: named("Brush"), flags: ACTOR_ED,
      serialize: (p) => {
        const w = new Writer(224);
        writeStateFrame(w, refs.Brush);
        const pr = p.props(w);
        pr.byte("CsgOper", 2);                        // CSG_Subtract
        pr.actorCommon(levelInfoRef, holder.physVolRef, "Brush");
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

  const ambient = o.ambient === undefined ? DEFAULTS.ambient : Math.max(0, Math.min(255, Math.round(o.ambient)));
  const glow = o.glow === undefined ? DEFAULTS.glow : Math.max(0, Math.min(254, Math.round(o.glow)));
  const zoneInfoRef = pkg.addExport({
    classRef: refs.ZoneInfo, name: "ZoneInfo0", flags: ACTOR,
    serialize: (p) => {
      const w = new Writer(192);
      writeStateFrame(w, refs.ZoneInfo);
      const pr = p.props(w);
      pr.byte("AmbientBrightness", ambient);
      pr.actorCommon(levelInfoRef, physVolRef, "ZoneInfo", 1, zoneInfoRef);
      pr.vector("Location", [0, 0, box.min[2] + 64]);
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
      // models[0] is only read for a bounding box the writer then throws away (model.js line ~949),
      // so an empty one is honest rather than a fudge.
      const stub = {
        faces: [], texinfo: [], entities: [], leafs: [], nodes: [], planes: [], clipnodes: [],
        markSurfaces: [], surfedges: [], edges: [], vertexes: [],
        models: [{ mins: [0, 0, 0], maxs: [0, 0, 0], firstface: 0, numfaces: 0 }],
      };
      const r = buildModel(stub, {
        scale, lightMapScale: 32, texByMiptex: new Map(), texByRef: new Map(), levelRef: p.names.none,
        minimalWorld: true, worldBox: box, hideMaterialRef: hideRef,
        brushEntities: false, polysRef: worldPolysRef,
      });
      built.model = r.model;
      return writeModel(p, r.model);
    },
  });

  // --- the ground ---------------------------------------------------------------------------------
  // Which layer paints which quad, and what each layer is made of. A layer's UScale is in texture
  // repeats per QUAD, so it goes straight into the UV; where a layer does not set one, a repeat
  // every eight quads reads about right at 128-unit quads.
  const lmap = layerMap(client, src, terrain);
  const layerMat = new Map();
  const materialOf = (i) => {
    if (layerMat.has(i)) return layerMat.get(i);
    const layer = terrain.layers[i];
    const tex = layer && resolveTexture(layer.texture);
    const out = {
      texRef: (tex && tex.texRef) || groundRef,
      uScale: (layer && layer.uScale) || 1 / 8,
      vScale: (layer && layer.vScale) || 1 / 8,
    };
    layerMat.set(i, out);
    return out;
  };
  const terrainMesh = buildTerrainMeshes(terrain, { step, layerAt: (x, y) => lmap.at(x, y), materialOf });
  log("terrain layers: " + lmap.used.length + " of " + terrain.layers.length + " paint anything (" +
    lmap.used.map((i) => (terrain.layers[i].texture ? terrain.layers[i].texture.name : "?")).join(", ") + ")");
  const meshActors = [];
  terrainMesh.meshes.forEach((mesh, i) => {
    // The patch is authored in Lineage 2 units around its own centre; both go through the scale.
    for (const v of mesh.vertices) v.pos = [v.pos[0] * scale, v.pos[1] * scale, v.pos[2] * scale];
    for (const k of ["min", "max"]) mesh.bbox[k] = mesh.bbox[k].map((v) => v * scale);
    mesh.center = mesh.center.map((v) => v * scale);
    mesh.radius *= scale;
    const at = toKF(mesh.origin);
    const meshRef = pkg.addExport({
      classRef: refs.StaticMesh, name: "L2Ground" + i, flags: refs.flagsGame,
      serialize: (p) => buildMeshExport(p, mesh),
    });
    const instRef = pkg.addExport({
      classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame,
      serialize: (p) => buildMeshInstance(p, mesh),
    });
    meshActors.push(pkg.addExport({
      classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.StaticMeshActor);
        const pr = p.props(w);
        pr.object("StaticMesh", meshRef);
        pr.object("StaticMeshInstance", instRef);
        pr.bool("bStatic", true);
        pr.bool("bWorldGeometry", true);
        // Lit, not bUnlit: an unlit surface reads about 2.5x its own texture in this engine
        // (GOTCHAS 5.15) and the ground came out as white glare. The light is the zone's ambient
        // plus this actor's own glow, which is the same split the Counter-Strike route uses - and
        // it leaves the torch and the muzzle flash somewhere to land.
        pr.byte("AmbientGlow", glow);
        pr.bool("bCollideActors", true);
        pr.bool("bBlockActors", true);
        pr.bool("bBlockPlayers", true);
        pr.bool("bBlockZeroExtentTraces", true);
        pr.bool("bBlockNonZeroExtentTraces", true);
        pr.bool("bBlockKarma", true);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", at);
        pr.vector("Location", at);
        pr.end();
        return w;
      },
    }));
  });
  log("terrain: " + terrain.width + "x" + terrain.height + " heightfield, scale " +
    terrain.scale.map((v) => Math.round(v)).join("/") + " -> " + terrainMesh.meshes.length + " mesh(es), " +
    terrainMesh.triangles + " triangles in " + terrainMesh.sections + " section(s)" +
    (step > 1 ? " (every " + step + "th vertex)" : "") +
    (terrainMesh.holes ? ", " + terrainMesh.holes + " patch(es) entirely hidden" : ""));

  // --- what the square is built out of ------------------------------------------------------------
  // A town square is 1900 StaticMeshActors over 47 meshes: the meshes come across once each, the
  // actors are what repeat. Their transform goes through untouched - both engines are left-handed
  // UE2, so Rotation, DrawScale and DrawScale3D mean the same thing on the other side.
  if (!o.noMeshes) {
    const meshCache = new Map();                    // "pkg.name" -> KF mesh ref, or null
    const textureRef = (target) => (resolveTexture(target) || {}).texRef || 0;

    const meshRefOf = (target) => {
      const key = target.pkg + "." + target.name;
      if (meshCache.has(key)) return meshCache.get(key);
      let out = null;
      const src2 = client.get(target.pkg);
      const exp = src2 && src2.exports.find((e) => e.name === target.name && src2.classOf(e) === "StaticMesh");
      if (!exp) meshStats.missingMesh++;
      else {
        try {
          const raw = readMesh(src2, exp);
          // One material ref per section; a section whose texture could not be read keeps the flat
          // grey rather than dropping the geometry, so a hole in the client is visible, not silent.
          const mats = raw.sections.map((_, i) => textureRef((raw.materials[i] || {}).material) || groundRef);
          const kf = toKFMesh(raw, mats, { scale });
          const mRef = pkg.addExport({
            classRef: refs.StaticMesh, name: sanitizeName("L2_" + key.replace(/\./g, "_")), flags: refs.flagsGame,
            serialize: (p) => buildMeshExport(p, kf),
          });
          out = { meshRef: mRef, mesh: kf };
          meshStats.meshes++;
          meshStats.triangles += raw.indices.length / 3;
        } catch (e) { meshStats.failed++; }
      }
      meshCache.set(key, out);
      return out;
    };

    for (const e of src.exports) {
      if (src.classOf(e) !== "StaticMeshActor" || !e.serialSize) continue;
      const { tags } = tagsOf(src, e);
      const smTag = pick(tags, "StaticMesh");
      if (!smTag) continue;
      const target = refTarget(src, val.ref(src, smTag));
      if (!target || !target.pkg) { meshStats.missingMesh++; continue; }
      const hit = meshRefOf(target);
      if (!hit) continue;

      const locTag = pick(tags, "Location");
      const rotTag = pick(tags, "Rotation");
      const dsTag = pick(tags, "DrawScale");
      const ds3Tag = pick(tags, "DrawScale3D");
      const ppTag = pick(tags, "PrePivot");
      const at = toKF(locTag ? val.vector(src, locTag) : [0, 0, 0]);
      const rot = rotTag ? val.rotator(src, rotTag) : null;
      const drawScale = dsTag ? val.float(src, dsTag) : null;
      const ds3 = ds3Tag ? val.vector(src, ds3Tag) : null;
      const pp = ppTag ? val.vector(src, ppTag) : null;

      // One instance per ACTOR, not per mesh: it is per-instance data - where a Build in KFEd writes
      // that actor's own lighting - so two actors sharing an instance would share their light. If
      // the square baked anything into this actor's colours, that is what goes in it.
      const instTag = pick(tags, "StaticMeshInstance");
      const instTarget = instTag ? refTarget(src, val.ref(src, instTag)) : null;
      const baked = instTarget && instTarget.local ? readInstanceColors(src, instTarget.local) : null;
      const instMesh = baked && baked.length === hit.mesh.vertices.length
        ? Object.assign({}, hit.mesh, { colors: baked })
        : hit.mesh;
      if (instMesh !== hit.mesh) meshStats.baked++;
      const instRef = pkg.addExport({
        classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame,
        serialize: (p) => buildMeshInstance(p, instMesh),
      });

      meshActors.push(pkg.addExport({
        classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(288);
          writeStateFrame(w, refs.StaticMeshActor);
          const pr = p.props(w);
          pr.object("StaticMesh", hit.meshRef);
          pr.object("StaticMeshInstance", instRef);
          pr.bool("bStatic", true);
          pr.bool("bWorldGeometry", true);
          pr.byte("AmbientGlow", glow);
          pr.bool("bCollideActors", true);
          pr.bool("bBlockActors", true);
          pr.bool("bBlockPlayers", true);
          pr.bool("bBlockZeroExtentTraces", true);
          pr.bool("bBlockNonZeroExtentTraces", true);
          pr.bool("bBlockKarma", true);
          pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
          if (drawScale !== null && drawScale !== 1) pr.float("DrawScale", drawScale);
          if (ds3) pr.vector("DrawScale3D", ds3);
          if (pp) pr.vector("PrePivot", [pp[0] * scale, pp[1] * scale, pp[2] * scale]);
          pr.vector("ColLocation", at);
          pr.vector("Location", at);
          if (rot) pr.rotator("Rotation", rot);
          pr.end();
          return w;
        },
      }));
      meshStats.actors++;
    }
    log("static meshes: " + meshStats.actors + " actor(s) over " + meshStats.meshes + " mesh(es), " +
      meshStats.triangles + " triangles, " + meshStats.textures + " texture(s)" +
      (meshStats.masked ? ", " + meshStats.masked + " cut out by their alpha" : "") +
      (meshStats.blended ? ", " + meshStats.blended + " blended (see-through, additive)" : "") +
      (meshStats.frames ? ", " + meshStats.frames + " animation frame(s)" : "") +
      (meshStats.baked ? ", " + meshStats.baked + " with the square's own baked vertex light" : "") +
      (meshStats.missingMesh ? ", " + meshStats.missingMesh + " mesh(es) not in this client" : "") +
      (meshStats.failed ? ", " + meshStats.failed + " unreadable" : "") +
      (meshStats.missingTex ? ", " + meshStats.missingTex + " texture(s) missing" : ""));
  }

  // --- the brushes --------------------------------------------------------------------------------
  // The other half of a built-up square. In 16_12 the dungeon under the heightfield is 174 additive
  // brushes: without them its floor does not exist and everything standing on it hangs in the air.
  const brushStats = { add: 0, subtract: 0, polys: 0, meshes: 0, triangles: 0, dropped: 0, unreadable: 0 };
  // Coarse "is there a floor here" map, in Lineage 2 units: the highest brush surface in each cell.
  // The spawn picker needs it - a dungeon under the heightfield is solid ground, but only where the
  // brushes actually are.
  // Where the floors are, and where the sea is.
  //
  // Kept as a list of horizontal polygons with their own extent rather than as a grid of cells: a
  // square's sea is ONE quad a kilometre across, and a cell map only ever hears about its four
  // corners - which is why the first attempt let 16_24 spawn on the sea floor.
  const floors = [], waters = [];
  const spanOf = (poly) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z = -Infinity;
    for (const v of poly.vertices) {
      if (v[0] < x0) x0 = v[0];
      if (v[1] < y0) y0 = v[1];
      if (v[0] > x1) x1 = v[0];
      if (v[1] > y1) y1 = v[1];
      if (v[2] > z) z = v[2];
    }
    return { x0, y0, x1, y1, z };
  };
  // The highest surface of that kind under (or at) this point, or null.
  const surfaceAt = (list, v, ceiling) => {
    let best = null;
    for (const s of list) {
      if (v[0] < s.x0 || v[0] > s.x1 || v[1] < s.y0 || v[1] > s.y1) continue;
      if (ceiling !== undefined && s.z > ceiling) continue;
      if (best === null || s.z > best) best = s.z;
    }
    return best;
  };
  if (!o.noBrushes) {
    const read = readBrushes(src, { solidOnly: false });
    Object.assign(brushStats, read.stats);
    for (const poly of read.polys) {
      // Only surfaces you could stand on or swim under: a wall is neither.
      if (Math.abs(poly.normal[2]) < 0.5) continue;
      const name = (poly.texture && ((poly.texture.pkg || "") + "." + (poly.texture.name || ""))) || "";
      if (/antiportal/i.test(name)) continue;
      if (/water|ocean/i.test(name)) { waters.push(spanOf(poly)); continue; }
      // A polygon with no texture is structural - the underside and sides of the water box, mostly -
      // and it is not drawn, so it is not something to stand on either. Counting it as a floor put
      // 16_24's spawn on the invisible top of its sea.
      if (!poly.texture) continue;
      floors.push(spanOf(poly));
    }
    const built = buildBrushMeshes(read.polys, resolveTexture, { scale });
    brushStats.meshes = built.meshes.length;
    brushStats.triangles = built.triangles;
    brushStats.dropped = built.dropped;
    built.meshes.forEach((mesh) => {
      // Authored in world space, so the actor sits at the level's own origin and the vertices carry
      // the position - the same shape the terrain patches use, one step simpler.
      const at = toKF([centre[0], centre[1], centre[2]]);
      for (const v of mesh.vertices) {
        v.pos = [v.pos[0] - centre[0] * scale, v.pos[1] - centre[1] * scale, v.pos[2] - centre[2] * scale];
      }
      for (const k of ["min", "max"]) mesh.bbox[k] = mesh.bbox[k].map((v, a) => v - centre[a] * scale);
      mesh.center = mesh.center.map((v, a) => v - centre[a] * scale);
      const meshRef = pkg.addExport({
        classRef: refs.StaticMesh, name: sanitizeName("L2Brush_" + mesh.key.replace(/\./g, "_") + "_" + meshActors.length),
        flags: refs.flagsGame,
        serialize: (p) => buildMeshExport(p, mesh),
      });
      const instRef = pkg.addExport({
        classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame,
        serialize: (p) => buildMeshInstance(p, mesh),
      });
      meshActors.push(pkg.addExport({
        classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(256);
          writeStateFrame(w, refs.StaticMeshActor);
          const pr = p.props(w);
          pr.object("StaticMesh", meshRef);
          pr.object("StaticMeshInstance", instRef);
          pr.bool("bStatic", true);
          pr.bool("bWorldGeometry", true);
          // The square's own sky - the haze ring and the cloud plane, twenty thousand units up -
          // is drawn, not lit, and is not something to bump into. Neither is water: in Lineage 2 you
          // swim through it, and a sea with collision is a glass floor over the whole square.
          const solid = !mesh.sky && !mesh.water;
          if (mesh.sky) pr.bool("bUnlit", true); else pr.byte("AmbientGlow", glow);
          pr.bool("bCollideActors", solid);
          pr.bool("bBlockActors", solid);
          pr.bool("bBlockPlayers", solid);
          pr.bool("bBlockZeroExtentTraces", solid);
          pr.bool("bBlockNonZeroExtentTraces", solid);
          pr.bool("bBlockKarma", solid);
          pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
          pr.vector("ColLocation", at);
          pr.vector("Location", at);
          pr.end();
          return w;
        },
      }));
    });
    brushStats.skyMeshes = built.meshes.filter((m) => m.sky).length;
    brushStats.waterMeshes = built.meshes.filter((m) => m.water).length;
    brushStats.antiportal = built.antiportal;
    log("brushes: " + brushStats.add + " additive (" + brushStats.subtract + " subtractive skipped), " +
      brushStats.polys + " polygon(s) -> " + brushStats.meshes + " mesh(es), " + brushStats.triangles + " triangles" +
      (brushStats.skyMeshes ? ", " + brushStats.skyMeshes + " of them the square's own sky" : "") +
      (brushStats.waterMeshes ? ", " + brushStats.waterMeshes + " water (see-through, no collision)" : "") +
      (brushStats.antiportal ? ", " + brushStats.antiportal + " antiportal polygon(s) skipped" : "") +
      (brushStats.dropped ? ", " + brushStats.dropped + " dropped for want of a texture" : "") +
      (brushStats.unreadable ? ", " + brushStats.unreadable + " brush(es) unreadable" : ""));
  }

  // --- the sky ------------------------------------------------------------------------------------
  // A cube just inside the world box, unlit, drawn from the inside. Without one the sky faces of the
  // box show nothing at all, which is not "no sky" but the previous frame smeared over the screen.
  {
    // Flat, and only flat. There is no skybox to carry across: Lineage 2 builds its sky at run time
    // - it turns with the hour and differs by region - and the file says as much, since every
    // `SkyZoneInfo` in the client is the same object, lens flares and pan speeds and not one
    // texture. Putting one of the client's cloud textures on a cube was tried and it is worse than
    // nothing: a 1024x512 painting stretched over six faces reads as slabs of cloud hanging in grey
    // air with the cube's corners showing through (Screenshot_10).
    //
    // What the square does have is the colour it fogs its own distance with, which is the colour
    // everything far away goes to. That is the sky.
    const side = 8;
    const air = squareAir(src);
    const colour = air.colour || FLAT_SKY;
    const rgb = Buffer.alloc(side * side * 3);
    for (let i = 0; i < side * side; i++) rgb.set(colour, i * 3);
    const skyTex = addRgbTexture(pkg, refs, "l2_sky", { width: side, height: side, rgb }, SKY_GAIN).texRef;
    log("sky: flat, " + (air.colour
      ? "in the square's own air colour " + colour.join(",") + " (from " + air.zones + " ZoneInfo(s))"
      : "the standard blue - the square declares no fog colour"));
    const sides = {};
    for (const s of SIDES) sides[s] = { texRef: skyTex, width: side, height: side };
    // Big enough to ENCLOSE the level, which means the half-diagonal and not the smallest side: a
    // cube sized off the shortest axis ends inside the square and the view runs past its edge, and
    // past the edge there is nothing to draw but the last frame (GOTCHAS 5.7b). The ceiling is the
    // renderer's far plane, which starts eating the far corners somewhere above 32000.
    const half = [0, 1, 2].map((a) => (box.max[a] - box.min[a]) / 2);
    const R = Math.max(4096, Math.min(32000, Math.hypot(half[0], half[1]) * 1.08));
    const at = [0, 1, 2].map((a) => (box.max[a] + box.min[a]) / 2);
    const sky = buildSkyboxMesh([0, 0, 0], R, sides);
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
        pr.bool("bHiddenEd", true);                   // it encloses the level; KFEd shows nothing else
        pr.bool("bStatic", true);
        pr.bool("bWorldGeometry", true);
        pr.bool("bCollideActors", false);
        pr.bool("bBlockActors", false);
        pr.bool("bBlockKarma", false);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", at);
        pr.vector("Location", at);
        pr.end();
        return w;
      },
    }));
    log("sky: flat cube, half-size " + Math.round(R));
  }

  // --- spawns -------------------------------------------------------------------------------------
  // On the highest ground in the middle of the square, which is the one place certain to be outside
  // the terrain rather than under it.
  // The square's OWN spawns first. Lineage 2 puts them where a player belongs, which is not always
  // on the terrain: 16_12's town stands two thousand units under its heightfield - confirmed against
  // the TerrainSector bounding boxes, which agree with the height formula to a tenth of a unit - so
  // dropping the player on the ground would put him on a roof of nothing, looking at empty land.
  const starts = [];
  {
    // A spawn is only usable if it stands on something this converter actually built. Lineage 2's
    // own are not always above the heightfield - 16_12's are two thousand units under it, with the
    // town down there on brush geometry that does not come across yet - and a player dropped there
    // falls through the world until KillZ takes him.
    // The HIGHEST of the four corners of the quad the spawn stands on, not the nearest vertex. On a
    // slope the nearest vertex can be a whole quad's drop below the ground under the player's feet -
    // 128 units of it at this terrain scale - and a start set down there starts inside the hill.
    const ground = (v) => {
      const fx = (v[0] - terrain.location[0]) / terrain.scale[0];
      const fy = (v[1] - terrain.location[1]) / terrain.scale[1];
      const ix = Math.floor(fx), iy = Math.floor(fy);
      if (ix < 0 || iy < 0 || ix + 1 >= terrain.width || iy + 1 >= terrain.height) return null;
      return Math.max(
        terrain.vertex(ix, iy)[2], terrain.vertex(ix + 1, iy)[2],
        terrain.vertex(ix, iy + 1)[2], terrain.vertex(ix + 1, iy + 1)[2]);
    };
    // Four piles: on the heightfield, a level below it on brush geometry, buried just under it, and
    // nowhere at all. In that order of preference - a square's own ground-level starts first, its
    // dungeon second, and only then the place a buried start names with the ground put back.
    const own = [], under = [], lifted = [], sunk = [];
    for (const e of src.exports) {
      if (src.classOf(e) !== "PlayerStart" || !e.serialSize) continue;
      const { tags } = tagsOf(src, e);
      const L = pick(tags, "Location");
      if (!L) continue;
      const v = val.vector(src, L);
      // The height stays the client's own. Lineage 2 authored it against the same geometry this
      // converts, and what a player stands on in a town is a static mesh - a brush floor there is
      // often the ground UNDER the building. On 17_20 every start was being set down 212 units onto
      // one of those and arrived below the town, looking up at the underside of it. The surfaces
      // below only ever raise a start that is beneath them, never lower one.
      const floor = surfaceAt(floors, v, v[2] + 64);
      const onBrush = floor !== null && v[2] > floor - 64 && v[2] < floor + 1024;
      const sea = surfaceAt(waters, v);
      // Under the sea with no floor is the seabed, looking up at a ceiling.
      if (!onBrush && sea !== null && v[2] < sea - 16) { sunk.push(v); continue; }
      const g = ground(v);
      if (g !== null && v[2] > g - 32) {
        // Over water, with the seabed for ground. A start above the surface is a start on a pier -
        // 17_22's harbour town stands 74 units over its own sea on static meshes - and it keeps its
        // height. One AT the surface has nothing holding it up: 16_24's only start floats exactly at
        // sea level, and the ground it would settle onto is the seabed, underwater.
        if (sea !== null && g < sea - 16 && v[2] < sea + 16) { sunk.push(v); continue; }
        own.push([v[0], v[1], Math.max(v[2], g)]);
      } else if (onBrush && g !== null && g - v[2] > 1024) {
        // A whole level below the heightfield, standing on brush geometry: a dungeon. 16_12's is
        // two thousand units down and this is the only thing that keeps that square playable. It is
        // still second choice - a square with ground-level starts wants those, not its cellar.
        //
        // The depth is what tells a sub-level from a buried start. All 67 of 17_20's sit 416 units
        // under visible ground with the town standing on top of them: they are not a floor below,
        // they are junk, and a player put there is a player under the map.
        under.push([v[0], v[1], Math.max(v[2], floor)]);
      } else if (g !== null && !(sea !== null && g < sea - 16)) {
        // Buried, but the place it names is a place a player belongs - 17_20's are in the middle of
        // the town. Keep the spot and take the ground it is buried under.
        lifted.push([v[0], v[1], g]);
      } else {
        sunk.push(v);
      }
    }
    let where, from;
    if (own.length || under.length || lifted.length) {
      // Where MOST of the square's starts are is where the square is played. 16_12 has one stray
      // start up on the empty heightfield and twelve down in the dungeon that is the whole map;
      // taking the ground-level one because it is ground level puts the player on bare hillside.
      const piles = [[own, ""], [under, ", all of them a level below the heightfield"],
        [lifted, ", all of them buried and set back on the ground above"]];
      const best = piles.reduce((a, b) => (b[0].length > a[0].length ? b : a));
      const use = best[0], what = best[1];
      const skipped = sunk.length + own.length + under.length + lifted.length - use.length;
      where = use.slice(0, 16).map((v) => toKF(v));
      from = use.length + " of the square's own" + what +
        (skipped ? ", " + skipped + " skipped as under the terrain" : "");
    } else {
      if (sunk.length) {
        log("note: none of the square's " + sunk.length + " spawns stands on anything this built - " +
          "they are under the heightfield, or under the sea with no floor beneath them");
      }
      // The highest dry ground anywhere in the square, not just in the middle: on a coastal square
      // the middle is often the sea floor, and a start there is a start underwater.
      let best = null;
      for (let y = 4; y < terrain.height - 4; y += 2) {
        for (let x = 4; x < terrain.width - 4; x += 2) {
          const p = terrain.vertex(x, y);
          const sea = surfaceAt(waters, p);
          if (sea !== null && p[2] < sea) continue;
          if (!best || p[2] > best[2]) best = p;
        }
      }
      const at = toKF(best || [centre[0], centre[1], zMax]);
      at[2] += 64;
      where = Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return [at[0] + Math.cos(a) * 256, at[1] + Math.sin(a) * 256, at[2]];
      });
      from = "no spawns in the square - the highest ground in the middle";
    }
    for (const loc0 of where) {
      const loc = [loc0[0], loc0[1], loc0[2] + 64];
      starts.push(pkg.addExport({
        classRef: refs.PlayerStart, name: named("PlayerStart"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(160);
          writeStateFrame(w, refs.PlayerStart);
          const pr = p.props(w);
          pr.actorCommon(levelInfoRef, physVolRef, "PlayerStart", 1, zoneInfoRef);
          pr.vector("Location", loc);
          pr.end();
          return w;
        },
      }));
    }
    holder.starts = starts;
    log("player starts: " + starts.length + " (" + from + "), first at " + where[0].map(Math.round).join(","));
  }

  const summaryRef = holder.summaryRef = pkg.addExport({
    classRef: refs.LevelSummary, name: "LevelSummary", flags: refs.flagsGame,
    serialize: (p) => {
      const w = new Writer(256);
      const pr = p.props(w);
      writeCredits(pr);
      pr.end();
      return w;
    },
  });

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
  void summaryRef;

  const buf = pkg.build();
  const out = o.outFile || path.join(o.outDir || path.dirname(src.file), mapName + ".rom");
  fs.writeFileSync(out, buf);
  log("wrote " + out + "  " + (buf.length / 1048576).toFixed(2) + " MB in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

  return {
    out, size: buf.length, mapName, square,
    terrain: { width: terrain.width, height: terrain.height, meshes: terrainMesh.meshes.length, triangles: terrainMesh.triangles },
    model: built.model,
  };
}

module.exports = { convert, DEFAULTS, GAME };
