// Runs one conversion in a child process and reports back over IPC.
"use strict";

const path = require("path");
const fs = require("fs");
const { convert } = require("../src/convert");
const { verify } = require("../src/verify");
const { clientRoots } = require("../src/resources");

process.on("message", (job) => {
  const log = (t) => process.send({ kind: "log", text: t });
  // The picked Counter-Strike folder goes first: its stock WADs and gfx/env skyboxes are what a
  // downloaded .bsp is missing. convert() still adds the map's own neighbourhood after these.
  const wadDirs = [...clientRoots(job.csDir), ...(job.wadDirs || [])];
  try {
    const res = convert({
      bspFile: job.bspFile,
      outFile: job.outDir ? path.join(job.outDir, (job.name || ("KF-" + path.basename(job.bspFile).replace(/\.bsp$/i, ""))) + ".rom") : null,
      mapName: job.name || null,
      scale: job.scale, lightMapScale: job.lightMapScale,
      wadDirs, emitPlayerStarts: job.emitPlayerStarts !== false, log,
    });

    if (job.emitAse) {
      const { writeAse, writeT3d } = require("../src/backendB");
      const base = res.out.replace(/\.rom$/i, "");
      const a = writeAse(job.bspFile, base + ".ase", { scale: job.scale, wadDirs });
      const t = writeT3d(job.bspFile, base + ".t3d", { scale: job.scale });
      log("backend B: " + a.faces + " triangles, " + a.materials + " materials, " + t.playerStarts + " starts, " + t.lights + " lights");
    }

    const v = verify(res.out);
    for (const line of v.report.split("\n")) log(line);

    process.send({
      kind: "done", ok: v.ok, out: res.out, mapName: res.mapName,
      size: fs.statSync(res.out).size,
      nodes: res.model ? res.model.nodes.length : 0,
      surfs: res.model ? res.model.surfs.length : 0,
      lightMaps: res.model ? res.model.lightMaps.length : 0,
      atlases: res.model ? res.model.lightMapTextures.length : 0,
      textures: res.textures, missingTextures: res.missingTextures,
    });
  } catch (e) {
    log("ERROR: " + e.message);
    process.send({ kind: "done", ok: false, error: e.message });
  }
  process.exit(0);
});
