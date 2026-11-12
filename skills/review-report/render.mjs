#!/usr/bin/env node
// @ts-check
// review-report renderer. Story JSON + diff target → one self-contained HTML file.
// Usage:
//   node render.mjs --story <path> [--target <spec>] [--out <path>] [--context N] [--min-coverage PCT] [--only <glob,...>] [--pages|--single] [--diff-file <path>]
//   node render.mjs --dump-diff [--target <spec>] [--context N] [--diff-file <path>]
//   node render.mjs --dump-numbered [--target <spec>] [--context N] [--diff-file <path>]
//
// Errors and warnings go to stderr. When a report is written, stdout carries notes about .gitignore and,
// as its last line, the path of the report, so a caller can take that line without parsing anything else.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs as parseCli } from 'node:util';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { parseDiff, formatNumbered, lineStats } from './lib/diff.mjs';
import { resolveDiff, describeTarget, repoRoot, prNumber } from './lib/git.mjs';
import { validateStory, buildReport, withTargetMeta } from './lib/story.mjs';
import { renderPages } from './lib/html.mjs';
import { computeCoverage, matchGlob } from './lib/coverage.mjs';
import { gateErrors } from './lib/gate.mjs';

/** @typedef {import('./lib/diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./lib/git.mjs').ExecError} ExecError */
/** @typedef {import('./lib/story.mjs').Story} Story */
/** @typedef {import('./lib/story.mjs').Report} Report */
/** @typedef {import('./lib/coverage.mjs').Coverage} Coverage */

/**
 * The command line, read and checked.
 * @typedef {object} Options
 * @property {string} [story] path of the story JSON; always set outside the dump modes
 * @property {string} [target]
 * @property {string} [out]
 * @property {number} context
 * @property {number} minCoverage
 * @property {string[]} [only]
 * @property {string} [diffFile]
 * @property {boolean} dumpDiff
 * @property {boolean} dumpNumbered
 * @property {'pages' | 'single' | 'auto'} layout auto pages a report whose diff is long
 */

/**
 * A check on the parsed options: when `isBad` holds, the run stops with `problem` as a usage error.
 * @typedef {readonly [isBad: (opts: Options, flags: { pages?: boolean, single?: boolean }) => boolean, problem: string]} ArgRule
 */

// Everything main() needs below is declared before it runs: a const is not usable until its line has executed.

const USAGE = 'usage: node render.mjs --story <path> [--target <spec>] [--out <path>] [--context N] [--diff-file <path>]\n' +
  '       node render.mjs --dump-diff [--target <spec>] [--context N] [--diff-file <path>]\n' +
  '       node render.mjs --dump-numbered [--target <spec>] [--context N] [--diff-file <path>]';

/** Values of the options left out. */
const DEFAULTS = Object.freeze({ context: 3, minCoverage: 80 });

/**
 * Without --pages or --single, a diff of more rows than this is written as one page per chapter:
 * a single file that long is slow to open and hard to find one's way in.
 */
const PAGED_ABOVE_ROWS = 1500;

const OPTIONS = /** @type {const} */ ({
  story: { type: 'string' },
  target: { type: 'string' },
  out: { type: 'string' },
  context: { type: 'string' },
  'min-coverage': { type: 'string' },
  only: { type: 'string' },
  'diff-file': { type: 'string' },
  'dump-diff': { type: 'boolean' },
  'dump-numbered': { type: 'boolean' },
  pages: { type: 'boolean' },
  single: { type: 'boolean' },
});

// Names of the options that take a value; used by joinDashValues below.
const STRING_FLAGS = new Set(Object.entries(OPTIONS).filter(([, o]) => o.type === 'string').map(([k]) => `--${k}`));

/**
 * Checked in this order; the first broken rule is the one reported.
 * @type {readonly ArgRule[]}
 */
const ARG_RULES = [
  [(_, flags) => Boolean(flags.pages && flags.single), '--pages and --single cannot be used together'],
  [(o) => !o.dumpDiff && !o.dumpNumbered && !o.story, '--story is required'],
  [(o) => !Number.isInteger(o.context) || o.context < 0, '--context must be a non-negative integer'],
  [(o) => !(o.minCoverage >= 0 && o.minCoverage <= 100), '--min-coverage must be 0..100'],
];

// The pass needs a rendered report to read, so its absence is a visible header line, not a refusal.
const NO_READER_PASS = 'reader pass not recorded; the header says so. Run it and render again (reference/reader-pass.md)';

// Fail clearly on an old Node instead of with an obscure error further in.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  process.stderr.write(`error: review-report needs Node 22 or newer; this is Node ${process.versions.node}\n`);
  process.exit(2);
}

main(process.argv.slice(2));

/**
 * The run, phase by phase. Each phase that can fail prints its errors and exits, so a later phase
 * only ever sees input that passed every check before it.
 * @param {string[]} argv
 */
function main(argv) {
  const opts = optionsOrExit(argv);
  const diffText = loadDiffText(opts);
  if (opts.dumpDiff || opts.dumpNumbered) {
    process.stdout.write(opts.dumpDiff ? diffText : formatNumbered(onlyPart(parseDiff(diffText), opts.only)));
    return;
  }
  const validated = loadStory(/** @type {string} */ (opts.story)); // set: parseArgs requires it outside the dump modes
  const described = withTargetMeta(validated, { fromFile: Boolean(opts.diffFile), describe: () => describeOrExit(opts.target) });
  const allFiles = parseDiff(diffText);
  const files = selectPart(allFiles, opts.only);
  const story = withPartLabel(described, opts.only);

  const report = buildReport(story, files);
  if (report.errors.length) fail(report.errors);
  warn([...report.warnings, ...(story.meta.readerPass ? [] : [NO_READER_PASS])]);

  const coverage = computeCoverage(story, files, report);
  const gate = gateErrors({ story, report, coverage, allFiles, minCoverage: opts.minCoverage });
  if (gate.length) fail(gate);

  const root = safeRepoRoot();
  const outPath = writeReport({ story, report, files, coverage, opts, root });
  if (root) noteIgnored(root, outPath);
  process.stdout.write(`${outPath}\n`);
}

/**
 * util.parseArgs rejects a value that starts with a dash as ambiguous. Yet `--target --staged`,
 * `--out -x.html` and `--context -1` are valid input: the first two are documented and the last
 * must reach our own range check. Each such pair (a string option followed by a value that
 * starts with a dash) is therefore joined into `--name=value` before parsing.
 * @param {string[]} argv
 * @returns {string[]}
 */
function joinDashValues(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (STRING_FLAGS.has(a) && i + 1 < argv.length && argv[i + 1].startsWith('-')) out.push(`${a}=${argv[++i]}`);
    else out.push(a);
  }
  return out;
}

/**
 * Reads the command line without printing anything; the caller reports the error or the warnings.
 * @param {string[]} argv
 * @returns {{ opts: Options, warnings: string[] } | { error: string }}
 */
function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseCli({ args: joinDashValues(argv), options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (e) {
    return { error: messageOf(e).split('\n')[0] };
  }
  /** @type {Options} */
  const opts = {
    story: values.story,
    target: values.target,
    out: values.out,
    context: Number(values.context ?? DEFAULTS.context),
    minCoverage: Number(values['min-coverage'] ?? DEFAULTS.minCoverage),
    only: values.only?.split(',').map((g) => g.trim()).filter(Boolean),
    diffFile: values['diff-file'],
    dumpDiff: values['dump-diff'] ?? false,
    dumpNumbered: values['dump-numbered'] ?? false,
    layout: layoutChoice(values),
  };
  const broken = ARG_RULES.find(([isBad]) => isBad(opts, values));
  if (broken) return { error: broken[1] };
  return { opts, warnings: argWarnings(opts) };
}

/**
 * @param {{ pages?: boolean, single?: boolean }} flags
 * @returns {Options['layout']}
 */
function layoutChoice({ pages, single }) {
  if (pages) return 'pages';
  if (single) return 'single';
  return 'auto';
}

/**
 * @param {Options} opts
 * @returns {string[]}
 */
function argWarnings(opts) {
  if (opts.context === DEFAULTS.context || !prNumber(opts.target ?? '')) return [];
  return ['--context is ignored for PR targets (gh pr diff has no context flag); use <base>...<head> for wider context'];
}

/**
 * Warnings about the arguments print first, before any work that could fail or take long.
 * @param {string[]} argv
 * @returns {Options}
 */
function optionsOrExit(argv) {
  const parsed = parseArgs(argv);
  if ('error' in parsed) return usage(parsed.error);
  warn(parsed.warnings);
  return parsed.opts;
}

/**
 * @param {Options} opts
 * @returns {string} unified diff text
 */
function loadDiffText({ diffFile, target, context }) {
  try {
    return diffFile ? readFileSync(diffFile, 'utf8') : resolveDiff(target, context);
  } catch (e) {
    return fail([diffFile ? `cannot read diff file ${diffFile}: ${messageOf(e)}` : `cannot resolve diff for target ${target ?? '(default)'}: ${firstLine(e)}`]);
  }
}

/**
 * Reads the story and checks it against the contract; any problem ends the run.
 * @param {string} path
 * @returns {Story}
 */
function loadStory(path) {
  const story = readJson(path);
  const errors = validateStory(story);
  if (errors.length) fail(errors);
  return /** @type {Story} */ (story); // validateStory accepted it
}

/**
 * @param {string} path
 * @returns {unknown} whatever JSON the file holds; loadStory checks its shape
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail([`cannot parse story ${path}: ${messageOf(e)}`]);
  }
}

/**
 * @param {string | undefined} target
 * @returns {import('./lib/git.mjs').TargetInfo}
 */
function describeOrExit(target) {
  try {
    return describeTarget(target);
  } catch (e) {
    return fail([`cannot describe target: ${firstLine(e)}`]);
  }
}

/**
 * --only reports one part of a large change; coverage is measured within the part.
 * @param {DiffFile[]} allFiles
 * @param {string[] | undefined} only
 * @returns {DiffFile[]} the files the report covers; never empty
 */
function selectPart(allFiles, only) {
  if (allFiles.length === 0) fail(['diff is empty for this target']);
  if (!only) return allFiles;
  const files = onlyPart(allFiles, only);
  if (files.length === 0) fail([`--only matched no files in this diff: ${only.join(', ')}`]);
  return files;
}

/**
 * @param {Story} story
 * @param {string[] | undefined} only
 * @returns {Story} the story, its target label naming the part when --only narrowed the diff
 */
function withPartLabel(story, only) {
  if (!only) return story;
  const target = [story.meta.target, `only ${only.join(', ')}`].filter(Boolean).join(' · ');
  return { ...story, meta: { ...story.meta, target } };
}

/**
 * @param {DiffFile[]} files
 * @param {string[] | undefined} globs
 * @returns {DiffFile[]}
 */
function onlyPart(files, globs) {
  return globs ? files.filter((f) => globs.some((g) => matchGlob(g, f.path))) : files;
}

/**
 * Writes the report: one file, or a folder of pages.
 * @param {{ story: Story, report: Report, files: DiffFile[], coverage: Coverage, opts: Options, root: string | null }} input
 * @returns {string} path of the written file, or of the index page when paged
 */
function writeReport({ story, report, files, coverage, opts, root }) {
  const paged = isPaged(opts.layout, files);
  const { outDir, outPath } = outputPaths({ out: opts.out, root, title: story.meta.title, paged });
  const pages = renderOrExit({ story, report, files, coverage, paged });
  try {
    mkdirSync(outDir, { recursive: true });
    for (const p of pages) writeFileSync(paged ? join(outDir, p.path) : outPath, p.html);
  } catch (e) {
    fail([`cannot write ${outPath}: ${messageOf(e)}`]);
  }
  return outPath;
}

/**
 * A paged report is a folder named like the requested file, with index.html as its entry page.
 * @param {{ out: string | undefined, root: string | null, title: string, paged: boolean }} where
 * @returns {{ outDir: string, outPath: string }} the folder to create, and the file whose path is printed
 */
function outputPaths({ out, root, title, paged }) {
  const base = resolve(out ?? defaultOut(root, title));
  if (!paged) return { outDir: dirname(base), outPath: base };
  const outDir = base.replace(/\.html?$/i, '');
  return { outDir, outPath: join(outDir, 'index.html') };
}

/**
 * Renders apart from writing, so a bug in rendering is reported as such and not as a failure to write;
 * either way the run ends with one error line, not a stack trace.
 * @param {{ story: Story, report: Report, files: DiffFile[], coverage: Coverage, paged: boolean }} input
 * @returns {import('./lib/html.mjs').Page[]}
 */
function renderOrExit({ story, report, files, coverage, paged }) {
  try {
    return renderPages({ story, report, files, coverage, assets: readAssets(), paged });
  } catch (e) {
    return fail([`cannot render report: ${messageOf(e)}`]);
  }
}

/**
 * Long reports are split into one page per chapter unless --single is given.
 * @param {Options['layout']} layout
 * @param {DiffFile[]} files
 * @returns {boolean}
 */
function isPaged(layout, files) {
  if (layout !== 'auto') return layout === 'pages';
  return files.reduce((rows, f) => rows + lineStats(f).rows, 0) > PAGED_ABOVE_ROWS;
}

/** @returns {{ css: string, js: string }} the stylesheet and page script every report inlines */
function readAssets() {
  return {
    css: readFileSync(new URL('./template/report.css', import.meta.url), 'utf8'),
    js: readFileSync(new URL('./template/report.js', import.meta.url), 'utf8'),
  };
}

/**
 * @param {string} root
 * @param {string} outPath
 */
function noteIgnored(root, outPath) {
  try {
    if (ensureIgnored(root, outPath)) process.stdout.write('note: added reports/review/ to .gitignore\n');
  } catch (e) {
    process.stdout.write(`note: could not update .gitignore: ${messageOf(e)}\n`);
  }
}

/**
 * @param {string} msg
 * @returns {never}
 */
function usage(msg) {
  process.stderr.write(`error: ${msg}\n${USAGE}\n`);
  process.exit(2);
}

/**
 * @param {string[]} errors
 * @returns {never}
 */
function fail(errors) {
  // Lines indented by two spaces continue the previous error (file lists); they carry no prefix.
  for (const e of errors) process.stderr.write(e.startsWith('  ') ? `${e}\n` : `error: ${e}\n`);
  process.exit(1);
}

/** @param {string[]} warnings */
function warn(warnings) {
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
}

/**
 * Asks git itself, so any pattern (.gitignore, info/exclude, global excludes) counts.
 * --no-index answers for a tracked path too. Returns true (ignored), false (not
 * ignored) or null when git could not tell (path behind a symlink, git missing);
 * the caller then leaves .gitignore alone rather than guess.
 * @param {string} root
 * @param {string} path
 * @returns {boolean | null}
 */
function gitIgnores(root, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch (e) {
    return /** @type {ExecError} */ (e).status === 1 ? false : null;
  }
}

/**
 * @param {unknown} e anything a catch block caught
 * @returns {string}
 */
function messageOf(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * git/gh failures carry their stderr in the message; keep the first meaningful line.
 * @param {unknown} e what a failed git or gh call threw
 * @returns {string}
 */
function firstLine(e) {
  const err = /** @type {ExecError} */ (e);
  const text = (err.stderr && String(err.stderr).trim()) || err.message || String(err);
  return text.split('\n').filter(Boolean)[0] ?? 'unknown error';
}

/** @returns {string | null} */
function safeRepoRoot() {
  try { return repoRoot(); } catch { return null; }
}

/**
 * @param {string | null} root
 * @param {string} title
 * @returns {string}
 */
function defaultOut(root, title) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return join(root ?? process.cwd(), 'reports', 'review', `${date}-${slugify(title)}.html`);
}

/**
 * Letters and digits of any script survive, so titles in other languages keep a
 * distinct file name instead of collapsing to "<date>-.html" and overwriting each
 * other; accents are folded (Café → cafe).
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  const slug = title.normalize('NFKD').toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return slug || 'report';
}

/**
 * Reports are local working artifacts. Ignore the folder once, quietly, only
 * when the report actually landed under <root>/reports/review/.
 * @param {string} root
 * @param {string} outPath
 * @returns {boolean} whether the entry was added
 */
function ensureIgnored(root, outPath) {
  const rel = relative(root, outPath).split(sep).join('/');
  if (isAbsolute(rel) || !rel.startsWith('reports/review/')) return false;
  if (gitIgnores(root, outPath) !== false) return false;
  const gi = join(root, '.gitignore');
  const existing = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  // Already listed (e.g. the report itself was force-added): do not append it again.
  if (existing.split(/\r?\n/).some((l) => /^\/?reports\/review\/?$/.test(l.trim()))) return false;
  const prefix = existing.length && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(gi, `${prefix}# review-report output\nreports/review/\n`);
  return true;
}
