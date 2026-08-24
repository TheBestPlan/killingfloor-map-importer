// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Source 2 binary KV3 decoder (KV3\x01..\x05, magic 0x4B5633NN). A compiled resource's DATA / MDAT /
// physics blocks are KV3: a header of buffer sizes and element counts, one or two LZ4/zstd-compressed
// buffers, then a recursively typed value tree whose scalars are pulled from per-width sub-buffers
// (1/2/4/8-byte) and whose strings come from a string table. Ported field-for-field from
// ValveResourceFormat's BinaryKV3 (versions 2-5; v5 is what CS2 maps use, with its split
// buffer1=strings / buffer2=values+types+object-lengths). Returns a plain JS object/array/number tree.
"use strict";

const lz4 = require("./lz4");
const zlib = require("zlib");

// KV3BinaryNodeType (BinaryKV3.NodeType.cs) - 1-based, not the values a casual reading assumes.
const T = {
  NULL: 1, BOOL: 2, INT64: 3, UINT64: 4, DOUBLE: 5, STRING: 6, BLOB: 7, ARRAY: 8, OBJECT: 9,
  ARRAY_TYPED: 10, INT32: 11, UINT32: 12, TRUE: 13, FALSE: 14, I64_ZERO: 15, I64_ONE: 16,
  D_ZERO: 17, D_ONE: 18, FLOAT: 19, INT16: 20, UINT16: 21, INT32_AS_BYTE: 23,
  ARRAY_TYPE_BYTE_LENGTH: 24, ARRAY_TYPE_AUXILIARY_BUFFER: 25,
};

// A cursor over one decompressed buffer's four width-partitioned regions.
function subBuffers(buf, counts, startOffset, withStrings) {
  const b = {};
  let o = startOffset;
  const align = (n) => { o = (o + (n - 1)) & ~(n - 1); };
  // Align only BEFORE a non-empty region: an empty (count 0) region carries no alignment padding, so
  // aligning for it advances the cursor past where the type stream actually starts (off-by-4/8 desync
  // that read the root value as 0 for ~4/5 of CS2 map meshes - the ground/wall shell).
  b.b1 = { buf, off: o, end: o + counts.c1 }; o += counts.c1;
  if (counts.c2) align(2); b.b2 = { buf, off: o, end: o + counts.c2 * 2 }; o += counts.c2 * 2;
  if (counts.c4) align(4); b.b4 = { buf, off: o, end: o + counts.c4 * 4 }; o += counts.c4 * 4;
  if (counts.c8) align(8); b.b8 = { buf, off: o, end: o + counts.c8 * 8 }; o += counts.c8 * 8;
  b._after = o;
  return b;
}

function parseKV3(buf, start) {
  start = start || 0;
  const magic = buf.readUInt32LE(start);
  if (magic === 0x03564b56) throw new Error("KV3 legacy v0 (VKV3) not supported");
  if ((magic & 0xffffff00) >>> 0 !== 0x4b563300) throw new Error("not KV3 (magic 0x" + magic.toString(16) + ")");
  const version = magic & 0xff;
  if (version < 2) throw new Error("KV3 v" + version + " not supported");
  let p = start + 4;
  const i32 = () => { const v = buf.readInt32LE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16LE(p); p += 2; return v; };
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };

  p += 16;                                   // format GUID
  const compressionMethod = u32();
  const compressionDictionaryId = u16();
  const compressionFrameSize = u16();
  const countBytes1 = i32();
  const countBytes4 = i32();
  const countBytes8 = i32();
  const countTypes = i32();
  const countObjects = u16();
  const countArrays = u16();
  const sizeUncompressedTotal = i32();
  const sizeCompressedTotal = i32();
  const countBlocks = i32();
  const sizeBinaryBlobsBytes = i32();

  let countBytes2 = 0;
  if (version >= 4) { countBytes2 = i32(); i32(); /* sizeBlockCompressedSizesBytes */ }

  let sizeUncompressedBuffer1 = sizeUncompressedTotal, sizeCompressedBuffer1 = sizeCompressedTotal;
  let sizeUncompressedBuffer2 = 0, sizeCompressedBuffer2 = 0;
  let c1b2 = 0, c2b2 = 0, c4b2 = 0, c8b2 = 0, countObjects_b2 = 0;
  if (version >= 5) {
    sizeUncompressedBuffer1 = i32(); sizeCompressedBuffer1 = i32();
    sizeUncompressedBuffer2 = i32(); sizeCompressedBuffer2 = i32();
    c1b2 = i32(); c2b2 = i32(); c4b2 = i32(); c8b2 = i32();
    i32();                                   // unk13
    countObjects_b2 = i32(); i32(); i32();   // countArrays_b2, unk16
  }

  const method = compressionMethod;          // 0 none, 1 lz4, 2 zstd
  const decompress = (compSize, uncompSize) => {
    if (uncompSize === 0) return Buffer.alloc(0);
    if (method === 0) { const out = buf.subarray(p, p + uncompSize); p += uncompSize; return out; }
    if (method === 1) { const out = lz4.decompressBlock(buf, uncompSize, p, p + compSize); p += compSize; return out; }
    if (method === 2) { const out = zlib.zstdDecompressSync(buf.subarray(p, p + compSize)); p += compSize; return out; }
    throw new Error("KV3 compression method " + method + " unsupported");
  };

  const buffer1 = decompress(sizeCompressedBuffer1, sizeUncompressedBuffer1);
  const buffer2raw = version >= 5 ? decompress(sizeCompressedBuffer2, sizeUncompressedBuffer2) : buffer1;

  // --- buffer1: strings (v5) or the whole thing (v2-4) ---
  const ctx = {
    version, strings: [],
    types: null, typeOff: 0,
    objLengths: null, objOff: 0,
    blobLengths: null, blobOff: 0, blobs: null, blobsOff: 0,
    buffer: null, aux: null,
  };

  function readNullTerm(sb) {
    let e = sb.off; while (e < sb.buf.length && sb.buf[e] !== 0) e++;
    const s = sb.buf.toString("utf8", sb.off, e); sb.off = e + 1; return s;
  }

  if (version >= 5) {
    const b1 = subBuffers(buffer1, { c1: countBytes1, c2: countBytes2, c4: countBytes4, c8: countBytes8 }, 0, true);
    const countStrings = buffer1.readInt32LE(b1.b4.off); b1.b4.off += 4;
    for (let i = 0; i < countStrings; i++) ctx.strings.push(readNullTerm(b1.b1));
    ctx.aux = b1;                            // auxiliary buffer = buffer1 byte regions

    // buffer2: object lengths, then byte regions, then types
    let o = 0;
    ctx.objLengths = buffer2raw; ctx.objOff = 0; const objBytes = countObjects_b2 * 4; o = objBytes;
    const b2 = subBuffers(buffer2raw, { c1: c1b2, c2: c2b2, c4: c4b2, c8: c8b2 }, o, false);
    ctx.buffer = b2;
    ctx.types = buffer2raw; ctx.typeOff = b2._after;
    let after = b2._after + countTypes;
    if (countBlocks === 0) { /* trailer 0xFFEEDD00 at `after` */ after += 4; }
    else { ctx.blobSizesOff = after; }
    ctx.objLenLimit = objBytes;
  } else {
    // v2-4: one buffer holds bytes1/bytes4/bytes8 (+bytes2 v4), then strings, then types.
    const counts = { c1: countBytes1, c2: countBytes2, c4: countBytes4, c8: countBytes8 };
    const b = subBuffers(buffer1, counts, 0, true);
    const countStrings = buffer1.readInt32LE(b.b4.off); b.b4.off += 4;
    // strings live right after bytes8 region in v2-4
    let so = b._after;
    for (let i = 0; i < countStrings; i++) { let e = so; while (buffer1[e] !== 0) e++; ctx.strings.push(buffer1.toString("utf8", so, e)); so = e + 1; }
    ctx.buffer = b; ctx.aux = b;
    ctx.types = buffer1; ctx.typeOff = so;
    ctx.objLengths = null;                    // v2-4 read object length from bytes4
  }

  // --- recursive value reader ---
  const rd4 = (sb) => { const v = sb.buf.readInt32LE(sb.off); sb.off += 4; return v; };
  const rdU4 = (sb) => { const v = sb.buf.readUInt32LE(sb.off); sb.off += 4; return v; };

  function readType() {
    let databyte = ctx.types[ctx.typeOff++];
    let flag = 0;
    if (version >= 3) {
      if (databyte & 0x80) { databyte &= 0x3f; flag = ctx.types[ctx.typeOff++]; }
    } else if (databyte & 0x80) { databyte &= 0x7f; flag = ctx.types[ctx.typeOff++]; }
    return databyte;
  }

  function objectLength() {
    if (version >= 5) { const v = ctx.objLengths.readInt32LE(ctx.objOff); ctx.objOff += 4; return v; }
    const v = ctx.buffer.b4.buf.readInt32LE(ctx.buffer.b4.off); ctx.buffer.b4.off += 4; return v;
  }

  function readValue(datatype) {
    const b = ctx.buffer;
    switch (datatype) {
      case T.NULL: return null;
      case T.TRUE: return true;
      case T.FALSE: return false;
      case T.I64_ZERO: return 0;
      case T.I64_ONE: return 1;
      case T.D_ZERO: return 0.0;
      case T.D_ONE: return 1.0;
      case T.BOOL: { const v = b.b1.buf[b.b1.off] === 1; b.b1.off += 1; return v; }
      case T.INT32_AS_BYTE: { const v = b.b1.buf.readInt8(b.b1.off); b.b1.off += 1; return v; }
      case T.INT16: { const v = b.b2.buf.readInt16LE(b.b2.off); b.b2.off += 2; return v; }
      case T.UINT16: { const v = b.b2.buf.readUInt16LE(b.b2.off); b.b2.off += 2; return v; }
      case T.INT32: { const v = b.b4.buf.readInt32LE(b.b4.off); b.b4.off += 4; return v; }
      case T.UINT32: { const v = b.b4.buf.readUInt32LE(b.b4.off); b.b4.off += 4; return v; }
      case T.FLOAT: { const v = b.b4.buf.readFloatLE(b.b4.off); b.b4.off += 4; return v; }
      case T.INT64: { const v = b.b8.buf.readBigInt64LE(b.b8.off); b.b8.off += 8; return Number(v); }
      case T.UINT64: { const v = b.b8.buf.readBigUInt64LE(b.b8.off); b.b8.off += 8; return Number(v); }
      case T.DOUBLE: { const v = b.b8.buf.readDoubleLE(b.b8.off); b.b8.off += 8; return v; }
      case T.STRING: { const id = b.b4.buf.readInt32LE(b.b4.off); b.b4.off += 4; return id === -1 ? "" : ctx.strings[id]; }
      case T.BLOB: {
        if (version < 2) { const n = rd4(b.b4); const out = b.b1.buf.subarray(b.b1.off, b.b1.off + n); b.b1.off += n; return out; }
        // v2+: blob length from the blob-sizes list, data from the blob buffer (may be absent here)
        if (ctx.blobLengths == null) return Buffer.alloc(0);
        const n = ctx.blobLengths.readInt32LE(ctx.blobOff); ctx.blobOff += 4;
        const out = ctx.blobs ? ctx.blobs.subarray(ctx.blobsOff, ctx.blobsOff + n) : Buffer.alloc(0);
        ctx.blobsOff += n; return out;
      }
      case T.ARRAY: { const n = rd4(b.b4); const arr = new Array(n); for (let i = 0; i < n; i++) arr[i] = parseNode(true); return arr; }
      case T.ARRAY_TYPED:
      case T.ARRAY_TYPE_BYTE_LENGTH: {
        let n;
        if (datatype === T.ARRAY_TYPE_BYTE_LENGTH) { n = b.b1.buf[b.b1.off]; b.b1.off += 1; }
        else { n = rd4(b.b4); }
        const sub = readType();
        const arr = new Array(n); for (let i = 0; i < n; i++) arr[i] = readValue(sub); return arr;
      }
      case T.ARRAY_TYPE_AUXILIARY_BUFFER: {
        const n = b.b1.buf[b.b1.off]; b.b1.off += 1;
        const sub = readType();
        const saved = ctx.buffer; ctx.buffer = ctx.aux;   // element scalars come from the auxiliary buffer
        const arr = new Array(n); for (let i = 0; i < n; i++) arr[i] = readValue(sub);
        ctx.buffer = saved; return arr;
      }
      case T.OBJECT: {
        const n = objectLength();
        const obj = {}; for (let i = 0; i < n; i++) parseNode(false, obj); return obj;
      }
      default: throw new Error("KV3 unknown type " + datatype + " at typeOff " + (ctx.typeOff - 1));
    }
  }

  // parseNode: array element (isArray) or an object member (writes into `into`).
  function parseNode(isArray, into) {
    const datatype = readType();
    if (isArray) return readValue(datatype);
    const b = ctx.buffer;
    const stringID = b.b4.buf.readInt32LE(b.b4.off); b.b4.off += 4;
    const name = stringID === -1 ? "" : ctx.strings[stringID];
    into[name] = readValue(datatype);
    return into;
  }

  // Root is an object member set with no name (VRF wraps in a KVObject); the root type is read first.
  const rootType = readType();
  return readValue(rootType);
}

module.exports = { parseKV3 };
