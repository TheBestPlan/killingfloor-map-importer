// Half-Life .mdl (IDST version 10) - the props a CS map places with cycler_sprite, monster_furniture
// and friends. Only the first body part of each model, in its bind pose: these are scenery, and a
// static level cannot animate them anyway.
//
// Vertices live in bone space, so the bind pose has to be built and applied or every prop collapses
// onto the origin. Textures are paletted 8-bit and may live in a companion <name>T.mdl.
"use strict";

const fs = require("fs");

function readString(b, off, len) {
  const s = b.toString("latin1", off, off + len);
  const z = s.indexOf("\0");
  return z < 0 ? s : s.slice(0, z);
}

// bone.value = [x, y, z, rotX, rotY, rotZ] (radians, X-Y-Z order). Returns a 3x4 matrix.
function boneMatrix(pos, rot) {
  const [cx, cy, cz] = [Math.cos(rot[0]), Math.cos(rot[1]), Math.cos(rot[2])];
  const [sx, sy, sz] = [Math.sin(rot[0]), Math.sin(rot[1]), Math.sin(rot[2])];
  return [
    [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz, pos[0]],
    [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz, pos[1]],
    [-sy, sx * cy, cx * cy, pos[2]],
  ];
}

function matMul(a, b) {
  const out = [];
  for (let r = 0; r < 3; r++) {
    out.push([
      a[r][0] * b[0][0] + a[r][1] * b[1][0] + a[r][2] * b[2][0],
      a[r][0] * b[0][1] + a[r][1] * b[1][1] + a[r][2] * b[2][1],
      a[r][0] * b[0][2] + a[r][1] * b[1][2] + a[r][2] * b[2][2],
      a[r][0] * b[0][3] + a[r][1] * b[1][3] + a[r][2] * b[2][3] + a[r][3],
    ]);
  }
  return out;
}

const apply = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2] + m[0][3],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2] + m[1][3],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2] + m[2][3],
];

// The texture block, either in this file or in the <name>T.mdl beside it.
function readTextures(b, numTextures, textureIndex) {
  const out = [];
  for (let i = 0; i < numTextures; i++) {
    const o = textureIndex + i * 80;
    if (o + 80 > b.length) break;
    const name = readString(b, o, 64);
    const flags = b.readInt32LE(o + 64);
    const width = b.readInt32LE(o + 68), height = b.readInt32LE(o + 72);
    const index = b.readInt32LE(o + 76);
    if (width <= 0 || height <= 0 || index + width * height + 768 > b.length) continue;
    const idx = b.subarray(index, index + width * height);
    const pal = b.subarray(index + width * height, index + width * height + 768);
    const rgb = Buffer.alloc(width * height * 3);
    const alpha = Buffer.alloc(width * height, 255);
    // flags bit 6 (0x40) is "masked": the last palette entry is the cut-out colour.
    const masked = (flags & 0x40) !== 0;
    for (let p = 0; p < width * height; p++) {
      const c = idx[p];
      if (masked && c === 255) { alpha[p] = 0; continue; }
      rgb[p * 3] = pal[c * 3]; rgb[p * 3 + 1] = pal[c * 3 + 1]; rgb[p * 3 + 2] = pal[c * 3 + 2];
    }
    out.push({ name, width, height, rgb, alpha: masked ? alpha : null, masked });
  }
  return out;
}

function load(file) {
  let b;
  try { b = fs.readFileSync(file); } catch (e) { return null; }
  if (b.length < 244 || b.toString("latin1", 0, 4) !== "IDST") return null;
  if (b.readInt32LE(4) !== 10) return null;

  const numBones = b.readInt32LE(freq("numbones")), boneIndex = b.readInt32LE(freq("boneindex"));
  const numTextures = b.readInt32LE(freq("numtextures")), textureIndex = b.readInt32LE(freq("textureindex"));
  const numSkinRef = b.readInt32LE(freq("numskinref")), skinIndex = b.readInt32LE(freq("skinindex"));
  const numBodyParts = b.readInt32LE(freq("numbodyparts")), bodyPartIndex = b.readInt32LE(freq("bodypartindex"));

  // Bind pose. Each bone's own transform is value[0..5]; the world transform chains to the parent.
  const world = [];
  for (let i = 0; i < numBones; i++) {
    const o = boneIndex + i * 112;
    if (o + 112 > b.length) return null;
    const parent = b.readInt32LE(o + 32);
    const v = [];
    // mstudiobone_t: name[32], parent, flags, bonecontroller[6], value[6] at +64, scale[6].
    for (let k = 0; k < 6; k++) v.push(b.readFloatLE(o + 64 + k * 4));
    const local = boneMatrix([v[0], v[1], v[2]], [v[3], v[4], v[5]]);
    world.push(parent >= 0 && world[parent] ? matMul(world[parent], local) : local);
  }

  // Textures may be external: <name>.mdl -> <name>T.mdl.
  let texBuf = b, nTex = numTextures, texIdx = textureIndex;
  if (numTextures === 0) {
    const alt = file.replace(/\.mdl$/i, "T.mdl");
    try {
      const t = fs.readFileSync(alt);
      if (t.toString("latin1", 0, 4) === "IDST") {
        texBuf = t; nTex = t.readInt32LE(freq("numtextures")); texIdx = t.readInt32LE(freq("textureindex"));
      }
    } catch (e) { /* no companion file; the model draws untextured */ }
  }
  const textures = readTextures(texBuf, nTex, texIdx);
  const skins = [];
  const skinBuf = texBuf === b ? b : texBuf;
  const skinCount = texBuf === b ? numSkinRef : skinBuf.readInt32LE(freq("numskinref"));
  const skinOff = texBuf === b ? skinIndex : skinBuf.readInt32LE(freq("skinindex"));
  for (let i = 0; i < skinCount; i++) skins.push(skinBuf.readInt16LE(skinOff + i * 2));

  // One triangle list per texture.
  const groups = new Map();
  let verts = 0;
  for (let bp = 0; bp < numBodyParts; bp++) {
    const o = bodyPartIndex + bp * 76;
    if (o + 76 > b.length) break;
    const numModels = b.readInt32LE(o + 64), modelIndex = b.readInt32LE(o + 72);
    if (numModels <= 0) continue;
    // Only sub-model 0: the others are alternates (different heads, damaged variants).
    const mo = modelIndex;
    if (mo + 112 > b.length) continue;
    const numMesh = b.readInt32LE(mo + 72), meshIndex = b.readInt32LE(mo + 76);
    const numVerts = b.readInt32LE(mo + 80), vertInfoIndex = b.readInt32LE(mo + 84), vertIndex = b.readInt32LE(mo + 88);
    if (numVerts <= 0 || vertIndex + numVerts * 12 > b.length) continue;

    const pos = [];
    for (let i = 0; i < numVerts; i++) {
      const boneOfVert = b[vertInfoIndex + i];
      const raw = [b.readFloatLE(vertIndex + i * 12), b.readFloatLE(vertIndex + i * 12 + 4), b.readFloatLE(vertIndex + i * 12 + 8)];
      pos.push(world[boneOfVert] ? apply(world[boneOfVert], raw) : raw);
    }
    verts += numVerts;

    for (let mi = 0; mi < numMesh; mi++) {
      const meo = meshIndex + mi * 20;
      if (meo + 20 > b.length) break;
      const triIndex = b.readInt32LE(meo + 4), skinRef = b.readInt32LE(meo + 8);
      const tex = textures[skins[skinRef] !== undefined ? skins[skinRef] : skinRef] || textures[0];
      const key = tex ? tex.name : "none";
      if (!groups.has(key)) groups.set(key, { tex, tris: [] });
      const g = groups.get(key);
      const tw = tex ? tex.width : 1, th = tex ? tex.height : 1;

      // Command list: a signed count, then that many vertices; negative means a fan, positive a strip.
      let p = triIndex;
      for (let guard = 0; guard < 1 << 20; guard++) {
        if (p + 2 > b.length) break;
        const n = b.readInt16LE(p); p += 2;
        if (n === 0) break;
        const fan = n < 0, cnt = Math.abs(n);
        if (p + cnt * 8 > b.length) break;
        const run = [];
        for (let i = 0; i < cnt; i++) {
          const vi = b.readUInt16LE(p), s = b.readInt16LE(p + 4), t = b.readInt16LE(p + 6);
          p += 8;
          run.push({ pos: pos[vi] || [0, 0, 0], uv: [s / tw, t / th] });
        }
        for (let i = 2; i < cnt; i++) {
          if (fan) g.tris.push([run[0], run[i - 1], run[i]]);
          else if (i & 1) g.tris.push([run[i - 1], run[i - 2], run[i]]);
          else g.tris.push([run[i - 2], run[i - 1], run[i]]);
        }
      }
    }
  }

  const parts = [...groups.values()].filter((g) => g.tris.length);
  if (!parts.length) return null;
  return { name: readString(b, 8, 64), textures, parts, vertexCount: verts };
}

// Byte offsets in studiohdr_t, by name, so the reader above stays readable.
function freq(field) {
  const O = {
    numbones: 140, boneindex: 144,
    numbonecontrollers: 148, bonecontrollerindex: 152,
    numhitboxes: 156, hitboxindex: 160,
    numseq: 164, seqindex: 168,
    numseqgroups: 172, seqgroupindex: 176,
    numtextures: 180, textureindex: 184, texturedataindex: 188,
    numskinref: 192, numskinfamilies: 196, skinindex: 200,
    numbodyparts: 204, bodypartindex: 208,
  };
  if (O[field] === undefined) throw new Error("unknown studiohdr field " + field);
  return O[field];
}

module.exports = { load };
