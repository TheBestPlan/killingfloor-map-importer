"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Electron 32 removed File.path; a dropped file's path only comes from here now.
  droppedPath: (file) => webUtils.getPathForFile(file),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s) => ipcRenderer.invoke("settings:set", s),
  pickBsp: (title) => ipcRenderer.invoke("pick:bsp", title),
  pickDir: (title) => ipcRenderer.invoke("pick:dir", title),
  reveal: (f) => ipcRenderer.invoke("reveal", f),
  convert: (job) => ipcRenderer.invoke("convert", job),
  listSquares: (dir) => ipcRenderer.invoke("l2:squares", dir),
  listQ3Maps: (dir) => ipcRenderer.invoke("q3:maps", dir),
  listTOMaps: (dir) => ipcRenderer.invoke("to:maps", dir),
  onProgress: (cb) => ipcRenderer.on("progress", (e, m) => cb(m)),
});
