#!/usr/bin/env node
// @ts-check
// review-report renderer. Story JSON + diff target → one self-contained HTML file.
// Usage:
//   node render.mjs --story <path> [--target <spec>] [--out <path>] [--context N] [--min-coverage PCT] [--only <glob,...>] [--pages|--single] [--diff-file <path>]
//   node render.mjs --dump-diff [--target <spec>] [--context N] [--diff-file <path>]
//   node render.mjs --dump-numbered [--target <spec>] [--context N] [--diff-file <path>]
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs as parseCli } from 'node:util';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { parseDiff, formatNumbered } from './lib/diff.mjs';
import { resolveDiff, describeTarget, repoRoot, prNumber } from './lib/git.mjs';
import { validateStory, buildReport } from './lib/story.mjs';
import { renderPages } from './lib/html.mjs';
import { computeCoverage, matchGlob } from './lib/coverage.mjs';

/** @typedef {import('./lib/coverage.mjs').CountedFile} CountedFile */
/** @typedef {import('./lib/diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./lib/git.mjs').ExecError} ExecError */
/** @typedef {import('./lib/story.mjs').Story} Story */

const USAGE = 'usage: node render.mjs --story <path> [--target <spec>] [--out <path>] [--context N] [--diff-file <path>]\n' +
  '       node render.mjs --dump-diff [--target <spec>] [--context N] [--diff-file <path>]\n' +
  '       node render.mjs --dump-numbered [--target <spec>] [--context N] [--diff-file <path>]';

// Declared before main() runs below: a const is not usable until its line has executed.
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

// Fail clearly on an old Node instead of with an obscure error further in.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  process.stderr.write(`error: review-report needs Node 22 or newer; this is Node ${process.versions.node}\n`);
  process.exit(2);
}

main(parseArgs(process.argv.slice(2)));

// util.parseArgs rejects a value that starts with a dash as ambiguous. Yet `--target --staged`,
// `--out -x.html` and `--context -1` are valid input: the first two are documented and the last
// must reach our own range check. Each such pair (a string option followed by a value that
// starts with a dash) is therefore joined into `--name=value` before parsing.

/**
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
 * @param {string[]} argv
 * @returns {{ story?: string, target?: string, out?: string, context: number, minCoverage: number,
 *   only?: string[], diffFile?: string, dumpDiff: boolean, dumpNumbered: boolean, pages?: boolean }}
 */
function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseCli({ args: joinDashValues(argv), options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (e) {
    return usage(/** @type {Error} */ (e).message.split('\n')[0]);
  }
  if (values.pages && values.single) usage('--pages and --single cannot be used together');
  const opts = {
    story: values.story,
    target: values.target,
    out: values.out,
    context: values.context === undefined ? 3 : Number(values.context),
    minCoverage: values['min-coverage'] === undefined ? 80 : Number(values['min-coverage']),
    only: values.only?.split(',').map((g) => g.trim()).filter(Boolean),
    diffFile: values['diff-file'],
    dumpDiff: values['dump-diff'] ?? false,
    dumpNumbered: values['dump-numbered'] ?? false,
    pages: values.pages ? true : values.single ? false : undefined,
  };
  if (!opts.dumpDiff && !opts.dumpNumbered && !opts.story) usage('--story is required');
  if (!Number.isInteger(opts.context) || opts.context < 0) usage('--context must be a non-negative integer');
  if (!(opts.minCoverage >= 0 && opts.minCoverage <= 100)) usage('--min-coverage must be 0..100');
  if (opts.context !== 3 && prNumber(opts.target ?? '')) process.stderr.write('warning: --context is ignored for PR targets (gh pr diff has no context flag); use <base>...<head> for wider context\n');
  return opts;
}

/**
 * @param {string} msg
 * @returns {never}
 */
function usage(msg) {
  process.stderr.write(`error: ${msg}\n${USAGE}\n`);
  process.exit(2);
}

/** @param {ReturnType<typeof parseArgs>} opts */
function main(opts) {
  let diffText;
  try {
    diffText = opts.diffFile ? readFileSync(opts.diffFile, 'utf8') : resolveDiff(opts.target, opts.context);
  } catch (e) {
    fail([opts.diffFile ? `cannot read diff file ${opts.diffFile}: ${/** @type {Error} */ (e).message}` : `cannot resolve diff for target ${opts.target ?? '(default)'}: ${firstLine(e)}`]);
  }
  if (opts.dumpDiff) {
    process.stdout.write(diffText);
    return;
  }
  if (opts.dumpNumbered) {
    process.stdout.write(formatNumbered(onlyPart(parseDiff(diffText), opts.only)));
    return;
  }

  // Typed as a Story from here on: validateStory below stops the run when it is not one.
  /** @type {Story} */
  let story;
  try {
    story = JSON.parse(readFileSync(/** @type {string} */ (opts.story), 'utf8')); // set: parseArgs requires it outside the dump modes
  } catch (e) {
    fail([`cannot parse story ${opts.story}: ${/** @type {Error} */ (e).message}`]);
  }
  const errors = validateStory(story);
  if (errors.length) fail(errors);

  // Only ask git/gh about the target when the story leaves a meta field to fill;
  // for a PR target this is a network round-trip.
  if (!opts.diffFile && [story.meta.target, story.meta.base, story.meta.head].some((v) => v == null)) {
    let t;
    try { t = describeTarget(opts.target); } catch (e) { fail([`cannot describe target: ${firstLine(e)}`]); }
    story.meta.target ??= t.label;
    story.meta.base ??= t.base;
    story.meta.head ??= t.head;
  }

  const allFiles = parseDiff(diffText);
  let files = allFiles;
  if (files.length === 0) fail(['diff is empty for this target']);
  // --only reports one part of a large change; coverage is measured within the part.
  if (opts.only) {
    files = onlyPart(files, opts.only);
    if (files.length === 0) fail([`--only matched no files in this diff: ${opts.only.join(', ')}`]);
    story.meta.target = `${story.meta.target ?? ''} · only ${opts.only.join(', ')}`.replace(/^ · /, '');
  }
  const report = buildReport(story, files);
  if (report.errors.length) fail(report.errors);
  for (const w of report.warnings ?? []) process.stderr.write(`warning: ${w}\n`);

  const cov = computeCoverage(story, files, report);
  const gate = [];
  // The pass needs a rendered report to read, so its absence is a visible header line, not a refusal.
  if (!story.meta.readerPass) process.stderr.write('warning: reader pass not recorded; the header says so. Run it and render again (reference/reader-pass.md)\n');
  // Test files are named by the story, never guessed. Each one shown needs a "covers" statement:
  // what it pins and what it leaves untested, the question a reviewer asks of a test.
  if (!Array.isArray(story.tests)) {
    gate.push("tests is required: globs matching this project's test files, [] if the change has none");
  } else {
    const coveredTests = new Map();
    for (const ch of report.chapters) {
      if (ch.kind !== 'diff') continue;
      for (const sel of ch.hunks) {
        const glob = story.tests.find((g) => matchGlob(g, sel.file.path));
        if (!glob) continue;
        const entry = coveredTests.get(sel.file.path) ?? { at: sel.at, glob, covered: false };
        entry.covered = entry.covered || Boolean(sel.covers && sel.covers.trim());
        coveredTests.set(sel.file.path, entry);
      }
    }
    for (const [path, e] of coveredTests) {
      if (!e.covered) gate.push(`${e.at}: ${path} is a test file (matches ${e.glob}); add "covers": what it pins and what it leaves untested`);
    }
  }
  const MAX_CHAPTER = 1000;
  for (const ch of cov.chapterSizes) {
    if (ch.changed > MAX_CHAPTER) gate.push(`chapters[${ch.index}] "${ch.title}" shows ${ch.changed} changed lines; split it into chapters of one idea each (at most ${MAX_CHAPTER} lines)`);
  }
  // An exclude glob may target files outside the current --only part; only globs matching nothing at all are errors.
  for (const g of cov.unmatched) if (!allFiles.some((f) => matchGlob(g, f.path))) gate.push(`exclude glob matches no file in this diff: ${g}`);
  const pct = Math.round(cov.ratio * 100);
  if (pct < opts.minCoverage) {
    gate.push(`coverage ${pct}% of changed lines shown in chapters; minimum is ${opts.minCoverage}%. Not shown, largest first:`);
    for (const f of cov.uncovered.slice(0, 40)) {
      // Every uncovered file comes from counted, so find always succeeds.
      const c = /** @type {CountedFile} */ (cov.counted.find((x) => x.path === f.path));
      gate.push(`  ${f.path} +${c.adds} -${c.dels} (${f.missing} not shown)`);
    }
    if (cov.uncovered.length > 40) gate.push(`  … and ${cov.uncovered.length - 40} more files`);
    gate.push('  add chapters for these files, or exclude them in the story with a reason (generated, vendored, docs, fixtures)');
  }
  if (gate.length) fail(gate);

  const root = safeRepoRoot();
  // Long reports are split into one page per chapter unless --single is given.
  const diffRows = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  const paged = opts.pages ?? diffRows > 1500;
  const base = resolve(opts.out ?? defaultOut(root, story.meta.title));
  const outDir = paged ? base.replace(/\.html?$/i, '') : dirname(base);
  const outPath = paged ? join(outDir, 'index.html') : base;
  const css = readFileSync(new URL('./template/report.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('./template/report.js', import.meta.url), 'utf8');
  try {
    mkdirSync(outDir, { recursive: true });
    for (const p of renderPages(story, report, files, { css, js }, { paged })) writeFileSync(paged ? join(outDir, p.path) : outPath, p.html);
  } catch (e) {
    fail([`cannot write ${outPath}: ${/** @type {Error} */ (e).message}`]);
  }
  if (root) {
    try { ensureIgnored(root, outPath); } catch (e) { process.stdout.write(`note: could not update .gitignore: ${/** @type {Error} */ (e).message}\n`); }
  }
  process.stdout.write(`${outPath}\n`);
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
 * @param {string[]} errors
 * @returns {never}
 */
function fail(errors) {
  // Lines indented by two spaces continue the previous error (file lists); they carry no prefix.
  for (const e of errors) process.stderr.write(e.startsWith('  ') ? `${e}\n` : `error: ${e}\n`);
  process.exit(1);
}

// Asks git itself, so any pattern (.gitignore, info/exclude, global excludes) counts.
// --no-index answers for a tracked path too. Returns true (ignored), false (not
// ignored) or null when git could not tell (path behind a symlink, git missing);
// the caller then leaves .gitignore alone rather than guess.
/**
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

// git/gh failures carry their stderr in the message; keep the first meaningful line.
/**
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

// Letters and digits of any script survive, so titles in other languages keep a
// distinct file name instead of collapsing to "<date>-.html" and overwriting each
// other; accents are folded (Café → cafe).
/**
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

// Reports are local working artifacts. Ignore the folder once, quietly, only
// when the report actually landed under <root>/reports/review/.
/**
 * @param {string} root
 * @param {string} outPath
 */
function ensureIgnored(root, outPath) {
  const rel = relative(root, outPath).split(sep).join('/');
  if (isAbsolute(rel) || !rel.startsWith('reports/review/')) return;
  if (gitIgnores(root, outPath) !== false) return;
  const gi = join(root, '.gitignore');
  const existing = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  // Already listed (e.g. the report itself was force-added): do not append it again.
  if (existing.split(/\r?\n/).some((l) => /^\/?reports\/review\/?$/.test(l.trim()))) return;
  const prefix = existing.length && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(gi, `${prefix}# review-report output\nreports/review/\n`);
  process.stdout.write('note: added reports/review/ to .gitignore\n');
}
