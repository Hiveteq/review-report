import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the latter is percent-encoded, so a checkout
// path with a space or a non-ASCII character would not resolve.
const OV = { bigPicture: 'a\n```mermaid\nflowchart LR\nA-->B\n```', why: 'b', approach: 'c', howToRead: 'd' };
const skill = fileURLToPath(new URL('..', import.meta.url));
const fixtureDiff = join(skill, 'test/fixture.diff');
const fixtureStory = join(skill, 'test/fixture.story.json');
const fixture = JSON.parse(readFileSync(fixtureStory, 'utf8'));

// Paths in output are compared with forward slashes, so assertions read the same on Windows.
function run(args, cwd, env = process.env) {
  const r = spawnSync(process.execPath, [join(skill, 'render.mjs'), ...args], { cwd, encoding: 'utf8', env });
  return { ...r, stdout: (r.stdout ?? '').replace(/\\/g, '/'), stderr: (r.stderr ?? '').replace(/\\/g, '/') };
}
function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
// Every temp directory the tests make, removed once this file's tests have run.
const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
// realpath: macOS /var is /private/var; Windows 8.3 short names expand. git reports the real, long path.
function tempDir(prefix) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
function tempRepo() {
  const dir = tempDir('rr-');
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(dir, 'sub'));
  return dir;
}
// Two commits (a.txt with a blank line 2; then line 4 added and b.txt created) plus an uncommitted edit.
function repoWithHistory() {
  const dir = tempRepo();
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
function storyWithTitle(dir, title) {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ ...fixture, meta: { ...fixture.meta, title } }));
  return p;
}

test('renders fixture to default path under repo root and gitignores it', () => {
  const dir = tempRepo();
  const r = run(['--story', fixtureStory, '--diff-file', fixtureDiff], join(dir, 'sub'));
  assert.equal(r.status, 0, r.stderr);
  const outPath = r.stdout.trim().split('\n').pop();
  assert.match(outPath, /\/reports\/review\/\d{4}-\d{2}-\d{2}-greeter-takes-a-name-value-object\.html$/);
  assert.ok(outPath.toLowerCase().startsWith(dir.replace(/\\/g, '/').toLowerCase()), 'output under repo root, not cwd');
  assert.ok(existsSync(outPath));
  assert.match(readFileSync(outPath, 'utf8'), /<h2 id="overview">/);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /# review-report output\nreports\/review\/\n/);
  assert.match(r.stdout, /note: added reports\/review\/ to \.gitignore/);
});

test('does not touch .gitignore when already ignored or when --out is elsewhere', () => {
  const dir = tempRepo();
  writeFileSync(join(dir, '.gitignore'), 'reports/\n');
  const r1 = run(['--story', fixtureStory, '--diff-file', fixtureDiff], dir);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'reports/\n');
  const out = join(dir, 'custom.html');
  const r2 = run(['--story', fixtureStory, '--diff-file', fixtureDiff, '--out', out], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(existsSync(out));
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'reports/\n');
});

test('.gitignore gains the entry once, even when a report file is tracked', () => {
  const dir = tempRepo();
  const r1 = run(['--story', fixtureStory, '--diff-file', fixtureDiff], dir);
  assert.equal(r1.status, 0, r1.stderr);
  git(dir, 'add', '-f', r1.stdout.trim().split('\n').pop());
  const r2 = run(['--story', fixtureStory, '--diff-file', fixtureDiff], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal((readFileSync(join(dir, '.gitignore'), 'utf8').match(/reports\/review\//g) ?? []).length, 1);
  assert.ok(!r2.stdout.includes('note: added'));
});

test('prints every contract error and exits 1 without writing', () => {
  const dir = tempRepo();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ meta: { readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: {}, chapters: [{ title: 'x', intro: 'y', hunks: [{ file: 'nope', lines: 'all' }] }] }));
  const r = run(['--story', bad, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: meta\.title is required/);
  assert.match(r.stderr, /error: overview\.bigPicture is required/);
  assert.ok(!existsSync(join(dir, 'reports')));
});

test('a non-array where a list is expected is an error line, not a stack trace', () => {
  const dir = tempRepo();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({
    meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, glossary: [{ term: 'a', meaning: 'b' }], diagrams: { mermaid: 'x' },
    chapters: [{ title: 'x', intro: 'One. Two.', hunks: [{ file: 'src/Name.java', lines: 'all', comments: { line: 3, text: 'hi' } }] }],
  }));
  const r = run(['--story', bad, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: diagrams is no longer a story field/m);
  assert.match(r.stderr, /^error: chapters\[0\]\.hunks\[0\]\.comments must be an array$/m);
  assert.ok(!/TypeError|at .*\.mjs:\d+/.test(r.stderr), 'no stack trace');
});

test('reference errors are reported after validation passes', () => {
  const dir = tempRepo();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, glossary: [{ term: 'a', meaning: 'b' }], chapters: [{ title: 'x', intro: 'One. Two.', hunks: [{ file: 'nope', lines: 'all' }] }] }));
  const r = run(['--story', bad, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error: chapters\[0\]\.hunks\[0\]: file not in diff: nope/);
});

test('--dump-diff prints the diff and exits 0', () => {
  const dir = tempRepo();
  const r = run(['--dump-diff', '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^diff --git a\/src\/Greeter\.java/);
});

test('usage errors exit 2', () => {
  const r = run([], tempRepo());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--story/);
});

test('--dump-numbered prints line numbers next to each diff line', () => {
  const dir = tempRepo();
  const r = run(['--dump-numbered', '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^=== src\/Greeter\.java \(modified\)/m);
  assert.match(r.stdout, /^ {4}- {5}4 \+    public String greet\(Name name\) \{$/m);
});

test('setup failures print error: lines, not stack traces', () => {
  const dir = tempRepo();
  const r1 = run(['--story', fixtureStory, '--diff-file', join(dir, 'missing.diff')], dir);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /^error: cannot read diff file/m);
  assert.ok(!/at .*\.mjs:\d+/.test(r1.stderr), 'no stack trace');
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{ not json');
  const r2 = run(['--story', badJson, '--diff-file', fixtureDiff], dir);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /^error: cannot parse story/m);
  const r3 = run(['--story', fixtureStory], dir); // empty repo: no master commit to diff against
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /^error: /m);
  assert.ok(!/at .*\.mjs:\d+/.test(r3.stderr), 'no stack trace');
});

test('outside a repository the error is git\'s own, not advice about master/main', () => {
  const dir = tempDir('rr-norepo-');
  const r = run(['--dump-numbered'], dir, { ...process.env, GIT_CEILING_DIRECTORIES: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: cannot resolve diff for target \(default\): fatal: not a git repository/m);
  assert.ok(!r.stderr.includes('No master or main branch'), r.stderr);
});

test('a single-revision target shows the change that commit introduced, not the working tree', () => {
  const dir = repoWithHistory();
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

test('user git config for colour, prefixes and blank lines does not reach the parser', () => {
  const dir = repoWithHistory();
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

test('default filename uses the local date, not UTC', () => {
  const dir = tempRepo();
  const r = run(['--story', fixtureStory, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 0, r.stderr);
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.ok(r.stdout.trim().split('\n').pop().includes(`/reports/review/${local}-`), r.stdout);
});

test('titles in other scripts keep a distinct file name instead of collapsing to <date>-.html', () => {
  const dir = tempRepo();
  const out = (title) => run(['--story', storyWithTitle(dir, title), '--diff-file', fixtureDiff], dir).stdout.trim().split('\n').pop();
  assert.match(out('Рефакторинг парсера'), /-рефакторинг-парсера\.html$/);
  assert.match(out('重构解析器'), /-重构解析器\.html$/);
  assert.match(out('Café menu'), /-cafe-menu\.html$/);
  assert.match(out('!!!'), /-report\.html$/);
});

test('.gitignore is left alone when git already ignores the output path by any pattern', () => {
  const dir = tempRepo();
  writeFileSync(join(dir, '.gitignore'), '*.html\n');
  const r = run(['--story', fixtureStory, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '*.html\n');
  assert.ok(!r.stdout.includes('note: added'));
});

// A local stand-in for GitHub: a bare repository holding master and PR 7 as refs/pull/7/head.
// open: master has moved on and refs/pull/7/merge holds the test merge GitHub computes.
// merged: the PR was merged into master with a merge commit, so there is no merge ref.
// closed: master has moved on, the PR was never merged, and there is no merge ref.
// Returns a fresh clone which, like any clone, has no refs/pull/* until review-report fetches them.
// Its origin is `url`, which url.<base>.insteadOf points at the bare repository, so review-report
// sees a hosted remote while git fetches from the local one.
function cloneWithPullRequest(state, url = 'https://github.com/acme/demo.git') {
  const bare = tempDir('rr-remote-');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '-b', 'master'], { cwd: bare }).status, 0);
  const work = tempRepo();
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'switch', '-qc', 'feature');
  writeFileSync(join(work, 'a.txt'), 'one\ntwo\n');
  git(work, 'commit', '-qam', 'pr change');
  git(work, 'switch', '-q', 'master');
  writeFileSync(join(work, 'later.txt'), 'master moved on\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'later on master');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-q', 'origin', 'feature:refs/pull/7/head');
  if (state === 'open') {
    git(work, 'switch', '-q', '--detach', 'master');
    git(work, 'merge', '-q', '--no-ff', '-m', 'Merge pull request 7', 'feature');
    git(work, 'push', '-q', 'origin', 'HEAD:refs/pull/7/merge');
    git(work, 'push', '-q', 'origin', 'master');
  } else if (state === 'merged') {
    git(work, 'merge', '-q', '--no-ff', '-m', 'Merge pull request 7', 'feature');
    git(work, 'push', '-q', 'origin', 'master');
  } else {
    git(work, 'push', '-q', 'origin', 'master');
  }
  const client = tempDir('rr-client-');
  const c = spawnSync('git', ['clone', '-q', bare, client], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  git(client, 'remote', 'set-url', 'origin', url);
  git(client, 'config', `url.${bare}.insteadOf`, url);
  return client;
}
const withoutGh = { ...process.env, REVIEW_REPORT_WITHOUT: 'gh' };

for (const state of ['open', 'merged', 'closed']) {
  test(`${state === 'open' ? 'an' : 'a'} ${state} PR is fetched with git when gh is unavailable, with a note suggesting gh`, () => {
    const client = cloneWithPullRequest(state);
    const r = run(['--dump-diff', '--target', '#7'], client, withoutGh);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\+two$/m, 'the PR change is in the diff');
    assert.doesNotMatch(r.stdout, /later\.txt/, 'changes made on master after the PR branched are not');
    assert.match(r.stderr, /^note: gh is not installed; fetched PR #7 with git instead\. Install gh/m);
    assert.doesNotMatch(r.stdout, /^note:/m, 'notes stay off stdout, which carries the diff');
  });
}

test('fetching a PR moves no branches, tags or remote-tracking refs', () => {
  const client = cloneWithPullRequest('closed');
  const listRefs = () => git(client, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes');
  const before = listRefs();
  assert.equal(run(['--dump-diff', '--target', '#7'], client, withoutGh).status, 0);
  assert.equal(run(['--dump-diff', '--target', '#7'], client, withoutGh).status, 0, 'a repeat run overwrites its refs');
  assert.equal(listRefs(), before, 'branches, tags and remote-tracking refs are unchanged');
});

test('a closed PR is compared with the default branch, and a note says which', () => {
  const client = cloneWithPullRequest('closed');
  const r = run(['--dump-diff', '--target', '#7'], client, withoutGh);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\+two$/m);
  assert.doesNotMatch(r.stdout, /later\.txt/);
  assert.match(r.stderr, /^note: compared PR #7 with origin's default branch \(master\)\. If it targets another branch, pass --target origin\/<branch>\.\.\.refs\/review-report\/pr\/7\/head$/m);
});

test('a PR that no remote has is an error line naming the fix', () => {
  const client = cloneWithPullRequest('open');
  const r = run(['--dump-diff', '--target', '#99'], client, withoutGh);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: cannot resolve diff for target #99: PR #99 not found on origin\. Install gh, or pass --target <base>\.\.\.<head>\./m);
  assert.match(r.stderr, /^note: gh is not installed; fetched PR #99 with git instead\./m, 'notes survive an error');
});

// Gitea and Forgejo publish pull requests as GitHub does, but gh cannot read them.
test('a PR fetched with git from a remote not on github.com brings no note about gh', () => {
  const client = cloneWithPullRequest('open', 'https://codeberg.org/acme/demo.git');
  const r = run(['--dump-diff', '--target', '#7'], client, withoutGh);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\+two$/m);
  assert.doesNotMatch(r.stderr, /\bgh\b/);
});

test('a PR missing from a remote not on github.com is an error line without install advice', () => {
  const client = cloneWithPullRequest('open', 'https://codeberg.org/acme/demo.git');
  const r = run(['--dump-diff', '--target', '#99'], client, withoutGh);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: cannot resolve diff for target #99: PR #99 not found on origin\. Pass --target <base>\.\.\.<head>\.$/m);
  assert.doesNotMatch(r.stderr, /\bgh\b/);
});

test('--context with a PR read from --diff-file prints no gh note: gh was never asked', () => {
  const dir = tempRepo();
  const r = run(['--story', fixtureStory, '--diff-file', fixtureDiff, '--target', '#12', '--context', '8'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /note: gh|--context is ignored/);
});

test('an unwritable output path is an error line, and a stuck .gitignore is only a note', () => {
  const dir = tempRepo();
  const r1 = run(['--story', fixtureStory, '--diff-file', fixtureDiff, '--out', dir], dir); // a directory, not a file
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /^error: cannot write /m);
  assert.ok(!/at .*\.mjs:\d+/.test(r1.stderr), 'no stack trace');
  rmSync(join(dir, '.gitignore'));
  mkdirSync(join(dir, '.gitignore', 'x'), { recursive: true }); // .gitignore is a directory: cannot be read or appended
  const r2 = run(['--story', fixtureStory, '--diff-file', fixtureDiff], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /^note: could not update \.gitignore: /m);
  assert.match(r2.stdout, /\/reports\/review\/.*\.html$/m, 'report path still printed');
});

test('coverage below the minimum fails with the uncovered files listed; --min-coverage adjusts it', () => {
  const dir = tempRepo();
  const thin = JSON.parse(readFileSync(fixtureStory, 'utf8'));
  thin.chapters = [thin.chapters[0]]; // only Name.java explained: 3 of 14 counted lines
  const path = join(dir, 'thin.json');
  writeFileSync(path, JSON.stringify(thin));
  const r = run(['--story', path, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: coverage 21% of changed lines shown in chapters; minimum is 80%/m);
  assert.match(r.stderr, /^  src\/Greeter\.java \+3 -2 \(5 not shown\)$/m);
  assert.match(r.stderr, /^  README\.md \+2 -2 \(4 not shown\)$/m);
  assert.match(r.stderr, /add chapters for these files, or exclude them in the story with a reason/);
  const ok = run(['--story', path, '--diff-file', fixtureDiff, '--min-coverage', '20'], dir);
  assert.equal(ok.status, 0, ok.stderr);
});

test('--only restricts the report to files matching the globs, so a large diff can be reported in parts', () => {
  const dir = tempRepo();
  const s = JSON.parse(readFileSync(fixtureStory, 'utf8'));
  s.chapters = [s.chapters[0], s.chapters[1], s.chapters[2]]; // the three src/ files only
  const p = join(dir, 'part.json'); writeFileSync(p, JSON.stringify(s));
  const r = run(['--story', p, '--diff-file', fixtureDiff, '--only', 'src/**', '--out', join(dir, 'part.html')], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(dir, 'part.html'), 'utf8');
  assert.ok(!out.includes('data-path="README.md"'), 'README is outside the part');
  assert.match(out, /10 of 10 changed lines shown in chapters \(100%\)/);
  assert.match(out, /<p class="target">fixture · only src\/\*\*<\/p>/);
  const none = run(['--story', p, '--diff-file', fixtureDiff, '--only', 'nope/**'], dir);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^error: --only matched no files in this diff: nope\/\*\*/m);
});

test('--dump-numbered honours --only', () => {
  const r = run(['--dump-numbered', '--diff-file', fixtureDiff, '--only', 'src/**'], tempRepo());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^=== src\/Greeter\.java/m);
  assert.ok(!r.stdout.includes('=== README.md'), 'README is outside the part');
});

test('--pages writes a folder with index and chapter pages; small reports stay single-file by default', () => {
  const dir = tempRepo();
  const single = run(['--story', fixtureStory, '--diff-file', fixtureDiff], dir);
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stdout.trim().split('\n').pop(), /\.html$/);
  const paged = run(['--story', fixtureStory, '--diff-file', fixtureDiff, '--pages'], dir);
  assert.equal(paged.status, 0, paged.stderr);
  const index = paged.stdout.trim().split('\n').pop();
  assert.match(index, /\/reports\/review\/\d{4}-\d{2}-\d{2}-greeter-takes-a-name-value-object\/index\.html$/);
  assert.ok(existsSync(index));
  assert.ok(existsSync(join(index, '..', 'chapter-01.html')));
  assert.ok(existsSync(join(index, '..', 'other-changes.html')));
});

test('a chapter showing more than 1000 changed lines is refused with a split instruction', () => {
  const dir = tempRepo();
  // Build a diff with one 1200-line added file and a story that puts it in one chapter.
  const body = Array.from({ length: 1200 }, (_, i) => `+line ${i + 1}`).join('\n');
  const diff = `diff --git a/big.txt b/big.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,1200 @@\n${body}\n`;
  const diffPath = join(dir, 'big.diff'); writeFileSync(diffPath, diff);
  const s = JSON.parse(readFileSync(fixtureStory, 'utf8'));
  s.exclude = undefined;
  s.chapters = [{ title: 'One huge chapter', intro: 'Everything. At once.', hunks: [{ file: 'big.txt', lines: 'all', comments: [{ line: 1, text: 'A note.' }] }] }];
  const p = join(dir, 'big.json'); writeFileSync(p, JSON.stringify(s));
  const r = run(['--story', p, '--diff-file', diffPath], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: chapters\[0\] "One huge chapter" shows 1200 changed lines; split it into chapters of one idea each \(at most 1000 lines\)/m);
});

test('a render before the reader pass writes the same path and says so in the header', () => {
  const dir = tempRepo();
  const s = JSON.parse(readFileSync(fixtureStory, 'utf8'));
  delete s.meta.readerPass;
  const p = join(dir, 'd.json'); writeFileSync(p, JSON.stringify(s));
  const r = run(['--story', p, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split('\n').pop();
  assert.match(out, /-greeter-takes-a-name-value-object\.html$/);
  assert.match(readFileSync(out, 'utf8'), /Reader pass: not yet run\./);
  assert.match(r.stderr, /^warning: reader pass not recorded; the header says so. Run it and render again/m);
  s.meta.readerPass = { rounds: 1, questionsAnswered: 0, openQuestions: 0 };
  writeFileSync(p, JSON.stringify(s));
  const r2 = run(['--story', p, '--diff-file', fixtureDiff], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout.trim().split('\n').pop(), out, 'same path, overwritten');
  assert.match(readFileSync(out, 'utf8'), /Reader pass: 1 round, 0 questions answered, none open\./);
});

test('the header reports what the reader pass answered and what is still open', () => {
  const dir = tempRepo();
  const s = JSON.parse(readFileSync(fixtureStory, 'utf8'));
  s.meta.readerPass = { rounds: 2, questionsAnswered: 41, openQuestions: 3 };
  const p = join(dir, 'b.json'); writeFileSync(p, JSON.stringify(s));
  const r = run(['--story', p, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(r.stdout.trim().split('\n').pop(), 'utf8'), /Reader pass: 2 rounds, 41 questions answered, 3 still open\./);
});

test('the story must declare its test globs; an empty list is allowed', () => {
  const dir = tempRepo();
  const s = JSON.parse(readFileSync(fixtureStory, 'utf8'));
  delete s.tests;
  const p = join(dir, 'n.json'); writeFileSync(p, JSON.stringify(s));
  const r = run(['--story', p, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: tests is required: globs matching this project's test files, \[\] if the change has none/m);
});

test('a test file shown in a chapter needs a covers statement', () => {
  const dir = tempRepo();
  const s = JSON.parse(readFileSync(fixtureStory, 'utf8'));
  s.tests = ['src/Name.java']; // stands in for a test file in this fixture
  const p = join(dir, 't.json'); writeFileSync(p, JSON.stringify(s));
  const r = run(['--story', p, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: chapters\[0\]\.hunks\[0\]: src\/Name\.java is a test file \(matches src\/Name\.java\); add "covers": what it pins and what it leaves untested/m);
  s.chapters[0].hunks[0].covers = 'Pins the record accessor; equality is not tested.';
  writeFileSync(p, JSON.stringify(s));
  const ok = run(['--story', p, '--diff-file', fixtureDiff], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(ok.stdout.trim().split('\n').pop(), 'utf8'), /<div class="covers"><span class="covers-label">Covers<\/span><p>Pins the record accessor; equality is not tested\.<\/p><\/div>/);
});

test('anchor warnings are printed but do not stop the render', () => {
  const dir = tempRepo();
  const s = JSON.parse(readFileSync(fixtureStory, 'utf8'));
  s.chapters[0].hunks[0].comments = [{ line: 2, text: 'A Java `record`.' }];
  const p = join(dir, 'w.json'); writeFileSync(p, JSON.stringify(s));
  const r = run(['--story', p, '--diff-file', fixtureDiff], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^warning: chapters\[0\]\.hunks\[0\]\.comments\[0\]: src\/Name\.java new line 2 does not contain `record`; new line 3 does/m);
});
