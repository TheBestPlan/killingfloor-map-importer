// GoldSrc miptex -> embedded UE2.5 UTexture + UPalette.
// P8 is kept: GoldSrc textures are 8-bit palettised and so is Unreal's TEXF_P8, so the pixels go
// across with no recompression and no colour loss. GoldSrc's own 4 mip levels are reused and the
// chain is continued down to 1x1 by point sampling, the same way the compiler built them.
"use strict";

const { Writer } = require("./writer");
const { halveIndexed } = require("../goldsrc/wad");

const TEXF_P8 = 0;

// Unreal object names cannot carry GoldSrc's decoration characters.
function sanitizeName(name) {
  let s = name.replace(/[{}]/g, "M").replace(/^\+/, "Anim").replace(/^-/, "Rnd")
    .replace(/^~/, "Lit").replace(/^!/, "Liq").replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(s)) s = "T_" + s;
  return s;
}

const log2 = (n) => { let b = 0; while ((1 << b) < n) b++; return b; };

// GoldSrc masks on palette index 255; Unreal masks on index 0. Swapping the two indices (and the
// two palette entries with them) preserves every other colour exactly.
function remapForMask(mips, palette) {
  const pal = Buffer.from(palette);
  for (let c = 0; c < 3; c++) { const t = pal[0 * 3 + c]; pal[0 * 3 + c] = pal[255 * 3 + c]; pal[255 * 3 + c] = t; }
  const out = mips.map((m) => {
    const d = Buffer.from(m.data);
    for (let i = 0; i < d.length; i++) { if (d[i] === 255) d[i] = 0; else if (d[i] === 0) d[i] = 255; }
    return { width: m.width, height: m.height, data: d };
  });
  return { mips: out, palette: pal };
}

function buildMipChain(mips) {
  const chain = mips.slice();
  let last = chain[chain.length - 1];
  while (last.width > 1 || last.height > 1) {
    const h = halveIndexed(last.data, last.width, last.height);
    chain.push({ width: h.width, height: h.height, data: h.data });
    last = chain[chain.length - 1];
  }
  return chain;
}

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// GoldSrc texture sides only have to be multiples of 16 — over half of a typical CS map's textures
// are not powers of two (48x128, 128x240, 96x96...). Unreal sizes its texture buffers from
// UBits/VBits, so a non-power-of-two texture makes the renderer run off the end of the mip and
// trash the heap. Nearest-neighbour resampling keeps the image palettised and 1:1 in UV space.
function toPowerOfTwo(mip0, width, height) {
  const pw = nextPow2(width), ph = nextPow2(height);
  if (pw === width && ph === height) return { data: mip0, width, height, resampled: false };
  const out = Buffer.alloc(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / ph));
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / pw));
      out[y * pw + x] = mip0[sy * width + sx];
    }
  }
  return { data: out, width: pw, height: ph, resampled: true };
}

// Push colour outwards into the transparent texels.
//
// GoldSrc marks a cut-out with the last palette entry, which in almost every CS texture is pure
// blue. The alpha channel hides those texels, but their RGB is still blue, and bilinear filtering
// and every mip below the top blend it back in - that is the blue fringe around ladders, fences and
// foliage. Replacing the hidden colour with the average of its visible neighbours (a few passes, so
// it reaches a few texels deep) leaves nothing blue to bleed.
function bleedTransparent(rgb, alpha, w, h) {
  const solid = Buffer.from(alpha);
  // Run to convergence, not for a fixed four passes: a fence is a third cut-out, and four passes
  // reach four texels, so the middle of every gap kept its blue and the mips averaged it back in.
  for (let pass = 0; pass < 64; pass++) {
    const next = Buffer.from(solid);
    let changed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (solid[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!solid[j]) continue;
            r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++;
          }
        }
        if (!n) continue;
        rgb[i * 3] = Math.round(r / n); rgb[i * 3 + 1] = Math.round(g / n); rgb[i * 3 + 2] = Math.round(b / n);
        next[i] = 255;
        changed++;
      }
    }
    solid.set(next);
    if (!changed) break;
  }
  // A level small enough to be all cut-out has no neighbour to take colour from, and that is
  // exactly the level a distant surface samples. Return what the visible texels averaged to so the
  // caller can carry it down the chain.
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (!solid[i]) continue;
    r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; n++;
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
}

// Halve an RGBA level, averaging COLOUR over the visible texels only.
//
// The mip chain for a cut-out texture cannot be built by point-sampling palette indices: pick the
// wrong texel and a whole 2x2 collapses to the cut-out colour, and by 4x1 the entire level is the
// pure blue GoldSrc masks with. Measured on gg_33_mario's `{zaun01` fence: 256x64 hid 38,30,138
// under its transparent texels and 4x1 was 0,0,255 everywhere - visible texels included, because
// the DXT endpoints are fitted across the whole block. That level is what a fence across the field
// samples, which is the blue that clears up as the player walks toward it.
function halveMaskedRgba(src, w, h, fallback) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const rgb = Buffer.alloc(nw * nh * 3), alpha = Buffer.alloc(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, n = 0, seen = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy), i = sy * w + sx;
          seen++;
          if (!src.alpha[i]) continue;
          r += src.rgb[i * 3]; g += src.rgb[i * 3 + 1]; b += src.rgb[i * 3 + 2]; n++;
        }
      }
      const d = y * nw + x;
      const c = n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : fallback || [0, 0, 0];
      rgb[d * 3] = c[0]; rgb[d * 3 + 1] = c[1]; rgb[d * 3 + 2] = c[2];
      // Binary alpha: a cut-out has to stay a cut-out, and half the source texels is the threshold
      // that keeps a fence's slats from dissolving one level at a time.
      alpha[d] = n * 2 >= seen ? 255 : 0;
    }
  }
  return { width: nw, height: nh, rgb, alpha };
}

// Registers a UPalette + UTexture pair in the package. Returns the texture's export ref.
function addTexture(pkg, refs, miptex, opts) {
  const masked = !!(opts && opts.masked);
  const liquid = !!(opts && opts.liquid);
  let mips = miptex.mips, palette = miptex.palette;
  if (masked) ({ mips, palette } = remapForMask(mips, palette));
  const pot = toPowerOfTwo(mips[0].data, miptex.width, miptex.height);
  // If the base mip had to be resampled the stored mips no longer line up, so rebuild the chain.
  const chain = pot.resampled
    ? buildMipChain([{ width: pot.width, height: pot.height, data: pot.data }])
    : buildMipChain(mips);
  const width = pot.width, height = pot.height;
  const name = sanitizeName(miptex.name);

  const palRef = pkg.addExport({
    classRef: refs.Palette, name: name + "Pal", flags: refs.flagsGame,
    serialize: (p) => {
      const w = new Writer(1100);
      w.cidx(p.names.none);
      w.cidx(256);
      for (let i = 0; i < 256; i++) w.u8(palette[i * 3]).u8(palette[i * 3 + 1]).u8(palette[i * 3 + 2]).u8(255);
      return w;
    },
  });

  // DXT3 rather than P8 by default. Every shipped static mesh uses a block-compressed texture, and
  // a palettised one is drawn by the BSP path but comes out as bare wireframe on a static mesh -
  // both in game and in KFEd's textured viewport.
  if (opts && opts.dxt) {
    const dxt = require("./dxt");
    const rgbaOf = (m) => {
      const rgb = Buffer.alloc(m.width * m.height * 3);
      const alpha = Buffer.alloc(m.width * m.height, 255);
      for (let i = 0; i < m.data.length; i++) {
        const c = m.data[i];
        rgb[i * 3] = palette[c * 3]; rgb[i * 3 + 1] = palette[c * 3 + 1]; rgb[i * 3 + 2] = palette[c * 3 + 2];
        if (masked && c === 0) alpha[i] = 0;          // index 0 is the cut-out after remapForMask
      }
      if (masked) bleedTransparent(rgb, alpha, m.width, m.height);
      return { rgb, alpha };
    };
    // EVERY level down to 1x1, including the ones smaller than a DXT block.
    //
    // Dropping the 2x2 and 1x1 levels - "DXT works on 4x4 blocks" - is what produced the white
    // flashes. USize/VSize/UBits/VBits still declare the full size, so the engine computes the mip
    // count as log2(max) + 1 and asks for a level the array does not have; the read runs past the
    // end and the surface is whatever was in that memory, which is mostly 0xFF. The result is the
    // whole world drawn white with a few saturated pixels where real bytes leaked through, and it
    // only shows when the smallest mips are selected - at a distance, or across a shallow angle,
    // which is why it came and went as the view turned. Every shipped texture carries the full
    // chain (KF-Crash: 11 levels for 1024x1024).
    //
    // A sub-block level is stored as one block whose 4x4 is filled by repeating the tiny image.
    const padToBlock = (rgb, alpha, w, h) => {
      if (w >= 4 && h >= 4) return { rgb, alpha, w, h };
      const rgb4 = Buffer.alloc(48), a4 = Buffer.alloc(16);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const s = (Math.min(h - 1, y % h) * w + Math.min(w - 1, x % w));
          const d = y * 4 + x;
          rgb4[d * 3] = rgb[s * 3]; rgb4[d * 3 + 1] = rgb[s * 3 + 1]; rgb4[d * 3 + 2] = rgb[s * 3 + 2];
          a4[d] = alpha[s];
        }
      }
      return { rgb: rgb4, alpha: a4, w: 4, h: 4 };
    };
    // A cut-out texture builds its own chain in RGBA instead of reusing the indexed one: colour has
    // to be averaged over the visible texels only, and the level that is entirely cut out has to
    // inherit a colour rather than invent one.
    const levels = [];
    if (masked) {
      let cur = Object.assign({ width: chain[0].width, height: chain[0].height }, rgbaOf(chain[0]));
      let lastVisible = bleedTransparent(cur.rgb, cur.alpha, cur.width, cur.height);
      levels.push(cur);
      for (let i = 1; i < chain.length; i++) {
        cur = halveMaskedRgba(cur, cur.width, cur.height, lastVisible);
        const avg = bleedTransparent(cur.rgb, cur.alpha, cur.width, cur.height);
        if (avg) lastVisible = avg;
        levels.push(cur);
      }
    } else {
      for (const m of chain) levels.push(Object.assign({ width: m.width, height: m.height }, rgbaOf(m)));
    }
    const blocks = levels.map((m) => {
      const { rgb, alpha } = m;
      // GoldSrc water is a solid texture that the engine draws with a per-entity alpha
      // (func_water's renderamt, typically ~100/255). Bake that into the DXT3 alpha block so the
      // surface reads as water rather than as an opaque blue floor.
      if (liquid) alpha.fill(150);
      const p = padToBlock(rgb, alpha, m.width, m.height);
      // The stored width/height stay the TRUE mip size; only the block content is padded.
      return { width: m.width, height: m.height, data: dxt.encodeDXT3(p.rgb, p.w, p.h, p.alpha) };
    });
    const texRefD = pkg.addExport({
      classRef: refs.Texture, name, flags: refs.flagsGame,
      serialize: (p) => {
        const w = new Writer(1 << 16);
        const pr = p.props(w);
        pr.byte("Format", 7);                          // TEXF_DXT3
        pr.int("USize", width);
        pr.int("VSize", height);
        pr.byte("UBits", log2(width));
        pr.byte("VBits", log2(height));
        pr.int("UClamp", width);
        pr.int("VClamp", height);
        if (masked || liquid) pr.bool("bAlphaTexture", true);
        // Two-sided: only the top plane of each water brush survives (see build/mesh.js), and from
        // under the surface a one-sided plane is culled away - the swimmer looks up at open sky.
        if (liquid) { pr.bool("bTwoSided", true); pr.byte("Style", 3); }   // STY_Translucent
        pr.end();
        w.cidx(blocks.length);
        for (const m of blocks) {
          const rec = w.lazySkip();
          w.cidx(m.data.length).bytes(m.data);
          w.resolveLazy(rec);
          w.i32(m.width).i32(m.height).u8(log2(m.width)).u8(log2(m.height));
        }
        return w;
      },
    });
    return { texRef: texRefD, palRef, name, width, height, origWidth: miptex.width, origHeight: miptex.height, masked };
  }

  const texRef = pkg.addExport({
    classRef: refs.Texture, name, flags: refs.flagsGame,
    serialize: (p) => {
      const w = new Writer(1 << 16);
      const pr = p.props(w);
      pr.byte("Format", TEXF_P8);
      pr.object("Palette", palRef);
      pr.int("USize", width);
      pr.int("VSize", height);
      pr.byte("UBits", log2(width));
      pr.byte("VBits", log2(height));
      pr.int("UClamp", width);
      pr.int("VClamp", height);
      if (masked) pr.bool("bMasked", true);
      pr.end();
      w.cidx(chain.length);
      for (const m of chain) {
        const rec = w.lazySkip();
        w.cidx(m.data.length).bytes(m.data);
        w.resolveLazy(rec);
        w.i32(m.width).i32(m.height).u8(log2(m.width)).u8(log2(m.height));
      }
      return w;
    },
  });

  // origWidth/origHeight are what the GoldSrc texture axes are expressed in; the surface builder
  // rescales the axes by width/origWidth so both the section UVs and the editor's own projection
  // land on the same place.
  return { texRef, palRef, name, width, height, origWidth: miptex.width, origHeight: miptex.height, masked };
}

// A straight RGB image (a skybox side) as an UNCOMPRESSED RGBA8 UTexture.
//
// Not DXT: a block format stores two endpoints per 4x4 block, which is fine for noisy wall
// textures and awful for the smooth gradients a sky is made of - the moon and the clouds came out
// in visible bands. RGBA8 (format 5) is used by 81 of the textures in the shipped KF packages, so
// the engine takes it happily. 512x512x4 = 1 MB a face, 6 MB for the whole cube.
//
// Clamped, and with a FULL mip chain. Clamping is because a sky face is sampled right up to its
// border, so wrapping pulls in the opposite edge and draws a seam along every cube edge. The mip
// chain is not optional: every RGBA8 texture in the shipped packages carries one (KF-Crash's are
// 1024x1024 with 11 levels), and a texture the engine can only sample at level 0 is a texture the
// render device has to keep whole.
function mipChain(px, w, h) {
  const out = [{ width: w, height: h, data: px }];
  let cur = out[0];
  while (cur.width > 1 || cur.height > 1) {
    const nw = Math.max(1, cur.width >> 1), nh = Math.max(1, cur.height >> 1);
    const d = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(cur.width - 1, x * 2), x1 = Math.min(cur.width - 1, x * 2 + 1);
        const y0 = Math.min(cur.height - 1, y * 2), y1 = Math.min(cur.height - 1, y * 2 + 1);
        for (let c = 0; c < 4; c++) {
          d[(y * nw + x) * 4 + c] = (cur.data[(y0 * cur.width + x0) * 4 + c] + cur.data[(y0 * cur.width + x1) * 4 + c] +
            cur.data[(y1 * cur.width + x0) * 4 + c] + cur.data[(y1 * cur.width + x1) * 4 + c] + 2) >> 2;
        }
      }
    }
    cur = { width: nw, height: nh, data: d };
    out.push(cur);
  }
  return out;
}

function addRgbTexture(pkg, refs, name, img, gain, opts) {
  // The engine draws an unlit surface at roughly 2.5x the texture value (UE2 overbright plus KF
  // bloom): measured 233,233,249 on screen for a city1up whose own mean is 94,93,113. Pre-divide,
  // or the overcast grey of Counter-Strike arrives as a white glare.
  const g = gain && gain !== 1 ? gain : 1;
  const px = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    // UE2 stores FColor as B, G, R, A.
    px[i * 4] = Math.min(255, Math.round(img.rgb[i * 3 + 2] * g));
    px[i * 4 + 1] = Math.min(255, Math.round(img.rgb[i * 3 + 1] * g));
    px[i * 4 + 2] = Math.min(255, Math.round(img.rgb[i * 3] * g));
    px[i * 4 + 3] = img.alpha ? img.alpha[i] : 255;
  }
  // DXT1 unless the caller wants the uncompressed original: a sky face is 1.33 MB as RGBA8 at 512
  // and 0.125 MB as DXT1, and the six of them were two thirds of a converted map's bytes. An alpha
  // channel rules it out - DXT1's one bit is not enough for a sprite.
  const dxt1 = !img.alpha && !(opts && opts.raw);
  const texRef = pkg.addExport({
    classRef: refs.Texture, name: sanitizeName(name), flags: refs.flagsGame,
    serialize: (p) => {
      const w = new Writer(img.width * img.height * 6 + 512);
      const pr = p.props(w);
      pr.byte("Format", dxt1 ? 3 : 5);                // TEXF_DXT1 / TEXF_RGBA8
      pr.int("USize", img.width);
      pr.int("VSize", img.height);
      pr.byte("UBits", log2(img.width));
      pr.byte("VBits", log2(img.height));
      pr.int("UClamp", img.width);
      pr.int("VClamp", img.height);
      pr.byte("UClampMode", 1);                      // TC_Clamp
      pr.byte("VClampMode", 1);
      if (img.alpha) pr.bool("bAlphaTexture", true);
      pr.end();
      const chain = mipChain(px, img.width, img.height);
      w.cidx(chain.length);
      for (const m of chain) {
        // The pixels are BGRA in memory; the block encoder wants tight RGB.
        let data = m.data;
        if (dxt1) {
          const dxt = require("./dxt");
          const rgb = Buffer.alloc(m.width * m.height * 3);
          for (let i = 0; i < m.width * m.height; i++) {
            rgb[i * 3] = m.data[i * 4 + 2]; rgb[i * 3 + 1] = m.data[i * 4 + 1]; rgb[i * 3 + 2] = m.data[i * 4];
          }
          if (m.width >= 4 && m.height >= 4) {
            data = dxt.encodeDXT1(rgb, m.width, m.height);
          } else {
            // A level smaller than one block is still stored as one block, filled by repeating the
            // tiny image - the same padding the indexed path does, and the levels below 4x4 are not
            // optional (GOTCHAS 5.33).
            const rgb4 = Buffer.alloc(48);
            for (let y = 0; y < 4; y++) {
              for (let x = 0; x < 4; x++) {
                const s = (Math.min(m.height - 1, y % m.height) * m.width + Math.min(m.width - 1, x % m.width)) * 4;
                const d = (y * 4 + x) * 3;
                rgb4[d] = m.data[s + 2]; rgb4[d + 1] = m.data[s + 1]; rgb4[d + 2] = m.data[s];
              }
            }
            data = dxt.encodeDXT1(rgb4, 4, 4);
          }
        }
        const rec = w.lazySkip();
        w.cidx(data.length).bytes(data);
        w.resolveLazy(rec);
        w.i32(m.width).i32(m.height).u8(log2(m.width)).u8(log2(m.height));
      }
      return w;
    },
  });
  return { texRef, name, width: img.width, height: img.height };
}
module.exports = { addTexture, addRgbTexture, sanitizeName, TEXF_P8 };
