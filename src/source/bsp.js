// Source engine BSP (VBSP) reader -> the same scene shape the glTF route consumes.
//
// Covers Source 1 maps: Counter-Strike: Source / CS:GO (v19-21), Half-Life 2, Garry's Mod, Left 4
// Dead (all VBSP). It reads the world model's brush faces, their texinfo UVs and material names, and
// returns { prims, materials, lights, decodeMaterialImage, applyMat4, applyMat3 } - so src/gltf builds
// the .rom from it exactly like a 3D model. Source is Z-up like GoldSrc, so the route feeds axes
// [0,1,2] with a Y flip.
//
// Not yet: displacements (dispinfo terrain), static props (external .mdl), and VTF/VMT textures - the
// materials come out as flat colours hashed from their name until the texture pipeline lands. Tool
// surfaces (sky, nodraw, skip, hint, trigger) are dropped, as on the GoldSrc route.
"use strict";

const fs = require("fs");
const { decodeLump, isValveLzma } = require("./lzma");

const LUMP = { ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, TEXINFO: 6, FACES: 7, EDGES: 12, SURFEDGES: 13, MODELS: 14, DISPINFO: 26, PAKFILE: 40, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44 };
// texinfo flags that mean "not a drawable world surface"
const SURF_SKIP_MASK = 0x4 /*sky*/ | 0x40 /*trigger*/ | 0x80 /*nodraw*/ | 0x100 /*hint*/ | 0x200 /*skip*/ | 0x2 /*sky2d*/;

function readLumps(buf) {
  const magic = buf.toString("latin1", 0, 4);
  if (magic !== "VBSP") throw new Error("not a Source BSP (magic " + magic + ")");
  const version = buf.readInt32LE(4);
  const lumps = [];
  for (let i = 0; i < 64; i++) { const o = 8 + i * 16; lumps.push({ ofs: buf.readInt32LE(o), len: buf.readInt32LE(o + 4), ver: buf.readInt32LE(o + 8) }); }
  return { version, lumps };
}
// A lump may be individually LZMA-compressed (common in Left 4 Dead 2 / CS:GO): decode transparently.
function lumpBuf(buf, lumps, id) {
  const raw = buf.subarray(lumps[id].ofs, lumps[id].ofs + lumps[id].len);
  return isValveLzma(raw, 0) ? decodeLump(raw) : raw;
}

function cString(buf, off) { let e = off; while (e < buf.length && buf[e] !== 0) e++; return buf.toString("latin1", off, e); }

// A stable colour per material name, so the flat-shaded map still reads as distinct surfaces until
// the VTF texture pipeline lands.
function hashColor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  const r = 90 + (h & 0x7f), g = 90 + ((h >> 8) & 0x7f), b = 90 + ((h >> 16) & 0x7f);
  return [r / 255, g / 255, b / 255, 1];
}

function loadSourceScene(file, log) {
  const buf = fs.readFileSync(file);
  const { version, lumps } = readLumps(buf);

  const verts = lumpBuf(buf, lumps, LUMP.VERTEXES);        // FVector[]
  const nVerts = verts.length / 12;
  const vert = (i) => [verts.readFloatLE(i * 12), verts.readFloatLE(i * 12 + 4), verts.readFloatLE(i * 12 + 8)];

  const edgesB = lumpBuf(buf, lumps, LUMP.EDGES);          // u16[2][]
  const edge = (i) => [edgesB.readUInt16LE(i * 4), edgesB.readUInt16LE(i * 4 + 2)];
  const surfedges = lumpBuf(buf, lumps, LUMP.SURFEDGES);   // i32[]
  const nSurfedges = surfedges.length / 4;

  const planesB = lumpBuf(buf, lumps, LUMP.PLANES);        // normal(12)+dist(4)+type(4) = 20
  const planeNormal = (i) => [planesB.readFloatLE(i * 20), planesB.readFloatLE(i * 20 + 4), planesB.readFloatLE(i * 20 + 8)];

  // texinfo: textureVecs[2][4] (32) + lightmapVecs[2][4] (32) + flags(4) + texdata(4) = 72
  const texinfoB = lumpBuf(buf, lumps, LUMP.TEXINFO);
  const texinfo = (i) => {
    const o = i * 72;
    return {
      s: [texinfoB.readFloatLE(o), texinfoB.readFloatLE(o + 4), texinfoB.readFloatLE(o + 8), texinfoB.readFloatLE(o + 12)],
      t: [texinfoB.readFloatLE(o + 16), texinfoB.readFloatLE(o + 20), texinfoB.readFloatLE(o + 24), texinfoB.readFloatLE(o + 28)],
      flags: texinfoB.readInt32LE(o + 64), texdata: texinfoB.readInt32LE(o + 68),
    };
  };
  // texdata: reflectivity(12) + nameStringTableID(4) + width(4) + height(4) + view_w(4) + view_h(4) = 32
  const texdataB = lumpBuf(buf, lumps, LUMP.TEXDATA);
  const texdata = (i) => ({ nameId: texdataB.readInt32LE(i * 32 + 12), width: texdataB.readInt32LE(i * 32 + 16), height: texdataB.readInt32LE(i * 32 + 20) });
  const strTable = lumpBuf(buf, lumps, LUMP.TEXDATA_STRING_TABLE);
  const strData = lumpBuf(buf, lumps, LUMP.TEXDATA_STRING_DATA);
  const texName = (nameId) => cString(strData, strTable.readInt32LE(nameId * 4));

  // face: planenum(u16) side(u8) onNode(u8) firstedge(i32) numedges(i16) texinfo(i16) dispinfo(i16)
  //       surfaceFogVolumeID(i16) styles[4](u8) lightofs(i32) area(f32) lmMins[2](i32) lmSize[2](i32)
  //       origFace(i32) numPrims(u16) firstPrimID(u16) smoothingGroups(u32) = 56
  const facesB = lumpBuf(buf, lumps, LUMP.FACES);
  const FACE = 56;
  const nFaces = facesB.length / FACE;
  const face = (i) => {
    const o = i * FACE;
    return { planenum: facesB.readUInt16LE(o), side: facesB[o + 2], firstedge: facesB.readInt32LE(o + 4), numedges: facesB.readInt16LE(o + 8), texinfo: facesB.readInt16LE(o + 10), dispinfo: facesB.readInt16LE(o + 12) };
  };

  // dmodel_t (48): mins(12) maxs(12) origin(12) headnode(4) firstface(4)@40 numfaces(4)@44
  const modelsB = lumpBuf(buf, lumps, LUMP.MODELS);
  const world = { firstface: modelsB.readInt32LE(40), numfaces: modelsB.readInt32LE(44) };

  // Winding: gather the face's polygon vertices via surfedges -> edges -> vertexes.
  const faceVerts = (f) => {
    const out = [];
    for (let k = 0; k < f.numedges; k++) {
      const se = surfedges.readInt32LE((f.firstedge + k) * 4);
      const e = edge(Math.abs(se));
      out.push(se >= 0 ? e[0] : e[1]);
    }
    return out;
  };

  // Group faces by material (texdata), build one prim per material.
  const groups = new Map();
  const materials = [];
  const matIndex = new Map();
  const stats = { faces: 0, tris: 0, skipped: 0, tool: 0, disp: 0 };
  for (let fi = world.firstface; fi < world.firstface + world.numfaces; fi++) {
    const f = face(fi);
    if (f.dispinfo >= 0) { stats.disp++; continue; }          // displacement surfaces: not yet
    if (f.texinfo < 0) { stats.skipped++; continue; }
    const ti = texinfo(f.texinfo);
    if (ti.flags & SURF_SKIP_MASK) { stats.tool++; continue; }
    const td = texdata(ti.texdata);
    const name = texName(td.nameId);
    let mi = matIndex.get(name);
    if (mi === undefined) { mi = materials.length; matIndex.set(name, mi); materials.push({ name, factor: hashColor(name), imageIndex: null }); }
    let g = groups.get(mi);
    if (!g) { g = { pos: [], nrm: [], uv: [] }; groups.set(mi, g); }

    const vi = faceVerts(f);
    if (vi.length < 3) { stats.skipped++; continue; }
    let normal = planeNormal(f.planenum);
    if (f.side) normal = [-normal[0], -normal[1], -normal[2]];
    const tw = td.width || 1, th = td.height || 1;
    const uvOf = (p) => [(ti.s[0] * p[0] + ti.s[1] * p[1] + ti.s[2] * p[2] + ti.s[3]) / tw, (ti.t[0] * p[0] + ti.t[1] * p[1] + ti.t[2] * p[2] + ti.t[3]) / th];
    const P = vi.map(vert);
    const UV = P.map(uvOf);
    // fan triangulate; expand per corner (mesh.js re-chunks anyway)
    for (let k = 1; k + 1 < P.length; k++) {
      for (const idx of [0, k, k + 1]) {
        g.pos.push(P[idx][0], P[idx][1], P[idx][2]);
        g.nrm.push(normal[0], normal[1], normal[2]);
        g.uv.push(UV[idx][0], UV[idx][1]);
      }
      stats.tris++;
    }
    stats.faces++;
  }

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const prims = [];
  for (const [mi, g] of groups) {
    if (!g.pos.length) continue;
    const n = g.pos.length / 3;
    prims.push({ pos: { data: g.pos, count: n }, nrm: { data: g.nrm, count: n }, uv: { data: g.uv, count: g.uv.length / 2 }, indices: Array.from({ length: n }, (_, i) => i), material: mi, matrix: identity });
  }

  const applyMat4 = (m, p) => p;               // Source verts are already world-space, matrix is identity
  const applyMat3 = (m, n) => n;
  const decodeMaterialImage = () => { throw new Error("no texture (VTF pipeline not wired)"); };

  if (log) log("Source BSP v" + version + ": " + stats.faces + " world faces -> " + stats.tris + " tris in " + prims.length + " material(s) (" + stats.tool + " tool, " + stats.disp + " displacement, " + stats.skipped + " skipped)");
  return { prims, materials, lights: [], decodeMaterialImage, applyMat4, applyMat3, version, stats };
}

module.exports = { loadSourceScene, readLumps };
