// @ts-check
// Coverage: how much of the change the chapters actually explain.
// The tool counts; the story classifies. Only exclusions that are universal
// by nature are built in (binaries, lockfiles, minified/source-map files,
// generated/vendored/build output paths). Everything else counts unless the
// story excludes it with a glob and a reason, and those reasons are shown in
// the report so the reviewer can judge them.

import { lineStats } from './diff.mjs';

/** @typedef {import('./diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./story.mjs').Story} Story */
/** @typedef {import('./story.mjs').Report} Report */
/** @typedef {import('./story.mjs').ReportChapter} ReportChapter */
/** @typedef {NonNullable<Story['exclude']>[number]} StoryExclude */

/**
 * A file the count includes. changed counts added plus deleted lines.
 * @typedef {object} CountedFile
 * @property {string} path
 * @property {number} changed
 * @property {number} explained changed lines some chapter shows
 * @property {number} missing changed lines no chapter shows
 * @property {number} adds
 * @property {number} dels
 */

/**
 * A file the count leaves out, and why.
 * @typedef {object} ExcludedFile
 * @property {string} path
 * @property {string} reason
 */

/**
 * @typedef {object} Coverage
 * @property {number} total changed lines in counted files
 * @property {number} explained of those, the lines some chapter shows
 * @property {number} ratio explained / total; 1 when nothing counts
 * @property {CountedFile[]} counted
 * @property {CountedFile[]} uncovered counted files with lines no chapter shows, most missing first
 *   (the same objects as in `counted`; callers only read them)
 * @property {ExcludedFile[]} excluded
 * @property {{ index: number, title: string, changed: number }[]} chapterSizes
 * @property {string[]} unmatched story exclude globs that excluded no file: a glob whose files an earlier glob
 *   already claimed, or that matches only files with no changed lines, is listed too
 */

export const DEFAULT_EXCLUDES = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/Cargo.lock', '**/go.sum', '**/composer.lock',
  '**/Gemfile.lock', '**/poetry.lock', '**/Pipfile.lock', '**/*.lock',
  '**/*.min.*', '**/*.map',
  '**/generated/**', '**/__generated__/**', '**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**',
  '**/.openapi-generator/**',
];
const DEFAULT_REASON = 'lockfile, generated, vendored or build output';

/** Compiled glob patterns. Coverage tests every file against the same few globs, so each is compiled once. */
/** @type {Map<string, RegExp>} */
const globCache = new Map();

// Minimal glob: `**/` matches zero or more directories, `**` anything, `*` within a segment, `?` one char.
/**
 * @param {string} glob
 * @param {string} path
 * @returns {boolean}
 */
export function matchGlob(glob, path) {
  const regex = globCache.get(glob) ?? compileGlob(glob);
  globCache.set(glob, regex);
  return regex.test(path);
}

/**
 * @param {string} glob
 * @returns {RegExp}
 */
function compileGlob(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    switch (ch) {
      case '*':
        if (glob[i + 1] !== '*') re += '[^/]*';
        else if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } // `**/` also matches no folder at all
        else { re += '.*'; i += 1; }
        break;
      case '?':
        re += '[^/]';
        break;
      default:
        re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Why the count leaves a file out, or undefined when it counts. The story goes first, so its reason wins over
 * the built-in ones. `glob` is set only for a story exclusion, so the gate can tell which story globs did something.
 * @param {DiffFile} file
 * @param {StoryExclude[]} storyExcludes
 * @returns {{ reason: string, glob?: string } | undefined}
 */
function exclusionOf(file, storyExcludes) {
  const rule = storyExcludes.find((e) => matchGlob(e.glob, file.path));
  if (rule) return { reason: rule.reason, glob: rule.glob };
  if (file.binary) return { reason: 'binary' };
  if (DEFAULT_EXCLUDES.some((g) => matchGlob(g, file.path))) return { reason: DEFAULT_REASON };
  return undefined;
}

/**
 * The changed lines a chapter shows; a prose-only chapter shows none.
 * @param {ReportChapter} chapter
 * @returns {number}
 */
function changedLinesShown(chapter) {
  if (chapter.kind !== 'diff') return 0;
  return chapter.hunks.flatMap((sel) => sel.hunks).flatMap((h) => h.lines).filter((l) => l.type !== 'ctx').length;
}

/**
 * The story must already have passed `validateStory`; its exclude entries are not checked again here.
 * @param {Story} story
 * @param {DiffFile[]} files
 * @param {Report} report
 * @returns {Coverage}
 */
export function computeCoverage(story, files, report) {
  const storyExcludes = story.exclude ?? [];
  /** @type {CountedFile[]} */
  const counted = [];
  /** @type {ExcludedFile[]} */
  const excluded = [];
  /** @type {Set<string>} story globs that excluded at least one file */
  const usedGlobs = new Set();
  for (const file of files) {
    const { adds, dels } = lineStats(file);
    const changed = adds + dels;
    // Mode-only changes and pure renames have nothing to explain. A binary file has no lines but still changed.
    if (changed === 0 && !file.binary) continue;
    const exclusion = exclusionOf(file, storyExcludes);
    if (exclusion) {
      excluded.push({ path: file.path, reason: exclusion.reason });
      if (exclusion.glob) usedGlobs.add(exclusion.glob);
      continue;
    }
    // Line objects, not hunks: a sliced selection shows only part of a hunk.
    const explained = file.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'ctx' && report.shownLines.has(l)).length;
    counted.push({ path: file.path, changed, explained, missing: changed - explained, adds, dels });
  }

  const total = counted.reduce((n, f) => n + f.changed, 0);
  const explained = counted.reduce((n, f) => n + f.explained, 0);
  return {
    total, explained, ratio: total === 0 ? 1 : explained / total,
    counted,
    uncovered: counted.filter((f) => f.missing > 0).sort((a, b) => b.missing - a.missing),
    excluded,
    // Changed lines per chapter, so the CLI can refuse a chapter too long to read as one page.
    chapterSizes: report.chapters.map((ch, i) => ({ index: i, title: ch.title, changed: changedLinesShown(ch) })),
    unmatched: storyExcludes.map((e) => e.glob).filter((g) => !usedGlobs.has(g)),
  };
}
