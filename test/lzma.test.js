// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 TheBestPlan

// Verifies the LZMA1 lump decoder against a python `lzma.FORMAT_ALONE` vector (wrapped in Valve's
// lump header). The payload is deterministic, so it is regenerated here; only the compressed blob is
// embedded. Self-contained - no python needed at test time.
"use strict";

const assert = require("assert");
const { decodeLump } = require("../src/source/lzma");

// The exact payload python compressed: 300 lines, each "...dog %04d. " with i%37.
let payload = "";
for (let i = 0; i < 300; i++) payload += "The quick brown fox jumps over the lazy dog " + String(i % 37).padStart(4, "0") + ". ";
const expected = Buffer.from(payload, "latin1");

const VALVE_B64 =
  "TFpNQZg6AACxAAAAXQAAgAAAKhoIogMlZvFLeMWiBf8u5tnSIBqtNPjiHehBNvrcBmm7POQQNCcJ67Nm4xFpPa1UOMgYLfj5dlL9tycLNvdS3kahIUoztaqJ84Yp/Jr7cHlkL+Bo+//QRR2ZdrquWhDLLLGKSG5ezswIDrKsmAEMEgtya0YYEaPeLrIA21m4HJttaAy8dCQ8pnxWg5nwXmqne9zTd08Czg8jOw2mS6v0IHedKgYWuOSB8D3//ykxuAA=";
const blob = Buffer.from(VALVE_B64, "base64");

const out = decodeLump(blob);
assert.strictEqual(out.length, expected.length, "decoded length " + out.length + " != " + expected.length);
assert.ok(out.equals(expected), "decoded bytes differ from expected payload");
console.log("  LZMA1 lump decoder: " + out.length + " bytes round-trip vs python FORMAT_ALONE vector");
console.log("lzma.test.js: passed");
