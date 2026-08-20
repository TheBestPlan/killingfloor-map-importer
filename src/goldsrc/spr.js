// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// GoldSrc sprites (.spr). Only what a converter needs: the first frame, as RGB + alpha.
//
// env_sprite / env_glow / cycler_sprite point at one of these with their `model` key. Animated
// sprites keep every frame in the file; a static level cannot play them, so frame 0 is what gets
// converted - which is what those three entities show standing still anyway.
"use strict";

const fs = require("fs");

// Header is 40 bytes, then a palette, then the frames.
const HEADER = 40;

// texFormat: how the palette indices turn into colour and alpha.
const NORMAL = 0, ADDITIVE = 1, INDEXALPHA = 2, ALPHTEST = 3;

function load(file) {
  let b;
  try { b = fs.readFileSync(file); } catch (e) { return null; }
  if (b.length < HEADER + 2 || b.toString("latin1", 0, 4) !== "IDSP") return null;
  const version = b.readInt32LE(4);
  if (version !== 2) return null;                       // v1 is Quake; no GoldSrc map ships one
  const spr = {
    type: b.readInt32LE(8),
    texFormat: b.readInt32LE(12),
    maxWidth: b.readInt32LE(20),
    maxHeight: b.readInt32LE(24),
    numFrames: b.readInt32LE(28),
  };

  let o = HEADER;
  const palCount = b.readUInt16LE(o); o += 2;
  if (palCount < 1 || o + palCount * 3 > b.length) return null;
  const pal = b.subarray(o, o + palCount * 3); o += palCount * 3;

  // Frame 0. A group frame (group != 0) prefixes an interval table; those only appear in animated
  // sprites, and stepping past it lands on the same per-frame record.
  if (o + 20 > b.length) return null;
  const group = b.readInt32LE(o); o += 4;
  if (group !== 0) {
    const n = b.readInt32LE(o); o += 4 + n * 4;
    if (o + 20 > b.length) return null;
  }
  o += 8;                                               // originX, originY - unused, sprites centre themselves
  const width = b.readInt32LE(o); o += 4;
  const height = b.readInt32LE(o); o += 4;
  if (width <= 0 || height <= 0 || o + width * height > b.length) return null;

  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = b[o + i];
    if (spr.texFormat === INDEXALPHA) {
      // Colour comes from the last palette entry; the index IS the alpha ramp. This is how glows
      // and light coronas are stored.
      rgb[i * 3] = pal[(palCount - 1) * 3];
      rgb[i * 3 + 1] = pal[(palCount - 1) * 3 + 1];
      rgb[i * 3 + 2] = pal[(palCount - 1) * 3 + 2];
      alpha[i] = idx;
    } else {
      rgb[i * 3] = pal[idx * 3];
      rgb[i * 3 + 1] = pal[idx * 3 + 1];
      rgb[i * 3 + 2] = pal[idx * 3 + 2];
      if (spr.texFormat === ALPHTEST) alpha[i] = idx === 255 ? 0 : 255;
      else if (spr.texFormat === ADDITIVE) alpha[i] = Math.round((rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3);
      else alpha[i] = 255;
    }
  }
  // A masked sprite keeps index 255 in the colour channel too, and the engine's bilinear filter
  // drags that colour into the visible edge as a fringe. Blank it out so the fringe is black-free.
  if (spr.texFormat === ALPHTEST) {
    for (let i = 0; i < width * height; i++) {
      if (alpha[i]) continue;
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 0;
    }
  }

  return Object.assign(spr, { width, height, rgb, alpha, additive: spr.texFormat === ADDITIVE || spr.texFormat === INDEXALPHA });
}

module.exports = { load, NORMAL, ADDITIVE, INDEXALPHA, ALPHTEST };
