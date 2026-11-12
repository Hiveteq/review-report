// @ts-check
// Minimal Markdown → HTML for story prose. Deliberately small: the story is
// written by Claude, so it only needs the constructs listed in the test file.
// Everything is escaped first; no raw HTML passes through.

/** @type {Record<string, string>} */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * @param {unknown} s any value; it is converted to text first
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/**
 * What a block parser returns: its HTML ('' for a block that renders nothing) and the line after the block.
 * @typedef {{ html: string, next: number }} Block
 */

/**
 * A block kind: `start` recognises its first line, and `parse` consumes the block from there. `parse` gets the
 * `start` match, so a parser does not re-run the pattern that picked it.
 * @typedef {object} BlockParser
 * @property {RegExp} start
 * @property {(lines: string[], i: number, match: RegExpExecArray) => Block} parse
 */

const FENCE = /^```/;
const BULLET = /^[-*] /;
const ORDERED = /^(\d+)\. /;
// The `s` flag lets the heading text run to the end of the line even past a stray \r, U+2028 or U+2029.
// Lines are already split on \n, so it never reaches into the next line.
const HEADING = /^(#{1,4}) (.*)$/s;

/**
 * Tried in order on the first line of each block. A line no parser claims starts a paragraph.
 * @type {readonly BlockParser[]}
 */
const BLOCKS = Object.freeze([
  { start: FENCE, parse: fence },
  { start: HEADING, parse: heading },
  { start: BULLET, parse: bulletList },
  { start: ORDERED, parse: orderedList },
  { start: /^\s*$/, parse: (lines, i) => ({ html: '', next: i + 1 }) },
]);

/**
 * Whether a line begins a block other than a paragraph, which is where a paragraph ends.
 * @param {string} line
 * @returns {boolean}
 */
const startsBlock = (line) => BLOCKS.some(({ start }) => start.test(line));

/**
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  /** @type {string[]} */
  const out = [];
  // A cursor over the lines: each block consumes a run of them and says where the next block begins.
  let i = 0;
  while (i < lines.length) {
    const { html, next } = parseBlock(lines, i);
    if (html) out.push(html);
    i = next;
  }
  return out.join('\n');
}

/**
 * Parses the block that begins at line i.
 * @param {string[]} lines
 * @param {number} i
 * @returns {Block}
 */
function parseBlock(lines, i) {
  // A loop, not find: the match that picked the parser is handed to it.
  for (const { start, parse } of BLOCKS) {
    const match = start.exec(lines[i]);
    if (match) return parse(lines, i, match);
  }
  return paragraph(lines, i);
}

/**
 * A fenced code block. An unclosed fence runs to the end of the text.
 * @param {string[]} lines
 * @param {number} i
 * @returns {Block}
 */
function fence(lines, i) {
  const lang = lines[i].slice(3).trim() || 'plaintext';
  let close = i + 1;
  while (close < lines.length && !FENCE.test(lines[close])) close++;
  const body = escapeHtml(lines.slice(i + 1, close).join('\n'));
  // A mermaid fence is a diagram, drawn where it sits in the prose. The page
  // script renders pre.mermaid from data-source and re-renders on theme change.
  const html = lang === 'mermaid'
    ? `<figure class="diagram"><pre class="mermaid" data-source="${body}">${body}</pre></figure>`
    : `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`;
  return { html, next: close + 1 };
}

/**
 * @param {string[]} lines
 * @param {number} i
 * @param {RegExpExecArray} match groups: the hashes, then the heading text
 * @returns {Block}
 */
function heading(lines, i, match) {
  const level = match[1].length + 2; // # → h3, so it nests under the report's h2 sections
  return { html: `<h${level}>${inline(match[2])}</h${level}>`, next: i + 1 };
}

/**
 * @param {string[]} lines
 * @param {number} i
 * @param {RegExpExecArray} first the match on the first item
 * @returns {Block}
 */
function bulletList(lines, i, first) {
  const items = [first, ...matchRun(lines, i + 1, BULLET)];
  return { html: `<ul>${listItems(items)}</ul>`, next: i + items.length };
}

/**
 * @param {string[]} lines
 * @param {number} i
 * @param {RegExpExecArray} first the match on the first item; group 1 is its number
 * @returns {Block}
 */
function orderedList(lines, i, first) {
  const items = [first, ...matchRun(lines, i + 1, ORDERED)];
  // A list interrupted by a code block continues as a new <ol>; keeping the
  // source number as `start` stops it from renumbering from 1.
  const start = Number(first[1]);
  return { html: `<ol${start === 1 ? '' : ` start="${start}"`}>${listItems(items)}</ol>`, next: i + items.length };
}

/**
 * Lines up to the next blank line or block start, joined into one paragraph.
 * @param {string[]} lines
 * @param {number} i a line no block parser claims
 * @returns {Block}
 */
function paragraph(lines, i) {
  let next = i + 1;
  while (next < lines.length && !startsBlock(lines[next])) next++;
  return { html: `<p>${inline(lines.slice(i, next).join(' '))}</p>`, next };
}

/**
 * Matches `pattern` against each line from `from` on, stopping at the first line it does not match.
 * @param {string[]} lines
 * @param {number} from
 * @param {RegExp} pattern
 * @returns {RegExpExecArray[]}
 */
function matchRun(lines, from, pattern) {
  /** @type {RegExpExecArray[]} */
  const matches = [];
  // A loop with an early exit: the run ends at the first line that does not match.
  for (let k = from; k < lines.length; k++) {
    const match = pattern.exec(lines[k]);
    if (!match) break;
    matches.push(match);
  }
  return matches;
}

/**
 * List items from their marker matches: the text after the marker, with inline marks.
 * @param {RegExpExecArray[]} items
 * @returns {string}
 */
const listItems = (items) => items.map((m) => `<li>${inline(m.input.slice(m[0].length))}</li>`).join('');

// Only web links, mail links, in-page anchors and relative paths become anchors.
// The URL is parsed the way a browser will parse the href (WHATWG URL): leading
// control characters and whitespace are dropped and the scheme is case-folded,
// so "\u0001javascript:" or "JAVASCRIPT:" is still seen as javascript: and left
// as text. Relative paths and #anchors resolve against the placeholder base.
/**
 * @param {string} url
 * @returns {boolean}
 */
function safeUrl(url) {
  let parsed;
  try { parsed = new URL(url, 'https://example.invalid/'); } catch { return false; }
  return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
}

// Inline marks. Code spans are lifted out first so their contents are never
// touched by the bold/italic/link passes, then spliced back in.
/**
 * @param {string} text
 * @returns {string}
 */
function inline(text) {
  /** @type {string[]} */
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])[_*]([^_*\s](?:[^_*]*?[^_*\s])?)[_*](?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, url) => (safeUrl(url) ? `<a href="${url}">${label}</a>` : all));
  // eslint-disable-next-line no-control-regex -- NUL brackets the code-span placeholders set above, on purpose.
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]);
}
