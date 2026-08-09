// GoldSrc BSP v30 reader (Half-Life / Counter-Strike 1.6).
// Struct layouts per the Half-Life SDK utils/common/bspfile.h.
"use strict";

const LUMP = {
  ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTEXES: 3, VISIBILITY: 4, NODES: 5, TEXINFO: 6,
  FACES: 7, LIGHTING: 8, CLIPNODES: 9, LEAFS: 10, MARKSURFACES: 11, EDGES: 12, SURFEDGES: 13, MODELS: 14,
};
const LUMP_NAMES = Object.keys(LUMP);

const TEX_SPECIAL = 1;
const CONTENTS = {
  EMPTY: -1, SOLID: -2, WATER: -3, SLIME: -4, LAVA: -5, SKY: -6,
  ORIGIN: -7, CLIP: -8, TRANSLUCENT: -15,
};

// Texture-name conventions. A converter must treat these differently from plain wall textures.
function classifyTexture(name) {
  const n = name.toLowerCase();
  if (n === "sky" || n === "env_sky") return "sky";
  if (n.startsWith("{")) return "masked";
  if (n.startsWith("!") || n.startsWith("~!") || n.startsWith("water")) return "liquid";
  if (/^[+][0-9a-j]/i.test(name)) return "animated";      // +0name .. +9name, +Aname .. +Jname
  if (/^-[0-9]/.test(name)) return "randomtile";          // -0name .. -9name (software renderer only)
  if (["aaatrigger", "clip", "origin", "null", "hint", "skip", "bevel", "boundingbox", "splitface"].includes(n)) return "tool";
  return "normal";
}

function parseEntities(text) {
  const out = [];
  let cur = null;
  const re = /\{|\}|"([^"]*)"\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === "{") cur = {};
    else if (m[0] === "}") { if (cur) out.push(cur); cur = null; }
    else if (cur) cur[m[1]] = m[2];
  }
  return out;
}

const num3 = (s, dflt) => {
  if (!s) return dflt.slice();
  const p = s.trim().split(/\s+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
};

class Bsp {
  constructor(buf) {
    this.buf = buf;
    this.version = buf.readInt32LE(0);
    if (this.version !== 30) throw new Error("not a GoldSrc BSP v30 (version " + this.version + ")");
    this.lumps = {};
    LUMP_NAMES.forEach((name, i) => {
      this.lumps[name] = { off: buf.readInt32LE(4 + i * 8), len: buf.readInt32LE(8 + i * 8) };
    });
    this._read();
  }

  _read() {
    const b = this.buf, L = this.lumps;

    this.planes = [];
    for (let i = 0, n = L.PLANES.len / 20; i < n; i++) {
      const o = L.PLANES.off + i * 20;
      this.planes.push({
        normal: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)],
        dist: b.readFloatLE(o + 12), type: b.readInt32LE(o + 16),
      });
    }

    const nv = L.VERTEXES.len / 12;
    this.vertexes = new Float32Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) this.vertexes[i] = b.readFloatLE(L.VERTEXES.off + i * 4);

    this.edges = new Int32Array(L.EDGES.len / 4 * 2);
    for (let i = 0, n = L.EDGES.len / 4; i < n; i++) {
      this.edges[i * 2] = b.readUInt16LE(L.EDGES.off + i * 4);
      this.edges[i * 2 + 1] = b.readUInt16LE(L.EDGES.off + i * 4 + 2);
    }

    this.surfedges = new Int32Array(L.SURFEDGES.len / 4);
    for (let i = 0; i < this.surfedges.length; i++) this.surfedges[i] = b.readInt32LE(L.SURFEDGES.off + i * 4);

    this.texinfo = [];
    for (let i = 0, n = L.TEXINFO.len / 40; i < n; i++) {
      const o = L.TEXINFO.off + i * 40;
      this.texinfo.push({
        s: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)], sShift: b.readFloatLE(o + 12),
        t: [b.readFloatLE(o + 16), b.readFloatLE(o + 20), b.readFloatLE(o + 24)], tShift: b.readFloatLE(o + 28),
        miptex: b.readInt32LE(o + 32), flags: b.readInt32LE(o + 36),
      });
    }

    // dface_t: u16 planenum, i16 side, i32 firstedge, u16 numedges, u16 texinfo, byte styles[4], i32 lightofs
    this.faces = [];
    for (let i = 0, n = L.FACES.len / 20; i < n; i++) {
      const o = L.FACES.off + i * 20;
      this.faces.push({
        planenum: b.readUInt16LE(o), side: b.readInt16LE(o + 2),
        firstedge: b.readInt32LE(o + 4), numedges: b.readUInt16LE(o + 8), texinfo: b.readUInt16LE(o + 10),
        styles: [b[o + 12], b[o + 13], b[o + 14], b[o + 15]], lightofs: b.readInt32LE(o + 16),
      });
    }

    this.nodes = [];
    for (let i = 0, n = L.NODES.len / 24; i < n; i++) {
      const o = L.NODES.off + i * 24;
      this.nodes.push({
        planenum: b.readInt32LE(o), children: [b.readInt16LE(o + 4), b.readInt16LE(o + 6)],
        mins: [b.readInt16LE(o + 8), b.readInt16LE(o + 10), b.readInt16LE(o + 12)],
        maxs: [b.readInt16LE(o + 14), b.readInt16LE(o + 16), b.readInt16LE(o + 18)],
        firstface: b.readUInt16LE(o + 20), numfaces: b.readUInt16LE(o + 22),
      });
    }

    this.leafs = [];
    for (let i = 0, n = L.LEAFS.len / 28; i < n; i++) {
      const o = L.LEAFS.off + i * 28;
      this.leafs.push({
        contents: b.readInt32LE(o), visofs: b.readInt32LE(o + 4),
        mins: [b.readInt16LE(o + 8), b.readInt16LE(o + 10), b.readInt16LE(o + 12)],
        maxs: [b.readInt16LE(o + 14), b.readInt16LE(o + 16), b.readInt16LE(o + 18)],
        firstmarksurface: b.readUInt16LE(o + 20), nummarksurfaces: b.readUInt16LE(o + 22),
      });
    }

    this.marksurfaces = new Uint16Array(L.MARKSURFACES.len / 2);
    for (let i = 0; i < this.marksurfaces.length; i++) this.marksurfaces[i] = b.readUInt16LE(L.MARKSURFACES.off + i * 2);

    this.clipnodes = [];
    for (let i = 0, n = L.CLIPNODES.len / 8; i < n; i++) {
      const o = L.CLIPNODES.off + i * 8;
      this.clipnodes.push({ planenum: b.readInt32LE(o), children: [b.readInt16LE(o + 4), b.readInt16LE(o + 6)] });
    }

    this.models = [];
    for (let i = 0, n = L.MODELS.len / 64; i < n; i++) {
      const o = L.MODELS.off + i * 64;
      this.models.push({
        mins: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)],
        maxs: [b.readFloatLE(o + 12), b.readFloatLE(o + 16), b.readFloatLE(o + 20)],
        origin: [b.readFloatLE(o + 24), b.readFloatLE(o + 28), b.readFloatLE(o + 32)],
        headnode: [b.readInt32LE(o + 36), b.readInt32LE(o + 40), b.readInt32LE(o + 44), b.readInt32LE(o + 48)],
        visleafs: b.readInt32LE(o + 52), firstface: b.readInt32LE(o + 56), numfaces: b.readInt32LE(o + 60),
      });
    }

    // miptex directory: names are always present; pixel data may live in an external WAD.
    const t = L.TEXTURES.off;
    this.miptex = [];
    if (L.TEXTURES.len > 0) {
      const count = b.readInt32LE(t);
      for (let i = 0; i < count; i++) {
        const rel = b.readInt32LE(t + 4 + i * 4);
        if (rel < 0) { this.miptex.push(null); continue; }
        const o = t + rel;
        // Cut at the first NUL, not at /\0.*$/ - `.` skips a newline, and the junk left in the
        // unused half of a 16-byte name field is arbitrary bytes. a2k_aimskillz has "AzTrim\0.wal\nWal",
        // which the dot form turns into a name matching nothing.
        const name = b.toString("latin1", o, o + 16).replace(/\0[\s\S]*$/, "");
        const offsets = [0, 1, 2, 3].map((k) => b.readUInt32LE(o + 24 + k * 4));
        this.miptex.push({
          name, width: b.readUInt32LE(o + 16), height: b.readUInt32LE(o + 20),
          offsets, base: o, embedded: offsets[0] !== 0, kind: classifyTexture(name),
        });
      }
    }

    this.lighting = { off: L.LIGHTING.off, len: L.LIGHTING.len };
    this.entities = parseEntities(b.toString("latin1", L.ENTITIES.off, L.ENTITIES.off + L.ENTITIES.len));
    this.worldspawn = this.entities.find((e) => e.classname === "worldspawn") || {};
    this.wads = (this.worldspawn.wad || "").split(";").filter(Boolean).map((w) => w.split(/[\\/]/).pop());
    this.skyname = this.worldspawn.skyname || "";
  }

  // Ordered vertex ring of a face, following signed surfedges.
  faceVertices(face) {
    const out = [];
    for (let i = 0; i < face.numedges; i++) {
      const se = this.surfedges[face.firstedge + i];
      const e = Math.abs(se) * 2;
      const vi = se >= 0 ? this.edges[e] : this.edges[e + 1];
      out.push([this.vertexes[vi * 3], this.vertexes[vi * 3 + 1], this.vertexes[vi * 3 + 2]]);
    }
    return out;
  }

  faceNormal(face) {
    const p = this.planes[face.planenum];
    return face.side ? [-p.normal[0], -p.normal[1], -p.normal[2]] : p.normal.slice();
  }

  faceDist(face) {
    const p = this.planes[face.planenum];
    return face.side ? -p.dist : p.dist;
  }

  // Luxel grid of a face. Exactly the compiler's CalcFaceExtents: the lightmap samples sit on a
  // 16-unit grid in texture space, snapped outward, hence the +1.
  faceLightmap(face) {
    const ti = this.texinfo[face.texinfo];
    if (face.lightofs < 0 || (ti.flags & TEX_SPECIAL)) return null;
    let sMin = 1e9, sMax = -1e9, tMin = 1e9, tMax = -1e9;
    for (const p of this.faceVertices(face)) {
      const s = p[0] * ti.s[0] + p[1] * ti.s[1] + p[2] * ti.s[2] + ti.sShift;
      const tt = p[0] * ti.t[0] + p[1] * ti.t[1] + p[2] * ti.t[2] + ti.tShift;
      if (s < sMin) sMin = s; if (s > sMax) sMax = s;
      if (tt < tMin) tMin = tt; if (tt > tMax) tMax = tt;
    }
    const baseS = Math.floor(sMin / 16), baseT = Math.floor(tMin / 16);
    const w = Math.ceil(sMax / 16) - baseS + 1, h = Math.ceil(tMax / 16) - baseT + 1;
    const styles = face.styles.filter((s) => s !== 255).length || 1;
    return { width: w, height: h, baseS, baseT, styles, offset: face.lightofs };
  }

  // RGB8 luxels of a face's first (constant) light style.
  faceLightmapRGB(face) {
    const lm = this.faceLightmap(face);
    if (!lm) return null;
    const need = lm.width * lm.height * 3;
    const at = this.lighting.off + lm.offset;
    if (lm.offset < 0 || lm.offset + need > this.lighting.len) return null;
    return { ...lm, rgb: this.buf.subarray(at, at + need) };
  }

  stats() {
    return {
      version: this.version, planes: this.planes.length, vertexes: this.vertexes.length / 3,
      faces: this.faces.length, texinfo: this.texinfo.length, nodes: this.nodes.length,
      leafs: this.leafs.length, models: this.models.length, clipnodes: this.clipnodes.length,
      miptex: this.miptex.length, entities: this.entities.length,
      lightingBytes: this.lighting.len, wads: this.wads, sky: this.skyname,
    };
  }
}

function load(file) { return new Bsp(require("fs").readFileSync(file)); }

// What a finished map says it came from. Every source game this converter grows to read names
// itself here, so nothing downstream has to know which reader ran.
const GAME = "Counter-Strike 1.6";

module.exports = { Bsp, load, GAME, LUMP, CONTENTS, TEX_SPECIAL, classifyTexture, parseEntities, num3 };
