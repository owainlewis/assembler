const { test } = require('node:test');
const assert = require('node:assert/strict');
const slugify = require('/workspace/slugify.cjs');

for (const [input, expected] of [
  ['Hello World', 'hello-world'],
  ['  A repeatable workflow!  ', 'a-repeatable-workflow'],
  ['Docker + gVisor / Demo 123', 'docker-gvisor-demo-123'],
  ['already-a-slug', 'already-a-slug'],
  ['', ''],
  [' !!! ', ''],
]) {
  test(JSON.stringify(input), () => assert.equal(slugify(input), expected));
}
