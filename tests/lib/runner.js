/**
 * A deliberately tiny test runner -- no dependency to install, matching
 * the rest of this repo's zero-build-step philosophy (see js/data.js's own
 * header comment on why the site itself has no bundler). Collects and
 * reports failures rather than throwing on the first one, so a single CI
 * run shows everything that's actually broken, not just the first symptom.
 */
let currentSuite = null;
const suites = [];

function describe(name, fn) {
  currentSuite = { name, tests: [] };
  suites.push(currentSuite);
  fn();
  currentSuite = null;
}

function test(name, fn) {
  if (!currentSuite) throw new Error(`test("${name}") called outside describe()`);
  currentSuite.tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

assert.equal = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

assert.deepEqual = (actual, expected, message) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(message || `Expected ${e}, got ${a}`);
  }
};

function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const suite of suites) {
    console.log(`\n${suite.name}`);
    for (const { name, fn } of suite.tests) {
      try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
      } catch (err) {
        failed++;
        failures.push({ suite: suite.name, test: name, error: err });
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - [${f.suite}] ${f.test}: ${f.error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { describe, test, assert, run };
