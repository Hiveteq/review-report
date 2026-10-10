import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDiff } from '../lib/diff.mjs';
import { buildReport } from '../lib/story.mjs';
import { computeCoverage, matchGlob, DEFAULT_EXCLUDES } from '../lib/coverage.mjs';

const files = parseDiff(readFileSync(new URL('./fixture.diff', import.meta.url), 'utf8'));
const story = () => JSON.parse(readFileSync(new URL('./fixture.story.json', import.meta.url), 'utf8'));

test('glob matching covers *, ** and ? without any stack-specific assumptions', () => {
  assert.ok(matchGlob('docs/**', 'docs/a/b.md'));
  assert.ok(matchGlob('docs/**', 'docs/x.md'));
  assert.ok(!matchGlob('docs/**', 'src/docs/x.md'));
  assert.ok(matchGlob('**/*.snap', 'a/b/c.snap'));
  assert.ok(matchGlob('*.lock', 'yarn.lock'));
  assert.ok(!matchGlob('*.lock', 'sub/yarn.lock'));
  assert.ok(matchGlob('src/?.js', 'src/a.js'));
});

test('built-in exclusions are universal: binaries, lockfiles, minified, generated and vendored paths', () => {
  const names = ['package-lock.json', 'Cargo.lock', 'go.sum', 'poetry.lock', 'x/app.min.js', 'x/app.js.map',
    'web/src/generated/client/x.ts', 'vendor/lib/a.go', 'node_modules/a/b.js', 'dist/bundle.js', 'build/out.o', 'a/__generated__/b.ts'];
  for (const n of names) assert.ok(DEFAULT_EXCLUDES.some((g) => matchGlob(g, n)), `${n} should be excluded by default`);
  for (const n of ['src/main.rs', 'lib/x.py', 'README.md', 'src/generated_report.ts', 'build.gradle']) {
    assert.ok(!DEFAULT_EXCLUDES.some((g) => matchGlob(g, n)), `${n} should count`);
  }
});

test('coverage counts changed lines of counted files and reports what chapters explained', () => {
  const s = story();
  const report = buildReport(s, files);
  const cov = computeCoverage(s, files, report);
  // Greeter 5, Name 3, Legacy 2, README 4 count; docs/** excluded by the story; binaries excluded by default;
  // mode-only and pure-rename files have no changed lines.
  assert.equal(cov.total, 14);
  assert.equal(cov.explained, 12); // README's first hunk (2 lines) is in the appendix
  assert.equal(cov.ratio, 12 / 14);
  assert.deepEqual(cov.uncovered, [{ path: 'README.md', changed: 4, explained: 2, missing: 2 }]);
  assert.deepEqual(cov.excluded.map((e) => [e.path, e.reason]), [
    ['docs/new näme.md', 'docs: prose, not code'],
    ['img/logo.png', 'binary'],
    ['img/photo.jpg', 'binary'],
  ]);
});

test('a story exclusion needs a glob and a reason; unmatched globs are reported', () => {
  const s = story();
  s.exclude = [{ glob: 'nothing/**', reason: 'r' }];
  const cov = computeCoverage(s, files, buildReport(s, files));
  assert.deepEqual(cov.unmatched, ['nothing/**']);
});

test('coverage reports the largest chapter so the renderer can refuse oversized ones', () => {
  const s = story();
  const cov = computeCoverage(s, files, buildReport(s, files));
  assert.deepEqual(cov.chapterSizes.map((c) => [c.title, c.changed]), [
    ['1. The new Name type', 3], ['2. Greeter adopts Name', 5], ['3. Legacy removed', 2], ['4. Usage docs', 2], ['5. Migration checklist', 0],
  ]);
});

test('coverage counts sliced lines, not whole hunks', () => {
  const s = story();
  s.chapters[0].hunks[0] = { file: 'src/Name.java', lines: [3, 3], slice: true };
  const cov = computeCoverage(s, files, buildReport(s, files));
  const name = cov.counted.find((f) => f.path === 'src/Name.java');
  assert.equal(name.explained, 1);
  assert.equal(name.missing, 2);
});
