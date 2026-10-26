import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDiff, describeTarget, repoRoot, parseTarget, prNumber, EMPTY_TREE, withoutTools } from '../lib/git.mjs';

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

// What execFileSync throws when the command is not installed.
const notInstalled = (cmd) => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
// What execFileSync throws when a command exits non-zero after printing to stderr.
const failed = (status, stderr) => Object.assign(new Error(`exit ${status}`), { status, stderr });
const PR = (kind) => `refs/review-report/pr/12/${kind}`;
// Which of the PR's refs a remote has, as `git ls-remote` prints them. Empty output means neither.
const lsRemote = (remote) => `git ls-remote ${remote} refs/pull/12/head refs/pull/12/merge`;
const listed = (...kinds) => kinds.map((k) => `${k === 'head' ? 'h1' : 'm1'}\trefs/pull/12/${k}\n`).join('');
// One fetch for the refs the remote has. --refmap= keeps it from moving remote-tracking branches.
const fetchPrRefs = (remote, ...kinds) => ['git fetch --quiet --no-tags --refmap=', remote,
  ...kinds.map((k) => `+refs/pull/12/${k}:${PR(k)}`)].join(' ');
const GH_DIFF = 'gh pr diff 12 --color never';
// The repository's remote URLs as git config stores them, read to decide whether gh would help.
const REMOTE_URLS = 'git config --get-regexp ^remote\\..*\\.url$';
const hostedAt = (url) => ({ [REMOTE_URLS]: `remote.origin.url ${url}\n` });
const onGitHub = hostedAt('https://github.com/acme/demo.git');
// An open PR on origin whose merge ref is current: its second parent is the PR head.
const openOnOrigin = {
  ...onGitHub,
  'git remote': 'origin\n',
  [lsRemote('origin')]: listed('head', 'merge'),
  [fetchPrRefs('origin', 'head', 'merge')]: '',
  [`git rev-parse ${PR('merge')}^2 ${PR('head')}`]: 'h1\nh1\n',
};
// A PR on origin with no merge ref (merged or closed), origin's default branch being main.
const closedOnOrigin = {
  ...onGitHub,
  'git remote': 'origin\n',
  [lsRemote('origin')]: listed('head'),
  [fetchPrRefs('origin', 'head')]: '',
  'git ls-remote --symref origin HEAD': 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
  [`git fetch --quiet --no-tags --refmap= origin +refs/heads/main:${PR('base')}`]: '',
};

test('with gh, a PR uses gh pr diff and adds no note at the default context', () => {
  const notes = [];
  const run = fakeRun({ [GH_DIFF]: 'PR' });
  assert.equal(resolveDiff('#12', 3, run, notes), 'PR');
  assert.deepEqual(notes, []);
});

test('with gh, --context other than 3 adds a note that gh ignores it', () => {
  const notes = [];
  const run = fakeRun({ [GH_DIFF]: 'PR' });
  resolveDiff('#12', 8, run, notes);
  assert.match(notes[0], /--context is ignored when gh fetches the pull request/);
});

test('without gh, an open PR is diffed from its merge ref against the first parent', () => {
  const notes = [];
  const run = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...openOnOrigin, [`${GIT} -U5 ${PR('merge')}^1 ${PR('merge')}`]: 'OPEN' });
  assert.equal(resolveDiff('#12', 5, run, notes), 'OPEN');
  assert.match(notes[0], /^gh is not installed; fetched PR #12 with git instead\. Install gh \(https:\/\/cli\.github\.com\)/);
});

test('gh that fails for another reason falls back to git; the note gives gh\'s reason, not install advice', () => {
  const notes = [];
  const run = fakeRun({
    [GH_DIFF]: failed(4, 'To get started with GitHub CLI, please run:  gh auth login\n'),
    ...openOnOrigin,
    [`${GIT} -U3 ${PR('merge')}^1 ${PR('merge')}`]: 'OPEN',
  });
  assert.equal(resolveDiff('#12', 3, run, notes), 'OPEN');
  assert.match(notes[0], /^gh could not fetch it \(To get started with GitHub CLI, please run:  gh auth login\); fetched PR #12 with git instead\.$/);
});

test('which refs exist is read from ls-remote, never from git\'s (translated) error text', () => {
  // A remote without the PR prints nothing; no fetch is attempted there, so no message is parsed.
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...openOnOrigin,
    'git remote': 'origin\nupstream\n',
    [lsRemote('upstream')]: '',
    [`${GIT} -U3 ${PR('merge')}^1 ${PR('merge')}`]: 'OPEN',
  });
  assert.equal(resolveDiff('#12', 3, run, []), 'OPEN');
  assert.deepEqual(run.calls.filter((c) => c.startsWith('git ls-remote')), [lsRemote('upstream'), lsRemote('origin')], 'upstream first');
  assert.ok(!run.calls.some((c) => c.startsWith('git fetch') && c.includes(' upstream ')), 'nothing fetched from a remote without the PR');
});

test('a stale merge ref (its PR side is not the current head) is not trusted', () => {
  const notes = [];
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...openOnOrigin,
    [`git rev-parse ${PR('merge')}^2 ${PR('head')}`]: 'old\nnew\n',
    [`${GIT} -U3 ${PR('merge')}^1...${PR('head')}`]: 'CURRENT',
  });
  assert.equal(resolveDiff('#12', 3, run, notes), 'CURRENT');
});

test('a PR without a merge ref is compared with the default branch, and a note names it and the way out', () => {
  const notes = [];
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...closedOnOrigin,
    [`git merge-base --is-ancestor ${PR('head')} ${PR('base')}`]: exit(1),
    [`${GIT} -U3 ${PR('base')}...${PR('head')}`]: 'CLOSED',
  });
  assert.equal(resolveDiff('#12', 3, run, notes), 'CLOSED');
  const otherBase = `pass --target origin/<branch>...${PR('head')}`;
  assert.equal(notes[1], `compared PR #12 with origin's default branch (main). If it targets another branch, ${otherBase}`);
});

test('a PR merged with a merge commit is diffed from the default branch just before that merge', () => {
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...closedOnOrigin,
    [`git merge-base --is-ancestor ${PR('head')} ${PR('base')}`]: '',
    [`git rev-list --first-parent --ancestry-path --reverse ${PR('head')}..${PR('base')}`]: 'm1\nm2\n',
    [`${GIT} -U3 m1^1...${PR('head')}`]: 'MERGED',
  });
  assert.equal(resolveDiff('#12', 3, run, []), 'MERGED');
});

test('a network failure surfaces git\'s own message', () => {
  const offline = failed(128, "fatal: unable to access 'https://example.invalid/': Could not resolve host\n");
  const run = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...onGitHub, 'git remote': 'origin\n', [lsRemote('origin')]: offline });
  assert.throws(() => resolveDiff('#12', 3, run, []), (e) => e === offline);
});

test('a PR on no remote, and a repository with no remotes, give errors naming the fix', () => {
  const absent = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...onGitHub, 'git remote': 'origin\n', [lsRemote('origin')]: '' });
  assert.throws(() => resolveDiff('#12', 3, absent, []), /^Error: PR #12 not found on origin\. Install gh, or pass --target <base>\.\.\.<head>\.$/);
  const ghFailed = fakeRun({ [GH_DIFF]: failed(1, 'not found\n'), 'git remote': 'origin\n', [lsRemote('origin')]: '' });
  assert.throws(() => resolveDiff('#12', 3, ghFailed, []), /^Error: PR #12 not found on origin\. Pass --target <base>\.\.\.<head>\.$/,
    'no install advice when gh is installed');
  const none = fakeRun({ [GH_DIFF]: notInstalled('gh'), [REMOTE_URLS]: exit(1), 'git remote': '' });
  assert.throws(() => resolveDiff('#12', 3, none, []), /this repository has no remotes\. Pass --target <base>\.\.\.<head>\./);
});

test('without gh, a repository with no remote on github.com gets no note suggesting gh', () => {
  const notes = [];
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...openOnOrigin,
    ...hostedAt('https://gitlab.com/acme/demo.git'),
    [`${GIT} -U3 ${PR('merge')}^1 ${PR('merge')}`]: 'OPEN',
  });
  assert.equal(resolveDiff('#12', 3, run, notes), 'OPEN');
  assert.deepEqual(notes, []);
});

test('without gh, a PR missing from a remote not on github.com is an error without install advice', () => {
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...hostedAt('https://gitlab.com/acme/demo.git'),
    'git remote': 'origin\n',
    [lsRemote('origin')]: '',
  });
  assert.throws(() => resolveDiff('#12', 3, run, []), /^Error: PR #12 not found on origin\. Pass --target <base>\.\.\.<head>\.$/);
});

// Remote URL forms git accepts. Only the host decides; a path or a look-alike host does not count.
for (const [url, suggested] of [
  ['https://github.com/acme/demo.git', true],
  ['https://user@GitHub.com/acme/demo', true],
  ['git@github.com:acme/demo.git', true],
  ['ssh://git@github.com/acme/demo.git', true],
  ['https://gitlab.com/acme/demo.git', false],
  ['https://github.com.example.org/acme/demo.git', false],
  ['https://example.org/github.com/demo.git', false],
  ['/srv/git/github.com/demo.git', false],
]) {
  test(`without gh, a remote at ${url} ${suggested ? 'gets' : 'does not get'} a note suggesting gh`, () => {
    const notes = [];
    const run = fakeRun({
      [GH_DIFF]: notInstalled('gh'),
      ...openOnOrigin,
      ...hostedAt(url),
      [`${GIT} -U3 ${PR('merge')}^1 ${PR('merge')}`]: 'OPEN',
    });
    resolveDiff('#12', 3, run, notes);
    assert.equal(notes.some((n) => n.includes('Install gh')), suggested);
  });
}

test('without gh, any one remote on github.com is enough for the note suggesting gh', () => {
  const notes = [];
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...openOnOrigin,
    [REMOTE_URLS]: 'remote.mirror.url https://gitlab.com/acme/demo.git\nremote.origin.url git@github.com:acme/demo.git\n',
    [`${GIT} -U3 ${PR('merge')}^1 ${PR('merge')}`]: 'OPEN',
  });
  resolveDiff('#12', 3, run, notes);
  assert.match(notes[0], /Install gh/);
});

test('describeTarget labels a PR generically when gh is unavailable', () => {
  const run = fakeRun({ 'gh pr view 12 --json baseRefName,headRefName': notInstalled('gh') });
  assert.deepEqual(describeTarget('#12', run), { base: 'PR base', head: 'PR #12', label: 'PR #12' });
});

test('withoutTools makes the listed commands look not installed and passes others through', () => {
  const run = withoutTools(fakeRun({ 'git remote': 'origin\n' }), 'gh, node');
  assert.throws(() => run('gh', ['pr', 'diff', '1']), (e) => e.code === 'ENOENT');
  assert.equal(run('git', ['remote']), 'origin\n');
  const same = fakeRun({});
  assert.equal(withoutTools(same, undefined), same);
});
