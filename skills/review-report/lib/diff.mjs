// Parses `git diff` unified output into files → hunks → numbered lines.
// Pure function: no I/O. Line numbers are computed by walking each hunk,
// so downstream code can anchor comments by old-side or new-side number.
//
// Header-only entries (binary files, mode-only changes, pure renames, empty
// files) have no ---/+++ lines; their paths come from the `diff --git` line.

export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  // Body lines the current hunk still owes on each side, from its @@ counts.
  let oldLeft = 0;
  let newLeft = 0;

  // A BOM (some Windows editors add one when a diff is saved) would hide the first `diff --git`.
  for (const raw of text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const [a, b] = splitGitLine(raw.slice(11));
      file = { path: null, oldPath: a, newPath: b, status: 'modified', binary: false, oldMode: null, newMode: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (hunk === null) {
      // File header section. Order of these lines varies, so match each independently.
      if (raw.startsWith('--- ')) { file.oldPath = headerPath(raw.slice(4)); continue; }
      if (raw.startsWith('+++ ')) { file.newPath = headerPath(raw.slice(4)); continue; }
      if (raw.startsWith('new file mode ')) { file.status = 'added'; file.newMode = raw.slice(14).trim(); continue; }
      if (raw.startsWith('deleted file mode ')) { file.status = 'deleted'; file.oldMode = raw.slice(18).trim(); continue; }
      if (raw.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = unquotePath(raw.slice(12)); continue; }
      if (raw.startsWith('rename to ')) { file.newPath = unquotePath(raw.slice(10)); continue; }
      if (raw.startsWith('old mode ')) { file.oldMode = raw.slice(9).trim(); continue; }
      if (raw.startsWith('new mode ')) { file.newMode = raw.slice(9).trim(); continue; }
      if (raw.startsWith('Binary files')) { file.binary = true; continue; }
    }

    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(raw);
      if (!m) continue;
      hunk = { oldStart: Number(m[1]), newStart: Number(m[3]), header: m[5], lines: [] };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue;

    // Inside a hunk. `\ No newline at end of file` carries no content and is not counted.
    if (raw.startsWith('\\')) continue;
    // Once both counts are spent the hunk is complete. Whatever follows before the
    // next @@ or diff --git line (a format-patch signature, mail text) is not diff content.
    if (oldLeft <= 0 && newLeft <= 0) continue;
    // A blank context line is " ". Editors trim it to "" when a diff is saved to a file;
    // the counts still owe a line, so it is read as the blank context line it was.
    const tag = raw === '' ? ' ' : raw[0];
    const content = raw === '' ? '' : raw.slice(1);
    if (tag === '+') { hunk.lines.push({ type: 'add', old: null, new: newNo++, content }); newLeft--; }
    else if (tag === '-') { hunk.lines.push({ type: 'del', old: oldNo++, new: null, content }); oldLeft--; }
    else if (tag === ' ') { hunk.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, content }); oldLeft--; newLeft--; }
    // Any other line is not diff content and is ignored.
  }

  for (const f of files) {
    f.path = f.status === 'deleted' || f.newPath === '/dev/null' ? f.oldPath : f.newPath;
  }
  return files;
}

// `--- a/path` / `+++ b/path`: unquote, strip the a/ b/ prefix and the trailing
// tab git adds when an unquoted path contains spaces. `/dev/null` stays as-is.
function headerPath(rest) {
  const p = unquotePath(rest.replace(/\t$/, ''));
  if (p === '/dev/null') return p;
  return p.replace(/^[ab]\//, '');
}

// `diff --git a/X b/Y`. Either side may be C-quoted. Unquoted paths may contain
// spaces, so when neither side is quoted try every " b/" split and prefer the
// one where both sides name the same path (the common non-rename case).
function splitGitLine(rest) {
  const tokens = quotedTokens(rest);
  if (tokens) return tokens.map((t) => t.replace(/^[ab]\//, ''));
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

// Splits `X Y` where at least one of X, Y is a C-quoted string; null otherwise.
function quotedTokens(s) {
  if (!s.includes('"')) return null;
  const out = [];
  let i = 0;
  while (i < s.length && out.length < 2) {
    if (s[i] === ' ') { i++; continue; }
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out.push(unquotePath(s.slice(i, j + 1)));
      i = j + 1;
    } else {
      // Unquoted side: runs to the space before the next quoted token, or to the end.
      const q = s.indexOf(' "', i);
      const end = q === -1 ? s.length : q;
      out.push(s.slice(i, end));
      i = end;
    }
  }
  return out.length === 2 ? out : null;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

// git quotes paths with unusual bytes as C strings: "caf\303\251.txt".
// Decodes \ooo octal bytes as UTF-8 and the \t \n \" \\ escapes. Literal runs
// are encoded whole, so a character outside the BMP (an emoji left raw under
// core.quotePath=false) keeps both halves of its surrogate pair together.
export function unquotePath(p) {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const inner = p.slice(1, -1);
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
      const oct = inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
      bytes.push(parseInt(oct, 8));
      i += oct.length;
    } else {
      const map = { t: 9, n: 10, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(map[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  flush();
  return utf8Decoder.decode(Uint8Array.from(bytes));
}

// git's "@@ -a,b +c,d @@ context" label for a parsed hunk. Like git, a count of
// 1 is left out. Counts come from the parsed lines, so the label always matches
// what is shown even when the input header was off.
export function hunkLabel(h) {
  const oldCount = h.lines.filter((l) => l.type !== 'add').length;
  const newCount = h.lines.filter((l) => l.type !== 'del').length;
  return `@@ -${hunkRange(h.oldStart, oldCount)} +${hunkRange(h.newStart, newCount)} @@ ${h.header}`.trimEnd();
}

function hunkRange(start, count) {
  return count === 1 ? String(start) : `${start},${count}`;
}

// Human/LLM-readable dump with old and new line numbers on every line, so a
// story author can copy anchor numbers instead of counting. Format per line:
// "<old:5> <new:5> <marker><content>", "-" where a side has no number.
export function formatNumbered(files) {
  const out = [];
  for (const f of files) {
    const how = f.status === 'renamed' ? `renamed from ${f.oldPath}` : f.status;
    const mode = f.hunks.length ? modeNote(f) : null; // header-only files say it in their reason line
    out.push(`=== ${f.path} (${how}${mode ? `, ${mode}` : ''})`);
    const reason = headerOnlyReason(f);
    if (reason) { out.push(`(${reason})`); continue; }
    out.push('  old   new  line');
    for (const h of f.hunks) {
      out.push(hunkLabel(h));
      for (const l of h.lines) {
        const marker = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
        out.push(`${String(l.old ?? '-').padStart(5)} ${String(l.new ?? '-').padStart(5)} ${marker}${l.content}`);
      }
    }
  }
  return out.join('\n') + '\n';
}

// A permission change worth showing next to the content change: an edited file
// that also became executable, or a new script created executable. null otherwise.
export function modeNote(f) {
  if (f.oldMode && f.newMode) return `mode ${f.oldMode} → ${f.newMode}`;
  if (f.status === 'added' && f.newMode && f.newMode !== '100644') return `mode ${f.newMode}`;
  return null;
}

// Why a file has no hunks to show: 'binary', 'mode' (mode-only change),
// 'rename' (pure rename), 'empty' (an empty file added or deleted, or a pure
// copy under diff.renames=copies); null when it has hunks to show.
export function headerOnlyKind(f) {
  if (f.binary) return 'binary';
  if (f.hunks.length > 0) return null;
  if (f.oldMode && f.newMode) return 'mode';
  if (f.status === 'renamed') return 'rename';
  return 'empty';
}

// The kind as one line of text for the numbered dump; null when the file has hunks.
export function headerOnlyReason(f) {
  switch (headerOnlyKind(f)) {
    case 'binary': return 'binary';
    case 'mode': return `mode ${f.oldMode} → ${f.newMode}, no content change`;
    case 'rename': return 'no content change';
    case 'empty': return f.status === 'added' || f.status === 'deleted' ? 'empty file' : 'no content change';
    default: return null;
  }
}
