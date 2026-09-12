// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// meshoptimizer vertex/index buffer decoders, as Source 2 stores its MVTX/MIDX (and VBIB) mesh
// buffers. A C# -> JS port of ValveResourceFormat's MeshOptimizerVertexDecoder /
// MeshOptimizerIndexDecoder (themselves ports of zeux/meshoptimizer). Vertex codec versions 0 and 1
// (CS2 uses 1: a per-4-byte-lane control byte, a channel byte per lane picking 1/2/4-byte delta
// decode with a rotate, and byte groups whose 2-bit header picks a per-group bit width with a
// sentinel escape to a full byte). Index codec rebuilds a triangle list from edge/vertex FIFOs.
"use strict";

const REV = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let r = 0; for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b); REV[i] = r; }

const VERTEX_HEADER = 0xa0, INDEX_HEADER = 0xe0;
const BYTE_GROUP = 16, BLOCK_SIZE_BYTES = 8192, BLOCK_MAX = 256;
const BitsV0 = [0, 2, 4, 8], BitsV1 = [0, 1, 2, 4, 8];

const unzig8 = (v) => ((0 - (v & 1)) ^ (v >> 1)) & 0xff;
const unzig16 = (v) => ((0 - (v & 1)) ^ (v >> 1)) & 0xffff;
const rot32 = (v, r) => (((v << r) | (v >>> ((32 - r) & 31))) >>> 0);

function vertexBlockSize(vertexSize) {
  let r = (BLOCK_SIZE_BYTES / vertexSize) | 0;
  r &= ~(BYTE_GROUP - 1);
  return r < BLOCK_MAX ? r : BLOCK_MAX;
}

// Decode one 16-value byte group at `bits` width into dst[dstOff..dstOff+16); return the new src pos.
function decodeBytesGroup(src, pos, dst, dstOff, bits) {
  if (bits === 0) { for (let k = 0; k < 16; k++) dst[dstOff + k] = 0; return pos; }
  if (bits === 8) { for (let k = 0; k < 16; k++) dst[dstOff + k] = src[pos + k]; return pos + 16; }
  let dv, b;
  const next = (nbits) => {
    const enc = b >> (8 - nbits); b = (b << nbits) & 0xff;
    if (enc === (1 << nbits) - 1) { const v = src[pos + dv]; dv += 1; return v; }
    return enc;
  };
  if (bits === 1) {
    dv = 2;
    b = REV[src[pos]]; for (let k = 0; k < 8; k++) dst[dstOff + k] = next(1);
    b = REV[src[pos + 1]]; for (let k = 8; k < 16; k++) dst[dstOff + k] = next(1);
    return pos + dv;
  }
  if (bits === 2) {
    dv = 4;
    for (let g = 0; g < 4; g++) { b = src[pos + g]; for (let k = 0; k < 4; k++) dst[dstOff + g * 4 + k] = next(2); }
    return pos + dv;
  }
  if (bits === 4) {
    dv = 8;
    for (let g = 0; g < 8; g++) { b = src[pos + g]; for (let k = 0; k < 2; k++) dst[dstOff + g * 2 + k] = next(4); }
    return pos + dv;
  }
  throw new Error("meshopt: bad bit length " + bits);
}

function decodeBytes(src, pos, dst, dstOff, destLen, bitsTable) {
  if (destLen % BYTE_GROUP !== 0) throw new Error("meshopt: destLen not multiple of 16");
  const headerSize = (((destLen / BYTE_GROUP) | 0) + 3) >> 2;
  const headerOff = pos; pos += headerSize;
  for (let i = 0; i < destLen; i += BYTE_GROUP) {
    const ho = (i / BYTE_GROUP) | 0;
    const bitsk = (src[headerOff + (ho >> 2)] >> ((ho % 4) * 2)) & 3;
    pos = decodeBytesGroup(src, pos, dst, dstOff + i, bitsTable[bitsk]);
  }
  return pos;
}

// One channel-group of 4 byte-lanes, delta-decoded into `transposed` at column `tOff`.
function decodeDeltas1(size, buffer, transposed, tOff, vertexCount, vertexSize, lastVertex, lvOff, rot) {
  let bufBase = 0;
  for (let k = 0; k < 4; k += size) {
    let vertexOffset = k;
    let p = lastVertex[lvOff]; for (let j = 1; j < size; j++) p |= lastVertex[lvOff + j] << (8 * j);
    p >>>= 0;
    for (let i = 0; i < vertexCount; i++) {
      let v = buffer[bufBase + i]; for (let j = 1; j < size; j++) v |= buffer[bufBase + i + vertexCount * j] << (8 * j);
      v >>>= 0;
      if (size === 1) v = (unzig8(v) + p) & 0xffffffff;
      else if (size === 2) v = (unzig16(v) + p) & 0xffffffff;
      else v = (rot32(v, rot) ^ p) >>> 0;
      v >>>= 0;
      for (let j = 0; j < size; j++) transposed[tOff + vertexOffset + j] = (v >>> (j * 8)) & 0xff;
      p = v;
      vertexOffset += vertexSize;
    }
    bufBase += vertexCount * size;
    lvOff += size;
  }
}

function decodeVertexBlock(c, vertexData, vdOff, vertexCount, vertexSize, lastVertex, channels, version) {
  const vcAligned = (vertexCount + BYTE_GROUP - 1) & ~(BYTE_GROUP - 1);
  const controlSize = version === 0 ? 0 : vertexSize / 4;
  const controlOff = c.pos; c.pos += controlSize;
  const buffer = c.scratchBuf, transposed = c.scratchT;
  for (let k = 0; k < vertexSize; k += 4) {
    const ctrlByte = version === 0 ? 0 : c.buf[controlOff + k / 4];
    for (let j = 0; j < 4; j++) {
      const ctrl = (ctrlByte >> (j * 2)) & 3;
      const laneOff = j * vertexCount;
      if (ctrl === 3) { c.buf.copy(buffer, laneOff, c.pos, c.pos + vertexCount); c.pos += vertexCount; }
      else if (ctrl === 2) { buffer.fill(0, laneOff, laneOff + vertexCount); }
      else { c.pos = decodeBytes(c.buf, c.pos, buffer, laneOff, vcAligned, version === 0 ? BitsV0 : BitsV1.slice(ctrl)); }
    }
    const channel = version === 0 ? 0 : channels[k / 4];
    const type = channel & 3;
    if (type === 0) decodeDeltas1(1, buffer, transposed, k, vertexCount, vertexSize, lastVertex, k, 0);
    else if (type === 1) decodeDeltas1(2, buffer, transposed, k, vertexCount, vertexSize, lastVertex, k, 0);
    else if (type === 2) decodeDeltas1(4, buffer, transposed, k, vertexCount, vertexSize, lastVertex, k, (32 - (channel >> 4)) & 31);
    else throw new Error("meshopt: invalid channel type");
  }
  transposed.copy(vertexData, vdOff, 0, vertexCount * vertexSize);
  transposed.copy(lastVertex, 0, vertexSize * (vertexCount - 1), vertexSize * (vertexCount - 1) + vertexSize);
}

function decodeVertexBuffer(vertexCount, vertexSize, buffer) {
  if (vertexSize <= 0 || vertexSize > 256 || vertexSize % 4 !== 0) throw new Error("meshopt: bad vertexSize " + vertexSize);
  if ((buffer[0] & 0xf0) !== VERTEX_HEADER) throw new Error("meshopt: bad vertex header 0x" + buffer[0].toString(16));
  const version = buffer[0] & 0x0f;
  if (version > 1) throw new Error("meshopt: vertex version " + version);
  const body = buffer.subarray(1);
  const tailSize = vertexSize + (version === 0 ? 0 : vertexSize / 4);
  const tailMin = version === 0 ? 32 : 24;
  const tailPadded = tailSize < tailMin ? tailMin : tailSize;
  if (body.length < tailPadded) throw new Error("meshopt: buffer too small for tail");
  const out = Buffer.alloc(vertexCount * vertexSize);
  const lastVertex = Buffer.alloc(vertexSize);
  body.copy(lastVertex, 0, body.length - tailSize, body.length - tailSize + vertexSize);
  const channels = version === 0 ? null : body.subarray(body.length - tailSize + vertexSize, body.length - tailSize + vertexSize + vertexSize / 4);
  const bs = vertexBlockSize(vertexSize);
  const c = { buf: body, pos: 0, scratchBuf: Buffer.alloc(BLOCK_MAX * 4), scratchT: Buffer.alloc(BLOCK_SIZE_BYTES) };
  let vo = 0;
  while (vo < vertexCount) {
    const blk = vo + bs < vertexCount ? bs : vertexCount - vo;
    decodeVertexBlock(c, out, vo * vertexSize, blk, vertexSize, lastVertex, channels, version);
    vo += blk;
  }
  if (body.length - c.pos !== tailPadded) throw new Error("meshopt: tail size mismatch (" + (body.length - c.pos) + " vs " + tailPadded + ")");
  return out;
}

// --- index buffer ---
function decodeVByte(data, cur) { let lead = data[cur.p++]; if (lead < 128) return lead >>> 0; let result = lead & 127, shift = 7; for (let i = 0; i < 4; i++) { const g = data[cur.p++]; result |= (g & 127) << shift; shift += 7; if (g < 128) break; } return result >>> 0; }
function decodeIndexDelta(data, last, cur) { const v = decodeVByte(data, cur); const d = ((v >>> 1) ^ (-(v & 1))) >>> 0; return (last + d) >>> 0; }

function decodeIndexBuffer(indexCount, indexSize, buffer) {
  if (indexCount % 3 !== 0) throw new Error("meshopt: indexCount not multiple of 3");
  if (indexSize !== 2 && indexSize !== 4) throw new Error("meshopt: indexSize must be 2 or 4");
  const dataOffset = 1 + (indexCount / 3);
  if (buffer.length < dataOffset + 16) throw new Error("meshopt: index buffer too short");
  if ((buffer[0] & 0xf0) !== INDEX_HEADER) throw new Error("meshopt: bad index header 0x" + buffer[0].toString(16));
  const version = buffer[0] & 0x0f;
  if (version > 1) throw new Error("meshopt: index version " + version);
  const vfifo = new Uint32Array(16), efA = new Uint32Array(16), efB = new Uint32Array(16);
  let efOff = 0, vfOff = 0, next = 0, last = 0;
  const fecmax = version >= 1 ? 13 : 15;
  let bufferIndex = 1;
  const data = buffer.subarray(dataOffset, buffer.length - 16);
  const codeaux = buffer.subarray(buffer.length - 16);
  const out = Buffer.alloc(indexCount * indexSize);
  const cur = { p: 0 };
  const pushV = (v, cond) => { vfifo[vfOff] = v; vfOff = (vfOff + (cond ? 1 : 0)) & 15; };
  const pushE = (a, b) => { efA[efOff] = a; efB[efOff] = b; efOff = (efOff + 1) & 15; };
  const write = (i, a, b, c) => {
    const o = i * indexSize;
    if (indexSize === 2) { out.writeUInt16LE(a & 0xffff, o); out.writeUInt16LE(b & 0xffff, o + 2); out.writeUInt16LE(c & 0xffff, o + 4); }
    else { out.writeUInt32LE(a >>> 0, o); out.writeUInt32LE(b >>> 0, o + 4); out.writeUInt32LE(c >>> 0, o + 8); }
  };
  for (let i = 0; i < indexCount; i += 3) {
    const codetri = buffer[bufferIndex++];
    if (codetri < 0xf0) {
      const fe = codetri >> 4;
      const ei = (efOff - 1 - fe) & 15;
      const a = efA[ei], b = efB[ei];
      let c;
      const fec = codetri & 15;
      if (fec < fecmax) {
        const fec0 = fec === 0;
        c = fec0 ? next : vfifo[(vfOff - 1 - fec) & 15];
        next += fec0 ? 1 : 0;
        pushV(c, fec0);
      } else {
        c = last = (fec !== 15) ? (last + (fec - (fec ^ 3))) >>> 0 : decodeIndexDelta(data, last, cur);
        pushV(c, true);
      }
      pushE(c, b); pushE(a, c);
      write(i, a, b, c);
    } else if (codetri < 0xfe) {
      const ca = codeaux[codetri & 15];
      const feb = ca >> 4, fec = ca & 15;
      const a = next++;
      const feb0 = feb === 0;
      const b = feb0 ? next : vfifo[(vfOff - feb) & 15];
      next += feb0 ? 1 : 0;
      const fec0 = fec === 0;
      const c = fec0 ? next : vfifo[(vfOff - fec) & 15];
      next += fec0 ? 1 : 0;
      write(i, a, b, c);
      pushV(a, true); pushV(b, feb0); pushV(c, fec0);
      pushE(b, a); pushE(c, b); pushE(a, c);
    } else {
      const ca = data[cur.p++];
      const fea = codetri === 0xfe ? 0 : 15;
      const feb = ca >> 4, fec = ca & 15;
      if (ca === 0) next = 0;
      let a = fea === 0 ? next++ : 0;
      let b = feb === 0 ? next++ : vfifo[(vfOff - feb) & 15];
      let c = fec === 0 ? next++ : vfifo[(vfOff - fec) & 15];
      if (fea === 15) last = a = decodeIndexDelta(data, last, cur);
      if (feb === 15) last = b = decodeIndexDelta(data, last, cur);
      if (fec === 15) last = c = decodeIndexDelta(data, last, cur);
      write(i, a, b, c);
      pushV(a, true); pushV(b, feb === 0 || feb === 15); pushV(c, fec === 0 || fec === 15);
      pushE(b, a); pushE(c, b); pushE(a, c);
    }
  }
  if (cur.p !== data.length) throw new Error("meshopt: index data not fully consumed (" + cur.p + "/" + data.length + ")");
  return out;
}

module.exports = { decodeVertexBuffer, decodeIndexBuffer };
