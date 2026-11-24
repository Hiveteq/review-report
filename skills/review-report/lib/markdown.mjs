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

const FENCE = /^```/;
const BULLET = /^[-*] /;
const ORDERED = /^(\d+)\. /;
const BLANK = /^\s*$/;
// The `s` flag lets the heading text run to the end of the line even past a stray \r, U+2028 or U+2029.
// Lines are already split on \n, so it never reaches into the next line. Without it such a line matched no
// block yet still ended a paragraph, and the loop below never moved past it.
const HEADING = /^(#{1,4}) (.*)$/s;

/**
 * Whether a line begins a block other than a paragraph, which is where a paragraph ends.
 * It uses the same patterns as the block checks in renderMarkdown, so the two always agree.
 * @param {string} line
 * @returns {boolean}
 */
function startsBlock(line) {
  return FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || BLANK.test(line);
}

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
    const line = lines[i];
    const heading = HEADING.exec(line);
    if (FENCE.test(line)) {
      const block = fence(lines, i);
      out.push(block.html);
      i = block.next;
    } else if (heading) {
      const level = heading[1].length + 2; // # → h3, so it nests under the report's h2 sections
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
    } else if (BULLET.test(line) || ORDERED.test(line)) {
      const block = list(lines, i);
      out.push(block.html);
      i = block.next;
    } else if (BLANK.test(line)) {
      i++;
    } else {
      // A paragraph: this line and the ones after it, up to the next blank line or block start.
      let next = i + 1;
      while (next < lines.length && !startsBlock(lines[next])) next++;
      out.push(`<p>${inline(lines.slice(i, next).join(' '))}</p>`);
      i = next;
    }
  }
  return out.join('\n');
}

/**
 * A fenced code block. An unclosed fence runs to the end of the text.
 * @param {string[]} lines
 * @param {number} i the opening fence
 * @returns {{ html: string, next: number }} next is the line after the closing fence
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
 * A bulleted or numbered list: the run of lines that carry the same kind of marker as line i.
 * @param {string[]} lines
 * @param {number} i the first item
 * @returns {{ html: string, next: number }} next is the line after the last item
 */
function list(lines, i) {
  const first = ORDERED.exec(lines[i]);
  const marker = first ? ORDERED : BULLET;
  /** @type {string[]} */
  const items = [];
  let next = i;
  // A loop with an early exit: the list ends at the first line without a marker of its kind.
  for (; next < lines.length; next++) {
    const match = marker.exec(lines[next]);
    if (!match) break;
    items.push(`<li>${inline(lines[next].slice(match[0].length))}</li>`);
  }
  if (!first) return { html: `<ul>${items.join('')}</ul>`, next };
  // A list interrupted by a code block continues as a new <ol>; keeping the
  // source number as `start` stops it from renumbering from 1.
  const start = Number(first[1]);
  return { html: `<ol${start === 1 ? '' : ` start="${start}"`}>${items.join('')}</ol>`, next };
}

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
