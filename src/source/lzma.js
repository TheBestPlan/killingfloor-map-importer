// LZMA1 decoder for Source BSP lumps.
//
// bspzip compresses individual lumps (common in Left 4 Dead 2 / CS:GO maps). A compressed lump begins
// with a Valve header: 'LZMA' + actualSize(u32) + lzmaSize(u32) + props(1) + dictSize(u32), then a
// raw LZMA1 stream. This decodes that back to the plain lump. Ported from the LZMA SDK reference
// (LzmaDec); verified against a python `lzma.FORMAT_ALONE` vector in test/lzma.test.js.
"use strict";

const kNumBitModelTotalBits = 11;
const kBitModelTotal = 1 << kNumBitModelTotalBits;   // 2048
const kNumMoveBits = 5;
const PROB_INIT = kBitModelTotal >> 1;               // 1024

const kNumPosBitsMax = 4;
const kNumStates = 12;
const kNumLenToPosStates = 4;
const kNumAlignBits = 4;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >> 1);   // 128
const kMatchMinLen = 2;

function isValveLzma(buf, off) { return buf.length >= off + 17 && buf[off] === 0x4c && buf[off + 1] === 0x5a && buf[off + 2] === 0x4d && buf[off + 3] === 0x41; }

// Decode a Valve-wrapped lump. Returns a Buffer of actualSize, or the input unchanged if not LZMA.
function decodeLump(buf) {
  if (!isValveLzma(buf, 0)) return buf;
  const actualSize = buf.readUInt32LE(4);
  const props = buf[12];
  return decodeRaw(props, buf, 17, actualSize);
}

// props byte + raw stream at inBuf[inPos..], producing outSize bytes.
function decodeRaw(props, inBuf, inPos, outSize) {
  let lc = props % 9; let r = (props / 9) | 0; let lp = r % 5; let pb = (r / 5) | 0;
  const posMask = (1 << pb) - 1;
  const litPosMask = (1 << lp) - 1;

  // probability model layout
  const NumStates4 = kNumStates << kNumPosBitsMax;
  const probs = new Uint16Array(
    NumStates4 +          // IsMatch [state<<4 | posState]
    kNumStates +          // IsRep
    kNumStates +          // IsRepG0
    kNumStates +          // IsRepG1
    kNumStates +          // IsRepG2
    NumStates4 +          // IsRep0Long
    (kNumLenToPosStates << 6) +   // PosSlot: 4 trees of 64
    (kNumFullDistances - kEndPosModelIndex) +   // SpecPos
    (1 << kNumAlignBits) +   // Align
    2 + (16 << 3) + (16 << 3) + 256 +   // LenCoder: choice,choice2, low[16*8], mid[16*8], high[256]
    2 + (16 << 3) + (16 << 3) + 256 +   // RepLenCoder
    (0x300 << (lc + lp))    // Literal
  );
  probs.fill(PROB_INIT);

  // offsets into probs
  let o = 0;
  const IsMatch = o; o += NumStates4;
  const IsRep = o; o += kNumStates;
  const IsRepG0 = o; o += kNumStates;
  const IsRepG1 = o; o += kNumStates;
  const IsRepG2 = o; o += kNumStates;
  const IsRep0Long = o; o += NumStates4;
  const PosSlot = o; o += kNumLenToPosStates << 6;
  const SpecPos = o; o += kNumFullDistances - kEndPosModelIndex;
  const Align = o; o += 1 << kNumAlignBits;
  const LenCoder = o; o += 2 + (16 << 3) + (16 << 3) + 256;
  const RepLenCoder = o; o += 2 + (16 << 3) + (16 << 3) + 256;
  const Literal = o;

  // range decoder
  let range = 0xffffffff >>> 0;
  let code = 0;
  let ip = inPos + 1;                 // first byte ignored
  for (let i = 0; i < 4; i++) code = ((code << 8) | inBuf[ip++]) >>> 0;

  function normalize() { if (range < (1 << 24)) { range = (range << 8) >>> 0; code = ((code << 8) | inBuf[ip++]) >>> 0; } }
  function bit(pi) {
    const prob = probs[pi];
    const bound = ((range >>> kNumBitModelTotalBits) * prob) >>> 0;
    let b;
    if ((code >>> 0) < bound) { range = bound; probs[pi] = prob + ((kBitModelTotal - prob) >>> kNumMoveBits); b = 0; }
    else { range = (range - bound) >>> 0; code = (code - bound) >>> 0; probs[pi] = prob - (prob >>> kNumMoveBits); b = 1; }
    normalize();
    return b;
  }
  function directBits(n) {
    let res = 0;
    do {
      range = range >>> 1;
      code = (code - range) >>> 0;
      const t = (0 - (code >>> 31)) >>> 0;
      code = (code + (range & t)) >>> 0;
      normalize();
      res = ((res << 1) + t + 1) >>> 0;
    } while (--n);
    return res >>> 0;
  }
  function bittree(base, nbits) { let m = 1; for (let i = 0; i < nbits; i++) m = (m << 1) | bit(base + m); return m - (1 << nbits); }
  function bittreeRev(base, nbits) { let m = 1, sym = 0; for (let i = 0; i < nbits; i++) { const b = bit(base + m); m = (m << 1) | b; sym |= b << i; } return sym; }

  function lenDecode(coder, posState) {
    if (bit(coder) === 0) return bittree(coder + 2 + posState * 8, 3);
    if (bit(coder + 1) === 0) return 8 + bittree(coder + 2 + (16 << 3) + posState * 8, 3);
    return 16 + bittree(coder + 2 + (16 << 3) + (16 << 3), 8);
  }

  const out = Buffer.alloc(outSize);
  let outPos = 0;
  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;

  while (outPos < outSize) {
    const posState = outPos & posMask;
    if (bit(IsMatch + (state << kNumPosBitsMax) + posState) === 0) {
      // literal
      const prevByte = outPos > 0 ? out[outPos - 1] : 0;
      const litState = ((outPos & litPosMask) << lc) + (prevByte >> (8 - lc));
      const probLit = Literal + 0x300 * litState;
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[outPos - rep0 - 1];
        do {
          const matchBit = (matchByte >> 7) & 1; matchByte = (matchByte << 1) & 0xff;
          const b = bit(probLit + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | b;
          if (matchBit !== b) { while (symbol < 0x100) symbol = (symbol << 1) | bit(probLit + symbol); break; }
        } while (symbol < 0x100);
      } else {
        while (symbol < 0x100) symbol = (symbol << 1) | bit(probLit + symbol);
      }
      out[outPos++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    // match
    let len;
    if (bit(IsRep + state) !== 0) {
      // rep match
      if (bit(IsRepG0 + state) === 0) {
        if (bit(IsRep0Long + (state << kNumPosBitsMax) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[outPos] = out[outPos - rep0 - 1]; outPos++;
          continue;
        }
      } else {
        let dist;
        if (bit(IsRepG1 + state) === 0) dist = rep1;
        else { if (bit(IsRepG2 + state) === 0) dist = rep2; else { dist = rep3; rep3 = rep2; } rep2 = rep1; }
        rep1 = rep0; rep0 = dist;
      }
      len = lenDecode(RepLenCoder, posState) + kMatchMinLen;
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = lenDecode(LenCoder, posState);
      state = state < 7 ? 7 : 10;
      const lenToPos = len < kNumLenToPosStates ? len : kNumLenToPosStates - 1;
      const posSlot = bittree(PosSlot + (lenToPos << 6), 6);
      if (posSlot < 4) rep0 = posSlot;
      else {
        const numDirect = (posSlot >> 1) - 1;
        rep0 = (2 | (posSlot & 1)) << numDirect;
        if (posSlot < kEndPosModelIndex) rep0 += bittreeRev(SpecPos + rep0 - posSlot - 1, numDirect);
        else {
          rep0 = (rep0 + (directBits(numDirect - kNumAlignBits) << kNumAlignBits)) >>> 0;
          rep0 = (rep0 + bittreeRev(Align, kNumAlignBits)) >>> 0;
        }
      }
      if (rep0 === 0xffffffff) break;   // end marker
      len += kMatchMinLen;
    }
    // copy match
    let src = outPos - rep0 - 1;
    for (let i = 0; i < len && outPos < outSize; i++) out[outPos++] = out[src++];
  }
  return out;
}

module.exports = { decodeLump, decodeRaw, isValveLzma };
