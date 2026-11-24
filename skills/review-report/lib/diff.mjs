// @ts-check
// Parses `git diff` unified output into files → hunks → numbered lines.
// Pure function: no I/O. Line numbers are computed by walking each hunk,
// so downstream code can anchor comments by old-side or new-side number.
//
// Header-only entries (binary files, mode-only changes, pure renames, empty
// files) have no ---/+++ lines; their paths come from the `diff --git` line.

/**
 * One line of a hunk, numbered on each side it exists on: an added line has no old number and a
 * deleted line has no new one. content is the line without its +, - or space marker.
 *
 * Each line object is created once, here, and its identity matters downstream. A story slice reuses the
 * parsed objects, and coverage and the appendix find the lines a chapter showed with `Set.has`. Copying a
 * line (spread, structuredClone) would make every copied line count as not shown.
 * @typedef {{ type: 'add', old: null, new: number, content: string }
 *   | { type: 'del', old: number, new: null, content: string }
 *   | { type: 'ctx', old: number, new: number, content: string }} DiffLine
 */

/**
 * @typedef {object} Hunk
 * @property {number} oldStart
 * @property {number} newStart
 * @property {string} header the text after the closing `@@`, often the enclosing function
 * @property {DiffLine[]} lines
 * @property {Hunk} [sliceOf] the hunk this one was cut from, when a story shows only part of it
 */

/**
 * @typedef {object} DiffFile
 * @property {string} path the path to show: the old one for a deleted file, the new one otherwise
 * @property {string} oldPath
 * @property {string} newPath
 * @property {'modified' | 'added' | 'deleted' | 'renamed'} status
 * @property {boolean} binary
 * @property {string | null} oldMode
 * @property {string | null} newMode
 * @property {Hunk[]} hunks
 */

/** @typedef {Omit<DiffFile, 'path' | 'hunks'>} FileHeader what a file's header lines say about it */

/**
 * Why a file has no hunks to show: 'binary', 'mode' (mode-only change), 'rename' (pure rename), 'empty' (an
 * empty file added or deleted, or a pure copy under diff.renames=copies).
 * @typedef {'binary' | 'mode' | 'rename' | 'empty'} HeaderOnlyKind
 */

const GIT_LINE = 'diff --git ';

// `@@ -oldStart,oldCount +newStart,newCount @@ header`. git leaves out a count of 1.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * The file header lines that carry information, each with the fields it sets from the text after its prefix.
 * Other header lines, such as `index` and `similarity index`, carry nothing the report shows.
 * @type {[prefix: string, fields: (rest: string) => Partial<FileHeader>][]}
 */
const HEADER_LINES = [
  ['--- ', (rest) => ({ oldPath: headerPath(rest) })],
  ['+++ ', (rest) => ({ newPath: headerPath(rest) })],
  ['new file mode ', (rest) => ({ status: 'added', newMode: rest.trim() })],
  ['deleted file mode ', (rest) => ({ status: 'deleted', oldMode: rest.trim() })],
  ['rename from ', (rest) => ({ status: 'renamed', oldPath: unquotePath(rest) })],
  ['rename to ', (rest) => ({ newPath: unquotePath(rest) })],
  ['old mode ', (rest) => ({ oldMode: rest.trim() })],
  ['new mode ', (rest) => ({ newMode: rest.trim() })],
  ['Binary files', () => ({ binary: true })],
];

/** The marker each kind of hunk line carries, for the numbered dump. */
const MARKER = { add: '+', del: '-', ctx: ' ' };

/**
 * One pass over the lines, as a state machine. A `diff --git` line opens a file. Until the file's first
 * `@@` line, its lines are header lines. After it, they are hunk body lines, numbered from the `@@` counts.
 * So a body line that looks like a header line (`--- x` deleting "-- x") is never read as one.
 * @param {string} text unified diff, as `git diff` prints it
 * @returns {DiffFile[]}
 */
export function parseDiff(text) {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let file = null;
  /** @type {Hunk | null} */
  let hunk = null;
  // The next number on each side, and where the side ends: the @@ counts say how many lines the hunk owes.
  let oldNo = 0;
  let newNo = 0;
  let oldEnd = 0;
  let newEnd = 0;

  // A BOM (some Windows editors add one when a diff is saved) would hide the first `diff --git`.
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith(GIT_LINE)) {
      const [oldPath, newPath] = splitGitLine(raw.slice(GIT_LINE.length));
      file = { path: '', oldPath, newPath, status: 'modified', binary: false, oldMode: null, newMode: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    // Text before the first `diff --git` line (a commit message, say) belongs to no file.
    if (!file) continue;

    if (raw.startsWith('@@')) {
      const match = HUNK_HEADER.exec(raw);
      if (!match) continue; // a malformed @@ line starts nothing
      const [, oldStart, oldCount = '1', newStart, newCount = '1', header] = match;
      hunk = { oldStart: Number(oldStart), newStart: Number(newStart), header, lines: [] };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      oldEnd = oldNo + Number(oldCount);
      newEnd = newNo + Number(newCount);
      continue;
    }

    if (!hunk) {
      // A header line. git prints them in varying order, so each is matched on its own. They are applied
      // one at a time: a `--binary` patch puts many thousands of base85 lines here, too many to spread.
      const rule = HEADER_LINES.find(([prefix]) => raw.startsWith(prefix));
      if (!rule) continue;
      const [prefix, fields] = rule;
      Object.assign(file, fields(raw.slice(prefix.length)));
      continue;
    }

    // Once both counts are spent the hunk is complete. Whatever follows before the
    // next @@ or diff --git line (a format-patch signature, mail text) is not diff content.
    if (oldNo >= oldEnd && newNo >= newEnd) continue;
    // A blank context line is " ". Editors trim it to "" when a diff is saved to a file;
    // the counts still owe a line, so it is read as the blank context line it was.
    const marker = raw === '' ? ' ' : raw[0];
    const content = raw.slice(1);
    if (marker === '+') hunk.lines.push({ type: 'add', old: null, new: newNo++, content });
    else if (marker === '-') hunk.lines.push({ type: 'del', old: oldNo++, new: null, content });
    else if (marker === ' ') hunk.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, content });
    // Any other line, such as `\ No newline at end of file`, carries no content and takes no number.
  }

  // The path to show: the old one for a deleted file, the new one otherwise.
  for (const f of files) f.path = f.status === 'deleted' || f.newPath === '/dev/null' ? f.oldPath : f.newPath;
  return files;
}

/**
 * `--- a/path` / `+++ b/path`: unquote, strip the a/ b/ prefix and the trailing
 * tab git adds when an unquoted path contains spaces. `/dev/null` stays as-is.
 * @param {string} rest
 * @returns {string}
 */
function headerPath(rest) {
  const p = unquotePath(rest.replace(/\t$/, ''));
  if (p === '/dev/null') return p;
  return p.replace(/^[ab]\//, '');
}

/**
 * `diff --git a/X b/Y`. Either side may be C-quoted. Unquoted paths may contain
 * spaces, so when neither side is quoted try every " b/" split and prefer the
 * one where both sides name the same path (the common non-rename case).
 * @param {string} rest
 * @returns {string[]} the old and the new path
 */
function splitGitLine(rest) {
  const tokens = quotedTokens(rest);
  if (tokens) return tokens.map((t) => t.replace(/^[ab]\//, ''));
  /** @type {[string, string][]} */
  const candidates = [];
  let idx = rest.indexOf(' b/');
  while (idx !== -1) {
    candidates.push([rest.slice(0, idx), rest.slice(idx + 1)]);
    idx = rest.indexOf(' b/', idx + 1);
  }
  if (candidates.length === 0) return [rest, rest];
  const same = candidates.find(([a, b]) => a.replace(/^a\//, '') === b.replace(/^b\//, ''));
  const [a, b] = same ?? candidates[0];
  return [a.replace(/^a\//, ''), b.replace(/^b\//, '')];
}

/**
 * Splits `X Y` where at least one of X, Y is a C-quoted string; null otherwise.
 * @param {string} s
 * @returns {string[] | null}
 */
function quotedTokens(s) {
  if (!s.includes('"')) return null;
  /** @type {string[]} */
  const out = [];
  let i = 0;
  // A scanner: where the next token starts depends on where the last one ended.
  while (i < s.length && out.length < 2) {
    if (s[i] === ' ') {
      i++;
    } else if (s[i] === '"') {
      // A quoted side runs to the closing quote; an escaped quote does not end it.
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out.push(unquotePath(s.slice(i, j + 1)));
      i = j + 1;
    } else {
      // An unquoted side runs to the space before the next quoted token, or to the end.
      const q = s.indexOf(' "', i);
      const end = q === -1 ? s.length : q;
      out.push(s.slice(i, end));
      i = end;
    }
  }
  return out.length === 2 ? out : null;
}

/**
 * The byte each single-letter escape in a C-quoted path stands for.
 * @type {Record<string, number>}
 */
const C_ESCAPES = { t: 9, n: 10, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };

// TextEncoder and TextDecoder, not Node's Buffer: this module also has to run where there is no Node.
// The decoder drops a leading byte-order mark, as this decoding always has.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * git quotes paths with unusual bytes as C strings: "caf\303\251.txt".
 * Decodes \ooo octal bytes as UTF-8 and the \t \n \" \\ escapes. Literal runs
 * are encoded whole, so a character outside the BMP (an emoji left raw under
 * core.quotePath=false) keeps both halves of its surrogate pair together.
 * @param {string} p
 * @returns {string}
 */
export function unquotePath(p) {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  // The capture group keeps each escape in the split: literal runs sit at even indexes, escapes at odd ones.
  // A lone backslash at the end (malformed input) is an escape with nothing after it, and is kept.
  const parts = p.slice(1, -1).split(/(\\[0-7]{1,3}|\\.?)/s);
  const bytes = parts.flatMap((part, k) => {
    if (k % 2 === 0) return [...utf8Encoder.encode(part)];
    const escaped = part.slice(1);
    if (escaped === '') return [92];
    if (/^[0-7]/.test(escaped)) return [parseInt(escaped, 8)];
    return [C_ESCAPES[escaped] ?? escaped.charCodeAt(0)];
  });
  // Uint8Array.from keeps the low 8 bits of each number, so an out-of-range octal such as \777 becomes byte 0xff.
  return utf8Decoder.decode(Uint8Array.from(bytes));
}

/**
 * The label git puts on a hunk, for a parsed hunk: the old and new line ranges between `@@` marks,
 * then the context text. Like git, a count of 1 is left out. Counts come from the parsed lines, so
 * the label always matches what is shown even when the input header was off.
 * @param {Hunk} h
 * @returns {string}
 */
export function hunkLabel(h) {
  const oldCount = h.lines.filter((l) => l.type !== 'add').length;
  const newCount = h.lines.filter((l) => l.type !== 'del').length;
  return `@@ -${hunkRange(h.oldStart, oldCount)} +${hunkRange(h.newStart, newCount)} @@ ${h.header}`.trimEnd();
}

/**
 * @param {number} start
 * @param {number} count
 * @returns {string}
 */
function hunkRange(start, count) {
  return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * How many lines a file adds and deletes, and how many diff rows it has in all.
 * @param {DiffFile} file
 * @returns {{ adds: number, dels: number, rows: number }}
 */
export function lineStats(file) {
  let adds = 0;
  let dels = 0;
  let rows = 0;
  // Plain counting loops: the report asks for these numbers several times per file.
  for (const { lines } of file.hunks) {
    rows += lines.length;
    for (const { type } of lines) {
      if (type === 'add') adds++;
      else if (type === 'del') dels++;
    }
  }
  return { adds, dels, rows };
}

/**
 * Human/LLM-readable dump with old and new line numbers on every line, so a
 * story author can copy anchor numbers instead of counting. Format per line:
 * "<old:5> <new:5> <marker><content>", "-" where a side has no number.
 * @param {DiffFile[]} files
 * @returns {string}
 */
export function formatNumbered(files) {
  return `${files.flatMap(numberedFileLines).join('\n')}\n`;
}

/**
 * A header-only file gets its reason line instead of a table.
 * @param {DiffFile} f
 * @returns {string[]}
 */
function numberedFileLines(f) {
  const reason = headerOnlyReason(f);
  if (reason) return [numberedTitle(f), `(${reason})`];
  return [numberedTitle(f), '  old   new  line', ...f.hunks.flatMap((h) => [hunkLabel(h), ...h.lines.map(numberedLine)])];
}

/**
 * @param {DiffFile} f
 * @returns {string}
 */
function numberedTitle(f) {
  const how = f.status === 'renamed' ? `renamed from ${f.oldPath}` : f.status;
  const mode = f.hunks.length ? modeNote(f) : null; // header-only files say it in their reason line
  return `=== ${f.path} (${how}${mode ? `, ${mode}` : ''})`;
}

/**
 * @param {DiffLine} l
 * @returns {string}
 */
function numberedLine(l) {
  return `${String(l.old ?? '-').padStart(5)} ${String(l.new ?? '-').padStart(5)} ${MARKER[l.type]}${l.content}`;
}

/**
 * A permission change worth showing next to the content change: an edited file
 * that also became executable, or a new script created executable. null otherwise.
 * @param {DiffFile} f
 * @returns {string | null}
 */
export function modeNote(f) {
  if (f.oldMode && f.newMode) return `mode ${f.oldMode} → ${f.newMode}`;
  if (f.status === 'added' && f.newMode && f.newMode !== '100644') return `mode ${f.newMode}`;
  return null;
}

/**
 * @param {DiffFile} f
 * @returns {HeaderOnlyKind | null} null when the file has hunks to show
 */
export function headerOnlyKind(f) {
  if (f.binary) return 'binary';
  if (f.hunks.length > 0) return null;
  if (f.oldMode && f.newMode) return 'mode';
  if (f.status === 'renamed') return 'rename';
  return 'empty';
}

/**
 * How each kind of header-only file is described, as plain text: `reason` is the short form in the numbered
 * dump, `sentence` stands in the report where the diff table would be.
 * An empty file added or deleted says so. Any other empty entry is a pure copy, where nothing changed.
 * @type {Record<HeaderOnlyKind, { reason: (f: DiffFile) => string, sentence: (f: DiffFile) => string }>}
 */
export const HEADER_ONLY = {
  binary: {
    reason: () => 'binary',
    sentence: () => 'Binary file, no textual diff.',
  },
  mode: {
    reason: (f) => `mode ${f.oldMode} → ${f.newMode}, no content change`,
    sentence: (f) => `Mode changed ${f.oldMode} → ${f.newMode}, no content change.`,
  },
  rename: {
    reason: () => 'no content change',
    sentence: () => 'Renamed, no content change.',
  },
  empty: {
    reason: (f) => (f.status === 'added' || f.status === 'deleted' ? 'empty file' : 'no content change'),
    sentence: (f) => (f.status === 'added' || f.status === 'deleted' ? `Empty file ${f.status}.` : 'No content change.'),
  },
};

/**
 * The kind as one line of text for the numbered dump; null when the file has hunks.
 * @param {DiffFile} f
 * @returns {string | null}
 */
export function headerOnlyReason(f) {
  const kind = headerOnlyKind(f);
  return kind === null ? null : HEADER_ONLY[kind].reason(f);
}
