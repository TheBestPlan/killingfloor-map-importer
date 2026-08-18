// Rebuilding Unreal Engine 1's baked light as pixels.
//
// UE1 does not store a lightmap. It stores, per surface, one BIT per luxel per light - "this light
// reaches this luxel" - and computes the colour at load time from the light actors themselves. So
// carrying the light across means doing what the engine does: walk each surface's luxel grid, and
// for every light in its list add colour by distance, incidence and that one shadow bit.
//
// The arithmetic is Epic's, from Render/Src/UnLight.cpp of the UT99 v400 source:
//
//   Radius   = 25 * (LightRadius + 1)                     AActor::WorldLightRadius
//   Diffuse  = |(LightLocation - SurfaceBase) . Normal| / Radius
//   value    = ShadowMap * Diffuse * LightSqrt[dist^2 * 4093 / Radius^2]
//   LightSqrt[i] = (2S^3 - 3S^2 + 1) / S,  S = dist / Radius
//
// which multiplies out to `cos(incidence) * (2S^3 - 3S^2 + 1)` - a Lambert term times a smoothstep
// falloff that reaches zero exactly at the light's radius. The shadow bits are convolved with the
// same 3x3 tent the engine uses (FLightManager::Init's FilterWeight), so a shadow edge arrives
// soft rather than as stairsteps of single luxels.
//
// Two facts checked against the files rather than assumed: the per-surface bit runs are
// `((UClamp+7)/8) * VClamp` bytes per light, laid end to end from FLightMapIndex.DataOffset - which
// accounts for LightBits to the byte on every stock map - and every vertex of every node lands
// inside its own surface's UClamp x VClamp block.
"use strict";

const { tagsOf, pick, val } = require("../lineage2/props");

const PAGE = +process.env.KF_LM_PAGE || 1024;   // atlas page side, in luxels
const GUTTER = 1;                               // one texel of bleed room around every block

// ELightEffect, the two that are not a point light.
const LE_STATIC_SPOT = 8, LE_SPOTLIGHT = 12;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// The world-space direction that moves one unit along each of the surface's two texture axes. The
// axes are not unit vectors and need not be orthogonal, so this is the dual basis: the inverse of
// the matrix whose rows are (U, V, N).
function dualBasis(U, V, N) {
  const m = [U, V, N];
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!det || !isFinite(det)) return null;
  const inv = (r, c) => {
    const r1 = (c + 1) % 3, r2 = (c + 2) % 3, c1 = (r + 1) % 3, c2 = (r + 2) % 3;
    return (m[r1][c1] * m[r2][c2] - m[r1][c2] * m[r2][c1]) / det;
  };
  // Columns of the inverse: column 0 moves one unit of U, column 1 one unit of V.
  return {
    u: [inv(0, 0), inv(1, 0), inv(2, 0)],
    v: [inv(0, 1), inv(1, 1), inv(2, 1)],
  };
}

// Unreal's byte hue/saturation to RGB in 0..1. Saturation is inverted: 255 is white.
function hsvToRgb(hue, sat) {
  const h = (hue / 255) * 6;
  const i = Math.floor(h) % 6, f = h - Math.floor(h);
  const pure = [
    [1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f],
  ][i < 0 ? 0 : i];
  const s = 1 - Math.max(0, Math.min(255, sat)) / 255;      // 0 = white, 1 = fully coloured
  return pure.map((c) => c * s + (1 - s));
}

// A light actor, read once.
function readLight(pkg, ref) {
  const exp = ref > 0 ? pkg.exports[ref - 1] : null;
  if (!exp || exp.serialSize <= 0) return null;
  let tags;
  try { tags = tagsOf(pkg, exp).tags; } catch (e) { return null; }
  const num = (name, dflt) => { const t = pick(tags, name); return t ? val.byte(pkg, t) : dflt; };
  const loc = pick(tags, "Location");
  if (!loc) return null;
  // Class defaults from UT99's Light.uc; an actor only stores what it changed.
  const brightness = num("LightBrightness", 64) / 255;
  const radius = 25 * (num("LightRadius", 64) + 1);
  const type = num("LightType", 1);                          // LT_Steady
  if (type === 0) return null;                               // LT_None: an actor that lights nothing
  const effect = num("LightEffect", 0);
  const rot = pick(tags, "Rotation");
  const r = rot ? val.rotator(pkg, rot) : [0, 0, 0];
  const pitch = (r[0] / 65536) * Math.PI * 2, yaw = (r[1] / 65536) * Math.PI * 2;
  return {
    location: val.vector(pkg, loc),
    color: hsvToRgb(num("LightHue", 0), num("LightSaturation", 255)),
    brightness, radius,
    spot: effect === LE_SPOTLIGHT || effect === LE_STATIC_SPOT,
    cone: num("LightCone", 128),
    view: [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)],
  };
}

// The 3x3 tent FLightManager::Init builds, as a normalised weight per neighbour.
const FILTER = [24, 40, 24, 40, 64, 40, 24, 40, 24];
const FILTER_SUM = FILTER.reduce((a, b) => a + b, 0);

// One light's shadow bitmask, smoothed into 0..1 per luxel. Edges repeat, which is what the
// engine's own shifting does at the ends of a row.
function smoothShadow(bits, at, w, h, out) {
  const stride = (w + 7) >> 3;
  const bitAt = (x, y) => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    const b = bits[at + cy * stride + (cx >> 3)];
    return b === undefined ? 0 : (b >> (cx & 7)) & 1;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++, k++) sum += FILTER[k] * bitAt(x + dx, y + dy);
      out[y * w + x] = sum / FILTER_SUM;
    }
  }
  return out;
}

// Shelf packer, fed the blocks TALLEST FIRST.
//
// Order is most of the packing: a map's blocks run from 4x4 to 200x180, and placing them as they
// come leaves every shelf as tall as the one big block that opened it. TO-Crossfire's 234k luxels
// filled two 1024x1024 pages that way - 88% of the atlas was air, and an atlas is the biggest thing
// in the finished file. Sorted, the same map lands in one page cropped to 1024x256.
class Atlas {
  constructor(size) { this.size = size; this.pages = []; }
  place(w, h) {
    const bw = w + GUTTER * 2, bh = h + GUTTER * 2;
    if (bw > this.size || bh > this.size) return null;
    for (const page of this.pages) {
      for (const shelf of page.shelves) {
        if (shelf.height >= bh && shelf.x + bw <= this.size) {
          const at = { page: page.index, x: shelf.x + GUTTER, y: shelf.y + GUTTER };
          shelf.x += bw;
          page.usedX = Math.max(page.usedX, shelf.x);
          return at;
        }
      }
      if (page.y + bh <= this.size) {
        const shelf = { x: bw, y: page.y, height: bh };
        page.shelves.push(shelf);
        const at = { page: page.index, x: GUTTER, y: page.y + GUTTER };
        page.y += bh;
        page.usedX = Math.max(page.usedX, bw);
        return at;
      }
    }
    this.pages.push({ index: this.pages.length, y: 0, usedX: 0, shelves: [] });
    return this.place(w, h);
  }
}

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

function buildLightmap(pkg, model, opts) {
  const o = opts || {};
  const gain = o.gain === undefined ? 1 : o.gain;
  const floor = o.floor === undefined ? 0 : o.floor;
  const atlas = new Atlas(PAGE);
  const lights = new Map();
  const lightOf = (ref) => {
    if (!lights.has(ref)) lights.set(ref, readLight(pkg, ref));
    return lights.get(ref);
  };

  const stats = { surfaces: 0, lights: 0, skipped: 0, tooBig: 0, mean: 0, fill: 0 };
  const placed = new Map();            // iSurf -> block, several surfaces can share one light mesh
  const blocks = [];                   // one per FLightMapIndex actually used

  // Pass one: what has to be packed, and everything a luxel needs to be shaded.
  const byLightMap = new Map();
  model.surfs.forEach((surf, iSurf) => {
    if (surf.iLightMap < 0) return;
    const known = byLightMap.get(surf.iLightMap);
    if (known) { placed.set(iSurf, known); return; }
    const lm = model.lightMap[surf.iLightMap];
    if (!lm || lm.uClamp <= 0 || lm.vClamp <= 0) { stats.skipped++; return; }
    const O = model.points[surf.pBase];
    const U = model.vectors[surf.vTextureU], V = model.vectors[surf.vTextureV], N = model.vectors[surf.vNormal];
    if (!O || !U || !V || !N) { stats.skipped++; return; }
    const dual = dualBasis(U, V, N);
    if (!dual) { stats.skipped++; return; }
    const block = {
      lm, O, U, V, w: lm.uClamp, h: lm.vClamp,
      // World position of luxel (0,0) and the step between luxels.
      base: [0, 1, 2].map((k) => O[k] + dual.u[k] * lm.pan[0] + dual.v[k] * lm.pan[1]),
      du: dual.u.map((c) => c * lm.uScale),
      dv: dual.v.map((c) => c * lm.vScale),
      unit: (() => { const len = Math.hypot(N[0], N[1], N[2]) || 1; return N.map((c) => c / len); })(),
      spot: null,
    };
    byLightMap.set(surf.iLightMap, block);
    placed.set(iSurf, block);
    blocks.push(block);
  });

  // Pass two: pack tallest first, then give every page a buffer.
  blocks.sort((a, b) => b.h - a.h || b.w - a.w);
  for (const block of blocks) {
    block.spot = atlas.place(block.w, block.h);
    if (!block.spot) stats.tooBig++; else stats.surfaces++;
  }
  for (const page of atlas.pages) {
    page.width = nextPow2(Math.min(PAGE, page.usedX));
    page.height = nextPow2(Math.min(PAGE, page.y));
    page.rgb = Buffer.alloc(page.width * page.height * 3);
  }

  // Pass three: the light itself.
  let sum = 0, n = 0;
  const lightsUsed = new Set();
  for (const block of blocks) {
    if (!block.spot) continue;
    const { lm, w, h, base, du, dv, unit, O, spot } = block;
    const page = atlas.pages[spot.page];
    const acc = new Float32Array(w * h * 3);
    const mask = new Float32Array(w * h);
    const stride = (w + 7) >> 3, space = stride * h;
    let li = 0;
    for (let i = lm.iLightActors; i >= 0 && i < model.lights.length && model.lights[i]; i++, li++) {
      const L = lightOf(model.lights[i]);
      if (!L) continue;
      lightsUsed.add(model.lights[i]);
      smoothShadow(model.lightBits, lm.dataOffset + li * space, w, h, mask);
      // The engine's per-surface incidence term: the light's distance from the surface's PLANE.
      const perp = Math.abs(dot(sub(L.location, O), unit));
      if (perp <= 0) continue;
      const R = L.radius, cr = L.color, br = L.brightness;
      const sine = 1 - L.cone / 256, rsine = 1 / Math.max(1e-4, 1 - sine), sineRSine = sine * rsine;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = mask[y * w + x];
          if (s <= 0) continue;
          const px = base[0] + du[0] * x + dv[0] * y;
          const py = base[1] + du[1] * x + dv[1] * y;
          const pz = base[2] + du[2] * x + dv[2] * y;
          const vx = px - L.location[0], vy = py - L.location[1], vz = pz - L.location[2];
          const d2 = vx * vx + vy * vy + vz * vz;
          if (d2 >= R * R) continue;
          const d = Math.sqrt(d2) || 1;
          const S = d / R;
          let f = (2 * S * S * S - 3 * S * S + 1) * (perp / d) * s;
          if (L.spot) {
            const vdotv = vx * L.view[0] + vy * L.view[1] + vz * L.view[2];
            if (vdotv <= 0 || vdotv * vdotv <= sine * sine * d2) continue;
            const cone = vdotv * rsine / d - sineRSine;
            f *= cone * cone;
          }
          if (f <= 0) continue;
          const at = (y * w + x) * 3;
          acc[at] += cr[0] * br * f;
          acc[at + 1] += cr[1] * br * f;
          acc[at + 2] += cr[2] * br * f;
        }
      }
    }

    // Into the page, with the block's edge repeated into the gutter so bilinear filtering at the
    // seam samples the block rather than its neighbour.
    const put = (x, y, r, g, b) => {
      if (x < 0 || y < 0 || x >= page.width || y >= page.height) return;
      const at = (y * page.width + x) * 3;
      page.rgb[at] = r; page.rgb[at + 1] = g; page.rgb[at + 2] = b;
    };
    // The gain goes through a soft rolloff rather than a multiply-and-clip.
    //
    // Straight `min(1, acc) * gain` saturates every luxel over 1/gain, so a bright map - a snow
    // field at noon, TO-KnightsEdge - comes out as flat white where the light varies most, while a
    // night map needs the gain to be visible at all. `1 - exp(-acc * gain)` is the same curve near
    // zero (within a percent for the dark half) and compresses the top instead of clipping it.
    const tone = (v) => Math.min(255, Math.round(255 * (1 - Math.exp(-v * gain))) + floor);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 3;
        const r = tone(acc[at]);
        const g = tone(acc[at + 1]);
        const b = tone(acc[at + 2]);
        sum += (r + g + b) / 3; n++;
        put(spot.x + x, spot.y + y, r, g, b);
        if (x === 0) put(spot.x - 1, spot.y + y, r, g, b);
        if (x === w - 1) put(spot.x + w, spot.y + y, r, g, b);
        if (y === 0) put(spot.x + x, spot.y - 1, r, g, b);
        if (y === h - 1) put(spot.x + x, spot.y + h, r, g, b);
      }
    }
  }

  stats.lights = lightsUsed.size;
  stats.mean = n ? sum / n : 0;
  const texels = atlas.pages.reduce((t, p) => t + p.width * p.height, 0);
  stats.fill = texels ? n / texels : 0;

  return {
    pages: atlas.pages.map((p) => ({ index: p.index, width: p.width, height: p.height, rgb: p.rgb })),
    pageSize: PAGE,
    stats,
    pageOf: (iSurf) => {
      const block = placed.get(iSurf);
      return block && block.spot ? block.spot.page : undefined;
    },
    // Where a world point sits in the atlas: its luxel coordinate on the surface, offset by where
    // the block was packed. Texel centres, hence the half.
    uvOf: (iSurf, point) => {
      const block = placed.get(iSurf);
      if (!block || !block.spot) return null;
      const page = atlas.pages[block.spot.page];
      const rel = sub(point, block.O);
      const u = (dot(rel, block.U) - block.lm.pan[0]) / block.lm.uScale;
      const v = (dot(rel, block.V) - block.lm.pan[1]) / block.lm.vScale;
      return [(block.spot.x + u + 0.5) / page.width, (block.spot.y + v + 0.5) / page.height];
    },
  };
}

module.exports = { buildLightmap, hsvToRgb, dualBasis, PAGE };
