// Self-check for the glTF -> Killing Floor route. Builds a synthetic scene (a PNG-textured cube with
// a point light and a directional light), converts it, and runs the .rom back through the independent
// reader's invariant checks. No game files needed - safe in CI.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const assert = require("assert");

const { convert } = require("../src/gltf/convert");
const { verify } = require("../src/verify");
const { decodePng } = require("../src/gltf/read");

function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function pngChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const body = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); return Buffer.concat([len, body, crc]); }
function makePng(w, h) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (stride + 1) + 1 + x * 4; raw[o] = (x * 60) & 0xff; raw[o + 1] = (y * 60) & 0xff; raw[o + 2] = 128; raw[o + 3] = 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

(function testPng() {
  const img = decodePng(makePng(4, 4));
  assert.strictEqual(img.width, 4); assert.strictEqual(img.height, 4);
  assert.strictEqual(img.rgb[3 * 1], 60); assert.strictEqual(img.rgb[2], 128);
  console.log("  PNG decoder: 4x4 RGBA round-trips");
})();

function f32(arr) { const b = Buffer.alloc(arr.length * 4); arr.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; }
function u16(arr) { const b = Buffer.alloc(arr.length * 2); arr.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; }
function makeGltf(pngBuf) {
  const S = 200;
  const faces = [
    { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  ];
  const pos = [], nrm = [], uv = [], idx = [];
  faces.forEach((f, fi) => { const base = fi * 4; f.v.forEach((p) => { pos.push(p[0] * S, p[1] * S, p[2] * S); nrm.push(...f.n); }); uv.push(0, 0, 1, 0, 1, 1, 0, 1); idx.push(base, base + 1, base + 2, base, base + 2, base + 3); });
  const posB = f32(pos), nrmB = f32(nrm), uvB = f32(uv), idxB = u16(idx);
  const pad = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const parts = [posB, nrmB, uvB, pad(idxB)];
  let off = 0; const views = parts.map((b) => { const v = { byteOffset: off, byteLength: b.length }; off += b.length; return v; });
  const bin = Buffer.concat(parts);
  return {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_lights_punctual"],
    extensions: { KHR_lights_punctual: { lights: [{ type: "point", color: [1, 0.8, 0.6], intensity: 300, range: 800 }, { type: "directional", color: [1, 1, 1], intensity: 120 }] } },
    scene: 0, scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ mesh: 0 }, { translation: [0, 400, 0], extensions: { KHR_lights_punctual: { light: 0 } } }, { rotation: [-0.383, 0, 0, 0.924], extensions: { KHR_lights_punctual: { light: 1 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: "cube", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: "data:image/png;base64," + pngBuf.toString("base64") }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: [-S, -S, -S], max: [S, S, S] },
      { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: uv.length / 2, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: views.map((v) => ({ buffer: 0, byteOffset: v.byteOffset, byteLength: v.byteLength })),
    buffers: [{ byteLength: bin.length, uri: "data:application/octet-stream;base64," + bin.toString("base64") }],
  };
}

(function testConvert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-gltf-"));
  const gltfPath = path.join(dir, "cube.gltf");
  fs.writeFileSync(gltfPath, JSON.stringify(makeGltf(makePng(4, 4))));
  const res = convert({ file: gltfPath, outDir: dir, log: () => { } });
  assert.ok(res.meshes >= 1, "at least one mesh");
  assert.strictEqual(res.lights, 2, "point + directional light carried");
  assert.ok(fs.existsSync(res.out), ".rom written");
  const v = verify(res.out);
  assert.ok(v.ok, "verify invariants:\n" + v.report);
  console.log("  glTF cube -> " + path.basename(res.out) + ": " + res.meshes + " mesh, " + res.lights + " lights, verify OK");
  fs.rmSync(dir, { recursive: true, force: true });
})();

(function testObjConvert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-obj-"));
  fs.writeFileSync(path.join(dir, "tex.png"), makePng(4, 4));
  fs.writeFileSync(path.join(dir, "cube.mtl"), "newmtl box\nKd 0.8 0.7 0.6\nmap_Kd tex.png\n");
  // a 400-uu cube, quads, with texcoords and one material
  const obj = [
    "mtllib cube.mtl",
    "v -200 -200 -200", "v 200 -200 -200", "v 200 200 -200", "v -200 200 -200",
    "v -200 -200 200", "v 200 -200 200", "v 200 200 200", "v -200 200 200",
    "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1",
    "vn 0 0 1", "vn 0 0 -1", "vn 0 1 0", "vn 0 -1 0", "vn 1 0 0", "vn -1 0 0",
    "usemtl box",
    "f 5/1/1 6/2/1 7/3/1 8/4/1",   // +Z
    "f 2/1/2 1/2/2 4/3/2 3/4/2",   // -Z
    "f 4/1/3 3/2/3 7/3/3 8/4/3",   // +Y
    "f 1/1/4 2/2/4 6/3/4 5/4/4",   // -Y
    "f 6/1/5 2/2/5 3/3/5 7/4/5",   // +X
    "f 1/1/6 5/2/6 8/3/6 4/4/6",   // -X
  ].join("\n");
  fs.writeFileSync(path.join(dir, "cube.obj"), obj);
  const res = convert({ file: path.join(dir, "cube.obj"), outDir: dir, log: () => { } });
  assert.ok(res.meshes >= 1, "obj: at least one mesh");
  const v = verify(res.out);
  assert.ok(v.ok, "obj verify invariants:\n" + v.report);
  console.log("  OBJ cube -> " + path.basename(res.out) + ": " + res.meshes + " mesh, verify OK");
  fs.rmSync(dir, { recursive: true, force: true });
})();

console.log("gltf.test.js: all checks passed");
