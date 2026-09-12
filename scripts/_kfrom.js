// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// The .rom package reader these research scripts use lives in the sibling repository
// killingfloor-map-viewer (https://github.com/TheBestPlan/killingfloor-map-viewer). Clone it next to
// this one, or point KF_ROM_JS at its kfrom.js.
"use strict";

const path = require("path");

const target = process.env.KF_ROM_JS ||
  path.resolve(__dirname, "..", "..", "killingfloor-map-viewer", "kfrom.js");

try {
  module.exports = require(target);
} catch (e) {
  console.error("kfrom.js not found at " + target +
    "\nClone killingfloor-map-viewer next to this repository, or set KF_ROM_JS to its kfrom.js.");
  process.exit(1);
}
