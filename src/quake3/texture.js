// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

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

// How a surface uses its image's alpha, from what the SHADER asked for and what the image has.
//
// The shader is the authority on whether a surface has holes; the image is only the authority on
// whether it has the alpha to make them. A .jpg has none, so a shader that alpha-tests one is
// simply opaque - that direction was always right.
//
// The other direction is not, and reading it that way is what put holes in q3dm9's and q3dm15's
// archways. `gothic_door/skull_door_a..f` are .tga files with an alpha channel and no shader of
// their own, and Quake 3 tests an image's alpha only where a shader says to: it draws the whole
// picture and the arch is solid. Cut out from the alpha alone, the arch trim came out with bites
// taken out of its top edge - ten such textures on q3dm9, eight on q3dm15, none at all on q3dm7 or
// q3tourney4, which is exactly the pair of maps the holes were reported on.
function opacityOf(shaderKind, ak) {
  const kind = shaderKind === "masked" ? (ak === "none" ? "normal" : "masked")
    : shaderKind === "additive" ? "additive"
      : shaderKind === "translucent" ? "translucent" : "normal";
  return { kind, keepAlpha: kind !== "normal" && ak !== "none" };
}

// Builds one record per BSP texture index:
//   { ref, kind, twoSided, liquid, name, width, height }   or null for something that never draws.
function loadTextures(pkg, refs, bsp, opts) {
  const { gamefs, shaders, log } = opts;
  const maxSize = opts.maxSize || 512;
  const byFile = new Map();                   // resolved image path + flags -> { texRef, ... }
  const out = new Map();
  const stats = { used: 0, images: 0, missing: 0, tool: 0, sky: 0, resampled: 0, cutout: 0, graded: 0, animated: 0, layered: 0, composited: 0, fog: 0 };
  const missingNames = [];

  const used = new Set();
  for (const f of bsp.faces) used.add(f.texture);

  for (const idx of used) {
    const t = bsp.textures[idx];
    if (!t) continue;
    if (t.tool) { stats.tool++; out.set(idx, null); continue; }
    stats.used++;
    let r = shaders.resolve(t.name, gamefs);
    // Fog volumes and sky are not surfaces this converter draws: the sky is a cube of its own and a
    // fog brush has no picture at all.
    if (r.kind === "sky") { stats.sky++; out.set(idx, { ref: 0, kind: "sky", name: t.name }); continue; }
    // A fog volume with no `fogparms` and no picture is a shape the engine tints through, and it
    // draws nothing at all.
    if (r.shader && r.shader.params.has("fog") && !(r.fog && r.file)) { out.set(idx, null); continue; }

    const liquid = !!(t.contents & (CONTENTS.WATER | CONTENTS.LAVA | CONTENTS.SLIME));
    let img = null;
    if (r.file) {
      try { img = decode(r.file, gamefs.read(r.file)); }
      catch (e) { if (log) log("texture unreadable: " + r.file + " (" + e.message + ")"); }
    }
    if (!img) { stats.missing++; if (missingNames.length < 12) missingNames.push(t.name); img = placeholder(); }

    // The shader's stages, flattened into this one image (shader.js `layers`).
    //
    // Killing Floor draws one material per surface and Quake 3 draws a stack, so the stack is
    // composited here, bottom to top, each layer with the blendFunc its stage carried. Whatever the
    // stack ends up being - a wall over an environment map, a broken plate over a scrolling
    // backdrop, bright slime over flat slime, a jump pad's metal plate with its round hole over a
    // spinning swirl - one stage of it alone is not the surface.
    //
    // The base is layer 0 and it keeps its alpha: whether the SURFACE is see-through was already
    // decided from that same first stage, and a later stage only says how it sits on the ones under
    // it. What is baked here is a still: a stage that pulses or scrolls is drawn at full and at
    // rest, which is as much of it as one material can hold.
    if (r.layers && r.layers.length > 1) {
      try {
        let base = null;
        for (const layer of r.layers) {
          let im = decode(layer.file, gamefs.read(layer.file));
          if (!base) { base = { width: im.width, height: im.height, rgb: Buffer.from(im.rgb), alpha: im.alpha && Buffer.from(im.alpha) }; continue; }
          if (im.width !== base.width || im.height !== base.height) im = resample(im, base.width, base.height);
          const n = base.width * base.height;
          for (let i = 0; i < n; i++) {
            for (let k = 0; k < 3; k++) {
              const d = base.rgb[i * 3 + k], s = im.rgb[i * 3 + k];
              let v;
              if (layer.blend === "additive") v = d + s;
              else if (layer.blend === "filter") v = (d * s) / 255;
              else if (layer.blend === "blend") {
                const a = im.alpha ? im.alpha[i] / 255 : 1;
                v = s * a + d * (1 - a);
              } else v = s;                       // opaque: this stage replaces what is under it
              base.rgb[i * 3 + k] = v > 255 ? 255 : v < 0 ? 0 : Math.round(v);
            }
          }
        }
        if (base && base.rgb !== img.rgb) { img = base; stats.composited++; }
      } catch (e) { /* a stage's image is not on disk; the surface keeps what it already had */ }
    }

    // A fog volume's own surface. Quake 3 renders fog volumetrically - everything seen through the
    // brush is tinted by `fogparms` and goes opaque at its depth - and the pools of death fog at the
    // bottom of q3dm9 and q3dm15 are 864x1124-unit sheets of it. Dropped, they left a hard-edged
    // hole with the room below showing through, which is what the report calls a hole in the mesh.
    //
    // One material cannot be volumetric, so the sheet is what carries it: the shader's own cloud
    // image tinted with the fog colour, drawn nearly opaque because `fogparms` says the fog closes
    // over within 128-256 units and these sheets are the top of a pit.
    if (r.fog) {
      const tint = r.fog.rgb;
      const rgb = Buffer.alloc(img.width * img.height * 3);
      for (let i = 0, n = img.width * img.height; i < n; i++) {
        for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.min(255, Math.round(img.rgb[i * 3 + k] * tint[k]));
      }
      img = { width: img.width, height: img.height, rgb, alpha: Buffer.alloc(img.width * img.height, 210) };
      r = Object.assign({}, r, { kind: "translucent" });
      stats.fog++;
    }

    const ak = alphaKind(img.alpha);
    const op = opacityOf(r.kind, ak);
    const kind = op.kind;
    if (!op.keepAlpha && img.alpha) {
      img = { width: img.width, height: img.height, rgb: img.rgb, alpha: null };
      if (ak !== "none") stats.alphaIgnored = (stats.alphaIgnored || 0) + 1;
    }
    if (kind === "masked") stats.cutout++;

    const key = (r.file || "?" + t.name) + "|" + kind +
      (r.layers && r.layers.length > 1 ? "|" + r.layers.map((l) => l.blend[0] + l.file).join("|") : "");
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
      graded: ak === "graded" && kind !== "normal",
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
      (stats.composited ? ", " + stats.composited + " with their shader stages flattened" : "") +
      (stats.fog ? ", " + stats.fog + " fog sheet(s)" : "") +
      (stats.alphaIgnored ? ", " + stats.alphaIgnored +
        " drawn solid over an alpha channel no shader asks for" : "") +
            (stats.missing ? ", " + stats.missing + " MISSING -> placeholder: " + missingNames.join(" ") : "") + ")");
  }
  return { textures: out, stats };
}

module.exports = { loadTextures, alphaKind, opacityOf };
