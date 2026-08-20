// Source engine BSP -> Killing Floor .rom. Reads the world geometry (src/source/bsp.js) into the
// glTF route's scene shape and hands it to that route's builder, so the whole KF skeleton, texture,
// sky, light and verify path is shared. Source is Z-up like GoldSrc, so it feeds axes [0,1,2] with a
// Y flip and the GoldSrc pawn-fit scale.
"use strict";

const path = require("path");
const { loadSourceScene } = require("./bsp");
const gltf = require("../gltf/convert");

const SCALE = 1.9165;   // GoldSrc units -> Unreal; Source uses the same units

function convert(opts) {
  const o = Object.assign({}, opts);
  const scene = loadSourceScene(o.file, o.log);
  const baseName = path.basename(o.file).replace(/\.bsp$/i, "");
  return gltf.convert(Object.assign({}, o, {
    scene, file: null, baseName,
    axes: [0, 1, 2], flip: [0, 1, 0],
    scale: o.scale || SCALE,
    title: baseName + " (Source)",
  }));
}

module.exports = { convert };
