// @ts-check
// Resolves a report target to unified diff text. All process spawning goes
// through an injectable `run` so tests never touch a real repository.
import { execFileSync } from 'node:child_process';

/**
 * Runs a command with an argument array and returns its stdout. It throws when the command fails,
 * as execFileSync does: the error carries the exit code in `status` and the output in `stderr`.
 * @typedef {(cmd: string, args: string[]) => string} Run
 */

/**
 * What execFileSync throws when a command fails or cannot start.
 * @typedef {Error & { status?: number | null, stderr?: string | Buffer }} ExecError
 */

/**
 * A target spec, read once. See parseTarget.
 * @typedef {{ kind: 'default' } | { kind: 'staged' } | { kind: 'working' } | { kind: 'pr', pr: string }
 *   | { kind: 'range', base: string, head: string } | { kind: 'commit', ref: string }} Target
 */

/**
 * How a target is labelled in the report header.
 * @typedef {object} TargetInfo
 * @property {string} base
 * @property {string} head
 * @property {string} label
 */

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

/** @type {Run} */
export function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The one interpretation of a target spec. resolveDiff (what to diff) and
// describeTarget (how to label it) both derive from it, so they cannot disagree.
/**
 * @param {string | undefined} target
 * @returns {Target}
 */
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

/**
 * @param {string | undefined} target
 * @param {number} context lines of context around each change
 * @param {Run} [run]
 * @returns {string} unified diff text
 */
export function resolveDiff(target, context, run = defaultRun) {
  const git = [...DIFF_FORMAT, `-U${context}`];
  const t = parseTarget(target);
  switch (t.kind) {
    case 'default': return run('git', [...git, `${defaultBase(run)}...HEAD`]);
    case 'staged': return run('git', [...git, '--cached']);
    case 'working': return run('git', [...git, 'HEAD']);
    case 'pr': return run('gh', ['pr', 'diff', t.pr, '--color', 'never']);
    case 'range': return run('git', [...git, /** @type {string} */ (target)]); // a range is never undefined
    // A single revision means the change that commit introduced, as describeTarget labels it.
    default: return run('git', [...git, parentOf(t.ref, run), t.ref]);
  }
}

/**
 * @param {string | undefined} target
 * @param {Run} [run]
 * @returns {TargetInfo}
 */
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
      const info = JSON.parse(run('gh', ['pr', 'view', t.pr, '--json', 'baseRefName,headRefName']));
      return { base: info.baseRefName, head: info.headRefName, label: `PR #${t.pr} (${info.headRefName} vs ${info.baseRefName})` };
    }
    case 'range': return { base: t.base, head: t.head, label: /** @type {string} */ (target) }; // a range is never undefined
    default: return { base: `${t.ref}^`, head: t.ref, label: t.ref };
  }
}

/**
 * @param {Run} [run]
 * @returns {string}
 */
export function repoRoot(run = defaultRun) {
  return run('git', ['rev-parse', '--show-toplevel']).trim();
}

/**
 * @param {string} target
 * @returns {string | null} the PR number for a `#123` target, as text
 */
export function prNumber(target) {
  const m = /^#(\d+)$/.exec(target);
  return m ? m[1] : null;
}

// `<ref>^`, or the empty tree when <ref> is a root commit and has no parent.
/**
 * @param {string} ref
 * @param {Run} run
 * @returns {string}
 */
function parentOf(ref, run) {
  return refExists(`${ref}^`, run) ? `${ref}^` : EMPTY_TREE;
}

// `rev-parse --verify --quiet` exits 1 for an unknown ref. Any other failure
// (not a repository, git missing, dubious ownership) is not an answer, so it
// propagates with git's own message instead of being read as "no such ref".
/**
 * @param {string} ref
 * @param {Run} run
 * @returns {boolean}
 */
function refExists(ref, run) {
  try {
    run('git', ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch (e) {
    if (/** @type {ExecError} */ (e).status === 1) return false;
    throw e;
  }
}

// master first, then main. Anything else must be given explicitly.
/**
 * @param {Run} run
 * @returns {string}
 */
function defaultBase(run) {
  for (const branch of ['master', 'main']) if (refExists(branch, run)) return branch;
  throw new Error('No master or main branch found. Pass --target <base>...<head>.');
}
