// Low-level Unreal Engine 2.5 package primitives: growable byte writer, compact indices,
// FString, and the tagged-property encoding used by every UObject property block.
"use strict";

// UE2 property type tags. Note Str is 13 (the FString property); 7 is the legacy fixed-size
// StringProperty and the engine rejects it with "Type mismatch ... file 7, class 13".
const PropType = { Byte: 1, Int: 2, Bool: 3, Float: 4, Object: 5, Name: 6, Class: 8, Array: 9, Struct: 10, Vector: 11, Rotator: 12, Str: 13, Map: 14 };

class Writer {
  constructor(cap) {
    this.buf = Buffer.alloc(cap || 1 << 16);
    this.len = 0;
    this.lazyPatches = [];   // { at, target } -> write (base + target) as int32 at `at`
  }
  _need(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = Buffer.alloc(cap);
    this.buf.copy(nb, 0, 0, this.len);
    this.buf = nb;
  }
  bytes(b) { this._need(b.length); Buffer.from(b).copy(this.buf, this.len); this.len += b.length; return this; }
  u8(v) { this._need(1); this.buf.writeUInt8(v & 0xff, this.len); this.len += 1; return this; }
  i16(v) { this._need(2); this.buf.writeInt16LE(v, this.len); this.len += 2; return this; }
  u16(v) { this._need(2); this.buf.writeUInt16LE(v, this.len); this.len += 2; return this; }
  i32(v) { this._need(4); this.buf.writeInt32LE(v | 0, this.len); this.len += 4; return this; }
  u32(v) { this._need(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; return this; }
  f32(v) { this._need(4); this.buf.writeFloatLE(v, this.len); this.len += 4; return this; }
  qwordZero() { return this.i32(0).i32(0); }
  qwordOnes() { return this.u32(0xffffffff).u32(0xffffffff); }
  qword(lo, hi) { return this.u32(lo >>> 0).u32(hi >>> 0); }
  vec(v) { return this.f32(v[0]).f32(v[1]).f32(v[2]); }
  plane(n, w) { return this.f32(n[0]).f32(n[1]).f32(n[2]).f32(w); }

  // FBox = Min FVector, Max FVector, byte IsValid  (25 bytes)
  box(min, max, valid) { return this.vec(min).vec(max).u8(valid === undefined ? 1 : valid); }
  // FSphere = FVector Center, FLOAT Radius (16 bytes)
  sphere(c, r) { return this.vec(c).f32(r); }

  // Unreal compact index: byte0 bit0x80 = sign, bit0x40 = continue, low 6 bits = value;
  // continuation bytes use bit0x80 = continue plus 7 value bits.
  cidx(value) {
    let v = value < 0 ? -value : value;
    let b0 = (value < 0 ? 0x80 : 0) | (v & 0x3f);
    v >>>= 6;
    if (v) {
      this.u8(b0 | 0x40);
      while (v) {
        const part = v & 0x7f;
        v >>>= 7;
        this.u8(v ? part | 0x80 : part);
      }
    } else this.u8(b0);
    return this;
  }

  // FString: compact length INCLUDING the terminating NUL, then the bytes. Empty = length 0.
  fstring(s) {
    if (!s) return this.cidx(0);
    const b = Buffer.from(s, "latin1");
    this.cidx(b.length + 1).bytes(b).u8(0);
    return this;
  }

  // TLazyArray skip offset: absolute file position just past the array. Patched at assembly time.
  lazySkip() {
    this.lazyPatches.push({ at: this.len, target: -1 });
    this.i32(0);
    return this.lazyPatches[this.lazyPatches.length - 1];
  }
  resolveLazy(rec) { rec.target = this.len; return this; }

  out() { return this.buf.subarray(0, this.len); }
}

// Tagged-property block writer. `names` is the package name table (adds on demand).
class Props {
  constructor(w, names) { this.w = w; this.names = names; }

  _tag(name, type, valueBytes, structName, arrayIndex, boolValue) {
    const w = this.w;
    w.cidx(this.names.add(name));
    const size = valueBytes ? valueBytes.length : 0;
    let sizeCode;
    if (type === PropType.Bool) sizeCode = 0;
    else if (size === 1) sizeCode = 0;
    else if (size === 2) sizeCode = 1;
    else if (size === 4) sizeCode = 2;
    else if (size === 12) sizeCode = 3;
    else if (size === 16) sizeCode = 4;
    else if (size < 256) sizeCode = 5;
    else if (size < 65536) sizeCode = 6;
    else sizeCode = 7;
    const isArray = arrayIndex !== undefined && arrayIndex !== null;
    let info = (type & 0x0f) | (sizeCode << 4);
    if (type === PropType.Bool) { if (boolValue) info |= 0x80; }
    else if (isArray) info |= 0x80;
    w.u8(info);
    if (type === PropType.Struct) w.cidx(this.names.add(structName));
    if (sizeCode === 5) w.u8(size);
    else if (sizeCode === 6) w.u16(size);
    else if (sizeCode === 7) w.u32(size);
    if (isArray && type !== PropType.Bool) w.u8(arrayIndex);
    if (valueBytes) w.bytes(valueBytes);
    return this;
  }

  byte(name, v) { return this._tag(name, PropType.Byte, Buffer.from([v & 0xff])); }
  int(name, v) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return this._tag(name, PropType.Int, b); }
  float(name, v) { const b = Buffer.alloc(4); b.writeFloatLE(v); return this._tag(name, PropType.Float, b); }
  bool(name, v) { return this._tag(name, PropType.Bool, null, null, null, !!v); }
  object(name, ref) { const t = new Writer(8); t.cidx(ref); return this._tag(name, PropType.Object, Buffer.from(t.out())); }
  // A `class<X>` property. Same payload as an object reference, different tag - the engine matches
  // the tag against the property it is loading into and drops what does not agree.
  classProp(name, ref) { const t = new Writer(8); t.cidx(ref); return this._tag(name, PropType.Class, Buffer.from(t.out())); }
  nameProp(name, value) { const t = new Writer(8); t.cidx(this.names.add(value)); return this._tag(name, PropType.Name, Buffer.from(t.out())); }
  str(name, value) { const t = new Writer(64); t.fstring(value); return this._tag(name, PropType.Str, Buffer.from(t.out())); }
  vector(name, v) {
    const b = Buffer.alloc(12);
    b.writeFloatLE(v[0], 0); b.writeFloatLE(v[1], 4); b.writeFloatLE(v[2], 8);
    return this._tag(name, PropType.Struct, b, "Vector");
  }
  rotator(name, r) {
    const b = Buffer.alloc(12);
    b.writeInt32LE(r[0] | 0, 0); b.writeInt32LE(r[1] | 0, 4); b.writeInt32LE(r[2] | 0, 8);
    return this._tag(name, PropType.Struct, b, "Rotator");
  }
  // One element of a fixed-size array property - Mover.KeyPos[1] and friends.
  vectorAt(name, index, v) {
    const b = Buffer.alloc(12);
    b.writeFloatLE(v[0], 0); b.writeFloatLE(v[1], 4); b.writeFloatLE(v[2], 8);
    return this._tag(name, PropType.Struct, b, "Vector", index);
  }
  rotatorAt(name, index, r) {
    const b = Buffer.alloc(12);
    b.writeInt32LE(r[0] | 0, 0); b.writeInt32LE(r[1] | 0, 4); b.writeInt32LE(r[2] | 0, 8);
    return this._tag(name, PropType.Struct, b, "Rotator", index);
  }
  // Takes R,G,B[,A] and writes B,G,R,A: FColor is BGRA on disk, and the engine's own text form says
  // so - a KFEd .t3d reads `DistanceFogColor=(B=108,G=182,R=255)`. Passing RGB straight through put
  // the blue of the underwater overlay in the red channel, which is why water tinted the screen red.
  color(name, c) {
    const b = Buffer.from([c[2] & 255, c[1] & 255, c[0] & 255, c.length > 3 ? c[3] & 255 : 255]);
    return this._tag(name, PropType.Struct, b, "Color");
  }
  // Struct whose value is raw bytes - Vector, Rotator, Color and the rest of the atomic ones, which
  // the engine writes as their fields back to back with no tags around them.
  structRaw(name, structName, bytes, index) {
    return this._tag(name, PropType.Struct, Buffer.from(bytes), structName, index);
  }
  // A dynamic array: the count, then each element's VALUE with no tag of its own. What an element
  // looks like comes from the property's declared type, which is not in the file - the caller knows.
  arrayProp(name, count, fill) {
    const inner = new Writer(256);
    inner.cidx(count);
    fill(inner, new Props(inner, this.names));
    return this._tag(name, PropType.Array, Buffer.from(inner.out()));
  }
  // Struct whose value is itself a tagged property block (how the engine stores PointRegion, Scale…).
  structBlock(name, structName, fill) {
    const inner = new Writer(64);
    fill(new Props(inner, this.names));
    return this._tag(name, PropType.Struct, Buffer.from(inner.out()), structName);
  }
  // Every actor carries these; without `Level` the engine dereferences null in ANavigationPoint::Destroy.
  actorCommon(levelInfoRef, physicsVolumeRef, tag, zoneNumber, zoneRef) {
    this.object("Level", levelInfoRef);
    this.structBlock("Region", "PointRegion", (p) => {
      p.object("Zone", zoneRef || levelInfoRef);
      p.int("iLeaf", 0);
      p.byte("ZoneNumber", zoneNumber === undefined ? 1 : zoneNumber);
      p.end();
    });
    if (tag) this.nameProp("Tag", tag);
    if (physicsVolumeRef) this.object("PhysicsVolume", physicsVolumeRef);
    return this;
  }
  end() { this.w.cidx(this.names.add("None")); return this.w; }
}

// Objects flagged RF_HasStack are prefixed by an FStateFrame. Every actor in every shipped map has
// one; the values below are exactly what UnrealEd writes for an actor sitting in its default state.
function writeStateFrame(w, classRef) {
  w.cidx(classRef).cidx(classRef);
  w.u32(0xffffffff).u32(0xffffffff);      // ProbeMask
  w.u32(0xfefefefe);                      // LatentAction
  if (classRef !== 0) w.cidx(-1);         // Offset (only present when Node != None)
  return w;
}

module.exports = { Writer, Props, PropType, writeStateFrame };
