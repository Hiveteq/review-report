// @ts-check
// Story contract: validation plus the join between story and parsed diff.
// Pure functions. Errors are collected, never thrown, so the CLI can print all of them.

/** @typedef {import('./diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./diff.mjs').DiffLine} DiffLine */
/** @typedef {import('./diff.mjs').Hunk} Hunk */

// The story as the agent writes it. These types describe a story that validateStory accepted;
// reference/story-schema.md is the contract in prose.

/**
 * A note on one line of a hunk, as the story writes it.
 * @typedef {object} Comment
 * @property {number} line
 * @property {'old' | 'new'} [side] which side's numbering `line` uses; 'new' when left out
 * @property {string} text Markdown
 */

/**
 * A chapter's pick of one file's hunks.
 * @typedef {object} HunkRef
 * @property {string} file
 * @property {'all' | [number, number]} lines a new-side range, inclusive; [start, end] whenever slice is set
 * @property {boolean} [slice] show only `lines` of each hunk instead of the whole hunk
 * @property {string} [covers] for a test file: what it pins and what it leaves untested
 * @property {Comment[]} [comments]
 */

/**
 * A chapter has exactly one of hunks and html.
 * @typedef {{ title: string, intro: string, hunks: HunkRef[], html?: undefined }
 *   | { title: string, intro: string, html: string, hunks?: undefined }} Chapter
 */

/**
 * @typedef {object} ReaderPass
 * @property {number} rounds
 * @property {number} questionsAnswered
 * @property {number} openQuestions
 */

/**
 * @typedef {object} StoryMeta
 * @property {string} title
 * @property {string} [target] how the diff was chosen; render.mjs fills it in when left out
 * @property {string} [base]
 * @property {string} [head]
 * @property {ReaderPass} [readerPass] absent until the reader pass has run
 */

/** @typedef {'bigPicture' | 'why' | 'approach' | 'howToRead'} OverviewPart */

/**
 * @typedef {object} Story
 * @property {StoryMeta} meta
 * @property {Record<OverviewPart, string>} overview Markdown, one entry per part
 * @property {string} [howToTest]
 * @property {{ term: string, meaning: string }[]} [glossary]
 * @property {string[]} [tests] globs naming the project's test files
 * @property {{ glob: string, reason: string }[]} [exclude] files left out of the coverage count, with a reason
 * @property {Chapter[]} chapters
 */

// What buildReport makes of a story and a parsed diff.

/**
 * A story comment after the join: its side is always set.
 * @typedef {object} PlacedComment
 * @property {number} line
 * @property {'old' | 'new'} side
 * @property {string} text
 */

/**
 * One file's hunks as a chapter shows them.
 * @typedef {object} Selection
 * @property {DiffFile} file
 * @property {Hunk[]} hunks whole hunks, or the slices of them the story asked for
 * @property {PlacedComment[]} comments
 * @property {string | null} covers
 * @property {string} at where the hunk ref sits in the story, such as chapters[0].hunks[1]
 */

/** @typedef {{ kind: 'diff', title: string, intro: string, hunks: Selection[] }} DiffChapter */
/** @typedef {{ kind: 'html', title: string, intro: string, html: string }} HtmlChapter */
/** @typedef {DiffChapter | HtmlChapter} ReportChapter */

/**
 * The hunks no chapter showed, per file. A file with no hunks at all (binary, mode-only) is listed too.
 * @typedef {object} AppendixEntry
 * @property {DiffFile} file
 * @property {Hunk[]} hunks
 */

/**
 * @typedef {object} Report
 * @property {ReportChapter[]} chapters
 * @property {AppendixEntry[]} appendix
 * @property {string[]} errors problems that stop the render
 * @property {string[]} warnings likely mistakes, printed but not fatal
 */

/**
 * What one hunk ref adds to the report. buildReport merges these, so no step writes into a shared list.
 * @typedef {object} RefPick
 * @property {Selection | null} selection null when the ref names no file or no hunk of the diff; errors says which
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {Hunk[]} touched the parsed hunks the ref showed any part of, even a slice that came out empty
 * @property {DiffLine[]} shown the parsed line objects the ref showed, never copies of them
 */

/**
 * One check on an object of the story. When isBad holds, the problem is reported as `<path>.<problem>`.
 * @typedef {readonly [isBad: (fields: Record<string, unknown>) => boolean, problem: string]} Rule
 */

/**
 * @param {unknown} v
 * @returns {v is string}
 */
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Any non-null object, arrays included. A check that must refuse arrays says so itself.
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObject = (v) => typeof v === 'object' && v !== null;

/**
 * An object's fields, for reading. A value that is not an object has none, so each of its fields reads as undefined.
 * @param {unknown} v
 * @returns {Record<string, unknown>}
 */
const fieldsOf = (v) => (isObject(v) ? v : {});

/**
 * A single object where a list is expected is a likely slip. Its validator reports that as an
 * error line, and here it reads as an empty list, so walking its items cannot throw a TypeError.
 * @param {unknown} v
 * @returns {unknown[]}
 */
const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * @param {unknown} v
 * @param {number} min
 * @returns {boolean}
 */
const isIntegerAtLeast = (v, min) => typeof v === 'number' && Number.isInteger(v) && v >= min;

/**
 * The problems a list of rules finds in one object of the story, each prefixed with the object's path.
 * @param {ReadonlyArray<Rule>} rules
 * @param {unknown} value
 * @param {string} path
 * @returns {string[]}
 */
function brokenRules(rules, value, path) {
  const fields = fieldsOf(value);
  return rules.filter(([isBad]) => isBad(fields)).map(([, problem]) => `${path}.${problem}`);
}

// Sentence count for the two-sentence rule. Intl.Segmenter knows the sentence
// terminators of every script (。！？ as well as .!?) and does not break after
// abbreviations such as "e.g.", which a punctuation regex gets wrong both ways.
// Newlines are collapsed first because the segmenter treats them as hard breaks.
// A Node built without ICU sentence data falls back to the ASCII heuristic.
const sentences = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;

/**
 * @param {string} text
 * @returns {number}
 */
function sentenceCount(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!sentences) return (flat.match(/[.!?](\s|$)/g) ?? []).length;
  let count = 0;
  for (const { segment } of sentences.segment(flat)) if (/[\p{L}\p{N}]/u.test(segment)) count++;
  return count;
}

/**
 * @param {unknown} lines
 * @returns {boolean}
 */
function validLines(lines) {
  if (lines === 'all') return true;
  return Array.isArray(lines) && lines.length === 2 && lines.every(Number.isInteger) && lines[0] <= lines[1];
}

// The overview is the big picture. Each part is Markdown and each is required.
export const OVERVIEW_PARTS = ['bigPicture', 'why', 'approach', 'howToRead'];
// The parts that describe the shape of the change, where its diagram belongs.
const DIAGRAM_PARTS = ['bigPicture', 'approach'];
const MERMAID_FENCE = /^```mermaid\s*$/m;

/** @type {ReadonlyArray<Rule>} */
const READER_PASS_RULES = Object.freeze([
  [(pass) => !isIntegerAtLeast(pass.rounds, 1), 'rounds must be at least 1'],
  [(pass) => !isIntegerAtLeast(pass.questionsAnswered, 0), 'questionsAnswered must be a non-negative integer'],
  [(pass) => !isIntegerAtLeast(pass.openQuestions, 0), 'openQuestions must be a non-negative integer'],
]);

/** @type {ReadonlyArray<Rule>} */
const GLOSSARY_ENTRY_RULES = Object.freeze([
  [(entry) => !nonEmpty(entry.term), 'term is required'],
  [(entry) => !nonEmpty(entry.meaning), 'meaning is required'],
]);

/** @type {ReadonlyArray<Rule>} */
const EXCLUDE_ENTRY_RULES = Object.freeze([
  [(entry) => !nonEmpty(entry.glob), 'glob is required'],
  [(entry) => !nonEmpty(entry.reason), 'reason is required'],
]);

/** @type {ReadonlyArray<Rule>} */
const CHAPTER_RULES = Object.freeze([
  [(ch) => !nonEmpty(ch.title), 'title is required'],
  [(ch) => !nonEmpty(ch.intro), 'intro is required'],
  [(ch) => nonEmpty(ch.intro) && sentenceCount(ch.intro) < 2, 'intro must have at least two sentences: what this chapter shows, and why it follows the previous one'],
  [(ch) => ch.hunks !== undefined && !Array.isArray(ch.hunks), 'hunks must be an array'],
]);

/** @type {ReadonlyArray<Rule>} */
const HUNK_REF_RULES = Object.freeze([
  [(ref) => !nonEmpty(ref.file), 'file is required'],
  [(ref) => !validLines(ref.lines), 'lines must be "all" or [start, end] integers with start <= end'],
  [(ref) => ref.covers !== undefined && typeof ref.covers !== 'string', 'covers must be text'],
  [(ref) => ref.slice === true && !Array.isArray(ref.lines), 'slice needs lines as [start, end]'],
  [(ref) => ref.comments !== undefined && !Array.isArray(ref.comments), 'comments must be an array'],
]);

/** @type {ReadonlyArray<Rule>} */
const COMMENT_RULES = Object.freeze([
  [(c) => !Number.isInteger(c.line), 'line must be an integer'],
  [(c) => c.side !== undefined && c.side !== 'old' && c.side !== 'new', 'side must be "old" or "new"'],
  [(c) => !nonEmpty(c.text), 'text is required'],
]);

/** @typedef {(value: unknown, path: string) => string[]} Validator */

/**
 * The story's top-level fields with their validators. Problems are listed in this order.
 * @type {ReadonlyArray<readonly [field: string, validate: Validator]>}
 */
const SECTIONS = Object.freeze([
  ['meta', validateMeta],
  ['overview', validateOverview],
  ['howToTest', validateHowToTest],
  ['glossary', validateGlossary],
  ['diagrams', validateLegacyDiagrams],
  ['tests', validateTests],
  ['exclude', validateExclude],
  ['chapters', validateChapters],
]);

/**
 * @param {unknown} story parsed JSON of any shape; checking that shape is this function's job
 * @returns {string[]} every problem found, each with its path in the story; empty when valid
 */
export function validateStory(story) {
  const fields = fieldsOf(story);
  return SECTIONS.flatMap(([field, validate]) => validate(fields[field], field));
}

/** @type {Validator} */
function validateMeta(meta, path) {
  const fields = fieldsOf(meta);
  return [
    ...(nonEmpty(fields.title) ? [] : [`${path}.title is required`]),
    ...validateReaderPass(fields.readerPass, `${path}.readerPass`),
  ];
}

/**
 * Absence is allowed: the pass needs a rendered report to read. render.mjs prints a warning and the header says "not yet run".
 * @type {Validator}
 */
function validateReaderPass(pass, path) {
  if (pass === undefined) return [];
  if (!isObject(pass)) return [`${path} must be { rounds, openQuestions }`];
  return brokenRules(READER_PASS_RULES, pass, path);
}

/** @type {Validator} */
function validateOverview(overview, path) {
  if (!isObject(overview) || Array.isArray(overview)) return [`${path} must be an object with bigPicture, why, approach and howToRead`];
  const missing = OVERVIEW_PARTS.filter((part) => !nonEmpty(overview[part])).map((part) => `${path}.${part} is required`);
  // String() spells out the conversion RegExp.test applies to a part that is not text.
  const hasDiagram = DIAGRAM_PARTS.some((part) => MERMAID_FENCE.test(String(overview[part] ?? '')));
  return hasDiagram ? missing : [...missing, `${path} needs at least one \`\`\`mermaid diagram inside bigPicture or approach`];
}

/** @type {Validator} */
function validateHowToTest(howToTest, path) {
  return howToTest === undefined || typeof howToTest === 'string' ? [] : [`${path} must be a string`];
}

/** @type {Validator} */
function validateGlossary(glossary, path) {
  const shape = glossary === undefined || Array.isArray(glossary) ? [] : [`${path} must be an array of { term, meaning }`];
  return [...shape, ...asArray(glossary).flatMap((entry, i) => brokenRules(GLOSSARY_ENTRY_RULES, entry, `${path}[${i}]`))];
}

/**
 * An earlier story format listed diagrams in a field of their own. Naming their new place
 * is kinder than dropping them without a word.
 * @type {Validator}
 */
function validateLegacyDiagrams(diagrams, path) {
  return diagrams === undefined ? [] : [`${path} is no longer a story field: put \`\`\`mermaid fences inside overview parts or chapter intros`];
}

/**
 * Which files are tests is the story's call: the writer knows the project's stack, the tool does not.
 * @type {Validator}
 */
function validateTests(tests, path) {
  if (tests === undefined || (Array.isArray(tests) && tests.every((glob) => typeof glob === 'string'))) return [];
  return [`${path} must be an array of globs for this project's test files`];
}

/** @type {Validator} */
function validateExclude(exclude, path) {
  const shape = exclude === undefined || Array.isArray(exclude) ? [] : [`${path} must be an array of { glob, reason }`];
  return [...shape, ...asArray(exclude).flatMap((entry, i) => validateExcludeEntry(entry, `${path}[${i}]`))];
}

/** @type {Validator} */
function validateExcludeEntry(entry, path) {
  return isObject(entry) ? brokenRules(EXCLUDE_ENTRY_RULES, entry, path) : [`${path} must be { glob, reason }`];
}

/** @type {Validator} */
function validateChapters(chapters, path) {
  if (!Array.isArray(chapters) || chapters.length === 0) return [`${path} must be a non-empty array`];
  return chapters.flatMap((chapter, i) => validateChapter(chapter, `${path}[${i}]`));
}

/**
 * The hunks-or-html check is about the chapter as a whole, not one of its fields, so its
 * message reads differently from the CHAPTER_RULES ones and it sits outside that table.
 * @type {Validator}
 */
function validateChapter(chapter, path) {
  const fields = fieldsOf(chapter);
  const exactlyOne = Array.isArray(fields.hunks) !== (typeof fields.html === 'string');
  return [
    ...brokenRules(CHAPTER_RULES, fields, path),
    ...(exactlyOne ? [] : [`${path} must have exactly one of hunks or html`]),
    ...asArray(fields.hunks).flatMap((ref, j) => validateHunkRef(ref, `${path}.hunks[${j}]`)),
  ];
}

/** @type {Validator} */
function validateHunkRef(ref, path) {
  return [
    ...brokenRules(HUNK_REF_RULES, ref, path),
    ...asArray(fieldsOf(ref).comments).flatMap((comment, k) => validateComment(comment, `${path}.comments[${k}]`)),
  ];
}

/** @type {Validator} */
function validateComment(comment, path) {
  return brokenRules(COMMENT_RULES, comment, path);
}

/**
 * @param {Story} story a story validateStory accepted
 * @param {DiffFile[]} files
 * @returns {Report}
 */
export function buildReport(story, files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const built = story.chapters.map((chapter, i) => buildChapter(chapter, `chapters[${i}]`, byPath));
  const picks = built.flatMap((b) => b.picks);
  return {
    chapters: built.map((b) => b.chapter),
    appendix: appendixOf(files, new Set(picks.flatMap((p) => p.touched)), new Set(picks.flatMap((p) => p.shown))),
    errors: picks.flatMap((p) => p.errors),
    warnings: picks.flatMap((p) => p.warnings),
  };
}

/**
 * @param {Chapter} chapter
 * @param {string} at where the chapter sits in the story, such as chapters[0]
 * @param {Map<string, DiffFile>} byPath
 * @returns {{ chapter: ReportChapter, picks: RefPick[] }}
 */
function buildChapter(chapter, at, byPath) {
  const { title, intro } = chapter;
  if (typeof chapter.html === 'string') return { chapter: { kind: 'html', title, intro, html: chapter.html }, picks: [] };
  const picks = chapter.hunks.map((ref, j) => selectRef(ref, `${at}.hunks[${j}]`, byPath));
  const hunks = picks.map((p) => p.selection).filter((sel) => sel !== null);
  return { chapter: { kind: 'diff', title, intro, hunks }, picks };
}

/**
 * Joins one hunk ref with the diff.
 * @param {HunkRef} ref
 * @param {string} at where the ref sits in the story, such as chapters[0].hunks[1]
 * @param {Map<string, DiffFile>} byPath
 * @returns {RefPick}
 */
function selectRef(ref, at, byPath) {
  const file = byPath.get(ref.file);
  if (!file) return unresolved(`${at}: file not in diff: ${ref.file}`);
  const picked = file.hunks.filter((h) => ref.lines === 'all' || overlaps(h, ref.lines[0], ref.lines[1]));
  if (picked.length === 0) {
    const range = ref.lines === 'all' ? 'any lines (file has no hunks)' : `new-side lines ${ref.lines[0]}-${ref.lines[1]}`;
    return unresolved(`${at}: no hunk in ${ref.file} overlaps ${range}`);
  }
  const hunks = shownParts(ref, picked);
  const lines = hunks.flatMap((h) => h.lines);
  /** @type {PlacedComment[]} */
  const comments = (ref.comments ?? []).map((c) => ({ line: c.line, side: c.side ?? 'new', text: c.text }));
  const problems = comments.map((comment, k) => commentProblems({ comment, at: `${at}.comments[${k}]`, file: ref.file, lines }));
  return {
    selection: { file, hunks, comments, covers: typeof ref.covers === 'string' ? ref.covers : null, at },
    errors: problems.flatMap((p) => p.errors),
    warnings: problems.flatMap((p) => p.warnings),
    touched: picked,
    shown: lines,
  };
}

/**
 * A ref that points at nothing in the diff: it shows nothing and reports one error.
 * @param {string} error
 * @returns {RefPick}
 */
const unresolved = (error) => ({ selection: null, errors: [error], warnings: [], touched: [], shown: [] });

/**
 * A slice shows only the given new-side range of each hunk, so one new file can be
 * spread over the chapters that explain its parts. Without slice the whole hunk shows.
 * @param {HunkRef} ref
 * @param {Hunk[]} picked the hunks the ref's range overlaps
 * @returns {Hunk[]}
 */
function shownParts(ref, picked) {
  if (!ref.slice) return picked;
  // Read only when slice is true, and validateStory requires lines as [start, end] whenever slice is true.
  const [start, end] = /** @type {[number, number]} */ (ref.lines);
  return picked.map((h) => sliceHunk(h, start, end)).filter((h) => h.lines.length > 0);
}

/**
 * A note on a line the chapter does not show cannot be placed, so that is an error. A note
 * whose named code sits on a nearby line can be placed but is likely off by one: a warning.
 * @param {object} args
 * @param {PlacedComment} args.comment
 * @param {string} args.at where the comment sits in the story, such as chapters[0].hunks[1].comments[2]
 * @param {string} args.file the path the hunk ref names
 * @param {DiffLine[]} args.lines the lines the hunk ref shows
 * @returns {{ errors: string[], warnings: string[] }}
 */
function commentProblems({ comment, at, file, lines }) {
  const { line, side } = comment;
  const present = lines.some((l) => (side === 'new' ? l.new : l.old) === line);
  if (!present) return { errors: [`${at}: ${side} line ${line} is not in the selected hunks of ${file}`], warnings: [] };
  const drift = anchorDrift(comment, lines);
  if (!drift) return { errors: [], warnings: [] };
  return {
    errors: [],
    warnings: [`${at}: ${file} ${side} line ${line} does not contain ${drift.names}; ${side} line ${drift.line} does. Move the note if it is about that line.`],
  };
}

/**
 * Files with no hunks at all (binary, mode-only, pure rename, empty) always
 * appear here so the reader can see they were part of the change.
 * @param {DiffFile[]} files
 * @param {Set<Hunk>} touched every parsed hunk some chapter showed any part of
 * @param {Set<DiffLine>} shownLines every parsed line some chapter showed
 * @returns {AppendixEntry[]}
 */
function appendixOf(files, touched, shownLines) {
  return files
    .map((file) => ({ file, hunks: file.hunks.flatMap((h) => unshownPart(h, touched, shownLines)) }))
    .filter((e) => e.hunks.length > 0 || e.file.hunks.length === 0);
}

/**
 * A hunk no chapter touched goes to the appendix whole. A sliced hunk leaves only its
 * changed lines that no slice showed.
 * @param {Hunk} hunk
 * @param {Set<Hunk>} touched
 * @param {Set<DiffLine>} shownLines
 * @returns {Hunk[]} the hunk, the part of it no chapter showed, or nothing
 */
function unshownPart(hunk, touched, shownLines) {
  if (!touched.has(hunk)) return [hunk];
  const rest = hunk.lines.filter((l) => !shownLines.has(l));
  return rest.some((l) => l.type !== 'ctx') ? [subHunk(hunk, rest)] : [];
}

// Shared /g patterns are safe here only because matchAll copies the pattern and match resets it.
// A .test() or .exec() call would carry lastIndex from one call into the next.
const BACKTICK_SPAN = /`([^`]+)`/g;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

/**
 * Names a note puts in backticks, as plain identifier-like tokens: `value()` gives value,
 * `"Hello "` gives Hello. Markdown backticks are the only convention used, so this
 * works for any language.
 * @param {string} text
 * @returns {string[]} each name once, in the order of first appearance
 */
function namesIn(text) {
  const spans = [...String(text).matchAll(BACKTICK_SPAN)].map(([, span]) => span);
  return [...new Set(spans.flatMap((span) => span.match(IDENTIFIER) ?? []))];
}

/**
 * A note whose named code is missing from its own line but present one or two lines
 * away was most likely anchored off by one. Returns the nearest such line, or null.
 * @param {PlacedComment} comment
 * @param {DiffLine[]} lines
 * @returns {{ line: number, names: string } | null} names: the backticked names found there, joined for a message
 */
function anchorDrift(comment, lines) {
  const names = namesIn(comment.text);
  if (!names.length) return null;
  /**
   * @param {DiffLine} l
   * @returns {number | null}
   */
  const num = (l) => (comment.side === 'new' ? l.new : l.old);
  /**
   * @param {number} n
   * @returns {DiffLine | undefined}
   */
  const at = (n) => lines.find((l) => num(l) === n);
  const anchor = at(comment.line);
  if (!anchor || names.some((t) => anchor.content.includes(t))) return null;
  for (const d of [1, -1, 2, -2]) {
    const near = at(comment.line + d);
    const hits = near ? names.filter((t) => near.content.includes(t)) : [];
    if (hits.length) return { line: comment.line + d, names: hits.map((t) => `\`${t}\``).join(', ') };
  }
  return null;
}

/**
 * The part of a hunk that belongs to new-side lines start..end. A deleted line has no
 * new number; it belongs where it sits, after the last new-side line before it.
 * @param {Hunk} hunk
 * @param {number} start
 * @param {number} end
 * @returns {Hunk}
 */
function sliceHunk(hunk, start, end) {
  /** @type {DiffLine[]} */
  const kept = [];
  // A scan, not a filter: where a deleted line belongs depends on the lines before it.
  let lastNew = hunk.newStart - 1;
  for (const line of hunk.lines) {
    lastNew = line.new ?? lastNew;
    const inSlice = line.new === null ? lastNew >= start - 1 && lastNew < end : line.new >= start && line.new <= end;
    // The parsed line object itself, never a copy: coverage finds shown lines by identity.
    if (inSlice) kept.push(line);
  }
  return subHunk(hunk, kept);
}

/**
 * A hunk made of some of another hunk's lines, numbered from its first line.
 * @param {Hunk} hunk
 * @param {DiffLine[]} lines
 * @returns {Hunk}
 */
function subHunk(hunk, lines) {
  const firstOld = lines.find((l) => l.old !== null);
  const firstNew = lines.find((l) => l.new !== null);
  return {
    oldStart: firstOld ? firstOld.old : hunk.oldStart,
    newStart: firstNew ? firstNew.new : hunk.newStart,
    header: hunk.header,
    lines,
    sliceOf: hunk,
  };
}

/**
 * New-side overlap. A hunk that only deletes (no context) has no new-side
 * numbers; git's newStart then points at the line before the deletion.
 * @param {Hunk} hunk
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function overlaps(hunk, start, end) {
  const news = hunk.lines.map((l) => l.new).filter((n) => n !== null);
  if (news.length === 0) return hunk.newStart >= start - 1 && hunk.newStart <= end;
  return news[0] <= end && news[news.length - 1] >= start;
}

/**
 * Fills target, base and head where the story left them out. `describe` is asked only when one is missing
 * and the diff came from git or gh: for a PR target, describing it is a network round-trip. A diff read
 * from a file has no target to describe, so its gaps stay empty.
 * @param {Story} story a story validateStory accepted; it is not changed
 * @param {{ fromFile: boolean, describe: () => import('./git.mjs').TargetInfo }} source where the diff came from
 * @returns {Story} the same story when nothing is filled in, otherwise a copy with the filled meta
 */
export function withTargetMeta(story, { fromFile, describe }) {
  const { meta } = story;
  if (fromFile || [meta.target, meta.base, meta.head].every((v) => v != null)) return story;
  const t = describe();
  return { ...story, meta: { ...meta, target: meta.target ?? t.label, base: meta.base ?? t.base, head: meta.head ?? t.head } };
}
