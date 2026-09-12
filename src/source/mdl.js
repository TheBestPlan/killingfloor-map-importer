// Source studiomdl reader: .mdl (structure + materials) + .vvd (vertices) + .vtx (index strips) ->
// mesh geometry. Static props (prop_static) reference these; a Garry's Mod DBD map is almost entirely
// props, so without this the map is an empty shell.
//
// Only what a rigid static prop needs is read: LOD0 geometry, positions/normals/UVs, and one material
// name per mesh. Bones/animation/flexes are ignored. Correlates the parallel .mdl and .vtx bodypart/
// model/mesh hierarchies to map each .vtx strip vertex back to a .vvd vertex.
"use strict";

// --- .vvd: LOD0 vertices ---------------------------------------------------------------------------
function readVvd(vvd) {
  if (vvd.toString("latin1", 0, 4) !== "IDSV") return null;
  const numLODVertexes0 = vvd.readInt32LE(16);       // numLODVertexes[0]
  const numFixups = vvd.readInt32LE(48);
  const fixupTableStart = vvd.readInt32LE(52);
  const vertexDataStart = vvd.readInt32LE(56);
  const VSZ = 48;                                     // boneweights(16)+pos(12)+normal(12)+uv(8)
  const readVert = (o) => ({
    pos: [vvd.readFloatLE(o + 16), vvd.readFloatLE(o + 20), vvd.readFloatLE(o + 24)],
    normal: [vvd.readFloatLE(o + 28), vvd.readFloatLE(o + 32), vvd.readFloatLE(o + 36)],
    uv: [vvd.readFloatLE(o + 40), vvd.readFloatLE(o + 44)],
  });
  if (numFixups === 0) {
    const verts = new Array(numLODVertexes0);
    for (let i = 0; i < numLODVertexes0; i++) verts[i] = readVert(vertexDataStart + i * VSZ);
    return { verts, hasFixups: false };
  }
  // Apply the fixup table: copy runs of source vertices whose LOD >= 0 into the LOD0 stream.
  const verts = [];
  for (let f = 0; f < numFixups; f++) {
    const fo = fixupTableStart + f * 12;
    const lod = vvd.readInt32LE(fo), src = vvd.readInt32LE(fo + 4), n = vvd.readInt32LE(fo + 8);
    if (lod < 0) continue;
    for (let i = 0; i < n; i++) verts.push(readVert(vertexDataStart + (src + i) * VSZ));
  }
  return { verts, hasFixups: true };
}

// --- .mdl: per-mesh material + vertex layout, and texture names -----------------------------------
function readMdl(mdl) {
  const numtextures = mdl.readInt32LE(204), textureindex = mdl.readInt32LE(208);
  const numcdtextures = mdl.readInt32LE(212), cdtextureindex = mdl.readInt32LE(216);
  const numbodyparts = mdl.readInt32LE(232), bodypartindex = mdl.readInt32LE(236);
  const cstr = (off) => { let e = off; while (e < mdl.length && mdl[e] !== 0) e++; return mdl.toString("latin1", off, e); };
  const textures = [];
  for (let i = 0; i < numtextures; i++) {
    const o = textureindex + i * 64;
    textures.push(cstr(o + mdl.readInt32LE(o)).replace(/\\/g, "/"));
  }
  // cdtexture directories: where the material .vmt files sit (e.g. "props_dbdmap/structures/").
  const cdtextures = [];
  for (let i = 0; i < numcdtextures; i++) cdtextures.push(cstr(mdl.readInt32LE(cdtextureindex + i * 4)).replace(/\\/g, "/"));
  // bodypart -> model -> mesh, collecting vertex bases + material index (parallel to the .vtx tree)
  const bodyparts = [];
  for (let bp = 0; bp < numbodyparts; bp++) {
    const bo = bodypartindex + bp * 16;
    const nummodels = mdl.readInt32LE(bo + 4), modelindex = bo + mdl.readInt32LE(bo + 12);
    const models = [];
    for (let m = 0; m < nummodels; m++) {
      const mo = modelindex + m * 148;
      const nummeshes = mdl.readInt32LE(mo + 72), meshindex = mo + mdl.readInt32LE(mo + 76);
      const vertexBase = Math.floor(mdl.readInt32LE(mo + 84) / 48);   // vertexindex is a byte offset
      const meshes = [];
      for (let me = 0; me < nummeshes; me++) {
        const eo = meshindex + me * 116;
        meshes.push({ material: mdl.readInt32LE(eo), vertexoffset: mdl.readInt32LE(eo + 12) });
      }
      models.push({ vertexBase, meshes });
    }
    bodyparts.push({ models });
  }
  return { textures, cdtextures, bodyparts };
}

// --- .vtx: index strips, mapped back to .vvd via the .mdl layout ----------------------------------
function readVtx(vtx, mdlTree, wantLod) {
  const numBodyParts = vtx.readInt32LE(28), bodyPartOffset = vtx.readInt32LE(32);
  const out = [];   // { material, indices:[globalVvdIndex,...] }
  for (let bp = 0; bp < numBodyParts; bp++) {
    const bpo = bodyPartOffset + bp * 8;
    const numModels = vtx.readInt32LE(bpo), modelOffset = bpo + vtx.readInt32LE(bpo + 4);
    const mdlBp = mdlTree.bodyparts[bp]; if (!mdlBp) continue;
    for (let m = 0; m < numModels; m++) {
      const mo = modelOffset + m * 8;
      const numLODs = vtx.readInt32LE(mo), lodOffset = mo + vtx.readInt32LE(mo + 4);
      const mdlModel = mdlBp.models[m]; if (!mdlModel) continue;
      const lod = Math.max(0, Math.min(wantLod || 0, numLODs - 1));   // lower LOD = fewer triangles
      const lo = lodOffset + lod * 12;                  // ModelLODHeader is 12 bytes
      const numMeshes = vtx.readInt32LE(lo), meshOffset = lo + vtx.readInt32LE(lo + 4);
      for (let me = 0; me < numMeshes; me++) {
        const meo = meshOffset + me * 9;
        const numStripGroups = vtx.readInt32LE(meo), sgOffset = meo + vtx.readInt32LE(meo + 4);
        const mdlMesh = mdlModel.meshes[me]; if (!mdlMesh) continue;
        const vbase = mdlModel.vertexBase + mdlMesh.vertexoffset;
        const meshOut = { material: mdlMesh.material, indices: [] };
        for (let sg = 0; sg < numStripGroups; sg++) {
          const so = sgOffset + sg * 25;
          const numVerts = vtx.readInt32LE(so), vertOffset = so + vtx.readInt32LE(so + 4);
          const numIndices = vtx.readInt32LE(so + 8), indexOffset = so + vtx.readInt32LE(so + 12);
          // stripgroup vertex i -> origMeshVertID (u16 at +4 of the 9-byte vertex)
          const origVert = (i) => vtx.readUInt16LE(vertOffset + i * 9 + 4);
          for (let i = 0; i < numIndices; i++) {
            const sgv = vtx.readUInt16LE(indexOffset + i * 2);
            if (sgv >= numVerts) continue;
            meshOut.indices.push(vbase + origVert(sgv));
          }
        }
        if (meshOut.indices.length) out.push(meshOut);
      }
    }
  }
  return out;
}

// Returns { verts:[{pos,normal,uv}], meshes:[{material(name), indices}] } or null.
function loadModel(mdlBuf, vvdBuf, vtxBuf, wantLod) {
  if (!mdlBuf || !vvdBuf || !vtxBuf) return null;
  const vv = readVvd(vvdBuf);
  if (!vv || !vv.verts.length) return null;
  const verts = vv.verts;
  const tree = readMdl(mdlBuf);
  // Fixup models remap vertices per LOD; only LOD0 is reconstructed here, so stay on LOD0 for those.
  const lod = vv.hasFixups ? 0 : (wantLod || 0);
  const vtxMeshes = readVtx(vtxBuf, tree, lod);
  const meshes = vtxMeshes.map((m) => ({
    material: tree.textures[m.material] || tree.textures[0] || null,
    indices: m.indices.filter((i) => i < verts.length),
  })).filter((m) => m.indices.length >= 3);
  if (!meshes.length) return null;
  return { verts, meshes, cdtextures: tree.cdtextures || [] };
}

module.exports = { loadModel, readVvd, readMdl, readVtx };
