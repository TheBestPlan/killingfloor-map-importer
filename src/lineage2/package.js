// Lineage 2 client packages: the same Unreal Engine 2 container Killing Floor uses, wrapped in one
// of NCSoft's header encryptions.
//
// A client file starts with 28 bytes of UTF-16LE naming the scheme - "Lineage2Ver111" - and the rest
// is the ordinary package. 111 and 121 are a byte-wise XOR; 111's key is the constant 0xAC, which is
// how the tag falls out on the first four bytes:
//
//   6d 2f 86 32  ^ AC  ->  c1 83 2a 9e   = 0x9E2A83C1, the Unreal package tag
//
// After that our own reader takes it unchanged: Interlude packages are file version 123 against
// Killing Floor's 128, and the header, name, import and export tables did not move between them.
// The licensee version varies from file to file (12, 25, 28 all appear) and nothing reads it.
"use strict";

const fs = require("fs");
const path = require("path");
const { parsePackage } = require("../unreal/read");

const HEADER = 28;                       // "Lineage2Ver###" in UTF-16LE
const KEY_111 = 0xac;

// 121 XORs with a key built from the file's own name, which is why it has to be passed in.
function key121(fileName) {
  const base = path.basename(fileName).toLowerCase();
  let sum = 0;
  for (let i = 0; i < base.length; i++) sum += base.charCodeAt(i);
  return sum & 0xff;
}

function decrypt(file, raw) {
  const tag = raw.length >= HEADER ? raw.toString("utf16le", 0, HEADER) : "";
  const m = /^Lineage2Ver(\d+)/.exec(tag);
  if (!m) return { buf: raw, crypt: "none" };
  const ver = m[1];
  let key;
  if (ver === "111") key = KEY_111;
  else if (ver === "121" || ver === "120") key = key121(file);
  else throw new Error(path.basename(file) + ": Lineage2Ver" + ver + " is not a XOR scheme this reads");
  const body = raw.subarray(HEADER);
  const out = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body[i] ^ key;
  return { buf: out, crypt: ver };
}

function load(file) {
  const { buf, crypt } = decrypt(file, fs.readFileSync(file));
  const pkg = parsePackage(buf);
  if (pkg.header.tag !== 0x9e2a83c2 >>> 0 && pkg.header.tag !== 0x9e2a83c1 >>> 0) {
    throw new Error(path.basename(file) + ": not an Unreal package after decryption (tag 0x" +
      pkg.header.tag.toString(16) + ", crypt " + crypt + ")");
  }
  pkg.file = file;
  pkg.crypt = crypt;
  pkg.pkgName = path.basename(file).replace(/\.[^.]+$/, "");
  return pkg;
}

// The client's own folders, in the order the engine searches them. A package is named without its
// extension in an import ("LineageNPC"), so the extension has to be guessed from where it lives.
const FOLDERS = [
  ["maps", ".unr"], ["staticmeshes", ".usx"], ["textures", ".utx"], ["systextures", ".utx"],
  ["animations", ".ukx"], ["sounds", ".uax"], ["music", ".umx"], ["system", ".u"],
];

// Index of every package a client holds, by lowercased name. Built once and shared, because a town
// square pulls meshes out of dozens of packages and the client has 800 of them.
class Client {
  constructor(root) {
    this.root = root;
    this.byName = new Map();
    this.open = new Map();
    for (const [dir, ext] of FOLDERS) {
      let names = [];
      try { names = fs.readdirSync(path.join(root, dir)); } catch (e) { continue; }
      for (const n of names) {
        if (path.extname(n).toLowerCase() !== ext) continue;
        const key = path.basename(n, path.extname(n)).toLowerCase();
        if (!this.byName.has(key)) this.byName.set(key, path.join(root, dir, n));
      }
    }
  }

  has(name) { return this.byName.has(String(name).toLowerCase()); }
  pathOf(name) { return this.byName.get(String(name).toLowerCase()) || null; }

  // Packages are held open: a square's meshes come back to the same few .usx over and over, and each
  // one costs a decrypt of the whole file.
  get(name) {
    const key = String(name).toLowerCase();
    if (this.open.has(key)) return this.open.get(key);
    const file = this.byName.get(key);
    const pkg = file ? load(file) : null;
    this.open.set(key, pkg);
    return pkg;
  }

  // Every map square, as { name, x, y, file }. L2 names them "<x>_<y>.unr" on a 32768-unit grid.
  squares() {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(path.join(this.root, "maps")); } catch (e) { return out; }
    for (const n of names) {
      const m = /^(\d+)_(\d+)\.unr$/i.exec(n);
      if (!m) continue;
      out.push({ name: path.basename(n, ".unr"), x: +m[1], y: +m[2], file: path.join(this.root, "maps", n) });
    }
    return out.sort((a, b) => a.x - b.x || a.y - b.y);
  }
}

module.exports = { load, decrypt, Client, HEADER };
