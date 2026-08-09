"use strict";
// Self-test for the window translations (the Language picker in the header). Catches the three ways
// a locale rots: a missing/extra key, a dropped {placeholder} (the string would render "{n}" to the
// user), and a key used by the page that no dictionary defines.
// Run: node test/i18n.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "electron", "renderer");
const src = fs.readFileSync(path.join(dir, "i18n.js"), "utf8");
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");

// i18n.js is a browser script (no module system): run it against a stub window to get its API.
const win = {};
new Function("window", src)(win);
const { DICT, LANGS, t } = win.KFI18N;

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log("PASS " + name); };

const enKeys = Object.keys(DICT.en).sort();
const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");

ok("every README language has a dictionary", LANGS.every(([code]) => !!DICT[code]) && LANGS.length === Object.keys(DICT).length);

for (const [code] of LANGS) {
  const missing = enKeys.filter((k) => !(k in DICT[code]));
  const extra = Object.keys(DICT[code]).filter((k) => !(k in DICT.en));
  ok(code + ": no missing keys" + (missing.length ? " -> " + missing.join(", ") : ""), missing.length === 0);
  ok(code + ": no stale keys" + (extra.length ? " -> " + extra.join(", ") : ""), extra.length === 0);
  const badVars = enKeys.filter((k) => vars(DICT[code][k] || "") !== vars(DICT.en[k]));
  ok(code + ": placeholders match en" + (badVars.length ? " -> " + badVars.join(", ") : ""), badVars.length === 0);
}

// Keys the markup binds to, plus the ones the inline script passes to t()/setText().
const bound = [...html.matchAll(/data-i18n(?:-html|-title|-ph)?="([^"]+)"/g)].map((m) => m[1]);
const NS = /^(ui|drop|legend|label|ph|hint|chk|btn|act|log|status|state|err|dlg)\.[A-Za-z0-9]+$/;
const used = [...html.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).filter((s) => NS.test(s));
const unknown = [...new Set([...bound, ...used])].filter((k) => !(k in DICT.en));
ok("index.html uses only known keys" + (unknown.length ? " -> " + unknown.join(", ") : ""), unknown.length === 0);
ok("index.html actually binds keys", bound.length > 15);

// Fallback + interpolation: an untranslated key falls back to English, an unknown key renders itself.
global.document = { documentElement: {}, querySelectorAll: () => [] };   // apply() walks the page; here there is none
win.KFI18N.apply("ru");
ok("t() interpolates vars", t("status.converting", { name: "de_dust.bsp" }).includes("de_dust.bsp"));
ok("t() falls back to en", t("__nope__") === "__nope__" && t("btn.convert") !== DICT.en["btn.convert"]);
win.KFI18N.apply("en");
ok("default language is English", t("btn.convert") === "Convert");

console.log("\ni18n: " + pass + "/" + pass + " checks passed");
