// @ts-check
// Pins what the renderer prints and writes, byte for byte, so refactors cannot change output unnoticed.
// The inlined page script and stylesheet are replaced by markers: they have their own browser tests,
// and pinning them here would make every page-script change rewrite these snapshots.
import * as nodeTest from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIFF_PATH, FIXTURE_STORY_PATH, SKILL_DIR, spawnRender, tempDir } from './helpers.mjs';

const { test } = nodeTest;

// @types/node 20 predates the snapshot API (Node 22.3+), so the two calls used here are typed locally.
const snapshotApi = /** @type {{ snapshot: { setDefaultSnapshotSerializers(serializers: ((value: unknown) => unknown)[]): void } }} */ (/** @type {unknown} */ (nodeTest));
snapshotApi.snapshot.setDefaultSnapshotSerializers([(value) => value]);

/**
 * @param {import('node:test').TestContext} t
 * @param {unknown} value
 * @returns {void}
 */
function matchSnapshot(t, value) {
  // The cast stays here: @types/node 20 has no typing for `assert.snapshot`.
  /** @type {{ assert: { snapshot(value: unknown): void } }} */ (/** @type {unknown} */ (t)).assert.snapshot(value);
}

const inlined = ['template/report.js', 'template/report.css'].map((f) => [readFileSync(join(SKILL_DIR, f), 'utf8'), `/* ${f} */`]);

/**
 * @param {string} html
 * @returns {string}
 */
const withoutInlinedAssets = (html) => inlined.reduce((text, [content, marker]) => text.replaceAll(content, marker), html);

/**
 * Replaces one directory path in both separator forms, so output is the same on every platform.
 * @param {string} text
 * @param {string} dir
 * @param {string} label
 * @returns {string}
 */
const labelled = (text, dir, label) => text.replaceAll(dir, label).replaceAll(dir.replaceAll('\\', '/'), label);

/**
 * @param {string[]} args
 * @param {[string, string][]} [labels] exact paths the run prints, each with the portable text shown instead; a
 *   whole printed path is labelled, so its separators (backslashes on Windows) do not reach the snapshot
 * @returns {string} exit code, stdout and stderr as one text, with the skill and output paths made portable
 */
function run(args, labels = []) {
  const r = spawnRender(args);
  const text = `exit ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`;
  return [...labels, [SKILL_DIR, '<skill>/']].reduce((portable, [path, label]) => labelled(portable, path, label), text);
}

test('paged output of the fixture', (t) => {
  const out = tempDir(t);
  const index = join(out, 'r', 'index.html');
  matchSnapshot(t, run(['--story', FIXTURE_STORY_PATH, '--diff-file', FIXTURE_DIFF_PATH, '--pages', '--out', join(out, 'r.html')], [[index, '<out>/r/index.html']]));

  const dir = join(out, 'r');
  const pages = readdirSync(dir).sort();
  matchSnapshot(t, pages.join('\n'));
  for (const page of pages) matchSnapshot(t, withoutInlinedAssets(readFileSync(join(dir, page), 'utf8')));
});

test('numbered dump of the fixture', (t) => {
  matchSnapshot(t, run(['--dump-numbered', '--diff-file', FIXTURE_DIFF_PATH]));
});

/** Each failing story, with the extra arguments it needs: the gate story asks for coverage it cannot reach. */
const STORIES = {
  'invalid-story': [],
  'bad-references': [],
  'gate-failures': ['--min-coverage', '100'],
  'test-without-covers': [],
};

for (const [name, extra] of Object.entries(STORIES)) {
  test(`messages for ${name}`, (t) => {
    const out = tempDir(t);
    const target = join(out, 'never-written.html');
    matchSnapshot(t, run(['--story', join(SKILL_DIR, `test/stories/${name}.json`), '--diff-file', FIXTURE_DIFF_PATH, '--out', target, ...extra], [[out, '<out>']]));
    t.assert.equal(existsSync(target), false, 'a failing run must not write the report');
  });
}
