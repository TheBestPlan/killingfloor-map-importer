// Quake 3 surfaces -> Killing Floor textures.
//
// A BSP surface names a SHADER; shader.js says which image file that is and how it blends. What is
// left for this module is the pixels: decode the .tga/.jpg, make it a power of two, and hand it to
// the package writer as a DXT texture that TILES (a world surface's UVs run well past 0..1).
"use strict";

const { decode } = require("./image");
const { resample } = require("../build/upscale");
const { addRgbTexture } = require("../unreal/texture");
const { CONTENTS, SURF } = require("./bsp");

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// A visible stand-in for a shader whose image is nowhere in the client: magenta chequer, the same
// thing the GoldSrc route uses for a missing WAD.
function placeholder() {
  const side = 64;
  const rgb = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const on = ((x >> 3) + (y >> 3)) & 1;
      const o = (y * side + x) * 3;
      rgb[o] = on ? 255 : 40; rgb[o + 1] = 0 + (on ? 0 : 40); rgb[o + 2] = on ? 255 : 40;
    }
  }
  return { width: side, height: side, rgb, alpha: null };
}

// Alpha that is only ever 0 or 255 is a cut-out; anything in between is real translucency. A .tga
// whose alpha channel is solid 255 has none at all and would cost four times the bytes for nothing.
function alphaKind(alpha) {
  if (!alpha) return "none";
  let min = 255, max = 0, mid = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a < min) min = a;
    if (a > max) max = a;
    if (a > 8 && a < 247) mid++;
  }
  if (min >= 247) return "none";
  return mid > alpha.length / 64 ? "graded" : "cutout";
}

// Builds one record per BSP texture index:
//   { ref, kind, twoSided, liquid, name, width, height }   or null for something that never draws.
function loadTextures(pkg, refs, bsp, opts) {
  const { gamefs, shaders, log } = opts;
  const maxSize = opts.maxSize || 512;
  const byFile = new Map();                   // resolved image path + flags -> { texRef, ... }
  const out = new Map();
  const stats = { used: 0, images: 0, missing: 0, tool: 0, sky: 0, resampled: 0, cutout: 0, graded: 0, animated: 0, layered: 0, composited: 0, glowed: 0 };
  const missingNames = [];

  const used = new Set();
  for (const f of bsp.faces) used.add(f.texture);

  for (const idx of used) {
    const t = bsp.textures[idx];
    if (!t) continue;
    if (t.tool) { stats.tool++; out.set(idx, null); continue; }
    stats.used++;
    const r = shaders.resolve(t.name, gamefs);
    // Fog volumes and sky are not surfaces this converter draws: the sky is a cube of its own and a
    // fog brush has no picture at all.
    if (r.kind === "sky") { stats.sky++; out.set(idx, { ref: 0, kind: "sky", name: t.name }); continue; }
    if (r.shader && r.shader.params.has("fog")) { out.set(idx, null); continue; }

    const liquid = !!(t.contents & (CONTENTS.WATER | CONTENTS.LAVA | CONTENTS.SLIME));
    let img = null;
    if (r.file) {
      try { img = decode(r.file, gamefs.read(r.file)); }
      catch (e) { if (log) log("texture unreadable: " + r.file + " (" + e.message + ")"); }
    }
    if (!img) { stats.missing++; if (missingNames.length < 12) missingNames.push(t.name); img = placeholder(); }

    // What this image is painted OVER (shader.js `under`): an environment map under a shiny rail, a
    // scrolling electric plate under a broken floor. A UE2.5 surface draws one material, so the two
    // are composited here by the top image's own alpha. Without it the alpha was simply dropped and
    // the see-through part of the surface came out as the top texture's black - which is the hole in
    // pro-q3tourney4's floor reading as a black blob.
    if (r.under && img.alpha) {
      try {
        let u = decode(r.under, gamefs.read(r.under));
        if (u.width !== img.width || u.height !== img.height) u = resample(u, img.width, img.height);
        const rgb = Buffer.alloc(img.width * img.height * 3);
        for (let i = 0, n = img.width * img.height; i < n; i++) {
          const a = img.alpha[i] / 255;
          for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.round(img.rgb[i * 3 + k] * a + u.rgb[i * 3 + k] * (1 - a));
        }
        img = { width: img.width, height: img.height, rgb, alpha: null };
        stats.composited++;
      } catch (e) { /* the backdrop is not on disk; the surface keeps its own image alone */ }
    }

    // ...and the glow stage added over it (shader.js `over`): the bright slime over the flat one,
    // a lamp's `.blend` over its housing, a console's lit screen. Additive, because that is the
    // blendFunc the stage carries, and the picture is a still of what Quake 3 pulses.
    if (r.over) {
      try {
        let g = decode(r.over, gamefs.read(r.over));
        if (g.width !== img.width || g.height !== img.height) g = resample(g, img.width, img.height);
        const rgb = Buffer.alloc(img.width * img.height * 3);
        for (let i = 0; i < img.width * img.height * 3; i++) {
          const v = img.rgb[i] + g.rgb[i];
          rgb[i] = v > 255 ? 255 : v;
        }
        img = { width: img.width, height: img.height, rgb, alpha: img.alpha };
        stats.glowed++;
      } catch (e) { /* the glow is not on disk; the surface keeps its base alone */ }
    }

    let kind = r.kind === "masked" ? "masked" : r.kind === "additive" ? "additive"
      : r.kind === "translucent" ? "translucent" : "normal";
    const ak = alphaKind(img.alpha);
    // The shader is the authority on WHETHER a surface has holes; the image is the authority on
    // whether it has the alpha to make them. A jpg has none, so a shader that alpha-tests one is
    // simply opaque.
    if (kind === "masked" && ak === "none") kind = "normal";
    if (kind === "normal" && ak === "cutout") kind = "masked";
    if (ak === "none") img = { width: img.width, height: img.height, rgb: img.rgb, alpha: null };
    if (kind === "masked") stats.cutout++;
    if (ak === "graded" && kind === "normal") stats.graded++;

    const key = (r.file || "?" + t.name) + "|" + kind + (r.under ? "|" + r.under : "") + (r.over ? "|+" + r.over : "");
    let rec = byFile.get(key);
    if (!rec) {
      let w = Math.min(maxSize, nextPow2(img.width)), h = Math.min(maxSize, nextPow2(img.height));
      if (w !== img.width || h !== img.height) { img = resample(img, w, h); stats.resampled++; }
      const base = "q3_" + t.name.replace(/^textures\//, "").replace(/[^A-Za-z0-9_]/g, "_");
      // Block-compressed by default. `raw` is the diagnostic: it tells a fault in the pixels apart
      // from a fault in the compression, at four times the bytes.
      const wopts = { wrap: true, dxt3: !opts.rawTextures, raw: !!opts.rawTextures };
      // A flipbook: `animMap` names the frames and Killing Floor plays them through AnimNext, one
      // texture per frame with the last pointing back at the first. Without it a torch is a
      // photograph of a flame.
      const frames = r.frames && r.frames.length > 1 ? r.frames : null;
      if (frames) {
        const imgs = [img];
        for (const f of frames.slice(1)) {
          try {
            let im = decode(f, gamefs.read(f));
            if (im.width !== w || im.height !== h) im = resample(im, w, h);
            imgs.push(im);
          } catch (e) { /* a frame the client does not ship just shortens the loop */ }
        }
        const links = imgs.map(() => ({ next: 0 }));
        const fps = r.fps > 0 ? r.fps : 10;
        const refsOut = imgs.map((im, i) => addRgbTexture(pkg, refs, base + "_f" + i, im, 1,
          Object.assign({ anim: { next: () => links[i].next, minFrameRate: fps, maxFrameRate: fps } }, wopts)).texRef);
        refsOut.forEach((_, i) => { links[i].next = refsOut[(i + 1) % refsOut.length]; });
        rec = { texRef: refsOut[0], width: w, height: h };
        stats.images += imgs.length;
        stats.animated++;
      } else {
        const tex = addRgbTexture(pkg, refs, base, img, 1, wopts);
        rec = { texRef: tex.texRef, width: w, height: h };
        stats.images++;
      }
      byFile.set(key, rec);
    }
    // The second layer of a terrain shader, painted over the first by the vertex alpha. It is an
    // ordinary texture here; what makes it a blend is the material and the extra pass the mesh
    // builder emits for it.
    let overlay = null;
    if (r.overlay && opts.terrainLayers !== false) {
      const okey = r.overlay.file + "|overlay";
      overlay = byFile.get(okey);
      if (!overlay) {
        try {
          let oi = decode(r.overlay.file, gamefs.read(r.overlay.file));
          const ow = Math.min(maxSize, nextPow2(oi.width)), oh = Math.min(maxSize, nextPow2(oi.height));
          if (ow !== oi.width || oh !== oi.height) { oi = resample(oi, ow, oh); stats.resampled++; }
          const otex = addRgbTexture(pkg, refs, "q3_" + r.overlay.file.replace(/^textures\//, "").replace(/[^A-Za-z0-9_]/g, "_"),
            oi, 1, { wrap: true, dxt3: !opts.rawTextures, raw: !!opts.rawTextures });
          overlay = { texRef: otex.texRef, width: ow, height: oh, tcScale: r.overlay.tcScale || null };
          byFile.set(okey, overlay);
          stats.images++;
          stats.layered++;
        } catch (e) { overlay = null; }
      }
    }

    out.set(idx, {
      ref: rec.texRef, texRef: rec.texRef, kind, liquid, name: t.name,
      width: rec.width, height: rec.height, overlay,
      // Whether the image itself carries the opacity: a .tga with a graded alpha channel is its own
      // Opacity map, a .jpg has to make do with a flat one.
      graded: ak === "graded",
      // `tcMod scale`, baked into the UVs by the mesh builder.
      tcScale: r.tcScale || null,
      twoSided: r.twoSided || liquid || kind === "masked",
      // Whether the player can walk into it. In Quake 3 collision is a property of the BRUSH, not of
      // the picture on it: `CM_LoadMap` gives a brush the contents of its shader, and a trace only
      // hits what carries CONTENTS_SOLID. A lamp's light beam, a flame sheet and a `nonsolid` grate
      // have none, and the player walks through them there - while Killing Floor takes its collision
      // from the mesh triangles, which is why every beam on mpteam2 was a wall to bump into.
      //
      // Deliberately narrower than "no CONTENTS_SOLID": Quake 3 maps also block with invisible
      // `common/clip` brushes, which q3map emits no drawsurface for and this converter therefore
      // cannot carry, so a fence whose own brush is not solid would become a hole in the level.
      // Only the two cases that are unambiguously an effect are opened up - an explicit `nonsolid`,
      // and a see-through surface whose brush is not solid either.
      nonsolid: !!(t.flags & SURF.NONSOLID) ||
        (!(t.contents & CONTENTS.SOLID) && (kind === "additive" || kind === "translucent")),
      // `deformVertexes autoSprite`: the surface is a camera-facing billboard, not a wall.
      sprite: !!r.sprite,
      // `tcMod scroll` / `tcMod rotate`: the UV animation, carried as a TexPanner / TexRotator.
      scroll: r.scroll || null,
      rotate: r.rotate || 0,
    });
  }

  if (log) {
    log("textures: " + stats.images + " image(s) for " + stats.used + " surface shader(s) (" +
      stats.tool + " tool, " + stats.sky + " sky, " + stats.cutout + " cut-out, " +
      stats.resampled + " resampled to power-of-two" +
      (stats.animated ? ", " + stats.animated + " flipbook" : "") +
      (stats.layered ? ", " + stats.layered + " painted second layer" : "") +
      (stats.composited ? ", " + stats.composited + " composited over a backdrop" : "") +
      (stats.glowed ? ", " + stats.glowed + " with a glow stage added in" : "") +
      (stats.missing ? ", " + stats.missing + " MISSING -> placeholder: " + missingNames.join(" ") : "") + ")");
  }
  return { textures: out, stats };
}

module.exports = { loadTextures };
