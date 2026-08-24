// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// The GoldSrc lightmap, carried onto the static meshes.
//
// Everything Counter-Strike shows on a surface - the shadow a building drops on the sand, the pool
// under a lamp, the soft half-tones hlrad computed by bouncing light around the level - is already
// in the .bsp, one luxel per 16 units. None of it survives the trip when a converter re-lights the
// map with Unreal's own lights: a real-time light has no shadows on world geometry and no bounce,
// so the best it can do is a flat wash that has to be tuned by eye, forever.
//
// This module packs those luxels into atlas pages and hands back, per face, the mapping from a
// world position to a texel in that atlas. The mesh builder writes it as a SECOND UV set, and the
// material multiplies the texture by the atlas through `TexCoordSource` reading UV channel 1.
//
// The mapping is not approximated: GoldSrc's own luxel coordinates come straight out of texinfo,
//   s = dot(p, ti.s) + ti.sShift,  luxel x = s / 16 - hl.baseS
// so the light lands exactly where the compiler put it.
"use strict";

const ATLAS = 512;               // page side; the shipped KF lightmap atlases are this size
const BORDER = 1;                // one texel of edge repeat, or bilinear filtering bleeds neighbours

// Shelf packer, same shape as the one the BSP route uses for its own atlases.
class Packer {
  constructor(size) { this.size = size; this.pages = [{ shelfY: 0, shelfH: 0, x: 0 }]; }
  alloc(w, h) {
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (p.x + w <= this.size && p.shelfY + Math.max(p.shelfH, h) <= this.size) {
        const at = { page: i, x: p.x, y: p.shelfY };
        p.x += w; p.shelfH = Math.max(p.shelfH, h);
        return at;
      }
      if (p.shelfY + p.shelfH + h <= this.size) {
        p.shelfY += p.shelfH; p.shelfH = h; p.x = w;
        return { page: i, x: 0, y: p.shelfY };
      }
    }
    this.pages.push({ shelfY: 0, shelfH: h, x: w });
    return { page: this.pages.length - 1, x: 0, y: 0 };
  }
}

// A face with no lightmap of its own - sky, water, anything hlrad skipped - still needs somewhere
// to sample. Give it one flat block at the value an unlit GoldSrc surface has.
const FLAT = { width: 2, height: 2, baseS: 0, baseT: 0, rgb: Buffer.alloc(12, 128), flat: true };

function planLightmaps(map, opts) {
  const packer = new Packer(ATLAS);
  const pages = [];                                   // page index -> RGB buffer
  const byFace = new Map();                           // face index -> { page, x, y, hl }
  const gain = opts && opts.gain ? opts.gain : 1;
  // Nothing survives a multiply by zero. In the lit route the baked light rides INSIDE the wall's
  // Diffuse, so a luxel hlrad left at 0 is a surface no torch, no muzzle flash and no lamp can ever
  // reach: texture x 0 x light is still 0. It is not a corner case - 64.5% of zm_rooms' luxels are
  // exactly 0, against 3.4% of gg_dustwars and none of cs_assault - and the flashlight there lights
  // nothing at all (Screenshot_13).
  //
  // A floor under the atlas leaves the darkest surface a little of its texture for a light to land
  // on. The price is hlrad's deepest shadows lifting by the same amount, which is why it is small:
  // at 8 it moves 70% of zm_rooms and 0% of cs_assault.
  const floor = opts && opts.floor ? Math.max(0, Math.min(255, opts.floor)) : 0;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(floor, Math.min(255, Math.round(v * gain)));
  let flatFaces = 0, litFaces = 0;

  // Which texels of a page hold a block. The rest is the gap the shelf packer leaves, and it is
  // black - so the mip chain has to know not to average it in (unreal/texture.js mipChain).
  const covers = [];
  const pageOf = (i) => {
    while (pages.length <= i) { pages.push(Buffer.alloc(ATLAS * ATLAS * 3, 0)); covers.push(new Uint8Array(ATLAS * ATLAS)); }
    return pages[i];
  };

  const faces = opts && opts.faces ? opts.faces : map.faces.map((_, i) => i);
  for (const fi of faces) {
    const face = map.faces[fi];
    if (!face) continue;
    const hl = map.faceLightmapRGB(face) || FLAT;
    if (hl.flat) flatFaces++; else litFaces++;
    const w = hl.width, h = hl.height;
    const at = packer.alloc(w + BORDER * 2, h + BORDER * 2);
    const page = pageOf(at.page);
    // Copy the block in, then repeat its edge into the border ring.
    for (let y = -BORDER; y < h + BORDER; y++) {
      const sy = Math.max(0, Math.min(h - 1, y));
      for (let x = -BORDER; x < w + BORDER; x++) {
        const sx = Math.max(0, Math.min(w - 1, x));
        const s = (sy * w + sx) * 3;
        const t = (at.y + BORDER + y) * ATLAS + (at.x + BORDER + x);
        const d = t * 3;
        page[d] = lut[hl.rgb[s]];
        page[d + 1] = lut[hl.rgb[s + 1]];
        page[d + 2] = lut[hl.rgb[s + 2]];
        covers[at.page][t] = 1;
      }
    }
    byFace.set(fi, { page: at.page, x: at.x + BORDER, y: at.y + BORDER, hl });
  }

  // World position (GoldSrc space, entity origin already subtracted) -> atlas UV.
  const uvOf = (plan, ti, pHL) => {
    const hl = plan.hl;
    if (hl.flat) return [(plan.x + 1) / ATLAS, (plan.y + 1) / ATLAS];
    const s = pHL[0] * ti.s[0] + pHL[1] * ti.s[1] + pHL[2] * ti.s[2] + ti.sShift;
    const t = pHL[0] * ti.t[0] + pHL[1] * ti.t[1] + pHL[2] * ti.t[2] + ti.tShift;
    // Clamp inside the block: a vertex can sit a hair outside its own luxel grid, and past the
    // border it would sample the neighbour packed beside it.
    const lx = Math.max(-BORDER, Math.min(hl.width - 1 + BORDER, s / 16 - hl.baseS));
    const ly = Math.max(-BORDER, Math.min(hl.height - 1 + BORDER, t / 16 - hl.baseT));
    // +0.5 puts the sample in the middle of the texel, where bilinear filtering expects it.
    return [(plan.x + lx + 0.5) / ATLAS, (plan.y + ly + 0.5) / ATLAS];
  };

  return { pages, covers, byFace, uvOf, size: ATLAS, stats: { pages: pages.length, litFaces, flatFaces } };
}

module.exports = { planLightmaps, ATLAS };
