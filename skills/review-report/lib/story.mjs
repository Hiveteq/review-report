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
 * @param {unknown} v
 * @returns {v is string}
 */
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

// The overview is the big picture. Each part is Markdown and each is required.
export const OVERVIEW_PARTS = ['bigPicture', 'why', 'approach', 'howToRead'];
const MERMAID_FENCE = /^```mermaid\s*$/m;

/**
 * @param {any} story parsed JSON of any shape; checking that shape is this function's job
 * @returns {string[]} every problem found, each with its path in the story; empty when valid
 */
export function validateStory(story) {
  /** @type {string[]} */
  const errors = [];
  if (!nonEmpty(story?.meta?.title)) errors.push('meta.title is required');
  const np = story?.meta?.readerPass;
  // Absence is allowed: the pass needs a rendered report to read. render.mjs prints a warning and the header says "not yet run".
  if (np !== undefined && (np === null || typeof np !== 'object')) {
    errors.push('meta.readerPass must be { rounds, openQuestions }');
  } else if (np) {
    if (!Number.isInteger(np.rounds) || np.rounds < 1) errors.push('meta.readerPass.rounds must be at least 1');
    if (!Number.isInteger(np.questionsAnswered) || np.questionsAnswered < 0) errors.push('meta.readerPass.questionsAnswered must be a non-negative integer');
    if (!Number.isInteger(np.openQuestions) || np.openQuestions < 0) errors.push('meta.readerPass.openQuestions must be a non-negative integer');
  }


  const ov = story?.overview;
  if (ov === null || typeof ov !== 'object' || Array.isArray(ov)) {
    errors.push('overview must be an object with bigPicture, why, approach and howToRead');
  } else {
    for (const part of OVERVIEW_PARTS) if (!nonEmpty(ov[part])) errors.push(`overview.${part} is required`);
    const hasDiagram = ['bigPicture', 'approach'].some((part) => MERMAID_FENCE.test(ov[part] ?? ''));
    if (!hasDiagram) errors.push('overview needs at least one ```mermaid diagram inside bigPicture or approach');
  }
  if (story?.howToTest !== undefined && typeof story.howToTest !== 'string') errors.push('howToTest must be a string');

  if (story?.glossary !== undefined && !Array.isArray(story.glossary)) errors.push('glossary must be an array of { term, meaning }');
  asArray(story?.glossary).forEach((g, i) => {
    if (!nonEmpty(g?.term)) errors.push(`glossary[${i}].term is required`);
    if (!nonEmpty(g?.meaning)) errors.push(`glossary[${i}].meaning is required`);
  });

  // A single object where a list is expected is a likely slip; it must become an
  // error line, not a TypeError from .forEach.
  if (story?.diagrams !== undefined) errors.push('diagrams is no longer a story field: put ```mermaid fences inside overview parts or chapter intros');

  // Which files are tests is the story's call: the writer knows the project's stack, the tool does not.
  if (story?.tests !== undefined && (!Array.isArray(story.tests) || !story.tests.every((/** @type {unknown} */ g) => typeof g === 'string'))) errors.push('tests must be an array of globs for this project\'s test files');
  if (story?.exclude !== undefined && !Array.isArray(story.exclude)) errors.push('exclude must be an array of { glob, reason }');
  asArray(story?.exclude).forEach((e, i) => {
    if (e === null || typeof e !== 'object') { errors.push(`exclude[${i}] must be { glob, reason }`); return; }
    if (!nonEmpty(e.glob)) errors.push(`exclude[${i}].glob is required`);
    if (!nonEmpty(e.reason)) errors.push(`exclude[${i}].reason is required`);
  });

  if (!Array.isArray(story?.chapters) || story.chapters.length === 0) {
    errors.push('chapters must be a non-empty array');
    return errors;
  }
  // story is unchecked JSON, so the callback parameters get their types here.
  story.chapters.forEach((/** @type {any} */ ch, /** @type {number} */ i) => {
    const at = `chapters[${i}]`;
    if (!nonEmpty(ch?.title)) errors.push(`${at}.title is required`);
    if (!nonEmpty(ch?.intro)) errors.push(`${at}.intro is required`);
    else if (sentenceCount(ch.intro) < 2) errors.push(`${at}.intro must have at least two sentences: what this chapter shows, and why it follows the previous one`);
    const hasHunks = Array.isArray(ch?.hunks);
    const hasHtml = typeof ch?.html === 'string';
    if (ch?.hunks !== undefined && !hasHunks) errors.push(`${at}.hunks must be an array`);
    if (hasHunks === hasHtml) errors.push(`${at} must have exactly one of hunks or html`);
    asArray(ch?.hunks).forEach((h, j) => {
      const hat = `${at}.hunks[${j}]`;
      if (!nonEmpty(h?.file)) errors.push(`${hat}.file is required`);
      if (!validLines(h?.lines)) errors.push(`${hat}.lines must be "all" or [start, end] integers with start <= end`);
      if (h?.covers !== undefined && typeof h.covers !== 'string') errors.push(`${hat}.covers must be text`);
      if (h?.slice === true && !Array.isArray(h?.lines)) errors.push(`${hat}.slice needs lines as [start, end]`);
      if (h?.comments !== undefined && !Array.isArray(h.comments)) errors.push(`${hat}.comments must be an array`);
      asArray(h?.comments).forEach((c, k) => {
        const cat = `${hat}.comments[${k}]`;
        if (!Number.isInteger(c?.line)) errors.push(`${cat}.line must be an integer`);
        if (c?.side !== undefined && c.side !== 'old' && c.side !== 'new') errors.push(`${cat}.side must be "old" or "new"`);
        if (!nonEmpty(c?.text)) errors.push(`${cat}.text is required`);
      });
    });
  });
  return errors;
}

/**
 * @param {any} v a value from the unchecked story
 * @returns {any[]}
 */
const asArray = (v) => (Array.isArray(v) ? v : []);

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
  /** @type {Set<DiffLine>} */
  const shownLines = new Set(); // every diff line object some chapter showed
  /** @type {Set<Hunk>} */
  const touched = new Set();    // every original hunk some chapter showed any part of
  const byPath = new Map(files.map((f) => [f.path, f]));

  /** @type {ReportChapter[]} */
  const chapters = story.chapters.map((ch, i) => {
    if (typeof ch.html === 'string') return { kind: 'html', title: ch.title, intro: ch.intro, html: ch.html };
    const hunks = ch.hunks.map((ref, j) => {
      const at = `chapters[${i}].hunks[${j}]`;
      const file = byPath.get(ref.file);
      if (!file) {
        errors.push(`${at}: file not in diff: ${ref.file}`);
        return null;
      }
      const picked = file.hunks
        .map((h, idx) => ({ h, idx }))
        .filter(({ h }) => ref.lines === 'all' || overlaps(h, ref.lines[0], ref.lines[1]));
      if (picked.length === 0) {
        const range = ref.lines === 'all' ? 'any lines (file has no hunks)' : `new-side lines ${ref.lines[0]}-${ref.lines[1]}`;
        errors.push(`${at}: no hunk in ${ref.file} overlaps ${range}`);
        return null;
      }
      // A slice shows only the given new-side range of each hunk, so one new file can be
      // spread over the chapters that explain its parts. Without slice the whole hunk shows.
      // Read only when slice is true, and validateStory requires lines as [start, end] whenever slice is true.
      const sliceRange = /** @type {[number, number]} */ (ref.lines);
      const shown = ref.slice ? picked.map(({ h }) => sliceHunk(h, sliceRange[0], sliceRange[1])).filter((h) => h.lines.length) : picked.map(({ h }) => h);
      picked.forEach(({ h }) => touched.add(h));
      shown.forEach((h) => h.lines.forEach((l) => shownLines.add(l)));
      const lines = shown.flatMap((h) => h.lines);
      /** @type {PlacedComment[]} */
      const comments = (ref.comments ?? []).map((c) => ({ line: c.line, side: c.side ?? 'new', text: c.text }));
      comments.forEach((c, k) => {
        const present = lines.some((l) => (c.side === 'new' ? l.new : l.old) === c.line);
        if (!present) { errors.push(`${at}.comments[${k}]: ${c.side} line ${c.line} is not in the selected hunks of ${ref.file}`); return; }
        const drift = anchorDrift(c, lines);
        if (drift) warnings.push(`${at}.comments[${k}]: ${ref.file} ${c.side} line ${c.line} does not contain ${drift.names}; ${c.side} line ${drift.line} does. Move the note if it is about that line.`);
      });
      return { file, hunks: shown, comments, covers: typeof ref.covers === 'string' ? ref.covers : null, at };
    }).filter((sel) => sel !== null);
    return { kind: 'diff', title: ch.title, intro: ch.intro, hunks };
  });

  // Files with no hunks at all (binary, mode-only, pure rename, empty) always
  // appear here so the reader can see they were part of the change.
  // A hunk no chapter touched goes here whole; a sliced hunk leaves only its changed
  // lines that no slice showed.
  const appendix = files
    .map((file) => ({ file, hunks: file.hunks.flatMap((h) => {
      if (!touched.has(h)) return [h];
      const rest = h.lines.filter((l) => !shownLines.has(l));
      return rest.some((l) => l.type !== 'ctx') ? [subHunk(h, rest)] : [];
    }) }))
    .filter((e) => e.hunks.length > 0 || e.file.hunks.length === 0);

  return { chapters, appendix, errors, warnings };
}

// Names a note puts in backticks, as plain identifier-like tokens: `value()` gives value,
// `"Hello "` gives Hello. Markdown backticks are the only convention used, so this
// works for any language.
/**
 * @param {string} text
 * @returns {string[]}
 */
function namesIn(text) {
  /** @type {string[]} */
  const out = [];
  for (const [, span] of String(text).matchAll(/`([^`]+)`/g)) {
    for (const t of span.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) if (!out.includes(t)) out.push(t);
  }
  return out;
}

// A note whose named code is missing from its own line but present one or two lines
// away was most likely anchored off by one. Returns the nearest such line, or null.
/**
 * @param {PlacedComment} comment
 * @param {DiffLine[]} lines
 * @returns {{ line: number, names: string } | null} names: the backticked names found there, joined for a message
 */
function anchorDrift(comment, lines) {
  const names = namesIn(comment.text);
  if (!names.length) return null;
  /** @param {DiffLine} l */
  const num = (l) => (comment.side === 'new' ? l.new : l.old);
  /** @param {number} n */
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

// The part of a hunk that belongs to new-side lines start..end. A deleted line has no
// new number; it belongs where it sits, after the last new-side line before it.
/**
 * @param {Hunk} hunk
 * @param {number} start
 * @param {number} end
 * @returns {Hunk}
 */
function sliceHunk(hunk, start, end) {
  let lastNew = hunk.newStart - 1;
  const lines = hunk.lines.filter((l) => {
    if (l.new !== null) { lastNew = l.new; return l.new >= start && l.new <= end; }
    return lastNew >= start - 1 && lastNew < end;
  });
  return subHunk(hunk, lines);
}

// A hunk made of some of another hunk's lines, numbered from its first line.
/**
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

// New-side overlap. A hunk that only deletes (no context) has no new-side
// numbers; git's newStart then points at the line before the deletion.
/**
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
