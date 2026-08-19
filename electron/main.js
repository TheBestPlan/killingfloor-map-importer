// Electron shell around the converter. The conversion itself runs in a child process so a crash or
// a huge map cannot take the window down with it.
"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");

const SETTINGS = path.join(app.getPath("userData"), "settings.json");
const DEFAULT_SETTINGS = {
  outDir: "",
  csDir: "",
  wadDirs: [],
  scale: 1.9165,
  lightMapScale: 32,
  healthScale: 1,      // multiplies every func_breakable's Health; 1 is what the map itself says
  lighting: "ambient", // "ambient" plays as converted, "sunlight" is written for a Build in KFEd
  lightScale: 1,       // multiplies the sun and every lamp
  emitAse: false,
  emitPlayerStarts: true,
  lang: "en",          // UI language (Language picker in the header)
  // Which game the maps come from. "cs" reads GoldSrc .bsp files, "l2" a Lineage 2 client.
  game: "cs",
  l2Dir: "",
  terrainStep: 1,      // 1 keeps every terrain vertex, 2 halves the grid
  l2Ambient: 32,       // the zone: the light on the player and the zeds
  l2Glow: 40,          // AmbientGlow on the world's own actors
  // Quake 3: the client folder, and the same two-way light split as Lineage 2. The defaults are the
  // converter's own - see src/quake3/convert.js for why the scale cannot go above 1.94.
  q3Dir: "",
  q3Scale: 1.9,
  q3Patch: 4,          // bezier tessellation level
  q3Ambient: 40,
  q3Glow: 96,
  q3LightGain: 4,      // Quake 3 lightmaps are dark on purpose; this is what lifts them
  // Tactical Ops: an Unreal Engine 1 install. The scale ceiling is the step again - see
  // src/tacticalops/convert.js - and the light gain is what the rebuilt UE1 light mesh ends in.
  toDir: "",
  toScale: 1.3,
  toAmbient: 32,
  toGlow: 64,
  toLightGain: 3,
};

function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(SETTINGS, "utf8"))); }
  catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
function saveSettings(s) {
  try { fs.mkdirSync(path.dirname(SETTINGS), { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2)); } catch (e) { }
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 740, backgroundColor: "#14161a",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // KF_SHOT=<file.png> captures the window and quits. Capturing the desktop instead gets whatever
  // Windows has on top - the foreground lock means that is often not this app - so the picture has
  // to come from the renderer itself. It is how the window gets checked without a person at it.
  if (process.env.KF_SHOT) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.KF_SHOT, img.toPNG());
        } catch (e) { console.error("capture failed: " + e.message); }
        app.quit();
      }, Number(process.env.KF_SHOT_DELAY || 2500));
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:set", (e, s) => { saveSettings(s); return s; });

ipcMain.handle("pick:bsp", async (e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title: title || "Pick Counter-Strike 1.6 maps",
    filters: [{ name: "GoldSrc BSP", extensions: ["bsp"] }],
    properties: ["openFile", "multiSelections"],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("pick:dir", async (e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("reveal", (e, file) => { if (file && fs.existsSync(file)) shell.showItemInFolder(file); });

// The world squares a Lineage 2 client holds. Reading the folder is enough - the names are the grid
// position - so this does not open a single package.
ipcMain.handle("l2:squares", (e, dir) => {
  try {
    const { Client } = require("../src/lineage2/package");
    return new Client(dir).squares().map((s) => ({ name: s.name, x: s.x, y: s.y }));
  } catch (err) { return []; }
});

// The maps a Quake III client holds, across baseq3 and every mod folder beside it. Reading the
// archives' central directories is enough - not one map is opened.
ipcMain.handle("q3:maps", (e, dir) => {
  try {
    const { GameFs, searchDirs } = require("../src/quake3/pk3");
    const out = [];
    const seen = new Set();
    for (const mod of fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name)))
      .map((d) => d.name)
      .sort((a, b) => (a === "baseq3" ? -1 : b === "baseq3" ? 1 : a.localeCompare(b)))) {
      let fsys;
      try { fsys = new GameFs(searchDirs(dir, mod)); } catch (err) { continue; }
      for (const m of fsys.list(/^maps\/.*\.bsp$/).sort()) {
        const name = path.basename(m, ".bsp");
        // A mod folder reads baseq3 underneath it, so its listing repeats every stock map.
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, mod });
      }
      fsys.close();
    }
    return out;
  } catch (err) { return []; }
});

// The maps a Tactical Ops install holds. Only the folder is read: a map is a .unr in
// TacticalOps\Maps and its name is all the list needs.
ipcMain.handle("to:maps", (e, dir) => {
  try {
    const { Client } = require("../src/tacticalops/package");
    return new Client(dir).maps().map((m) => ({ name: m.name }));
  } catch (err) { return []; }
});

// One child process per map; progress lines stream back to the renderer.
ipcMain.handle("convert", (e, job) => new Promise((resolve) => {
  const child = fork(path.join(__dirname, "worker.js"), [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const send = (type, text) => { if (win && !win.isDestroyed()) win.webContents.send("progress", { type, text, file: job.bspFile }); };
  child.stdout.on("data", (d) => send("log", String(d).trimEnd()));
  child.stderr.on("data", (d) => send("err", String(d).trimEnd()));
  child.on("message", (m) => {
    if (m.kind === "log") send("log", m.text);
    else if (m.kind === "done") resolve(m);
  });
  child.on("error", (err) => resolve({ kind: "done", ok: false, error: err.message }));
  child.on("exit", (code) => { if (code !== 0) resolve({ kind: "done", ok: false, error: "worker exited with code " + code }); });
  child.send(job);
}));
