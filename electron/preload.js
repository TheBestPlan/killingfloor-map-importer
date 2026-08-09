"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s) => ipcRenderer.invoke("settings:set", s),
  pickBsp: (title) => ipcRenderer.invoke("pick:bsp", title),
  pickDir: (title) => ipcRenderer.invoke("pick:dir", title),
  reveal: (f) => ipcRenderer.invoke("reveal", f),
  convert: (job) => ipcRenderer.invoke("convert", job),
  onProgress: (cb) => ipcRenderer.on("progress", (e, m) => cb(m)),
});
