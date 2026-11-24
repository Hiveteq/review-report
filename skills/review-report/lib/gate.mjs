// @ts-check
// The gate: rules a story must meet before its report is written. Each rule reads the story, the report
// built from it and the coverage of that report, and returns the problems it found as error lines.
// No I/O here; render.mjs prints the lines and stops the run when there are any.
import { matchGlob } from './coverage.mjs';

/** @typedef {import('./diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./story.mjs').Story} Story */
/** @typedef {import('./story.mjs').Report} Report */
/** @typedef {import('./coverage.mjs').Coverage} Coverage */

/**
 * @typedef {object} GateInput
 * @property {Story} story
 * @property {Report} report
 * @property {Coverage} coverage
 * @property {DiffFile[]} allFiles every file in the diff, before --only narrows it
 * @property {number} minCoverage percent, 0..100
 */

/** Limits the gate enforces. */
export const LIMITS = Object.freeze({ maxChapterLines: 1000, uncoveredListed: 40 });

/**
 * Every reason the report must not be written, in the order a reader should fix them.
 * @param {GateInput} input
 * @returns {string[]}
 */
export function gateErrors(input) {
  return [
    ...testFileRules(input),
    ...oversizedChapters(input),
    ...deadExcludeGlobs(input),
    ...coverageBelowMinimum(input),
  ];
}

/**
 * Test files are named by the story, never guessed. Each one shown needs a "covers" statement:
 * what it pins and what it leaves untested, the question a reviewer asks of a test.
 * @param {GateInput} input
 * @returns {string[]}
 */
function testFileRules({ story, report }) {
  const globs = story.tests;
  if (!Array.isArray(globs)) return ["tests is required: globs matching this project's test files, [] if the change has none"];
  const shown = report.chapters
    .flatMap((ch) => (ch.kind === 'diff' ? ch.hunks : []))
    .flatMap((sel) => {
      const glob = globs.find((g) => matchGlob(g, sel.file.path));
      return glob ? [{ sel, glob }] : [];
    });
  // One statement anywhere is enough for a file shown in several places; the error points at its first one.
  const covered = new Set(shown.filter(({ sel }) => sel.covers?.trim()).map(({ sel }) => sel.file.path));
  return [...Map.groupBy(shown, ({ sel }) => sel.file.path).values()]
    .map(([first]) => first)
    .filter(({ sel }) => !covered.has(sel.file.path))
    .map(({ sel, glob }) => `${sel.at}: ${sel.file.path} is a test file (matches ${glob}); add "covers": what it pins and what it leaves untested`);
}

/**
 * @param {GateInput} input
 * @returns {string[]}
 */
function oversizedChapters({ coverage }) {
  const max = LIMITS.maxChapterLines;
  return coverage.chapterSizes
    .filter((ch) => ch.changed > max)
    .map((ch) => `chapters[${ch.index}] "${ch.title}" shows ${ch.changed} changed lines; split it into chapters of one idea each (at most ${max} lines)`);
}

/**
 * An exclude glob may target files outside the current --only part; only globs matching nothing at all are errors.
 * @param {GateInput} input
 * @returns {string[]}
 */
function deadExcludeGlobs({ coverage, allFiles }) {
  return coverage.unmatched
    .filter((g) => !allFiles.some((f) => matchGlob(g, f.path)))
    .map((g) => `exclude glob matches no file in this diff: ${g}`);
}

/**
 * Lines indented by two spaces continue the error above them; the CLI prints them without a prefix.
 * @param {GateInput} input
 * @returns {string[]}
 */
function coverageBelowMinimum({ coverage, minCoverage }) {
  const pct = Math.round(coverage.ratio * 100);
  if (pct >= minCoverage) return [];
  const { uncovered } = coverage;
  const rest = uncovered.length - LIMITS.uncoveredListed;
  return [
    `coverage ${pct}% of changed lines shown in chapters; minimum is ${minCoverage}%. Not shown, largest first:`,
    ...uncovered.slice(0, LIMITS.uncoveredListed).map((f) => `  ${f.path} +${f.adds} -${f.dels} (${f.missing} not shown)`),
    ...(rest > 0 ? [`  … and ${rest} more files`] : []),
    '  add chapters for these files, or exclude them in the story with a reason (generated, vendored, docs, fixtures)',
  ];
}
