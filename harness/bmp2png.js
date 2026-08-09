// BMP -> downscaled PNG, without GDI+ (which refuses the engine's 32-bit BMPs at some sizes).
const fs = require("fs"), zlib = require("zlib");

function readBmp(file) {
  const b = fs.readFileSync(file);
  const dataOff = b.readUInt32LE(10), hdr = b.readUInt32LE(14);
  const w = b.readInt32LE(18), h = b.readInt32LE(22), bpp = b.readUInt16LE(28);
  // The engine writes rows with no 4-byte padding, which GDI+ also chokes on; detect either.
  const bytes = bpp / 8, H0 = Math.abs(h);
  const padded = Math.ceil(w * bytes / 4) * 4;
  const stride = (b.length - dataOff) >= padded * H0 ? padded : w * bytes;
  const flip = h > 0, H = Math.abs(h);
  const px = (x, y) => {
    const sy = flip ? H - 1 - y : y;
    const o = dataOff + sy * stride + x * bytes;
    return [b[o + 2], b[o + 1], b[o]];
  };
  return { w, h: H, bpp, hdr, px };
}

function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const [src, dst, maxW] = [process.argv[2], process.argv[3], +(process.argv[4] || 700)];
const im = readBmp(src);
const scale = Math.min(1, maxW / im.w);
const W = Math.max(1, Math.round(im.w * scale)), H = Math.max(1, Math.round(im.h * scale));
const out = Buffer.alloc(W * H * 3);
let lum = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const p = im.px(Math.min(im.w - 1, Math.round(x / scale)), Math.min(im.h - 1, Math.round(y / scale)));
  const o = (y * W + x) * 3;
  out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2];
  lum += (p[0] + p[1] + p[2]) / 3;
}
fs.writeFileSync(dst, png(W, H, out));
console.log(dst + "  " + W + "x" + H + "  mean luminance " + (lum / (W * H)).toFixed(1));
