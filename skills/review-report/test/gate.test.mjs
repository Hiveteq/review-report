// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../lib/story.mjs';
import { computeCoverage, matchGlob } from '../lib/coverage.mjs';
import { parseDiff } from '../lib/diff.mjs';
import { gateErrors, LIMITS } from '../lib/gate.mjs';
import { fixtureFiles, fixtureStory, minimalStory } from './helpers.mjs';

/** @typedef {import('../lib/story.mjs').Story} Story */
/** @typedef {import('../lib/diff.mjs').DiffFile} DiffFile */

const TESTS_REQUIRED = "tests is required: globs matching this project's test files, [] if the change has none";
const COVERAGE_ADVICE = '  add chapters for these files, or exclude them in the story with a reason (generated, vendored, docs, fixtures)';

/**
 * Runs the gate as the CLI does: the report and its coverage come from the story and the files of the part.
 * @param {Story} story
 * @param {{ files?: DiffFile[], allFiles?: DiffFile[], minCoverage?: number }} [options] `allFiles` defaults to
 *   `files`, as when no --only narrows the diff
 * @returns {string[]}
 */
function gateFor(story, { files = fixtureFiles(), allFiles = files, minCoverage = 80 } = {}) {
  const report = buildReport(story, files);
  assert.deepEqual(report.errors, [], 'the story must reference the diff, or the gate never runs');
  return gateErrors({ story, report, coverage: computeCoverage(story, files, report), allFiles, minCoverage });
}

/**
 * Diff text that adds a file of `count` numbered lines.
 * @param {string} path
 * @param {number} count
 * @returns {string}
 */
function addedFile(path, count) {
  const body = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join('\n');
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n${body}\n`;
}

/**
 * A valid story with one chapter that shows each of `paths` whole.
 * @param {string[]} paths
 * @param {Record<string, unknown>} [overrides] other top-level story fields
 * @returns {Story}
 */
function storyShowing(paths, overrides = {}) {
  const hunks = paths.map((file) => ({ file, lines: 'all' }));
  return /** @type {Story} */ (minimalStory({ chapters: [{ title: 'Shown', intro: 'One. Two.', hunks }], ...overrides }));
}

test('a story that meets every rule passes the gate', () => {
  assert.deepEqual(gateFor(fixtureStory()), []);
});

test('the story must declare its test globs; an empty list is allowed', () => {
  const story = fixtureStory();
  delete story.tests;
  assert.deepEqual(gateFor(story), [TESTS_REQUIRED]);

  story.tests = [];
  assert.deepEqual(gateFor(story), []);
});

test('a test file shown in a chapter needs a covers statement', () => {
  const story = fixtureStory();
  story.tests = ['src/Name.java']; // stands in for a test file in this fixture
  assert.deepEqual(gateFor(story), [
    'chapters[0].hunks[0]: src/Name.java is a test file (matches src/Name.java); add "covers": what it pins and what it leaves untested',
  ]);

  story.chapters[0].hunks[0].covers = 'Pins the record accessor; equality is not tested.';
  assert.deepEqual(gateFor(story), []);
});

test('covers text of only spaces counts as missing', () => {
  const story = fixtureStory();
  story.tests = ['src/Name.java'];
  story.chapters[0].hunks[0].covers = '   ';
  assert.deepEqual(gateFor(story), [
    'chapters[0].hunks[0]: src/Name.java is a test file (matches src/Name.java); add "covers": what it pins and what it leaves untested',
  ]);
});

test('test files are reported in the order they first appear, each naming the first test glob it matches', () => {
  const story = fixtureStory();
  story.tests = ['src/*.java', 'src/Name.java'];
  assert.deepEqual(gateFor(story), [
    'chapters[0].hunks[0]: src/Name.java is a test file (matches src/*.java); add "covers": what it pins and what it leaves untested',
    'chapters[1].hunks[0]: src/Greeter.java is a test file (matches src/*.java); add "covers": what it pins and what it leaves untested',
    'chapters[2].hunks[0]: src/Legacy.java is a test file (matches src/*.java); add "covers": what it pins and what it leaves untested',
  ]);
});

test('a test file shown twice is reported once, at its first hunk, and one covers statement is enough', () => {
  const story = fixtureStory();
  story.tests = ['src/Name.java'];
  story.chapters[1].hunks.push({ file: 'src/Name.java', lines: 'all' });
  assert.deepEqual(gateFor(story), [
    'chapters[0].hunks[0]: src/Name.java is a test file (matches src/Name.java); add "covers": what it pins and what it leaves untested',
  ]);

  story.chapters[1].hunks[1].covers = 'Pins the record accessor.';
  assert.deepEqual(gateFor(story), []);
});

test(`a chapter showing more than ${LIMITS.maxChapterLines} changed lines is refused with a split instruction`, () => {
  const files = parseDiff(addedFile('big.txt', 1200));
  const story = storyShowing(['big.txt']);
  story.chapters[0].title = 'One huge chapter';
  assert.deepEqual(gateFor(story, { files }), [
    'chapters[0] "One huge chapter" shows 1200 changed lines; split it into chapters of one idea each (at most 1000 lines)',
  ]);
});

test(`a chapter of exactly ${LIMITS.maxChapterLines} changed lines is accepted`, () => {
  const files = parseDiff(addedFile('big.txt', 1000));
  assert.deepEqual(gateFor(storyShowing(['big.txt']), { files }), []);
});

test('an exclude glob that matches no file in the diff is an error', () => {
  const story = fixtureStory();
  story.exclude.push({ glob: 'nothing/**', reason: 'matches no file on purpose' });
  assert.deepEqual(gateFor(story), ['exclude glob matches no file in this diff: nothing/**']);
});

test('an exclude glob for files outside the --only part is not an error', () => {
  const allFiles = fixtureFiles();
  const files = allFiles.filter((f) => matchGlob('src/**', f.path));
  const story = fixtureStory();
  story.chapters = story.chapters.slice(0, 3); // the three src/ files; the story still excludes docs/**
  assert.deepEqual(gateFor(story, { files, allFiles }), []);

  // Against the part alone, docs/** would match nothing: the whole diff is what saves it.
  assert.deepEqual(gateFor(story, { files }), ['exclude glob matches no file in this diff: docs/**']);
});

test('coverage below the minimum fails with the uncovered files listed, most lines not shown first', () => {
  const story = fixtureStory();
  story.chapters = [story.chapters[0]]; // only Name.java explained: 3 of 14 counted lines
  assert.deepEqual(gateFor(story), [
    'coverage 21% of changed lines shown in chapters; minimum is 80%. Not shown, largest first:',
    '  src/Greeter.java +3 -2 (5 not shown)',
    '  README.md +2 -2 (4 not shown)',
    '  src/Legacy.java +0 -2 (2 not shown)',
    COVERAGE_ADVICE,
  ]);
});

test('coverage is compared as a whole percent, so a rounded value equal to the minimum passes', () => {
  const story = fixtureStory();
  story.chapters = [story.chapters[0]]; // 3 of 14 lines: 21.4%, shown as 21%
  assert.deepEqual(gateFor(story, { minCoverage: 21 }), []);
  assert.equal(gateFor(story, { minCoverage: 22 }).length, 5);
});

test(`at most ${LIMITS.uncoveredListed} uncovered files are listed, then a count of the rest`, () => {
  const names = Array.from({ length: 41 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`);
  const files = parseDiff(['shown.txt', ...names].map((p) => addedFile(p, 1)).join(''));
  const listed = names.slice(0, 40).map((n) => `  ${n} +1 -0 (1 not shown)`);
  assert.deepEqual(gateFor(storyShowing(['shown.txt']), { files }), [
    'coverage 2% of changed lines shown in chapters; minimum is 80%. Not shown, largest first:',
    ...listed,
    '  … and 1 more files',
    COVERAGE_ADVICE,
  ]);

  const forty = files.filter((f) => f.path !== 'f41.txt');
  assert.deepEqual(gateFor(storyShowing(['shown.txt']), { files: forty }), [
    'coverage 2% of changed lines shown in chapters; minimum is 80%. Not shown, largest first:',
    ...listed,
    COVERAGE_ADVICE,
  ]);
});

test('every failing rule is reported, in the order a reader should fix them', () => {
  const files = parseDiff(addedFile('big.txt', 1200) + addedFile('other.txt', 2000));
  const story = storyShowing(['big.txt'], { tests: undefined, exclude: [{ glob: 'nothing/**', reason: 'r' }] });
  assert.deepEqual(gateFor(story, { files }), [
    TESTS_REQUIRED,
    'chapters[0] "Shown" shows 1200 changed lines; split it into chapters of one idea each (at most 1000 lines)',
    'exclude glob matches no file in this diff: nothing/**',
    'coverage 38% of changed lines shown in chapters; minimum is 80%. Not shown, largest first:',
    '  other.txt +2000 -0 (2000 not shown)',
    COVERAGE_ADVICE,
  ]);
});
