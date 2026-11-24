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
 * @property {Set<DiffLine>} shownLines every parsed line object some chapter shows, for the coverage count
 */

/**
 * Collects the problems buildReport finds while it walks the story's hunk refs, into lists buildReport owns.
 * Calls arrive in walk order, so the messages keep the order of the story.
 * @typedef {object} Problems
 * @property {(message: string) => void} error a problem that stops the render
 * @property {(message: string) => void} warning a likely mistake, printed but not fatal
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
 * A single object where a list is expected is a likely slip. Its check reports that as an
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
const OVERVIEW_PARTS = ['bigPicture', 'why', 'approach', 'howToRead'];
// The parts that describe the shape of the change, where its diagram belongs.
const DIAGRAM_PARTS = ['bigPicture', 'approach'];
const MERMAID_FENCE = /^```mermaid\s*$/m;

/**
 * @param {unknown} story parsed JSON of any shape; checking that shape is this function's job
 * @returns {string[]} every problem found, each with its path in the story; empty when valid
 */
export function validateStory(story) {
  const { meta, overview, howToTest, glossary, diagrams, tests, exclude, chapters } = fieldsOf(story);
  const errors = [...validateMeta(meta), ...validateOverview(overview)];
  if (howToTest !== undefined && typeof howToTest !== 'string') errors.push('howToTest must be a string');

  if (glossary !== undefined && !Array.isArray(glossary)) errors.push('glossary must be an array of { term, meaning }');
  for (const [i, entry] of asArray(glossary).entries()) {
    const { term, meaning } = fieldsOf(entry);
    if (!nonEmpty(term)) errors.push(`glossary[${i}].term is required`);
    if (!nonEmpty(meaning)) errors.push(`glossary[${i}].meaning is required`);
  }

  // An earlier story format listed diagrams in a field of their own. Naming their new place
  // is kinder than dropping them without a word.
  if (diagrams !== undefined) errors.push('diagrams is no longer a story field: put ```mermaid fences inside overview parts or chapter intros');

  // Which files are tests is the story's call: the writer knows the project's stack, the tool does not.
  const testsOk = tests === undefined || (Array.isArray(tests) && tests.every((glob) => typeof glob === 'string'));
  if (!testsOk) errors.push('tests must be an array of globs for this project\'s test files');

  errors.push(...validateExclude(exclude));

  if (!Array.isArray(chapters) || chapters.length === 0) return [...errors, 'chapters must be a non-empty array'];
  return [...errors, ...chapters.flatMap((chapter, i) => validateChapter(chapter, `chapters[${i}]`))];
}

/**
 * @param {unknown} meta
 * @returns {string[]}
 */
function validateMeta(meta) {
  const { title, readerPass } = fieldsOf(meta);
  const errors = nonEmpty(title) ? [] : ['meta.title is required'];
  // Absence is allowed: the pass needs a rendered report to read. render.mjs prints a warning and the header says "not yet run".
  if (readerPass === undefined) return errors;
  if (!isObject(readerPass)) return [...errors, 'meta.readerPass must be { rounds, openQuestions }'];
  if (!isIntegerAtLeast(readerPass.rounds, 1)) errors.push('meta.readerPass.rounds must be at least 1');
  if (!isIntegerAtLeast(readerPass.questionsAnswered, 0)) errors.push('meta.readerPass.questionsAnswered must be a non-negative integer');
  if (!isIntegerAtLeast(readerPass.openQuestions, 0)) errors.push('meta.readerPass.openQuestions must be a non-negative integer');
  return errors;
}

/**
 * @param {unknown} overview
 * @returns {string[]}
 */
function validateOverview(overview) {
  if (!isObject(overview) || Array.isArray(overview)) return ['overview must be an object with bigPicture, why, approach and howToRead'];
  const errors = OVERVIEW_PARTS.filter((part) => !nonEmpty(overview[part])).map((part) => `overview.${part} is required`);
  // String() spells out the conversion RegExp.test applies to a part that is not text.
  const hasDiagram = DIAGRAM_PARTS.some((part) => MERMAID_FENCE.test(String(overview[part] ?? '')));
  if (!hasDiagram) errors.push('overview needs at least one ```mermaid diagram inside bigPicture or approach');
  return errors;
}

/**
 * @param {unknown} exclude
 * @returns {string[]}
 */
function validateExclude(exclude) {
  const errors = exclude === undefined || Array.isArray(exclude) ? [] : ['exclude must be an array of { glob, reason }'];
  for (const [i, entry] of asArray(exclude).entries()) {
    if (!isObject(entry)) {
      errors.push(`exclude[${i}] must be { glob, reason }`);
      continue;
    }
    if (!nonEmpty(entry.glob)) errors.push(`exclude[${i}].glob is required`);
    if (!nonEmpty(entry.reason)) errors.push(`exclude[${i}].reason is required`);
  }
  return errors;
}

/**
 * @param {unknown} chapter
 * @param {string} at where the chapter sits in the story, such as chapters[0]
 * @returns {string[]}
 */
function validateChapter(chapter, at) {
  const { title, intro, hunks, html } = fieldsOf(chapter);
  const errors = [];
  if (!nonEmpty(title)) errors.push(`${at}.title is required`);
  if (!nonEmpty(intro)) errors.push(`${at}.intro is required`);
  else if (sentenceCount(intro) < 2) errors.push(`${at}.intro must have at least two sentences: what this chapter shows, and why it follows the previous one`);
  if (hunks !== undefined && !Array.isArray(hunks)) errors.push(`${at}.hunks must be an array`);
  if (Array.isArray(hunks) === (typeof html === 'string')) errors.push(`${at} must have exactly one of hunks or html`);
  return [...errors, ...asArray(hunks).flatMap((ref, j) => validateHunkRef(ref, `${at}.hunks[${j}]`))];
}

/**
 * @param {unknown} ref
 * @param {string} at where the ref sits in the story, such as chapters[0].hunks[1]
 * @returns {string[]}
 */
function validateHunkRef(ref, at) {
  const { file, lines, covers, slice, comments } = fieldsOf(ref);
  const errors = [];
  if (!nonEmpty(file)) errors.push(`${at}.file is required`);
  if (!validLines(lines)) errors.push(`${at}.lines must be "all" or [start, end] integers with start <= end`);
  if (covers !== undefined && typeof covers !== 'string') errors.push(`${at}.covers must be text`);
  if (slice === true && !Array.isArray(lines)) errors.push(`${at}.slice needs lines as [start, end]`);
  if (comments !== undefined && !Array.isArray(comments)) errors.push(`${at}.comments must be an array`);
  for (const [k, comment] of asArray(comments).entries()) {
    const { line, side, text } = fieldsOf(comment);
    if (!Number.isInteger(line)) errors.push(`${at}.comments[${k}].line must be an integer`);
    if (side !== undefined && side !== 'old' && side !== 'new') errors.push(`${at}.comments[${k}].side must be "old" or "new"`);
    if (!nonEmpty(text)) errors.push(`${at}.comments[${k}].text is required`);
  }
  return errors;
}

/**
 * @param {Story} story a story validateStory accepted
 * @param {DiffFile[]} files
 * @returns {Report}
 */
export function buildReport(story, files) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Problems} */
  const problems = { error: (message) => { errors.push(message); }, warning: (message) => { warnings.push(message); } };
  // Every parsed hunk some chapter showed any part of, even a slice that came out empty.
  /** @type {Set<Hunk>} */
  const touched = new Set();
  const byPath = new Map(files.map((f) => [f.path, f]));

  /**
   * Joins one hunk ref with the diff. Null when the ref names no file or no hunk of the diff.
   * @param {HunkRef} ref
   * @param {string} at where the ref sits in the story, such as chapters[0].hunks[1]
   * @returns {Selection | null}
   */
  const selectRef = (ref, at) => {
    const file = byPath.get(ref.file);
    if (!file) {
      problems.error(`${at}: file not in diff: ${ref.file}`);
      return null;
    }
    const picked = file.hunks.filter((h) => ref.lines === 'all' || overlaps(h, ref.lines[0], ref.lines[1]));
    if (picked.length === 0) {
      const range = ref.lines === 'all' ? 'any lines (file has no hunks)' : `new-side lines ${ref.lines[0]}-${ref.lines[1]}`;
      problems.error(`${at}: no hunk in ${ref.file} overlaps ${range}`);
      return null;
    }
    for (const h of picked) touched.add(h);
    const hunks = shownParts(ref, picked);
    const lines = hunks.flatMap((h) => h.lines);
    /** @type {PlacedComment[]} */
    const comments = (ref.comments ?? []).map((c) => ({ line: c.line, side: c.side ?? 'new', text: c.text }));
    for (const [k, comment] of comments.entries()) checkComment(comment, `${at}.comments[${k}]`, { file: ref.file, lines }, problems);
    return { file, hunks, comments, covers: typeof ref.covers === 'string' ? ref.covers : null, at };
  };

  /** @type {ReportChapter[]} */
  const chapters = story.chapters.map((chapter, i) => {
    const { title, intro } = chapter;
    if (typeof chapter.html === 'string') return { kind: 'html', title, intro, html: chapter.html };
    const hunks = chapter.hunks.map((ref, j) => selectRef(ref, `chapters[${i}].hunks[${j}]`)).filter((sel) => sel !== null);
    return { kind: 'diff', title, intro, hunks };
  });
  const shownLines = new Set(chapters.flatMap((ch) => (ch.kind === 'diff' ? ch.hunks : [])).flatMap((sel) => sel.hunks).flatMap((h) => h.lines));
  return { chapters, appendix: appendixOf(files, touched, shownLines), errors, warnings, shownLines };
}

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
 * @param {PlacedComment} comment
 * @param {string} at where the comment sits in the story, such as chapters[0].hunks[1].comments[2]
 * @param {{ file: string, lines: DiffLine[] }} shown the path the hunk ref names and the lines it shows
 * @param {Problems} problems
 */
function checkComment(comment, at, { file, lines }, problems) {
  const { line, side } = comment;
  if (!lines.some((l) => l[side] === line)) {
    problems.error(`${at}: ${side} line ${line} is not in the selected hunks of ${file}`);
    return;
  }
  const drift = anchorDrift(comment, lines);
  if (drift) problems.warning(`${at}: ${file} ${side} line ${line} does not contain ${drift.names}; ${side} line ${drift.line} does. Move the note if it is about that line.`);
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
   * @param {number} n
   * @returns {DiffLine | undefined}
   */
  const at = (n) => lines.find((l) => l[comment.side] === n);
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
