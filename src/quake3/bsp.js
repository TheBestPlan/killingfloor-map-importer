// Quake 3 BSP reader (IBSP v46) - Quake III Arena and Team Arena.
//
// Same family as GoldSrc, five years later, and the differences are the ones that matter to a
// converter: a face carries its own UVs per vertex instead of a pair of projection axes, the
// lightmap is a set of finished 128x128 pages instead of a per-face luxel block, and a third of the
// geometry is not polygons at all but bezier patches and triangle soups.
//
// Struct layout per the unofficial spec (mralligator.com/q3) and id's own q3/bspfile.h.
"use strict";

const LUMP = {
  ENTITIES: 0, TEXTURES: 1, PLANES: 2, NODES: 3, LEAFS: 4, LEAFFACES: 5, LEAFBRUSHES: 6,
  MODELS: 7, BRUSHES: 8, BRUSHSIDES: 9, VERTEXES: 10, MESHVERTS: 11, EFFECTS: 12, FACES: 13,
  LIGHTMAPS: 14, LIGHTVOLS: 15, VISDATA: 16,
};

// Face types.
const FACE = { POLYGON: 1, PATCH: 2, MESH: 3, BILLBOARD: 4 };

// A lightmap page is always this, in every stock map of both games.
const LIGHTMAP_SIZE = 128;

// q3 surfaceflags.h - only the ones a converter has to act on.
const SURF = {
  SKY: 0x4, NODRAW: 0x80, HINT: 0x100, SKIP: 0x200, NOLIGHTMAP: 0x400,
  NONSOLID: 0x4000, ALPHASHADOW: 0x10000,
};
// q3 contents flags, same source.
const CONTENTS = {
  SOLID: 1, LAVA: 8, SLIME: 16, WATER: 32, FOG: 64, AREAPORTAL: 0x8000,
  PLAYERCLIP: 0x10000, MONSTERCLIP: 0x20000, TELEPORTER: 0x40000, JUMPPAD: 0x80000,
  CLUSTERPORTAL: 0x100000, DONOTENTER: 0x200000, BOTCLIP: 0x400000, ORIGIN: 0x1000000,
  DETAIL: 0x8000000, STRUCTURAL: 0x10000000, TRANSLUCENT: 0x20000000, TRIGGER: 0x40000000,
};

// A surface with nothing to draw. `common/*` is the tool set - clip, hint, trigger, the caulk that
// seals every brush the player never sees - and it is by far the biggest single group of faces in a
// stock map.
function isToolSurface(name, flags, contents) {
  if (flags & (SURF.NODRAW | SURF.HINT | SURF.SKIP)) return true;
  if (contents & (CONTENTS.PLAYERCLIP | CONTENTS.MONSTERCLIP | CONTENTS.BOTCLIP | CONTENTS.TRIGGER |
    CONTENTS.AREAPORTAL | CONTENTS.CLUSTERPORTAL | CONTENTS.DONOTENTER | CONTENTS.ORIGIN)) return true;
  return /^(textures\/)?common\//i.test(name) || /(^|\/)(caulk|nodraw|clip|hint|skip|trigger|origin|areaportal|donotenter|botclip|clusterportal|nodrawnonsolid|weapclip|full_clip)$/i.test(name);
}

class Bsp {
  constructor(buf, name) {
    this.buf = buf;
    this.name = name || "";
    if (buf.length < 144 || buf.toString("latin1", 0, 4) !== "IBSP") {
      throw new Error("not an IBSP file (magic " + JSON.stringify(buf.toString("latin1", 0, 4)) + ")");
    }
    this.version = buf.readInt32LE(4);
    // 46 is Quake 3 and Team Arena; 47 is the same layout with one extra lump, written by later
    // compilers (Quake Live, some RTCW tools) - read it the same way and ignore what we do not index.
    if (this.version !== 46 && this.version !== 47) {
      throw new Error("unsupported IBSP version " + this.version + " (Quake 3 is 46)");
    }
    this.lumps = [];
    for (let i = 0; i < 17; i++) {
      this.lumps.push({ off: buf.readInt32LE(8 + i * 8), len: buf.readInt32LE(12 + i * 8) });
    }
    this._read();
  }

  _read() {
    const b = this.buf;
    const L = (i) => this.lumps[i];

    this.textures = [];
    for (let i = 0, n = L(LUMP.TEXTURES).len / 72; i < n; i++) {
      const o = L(LUMP.TEXTURES).off + i * 72;
      const name = b.toString("latin1", o, o + 64).replace(/\0[\s\S]*$/, "");
      const flags = b.readInt32LE(o + 64), contents = b.readInt32LE(o + 68);
      this.textures.push({ name, flags, contents, tool: isToolSurface(name, flags, contents) });
    }

    this.planes = [];
    for (let i = 0, n = L(LUMP.PLANES).len / 16; i < n; i++) {
      const o = L(LUMP.PLANES).off + i * 16;
      this.planes.push({ normal: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)], dist: b.readFloatLE(o + 12) });
    }

    // Vertices as flat typed arrays: a stock map has up to ~60k of them and one object each is a
    // measurable share of the conversion.
    const nv = L(LUMP.VERTEXES).len / 44;
    this.vertexCount = nv;
    this.positions = new Float32Array(nv * 3);
    this.texcoords = new Float32Array(nv * 2);
    this.lmcoords = new Float32Array(nv * 2);
    this.normals = new Float32Array(nv * 3);
    this.colors = new Uint8Array(nv * 4);
    for (let i = 0; i < nv; i++) {
      const o = L(LUMP.VERTEXES).off + i * 44;
      this.positions[i * 3] = b.readFloatLE(o);
      this.positions[i * 3 + 1] = b.readFloatLE(o + 4);
      this.positions[i * 3 + 2] = b.readFloatLE(o + 8);
      this.texcoords[i * 2] = b.readFloatLE(o + 12);
      this.texcoords[i * 2 + 1] = b.readFloatLE(o + 16);
      this.lmcoords[i * 2] = b.readFloatLE(o + 20);
      this.lmcoords[i * 2 + 1] = b.readFloatLE(o + 24);
      this.normals[i * 3] = b.readFloatLE(o + 28);
      this.normals[i * 3 + 1] = b.readFloatLE(o + 32);
      this.normals[i * 3 + 2] = b.readFloatLE(o + 36);
      this.colors[i * 4] = b[o + 40]; this.colors[i * 4 + 1] = b[o + 41];
      this.colors[i * 4 + 2] = b[o + 42]; this.colors[i * 4 + 3] = b[o + 43];
    }

    const nm = L(LUMP.MESHVERTS).len / 4;
    this.meshverts = new Int32Array(nm);
    for (let i = 0; i < nm; i++) this.meshverts[i] = b.readInt32LE(L(LUMP.MESHVERTS).off + i * 4);

    this.faces = [];
    for (let i = 0, n = L(LUMP.FACES).len / 104; i < n; i++) {
      const o = L(LUMP.FACES).off + i * 104;
      this.faces.push({
        texture: b.readInt32LE(o), effect: b.readInt32LE(o + 4), type: b.readInt32LE(o + 8),
        vertex: b.readInt32LE(o + 12), nVertexes: b.readInt32LE(o + 16),
        meshvert: b.readInt32LE(o + 20), nMeshverts: b.readInt32LE(o + 24),
        lmIndex: b.readInt32LE(o + 28),
        normal: [b.readFloatLE(o + 84), b.readFloatLE(o + 88), b.readFloatLE(o + 92)],
        size: [b.readInt32LE(o + 96), b.readInt32LE(o + 100)],
      });
    }

    this.models = [];
    for (let i = 0, n = L(LUMP.MODELS).len / 40; i < n; i++) {
      const o = L(LUMP.MODELS).off + i * 40;
      this.models.push({
        mins: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)],
        maxs: [b.readFloatLE(o + 12), b.readFloatLE(o + 16), b.readFloatLE(o + 20)],
        face: b.readInt32LE(o + 24), nFaces: b.readInt32LE(o + 28),
        brush: b.readInt32LE(o + 32), nBrushes: b.readInt32LE(o + 36),
      });
    }

    this.brushes = [];
    for (let i = 0, n = L(LUMP.BRUSHES).len / 12; i < n; i++) {
      const o = L(LUMP.BRUSHES).off + i * 12;
      this.brushes.push({ side: b.readInt32LE(o), nSides: b.readInt32LE(o + 4), texture: b.readInt32LE(o + 8) });
    }
    this.brushsides = [];
    for (let i = 0, n = L(LUMP.BRUSHSIDES).len / 8; i < n; i++) {
      const o = L(LUMP.BRUSHSIDES).off + i * 8;
      this.brushsides.push({ plane: b.readInt32LE(o), texture: b.readInt32LE(o + 4) });
    }

    this.lightmapCount = Math.floor(L(LUMP.LIGHTMAPS).len / (LIGHTMAP_SIZE * LIGHTMAP_SIZE * 3));
    this.lightmapOffset = L(LUMP.LIGHTMAPS).off;

    this.entities = parseEntities(b.toString("latin1", L(LUMP.ENTITIES).off, L(LUMP.ENTITIES).off + L(LUMP.ENTITIES).len));
    this.worldspawn = this.entities.find((e) => e.classname === "worldspawn") || {};
  }

  // RGB bytes of one lightmap page.
  lightmap(i) {
    if (i < 0 || i >= this.lightmapCount) return null;
    const px = LIGHTMAP_SIZE * LIGHTMAP_SIZE * 3;
    return this.buf.subarray(this.lightmapOffset + i * px, this.lightmapOffset + (i + 1) * px);
  }

  vertex(i) {
    return {
      pos: [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]],
      uv: [this.texcoords[i * 2], this.texcoords[i * 2 + 1]],
      lm: [this.lmcoords[i * 2], this.lmcoords[i * 2 + 1]],
      normal: [this.normals[i * 3], this.normals[i * 3 + 1], this.normals[i * 3 + 2]],
      color: [this.colors[i * 4], this.colors[i * 4 + 1], this.colors[i * 4 + 2], this.colors[i * 4 + 3]],
    };
  }

  stats() {
    return {
      version: this.version, textures: this.textures.length, planes: this.planes.length,
      vertexes: this.vertexCount, meshverts: this.meshverts.length, faces: this.faces.length,
      patches: this.faces.filter((f) => f.type === FACE.PATCH).length,
      meshes: this.faces.filter((f) => f.type === FACE.MESH).length,
      models: this.models.length, brushes: this.brushes.length,
      lightmaps: this.lightmapCount, entities: this.entities.length,
    };
  }
}

// Entity blocks are the same key/value text GoldSrc uses.
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
  if (!s) return dflt ? dflt.slice() : [0, 0, 0];
  const p = s.trim().split(/\s+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
};

// --- bezier patches -------------------------------------------------------------------------------
// A type-2 face is a grid of size[0] x size[1] control points, both odd, which is
// ((w-1)/2) x ((h-1)/2) biquadratic patches sharing their edges. Tessellating each into an
// (L+1) x (L+1) grid and stitching them by index is what the engine does; the seam between two
// patches is exact because they share the control row.
// Quadratic bezier over three control vertices, every channel at once.
function bezier(c0, c1, c2, t) {
  const it = 1 - t, a = it * it, b2 = 2 * t * it, c = t * t;
  const mix = (x, y, z) => x * a + y * b2 + z * c;
  return {
    pos: [0, 1, 2].map((i) => mix(c0.pos[i], c1.pos[i], c2.pos[i])),
    uv: [0, 1].map((i) => mix(c0.uv[i], c1.uv[i], c2.uv[i])),
    lm: [0, 1].map((i) => mix(c0.lm[i], c1.lm[i], c2.lm[i])),
    normal: [0, 1, 2].map((i) => mix(c0.normal[i], c1.normal[i], c2.normal[i])),
    color: [0, 1, 2, 3].map((i) => mix(c0.color[i], c1.color[i], c2.color[i])),
  };
}

// Returns { verts: [vertex], indices: [int] } for one patch face, in Quake space.
function tessellatePatch(bsp, face, level) {
  const L = Math.max(1, level | 0);
  const w = face.size[0], h = face.size[1];
  if (w < 3 || h < 3 || !(w % 2) || !(h % 2)) return { verts: [], indices: [] };
  const ctrl = (x, y) => bsp.vertex(face.vertex + y * w + x);
  const verts = [], indices = [];
  const nx = (w - 1) / 2, ny = (h - 1) / 2;
  // One tessellated grid per sub-patch. Duplicated edge vertices between neighbours are exact
  // copies, so no seam shows; deduplicating them would cost more than the vertices do.
  for (let py = 0; py < ny; py++) {
    for (let px = 0; px < nx; px++) {
      const base = verts.length;
      for (let j = 0; j <= L; j++) {
        const v = j / L;
        // Three columns of the sub-patch, each collapsed along v first, then along u.
        const col = [0, 1, 2].map((k) => bezier(ctrl(px * 2 + k, py * 2), ctrl(px * 2 + k, py * 2 + 1), ctrl(px * 2 + k, py * 2 + 2), v));
        for (let i = 0; i <= L; i++) verts.push(bezier(col[0], col[1], col[2], i / L));
      }
      for (let j = 0; j < L; j++) {
        for (let i = 0; i < L; i++) {
          const a = base + j * (L + 1) + i;
          indices.push(a, a + L + 1, a + 1, a + 1, a + L + 1, a + L + 2);
        }
      }
    }
  }
  return { verts, indices };
}

function load(file) {
  return new Bsp(require("fs").readFileSync(file), require("path").basename(file, ".bsp"));
}

// What a finished map says it came from.
const GAME = "Quake III Arena";

module.exports = {
  Bsp, load, GAME, LUMP, FACE, SURF, CONTENTS, LIGHTMAP_SIZE,
  parseEntities, num3, tessellatePatch, isToolSurface,
};
