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
// --refmap= keeps a fetch from moving remote-tracking branches; --no-recurse-submodules keeps it out of submodules.
const FETCH = 'git fetch --quiet --no-tags --no-recurse-submodules --refmap=';
// One fetch for the refs the remote has.
const fetchPrRefs = (remote, ...kinds) => [FETCH, remote, ...kinds.map((k) => `+refs/pull/12/${k}:${PR(k)}`)].join(' ');
// The branch the PR is compared with, fetched from the PR's remote.
const fetchBase = (remote, branch) => `${FETCH} ${remote} +refs/heads/${branch}:${PR('base')}`;
const GH_DIFF = 'gh pr diff 12 --color never';
const GH_BASE = 'gh pr view 12 --json baseRefName';
const ancestry = (a, b) => `git merge-base --is-ancestor ${a} ${b}`;
// What gh shows for a PR: the head against the base it branched from, three-dot.
const prDiff = (base, context = 3) => `${GIT} -U${context} ${base}...${PR('head')}`;
const MERGE_BASE_SIDE = `${PR('merge')}^1`;
// The repository's remote URLs as git config stores them, read to decide whether gh would help.
const REMOTE_URLS = 'git config --get-regexp ^remote\\..*\\.url$';
// Remotes marked by `gh repo set-default`, read to pick the remote gh would ask. Exit 1: none.
const MARKED = 'git config --get-regexp ^remote\\..*\\.gh-resolved$';
const hostedAt = (url) => ({ [REMOTE_URLS]: `remote.origin.url ${url}\n`, [MARKED]: exit(1) });
const onGitHub = hostedAt('https://github.com/acme/demo.git');
// An open PR on origin whose merge ref is current: its second parent is the PR head.
const openOnOrigin = {
  ...onGitHub,
  'git remote': 'origin\n',
  [lsRemote('origin')]: listed('head', 'merge'),
  [fetchPrRefs('origin', 'head', 'merge')]: '',
  [`git rev-parse ${PR('merge')}^2 ${PR('head')}`]: 'h1\nh1\n',
};
// The same PR after its head moved: GitHub has not recomputed the merge ref yet.
const staleOnOrigin = { ...openOnOrigin, [`git rev-parse ${PR('merge')}^2 ${PR('head')}`]: 'old\nnew\n' };
// origin's default branch, main, fetched as the PR's base.
const defaultBranch = {
  'git ls-remote --symref origin HEAD': 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
  [fetchBase('origin', 'main')]: '',
};
// A PR on origin with no merge ref (merged or closed).
const closedOnOrigin = {
  ...onGitHub,
  'git remote': 'origin\n',
  [lsRemote('origin')]: listed('head'),
  [fetchPrRefs('origin', 'head')]: '',
  ...defaultBranch,
};
// A PR whose head is on main: the first commit on main's first-parent line after it has `parents`.
const mergedIntoMain = (parents) => ({
  ...closedOnOrigin,
  [ancestry(PR('head'), PR('base'))]: '',
  [`git rev-list --first-parent --ancestry-path --reverse ${PR('head')}..${PR('base')}`]: 'm1\nm2\n',
  [`git rev-parse m1^@ ${PR('head')}`]: `${parents.join('\n')}\nh1\n`,
});
const baseUnknown = (why) => new RegExp(`^Error: cannot tell which branch PR #12 targets: ${why}\\. Install gh, or pass --target <branch>\\.\\.\\.#12\\.$`);

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

test('without gh, an open PR is diffed three-dot from its merge ref\'s base side, as gh diffs it', () => {
  const notes = [];
  const run = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...openOnOrigin, [prDiff(MERGE_BASE_SIDE, 5)]: 'OPEN' });
  assert.equal(resolveDiff('#12', 5, run, notes), 'OPEN');
  assert.match(notes[0], /^gh is not installed; fetched PR #12 with git instead\. Install gh \(https:\/\/cli\.github\.com\)/);
});

test('gh that fails for another reason falls back to git; the note gives gh\'s reason, not install advice', () => {
  const notes = [];
  const loggedOut = failed(4, 'To get started with GitHub CLI, please run:  gh auth login\n');
  const run = fakeRun({ [GH_DIFF]: loggedOut, [GH_BASE]: loggedOut, ...openOnOrigin, [prDiff(MERGE_BASE_SIDE)]: 'OPEN' });
  assert.equal(resolveDiff('#12', 3, run, notes), 'OPEN');
  assert.match(notes[0], /^gh could not fetch it \(To get started with GitHub CLI, please run:  gh auth login\); fetched PR #12 with git instead\.$/);
});

test('gh that can view but not diff the PR names the base, and the PR is compared with that branch', () => {
  const run = fakeRun({
    [GH_DIFF]: failed(1, 'HTTP 406: Sorry, the diff exceeded the maximum number of files (300).\n'),
    [GH_BASE]: '{"baseRefName":"develop"}\n',
    ...openOnOrigin,
    [fetchBase('origin', 'develop')]: '',
    [ancestry(PR('head'), PR('base'))]: exit(1),
    [prDiff(PR('base'))]: 'AGAINST DEVELOP',
  });
  assert.equal(resolveDiff('#12', 3, run, []), 'AGAINST DEVELOP');
});

test('<branch>...#N compares the PR with that branch from the PR\'s remote, without asking gh', () => {
  const run = fakeRun({
    ...openOnOrigin,
    [fetchBase('origin', 'develop')]: '',
    [ancestry(PR('head'), PR('base'))]: exit(1),
    [prDiff(PR('base'))]: 'AGAINST DEVELOP',
  });
  assert.equal(resolveDiff('develop...#12', 3, run, []), 'AGAINST DEVELOP');
  assert.deepEqual(run.calls.filter((c) => c.startsWith('gh ')), []);
});

test('only the remote gh would ask is searched: upstream before origin, and a PR missing there is not sought elsewhere', () => {
  // ls-remote output is data; git's error messages are translated into the user's language.
  const run = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...openOnOrigin, 'git remote': 'origin\nupstream\n', [lsRemote('upstream')]: '' });
  assert.throws(() => resolveDiff('#12', 3, run, []), /^Error: PR #12 not found on upstream\. Install gh, or pass --target <base>\.\.\.<head>\.$/);
  assert.deepEqual(run.calls.filter((c) => c.startsWith('git ls-remote')), [lsRemote('upstream')]);
});

test('a remote marked by gh repo set-default is searched instead of upstream, and a note names it', () => {
  const notes = [];
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...openOnOrigin,
    'git remote': 'my.fork\norigin\nupstream\n',
    [MARKED]: 'remote.my.fork.gh-resolved base\n',
    [lsRemote('my.fork')]: listed('head', 'merge'),
    [fetchPrRefs('my.fork', 'head', 'merge')]: '',
    [prDiff(MERGE_BASE_SIDE)]: 'FORK',
  });
  assert.equal(resolveDiff('#12', 3, run, notes), 'FORK');
  assert.equal(notes[1], 'fetched PR #12 from my.fork, the remote gh would ask among my.fork, origin, upstream.');
});

test('a stale merge ref is still diffed from its base side when the head has not taken in newer base commits', () => {
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...staleOnOrigin,
    [ancestry(MERGE_BASE_SIDE, PR('head'))]: exit(1),
    [prDiff(MERGE_BASE_SIDE)]: 'OPEN',
  });
  assert.equal(resolveDiff('#12', 3, run, []), 'OPEN');
});

test('a stale merge ref whose head took in newer base commits is diffed against the current default branch', () => {
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...staleOnOrigin,
    ...defaultBranch,
    [ancestry(MERGE_BASE_SIDE, PR('head'))]: '',
    [ancestry(MERGE_BASE_SIDE, PR('base'))]: '',
    [prDiff(PR('base'))]: 'CURRENT',
  });
  assert.equal(resolveDiff('#12', 3, run, []), 'CURRENT');
});

test('a stale merge ref whose base is not on the default branch is an error naming <branch>...#N', () => {
  const run = fakeRun({
    [GH_DIFF]: notInstalled('gh'),
    ...staleOnOrigin,
    ...defaultBranch,
    [ancestry(MERGE_BASE_SIDE, PR('head'))]: '',
    [ancestry(MERGE_BASE_SIDE, PR('base'))]: exit(1),
  });
  assert.throws(() => resolveDiff('#12', 3, run, []),
    baseUnknown('its merge ref on origin is out of date and its base is not origin\'s default branch \\(main\\)'));
});

test('a PR without a merge ref and not merged into the default branch is an error naming <branch>...#N', () => {
  const run = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...closedOnOrigin, [ancestry(PR('head'), PR('base'))]: exit(1) });
  assert.throws(() => resolveDiff('#12', 3, run, []),
    baseUnknown('it has no merge ref on origin and was not merged into origin\'s default branch \\(main\\)'));
});

test('a PR merged into the default branch with a merge commit is diffed from that branch just before the merge', () => {
  const run = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...mergedIntoMain(['b1', 'h1']), [prDiff('m1^1')]: 'MERGED' });
  assert.equal(resolveDiff('#12', 3, run, []), 'MERGED');
});

test('a PR that reached the default branch through another branch\'s merge is an error naming <branch>...#N', () => {
  const run = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...mergedIntoMain(['b1', 'd1']) });
  assert.throws(() => resolveDiff('#12', 3, run, []),
    baseUnknown('it has no merge ref on origin and was not merged into origin\'s default branch \\(main\\)'));
});

test('a network failure surfaces git\'s own message', () => {
  const offline = failed(128, "fatal: unable to access 'https://example.invalid/': Could not resolve host\n");
  const run = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...onGitHub, 'git remote': 'origin\n', [lsRemote('origin')]: offline });
  assert.throws(() => resolveDiff('#12', 3, run, []), (e) => e === offline);
});

test('a PR on no remote, and a repository with no remotes, give errors naming the fix', () => {
  const absent = fakeRun({ [GH_DIFF]: notInstalled('gh'), ...onGitHub, 'git remote': 'origin\n', [lsRemote('origin')]: '' });
  assert.throws(() => resolveDiff('#12', 3, absent, []), /^Error: PR #12 not found on origin\. Install gh, or pass --target <base>\.\.\.<head>\.$/);
  const notFound = failed(1, 'not found\n');
  const ghFailed = fakeRun({ [GH_DIFF]: notFound, [GH_BASE]: notFound, [MARKED]: exit(1), 'git remote': 'origin\n', [lsRemote('origin')]: '' });
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
    [prDiff(MERGE_BASE_SIDE)]: 'OPEN',
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
      [prDiff(MERGE_BASE_SIDE)]: 'OPEN',
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
    [prDiff(MERGE_BASE_SIDE)]: 'OPEN',
  });
  resolveDiff('#12', 3, run, notes);
  assert.match(notes[0], /Install gh/);
});

test('describeTarget labels a PR generically when gh is unavailable', () => {
  const run = fakeRun({ 'gh pr view 12 --json baseRefName,headRefName': notInstalled('gh') });
  assert.deepEqual(describeTarget('#12', run), { base: 'PR base', head: 'PR #12', label: 'PR #12' });
});

test('parseTarget reads <branch>...#N as a pull request compared with that branch', () => {
  assert.deepEqual(parseTarget('release/2.x...#12'), { kind: 'pr', pr: '12', base: 'release/2.x' });
});

test('describeTarget labels a PR with the base named in <branch>...#N, with gh or without', () => {
  const withGh = fakeRun({ 'gh pr view 12 --json baseRefName,headRefName': '{"baseRefName":"main","headRefName":"feature"}' });
  assert.deepEqual(describeTarget('develop...#12', withGh), { base: 'develop', head: 'feature', label: 'PR #12 (feature vs develop)' });
  const withoutGh = fakeRun({ 'gh pr view 12 --json baseRefName,headRefName': notInstalled('gh') });
  assert.deepEqual(describeTarget('develop...#12', withoutGh), { base: 'develop', head: 'PR #12', label: 'PR #12 vs develop' });
});

test('withoutTools makes the listed commands look not installed and passes others through', () => {
  const run = withoutTools(fakeRun({ 'git remote': 'origin\n' }), 'gh, node');
  assert.throws(() => run('gh', ['pr', 'diff', '1']), (e) => e.code === 'ENOENT');
  assert.equal(run('git', ['remote']), 'origin\n');
  const same = fakeRun({});
  assert.equal(withoutTools(same, undefined), same);
});
