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
  scale: 1.9,
  lightMapScale: 32,
  healthScale: 1,      // multiplies every func_breakable's Health; 1 is what the map itself says
  emitAse: false,
  emitPlayerStarts: true,
  lang: "en",          // UI language (Language picker in the header)
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
