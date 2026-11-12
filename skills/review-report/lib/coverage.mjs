// @ts-check
// Coverage: how much of the change the chapters actually explain.
// The tool counts; the story classifies. Only exclusions that are universal
// by nature are built in (binaries, lockfiles, minified/source-map files,
// generated/vendored/build output paths). Everything else counts unless the
// story excludes it with a glob and a reason, and those reasons are shown in
// the report so the reviewer can judge them.

import { lineStats } from './diff.mjs';

/** @typedef {import('./diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./diff.mjs').Hunk} Hunk */
/** @typedef {import('./diff.mjs').DiffLine} DiffLine */
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
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {Hunk} hunk
 * @returns {number} the hunk's added and deleted lines
 */
const changedIn = (hunk) => hunk.lines.filter((l) => l.type !== 'ctx').length;

/**
 * Why a rule leaves a file out of the count. `glob` is set only for a story exclusion, so the gate can tell
 * which story globs did something.
 * @typedef {{ reason: string, glob?: string }} Exclusion
 */

/** @typedef {(file: DiffFile, storyExcludes: StoryExclude[]) => Exclusion | undefined} ExcludeRule */

/** @type {ExcludeRule} */
const storyRule = (file, storyExcludes) => {
  const rule = storyExcludes.find((e) => matchGlob(e.glob, file.path));
  return rule && { reason: rule.reason, glob: rule.glob };
};

/** @type {ExcludeRule} */
const binaryRule = (file) => (file.binary ? { reason: 'binary' } : undefined);

/** @type {ExcludeRule} */
const defaultRule = (file) => (DEFAULT_EXCLUDES.some((g) => matchGlob(g, file.path)) ? { reason: DEFAULT_REASON } : undefined);

/**
 * Tried in order; the first rule that answers decides. The story goes first so its reason wins over the
 * built-in ones, and a story glob counts as used only where it was that first answer.
 */
const EXCLUDE_RULES = Object.freeze([storyRule, binaryRule, defaultRule]);

/**
 * The answer of the first rule that excludes the file, if any.
 * @param {DiffFile} file
 * @param {StoryExclude[]} storyExcludes
 * @returns {Exclusion | undefined}
 */
function firstExclusion(file, storyExcludes) {
  // A loop, not map + find: later rules must not run once one has answered (the default rule tries every default glob).
  for (const rule of EXCLUDE_RULES) {
    const exclusion = rule(file, storyExcludes);
    if (exclusion) return exclusion;
  }
  return undefined;
}

/**
 * How the count treats one changed file.
 * @typedef {{ kind: 'skipped' }
 *   | { kind: 'excluded', file: ExcludedFile, glob?: string }
 *   | { kind: 'counted', file: CountedFile }} Classification
 */

/**
 * @param {DiffFile} file
 * @param {StoryExclude[]} storyExcludes
 * @param {Set<DiffLine>} shown the line objects some chapter shows
 * @returns {Classification}
 */
function classify(file, storyExcludes, shown) {
  const { adds, dels } = lineStats(file);
  const changed = adds + dels;
  // Mode-only changes and pure renames have nothing to explain. A binary file has no lines but still changed.
  if (changed === 0 && !file.binary) return { kind: 'skipped' };
  const exclusion = firstExclusion(file, storyExcludes);
  if (exclusion) return { kind: 'excluded', file: { path: file.path, reason: exclusion.reason }, glob: exclusion.glob };
  const explained = file.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'ctx' && shown.has(l)).length;
  return { kind: 'counted', file: { path: file.path, changed, explained, missing: changed - explained, adds, dels } };
}

/**
 * The hunks a chapter shows; a prose-only chapter shows none.
 * @param {ReportChapter} chapter
 * @returns {Hunk[]}
 */
const shownHunks = (chapter) => (chapter.kind === 'diff' ? chapter.hunks.flatMap((sel) => sel.hunks) : []);

/**
 * The story must already have passed `validateStory`; its exclude entries are not checked again here.
 * @param {Story} story
 * @param {DiffFile[]} files
 * @param {Report} report
 * @returns {Coverage}
 */
export function computeCoverage(story, files, report) {
  const storyExcludes = story.exclude ?? [];
  // Line objects, not hunks: a sliced selection shows only part of a hunk.
  const shown = new Set(report.chapters.flatMap(shownHunks).flatMap((h) => h.lines));
  const classified = files.map((file) => classify(file, storyExcludes, shown));

  const counted = classified.flatMap((c) => (c.kind === 'counted' ? [c.file] : []));
  const excluded = classified.flatMap((c) => (c.kind === 'excluded' ? [c.file] : []));
  const usedGlobs = new Set(classified.flatMap((c) => (c.kind === 'excluded' && c.glob ? [c.glob] : [])));

  const total = counted.reduce((n, f) => n + f.changed, 0);
  const explained = counted.reduce((n, f) => n + f.explained, 0);

  // Changed lines per chapter, so the CLI can refuse a chapter too long to read as one page.
  const chapterSizes = report.chapters.map((ch, i) => ({
    index: i, title: ch.title, changed: shownHunks(ch).reduce((n, h) => n + changedIn(h), 0),
  }));

  return {
    total, explained, ratio: total === 0 ? 1 : explained / total,
    counted,
    uncovered: counted.filter((f) => f.missing > 0).sort((a, b) => b.missing - a.missing),
    excluded, chapterSizes,
    unmatched: storyExcludes.map((e) => e.glob).filter((g) => !usedGlobs.has(g)),
  };
}
