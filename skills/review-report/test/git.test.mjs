import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDiff, describeTarget, repoRoot, parseTarget, prNumber, EMPTY_TREE } from '../lib/git.mjs';

// Records every invocation and answers from a script keyed by "cmd args".
function fakeRun(script) {
  const calls = [];
  const run = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    if (key in script) {
      const v = script[key];
      if (v instanceof Error) throw v;
      return v;
    }
    throw new Error(`unexpected command: ${key}`);
  };
  run.calls = calls;
  return run;
}

// What execFileSync throws for a command that exited with `code`.
const exit = (code) => Object.assign(new Error(`exit ${code}`), { status: code });

// The flags that pin git's output format, present on every diff invocation.
const GIT = 'git -c core.quotePath=false -c diff.suppressBlankEmpty=false diff --no-color --no-ext-diff --no-relative --src-prefix=a/ --dst-prefix=b/ --submodule=short';

test('no target diffs merge-base against master with context', () => {
  const run = fakeRun({
    'git rev-parse --verify --quiet master': 'abc\n',
    [`${GIT} -U3 master...HEAD`]: 'DIFF',
  });
  assert.equal(resolveDiff(undefined, 3, run), 'DIFF');
});

test('falls back to main when master is missing', () => {
  const run = fakeRun({
    'git rev-parse --verify --quiet master': exit(1),
    'git rev-parse --verify --quiet main': 'abc\n',
    [`${GIT} -U5 main...HEAD`]: 'DIFF',
  });
  assert.equal(resolveDiff(undefined, 5, run), 'DIFF');
});

test('errors clearly when neither master nor main exists', () => {
  const run = fakeRun({
    'git rev-parse --verify --quiet master': exit(1),
    'git rev-parse --verify --quiet main': exit(1),
  });
  assert.throws(() => resolveDiff(undefined, 3, run), /No master or main branch/);
});

test('a git failure other than "no such ref" propagates with its own message', () => {
  const notARepo = Object.assign(new Error('git failed'), { status: 128, stderr: 'fatal: not a git repository\n' });
  const run = fakeRun({ 'git rev-parse --verify --quiet master': notARepo });
  assert.throws(() => resolveDiff(undefined, 3, run), (e) => e === notARepo);
  assert.deepEqual(run.calls, ['git rev-parse --verify --quiet master']);
});

test('--staged, --working and ranges map to git diff flags', () => {
  const run = fakeRun({
    [`${GIT} -U3 --cached`]: 'S',
    [`${GIT} -U3 HEAD`]: 'W',
    [`${GIT} -U3 v1..v2`]: 'R',
  });
  assert.equal(resolveDiff('--staged', 3, run), 'S');
  assert.equal(resolveDiff('--working', 3, run), 'W');
  assert.equal(resolveDiff('v1..v2', 3, run), 'R');
});

test('#123 uses gh pr diff without colour', () => {
  const run = fakeRun({ 'gh pr diff 123 --color never': 'PR' });
  assert.equal(resolveDiff('#123', 3, run), 'PR');
});

test('a single revision diffs the commit against its parent, as describeTarget labels it', () => {
  const run = fakeRun({
    'git rev-parse --verify --quiet abc123^': 'p\n',
    [`${GIT} -U3 abc123^ abc123`]: 'ONE',
  });
  assert.equal(resolveDiff('abc123', 3, run), 'ONE');
  assert.deepEqual(describeTarget('abc123', run), { base: 'abc123^', head: 'abc123', label: 'abc123' });
});

test('a root commit is diffed against the empty tree', () => {
  const run = fakeRun({
    'git rev-parse --verify --quiet root^': exit(1),
    [`${GIT} -U3 ${EMPTY_TREE} root`]: 'ROOT',
  });
  assert.equal(resolveDiff('root', 3, run), 'ROOT');
});

test('describeTarget names base and head', () => {
  const run = fakeRun({
    'git rev-parse --verify --quiet master': 'abc\n',
    'git rev-parse --abbrev-ref HEAD': 'feature/x\n',
    'gh pr view 7 --json baseRefName,headRefName': '{"baseRefName":"master","headRefName":"pr-branch"}\n',
  });
  assert.deepEqual(describeTarget(undefined, run), { base: 'master', head: 'feature/x', label: 'feature/x vs master' });
  assert.deepEqual(describeTarget('#7', run), { base: 'master', head: 'pr-branch', label: 'PR #7 (pr-branch vs master)' });
  assert.deepEqual(describeTarget('--staged', run), { base: 'HEAD', head: 'index', label: 'staged changes' });
  assert.deepEqual(describeTarget('a..b', run), { base: 'a', head: 'b', label: 'a..b' });
});

test('parseTarget reads a missing range side as HEAD, like git', () => {
  assert.deepEqual(parseTarget('HEAD~1..'), { kind: 'range', base: 'HEAD~1', head: 'HEAD' });
  assert.deepEqual(parseTarget('...feature'), { kind: 'range', base: 'HEAD', head: 'feature' });
  assert.deepEqual(parseTarget('#12'), { kind: 'pr', pr: '12' });
  assert.deepEqual(parseTarget('v1.2.3'), { kind: 'commit', ref: 'v1.2.3' });
  assert.deepEqual(describeTarget('HEAD~1..', fakeRun({})), { base: 'HEAD~1', head: 'HEAD', label: 'HEAD~1..' });
  assert.equal(prNumber('#42'), '42');
  assert.equal(prNumber('42'), null);
});

test('repoRoot trims the toplevel path', () => {
  const run = fakeRun({ 'git rev-parse --show-toplevel': '/tmp/repo\n' });
  assert.equal(repoRoot(run), '/tmp/repo');
});
