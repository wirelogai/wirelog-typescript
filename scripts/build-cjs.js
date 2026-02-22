/**
 * Simple script to create a CJS wrapper for the ESM build.
 * This avoids needing a bundler as a dev dependency.
 */

import { writeFileSync } from "node:fs";

const cjs = `"use strict";

const mod = await import("./index.js");
module.exports = mod;
`;

writeFileSync("dist/index.cjs", cjs);
console.log("Built dist/index.cjs");
