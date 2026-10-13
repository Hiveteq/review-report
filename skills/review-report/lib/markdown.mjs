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

const BLOCK_START = /^(```|#{1,4} |[-*] |\d+\. )/;

/**
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  /** @type {string[]} */
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || 'plaintext';
      /** @type {string[]} */
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // closing fence
      const body = escapeHtml(buf.join('\n'));
      // A mermaid fence is a diagram, drawn where it sits in the prose. The page
      // script renders pre.mermaid from data-source and re-renders on theme change.
      if (lang === 'mermaid') out.push(`<figure class="diagram"><pre class="mermaid" data-source="${body}">${body}</pre></figure>`);
      else out.push(`<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,4}) (.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length + 2; // # → h3, so it nests under the report's h2 sections
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^[-*] /.test(line)) {
      /** @type {string[]} */
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\. /.test(line)) {
      // A list interrupted by a code block continues as a new <ol>; keeping the
      // source number as `start` stops it from renumbering from 1.
      // Cannot be null: the test above matched the same pattern.
      const start = Number(/** @type {RegExpExecArray} */ (/^(\d+)\. /.exec(line))[1]);
      /** @type {string[]} */
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\d+\. /, ''))}</li>`);
      out.push(`<ol${start === 1 ? '' : ` start="${start}"`}>${items.join('')}</ol>`);
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    /** @type {string[]} */
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !BLOCK_START.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
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
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, url) => (safeUrl(url) ? `<a href="${url}">${text}</a>` : all));
  // eslint-disable-next-line no-control-regex -- NUL brackets the code-span placeholders set above, on purpose.
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]);
}
