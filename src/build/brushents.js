// The brush entities that are not scenery: doors that open and glass that breaks.
//
// Everything else in a CS map (func_wall, func_illusionary, func_ladder…) is geometry and gets
// merged into the world's static meshes. These two do not: a door has to move and a pane has to
// shatter, so each keeps a mesh and an actor of its own.
"use strict";

// GoldSrc `material` on func_breakable: 0 glass, 1 wood, 2 metal, 3 flesh, 4 cinderblock,
// 5 ceiling tile, 6 computer, 7 unbreakable glass. Glass decides the flavour of the break, not
// whether it happens: every func_breakable is a separate object in the original and is shot away
// there, so merging the rest into the world made gg_33_shudder's six cinderblock walls part of the
// terrain - indestructible, and impossible to take out in the editor without leaving a hole.
function isGlass(e) {
  const m = e.material === undefined ? -1 : parseInt(e.material, 10);
  if (m === 0 || m === 7) return true;
  // Older maps leave `material` off and say it with the texture name instead.
  return /glass|window/i.test(e.texture || "") && m === -1;
}

// func_door's `angle` is the direction it slides: -1 up, -2 down, anything else a yaw in degrees.
function slideDir(e) {
  const a = parseFloat(e.angle === undefined ? "0" : e.angle);
  if (a === -1) return [0, 0, 1];
  if (a === -2) return [0, 0, -1];
  const r = (a || 0) * Math.PI / 180;
  return [Math.cos(r), Math.sin(r), 0];
}

// How far a door travels: its own size along the movement axis, less the `lip` that stays in the
// frame. This is exactly how the GoldSrc entity computes it.
function slideDistance(e, model) {
  const d = slideDir(e);
  const size = [0, 1, 2].map((i) => model.maxs[i] - model.mins[i]);
  const along = Math.abs(d[0]) * size[0] + Math.abs(d[1]) * size[1] + Math.abs(d[2]) * size[2];
  const lip = parseFloat(e.lip || "0") || 0;
  return Math.max(1, along - lip);
}

// Every brush entity that needs an actor of its own, in map order.
function collect(map) {
  const out = [];
  map.entities.forEach((e) => {
    const mm = /^\*(\d+)$/.exec(e.model || "");
    if (!mm) return;
    const model = map.models[+mm[1]];
    if (!model || model.numfaces <= 0) return;
    if (e.classname === "func_door" || e.classname === "func_door_rotating") out.push({ kind: "door", e, model, mi: +mm[1] });
    else if (e.classname === "func_breakable") out.push({ kind: isGlass(e) ? "glass" : "breakable", e, model, mi: +mm[1] });
  });
  return out;
}

// Mover keyframe 1, in Unreal units and Unreal axes. Returns { pos, rot, moveTime, stayOpen }.
function doorMotion(item, scale) {
  const { e, model } = item;
  const speed = Math.max(1, parseFloat(e.speed || "100") || 100);
  // `wait` -1 means "stay open". A Mover has no such setting, so park it open for an hour.
  const waitKey = e.wait === undefined ? 4 : parseFloat(e.wait);
  const stayOpen = waitKey < 0 ? 3600 : Math.max(0.5, waitKey);

  if (e.classname === "func_door_rotating") {
    const deg = parseFloat(e.distance || "90") || 90;
    const flags = parseInt(e.spawnflags || "0", 10) || 0;
    const sign = (flags & 2) ? -1 : 1;                  // SF_DOOR_ROTATE_BACKWARDS
    // The GoldSrc -> Unreal Y mirror reverses the sense of a yaw, so the sign flips again.
    const yaw = Math.round((-sign * deg / 360) * 65536);
    return { pos: [0, 0, 0], rot: [0, yaw, 0], moveTime: Math.max(0.2, deg / speed), stayOpen };
  }

  const d = slideDir(e);
  const dist = slideDistance(e, model) * scale;
  return {
    pos: [d[0] * dist, -d[1] * dist, d[2] * dist],      // mirror Y, as all geometry does
    rot: [0, 0, 0],
    moveTime: Math.max(0.2, slideDistance(item.e, model) / speed),
    stayOpen,
  };
}

module.exports = { collect, doorMotion, isGlass, slideDir, slideDistance };
