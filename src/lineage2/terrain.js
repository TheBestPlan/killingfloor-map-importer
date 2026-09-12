// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// The ground of a Lineage 2 square.
//
// `TerrainInfo` is a heightfield, not geometry: a G16 texture where every texel is one vertex, laid
// out on a regular grid of `TerrainScale.X` by `TerrainScale.Y` units. Height comes out as
//
//   z = (texel - 32768) / 256 * TerrainScale.Z + Location.Z
//
// - the 16-bit value is centred on 32768, and the engine reads it in 1/256ths. `QuadVisibilityBitmap`
// carries one bit per quad: a clear bit is a hole, which is how caves and water basins are cut.
//
// Killing Floor has terrain of its own, but writing UE2.5's TerrainInfo means writing its sectors,
// its lightmaps and its layer alpha maps as well. The ground goes across as ordinary static meshes
// instead: the same triangles, and every piece of the pipeline that already exists downstream.
"use strict";

const { tagsOf, pick, all, val, refTarget } = require("./props");
const { readHeightmap } = require("./texture");

// The engine's own quantisation: heights are 1/256th of a unit before TerrainScale.Z.
const HEIGHT_UNIT = 1 / 256;
const HEIGHT_MID = 32768;

function readTerrain(client, pkg) {
  const exp = pkg.exports.find((e) => pkg.classOf(e) === "TerrainInfo" && e.serialSize > 0);
  if (!exp) return null;
  const { tags } = tagsOf(pkg, exp);

  const scaleTag = pick(tags, "TerrainScale");
  const locTag = pick(tags, "Location");
  const scale = scaleTag ? val.vector(pkg, scaleTag) : [128, 128, 64];
  const location = locTag ? val.vector(pkg, locTag) : [0, 0, 0];

  const mapTag = pick(tags, "TerrainMap");
  const target = mapTag ? refTarget(pkg, val.ref(pkg, mapTag)) : null;
  if (!target) throw new Error("TerrainInfo has no TerrainMap");
  const hm = loadHeightmap(client, pkg, target);

  // One bit per quad, row-major, LSB first. The two extra bytes are the array's own header.
  const visTag = pick(tags, "QuadVisibilityBitmap");
  const visibility = visTag ? val.bytes(pkg, visTag) : null;

  const layers = all(tags, "Layers").map((t, i) => readLayer(pkg, t, i));

  return {
    name: pkg.pkgName,
    width: hm.width, height: hm.height,
    heights: hm.heights,
    scale, location,
    visibility,
    layers,
    mapX: pick(tags, "MapX") ? val.int(pkg, pick(tags, "MapX")) : null,
    mapY: pick(tags, "MapY") ? val.int(pkg, pick(tags, "MapY")) : null,
    // World position of terrain vertex (ix, iy), in Unreal units.
    //
    // `Location` is the CENTRE of the heightfield, not its corner. Read as a corner, every square's
    // ground came out half a square - 16384 units - out of place in both x and y: the terrain cut
    // through the town at the wrong height, the buildings' feet were buried, and every spawn check
    // that asked "what is the ground here" was answering about a place 16 thousand units away.
    //
    // Measured on four squares against the world grid the client itself uses, `(MapX-20, MapY-18) *
    // 32768`: centred, the footprint lands on that square exactly, and every one of the square's own
    // PlayerStarts falls inside it. Read as a corner, all four are off by +16384 in both axes.
    vertex(ix, iy) {
      const h = this.heights[iy * this.width + ix];
      return [
        this.location[0] + (ix - this.width / 2) * this.scale[0],
        this.location[1] + (iy - this.height / 2) * this.scale[1],
        this.location[2] + (h - HEIGHT_MID) * HEIGHT_UNIT * this.scale[2],
      ];
    },
    // A quad is drawn unless its visibility bit is clear.
    //
    // The row stride is the map width, not the quad count: 8194 bytes for a 256x256 square is the
    // array's 2-byte header and exactly 256x256 bits. Walking it 255 to the row shears the mask one
    // bit further left on every row down.
    quadVisible(ix, iy) {
      if (!this.visibility) return true;
      const bit = iy * this.width + ix;
      const byte = 2 + (bit >> 3);                  // the array's 2-byte header
      if (byte >= this.visibility.length) return true;
      return (this.visibility[byte] >> (bit & 7) & 1) !== 0;
    },
  };
}

function loadHeightmap(client, pkg, target) {
  if (target.local) return readHeightmap(pkg, target.local);
  const src = client.get(target.pkg);
  if (!src) throw new Error("terrain map package " + target.pkg + " is not in this client");
  const exp = src.exports.find((e) => e.name === target.name && src.classOf(e) === "Texture");
  if (!exp) throw new Error("terrain map " + target.pkg + "." + target.name + " not found");
  return readHeightmap(src, exp);
}

// A TerrainLayer is a struct: the texture painted, the alpha map that says where, and the mapping.
function readLayer(pkg, tag, index) {
  const { readTags } = require("./props");
  const { tags } = readTags(pkg, tag.at, tag.at + tag.size);
  const texTag = pick(tags, "Texture");
  const alphaTag = pick(tags, "AlphaMap");
  const num = (n, d) => { const t = pick(tags, n); return t ? val.float(pkg, t) : d; };
  return {
    index,
    texture: texTag ? refTarget(pkg, val.ref(pkg, texTag)) : null,
    alphaMap: alphaTag ? refTarget(pkg, val.ref(pkg, alphaTag)) : null,
    uScale: num("UScale", 1), vScale: num("VScale", 1),
    uPan: num("UPan", 0), vPan: num("VPan", 0),
  };
}

module.exports = { readTerrain, HEIGHT_UNIT, HEIGHT_MID };
