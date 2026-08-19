// End-to-end conversion: one Tactical Ops map -> Killing Floor .rom.
//
// The shortest hop this tool makes. Tactical Ops is Unreal Engine 1 and Killing Floor is Unreal
// Engine 2.5, so the two files are the same container three versions apart: the same compact
// indices, the same tagged properties, the same world axes, the same texel-projected UVs. Nothing is
// mirrored and nothing is re-projected - what changes is that the BSP becomes static meshes (the
// route every other game in this tool takes, and the one KFEd can rebuild) and that UE1's baked
// light, which is a shadow bit per luxel per light, has to be turned back into pixels.
//
// The Killing Floor level skeleton below (LevelInfo, the builder brush, the world box, the zone,
// Level) is the fourth copy of what convert.js writes for GoldSrc, lineage2/convert.js for Lineage 2
// and quake3/convert.js for Quake 3. It stays a copy for the reason given there: those files are the
// flow of one source game around the same twelve actors.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TO = require("./package");
const { readModel, findWorldModel, floorUnder, inSolid, nodePoints, PF } = require("./model");
const { readTexture, addUE1Texture } = require("./texture");
const { buildMeshes } = require("./mesh");
const { buildLightmap } = require("./light");
const { readMovers } = require("./movers");
const { Package, RF } = require("../unreal/package");
const { Writer, writeStateFrame } = require("../unreal/writer");
const { writeModel, emptyModel, emptyPolys } = require("../unreal/model");
const { writePolys, boxPolys, boxBrushModel } = require("../unreal/polys");
const { addRgbTexture, sanitizeName } = require("../unreal/texture");
const { buildMeshExport, buildMeshInstance } = require("../unreal/staticmesh");
const { buildModel } = require("../build/model");
const { tagsOf, pick, val } = require("../lineage2/props");
const { installedTacticalOps } = require("../resources");

const manifest = require("../../package.json");
const TOOL_NAME = manifest.productName;
const TOOL_URL = manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const GAME = "Tactical Ops: Assault on Terror";

const DEFAULTS = {
  // Both engines' own constants bracket this. Floor: a Tactical Ops player is UT99's
  // TournamentPlayer, CollisionRadius 17 and CollisionHeight 39, so 34 x 78 - the tightest passage
  // a mapper may build is 78 tall and KFHumanPawn's 100 has to fit it, 100/78 = 1.2821. At 1.0 the
  // Killing Floor player is simply TALLER than the doorways Tactical Ops built for its own.
  // Ceiling: UE1's Pawn.MaxStepHeight is 25 against UE2.5's MAXSTEPHEIGHT of 35, so 35/25 = 1.4,
  // above which a stair the mapper was allowed to build stops being climbable. The geometric mean
  // sits at equal relative margin from both: sqrt(100/78 * 35/25) = 1.339728.
  //
  // Checked and not binding: Tactical Ops crouches to CrouchHeight 29 (S_Player, s_SWAT.u), so 58
  // units, and a crouched KFHumanPawn's 68 wants only 1.1724. See ../../docs/games/tacticalops.md.
  //
  // Two things no scale fixes. The jump: S_Player raises UT99's JumpZ to 350, which against the
  // same -950 gravity both games use clears 64.5 units, where KF's 325 clears 55.6 - so a Tactical
  // Ops ledge is out of reach here even at 1.0. And the specimen: 52 uu wide against a 34-unit
  // passage wants 1.5294, which is past the step ceiling, so the tightest corridors stay closed to
  // the zeds at every legal scale.
  scale: 1.3397,
  // The zone's ambient lights the pawn and his hands; the actors' glow lights the walls. Same split,
  // and the same reasoning, as the Quake 3 route (GOTCHAS 4.11a).
  ambient: 32,
  glow: 64,
  // How bright the rebuilt light mesh comes out. The arithmetic in light.js is the engine's, but
  // the constant it ends in is not: UE1 finishes the luxel in fixed point through a per-light colour
  // palette, so what comes out here is a relative number. 3.0 is what put TO-Crossfire's lit
  // courtyard and its shadowed arcades where they sit in the game itself.
  lightGain: 3.0,
  // The floor under the atlas: a luxel at 0 multiplies the wall's texture to black and no torch and
  // no muzzle flash can ever reach it (GOTCHAS 4.11b).
  lightFloor: 20,
};

// A UT99 pawn's Location sits 39 above his feet; a KFHumanPawn's sits 50 above his, plus a little
// air so a start snapped to the floor in UnrealEd does not arrive inside it.
const TO_HALF_HEIGHT = 39, KF_HALF_HEIGHT = 50, SPAWN_CLEAR = 4;

// The engine draws an unlit surface at roughly 2.4x its texture (UE2 overbright plus KF bloom), so
// the sky - unlit by definition - is pre-divided or it arrives as white glare.
const SKY_GAIN = 1 / 2.4;

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

// Every actor of a class, with its tagged properties already read.
function actorsOf(pkg, className) {
  const out = [];
  pkg.exports.forEach((e, i) => {
    if (pkg.classOf(e) !== className || e.serialSize <= 0) return;
    let tags;
    try { tags = tagsOf(pkg, e).tags; } catch (err) { return; }
    out.push({ exp: e, ref: i + 1, tags });
  });
  return out;
}

function findMap(clientDir, name) {
  const client = new TO.Client(clientDir);
  const wanted = String(name).replace(/\.unr$/i, "").toLowerCase();
  const file = client.pathOf(wanted);
  if (!file || !/\.unr$/i.test(file)) {
    const have = client.maps().map((m) => m.name).join(", ");
    throw new Error("no map called " + name + " in " + clientDir + (have ? " (have: " + have + ")" : ""));
  }
  return { client, file };
}

function convert(opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  for (const k of Object.keys(DEFAULTS)) if (o[k] === undefined) o[k] = DEFAULTS[k];
  const log = o.log || (() => { });
  const t0 = Date.now();
  const scale = o.scale;

  // Either a loose .unr, or a map name inside an installed client.
  let client = null, file = null, baseName = null;
  const clientDir = o.clientDir || installedTacticalOps()[0] || null;
  if (o.mapFile) {
    file = o.mapFile;
    baseName = path.basename(file).replace(/\.unr$/i, "");
    // The map still needs the client for its textures: a Tactical Ops map holds almost none of its
    // own, and without the .utx packages every surface would be a placeholder.
    client = new TO.Client(clientDir || path.resolve(path.dirname(file), "..", ".."));
  } else {
    if (!clientDir || !o.map) throw new Error("give either a .unr file or --client <folder> --map <name>");
    const found = findMap(clientDir, o.map);
    client = found.client; file = found.file;
    baseName = path.basename(file).replace(/\.unr$/i, "");
  }
  const mapName = o.mapName || ("KF-" + sanitizeName(baseName));

  const pkg = TO.load(file);
  const worldExp = findWorldModel(pkg);
  if (!worldExp) throw new Error(baseName + ": no world Model in the package");
  const model = readModel(pkg, worldExp);
  log("read " + baseName + ".unr (UE1 v" + pkg.header.fileVersion + "): " + model.nodes.length + " nodes, " +
    model.surfs.length + " surfaces, " + model.points.length + " points, " + model.numZones + " zones, " +
    model.lightMap.length + " light meshes (" + Math.round(model.lightBits.length / 1024) + " KB of shadow bits)");

  const guid = crypto.createHash("md5").update(mapName).digest();
  const out = new Package({ guid });
  const refs = {
    Texture: out.importClass("Engine", "Texture"),
    Palette: out.importClass("Engine", "Palette"),
    Shader: out.importClass("Engine", "Shader"),
    ConstantColor: out.importClass("Engine", "ConstantColor"),
    Combiner: out.importClass("Engine", "Combiner"),
    TexCoordSource: out.importClass("Engine", "TexCoordSource"),
    Model: out.importClass("Engine", "Model"),
    Polys: out.importClass("Engine", "Polys"),
    Brush: out.importClass("Engine", "Brush"),
    LevelInfo: out.importClass("Engine", "LevelInfo"),
    LevelSummary: out.importClass("Engine", "LevelSummary"),
    Level: out.importClass("Engine", "Level"),
    DefaultPhysicsVolume: out.importClass("Engine", "DefaultPhysicsVolume"),
    PlayerStart: out.importClass("Engine", "PlayerStart"),
    StaticMesh: out.importClass("Engine", "StaticMesh"),
    StaticMeshActor: out.importClass("Engine", "StaticMeshActor"),
    StaticMeshInstance: out.importClass("Engine", "StaticMeshInstance"),
    ZoneInfo: out.importClass("Engine", "ZoneInfo"),
    PhysicsVolume: out.importClass("Engine", "PhysicsVolume"),
    DoorMover: out.importClass("KFMod", "KFDoorMover"),
    UseTrigger: out.importClass("KFMod", "KFUseTrigger"),
    flagsGame: RF.Public | RF.Standalone | RF.LoadForClient | RF.LoadForServer | RF.LoadForEdit,
  };
  const ACTOR = RF.GAME | RF.HasStack;
  const ACTOR_ED = RF.EDITOR_ONLY | RF.HasStack;
  const holder = {};
  const nameCount = new Map();
  const named = (cls) => { const n = nameCount.get(cls) || 0; nameCount.set(cls, n + 1); return cls + n; };

  // --- the sky room ---------------------------------------------------------------------------
  // UT99 draws its sky by rendering a small room somewhere off the map, seen from the SkyZoneInfo
  // standing in it, through every surface flagged PF_FakeBackdrop. Killing Floor has the same
  // machinery, but only for BSP surfaces - and the world here is static meshes. So the room is
  // lifted out, scaled up until it encloses the level and re-centred on it: the same picture with
  // parallax, which is what the Quake 3 route's cube gives too.
  const skyZoneActor = actorsOf(pkg, "SkyZoneInfo")[0] || null;
  let skyZone = -1;
  if (skyZoneActor) {
    for (let z = 0; z < model.zones.length; z++) if (model.zones[z].zoneActor === skyZoneActor.ref) skyZone = z;
  }
  const inSkyZone = (node) => skyZone >= 0 && (node.iZone[0] === skyZone || node.iZone[1] === skyZone);
  // Which surfaces belong to that room, so their textures can be dimmed: the sky is drawn unlit, and
  // the engine paints an unlit surface at roughly 2.4x its texture (UE2 overbright plus KF bloom),
  // so a sky carried across at face value arrives as white glare.
  const skySurfs = new Set();
  if (skyZone >= 0) for (const node of model.nodes) if (inSkyZone(node)) skySurfs.add(node.iSurf);
  // UT99 paints a sky in layers: an opaque picture with one or two PF_Translucent cloud sheets
  // panning over it (TO-Crossfire's room has three of the four). Nothing here reproduces a panning
  // sheet, and an additive one over the hole a backdrop surface leaves is a white glare - so the
  // overlays are dropped wherever the room has an opaque layer to keep.
  const skyOpaque = [...skySurfs].some((i) => model.surfs[i] && !(model.surfs[i].polyFlags & (PF.Translucent | PF.Modulated | PF.Masked)));
  const skyOverlay = (iSurf, surf) => skyOpaque && skySurfs.has(iSurf) &&
    !!(surf.polyFlags & (PF.Translucent | PF.Modulated | PF.Masked));

  // --- textures -------------------------------------------------------------------------------
  // One Killing Floor texture per (source texture, how the surface draws it): the same wall image
  // is an opaque wall in one place and a cut-out grate in another, and the two need different alpha.
  const texCache = new Map();
  const srcCache = new Map();
  const shaders = new Map();
  const seeThrough = new Set();
  const blendOver = new Map();
  let missingRef = null, missingCount = 0;
  const missingNames = new Set();
  let texturesWritten = 0;

  const readSource = (matRef) => {
    if (srcCache.has(matRef)) return srcCache.get(matRef);
    let src = null;
    const hit = TO.resolveRef(pkg, matRef, client, (cls) => /Texture$/.test(cls));
    if (hit && /Texture$/.test(hit.pkg.classOf(hit.exp))) {
      try {
        let owner = hit.pkg, exp = hit.exp;
        let t = readTexture(owner, exp);
        // Water is not a texture in UE1, it is a program. A `WetTexture` (`FractalTexture` ->
        // `WaterTexture` -> this) computes its pixels every frame by distorting a still image with
        // a wave field, and what it ships on disk is the empty buffer that program writes into -
        // which is why TO-Crossfire's canal came across as a flat khaki slab. `SourceTexture` names
        // the still image, and that is the frame to carry: the ripples are what is lost, not the
        // water. Anything without one (a plain `WaterTexture`, a `FireTexture`) has no still image
        // to fall back on and keeps whatever it stored.
        if (t.sourceTexture && owner.classOf(exp) !== "Texture") {
          const inner = TO.resolveRef(owner, t.sourceTexture, client, (cls) => /Texture$/.test(cls));
          if (inner) {
            const still = readTexture(inner.pkg, inner.exp);
            if (still.width && still.height && still.mips.length) { owner = inner.pkg; exp = inner.exp; t = still; }
          }
        }
        if (t.width && t.height && t.mips.length) src = { tex: t, key: (owner.pkgName || "?") + "." + t.name };
      } catch (e) { src = null; }
    }
    srcCache.set(matRef, src);
    return src;
  };

  const placeholder = () => {
    if (missingRef === null) {
      const side = 8;
      const rgb = Buffer.alloc(side * side * 3);
      for (let i = 0; i < side * side; i++) { rgb[i * 3] = 90; rgb[i * 3 + 1] = 90; rgb[i * 3 + 2] = 96; }
      missingRef = addRgbTexture(out, refs, "MissingTexture", { width: side, height: side, rgb }, 1, { wrap: true }).texRef;
    }
    return { ref: missingRef, origWidth: 64, origHeight: 64, kind: "opaque" };
  };

  // A surface that does not draw plainly gets a Shader: how a material blends is a property of its
  // OUTPUT, and a bare texture has no way to say "cut this out" or "see through this".
  //
  // UE1's own translucency reads the texture's brightness as its opacity, which is closest to
  // OB_Brighten here - but a pale texture then adds itself to a lit floor and burns to white, which
  // is what TO-Crossfire's pool did. A flat opacity through OB_Translucent keeps the pane and the
  // water see-through without ever blowing out; what is lost is the glow on a genuinely additive
  // surface.
  let flatOpacity = 0;
  // `diffuse` is what the surface draws - the texture, or the Combiner that multiplies the map's
  // light into it - and `mask` is always the raw texture, because the cut-out lives in ITS alpha.
  const shaderFor = (diffuse, kind, twoSided, mask) => {
    const key = diffuse + "|" + kind + "|" + (twoSided ? "2" : "1");
    if (shaders.has(key)) return shaders.get(key);
    const blend = kind === "masked" ? 1 : kind === "modulated" ? 2 : 3;   // OB_Masked / OB_Modulate / OB_Translucent
    if (kind === "translucent" && !flatOpacity) {
      flatOpacity = out.addExport({
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
    const ref = out.addExport({
      classRef: refs.Shader, name: (kind === "masked" ? "Masked" : "Blend") + shaders.size, flags: refs.flagsGame,
      serialize: (p) => {
        const w = new Writer(128);
        const pr = p.props(w);
        pr.object("Diffuse", diffuse);
        if (kind === "masked") pr.object("Opacity", mask);
        else if (kind === "translucent") pr.object("Opacity", flatOpacity);
        pr.byte("OutputBlending", blend);
        if (twoSided || kind !== "masked") pr.bool("TwoSided", true);
        pr.end();
        return w;
      },
    });
    shaders.set(key, ref);
    // Every one of these is see-through, cut-outs included: a projector - a bullet decal, the
    // torch's own spot - drawn onto one repaints the whole surface instead of marking it.
    seeThrough.add(ref);
    return ref;
  };

  const materialFor = (material, flags, sky) => {
    const src = readSource(material);
    // Whether a surface is a cut-out is the TEXTURE's answer as much as the surface's. UT99 ORs
    // `UTexture.PolyFlags` - which carries PF_Masked whenever the texture is `bMasked` - into the
    // surface's flags before drawing, and mappers rely on it: the railings on TO-Crossfire's bridge,
    // TO-GlasgowKiss' fire escapes and TO-November-Rain's signs all sit on surfaces WITHOUT
    // PF_Masked, and arrived as solid rectangles of whatever colour palette index 0 happened to be
    // - black, magenta, red.
    const masked = !!(flags & PF.Masked) || !!(src && src.tex.masked);
    // The sky is drawn flat and opaque whatever the room's own surfaces say: it is a backdrop, and
    // a backdrop that blends has nothing behind it to blend with.
    const kind = sky ? "opaque"
      : masked ? "masked" : (flags & PF.Translucent) ? "translucent"
        : (flags & PF.Modulated) ? "modulated" : "opaque";
    const twoSided = !sky && !!(flags & PF.TwoSided);
    const key = material + "|" + kind + "|" + (twoSided ? "2" : "1") + (sky ? "|s" : "");
    if (texCache.has(key)) return texCache.get(key);
    let rec;
    if (!src) {
      missingCount++;
      const { refTarget } = require("../lineage2/props");
      const t = refTarget(pkg, material);
      if (t) missingNames.add((t.pkg || "?") + "." + t.name);
      rec = placeholder();
    } else {
      const baseKey = src.key + "|" + (kind === "masked" ? "m" : "o") + (sky ? "s" : "");
      let base = texCache.get(baseKey);
      if (!base) {
        const added = addUE1Texture(out, refs, src.tex, {
          masked: kind === "masked", gain: sky ? SKY_GAIN : 1,
          name: sanitizeName(src.key.replace(/\./g, "_")) + (kind === "masked" ? "_m" : "") + (sky ? "_sky" : ""),
        });
        base = added ? { ref: added.texRef, origWidth: added.origWidth || src.tex.width, origHeight: added.origHeight || src.tex.height } : null;
        if (!base) base = placeholder();
        texCache.set(baseKey, base);
        if (added) texturesWritten++;
      }
      // An opaque two-sided surface needs no material of its own: mesh.js gives it a second set of
      // triangles wound the other way, which is cheaper than a Shader and cannot blend twice.
      let ref = base.ref;
      if (kind !== "opaque") {
        ref = shaderFor(base.ref, kind, twoSided, base.ref);
        // What the Shader was built over, so the lightmap can be multiplied into its DIFFUSE later
        // rather than wrapped around the finished Shader.
        blendOver.set(ref, { base: base.ref, kind, twoSided });
      }
      rec = { ref, origWidth: base.origWidth, origHeight: base.origHeight, kind };
    }
    texCache.set(key, rec);
    return rec;
  };
  const texOf = (iSurf, surf) => materialFor(surf.material, surf.polyFlags, skySurfs.has(iSurf));

  // --- the map's own light --------------------------------------------------------------------
  const light = o.noLight ? null : buildLightmap(pkg, model, { log, gain: o.lightGain, floor: o.lightFloor });

  // --- geometry -------------------------------------------------------------------------------
  const build = buildMeshes(model, {
    scale, texOf,
    // A fake-backdrop surface is a window onto the sky room, not a wall: carried across it becomes a
    // lid over the level with the sky behind it.
    skip: (i, surf) => !!(surf.polyFlags & PF.FakeBackdrop) || skyOverlay(i, surf),
    zoneOf: (node) => (inSkyZone(node) ? "sky" : null),
    lightUV: light ? light.uvOf : null,
    lightPage: light ? light.pageOf : null,
  });
  const st = build.stats;
  log("mesh: " + st.faces + " node polygons -> " + Math.round(st.triangles) + " triangles in " +
    build.meshes.length + " mesh(es) (" + st.sky + " backdrop cut out, " + st.noMaterial + " without a texture, " +
    st.twoSided + " two-sided doubled, " + st.flat3 + " collinear dropped)");
  log("textures: " + texturesWritten + " written, " + shaders.size + " see-through material(s)");
  if (missingCount) {
    log("textures MISSING for " + missingCount + " surface(s): " + [...missingNames].slice(0, 6).join(" ") +
      (missingNames.size > 6 ? " +" + (missingNames.size - 6) + " more" : ""));
  }

  const worldMeshes = build.meshes.filter((m) => m.tag !== "sky");
  const skyMeshes = o.noSky ? [] : build.meshes.filter((m) => m.tag === "sky");

  // --- the world box --------------------------------------------------------------------------
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of worldMeshes) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.origin[k] + m.bbox.min[k]);
      hi[k] = Math.max(hi[k], m.origin[k] + m.bbox.max[k]);
    }
  }
  if (!Number.isFinite(lo[0])) { lo.fill(-1024); hi.fill(1024); }
  const centre = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const half = [0, 1, 2].map((k) => (hi[k] - lo[k]) / 2);
  const levelRadius = Math.hypot(half[0], half[1], half[2]);
  const skyR = +process.env.KF_SKY_R || Math.max(12000, Math.min(30000, levelRadius * 4));
  const MARGIN = 512;
  const box = {
    min: [0, 1, 2].map((k) => Math.min(lo[k] - MARGIN, skyMeshes.length ? centre[k] - skyR - MARGIN : Infinity)),
    max: [0, 1, 2].map((k) => Math.max(hi[k] + MARGIN, skyMeshes.length ? centre[k] + skyR + MARGIN : -Infinity)),
  };

  // --- the level skeleton ---------------------------------------------------------------------
  const levelInfo = actorsOf(pkg, "LevelInfo")[0];
  const titleTag = levelInfo && pick(levelInfo.tags, "Title");
  const sourceTitle = titleTag ? readString(pkg, titleTag) : null;
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date(t0);
  const stamp = now.getFullYear() + "." + pad(now.getMonth() + 1) + "." + pad(now.getDate()) +
    " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
  const title = (sourceTitle || baseName) + " (" + GAME + ")";
  const writeCredits = (pr) => {
    pr.str("Title", title);
    pr.str("Author", TOOL_NAME);
    pr.str("Description", stamp);
    pr.str("DecoTextName", TOOL_URL);
    pr.int("IdealPlayerCountMin", 1);
    pr.int("IdealPlayerCountMax", 6);
    pr.str("ExtraInfo", TOOL_URL);
  };

  const levelInfoRef = out.addExport({
    classRef: refs.LevelInfo, name: "LevelInfo0", flags: ACTOR,
    serialize: (p) => {
      const w = new Writer(256);
      writeStateFrame(w, refs.LevelInfo);
      const pr = p.props(w);
      pr.float("TimeSeconds", 0);
      writeCredits(pr);
      pr.object("Summary", holder.summaryRef);
      pr.str("DefaultGameType", "KFmod.KFGameType");
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

  // A fully masked-out 8x8 stand-in: the BSP is the level's skeleton and draws nothing.
  const hideRef = addRgbTexture(out, refs, "InvisibleWorld",
    { width: 8, height: 8, rgb: Buffer.alloc(8 * 8 * 3), alpha: Buffer.alloc(8 * 8) }, 1, { dxt3: true }).texRef;

  // The red builder brush the editor validates on load - a plain 256 cube, as every shipped map has.
  const BUILDER = 256;
  const brushPolysRef = out.addExport({
    classRef: refs.Polys, name: "BrushPolys", flags: RF.EDITOR_ONLY,
    serialize: (p) => writePolys(p, boxPolys([-BUILDER, -BUILDER, -BUILDER], [BUILDER, BUILDER, BUILDER])
      .map((poly, i) => Object.assign(poly, { texture: hideRef, iLink: i }))),
  });
  const brushModelRef = out.addExport({
    classRef: refs.Model, name: "BrushModel", flags: RF.EDITOR_ONLY,
    serialize: (p) => emptyModel(p, brushPolysRef, {
      rootOutside: 1, linked: 1, numSharedSides: 4,
      bbox: { min: [-BUILDER, -BUILDER, -BUILDER], max: [BUILDER, BUILDER, BUILDER], valid: 1 },
    }),
  });
  const brushRef = out.addExport({
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

  // The subtract that makes the level a place rather than solid rock.
  const csgBrushes = [];
  {
    const h = [0, 1, 2].map((k) => (box.max[k] - box.min[k]) / 2);
    const at = [0, 1, 2].map((k) => (box.max[k] + box.min[k]) / 2);
    const polysRef = out.addExport({
      classRef: refs.Polys, name: named("Polys"), flags: RF.EDITOR_ONLY,
      serialize: (p) => writePolys(p, boxPolys(h.map((v) => -v), h)
        .map((poly, i) => Object.assign(poly, { texture: hideRef, polyFlags: 0x80, iLink: i }))),
    });
    const modelRef = out.addExport({
      classRef: refs.Model, name: named("Model"), flags: RF.EDITOR_ONLY,
      serialize: (p) => emptyModel(p, polysRef, {
        rootOutside: 1, linked: 1, numSharedSides: 4,
        bbox: { min: h.map((v) => -v), max: h, valid: 1 },
      }),
    });
    csgBrushes.push(out.addExport({
      classRef: refs.Brush, name: named("Brush"), flags: ACTOR_ED,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.Brush);
        const pr = p.props(w);
        pr.byte("CsgOper", 2);                          // CSG_Subtract
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

  const physVolRef = out.addExport({
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

  // The map's own idea of how dark its shadows are: the level's zones carry an AmbientBrightness
  // each, and the level as a whole is lit to the brightest of them.
  let zoneAmbient = 0, zoneHue = null, zoneSat = null;
  for (const cls of ["ZoneInfo", "LevelInfo"]) {
    for (const a of actorsOf(pkg, cls)) {
      const b = pick(a.tags, "AmbientBrightness");
      if (!b) continue;
      const v = val.byte(pkg, b);
      if (v > zoneAmbient) {
        zoneAmbient = v;
        const h = pick(a.tags, "AmbientHue"), s = pick(a.tags, "AmbientSaturation");
        zoneHue = h ? val.byte(pkg, h) : null;
        zoneSat = s ? val.byte(pkg, s) : null;
      }
    }
  }
  const ambient = Math.max(0, Math.min(255, Math.round((o.ambient + zoneAmbient * 0.5) * (o.lightScale || 1))));
  const glow = Math.max(0, Math.min(254, Math.round(o.glow * (o.lightScale || 1))));
  // What a mesh with no lightmap of its own is multiplied by, so it sits in the same room as one
  // that has: the atlas mean, floored so a very dark map still leaves its doors visible. See
  // dimMaterial below for where it is applied and what it fixes.
  const unlitScale = light ? Math.max(0.25, Math.min(1, light.stats.mean / 255)) : 1;
  const zoneInfoRef = holder.zoneInfoRef = out.addExport({
    classRef: refs.ZoneInfo, name: "ZoneInfo0", flags: ACTOR,
    serialize: (p) => {
      const w = new Writer(192);
      writeStateFrame(w, refs.ZoneInfo);
      const pr = p.props(w);
      pr.byte("AmbientBrightness", ambient);
      if (zoneHue !== null) pr.byte("AmbientHue", zoneHue);
      if (zoneSat !== null) pr.byte("AmbientSaturation", zoneSat);
      pr.actorCommon(levelInfoRef, physVolRef, "ZoneInfo", 1, zoneInfoRef);
      pr.vector("Location", [0, 0, 0]);
      pr.end();
      return w;
    },
  });

  // --- the world model ------------------------------------------------------------------------
  // Six inward-facing quads around the level and nothing else: the meshes are the world, and the
  // BSP exists so the renderer has a tree to walk and PointRegion has an answer (GOTCHAS 2.12).
  const worldPolysRef = out.addExport({
    classRef: refs.Polys, name: "WorldPolys", flags: RF.GAME, serialize: (p) => emptyPolys(p),
  });
  const built = {};
  const worldModelRef = out.addExport({
    classRef: refs.Model, name: "WorldModel", flags: RF.GAME,
    serialize: (p) => {
      const stub = {
        faces: [], texinfo: [], entities: [], leafs: [], nodes: [], planes: [], clipnodes: [],
        markSurfaces: [], surfedges: [], edges: [], vertexes: [],
        models: [{ mins: [0, 0, 0], maxs: [0, 0, 0], firstface: 0, numfaces: 0 }],
      };
      const r = buildModel(stub, {
        scale, lightMapScale: 32, texByMiptex: new Map(), texByRef: new Map(), levelRef: p.names.none,
        minimalWorld: true, worldBox: box, hideMaterialRef: hideRef,
        brushEntities: false, polysRef: worldPolysRef, zoneInfoRef,
      });
      built.model = r.model;
      return writeModel(p, r.model);
    },
  });

  // --- the light, as a texture ----------------------------------------------------------------
  const lmCoord = new Map();
  if (light) {
    for (const page of light.pages) {
      const tex = addRgbTexture(out, refs, mapName.replace(/[^A-Za-z0-9_]/g, "") + "_lm" + page.index,
        { width: page.width, height: page.height, rgb: page.rgb }, 1, { raw: true, wrap: false });
      lmCoord.set(page.index, out.addExport({
        classRef: refs.TexCoordSource, name: "LightCoords" + page.index, flags: refs.flagsGame,
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
    log("lightmap: " + light.pages.map((p) => p.width + "x" + p.height).join(" + ") + " (" +
      Math.round(light.stats.fill * 100) + "% full), " + light.stats.surfaces + " light mesh(es) from " +
      light.stats.lights + " light(s), mean luxel " + light.stats.mean.toFixed(1) +
      (light.stats.tooBig ? ", " + light.stats.tooBig + " too big to pack" : ""));
  }

  // One material drawn through another: the map's light over a wall, or the level's average light
  // over a mesh that has none. The alpha comes from the texture so a cut-out survives the multiply.
  const multiply = (name, a, b) => out.addExport({
    classRef: refs.Combiner, name, flags: refs.flagsGame,
    serialize: (p) => {
      const w = new Writer(128);
      const pr = p.props(w);
      pr.object("Material1", a);
      pr.object("Material2", b);
      pr.byte("CombineOperation", 2);                   // CO_Multiply
      pr.byte("AlphaOperation", 3);                     // AO_Use_Alpha_From_Material1
      pr.end();
      return w;
    },
  });

  const combiners = new Map();
  const litMaterial = (texRef, page) => {
    const key = texRef + "@" + page;
    if (combiners.has(key)) return combiners.get(key);
    const coord = lmCoord.get(page);
    if (!coord) return texRef;
    const ref = multiply("Lit" + combiners.size, texRef, coord);
    combiners.set(key, ref);
    return ref;
  };

  // A mesh with no light mesh of its own - every mover, and the handful of world surfaces the BSP
  // left without one - draws its texture at full strength beside a world multiplied by an atlas
  // whose mean is 54 of 255. TO-TerrorMansion's cream door (texture mean 199) came out as a white
  // rectangle with the panel gone.
  //
  // The multiplier has to live in the MATERIAL. ScaleGlow and AmbientGlow were both tried on the
  // actor: ScaleGlow 0.25 changed nothing on screen, and turning the glow down only moves what the
  // engine adds, not what the texture already is. A ConstantColor multiplied in is the atlas the
  // mesh never had.
  let dimColor = 0;
  const dimmed = new Map();
  const dimMaterial = (texRef) => {
    if (unlitScale >= 1) return texRef;
    if (dimmed.has(texRef)) return dimmed.get(texRef);
    if (!dimColor) {
      const v = Math.round(unlitScale * 255);
      dimColor = out.addExport({
        classRef: refs.ConstantColor, name: "UnlitLevel", flags: refs.flagsGame,
        serialize: (p) => {
          const w = new Writer(64);
          const pr = p.props(w);
          pr.color("Color", [v, v, v, 255]);
          pr.end();
          return w;
        },
      });
    }
    const ref = multiply("Unlit" + dimmed.size, texRef, dimColor);
    dimmed.set(texRef, ref);
    return ref;
  };

  // --- mesh actors ----------------------------------------------------------------------------
  const meshActors = [];
  let lowest = Infinity;
  worldMeshes.forEach((mesh, i) => {
    const lit = mesh.lightPage !== undefined && lmCoord.has(mesh.lightPage);
    // Whether the surface is see-through is a property of the material the mesh CAME with: once the
    // light is multiplied in, the mesh carries a Combiner and the Shader underneath it is no longer
    // the thing to ask.
    const seen = seeThrough.has(mesh.materials[0]);
    let mat = mesh.materials[0];
    // The light goes UNDER the Shader, not around it. A Combiner wrapped around a finished Shader
    // is a chain the client will not draw: TO-Blister's fences and TO-TerrorMansion's doors came
    // out as flat white panels, texture and cut-out both gone. Multiplying the atlas into the
    // Shader's Diffuse instead - the order the Quake 3 route already used - draws them properly.
    {
      const under = blendOver.get(mat);
      const base = under ? under.base : mat;
      const diffuse = lit ? litMaterial(base, mesh.lightPage) : dimMaterial(base);
      mat = under ? shaderFor(diffuse, under.kind, under.twoSided, under.base) : diffuse;
    }
    mesh.materials = mesh.materials.map(() => mat);
    if (!lit) mesh.lightPage = undefined;                // no second UV stream without an atlas
    lowest = Math.min(lowest, mesh.origin[2] + mesh.bbox.min[2]);

    const meshRef = out.addExport({
      classRef: refs.StaticMesh, name: mapName.replace(/[^A-Za-z0-9_]/g, "") + "_geo" + i,
      flags: refs.flagsGame,
      serialize: (p) => buildMeshExport(p, mesh),
    });
    const instRef = out.addExport({
      classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame,
      serialize: (p) => buildMeshInstance(p, mesh),
    });
    meshActors.push(out.addExport({
      classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
      serialize: (p) => {
        const w = new Writer(256);
        writeStateFrame(w, refs.StaticMeshActor);
        const pr = p.props(w);
        pr.object("StaticMesh", meshRef);
        pr.object("StaticMeshInstance", instRef);
        pr.bool("bStatic", true);
        pr.bool("bStaticLighting", true);
        // The world's share of the level's light, per actor. A mesh whose surfaces had no light
        // mesh of their own carries no atlas and would otherwise be lit by nothing at all.
        pr.byte("AmbientGlow", lit ? glow : Math.max(glow, 96));
        // A projector - a bullet decal, the torch's own spot - drawn onto a see-through surface
        // repaints the whole surface instead of marking it (GOTCHAS 4.12).
        if (seen) pr.bool("bAcceptsProjectors", false);
        pr.bool("bWorldGeometry", true);
        pr.bool("bCollideActors", true);
        pr.bool("bBlockActors", true);
        pr.bool("bBlockPlayers", true);
        pr.bool("bBlockZeroExtentTraces", true);
        pr.bool("bBlockNonZeroExtentTraces", true);
        pr.bool("bBlockKarma", !process.env.KF_NO_KARMA);
        pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
        pr.vector("ColLocation", mesh.origin);
        pr.vector("Location", mesh.origin);
        pr.end();
        return w;
      },
    }));
  });
  if (Number.isFinite(lowest)) holder.killZ = lowest - 2000;

  // --- the sky room, enlarged ------------------------------------------------------------------
  if (skyMeshes.length) {
    const slo = [Infinity, Infinity, Infinity], shi = [-Infinity, -Infinity, -Infinity];
    for (const m of skyMeshes) {
      for (let k = 0; k < 3; k++) {
        slo[k] = Math.min(slo[k], m.origin[k] + m.bbox.min[k]);
        shi[k] = Math.max(shi[k], m.origin[k] + m.bbox.max[k]);
      }
    }
    const skyCentre = [0, 1, 2].map((k) => (slo[k] + shi[k]) / 2);
    const skyRoom = Math.max(1, Math.hypot(...[0, 1, 2].map((k) => (shi[k] - slo[k]) / 2)));
    const K = skyR / skyRoom;
    skyMeshes.forEach((mesh, i) => {
      // The room is blown up around the level, so the player ends up INSIDE it and sees the walls
      // from the side the mapper meant them to be seen from - the same side mesh.js already winds
      // every node for. Nothing to flip here.
      for (const v of mesh.vertices) v.pos = v.pos.map((c) => c * K);
      mesh.bbox = { min: mesh.bbox.min.map((c) => c * K), max: mesh.bbox.max.map((c) => c * K) };
      mesh.radius *= K;
      // The room's own centre becomes the level's, so the player stands where the SkyZoneInfo did.
      const at = [0, 1, 2].map((k) => centre[k] + (mesh.origin[k] - skyCentre[k]) * K);
      mesh.lightPage = undefined;
      const meshRef = out.addExport({
        classRef: refs.StaticMesh, name: mapName.replace(/[^A-Za-z0-9_]/g, "") + "_sky" + i,
        flags: refs.flagsGame, serialize: (p) => buildMeshExport(p, mesh),
      });
      const instRef = out.addExport({
        classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame,
        serialize: (p) => buildMeshInstance(p, mesh),
      });
      meshActors.push(out.addExport({
        classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(256);
          writeStateFrame(w, refs.StaticMeshActor);
          const pr = p.props(w);
          pr.object("StaticMesh", meshRef);
          pr.object("StaticMeshInstance", instRef);
          pr.bool("bUnlit", true);
          pr.bool("bHiddenEd", true);
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
    });
    const sl = [Infinity, Infinity, Infinity], sh = [-Infinity, -Infinity, -Infinity];
    for (const m of skyMeshes) for (let k = 0; k < 3; k++) {
      sl[k] = Math.min(sl[k], centre[k] + (m.origin[k] - skyCentre[k]) * K + m.bbox.min[k]);
      sh[k] = Math.max(sh[k], centre[k] + (m.origin[k] - skyCentre[k]) * K + m.bbox.max[k]);
    }
    log("sky: the map's own sky room, " + skyMeshes.length + " mesh(es), scaled x" + K.toFixed(1) +
      " to a radius of " + Math.round(skyR) + "; it spans " + sl.map(Math.round).join(",") + " .. " +
      sh.map(Math.round).join(",") + " around a level of " + lo.map(Math.round).join(",") + " .. " + hi.map(Math.round).join(","));
  }

  // --- movers ------------------------------------------------------------------------------------
  // A door that stayed shut would seal a corridor for good, so anything that moves becomes a
  // KFDoorMover with the KFUseTrigger that wakes it - opened with the use key, and weldable, like a
  // native Killing Floor door. Glass panes and the movers that go nowhere stay where they are.
  if (o.movers !== false) {
    const { movers, stats: ms } = readMovers(pkg, { scale, materialFor });
    for (const mv of movers) {
      const mesh = mv.mesh;
      // A mover has no light mesh, so its materials take the same dimming the unlit world meshes do.
      mesh.materials = mesh.materials.map((m) => {
        const under = blendOver.get(m);
        const diffuse = dimMaterial(under ? under.base : m);
        return under ? shaderFor(diffuse, under.kind, under.twoSided, under.base) : diffuse;
      });
      const meshRef = out.addExport({
        classRef: refs.StaticMesh, name: mapName.replace(/[^A-Za-z0-9_]/g, "") + "_" + sanitizeName(mv.name),
        flags: refs.flagsGame, serialize: (p) => buildMeshExport(p, mesh),
      });
      const instRef = out.addExport({
        classRef: refs.StaticMeshInstance, name: named("StaticMeshInstance"), flags: refs.flagsGame,
        serialize: (p) => buildMeshInstance(p, mesh),
      });
      const seen = mesh.materials.some((m) => seeThrough.has(m));
      if (!mv.door) {
        meshActors.push(out.addExport({
          classRef: refs.StaticMeshActor, name: named("StaticMeshActor"), flags: ACTOR,
          serialize: (p) => {
            const w = new Writer(256);
            writeStateFrame(w, refs.StaticMeshActor);
            const pr = p.props(w);
            pr.object("StaticMesh", meshRef);
            pr.object("StaticMeshInstance", instRef);
            pr.bool("bStatic", true);
            pr.bool("bStaticLighting", true);
            pr.byte("AmbientGlow", Math.max(glow, 96));
            if (seen) pr.bool("bAcceptsProjectors", false);
            pr.bool("bWorldGeometry", true);
            pr.bool("bCollideActors", true);
            pr.bool("bBlockActors", true);
            pr.bool("bBlockPlayers", true);
            pr.bool("bBlockZeroExtentTraces", true);
            pr.bool("bBlockNonZeroExtentTraces", true);
            pr.bool("bBlockKarma", !process.env.KF_NO_KARMA);
            pr.actorCommon(levelInfoRef, physVolRef, "StaticMeshActor", 1, zoneInfoRef);
            pr.vector("ColLocation", mesh.origin);
            pr.vector("Location", mesh.origin);
            pr.end();
            return w;
          },
        }));
        continue;
      }
      const hb = [0, 1, 2].map((k) => (mesh.bbox.max[k] - mesh.bbox.min[k]) / 2);
      meshActors.push(out.addExport({
        classRef: refs.UseTrigger, name: named("KFUseTrigger"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(256);
          writeStateFrame(w, refs.UseTrigger);
          const pr = p.props(w);
          pr.nameProp("Event", mv.tag);
          pr.float("CollisionRadius", Math.max(96, Math.hypot(hb[0], hb[1]) + 48));
          pr.float("CollisionHeight", Math.max(64, hb[2] + 24));
          pr.float("MaxWeldStrength", 400);
          pr.bool("bCollideActors", true);
          pr.actorCommon(levelInfoRef, physVolRef, "DoorTrigger", 1, zoneInfoRef);
          pr.vector("ColLocation", mesh.origin);
          pr.vector("Location", mesh.origin);
          pr.end();
          return w;
        },
      }));
      meshActors.push(out.addExport({
        classRef: refs.DoorMover, name: named("KFDoorMover"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(384);
          writeStateFrame(w, refs.DoorMover);
          const pr = p.props(w);
          pr.object("StaticMesh", meshRef);
          pr.object("StaticMeshInstance", instRef);
          pr.byte("DrawType", 8);                         // DT_StaticMesh
          pr.vectorAt("KeyPos", 1, mv.move);
          pr.rotatorAt("KeyRot", 1, mv.turn);
          pr.float("MoveTime", mv.moveTime);
          pr.float("StayOpenTime", 4);
          pr.bool("bDynamicLightMover", false);
          pr.bool("bShadowCast", false);
          pr.bool("bBlockKarma", false);
          pr.byte("AmbientGlow", Math.max(glow, 96));
          if (seen) pr.bool("bAcceptsProjectors", false);
          pr.actorCommon(levelInfoRef, physVolRef, mv.tag, 1, zoneInfoRef);
          pr.vector("BasePos", mesh.origin);
          pr.rotator("BaseRot", [0, 0, 0]);
          pr.vector("ColLocation", mesh.origin);
          pr.vector("Location", mesh.origin);
          pr.end();
          return w;
        },
      }));
    }
    if (movers.length || ms.failed) {
      log("movers: " + movers.length + " read (" + ms.doors + " open with the use key, " + ms.glass +
        " glass, " + (movers.length - ms.doors - ms.glass) + " fixed in place), " +
        Math.round(ms.triangles) + " triangles" + (ms.failed ? ", " + ms.failed + " unreadable" : ""));
    }
  }

  // --- water --------------------------------------------------------------------------------------
  // Tactical Ops marks water the way UE1 does: a BSP zone with a WaterZone actor in it. Zones do not
  // survive the trip to static meshes, so what carries across is a box around the zone's own
  // geometry as a PhysicsVolume - which is what Killing Floor reads to decide the player is
  // swimming, and where the underwater tint comes from.
  //
  // The floor of the box is lifted 46 uu, for the reason the GoldSrc route lifts its own: which
  // volume an actor is in is decided by its centre, a standing KFHumanPawn's is at 50 and every
  // zed's at 44, so a band that thin keeps the player wet and the zeds walking.
  const waterVols = [];
  if (o.water !== false) {
    const WADE = 46, SWIM_MIN = 48;
    const zoneOfActor = new Map();
    for (const cls of ["WaterZone", "ZoneInfo", "SkyZoneInfo"]) {
      for (const a of actorsOf(pkg, cls)) {
        const wet = /Water/i.test(cls) || (pick(a.tags, "bWaterZone") || {}).bool;
        if (!wet) continue;
        for (let z = 0; z < model.zones.length; z++) if (model.zones[z].zoneActor === a.ref) zoneOfActor.set(z, a);
      }
    }
    for (const [z] of zoneOfActor) {
      const lo2 = [Infinity, Infinity, Infinity], hi2 = [-Infinity, -Infinity, -Infinity];
      for (const node of model.nodes) {
        if (node.numVertices < 3 || (node.iZone[0] !== z && node.iZone[1] !== z)) continue;
        for (const p of nodePoints(model, node)) {
          for (let k = 0; k < 3; k++) { lo2[k] = Math.min(lo2[k], p[k] * scale); hi2[k] = Math.max(hi2[k], p[k] * scale); }
        }
      }
      if (!Number.isFinite(lo2[0])) continue;
      const swims = (hi2[2] - lo2[2]) >= WADE + SWIM_MIN;
      const bottom = swims ? lo2[2] + WADE : lo2[2];
      const at = [(lo2[0] + hi2[0]) / 2, (lo2[1] + hi2[1]) / 2, (bottom + hi2[2]) / 2];
      const half = [(hi2[0] - lo2[0]) / 2, (hi2[1] - lo2[1]) / 2, (hi2[2] - bottom) / 2];
      if (half.some((h) => h <= 1)) continue;
      const polysRef = out.addExport({
        classRef: refs.Polys, name: named("Polys"), flags: RF.GAME,
        serialize: (p) => writePolys(p, boxPolys(half.map((v) => -v), half)),
      });
      const modelRef = out.addExport({
        classRef: refs.Model, name: named("Model"), flags: RF.GAME,
        serialize: (p) => writeModel(p, Object.assign(boxBrushModel(half.map((v) => -v), half), { polys: polysRef })),
      });
      waterVols.push(out.addExport({
        classRef: refs.PhysicsVolume, name: named("PhysicsVolume"), flags: ACTOR,
        serialize: (p) => {
          const w = new Writer(320);
          writeStateFrame(w, refs.PhysicsVolume);
          const pr = p.props(w);
          if (swims) {
            pr.bool("bWaterVolume", true);
            pr.float("FluidFriction", 2.4);
            pr.float("TerminalVelocity", 800);
          }
          pr.int("Priority", 100000);                 // must win over DefaultPhysicsVolume
          pr.bool("bDistanceFog", true);
          pr.bool("bNewKFColorCorrection", true);
          pr.color("KFOverlayColor", [40, 90, 130, 0]);
          pr.color("DistanceFogColor", [40, 90, 130, 0]);
          pr.float("DistanceFogStart", 0);
          pr.float("DistanceFogEnd", 6000);
          pr.actorCommon(levelInfoRef, physVolRef, "PhysicsVolume", 1, zoneInfoRef);
          pr.vector("Location", at);
          pr.object("Brush", modelRef);
          pr.end();
          return w;
        },
      }));
    }
    if (waterVols.length) log("water: " + waterVols.length + " zone(s) as PhysicsVolume(s)");
  }

  // --- player starts ---------------------------------------------------------------------------
  const starts = [];
  if (o.emitPlayerStarts !== false) {
    const at = process.env.KF_SPAWN_AT && process.env.KF_SPAWN_AT.split(",").map(Number);
    // Every start the map has, not a sample of them: Tactical Ops places them in pairs of team
    // bases, and taking the first N would put a whole team in one corner of the level.
    const spawns = at ? [{ _at: at.slice(0, 3), _yaw: at[3] }] : actorsOf(pkg, "PlayerStart");
    const wanted = o.spawnLimit ? spawns.slice(0, o.spawnLimit) : spawns;
    let dropped = 0;
    for (const s of wanted) {
      let loc, yaw = 0;
      if (s._at) { loc = s._at; yaw = s._yaw || 0; } else {
        const lt = pick(s.tags, "Location");
        if (!lt) continue;
        const org = val.vector(pkg, lt);
        // A start whose own point is inside solid rock is one the map never used - carried across
        // it spawns the player inside a wall, which is a map that looks broken from the first frame.
        // The pawn's head is checked too, since KF's is 22 units taller than the one this was
        // placed for.
        const head = [org[0], org[1], org[2] + (KF_HALF_HEIGHT - TO_HALF_HEIGHT) + 8];
        if (inSolid(model, org) || inSolid(model, head)) { dropped++; continue; }
        // Stand the pawn on the floor the start was placed over, rather than on the assumption that
        // both games' pawns are the same height above their own feet.
        const ground = floorUnder(model, org, 120);
        const feet = ground === null ? org[2] - TO_HALF_HEIGHT : ground;
        loc = [org[0] * scale, org[1] * scale, feet * scale + KF_HALF_HEIGHT + SPAWN_CLEAR];
        const rt = pick(s.tags, "Rotation");
        yaw = rt ? val.rotator(pkg, rt)[1] & 0xffff : 0;
      }
      starts.push(out.addExport({
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
    log("player starts: " + starts.length + " of the map's " + spawns.length +
      (dropped ? " (" + dropped + " dropped - inside geometry)" : ""));
  }

  holder.summaryRef = out.addExport({
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
  out.addExport({
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

  const buf = out.build();
  const outFile = o.outFile || path.join(o.outDir || path.dirname(file), mapName + ".rom");
  fs.writeFileSync(outFile, buf);
  log("wrote " + outFile + "  " + (buf.length / 1048576).toFixed(2) + " MB in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

  return {
    out: outFile, size: buf.length, mapName, map: baseName,
    stats: build.stats, meshes: worldMeshes.length, skyMeshes: skyMeshes.length,
    lightmapPages: light ? light.pages.length : 0, model: built.model,
  };
}

// A UE1 string property: the same length-prefixed bytes an FString is written as.
function readString(pkg, tag) {
  const { Rd } = require("../unreal/read");
  const r = new Rd(pkg.buf, tag.at);
  const s = r.fstring();
  return s || null;
}

module.exports = { convert, DEFAULTS, GAME };
