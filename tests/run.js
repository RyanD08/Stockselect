#!/usr/bin/env node
/**
 * Entry point: `node tests/run.js`. Discovers every tests/*.test.js file,
 * requires it (which registers its describe()/test() blocks against the
 * shared runner instance -- see lib/runner.js), then runs everything and
 * exits non-zero on any failure so CI actually fails the build.
 */
const fs = require('fs');
const path = require('path');
const { run } = require('./lib/runner');

const testsDir = __dirname;
const testFiles = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (testFiles.length === 0) {
  console.error('No *.test.js files found in tests/.');
  process.exit(1);
}

for (const file of testFiles) {
  require(path.join(testsDir, file));
}

run();
