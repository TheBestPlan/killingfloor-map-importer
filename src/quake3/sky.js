// The sky a Quake 3 map asks for.
//
// A sky shader carries `skyparms <farbox> <cloudheight> <nearbox>`, and a farbox is six images named
// <farbox>_{rt,lf,ft,bk,up,dn} - the same six sides, in the same Quake layout, that the GoldSrc
// route already draws on a cube.
//
// Most of id's own skies set the farbox to `-` and paint the sky with two scrolling cloud LAYERS
// instead: 30 of baseq3's 34 sky surfaces, 47 of Team Arena's 61. Nothing in UE2.5 reproduces a
// scrolling dome, so those get the cloud image itself on all six faces - a still sky of the map's
// own colour and clouds, seams and all, which is a great deal closer than a flat blue.
"use strict";

const { decode } = require("./image");
const { diffuseStage } = require("./shader");

const SIDES = ["up", "dn", "lf", "rt", "ft", "bk"];
const SUFFIX = { up: "_up", dn: "_dn", lf: "_lf", rt: "_rt", ft: "_ft", bk: "_bk" };

function readImage(gamefs, base) {
  for (const ext of [".tga", ".jpg", ".jpeg", ".png"]) {
    if (gamefs.has(base + ext)) {
      try { return decode(base + ext, gamefs.read(base + ext)); } catch { return null; }
    }
  }
  return null;
}

// Returns { sides: { up, dn, ... }, kind: "farbox" | "clouds", name } or null.
function loadSky(gamefs, shaderInfo) {
  const sh = shaderInfo && shaderInfo.shader;
  const farbox = shaderInfo && shaderInfo.sky && shaderInfo.sky.farbox;
  if (farbox) {
    const sides = {};
    let found = 0;
    for (const s of SIDES) {
      const img = readImage(gamefs, farbox.replace(/\\/g, "/") + SUFFIX[s]);
      if (img) { sides[s] = img; found++; }
    }
    if (found === SIDES.length) return { sides, kind: "farbox", name: farbox };
    if (found) {
      // An incomplete set: stand the missing sides in with one that exists rather than lose the sky.
      const any = sides[SIDES.find((s) => sides[s])];
      for (const s of SIDES) if (!sides[s]) sides[s] = any;
      return { sides, kind: "farbox", name: farbox + " (incomplete, " + found + "/6)" };
    }
  }
  // No farbox: the cloud layer's own image, on every face.
  const stage = sh && diffuseStage(sh);
  const cloud = (stage && stage.map) || (sh && sh.editorImage);
  if (cloud) {
    const img = readImage(gamefs, String(cloud).replace(/\\/g, "/").replace(/\.[a-z]+$/i, ""));
    if (img) {
      const sides = {};
      for (const s of SIDES) sides[s] = img;
      return { sides, kind: "clouds", name: String(cloud) };
    }
  }
  return null;
}

module.exports = { loadSky, SIDES };
