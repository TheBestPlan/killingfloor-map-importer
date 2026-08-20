// Quake 3 .shader scripts: what a surface name actually draws.
//
// A BSP names its surfaces after SHADERS, not after files. Most of them happen to be an image on
// disk with the extension left off, but the interesting ones - sky, lava, glass, the cut-out
// grates - exist only as a script in `scripts/*.shader`, and reading it is the only way to learn
// which image to use and how the surface blends.
//
// Only what a converter has to act on is read: the stage images, the blend mode, the alpha test,
// `cull`, `skyparms` and the surfaceparms. Everything else - the deforms, the tcMods, the
// rgbGen waves - is animation this engine cannot reproduce anyway.
"use strict";

// `//` comments, then braces as their own tokens.
function tokenize(text) {
  const out = [];
  const clean = text.replace(/\/\/[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const re = /[{}]|[^\s{}]+/g;
  let m;
  while ((m = re.exec(clean))) out.push(m[0]);
  return out;
}

const IMAGE_STAGE = /^(map|clampmap)$/i;

function parseShaders(text, into) {
  const t = tokenize(text);
  const shaders = into || new Map();
  let i = 0;
  while (i < t.length) {
    const name = t[i++];
    if (name === "{" || name === "}") continue;                 // stray brace: skip to the next name
    if (t[i] !== "{") continue;
    i++;
    const sh = { name, params: new Set(), editorImage: null, sky: null, cull: null, stages: [] };
    let depth = 1;
    while (i < t.length && depth > 0) {
      const w = t[i++];
      if (w === "}") { depth--; continue; }
      if (w === "{") {
        // A stage block.
        const st = { map: null, blend: "opaque", alphaFunc: null, depthWrite: false };
        let d = 1;
        // A brace is never an argument. `blendFunc GL_add` - id's own typo, in sfx.shader - is a
        // one-word blend spelled like a two-word one, and swallowing the `}` after it desynced the
        // whole rest of the file: 35 shaders parsed out of 215.
        const arg = () => (i < t.length && !/^[{}]$/.test(t[i]) ? t[i++] : null);
        while (i < t.length && d > 0) {
          const k = t[i++];
          if (k === "{") { d++; continue; }
          if (k === "}") { d--; continue; }
          const kl = k.toLowerCase();
          if (IMAGE_STAGE.test(kl)) { const v = arg(); if (!st.map) st.map = v; }
          else if (kl === "animmap") {
            // `animMap <fps> <frame> <frame> ...` - a flipbook. The frames are kept, not just the
            // first: Killing Floor animates a texture through AnimNext, so a Quake 3 flame can go on
            // flickering here.
            st.fps = parseFloat(arg()) || 0;
            let frame = arg();
            st.frames = frame ? [frame] : [];
            if (!st.map) st.map = frame;
            while (frame && /\.(tga|jpg|jpeg|png)$/i.test(t[i] || "")) { frame = arg(); if (frame) st.frames.push(frame); }
          } else if (kl === "videomap") arg();
          else if (kl === "blendfunc") {
            const a = (arg() || "").toLowerCase();
            // A blend factor is always GL_*; anything else is the next keyword. The test has to be
            // case-insensitive, because id writes them in capitals: matching only lowercase read
            // every `blendFunc GL_ONE GL_ONE` as the one-word form, classified it as opaque, and
            // turned every additive sprite in the game - the torch flames, the portal effects, the
            // lamp glows - into a rectangle of solid black.
            const b = /^gl_/i.test(t[i] || "") ? (arg() || "").toLowerCase() : null;
            st.blend = classifyBlend(a, b);
          } else if (kl === "alphafunc") { st.alphaFunc = (arg() || "").toUpperCase(); }
          else if (kl === "alphagen") {
            // `alphaGen vertex` is what a terrain shader blends its second rock by: the weight is
            // painted into the vertex alpha, not into a texture.
            st.alphaGen = (arg() || "").toLowerCase();
          } else if (kl === "rgbgen") { st.rgbGen = (arg() || "").toLowerCase(); }
          else if (kl === "tcmod") {
            // `tcMod scale <u> <v>` is a UV multiplier baked into the surface here - the terrain
            // shaders draw their rock at `scale 0.125`, and ignoring it puts the texture on the
            // ground eight times too large, which is what makes a Team Arena hillside read as flat
            // patches of colour. The animated tcMods (scroll, turb, rotate) have no equivalent.
            const kind = (arg() || "").toLowerCase();
            if (kind === "scale") {
              const u = parseFloat(arg()), v = parseFloat(arg());
              if (Number.isFinite(u) && Number.isFinite(v)) st.scale = [u, v];
            } else { while (/^-?[\d.]+$/.test(t[i] || "")) arg(); }
          } else if (kl === "depthwrite") st.depthWrite = true;
        }
        sh.stages.push(st);
        continue;
      }
      const wl = w.toLowerCase();
      if (wl === "surfaceparm") sh.params.add((t[i++] || "").toLowerCase());
      else if (wl === "qer_editorimage") sh.editorImage = t[i++];
      else if (wl === "cull") sh.cull = (t[i++] || "").toLowerCase();
      else if (wl === "skyparms") {
        // farbox cloudheight nearbox; "-" means none.
        const far = t[i++], height = t[i++], near = t[i++];
        sh.sky = { farbox: far === "-" ? null : far, cloudHeight: parseFloat(height) || 128, nearbox: near === "-" ? null : near };
      }
    }
    shaders.set(name.toLowerCase(), sh);
  }
  return shaders;
}

function classifyBlend(a, b) {
  if (!b) {
    const one = a.replace(/^gl_/, "");
    if (one === "add") return "additive";
    if (one === "filter") return "filter";
    if (one === "blend") return "blend";
    return "opaque";
  }
  const src = a, dst = b;
  if (src === "gl_one" && dst === "gl_zero") return "opaque";
  if (dst === "gl_one" && (src === "gl_one" || src === "gl_src_alpha" || src === "gl_dst_color")) return "additive";
  if (src === "gl_src_alpha" && dst === "gl_one_minus_src_alpha") return "blend";
  if ((src === "gl_dst_color" && dst === "gl_zero") || (src === "gl_zero" && dst === "gl_src_color")) return "filter";
  return "blend";
}

// The stage that carries the surface's own picture. A two-pass shader puts `$lightmap` in one stage
// and the texture in the other with `blendFunc filter`, so "the first stage" is the wrong answer as
// often as the right one.
function diffuseStage(sh) {
  const real = sh.stages.filter((s) => s.map && !/^\$/.test(s.map));
  if (!real.length) return null;
  return real.find((s) => s.blend === "opaque" || s.blend === "filter") || real[0];
}

// Every scripts/*.shader in the client, indexed by shader name.
class ShaderSet {
  constructor(gamefs, log) {
    this.shaders = new Map();
    this.files = gamefs.list(/^scripts\/.*\.shader$/).sort();
    for (const f of this.files) {
      try { parseShaders(gamefs.read(f).toString("latin1"), this.shaders); }
      catch (e) { if (log) log("shader script unreadable: " + f + " (" + e.message + ")"); }
    }
  }

  get(name) { return this.shaders.get(String(name).toLowerCase().replace(/\\/g, "/")) || null; }

  // Where a surface's pixels are, and how it draws. `kind` is what the KF side needs to pick a
  // material: a plain texture, a cut-out, something see-through, or the sky.
  resolve(name, gamefs) {
    const sh = this.get(name);
    const tryFile = (p) => {
      if (!p) return null;
      const base = String(p).replace(/\\/g, "/").replace(/\.(tga|jpg|jpeg|png)$/i, "");
      // Extension in the script is a hint, not a fact: half of id's own shaders say `.tga` for an
      // image that shipped as `.jpg` once the paks were rebuilt.
      for (const ext of [".tga", ".jpg", ".jpeg", ".png"]) if (gamefs.has(base + ext)) return base + ext;
      return null;
    };
    const stage = sh && diffuseStage(sh);
    const file = tryFile(name) || tryFile(stage && stage.map) || tryFile(sh && sh.editorImage);
    let kind = "normal";
    if (sh) {
      if (sh.sky || sh.params.has("sky")) kind = "sky";
      else if (sh.params.has("nodraw") || sh.params.has("trans") && !file) kind = "normal";
      if (stage) {
        if (stage.alphaFunc) kind = kind === "sky" ? kind : "masked";
        else if (stage.blend === "additive") kind = kind === "sky" ? kind : "additive";
        else if (stage.blend === "blend") kind = kind === "sky" ? kind : "translucent";
      }
      // A shader whose FIRST stage is additive over a solid one is a glow on top, not glass.
      if (kind === "additive" && sh.stages.some((s) => s.map && !/^\$/.test(s.map) && s.blend === "opaque")) kind = "normal";
    }
    // The frames of the flipbook this surface draws, in order, as files that exist.
    const frames = stage && stage.frames && stage.frames.length > 1
      ? stage.frames.map(tryFile).filter(Boolean) : null;

    // A terrain shader paints a SECOND texture over the first and blends the two by the vertex
    // alpha: `blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA` with `alphaGen vertex`. Team Arena's
    // mpterra1_0to1 is exactly that - two rocks, one weight per vertex - and carrying only the first
    // layer is why a hillside comes across as one flat rock with hard edges where the blend was.
    let overlay = null;
    if (sh && kind === "normal" && stage) {
      const later = sh.stages.filter((s) => s.map && !/^\$/.test(s.map) && s !== stage);
      const painted = later.find((s) => s.blend === "blend" && s.alphaGen === "vertex");
      const file2 = painted && tryFile(painted.map);
      if (file2 && file2 !== file) overlay = { file: file2, tcScale: painted.scale || null };
    }
    return {
      file, kind, shader: sh,
      frames: frames && frames.length > 1 ? frames : null,
      fps: (stage && stage.fps) || 0,
      tcScale: (stage && stage.scale) || null,
      overlay,
      twoSided: !!(sh && /^(none|disable|twosided)$/.test(sh.cull || "")),
      sky: sh && sh.sky,
    };
  }
}

module.exports = { ShaderSet, parseShaders, diffuseStage };
