// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDiff, formatNumbered, unquotePath, hunkLabel, headerOnlyKind, headerOnlyReason } from '../lib/diff.mjs';

/** @typedef {import('../lib/diff.mjs').DiffFile} DiffFile */

const fixture = readFileSync(new URL('./fixture.diff', import.meta.url), 'utf8');

// The first parsed file that `pick` accepts; the test fails when there is none.
/**
 * @param {DiffFile[]} files
 * @param {(f: DiffFile) => unknown} pick truthy for the file wanted
 * @returns {DiffFile}
 */
function findFile(files, pick) {
  const file = files.find(pick);
  assert.ok(file, 'no matching file in the diff');
  return file;
}

test('parses one entry per file with status', () => {
  const files = parseDiff(fixture);
  assert.deepEqual(
    files.map((f) => [f.path, f.status]),
    [
      ['src/Greeter.java', 'modified'],
      ['src/Name.java', 'added'],
      ['src/Legacy.java', 'deleted'],
      ['README.md', 'modified'],
      ['docs/new näme.md', 'renamed'],
      ['img/logo.png', 'added'],
      ['img/photo.jpg', 'modified'],
      ['scripts/run.sh', 'modified'],
      ['docs/renamed.md', 'renamed'],
    ],
  );
});

test('numbers old and new sides through adds and deletes', () => {
  const [greeter] = parseDiff(fixture);
  assert.equal(greeter.hunks.length, 1);
  const lines = greeter.hunks[0].lines.map((l) => [l.type, l.old, l.new]);
  assert.deepEqual(lines, [
    ['ctx', 1, 1],
    ['ctx', 2, 2],
    ['ctx', 3, 3],
    ['del', 4, null],
    ['del', 5, null],
    ['add', null, 4],
    ['add', null, 5],
    ['ctx', 6, 6],
    ['add', null, 7],
    ['ctx', 7, 8],
  ]);
  assert.equal(greeter.hunks[0].header, 'package demo;');
});

test('keeps line content without the leading marker', () => {
  const [greeter] = parseDiff(fixture);
  assert.equal(greeter.hunks[0].lines[5].content, '    public String greet(Name name) {');
  assert.equal(greeter.hunks[0].lines[1].content, '');
});

test('deleted file uses old path and has no new numbers', () => {
  const legacy = findFile(parseDiff(fixture), (f) => f.status === 'deleted');
  assert.equal(legacy.path, 'src/Legacy.java');
  assert.ok(legacy.hunks[0].lines.every((l) => l.new === null));
});

test('splits multiple hunks in one file', () => {
  const readme = findFile(parseDiff(fixture), (f) => f.path === 'README.md');
  assert.equal(readme.hunks.length, 2);
  assert.equal(readme.hunks[1].newStart, 10);
  assert.equal(readme.hunks[1].lines[2].new, 11);
});

test('rename keeps both paths and tolerates spaces, unicode and trailing tab', () => {
  const renamed = findFile(parseDiff(fixture), (f) => f.status === 'renamed');
  assert.equal(renamed.oldPath, 'docs/old name.md');
  assert.equal(renamed.newPath, 'docs/new näme.md');
  assert.equal(renamed.path, 'docs/new näme.md');
});

test('formatNumbered prints old and new numbers per line for every file', async () => {
  const { formatNumbered } = await import('../lib/diff.mjs');
  const out = formatNumbered(parseDiff(fixture));
  assert.match(out, /^=== src\/Greeter\.java \(modified\)\n {2}old {3}new {2}line\n@@ -1,7 \+1,8 @@ package demo;\n/m);
  assert.match(out, /^ {4}4 {5}- - {4}public String greet\(String name\) \{$/m);
  assert.match(out, /^ {4}- {5}4 \+ {4}public String greet\(Name name\) \{$/m);
  assert.match(out, /^ {4}1 {5}1 {2}package demo;$/m);
  assert.match(out, /^=== src\/Legacy\.java \(deleted\)$/m);
  assert.match(out, /^=== docs\/new näme\.md \(renamed from docs\/old name\.md\)$/m);
});

test('binary files get their path from the diff --git line and no hunks', () => {
  const files = parseDiff(fixture);
  const logo = findFile(files, (f) => f.path === 'img/logo.png');
  assert.equal(logo.binary, true);
  assert.equal(logo.status, 'added');
  assert.deepEqual(logo.hunks, []);
  const photo = findFile(files, (f) => f.path === 'img/photo.jpg');
  assert.equal(photo.binary, true);
  assert.equal(photo.oldPath, 'img/photo.jpg');
});

test('mode-only change records old and new mode with zero hunks', () => {
  const run = findFile(parseDiff(fixture), (f) => f.path === 'scripts/run.sh');
  assert.equal(run.oldMode, '100644');
  assert.equal(run.newMode, '100755');
  assert.deepEqual(run.hunks, []);
  assert.equal(run.binary, false);
});

test('pure rename keeps both paths with zero hunks', () => {
  const moved = findFile(parseDiff(fixture), (f) => f.path === 'docs/renamed.md');
  assert.equal(moved.status, 'renamed');
  assert.equal(moved.oldPath, 'docs/moved.md');
  assert.deepEqual(moved.hunks, []);
});

test('unquotes C-style quoted paths as git prints them for unicode, tabs and quotes', async () => {
  const { unquotePath } = await import('../lib/diff.mjs');
  assert.equal(unquotePath('"b/caf\\303\\251.txt"'), 'b/café.txt');
  assert.equal(unquotePath('"a/we\\"ird\\ttab\\\\.md"'), 'a/we"ird\ttab\\.md');
  assert.equal(unquotePath('plain/path.md'), 'plain/path.md');
});

test('numbered dump lists header-only files', async () => {
  const { formatNumbered } = await import('../lib/diff.mjs');
  const out = formatNumbered(parseDiff(fixture));
  assert.match(out, /^=== img\/logo\.png \(added\)\n\(binary\)$/m);
  assert.match(out, /^=== scripts\/run\.sh \(modified\)\n\(mode 100644 → 100755, no content change\)$/m);
  assert.match(out, /^=== docs\/renamed\.md \(renamed from docs\/moved\.md\)\n\(no content change\)$/m);
});

test('a blank context line saved as "" still counts, so later numbers stay right', () => {
  const trimmed = fixture.replace('@@ -1,7 +1,8 @@ package demo;\n package demo;\n \n', '@@ -1,7 +1,8 @@ package demo;\n package demo;\n\n');
  assert.notEqual(trimmed, fixture, 'fixture blank context line found');
  /** @param {string} text */
  const numbers = (text) => parseDiff(text)[0].hunks[0].lines.map((l) => [l.type, l.old, l.new]);
  assert.deepEqual(numbers(trimmed), numbers(fixture));
});

test('text after a completed hunk (a format-patch signature) is not diff content', () => {
  const [greeter] = parseDiff(`${fixture.split('diff --git a/src/Name.java')[0]}-- \n2.39.0\n\n`);
  assert.equal(greeter.hunks[0].lines.length, 10);
});

test('a leading byte-order mark does not hide the first file', () => {
  assert.equal(parseDiff(`\uFEFF${fixture}`)[0].path, 'src/Greeter.java');
});

test('quoted paths keep characters outside the BMP and survive a dangling backslash', () => {
  assert.equal(unquotePath('"a/caf😀\\"q.txt"'), 'a/caf😀"q.txt');
  assert.equal(unquotePath('"abc\\"'), 'abc\\');
});

test('hunk labels follow git and omit a count of 1', () => {
  const renamed = findFile(parseDiff(fixture), (f) => f.status === 'renamed' && f.hunks.length);
  assert.equal(hunkLabel(renamed.hunks[0]), '@@ -1 +1 @@');
  assert.equal(hunkLabel(parseDiff(fixture)[0].hunks[0]), '@@ -1,7 +1,8 @@ package demo;');
  assert.match(formatNumbered(parseDiff(fixture)), /^@@ -1 \+1 @@$/m);
});

test('headerOnlyKind tells an empty added file from a pure rename', () => {
  const [empty] = parseDiff('diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n');
  assert.equal(empty.status, 'added');
  assert.equal(headerOnlyKind(empty), 'empty');
  assert.equal(headerOnlyReason(empty), 'empty file');
  const files = parseDiff(fixture);
  assert.equal(headerOnlyKind(findFile(files, (f) => f.path === 'docs/renamed.md')), 'rename');
  assert.equal(headerOnlyKind(findFile(files, (f) => f.path === 'scripts/run.sh')), 'mode');
  assert.equal(headerOnlyKind(findFile(files, (f) => f.path === 'img/logo.png')), 'binary');
  assert.equal(headerOnlyKind(files[0]), null);
});

test('a mode change on a file that also has hunks is kept and named in the dump', () => {
  const text = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\nindex 1111111..2222222\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-echo hi\n+echo hello\n'
    + 'diff --git a/new.sh b/new.sh\nnew file mode 100755\nindex 0000000..3333333\n--- /dev/null\n+++ b/new.sh\n@@ -0,0 +1 @@\n+echo new\n';
  const files = parseDiff(text);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.oldMode, f.newMode, f.hunks.length]), [['run.sh', 'modified', '100644', '100755', 1], ['new.sh', 'added', null, '100755', 1]]);
  const out = formatNumbered(files);
  assert.match(out, /^=== run\.sh \(modified, mode 100644 → 100755\)$/m);
  assert.match(out, /^=== new\.sh \(added, mode 100755\)$/m);
});
