// Resolves a report target to unified diff text. All process spawning goes
// through an injectable `run` so tests never touch a real repository.
import { execFileSync } from 'node:child_process';

// git's empty tree. It stands in for the parent of a root commit, which has none.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Pins the output format parseDiff expects, whatever the user's git config says:
// unicode paths unquoted, blank context lines as a single space (not "" under
// diff.suppressBlankEmpty), no colour, no external diff tool, a/ b/ prefixes
// (not diff.noprefix or diff.mnemonicPrefix), paths from the repo root (not
// diff.relative), one-line submodule entries.
const DIFF_FORMAT = [
  '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false',
  'diff', '--no-color', '--no-ext-diff', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short',
];

export function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The one interpretation of a target spec. resolveDiff (what to diff) and
// describeTarget (how to label it) both derive from it, so they cannot disagree.
export function parseTarget(target) {
  if (target === undefined || target === '') return { kind: 'default' };
  if (target === '--staged') return { kind: 'staged' };
  if (target === '--working') return { kind: 'working' };
  const pr = prNumber(target);
  if (pr) return { kind: 'pr', pr };
  // `<branch>...#123`: a pull request compared with the branch it targets, which git alone cannot tell.
  const based = /^(.+)\.\.\.#(\d+)$/.exec(target);
  if (based) return { kind: 'pr', pr: based[2], base: based[1] };
  // `A..B` or `A...B`. git reads a missing side as HEAD, so `A..` is A..HEAD.
  const m = /^(.*?)\.{2,3}(.*)$/.exec(target);
  if (m) return { kind: 'range', base: m[1] || 'HEAD', head: m[2] || 'HEAD' };
  return { kind: 'commit', ref: target };
}

export function resolveDiff(target, context, run = defaultRun, notes = []) {
  const git = [...DIFF_FORMAT, `-U${context}`];
  const t = parseTarget(target);
  switch (t.kind) {
    case 'default': return run('git', [...git, `${defaultBase(run)}...HEAD`]);
    case 'staged': return run('git', [...git, '--cached']);
    case 'working': return run('git', [...git, 'HEAD']);
    case 'pr': return resolvePr(t, context, run, notes);
    case 'range': return run('git', [...git, target]);
    // A single revision means the change that commit introduced, as describeTarget labels it.
    default: return run('git', [...git, parentOf(t.ref, run), t.ref]);
  }
}

export function describeTarget(target, run = defaultRun) {
  const t = parseTarget(target);
  switch (t.kind) {
    case 'default': {
      const base = defaultBase(run);
      const head = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      return { base, head, label: `${head} vs ${base}` };
    }
    case 'staged': return { base: 'HEAD', head: 'index', label: 'staged changes' };
    case 'working': return { base: 'HEAD', head: 'working tree', label: 'working tree changes' };
    case 'pr': {
      try {
        const info = JSON.parse(run('gh', ['pr', 'view', t.pr, '--json', 'baseRefName,headRefName']));
        const base = t.base ?? info.baseRefName;
        return { base, head: info.headRefName, label: `PR #${t.pr} (${info.headRefName} vs ${base})` };
      } catch {
        // Without gh the branch names are unknown: git only has the PR's refs.
        if (t.base) return { base: t.base, head: `PR #${t.pr}`, label: `PR #${t.pr} vs ${t.base}` };
        return { base: 'PR base', head: `PR #${t.pr}`, label: `PR #${t.pr}` };
      }
    }
    case 'range': return { base: t.base, head: t.head, label: target };
    default: return { base: `${t.ref}^`, head: t.ref, label: t.ref };
  }
}

export function repoRoot(run = defaultRun) {
  return run('git', ['rev-parse', '--show-toplevel']).trim();
}

export function prNumber(target) {
  const m = /^#(\d+)$/.exec(target);
  return m ? m[1] : null;
}

// Test hook: REVIEW_REPORT_WITHOUT=gh (comma-separated) makes `run` act as if those commands
// were not installed, so tests can take the git path on machines and CI images that have gh.
export function withoutTools(run, list) {
  const missing = new Set(String(list ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!missing.size) return run;
  return (cmd, args) => {
    if (missing.has(cmd)) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
    return run(cmd, args);
  };
}

// git and gh failures carry their stderr; the first meaningful line is the message.
export function firstLine(e) {
  const text = (e.stderr && String(e.stderr).trim()) || e.message || String(e);
  return text.split('\n').filter(Boolean)[0] ?? 'unknown error';
}

// Pull requests: `#123`, or `<branch>...#123` to name the branch it targets.
// gh is preferred. It knows the PR's base and handles any PR state.
// Without gh, plain git fetches the PR. So does a failing gh: not logged in, or a diff too large to send.
// GitHub publishes every PR as refs/pull/<n>/head.
// While a PR is open and mergeable, GitHub also publishes refs/pull/<n>/merge.
// Fetched refs go under refs/review-report/, so the user's branches and tags stay untouched.
// A repeat run overwrites them.
const prRef = (pr, kind) => `refs/review-report/pr/${pr}/${kind}`;

function resolvePr({ pr, base }, context, run, notes) {
  const gh = base ? { base, suggestGh: false } : tryGh(pr, run, notes);
  if (gh.diff !== undefined) {
    if (context !== 3) notes.push('--context is ignored when gh fetches the pull request; use <base>...<head> for wider context');
    return gh.diff;
  }
  const advice = gh.suggestGh ? 'Install gh, or pass' : 'Pass';
  const remote = prRemote(pr, run, notes);
  const refs = fetchPr(pr, remote, run);
  if (!refs) throw new Error(`PR #${pr} not found on ${remote}. ${advice} --target <base>...<head>.`);
  const range = prRange({ pr, remote, base: gh.base, advice, ...refs }, run);
  return run('git', [...DIFF_FORMAT, `-U${context}`, ...range]);
}

// Returns gh's diff of the PR, or what is known without it.
// Without a diff, it says whether installing gh would help.
// gh may run but fail to send the diff; GitHub refuses diffs over 300 files, for example.
// Then gh pr view may still name the base branch.
function tryGh(pr, run, notes) {
  try {
    return { diff: run('gh', ['pr', 'diff', pr, '--color', 'never']) };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      notes.push(`gh could not fetch it (${firstLine(e)}); fetched PR #${pr} with git instead.`);
      return { suggestGh: false, base: ghBase(pr, run) };
    }
    const suggestGh = hasGitHubRemote(run);
    const benefit = 'for exact branch names in the report header and the PR description for Claude to read';
    if (suggestGh) notes.push(`gh is not installed; fetched PR #${pr} with git instead. Install gh (https://cli.github.com) ${benefit}.`);
    return { suggestGh };
  }
}

function ghBase(pr, run) {
  try {
    return JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'baseRefName'])).baseRefName ?? null;
  } catch {
    // gh cannot view the PR either (not logged in, offline): git has to find the base.
    return null;
  }
}

// Installing gh helps only where gh works, so the advice needs a remote on github.com. The URLs
// are read as configured, before url.<base>.insteadOf rewrites them. GitHub Enterprise hosts are
// not recognised, so their users get no install advice.
function hasGitHubRemote(run) {
  return configLines(run, '^remote\\..*\\.url$').some((line) => urlHost(line.split(' ')[1] ?? '') === 'github.com');
}

// `git config --get-regexp` output as lines; it exits 1 when nothing matches.
function configLines(run, pattern) {
  try {
    return run('git', ['config', '--get-regexp', pattern]).split('\n').filter(Boolean);
  } catch (e) {
    if (e.status !== 1) throw e;
    return [];
  }
}

// The host of a remote URL: a URL with a scheme (https://, ssh://), or scp-like `user@host:path`.
// A local path has none.
function urlHost(url) {
  if (URL.canParse(url)) return new URL(url).hostname.toLowerCase();
  return /^(?:[^@/]+@)?([^:/]+):/.exec(url)?.[1].toLowerCase() ?? '';
}

// Picks the one remote gh would ask.
// That is the remote `gh repo set-default` marked (remote.<name>.gh-resolved).
// Otherwise it is upstream, github or origin, in that order, else the first remote.
// A PR number belongs to one repository.
// Another remote's PR with the same number is a different change, so no other remote is asked.
function prRemote(pr, run, notes) {
  const names = run('git', ['remote']).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error(`PR #${pr} cannot be fetched: this repository has no remotes. Pass --target <base>...<head>.`);
  const marked = configLines(run, '^remote\\..*\\.gh-resolved$').map((line) => /^remote\.(.+)\.gh-resolved /.exec(line)?.[1]);
  const remote = marked.find((n) => names.includes(n))
    ?? ['upstream', 'github', 'origin'].find((n) => names.includes(n))
    ?? names[0];
  if (names.length > 1) notes.push(`fetched PR #${pr} from ${remote}, the remote gh would ask among ${names.join(', ')}.`);
  return remote;
}

// Fetches PR <pr>'s refs from `remote`, or returns null when it has no such PR.
// `ls-remote` says which refs exist. Its output is data; git's error messages are translated.
function fetchPr(pr, remote, run) {
  const listing = run('git', ['ls-remote', remote, `refs/pull/${pr}/head`, `refs/pull/${pr}/merge`]);
  const kinds = ['head', 'merge'].filter((k) => listing.includes(`\trefs/pull/${pr}/${k}`));
  if (!kinds.includes('head')) return null;
  fetchRefs(remote, kinds.map((k) => [`refs/pull/${pr}/${k}`, prRef(pr, k)]), run);
  return { head: prRef(pr, 'head'), merge: kinds.includes('merge') ? prRef(pr, 'merge') : null };
}

// One fetch for [remote ref, local ref] pairs.
// --refmap= stops git from also moving the user's remote-tracking branches.
// --no-tags leaves their tags as they are.
// --no-recurse-submodules keeps the fetch out of submodules.
// A submodule's remote may lack a commit the PR points to, or be unreachable.
function fetchRefs(remote, pairs, run) {
  run('git', ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--refmap=', remote,
    ...pairs.map(([from, to]) => `+${from}:${to}`)]);
}

// The git diff arguments for what the PR adds, as gh shows it.
// That is the head against the base it branched from, three-dot.
// A base named by the user or by gh is used as given.
// Otherwise git works the base out where it can prove it.
// Where it cannot, the error says how to name the base.
function prRange(p, run) {
  if (p.base) return againstBase(p, fetchBranch(p, p.base, run), run).range;
  return p.merge ? openRange(p, run) : rangeWithoutMergeRef(p, run);
}

// An open PR's merge ref is GitHub's test merge.
// Its first parent is the base tip at that time; its second parent is the PR head.
// GitHub refreshes it lazily, and never while the PR conflicts.
// A stale merge ref still gives the right base, unless the head has since taken in newer base commits.
// A rebase or "Update branch" does that. Then the diff needs the current base tip.
// git can confirm that tip only for the default branch.
function openRange(p, run) {
  const { pr, remote, head, merge, advice } = p;
  const baseSide = `${merge}^1`;
  const [prSide, current] = run('git', ['rev-parse', `${merge}^2`, head]).split('\n').map((s) => s.trim());
  if (prSide === current || !isAncestor(baseSide, head, run)) return [`${baseSide}...${head}`];
  const branch = fetchDefaultBranch(p, run);
  if (isAncestor(baseSide, branch.ref, run)) return [`${branch.ref}...${head}`];
  const why = `its merge ref on ${remote} is out of date and its base is not ${branch.label}`;
  throw new Error(`cannot tell which branch PR #${pr} targets: ${why}. ${advice} --target <branch>...#${pr}.`);
}

// A merged or closed PR has no merge ref.
// Its base is known only when it was merged into the default branch.
// Then a merge commit there has the PR head as its second parent.
function rangeWithoutMergeRef(p, run) {
  const branch = fetchDefaultBranch(p, run);
  const { range, merged } = againstBase(p, branch, run);
  if (merged) return range;
  const why = `it has no merge ref on ${p.remote} and was not merged into ${branch.label}`;
  throw new Error(`cannot tell which branch PR #${p.pr} targets: ${why}. ${p.advice} --target <branch>...#${p.pr}.`);
}

// The range for the PR against `branch`, a fetched base.
// A PR merged into the branch is already inside it.
// So the PR is compared with the branch just before the merge.
// `merged` is true when that merge commit's second parent is the PR head.
// That proves the PR was merged into this branch.
function againstBase({ pr, head }, branch, run) {
  if (!isAncestor(head, branch.ref, run)) return { range: [`${branch.ref}...${head}`], merged: false };
  const mergedBy = run('git', ['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${head}..${branch.ref}`])
    .split('\n')[0].trim();
  if (!mergedBy) throw new Error(`PR #${pr} adds nothing beyond ${branch.label}. Pass --target <base>...<head>.`);
  // `X^@` lists X's parents; the head's own hash follows them.
  const shas = run('git', ['rev-parse', `${mergedBy}^@`, head]).split('\n').map((s) => s.trim()).filter(Boolean);
  return { range: [`${mergedBy}^1...${head}`], merged: shas.length > 2 && shas[1] === shas.at(-1) };
}

function fetchDefaultBranch(p, run) {
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(run('git', ['ls-remote', '--symref', p.remote, 'HEAD']));
  if (!m) throw new Error(`cannot tell ${p.remote}'s default branch. Pass --target <branch>...#${p.pr}.`);
  return { ...fetchBranch(p, m[1], run), label: `${p.remote}'s default branch (${m[1]})` };
}

function fetchBranch({ pr, remote }, name, run) {
  fetchRefs(remote, [[`refs/heads/${name}`, prRef(pr, 'base')]], run);
  return { ref: prRef(pr, 'base'), label: `${remote}/${name}` };
}

// `merge-base --is-ancestor` exits 1 for "no"; any other failure propagates.
function isAncestor(a, b, run) {
  try {
    run('git', ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}

// `<ref>^`, or the empty tree when <ref> is a root commit and has no parent.
function parentOf(ref, run) {
  return refExists(`${ref}^`, run) ? `${ref}^` : EMPTY_TREE;
}

// `rev-parse --verify --quiet` exits 1 for an unknown ref. Any other failure
// (not a repository, git missing, dubious ownership) is not an answer, so it
// propagates with git's own message instead of being read as "no such ref".
function refExists(ref, run) {
  try {
    run('git', ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}

// master first, then main. Anything else must be given explicitly.
function defaultBase(run) {
  for (const branch of ['master', 'main']) if (refExists(branch, run)) return branch;
  throw new Error('No master or main branch found. Pass --target <base>...<head>.');
}
