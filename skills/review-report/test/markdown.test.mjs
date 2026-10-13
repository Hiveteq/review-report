// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderMarkdown } from '../lib/markdown.mjs';

test('escapeHtml covers the five characters', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('paragraphs and inline marks', () => {
  assert.equal(
    renderMarkdown('Hello **bold** and _em_ with `code<b>` and [link](https://x.y).\n\nSecond para.'),
    '<p>Hello <strong>bold</strong> and <em>em</em> with <code>code&lt;b&gt;</code> and <a href="https://x.y">link</a>.</p>\n<p>Second para.</p>',
  );
});

test('markup inside code spans is not converted', () => {
  assert.equal(renderMarkdown('use `a ** b ** c`'), '<p>use <code>a ** b ** c</code></p>');
});

test('raw html is escaped, not passed through (Review Focus 3)', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('lists, headings and fenced code', () => {
  assert.equal(
    renderMarkdown('# Title\n- one\n- two `x`\n1. first\n2. second\n```bash\nmake test <x\n```'),
    '<h3>Title</h3>\n<ul><li>one</li><li>two <code>x</code></li></ul>\n<ol><li>first</li><li>second</li></ol>\n<pre><code class="language-bash">make test &lt;x</code></pre>',
  );
});

test('multi-line paragraph joins with a space; CRLF tolerated', () => {
  assert.equal(renderMarkdown('line one\r\nline two'), '<p>line one line two</p>');
});

test('underscores inside words are not italics', () => {
  assert.equal(renderMarkdown('snake_case_name stays'), '<p>snake_case_name stays</p>');
});

test('links only allow http, https, mailto, anchors and relative paths', () => {
  assert.equal(renderMarkdown("[x](javascript:alert(1))"), '<p>[x](javascript:alert(1))</p>');
  assert.equal(renderMarkdown('[x](JAVASCRIPT:alert(1))'), '<p>[x](JAVASCRIPT:alert(1))</p>');
  assert.equal(renderMarkdown('[x](data:text/html,hi)'), '<p>[x](data:text/html,hi)</p>');
  assert.equal(renderMarkdown('[a](https://x.y) [b](#chapter-2) [c](docs/x.md) [d](mailto:me@x.y)'),
    '<p><a href="https://x.y">a</a> <a href="#chapter-2">b</a> <a href="docs/x.md">c</a> <a href="mailto:me@x.y">d</a></p>');
});

test('a scheme hidden behind a control character is still not a link', () => {
  // Browsers strip leading C0 controls before parsing, so this would run as javascript:.
  assert.equal(renderMarkdown('[x](\u0001javascript:alert%281%29)'), '<p>[x](\u0001javascript:alert%281%29)</p>');
  assert.equal(renderMarkdown('[x](\u001fJAVASCRIPT:alert%281%29)'), '<p>[x](\u001fJAVASCRIPT:alert%281%29)</p>');
  assert.equal(renderMarkdown('[q](docs/it&s.md?a=1&b=2)'), '<p><a href="docs/it&amp;s.md?a=1&amp;b=2">q</a></p>');
});

test('an ordered list interrupted by a code block keeps its numbering', () => {
  assert.equal(
    renderMarkdown('1. Build:\n```bash\nmake build\n```\n2. Run:\n```bash\nmake test\n```\n3. Open the page.'),
    '<ol><li>Build:</li></ol>\n<pre><code class="language-bash">make build</code></pre>\n<ol start="2"><li>Run:</li></ol>\n<pre><code class="language-bash">make test</code></pre>\n<ol start="3"><li>Open the page.</li></ol>',
  );
});

test('a mermaid fence renders as an in-place diagram with escaped source', () => {
  assert.equal(
    renderMarkdown('Before.\n```mermaid\nflowchart LR\n  A --> B & C\n```\nAfter.'),
    '<p>Before.</p>\n<figure class="diagram"><pre class="mermaid" data-source="flowchart LR\n  A --&gt; B &amp; C">flowchart LR\n  A --&gt; B &amp; C</pre></figure>\n<p>After.</p>',
  );
});
