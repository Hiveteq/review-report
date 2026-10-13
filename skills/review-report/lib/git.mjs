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
    case 'pr': return resolvePr(t.pr, context, run, notes);
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
        return { base: info.baseRefName, head: info.headRefName, label: `PR #${t.pr} (${info.headRefName} vs ${info.baseRefName})` };
      } catch {
        // Without gh the branch names are unknown: git only has the PR's refs.
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

// Pull requests (`#123`). gh is preferred: it knows the PR's branch names and handles any PR
// state. When gh is missing or fails (not installed, not logged in), the PR is fetched with
// plain git: GitHub publishes every PR as refs/pull/<n>/head, and as refs/pull/<n>/merge while
// it is open and mergeable. Fetched refs go under refs/review-report/, so the user's branches
// and tags are never touched, and a repeat run overwrites them.
const prRef = (pr, kind) => `refs/review-report/pr/${pr}/${kind}`;

function resolvePr(pr, context, run, notes) {
  let ghMissing = false;
  try {
    const diff = run('gh', ['pr', 'diff', pr, '--color', 'never']);
    if (context !== 3) notes.push('--context is ignored when gh fetches the pull request; use <base>...<head> for wider context');
    return diff;
  } catch (e) {
    ghMissing = e.code === 'ENOENT';
    notes.push(ghMissing
      ? `gh is not installed; fetched PR #${pr} with git instead. Install gh (https://cli.github.com) for exact branch ` +
        'names in the report header and the PR description for Claude to read.'
      : `gh could not fetch it (${firstLine(e)}); fetched PR #${pr} with git instead.`);
  }
  const fetched = fetchPr(pr, run, ghMissing);
  return run('git', [...DIFF_FORMAT, `-U${context}`, ...prRange(pr, fetched, run, notes)]);
}

// Fetches PR <pr> from the first remote that has it: upstream first (fork workflows), then
// origin, then any other remote. `ls-remote` says which of the PR's refs exist: its output is
// data, unlike git's error messages, which are translated into the user's language.
function fetchPr(pr, run, ghMissing) {
  const names = run('git', ['remote']).split('\n').map((s) => s.trim()).filter(Boolean);
  const first = ['upstream', 'origin'].filter((n) => names.includes(n));
  const remotes = [...first, ...names.filter((n) => !first.includes(n))];
  const fix = ghMissing ? 'Install gh, or pass --target <base>...<head>.' : 'Pass --target <base>...<head>.';
  if (!remotes.length) throw new Error(`PR #${pr} cannot be fetched: this repository has no remotes. Pass --target <base>...<head>.`);
  for (const remote of remotes) {
    const listing = run('git', ['ls-remote', remote, `refs/pull/${pr}/head`, `refs/pull/${pr}/merge`]);
    const kinds = ['head', 'merge'].filter((k) => listing.includes(`\trefs/pull/${pr}/${k}`));
    if (!kinds.includes('head')) continue;
    fetchRefs(remote, kinds.map((k) => [`refs/pull/${pr}/${k}`, prRef(pr, k)]), run);
    return { remote, head: prRef(pr, 'head'), merge: kinds.includes('merge') ? prRef(pr, 'merge') : null };
  }
  throw new Error(`PR #${pr} not found on ${remotes.join(', ')}. ${fix}`);
}

// One fetch for [remote ref, local ref] pairs. --refmap= stops git from also moving the user's
// remote-tracking branches; --no-tags keeps their tags as they are.
function fetchRefs(remote, pairs, run) {
  run('git', ['fetch', '--quiet', '--no-tags', '--refmap=', remote, ...pairs.map(([from, to]) => `+${from}:${to}`)]);
}

// The git diff arguments for what the PR adds. An open PR's merge ref has the base branch tip as
// its first parent and the PR head as its second. GitHub refreshes it lazily and not at all while
// the PR conflicts, so it is trusted only when its second parent is the current head; a stale one
// still names the base, and the head is compared with it. Without a merge ref (merged or closed),
// the PR is compared with the remote's default branch, and a note says so. A PR merged with a
// merge commit is already inside that branch, so its base is that branch just before the merge.
function prRange(pr, { remote, head, merge }, run, notes) {
  if (merge) {
    const [prSide, current] = run('git', ['rev-parse', `${merge}^2`, head]).split('\n').map((s) => s.trim());
    return prSide === current ? [`${merge}^1`, merge] : [`${merge}^1...${head}`];
  }
  const { ref: base, name } = fetchDefaultBranch(pr, remote, run);
  notes.push(`compared PR #${pr} with ${remote}'s default branch (${name}). If it targets another branch, ` +
    `pass --target ${remote}/<branch>...${head}`);
  if (!isAncestor(head, base, run)) return [`${base}...${head}`];
  const mergedBy = run('git', ['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${head}..${base}`])
    .split('\n')[0].trim();
  if (!mergedBy) throw new Error(`PR #${pr} adds nothing beyond ${remote}'s default branch. Pass --target <base>...<head>.`);
  return [`${mergedBy}^1...${head}`];
}

function fetchDefaultBranch(pr, remote, run) {
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(run('git', ['ls-remote', '--symref', remote, 'HEAD']));
  if (!m) throw new Error(`cannot tell ${remote}'s default branch. Pass --target <base>...<head>.`);
  fetchRefs(remote, [[`refs/heads/${m[1]}`, prRef(pr, 'base')]], run);
  return { ref: prRef(pr, 'base'), name: m[1] };
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
