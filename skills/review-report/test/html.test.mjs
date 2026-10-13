// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDiff } from '../lib/diff.mjs';
import { buildReport } from '../lib/story.mjs';
import { renderHtml } from '../lib/html.mjs';
import { CDN } from '../lib/cdn.mjs';

const fixtureText = readFileSync(new URL('./fixture.diff', import.meta.url), 'utf8');
const files = parseDiff(fixtureText);
const story = JSON.parse(readFileSync(new URL('./fixture.story.json', import.meta.url), 'utf8'));
const assets = { css: 'body{--marker:css}', js: 'window.__marker="js";' };
const html = renderHtml(story, buildReport(story, files), files, assets);

test('embeds title, assets and CDN links', () => {
  assert.match(html, /<title>Greeter takes a Name value object<\/title>/);
  assert.ok(html.includes('body{--marker:css}'));
  assert.ok(html.includes('window.__marker="js";'));
  assert.ok(html.includes(`<script src="${CDN.hljs.url}"`));
  assert.ok(html.includes(`<script src="${CDN.mermaid.url}"`));
  assert.match(html, /id="hljs-light"/);
  assert.match(html, /id="hljs-dark"/);
});

test('renders overview and how-to-test; diagram sits inside the big picture, no separate section', () => {
  assert.match(html, /<h2 id="overview">/);
  assert.match(html, /<h2 id="how-to-test">/);
  const big = html.indexOf('<h3>Where this change sits</h3>');
  const why = html.indexOf('<h3>Why this change</h3>');
  const diagram = html.indexOf('<pre class="mermaid" data-source="flowchart LR');
  assert.ok(big < diagram && diagram < why, 'diagram rendered inside the big-picture part');
  assert.ok(!html.includes('id="diagrams"'));
  assert.ok(html.includes(CDN.mermaid.url));
});

test('chapter diff rows carry old and new numbers and language class', () => {
  assert.match(html, /<tr class="line del" data-old="4" data-new="">/);
  assert.match(html, /<tr class="line add" data-old="" data-new="4">/);
  assert.match(html, /<code class="language-java"> {4}public String greet\(Name name\) \{<\/code>/);
});

test('comment rows follow their anchor line on the right side', () => {
  const newAnchor = html.indexOf('<tr class="line add" data-old="" data-new="4">');
  const newComment = html.indexOf('<tr class="comment" data-anchor-side="new" data-anchor-line="4">');
  assert.ok(newAnchor > 0 && newComment > newAnchor, 'new-side comment after its line');
  const between = html.slice(newAnchor + 1, newComment);
  assert.ok(!between.includes('<tr class="line'), 'no other line row between anchor and comment');

  const oldAnchor = html.indexOf('<tr class="line del" data-old="5" data-new="">');
  const oldComment = html.indexOf('<tr class="comment" data-anchor-side="old" data-anchor-line="5">');
  assert.ok(oldComment > oldAnchor && !html.slice(oldAnchor + 1, oldComment).includes('<tr class="line'));
});

test('comment text is markdown-rendered and escaped', () => {
  assert.match(html, /<code>equals<\/code>, <code>hashCode<\/code>/);
});

test('appendix lists only unreferenced hunks and file index counts every file', () => {
  assert.match(html, /<h2 id="appendix">Other changes<\/h2>/);
  const appendix = html.slice(html.indexOf('id="appendix"'));
  assert.ok(appendix.includes('data-path="README.md"'));
  assert.ok(appendix.includes('@@ -1,2 +1,2 @@'));
  assert.ok(!appendix.includes('@@ -10,3 +10,3 @@'));
  assert.match(html, /<nav[^>]*class="file-index"[\s\S]*src\/Greeter\.java[\s\S]*<span class="add">\+3<\/span><span class="del">-2<\/span>/);
});

test('html chapters pass through unescaped; deleted and renamed files are labelled', () => {
  assert.ok(html.includes('<table><tr><th>Caller</th>'));
  assert.match(html, /<span class="status deleted">deleted<\/span>/);
  assert.match(html, /docs\/old name\.md → docs\/new näme\.md/);
});

test('omits empty sections and the mermaid script when no diagram is present (Review Focus 4)', () => {
  const bare = { ...story, overview: { ...story.overview, bigPicture: 'Plain text only.' }, howToTest: undefined };
  const out = renderHtml(bare, buildReport(bare, files), files, assets);
  assert.ok(!out.includes('id="how-to-test"'));
  assert.ok(!out.includes('cdn.jsdelivr.net/npm/mermaid'));
});

test('diff tables declare column widths via colgroup so fixed layout honours them', () => {
  assert.match(html, /<table class="diff unified"><colgroup><col class="num"><col class="num"><col class="code"><\/colgroup>/);
});

test('sidebar has a notes layout toggle and the page defaults to margin notes', () => {
  assert.match(html, /<button id="notes-toggle"/);
  assert.match(html, /<html lang="en" data-theme="light" data-notes="margin" data-diff="unified" data-report-id="[a-z0-9-]+">/);
});

test('renders the glossary as a key-terms section after the overview', () => {
  const g = { ...story, glossary: [{ term: 'Greeter', meaning: 'The class that builds the greeting text. Lives in `src/`.' }] };
  const out = renderHtml(g, buildReport(g, files), files, assets);
  const overview = out.indexOf('<h2 id="overview">');
  const terms = out.indexOf('<h2 id="key-terms">New terms</h2>');
  assert.ok(terms > overview, 'key terms after overview');
  assert.match(out, /<dt>Greeter<\/dt><dd>The class that builds the greeting text\. Lives in <code>src\/<\/code>\.<\/dd>/);
  assert.match(out, /<li><a href="#key-terms">New terms<\/a><\/li>/);
});

test('header-only files render in the appendix with a reason and a real file-index anchor', () => {
  assert.match(html, /data-path="img\/logo\.png"[\s\S]*?Binary file, no textual diff\./);
  assert.match(html, /data-path="scripts\/run\.sh"[\s\S]*?<p class="muted">Mode changed 100644 → 100755, no content change\.<\/p>/);
  assert.match(html, /docs\/moved\.md → docs\/renamed\.md[\s\S]*?<p class="muted">Renamed, no content change\.<\/p>/);
  const ids = [...html.matchAll(/<(?:section|details) class="file[^"]*" id="(file-\d+-c)"/g)].map((m) => m[1]);
  const links = [...html.matchAll(/<a href="#(file-\d+-c)" data-file=/g)].map((m) => m[1]);
  for (const l of links) assert.ok(ids.includes(l), `file index link ${l} has no target`);
  assert.equal(new Set(ids).size, ids.length, 'file anchors are unique');
});

test('an empty added file is labelled as such, not as a rename', () => {
  const extra = parseDiff(`${fixtureText}diff --git a/pkg/__init__.py b/pkg/__init__.py\nnew file mode 100644\nindex 0000000..e69de29\n`);
  const out = renderHtml(story, buildReport(story, extra), extra, assets);
  assert.match(out, /data-path="pkg\/__init__\.py"[\s\S]*?<span class="status added">added<\/span>[\s\S]*?<p class="muted">Empty file added\.<\/p>/);
  assert.ok(!/data-path="pkg\/__init__\.py"[\s\S]{0,600}Renamed/.test(out));
});

test('the mermaid script is loaded only when the page has a diagram', () => {
  assert.ok(html.includes(`<script src="${CDN.mermaid.url}"`));
  const bare = { ...story, overview: { ...story.overview, bigPicture: 'No diagram here.' } };
  assert.ok(!renderHtml(bare, buildReport(bare, files), files, assets).includes('cdn.jsdelivr.net/npm/mermaid'));
});

test('hunk header rows use git\'s label format', () => {
  assert.match(html, /<tr class="hunk-header"><td colspan="3">@@ -1 \+1 @@<\/td><\/tr>/);
  assert.match(html, /<tr class="hunk-header"><td colspan="3">@@ -1,7 \+1,8 @@ package demo;<\/td><\/tr>/);
});

test('only the first block of a file carries an id', () => {
  const twice = { ...story, chapters: [...story.chapters, { title: 'again', intro: 'Same file again. Shown twice on purpose.', hunks: [{ file: 'src/Name.java', lines: 'all' }] }] };
  const out = renderHtml(twice, buildReport(twice, files), files, assets);
  assert.equal((out.match(/<section class="file" id="file-2-c"/g) ?? []).length, 1);
  assert.equal((out.match(/<section class="file" data-path="src\/Name\.java"/g) ?? []).length, 1);
});

test('a permission change next to a content change shows as a badge', () => {
  const withMode = parseDiff(fixtureText.replace('diff --git a/src/Greeter.java b/src/Greeter.java\nindex 1111111..2222222 100644\n', 'diff --git a/src/Greeter.java b/src/Greeter.java\nold mode 100644\nnew mode 100755\nindex 1111111..2222222\n'));
  const out = renderHtml(story, buildReport(story, withMode), withMode, assets);
  assert.match(out, /data-path="src\/Greeter\.java" data-hash="[0-9a-f]{8}">[\s\S]*?<span class="status mode">mode 100644 → 100755<\/span>/);
  assert.ok(!html.includes('class="status mode"'), 'no badge without a mode change');
});

test('file index links carry the full path as a title', () => {
  assert.match(html, /<a href="#file-1-c" data-file="src\/Greeter\.java" title="src\/Greeter\.java">/);
});

test('overview renders its four parts as sub-sections in order', () => {
  const parts = ['Where this change sits', 'Why this change', 'What changes', 'How to read this report'];
  const idx = parts.map((p) => html.indexOf(`<h3>${p}</h3>`));
  assert.ok(idx.every((i) => i > html.indexOf('<h2 id="overview">')), idx.join(','));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'parts in order');
  assert.match(html, /<h3>Where this change sits<\/h3>\s*<p><code>Greeter<\/code> builds/);
});

test('report header shows coverage and the appendix names what was excluded and why', () => {
  assert.match(html, /<p class="coverage">12 of 14 changed lines shown in chapters \(86%\)\. Reader pass: 1 round, 2 questions answered, none open\.<\/p>/);
  assert.match(html, /<details class="excluded"><summary>Excluded from the count: 3 files<\/summary><ul><li>docs\/new näme\.md <span class="muted">docs: prose, not code<\/span><\/li><li>img\/logo\.png <span class="muted">binary<\/span><\/li><li>img\/photo\.jpg <span class="muted">binary<\/span><\/li><\/ul><\/details>/);
});

test('paged rendering: an index page plus one page per chapter, linked both ways', async () => {
  const { renderPages } = await import('../lib/html.mjs');
  const pages = renderPages(story, buildReport(story, files), files, assets, { paged: true });
  assert.deepEqual(pages.map((p) => p.path), ['index.html', 'chapter-01.html', 'chapter-02.html', 'chapter-03.html', 'chapter-04.html', 'chapter-05.html', 'other-changes.html']);
  const index = pages[0].html;
  assert.match(index, /<h2 id="overview">Overview<\/h2>/);
  assert.match(index, /<h2 id="key-terms">New terms<\/h2>/);
  assert.match(index, /<p class="coverage">12 of 14 changed lines shown in chapters/);
  assert.match(index, /<details class="excluded">/);
  assert.ok(!pages[2].html.includes('<details class="excluded">'), 'chapter pages carry only the numbers');
  assert.match(index, /<h2 id="chapters">Chapters<\/h2>/);
  assert.match(index, /<a href="chapter-02\.html">2\. Greeter adopts Name<\/a>/);
  assert.ok(!index.includes('<table class="diff'), 'index carries no diff tables');
  const ch2 = pages[2].html;
  assert.match(ch2, /<title>2\. Greeter adopts Name · Greeter takes a Name value object<\/title>/);
  assert.match(ch2, /<h2 id="chapter-2">2\. Greeter adopts Name<\/h2>/);
  assert.match(ch2, /data-path="src\/Greeter\.java"/);
  assert.ok(!ch2.includes('data-path="src/Name.java"'), 'other chapters are not on this page');
  assert.match(ch2, /<a class="prev" href="chapter-01\.html">/);
  assert.match(ch2, /<a class="next" href="chapter-03\.html">/);
  assert.match(ch2, /<li class="current" data-files="src\/Greeter\.java"><a href="chapter-02\.html">2\. Greeter adopts Name<\/a>/);
  assert.match(ch2, /<li><a href="index\.html#overview">Overview<\/a><\/li>/);
  // file index links point at the page holding the file's first block
  assert.match(ch2, /<a href="chapter-01\.html#file-2-c" data-file="src\/Name\.java"/);
  assert.match(ch2, /<a href="other-changes\.html#file-6-c" data-file="img\/logo\.png"/);
  assert.match(pages[6].html, /<h2 id="appendix">Other changes<\/h2>/);
  assert.match(pages[6].html, /<a class="prev" href="chapter-05\.html">/);
  assert.ok(!pages[6].html.includes('class="next"'));
});

test('single-page rendering is unchanged and renderPages returns one page for it', async () => {
  const { renderPages } = await import('../lib/html.mjs');
  const pages = renderPages(story, buildReport(story, files), files, assets, { paged: false });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].path, 'index.html');
  assert.equal(pages[0].html, html);
});

test('excluded files in Other changes are collapsed with their reason; unreferenced source stays open', () => {
  const ap = html.slice(html.indexOf('id="appendix"'));
  assert.match(ap, /<details class="file excluded"[^>]*data-path="img\/logo\.png"><summary class="file-header"><span class="path">img\/logo\.png<\/span><span class="status added">added<\/span><span class="muted">excluded: binary<\/span><\/summary>/);
  assert.match(ap, /<section class="file"[^>]*data-path="README\.md" data-hash="[0-9a-f]{8}">/);
});

test('paged sidebar lists the files on this page first, then all files collapsed', async () => {
  const { renderPages } = await import('../lib/html.mjs');
  const pages = renderPages(story, buildReport(story, files), files, assets, { paged: true });
  const ch2 = pages[2].html;
  assert.match(ch2, /<h3>Files on this page<\/h3>\s*<nav class="file-index"><ul><li><a href="#file-1-c" data-file="src\/Greeter\.java"/);
  assert.match(ch2, /<details class="all-files"><summary>All files \(9\)<\/summary><nav class="file-index">/);
});

test('every page carries a stable report id and each file block a content hash, for viewed state', async () => {
  const { renderPages } = await import('../lib/html.mjs');
  const pages = renderPages(story, buildReport(story, files), files, assets, { paged: true });
  const ids = pages.map((p) => /<html [^>]*data-report-id="([a-z0-9-]+)"/.exec(p.html)?.[1]);
  assert.ok(ids.every((id) => id && id === ids[0]), `one id on every page: ${ids}`);
  assert.match(/** @type {string} */ (ids[0]), /^greeter-takes-a-name-value-object-[0-9a-f]{8}$/); // the check above found an id
  const other = { ...story, meta: { ...story.meta, title: 'Other title' } };
  // Cannot be null: every rendered page carries a report id.
  const otherId = /** @type {RegExpExecArray} */ (/data-report-id="([a-z0-9-]+)"/.exec(renderHtml(other, buildReport(other, files), files, assets)))[1];
  assert.notEqual(otherId, ids[0]);
  assert.match(html, /<section class="file" id="file-1-c" data-path="src\/Greeter\.java" data-hash="[0-9a-f]{8}">/);
});

test('file headers carry a manual Viewed checkbox; no per-file split button', () => {
  assert.match(html, /<header class="file-header"><span class="path">src\/Greeter\.java<\/span><label class="viewed"><input type="checkbox" class="viewed-toggle"> Viewed<\/label><\/header>/);
  assert.ok(!html.includes('split-toggle'));
});

test('sidebar has one global diff toggle and a viewed progress rail', () => {
  assert.match(html, /<div class="sidebar-top">\s*<button id="theme-toggle"[^>]*>Theme<\/button>\s*<button id="notes-toggle"[^>]*>Notes: margin<\/button>\s*<button id="diff-toggle" type="button" title="[^"]*">Diff: unified<\/button>\s*<\/div>/);
  assert.match(html, /<h3>Files<\/h3>\s*<div class="viewed-progress"><span class="viewed-count" data-total="6">0 of 6 viewed<\/span><div class="rail"><div class="fill"><\/div><\/div><\/div>/);
});

test('index chapter list carries the files of each chapter so viewed counts can be shown per chapter', async () => {
  const { renderPages } = await import('../lib/html.mjs');
  const index = renderPages(story, buildReport(story, files), files, assets, { paged: true })[0].html;
  assert.match(index, /<li data-files="src\/Name\.java"><a href="chapter-01\.html">1\. The new Name type<\/a>/);
  assert.match(index, /<li data-files="src\/Greeter\.java"><a href="chapter-02\.html">/);
});

test('sidebar chapter entries and chapter headings carry their file list for the viewed marker', async () => {
  const { renderPages } = await import('../lib/html.mjs');
  const pages = renderPages(story, buildReport(story, files), files, assets, { paged: true });
  const ch2 = pages[2].html;
  assert.match(ch2, /<li class="current" data-files="src\/Greeter\.java"><a href="chapter-02\.html">2\. Greeter adopts Name<\/a><span class="chapter-progress"><\/span><\/li>/);
  assert.match(ch2, /<li data-files="src\/Name\.java"><a href="chapter-01\.html">1\. The new Name type<\/a><span class="chapter-progress"><\/span><\/li>/);
  assert.match(ch2, /<section class="chapter" data-files="src\/Greeter\.java"><h2 id="chapter-2">2\. Greeter adopts Name<\/h2><p class="chapter-viewed"><\/p>/);
  // html chapters have no files and no marker
  assert.match(pages[5].html, /<li class="current"><a href="chapter-05\.html">5\. Migration checklist<\/a><\/li>/);
});

test('every CDN file is pinned to an exact version with a subresource-integrity hash', () => {
  const tags = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="https:\/\/[^"]+"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tags.length, 4, tags.join('\n')); // highlight.js script, two theme stylesheets, Mermaid
  for (const tag of tags) {
    assert.match(tag, /integrity="sha384-[A-Za-z0-9+/]{64}"/, tag);
    assert.match(tag, /crossorigin="anonymous"/, tag);
    assert.doesNotMatch(tag, /mermaid@11\//, 'Mermaid must be pinned to an exact version, not a major');
  }
  for (const file of Object.values(CDN)) {
    assert.match(file.url, /@?\d+\.\d+\.\d+\//, `${file.url} carries an exact version`);
    assert.ok(html.includes(`"${file.url}"`) || file.url.includes('mermaid'), `${file.url} is used`);
  }
});
