// @ts-check
// The gate: rules a story must meet before its report is written. Each rule reads the story, the report
// built from it and the coverage of that report, and returns the problems it found as error lines.
// No I/O here; render.mjs prints the lines and stops the run when there are any.
import { firstBy } from './collections.mjs';
import { matchGlob } from './coverage.mjs';

/** @typedef {import('./diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./story.mjs').Story} Story */
/** @typedef {import('./story.mjs').Report} Report */
/** @typedef {import('./story.mjs').Selection} Selection */
/** @typedef {import('./coverage.mjs').Coverage} Coverage */
/** @typedef {import('./coverage.mjs').CountedFile} CountedFile */

/**
 * @typedef {object} GateInput
 * @property {Story} story
 * @property {Report} report
 * @property {Coverage} coverage
 * @property {DiffFile[]} allFiles every file in the diff, before --only narrows it
 * @property {number} minCoverage percent, 0..100
 */

/** @typedef {(input: GateInput) => string[]} GateRule */

/** Limits the gate enforces. */
export const LIMITS = Object.freeze({ maxChapterLines: 1000, uncoveredListed: 40 });

/**
 * Every reason the report must not be written, in the order a reader should fix them.
 * @param {GateInput} input
 * @returns {string[]}
 */
export function gateErrors(input) {
  return GATE_RULES.flatMap((rule) => rule(input));
}

/**
 * Test files are named by the story, never guessed. Each one shown needs a "covers" statement:
 * what it pins and what it leaves untested, the question a reviewer asks of a test.
 * @type {GateRule}
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
  const covered = new Set(shown.filter(({ sel }) => hasCovers(sel)).map(({ sel }) => sel.file.path));
  return [...firstBy(shown, ({ sel }) => sel.file.path).values()]
    .filter(({ sel }) => !covered.has(sel.file.path))
    .map(({ sel, glob }) => `${sel.at}: ${sel.file.path} is a test file (matches ${glob}); add "covers": what it pins and what it leaves untested`);
}

/** @type {GateRule} */
function oversizedChapters({ coverage }) {
  const max = LIMITS.maxChapterLines;
  return coverage.chapterSizes
    .filter((ch) => ch.changed > max)
    .map((ch) => `chapters[${ch.index}] "${ch.title}" shows ${ch.changed} changed lines; split it into chapters of one idea each (at most ${max} lines)`);
}

/**
 * An exclude glob may target files outside the current --only part; only globs matching nothing at all are errors.
 * @type {GateRule}
 */
function deadExcludeGlobs({ coverage, allFiles }) {
  return coverage.unmatched
    .filter((g) => !allFiles.some((f) => matchGlob(g, f.path)))
    .map((g) => `exclude glob matches no file in this diff: ${g}`);
}

/**
 * Lines indented by two spaces continue the error above them; the CLI prints them without a prefix.
 * @type {GateRule}
 */
function coverageBelowMinimum({ coverage, minCoverage }) {
  const pct = Math.round(coverage.ratio * 100);
  if (pct >= minCoverage) return [];
  const { uncovered } = coverage;
  const rest = uncovered.length - LIMITS.uncoveredListed;
  return [
    `coverage ${pct}% of changed lines shown in chapters; minimum is ${minCoverage}%. Not shown, largest first:`,
    ...uncovered.slice(0, LIMITS.uncoveredListed).map(uncoveredLine),
    ...(rest > 0 ? [`  … and ${rest} more files`] : []),
    '  add chapters for these files, or exclude them in the story with a reason (generated, vendored, docs, fixtures)',
  ];
}

/**
 * In the order a reader should fix them. The rule functions are hoisted; this array is not, which is fine
 * because gateErrors first reads it after the module has finished loading.
 */
const GATE_RULES = Object.freeze([testFileRules, oversizedChapters, deadExcludeGlobs, coverageBelowMinimum]);

/**
 * @param {Selection} sel
 * @returns {boolean}
 */
function hasCovers(sel) {
  return Boolean(sel.covers?.trim());
}

/**
 * @param {CountedFile} f
 * @returns {string}
 */
function uncoveredLine(f) {
  return `  ${f.path} +${f.adds} -${f.dels} (${f.missing} not shown)`;
}
