// Is this frame the artefact? The artefact is a FLAT frame: the world is missing, so almost every
// pixel outside the weapon and HUD is the one clear colour. A dark wall is dark but never flat.
const fs = require("fs"), zlib = require("zlib");
function readPNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString("latin1", p + 4, p + 8);
    if (type === "IHDR") { w = b.readUInt32BE(p + 8); h = b.readUInt32BE(p + 12); ct = b[p + 17]; }
    else if (type === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len));
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  const px = Buffer.alloc(w * h * ch);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[o++]; const line = raw.subarray(o, o + stride); o += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += bb; else if (f === 3) v += (a + bb) >> 1;
      else if (f === 4) { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c); }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, px };
}
// Edge density over the left 60% of the frame, away from the weapon and the HUD. The artefact
// leaves the world unrendered, so that area has no edges at all; a dark wall still has plenty.
for (const f of process.argv.slice(2)) {
  let im; try { im = readPNG(f); } catch (e) { continue; }
  let edges = 0, n = 0;
  const X = Math.floor(im.w * 0.6), Y = im.h - 1;
  for (let y = 1; y < Y; y++) {
    for (let x = 1; x < X; x++) {
      const s = (y * im.w + x) * im.ch, l = (y * im.w + x - 1) * im.ch, u = ((y - 1) * im.w + x) * im.ch;
      const d = Math.abs(im.px[s] - im.px[l]) + Math.abs(im.px[s + 1] - im.px[l + 1]) + Math.abs(im.px[s + 2] - im.px[l + 2])
              + Math.abs(im.px[s] - im.px[u]) + Math.abs(im.px[s + 1] - im.px[u + 1]) + Math.abs(im.px[s + 2] - im.px[u + 2]);
      if (d > 24) edges++;
      n++;
    }
  }
  const pct = 100 * edges / n;
  console.log((pct < 1.0 ? 'FLAT  ' : '      ') + f.split(/[\/]/).pop().padEnd(16) + ' edge density ' + pct.toFixed(2) + '%');
}
