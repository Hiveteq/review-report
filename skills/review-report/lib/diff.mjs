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

/** @typedef {readonly [prefix: string, fields: (rest: string) => Partial<FileHeader>]} HeaderLine */

/**
 * One rule of HEADER_LINES, frozen so the shared table cannot be changed by a caller.
 * @param {string} prefix
 * @param {(rest: string) => Partial<FileHeader>} fields
 * @returns {HeaderLine}
 */
function headerLine(prefix, fields) {
  return Object.freeze(/** @type {const} */ ([prefix, fields]));
}

/**
 * The file header lines that carry information, each with the fields it sets from the text after its prefix.
 * git prints them in varying order, so every line is matched on its own. Other header lines, such as
 * `index` and `similarity index`, carry nothing the report shows.
 * @type {ReadonlyArray<HeaderLine>}
 */
const HEADER_LINES = Object.freeze([
  headerLine('--- ', (rest) => ({ oldPath: headerPath(rest) })),
  headerLine('+++ ', (rest) => ({ newPath: headerPath(rest) })),
  headerLine('new file mode ', (rest) => ({ status: 'added', newMode: rest.trim() })),
  headerLine('deleted file mode ', (rest) => ({ status: 'deleted', oldMode: rest.trim() })),
  headerLine('rename from ', (rest) => ({ status: 'renamed', oldPath: unquotePath(rest) })),
  headerLine('rename to ', (rest) => ({ newPath: unquotePath(rest) })),
  headerLine('old mode ', (rest) => ({ oldMode: rest.trim() })),
  headerLine('new mode ', (rest) => ({ newMode: rest.trim() })),
  headerLine('Binary files', () => ({ binary: true })),
]);

/**
 * A hunk body line's kind, by its first character.
 * @type {ReadonlyMap<string, DiffLine['type']>}
 */
const LINE_KIND = new Map([['+', 'add'], ['-', 'del'], [' ', 'ctx']]);

/**
 * The marker each kind of line carries, the inverse of LINE_KIND.
 * @type {Readonly<Record<DiffLine['type'], string>>}
 */
const MARKER = /** @type {Record<DiffLine['type'], string>} */ (
  Object.freeze(Object.fromEntries([...LINE_KIND].map(([marker, type]) => [type, marker])))
);

/**
 * @param {string} text unified diff, as `git diff` prints it
 * @returns {DiffFile[]}
 */
export function parseDiff(text) {
  // Text before the first `diff --git` line (a commit message, say) belongs to no file.
  return cutAt(diffLines(text), startFile).runs.map(readFile);
}

/**
 * A BOM (some Windows editors add one when a diff is saved) would hide the first `diff --git`.
 * @param {string} text
 * @returns {string[]}
 */
function diffLines(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
}

/**
 * Lines opened by a line that `startOf` recognised, with what it read from that line.
 * @template T
 * @typedef {{ start: T, body: string[] }} Run
 */

/**
 * Cuts lines into runs, each opened by a line `startOf` recognises; `before` holds the lines ahead of
 * the first one. Each run keeps what `startOf` read from its opening line, so no line is parsed twice.
 * @template T
 * @param {string[]} lines
 * @param {(line: string) => T | null} startOf what an opening line says; null for any other line
 * @returns {{ before: string[], runs: Run<T>[] }}
 */
function cutAt(lines, startOf) {
  const opens = lines.flatMap((line, at) => {
    const start = startOf(line);
    return start === null ? [] : [{ at, start }];
  });
  const ends = [...opens.slice(1).map(({ at }) => at), lines.length];
  return {
    before: lines.slice(0, opens[0]?.at ?? lines.length),
    runs: opens.map(({ at, start }, k) => ({ start, body: lines.slice(at + 1, ends[k]) })),
  };
}

/**
 * One file: its header lines, then its hunks. The header ends at the first `@@` line, so a hunk body
 * line that happens to look like a header line is never read as one. An `@@` line that does not parse
 * starts nothing; it is skipped like any other unknown line.
 * @param {Run<FileHeader>} run what the `diff --git` line said, and every line up to the next one
 * @returns {DiffFile}
 */
function readFile({ start, body }) {
  const { before: headerLines, runs: hunkRuns } = cutAt(body, startHunk);
  /**
   * Merged entry by entry, later lines winning. Passing every line to one call as spread arguments
   * overflows the stack on a large `--binary` patch, whose base85 lines all sit in the header.
   * @type {Partial<FileHeader>}
   */
  const fields = Object.fromEntries(headerLines.flatMap((raw) => Object.entries(readHeaderLine(raw))));
  const header = { ...start, ...fields };
  return { path: displayPath(header), ...header, hunks: hunkRuns.map(readHunk) };
}

/**
 * What a `diff --git` line says before the header lines are read: its two paths, modified.
 * @param {string} raw
 * @returns {FileHeader | null} null for any other line
 */
function startFile(raw) {
  if (!raw.startsWith(GIT_LINE)) return null;
  const [oldPath, newPath] = splitGitLine(raw.slice(GIT_LINE.length));
  return { oldPath, newPath, status: 'modified', binary: false, oldMode: null, newMode: null };
}

/**
 * The fields one header line sets; none for a line that carries nothing the report shows.
 * @param {string} raw
 * @returns {Partial<FileHeader>}
 */
function readHeaderLine(raw) {
  const rule = HEADER_LINES.find(([prefix]) => raw.startsWith(prefix));
  if (!rule) return {};
  const [prefix, fields] = rule;
  return fields(raw.slice(prefix.length));
}

/**
 * @param {FileHeader} header
 * @returns {string} the old path for a deleted file, the new path otherwise
 */
function displayPath(header) {
  return header.status === 'deleted' || header.newPath === '/dev/null' ? header.oldPath : header.newPath;
}

/**
 * @param {Run<HunkStart>} run what the `@@` line said, and every line up to the next `@@` line or file
 * @returns {Hunk}
 */
function readHunk({ start, body }) {
  const { oldStart, newStart, header } = start;
  return { oldStart, newStart, header, lines: numberLines(start, body.flatMap(readBodyLine)) };
}

/**
 * Where a hunk starts on each side, how many lines it spans there, and the text after its closing `@@`.
 * @typedef {{ oldStart: number, oldCount: number, newStart: number, newCount: number, header: string }} HunkStart
 */

/**
 * @param {string} raw
 * @returns {HunkStart | null} null for a line that is not a well-formed `@@` line
 */
function startHunk(raw) {
  const match = HUNK_HEADER.exec(raw);
  if (!match) return null;
  const [, oldStart, oldCount = '1', newStart, newCount = '1', header] = match;
  return { oldStart: Number(oldStart), oldCount: Number(oldCount), newStart: Number(newStart), newCount: Number(newCount), header };
}

/** @typedef {{ type: DiffLine['type'], content: string }} BodyLine a hunk body line before it is numbered */

/**
 * A hunk body line as its kind and content; nothing for a line that is not diff content.
 * @param {string} raw
 * @returns {BodyLine[]}
 */
function readBodyLine(raw) {
  // A blank context line is " ". Editors trim it to "" when a diff is saved to a file;
  // the counts still owe a line, so it is read as the blank context line it was.
  const type = LINE_KIND.get(raw === '' ? ' ' : raw[0]);
  // Any other line, such as `\ No newline at end of file`, carries no content and takes no number.
  return type ? [{ type, content: raw.slice(1) }] : [];
}

/**
 * @param {HunkStart} start
 * @param {BodyLine[]} body
 * @returns {DiffLine[]}
 */
function numberLines({ oldStart, oldCount, newStart, newCount }, body) {
  // The @@ counts say how many lines the hunk owes on each side; a side is spent once its number reaches the end.
  const oldEnd = oldStart + oldCount;
  const newEnd = newStart + newCount;
  let oldNo = oldStart;
  let newNo = newStart;
  /** @type {DiffLine[]} */
  const lines = [];
  // A state machine: each line takes the next number on every side it exists on.
  for (const { type, content } of body) {
    // Once both counts are spent the hunk is complete. Whatever follows before the
    // next @@ or diff --git line (a format-patch signature, mail text) is not diff content.
    if (oldNo >= oldEnd && newNo >= newEnd) break;
    if (type === 'add') lines.push({ type, old: null, new: newNo++, content });
    else if (type === 'del') lines.push({ type, old: oldNo++, new: null, content });
    else lines.push({ type, old: oldNo++, new: newNo++, content });
  }
  return lines;
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
      continue;
    }
    const { token, end } = s[i] === '"' ? quotedTokenAt(s, i) : plainTokenAt(s, i);
    out.push(token);
    i = end;
  }
  return out.length === 2 ? out : null;
}

/**
 * A C-quoted token starting at the opening quote at i, unquoted. Escaped quotes do not end it.
 * @param {string} s
 * @param {number} i
 * @returns {{ token: string, end: number }} end is the index just past the closing quote
 */
function quotedTokenAt(s, i) {
  let j = i + 1;
  while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
  return { token: unquotePath(s.slice(i, j + 1)), end: j + 1 };
}

/**
 * An unquoted token starting at i: it runs to the space before the next quoted token, or to the end.
 * @param {string} s
 * @param {number} i
 * @returns {{ token: string, end: number }}
 */
function plainTokenAt(s, i) {
  const q = s.indexOf(' "', i);
  const end = q === -1 ? s.length : q;
  return { token: s.slice(i, end), end };
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * The byte each single-letter escape in a C-quoted path stands for.
 * @type {Readonly<Record<string, number>>}
 */
const C_ESCAPES = Object.freeze({ t: 9, n: 10, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 });

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
  const inner = p.slice(1, -1);
  /** @type {number[]} */
  const bytes = [];
  let literal = '';
  const flush = () => {
    for (const b of utf8Encoder.encode(literal)) bytes.push(b);
    literal = '';
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') { literal += ch; continue; }
    flush();
    const next = inner[i + 1];
    if (next === undefined) { bytes.push(92); break; } // dangling backslash in malformed input: keep it
    if (/[0-7]/.test(next)) {
      // Cannot be null: the test above saw an octal digit right after the backslash.
      const oct = /** @type {RegExpMatchArray} */ (inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/))[0];
      bytes.push(parseInt(oct, 8));
      i += oct.length;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  flush();
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
  const lines = file.hunks.flatMap((h) => h.lines);
  return {
    adds: lines.filter((l) => l.type === 'add').length,
    dels: lines.filter((l) => l.type === 'del').length,
    rows: lines.length,
  };
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
  return [numberedTitle(f), '  old   new  line', ...f.hunks.flatMap(numberedHunkLines)];
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
 * @param {Hunk} h
 * @returns {string[]}
 */
function numberedHunkLines(h) {
  return [hunkLabel(h), ...h.lines.map(numberedLine)];
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
 * An empty file added or deleted says so. Otherwise an empty entry is a pure copy, where nothing changed.
 * @param {DiffFile} f
 * @returns {boolean}
 */
function isEmptyFileChange(f) {
  return f.status === 'added' || f.status === 'deleted';
}

/** @typedef {{ readonly reason: (f: DiffFile) => string, readonly sentence: (f: DiffFile) => string }} HeaderOnlyWording */

/**
 * How each kind of header-only file is described, as plain text: `reason` is the short form in the numbered
 * dump, `sentence` stands in the report where the diff table would be.
 * @type {Readonly<Record<HeaderOnlyKind, HeaderOnlyWording>>}
 */
export const HEADER_ONLY = Object.freeze({
  binary: wording(() => 'binary', () => 'Binary file, no textual diff.'),
  mode: wording(
    (f) => `mode ${f.oldMode} → ${f.newMode}, no content change`,
    (f) => `Mode changed ${f.oldMode} → ${f.newMode}, no content change.`,
  ),
  rename: wording(() => 'no content change', () => 'Renamed, no content change.'),
  empty: wording(
    (f) => (isEmptyFileChange(f) ? 'empty file' : 'no content change'),
    (f) => (isEmptyFileChange(f) ? `Empty file ${f.status}.` : 'No content change.'),
  ),
});

/**
 * One entry of HEADER_ONLY, frozen so the shared table cannot be changed by a caller.
 * @param {(f: DiffFile) => string} reason
 * @param {(f: DiffFile) => string} sentence
 * @returns {HeaderOnlyWording}
 */
function wording(reason, sentence) {
  return Object.freeze({ reason, sentence });
}

/**
 * The kind as one line of text for the numbered dump; null when the file has hunks.
 * @param {DiffFile} f
 * @returns {string | null}
 */
export function headerOnlyReason(f) {
  const kind = headerOnlyKind(f);
  return kind === null ? null : HEADER_ONLY[kind].reason(f);
}
