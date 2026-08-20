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
  // No farbox: the cloud LAYERS, flattened into one picture.
  //
  // Taking the diffuse stage alone is what made a Team Arena sky black: `xproto_sky2` draws a nearly
  // black cloud sheet ADDITIVELY over a lit one, and on its own that sheet is the black. Compositing
  // the stages the way the engine stacks them - the first as the base, the rest blended or added
  // over it - gets the map's own sky colour back.
  const stages = (sh && sh.stages || []).filter((s) => s.map && !/^\$/.test(s.map));
  const layers = [];
  for (const st of stages) {
    const img = readImage(gamefs, String(st.map).replace(/\\/g, "/").replace(/\.[a-z]+$/i, ""));
    if (img) layers.push({ img, blend: st.blend });
  }
  if (!layers.length) {
    const stage = sh && diffuseStage(sh);
    const cloud = (stage && stage.map) || (sh && sh.editorImage);
    const img = cloud && readImage(gamefs, String(cloud).replace(/\\/g, "/").replace(/\.[a-z]+$/i, ""));
    if (!img) return null;
    layers.push({ img, blend: "opaque" });
  }
  const base = layers[0].img;
  const rgb = Buffer.from(base.rgb);
  for (let i = 1; i < layers.length; i++) {
    const { img, blend } = layers[i];
    for (let p = 0; p < base.width * base.height; p++) {
      // Sample the layer at the base's resolution; the layers of a Quake 3 sky are the same size in
      // every stock shader, so this is a straight read in practice.
      const sx = Math.min(img.width - 1, Math.floor((p % base.width) * img.width / base.width));
      const sy = Math.min(img.height - 1, Math.floor(Math.floor(p / base.width) * img.height / base.height));
      const o = (sy * img.width + sx) * 3;
      for (let c = 0; c < 3; c++) {
        const src = img.rgb[o + c], dst = rgb[p * 3 + c];
        rgb[p * 3 + c] = blend === "additive" ? Math.min(255, dst + src)
          : blend === "filter" ? (dst * src) / 255
            : blend === "blend" ? (dst + src) / 2 : src;
      }
    }
  }
  const flat = { width: base.width, height: base.height, rgb, alpha: null };
  const sides = {};
  for (const s of SIDES) sides[s] = flat;
  return { sides, kind: "clouds", name: String(layers.map((l) => l.blend).length) + " layer(s)" };
}

module.exports = { loadSky, SIDES };
