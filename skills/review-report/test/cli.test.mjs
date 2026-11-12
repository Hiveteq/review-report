// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, appendFileSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DIFF_PATH, FIXTURE_STORY_PATH, READER_PASS, SKILL_DIR, fixtureStory, minimalStory, spawnRender, tempDir, tempRepo } from './helpers.mjs';

/** The arguments every successful render of the fixture needs. */
const FIXTURE_ARGS = ['--story', FIXTURE_STORY_PATH, '--diff-file', FIXTURE_DIFF_PATH];

// Paths in output are compared with forward slashes, so assertions read the same on Windows.
/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function run(args, cwd, env = process.env) {
  const r = spawnRender(args, { cwd, env });
  return { ...r, stdout: (r.stdout ?? '').replace(/\\/g, '/'), stderr: (r.stderr ?? '').replace(/\\/g, '/') };
}
/**
 * @param {string} dir
 * @param {...string} args
 * @returns {string}
 */
function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
// The last line a run printed: the report path, when the render succeeded.
/**
 * @param {string} text
 * @returns {string}
 */
const lastLine = (text) => /** @type {string} */ (text.trim().split('\n').pop()); // split never returns an empty array

// Two commits (a.txt with a blank line 2; then line 4 added and b.txt created) plus an uncommitted edit.
/**
 * @param {import('node:test').TestContext} t
 * @returns {string} the repository path
 */
function repoWithHistory(t) {
  const dir = tempRepo(t);
  writeFileSync(join(dir, 'a.txt'), 'one\n\nthree\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  writeFileSync(join(dir, 'a.txt'), 'one\n\nthree\nfour\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'second');
  appendFileSync(join(dir, 'a.txt'), 'dirty\n');
  return dir;
}
/**
 * Writes the story as JSON under `name` in `dir` and returns its path.
 * @param {string} dir
 * @param {unknown} story
 * @param {string} [name]
 * @returns {string} path of the written story
 */
function writeStory(dir, story, name = 'story.json') {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(story));
  return path;
}
let titledStories = 0;
/**
 * @param {string} dir
 * @param {string} title
 * @returns {string} path of the written story
 */
function storyWithTitle(dir, title) {
  const story = fixtureStory();
  return writeStory(dir, { ...story, meta: { ...story.meta, title } }, `titled-${++titledStories}.json`);
}

test('renders fixture to default path under repo root and gitignores it', (t) => {
  const dir = tempRepo(t);
  const r = run(FIXTURE_ARGS, join(dir, 'sub'));
  assert.equal(r.status, 0, r.stderr);
  const outPath = lastLine(r.stdout);
  assert.match(outPath, /\/reports\/review\/\d{4}-\d{2}-\d{2}-greeter-takes-a-name-value-object\.html$/);
  assert.ok(outPath.toLowerCase().startsWith(dir.replace(/\\/g, '/').toLowerCase()), 'output under repo root, not cwd');
  assert.ok(existsSync(outPath));
  assert.match(readFileSync(outPath, 'utf8'), /<h2 id="overview">/);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /# review-report output\nreports\/review\/\n/);
  assert.match(r.stdout, /note: added reports\/review\/ to \.gitignore/);
});

test('does not touch .gitignore when already ignored or when --out is elsewhere', (t) => {
  const dir = tempRepo(t);
  writeFileSync(join(dir, '.gitignore'), 'reports/\n');
  const r1 = run(FIXTURE_ARGS, dir);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'reports/\n');
  const out = join(dir, 'custom.html');
  const r2 = run([...FIXTURE_ARGS, '--out', out], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(existsSync(out));
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'reports/\n');
});

test('.gitignore gains the entry once, even when a report file is tracked', (t) => {
  const dir = tempRepo(t);
  const r1 = run(FIXTURE_ARGS, dir);
  assert.equal(r1.status, 0, r1.stderr);
  git(dir, 'add', '-f', lastLine(r1.stdout));
  const r2 = run(FIXTURE_ARGS, dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal((readFileSync(join(dir, '.gitignore'), 'utf8').match(/reports\/review\//g) ?? []).length, 1);
  assert.ok(!r2.stdout.includes('note: added'));
});

test('prints every contract error and exits 1 without writing', (t) => {
  const dir = tempRepo(t);
  const bad = writeStory(dir, minimalStory({ meta: { readerPass: READER_PASS }, overview: {}, chapters: [{ title: 'x', intro: 'y', hunks: [{ file: 'nope', lines: 'all' }] }] }));
  const r = run(['--story', bad, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: meta\.title is required/);
  assert.match(r.stderr, /error: overview\.bigPicture is required/);
  assert.ok(!existsSync(join(dir, 'reports')));
});

test('a non-array where a list is expected is an error line, not a stack trace', (t) => {
  const dir = tempRepo(t);
  const bad = writeStory(dir, minimalStory({
    glossary: [{ term: 'a', meaning: 'b' }],
    diagrams: { mermaid: 'x' },
    chapters: [{ title: 'x', intro: 'One. Two.', hunks: [{ file: 'src/Name.java', lines: 'all', comments: { line: 3, text: 'hi' } }] }],
  }));
  const r = run(['--story', bad, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: diagrams is no longer a story field/m);
  assert.match(r.stderr, /^error: chapters\[0\]\.hunks\[0\]\.comments must be an array$/m);
  assert.ok(!/TypeError|at .*\.mjs:\d+/.test(r.stderr), 'no stack trace');
});

test('reference errors are reported after validation passes', (t) => {
  const dir = tempRepo(t);
  const bad = writeStory(dir, minimalStory({ glossary: [{ term: 'a', meaning: 'b' }], chapters: [{ title: 'x', intro: 'One. Two.', hunks: [{ file: 'nope', lines: 'all' }] }] }));
  const r = run(['--story', bad, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: chapters\[0\]\.hunks\[0\]: file not in diff: nope/);
});

test('--dump-diff prints the diff and exits 0', (t) => {
  const dir = tempRepo(t);
  const r = run(['--dump-diff', '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^diff --git a\/src\/Greeter\.java/);
});

test('usage errors exit 2', (t) => {
  const r = run([], tempRepo(t));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--story/);
});

test('--dump-numbered prints line numbers next to each diff line', (t) => {
  const dir = tempRepo(t);
  const r = run(['--dump-numbered', '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^=== src\/Greeter\.java \(modified\)/m);
  assert.match(r.stdout, /^ {4}- {5}4 \+ {4}public String greet\(Name name\) \{$/m);
});

test('an unreadable diff file is an error line, not a stack trace', (t) => {
  const dir = tempRepo(t);
  const r = run(['--story', FIXTURE_STORY_PATH, '--diff-file', join(dir, 'missing.diff')], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: cannot read diff file/m);
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), 'no stack trace');
});

test('a story that is not JSON is an error line, not a stack trace', (t) => {
  const dir = tempRepo(t);
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{ not json');
  const r = run(['--story', badJson, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: cannot parse story/m);
});

test('a target with no diff base is an error line, not a stack trace', (t) => {
  const r = run(['--story', FIXTURE_STORY_PATH], tempRepo(t)); // empty repo: no master commit to diff against
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: /m);
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), 'no stack trace');
});

test('outside a repository the error is git\'s own, not advice about master/main', (t) => {
  const dir = realpathSync(tempDir(t, 'rr-norepo-'));
  const r = run(['--dump-numbered'], dir, { ...process.env, GIT_CEILING_DIRECTORIES: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: cannot resolve diff for target \(default\): fatal: not a git repository/m);
  assert.ok(!r.stderr.includes('No master or main branch'), r.stderr);
});

test('a single-revision target shows the change that commit introduced, not the working tree', (t) => {
  const dir = repoWithHistory(t);
  const r = run(['--dump-numbered', '--target', 'HEAD'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^=== a\.txt \(modified\)/m);
  assert.match(r.stdout, /^=== b\.txt \(added\)/m);
  assert.ok(!r.stdout.includes('dirty'), 'uncommitted edits are not part of the commit');
  const root = run(['--dump-numbered', '--target', 'HEAD~1'], dir); // root commit: no parent
  assert.equal(root.status, 0, root.stderr);
  assert.match(root.stdout, /^=== a\.txt \(added\)/m);
  assert.ok(!root.stdout.includes('b.txt'));
});

test('user git config for colour, prefixes and blank lines does not reach the parser', (t) => {
  const dir = repoWithHistory(t);
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'color.ui', GIT_CONFIG_VALUE_0: 'always',
    GIT_CONFIG_KEY_1: 'diff.noprefix', GIT_CONFIG_VALUE_1: 'true',
    GIT_CONFIG_KEY_2: 'diff.mnemonicPrefix', GIT_CONFIG_VALUE_2: 'true',
    GIT_CONFIG_KEY_3: 'diff.suppressBlankEmpty', GIT_CONFIG_VALUE_3: 'true',
  };
  const r = run(['--dump-numbered', '--target', 'HEAD~1..HEAD'], dir, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^=== a\.txt \(modified\)$/m, 'path without prefix or duplication');
  assert.match(r.stdout, /^ {4}2 {5}2 {2}$/m, 'blank context line keeps its number');
  assert.match(r.stdout, /^ {4}- {5}4 \+four$/m);
  assert.ok(!r.stdout.includes('\u001b['), 'no colour codes');
});

test('default filename uses the local date, not UTC', (t) => {
  const dir = tempRepo(t);
  const r = run(FIXTURE_ARGS, dir);
  assert.equal(r.status, 0, r.stderr);
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.ok(lastLine(r.stdout).includes(`/reports/review/${local}-`), r.stdout);
});

test('titles in other scripts keep a distinct file name instead of collapsing to <date>-.html', (t) => {
  const dir = tempRepo(t);
  /**
   * @param {string} title
   * @returns {string} the report path printed for a story with this title
   */
  const out = (title) => lastLine(run(['--story', storyWithTitle(dir, title), '--diff-file', FIXTURE_DIFF_PATH], dir).stdout);
  assert.match(out('Рефакторинг парсера'), /-рефакторинг-парсера\.html$/);
  assert.match(out('重构解析器'), /-重构解析器\.html$/);
  assert.match(out('Café menu'), /-cafe-menu\.html$/);
  assert.match(out('!!!'), /-report\.html$/);
});

test('.gitignore is left alone when git already ignores the output path by any pattern', (t) => {
  const dir = tempRepo(t);
  writeFileSync(join(dir, '.gitignore'), '*.html\n');
  const r = run(FIXTURE_ARGS, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '*.html\n');
  assert.ok(!r.stdout.includes('note: added'));
});

test('--context with a PR target prints a warning because gh pr diff ignores it', (t) => {
  const dir = tempRepo(t);
  // gh is not consulted for --diff-file, so only the warning path is exercised.
  const r = run([...FIXTURE_ARGS, '--target', '#12', '--context', '8'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^warning: --context is ignored for PR targets/m);
});

test('the --context warning for a PR target prints before anything else, even before the diff is read', (t) => {
  const dir = tempRepo(t);
  const r = run(['--story', FIXTURE_STORY_PATH, '--diff-file', join(dir, 'missing.diff'), '--target', '#12', '--context', '8'], dir);
  assert.equal(r.status, 1);
  const [first, second] = r.stderr.split('\n');
  assert.match(first, /^warning: --context is ignored for PR targets/);
  assert.match(second, /^error: cannot read diff file /);
});

test('an unwritable output path is an error line, not a stack trace', (t) => {
  const dir = tempRepo(t);
  const r = run([...FIXTURE_ARGS, '--out', dir], dir); // a directory, not a file
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: cannot write /m);
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr), 'no stack trace');
});

// A copy of the skill with its stylesheet missing fails while rendering, after every check has passed.
test('a failure while rendering is one error line, not a stack trace, and writes nothing', (t) => {
  const skill = join(tempDir(t), 'skill');
  cpSync(SKILL_DIR, skill, { recursive: true });
  rmSync(join(skill, 'template', 'report.css'));
  const outDir = tempDir(t);

  const r = spawnSync(process.execPath, [join(skill, 'render.mjs'), ...FIXTURE_ARGS, '--out', join(outDir, 'report.html')],
    { cwd: outDir, encoding: 'utf8' });

  assert.equal(r.status, 1);
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^error: cannot render report: .*ENOENT/);
  assert.ok(!r.stderr.includes('    at '), 'no stack trace');
  assert.deepEqual(readdirSync(outDir), []);
});

test('a .gitignore that cannot be updated is only a note; the report path is still printed', (t) => {
  const dir = tempRepo(t);
  rmSync(join(dir, '.gitignore'));
  mkdirSync(join(dir, '.gitignore', 'x'), { recursive: true }); // .gitignore is a directory: cannot be read or appended
  const r = run(FIXTURE_ARGS, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^note: could not update \.gitignore: /m);
  assert.match(r.stdout, /\/reports\/review\/.*\.html$/m, 'report path still printed');
});

test('coverage below the minimum fails with the uncovered files listed; --min-coverage adjusts it', (t) => {
  const dir = tempRepo(t);
  const thin = fixtureStory();
  thin.chapters = [thin.chapters[0]]; // only Name.java explained: 3 of 14 counted lines
  const path = writeStory(dir, thin);
  const r = run(['--story', path, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: coverage 21% of changed lines shown in chapters; minimum is 80%/m);
  assert.match(r.stderr, /^ {2}src\/Greeter\.java \+3 -2 \(5 not shown\)$/m);
  assert.match(r.stderr, /^ {2}README\.md \+2 -2 \(4 not shown\)$/m);
  assert.match(r.stderr, /add chapters for these files, or exclude them in the story with a reason/);
  const ok = run(['--story', path, '--diff-file', FIXTURE_DIFF_PATH, '--min-coverage', '20'], dir);
  assert.equal(ok.status, 0, ok.stderr);
});

test('--only restricts the report to files matching the globs, so a large diff can be reported in parts', (t) => {
  const dir = tempRepo(t);
  const s = fixtureStory();
  s.chapters = [s.chapters[0], s.chapters[1], s.chapters[2]]; // the three src/ files only
  const p = writeStory(dir, s);
  const r = run(['--story', p, '--diff-file', FIXTURE_DIFF_PATH, '--only', 'src/**', '--out', join(dir, 'part.html')], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'part.html'), 'utf8');
  assert.ok(!out.includes('data-path="README.md"'), 'README is outside the part');
  assert.match(out, /10 of 10 changed lines shown in chapters \(100%\)/);
  assert.match(out, /<p class="target">fixture · only src\/\*\*<\/p>/);
  const none = run(['--story', p, '--diff-file', FIXTURE_DIFF_PATH, '--only', 'nope/**'], dir);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^error: --only matched no files in this diff: nope\/\*\*/m);
});

test('--dump-numbered honours --only', (t) => {
  const r = run(['--dump-numbered', '--diff-file', FIXTURE_DIFF_PATH, '--only', 'src/**'], tempRepo(t));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^=== src\/Greeter\.java/m);
  assert.ok(!r.stdout.includes('=== README.md'), 'README is outside the part');
});

test('--pages writes a folder with index and chapter pages; small reports stay single-file by default', (t) => {
  const dir = tempRepo(t);
  const single = run(FIXTURE_ARGS, dir);
  assert.equal(single.status, 0, single.stderr);
  assert.match(lastLine(single.stdout), /\.html$/);
  const paged = run([...FIXTURE_ARGS, '--pages'], dir);
  assert.equal(paged.status, 0, paged.stderr);
  const index = lastLine(paged.stdout);
  assert.match(index, /\/reports\/review\/\d{4}-\d{2}-\d{2}-greeter-takes-a-name-value-object\/index\.html$/);
  assert.ok(existsSync(index));
  assert.ok(existsSync(join(index, '..', 'chapter-01.html')));
  assert.ok(existsSync(join(index, '..', 'other-changes.html')));
});

test('a render before the reader pass writes the same path and says so in the header', (t) => {
  const dir = tempRepo(t);
  const s = fixtureStory();
  delete s.meta.readerPass;
  const p = writeStory(dir, s);
  const r = run(['--story', p, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = lastLine(r.stdout);
  assert.match(out, /-greeter-takes-a-name-value-object\.html$/);
  assert.match(readFileSync(out, 'utf8'), /Reader pass: not yet run\./);
  assert.match(r.stderr, /^warning: reader pass not recorded; the header says so. Run it and render again/m);
  s.meta.readerPass = { ...READER_PASS };
  writeFileSync(p, JSON.stringify(s));
  const r2 = run(['--story', p, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(lastLine(r2.stdout), out, 'same path, overwritten');
  assert.match(readFileSync(out, 'utf8'), /Reader pass: 1 round, 0 questions answered, none open\./);
});

test('the header reports what the reader pass answered and what is still open', (t) => {
  const dir = tempRepo(t);
  const s = fixtureStory();
  s.meta.readerPass = { rounds: 2, questionsAnswered: 41, openQuestions: 3 };
  const p = writeStory(dir, s);
  const r = run(['--story', p, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(lastLine(r.stdout), 'utf8'), /Reader pass: 2 rounds, 41 questions answered, 3 still open\./);
});

test('a test file with a covers statement passes the gate and the report shows the statement', (t) => {
  const dir = tempRepo(t);
  const s = fixtureStory();
  s.tests = ['src/Name.java']; // stands in for a test file in this fixture
  s.chapters[0].hunks[0].covers = 'Pins the record accessor; equality is not tested.';
  const r = run(['--story', writeStory(dir, s), '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(lastLine(r.stdout), 'utf8'), /<div class="covers"><span class="covers-label">Covers<\/span><p>Pins the record accessor; equality is not tested\.<\/p><\/div>/);
});

test('anchor warnings are printed but do not stop the render', (t) => {
  const dir = tempRepo(t);
  const s = fixtureStory();
  s.chapters[0].hunks[0].comments = [{ line: 2, text: 'A Java `record`.' }];
  const p = writeStory(dir, s);
  const r = run(['--story', p, '--diff-file', FIXTURE_DIFF_PATH], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^warning: chapters\[0\]\.hunks\[0\]\.comments\[0\]: src\/Name\.java new line 2 does not contain `record`; new line 3 does/m);
});

test('dash-led target values (--staged, --working) are accepted after --target', (t) => {
  const dir = repoWithHistory(t);
  for (const target of ['--staged', '--working']) {
    const r = run(['--dump-diff', '--target', target], dir);
    assert.equal(r.status, 0, `${target}: ${r.stderr}`);
  }
});

test('every documented option is accepted together', (t) => {
  const dir = tempRepo(t);
  const out = join(dir, 'all.html');
  const r = run([...FIXTURE_ARGS, '--out', out, '--context', '3',
    '--min-coverage', '50', '--only', 'src/**,README.md', '--single'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(out));
});

test('--pages and --single together are a usage error', (t) => {
  const r = run([...FIXTURE_ARGS, '--pages', '--single'], tempRepo(t));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^error: --pages and --single cannot be used together/m);
});

test('--context -1 reaches the range check instead of an ambiguity error', (t) => {
  const r = run([...FIXTURE_ARGS, '--context', '-1'], tempRepo(t));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^error: --context must be a non-negative integer/m);
});

test('--out accepts a file name that starts with a dash', (t) => {
  const dir = tempRepo(t);
  const r = run([...FIXTURE_ARGS, '--out', '-x.html'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, '-x.html')));
});

test('--target --target --staged is a usage error', (t) => {
  const r = run(['--dump-diff', '--target', '--target', '--staged'], repoWithHistory(t));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^error: /m);
});
