// @ts-check
// Assembles the report pages. Pure: takes the story, the built report, the parsed files, their
// coverage and the asset strings, and returns HTML. DOM class/id names here are a contract with
// template/report.js and template/report.css; change them together.
import { createHash } from 'node:crypto';
import { CDN, pin } from './cdn.mjs';
import { escapeHtml as esc, renderMarkdown as md } from './markdown.mjs';
import { HEADER_ONLY, headerOnlyKind, hunkLabel, lineStats, modeNote } from './diff.mjs';
import { firstBy, groupBy } from './collections.mjs';

/** @typedef {import('./diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./diff.mjs').Hunk} Hunk */
/** @typedef {import('./diff.mjs').DiffLine} DiffLine */
/** @typedef {import('./story.mjs').Story} Story */
/** @typedef {import('./story.mjs').Report} Report */
/** @typedef {import('./story.mjs').ReportChapter} ReportChapter */
/** @typedef {import('./story.mjs').PlacedComment} PlacedComment */
/** @typedef {import('./coverage.mjs').Coverage} Coverage */

/**
 * The page script and stylesheet, inlined into every page.
 * @typedef {object} Assets
 * @property {string} css
 * @property {string} js
 */

/**
 * One HTML file of the report. path is relative to the report folder.
 * @typedef {object} Page
 * @property {string} path
 * @property {string} html
 */

/** @typedef {{ href: string, title: string }} PageLink */

/**
 * What makes one page different from the others.
 * @typedef {object} PageParts
 * @property {string} path the file name, such as index.html or chapter-02.html
 * @property {string} pageTitle for the <title>, escaped
 * @property {string} body
 * @property {PageLink | null} [prev] the page before, in reading order
 * @property {PageLink | null} [next] the page after
 */

/**
 * Everything about the report that does not depend on the page being rendered, worked out once.
 * @typedef {object} PageContext
 * @property {Story} story
 * @property {Report} report
 * @property {DiffFile[]} files
 * @property {Assets} assets
 * @property {boolean} paged
 * @property {string} reportId
 * @property {string} title the report title, escaped
 * @property {string} target what the report covers (a branch, a range), escaped; empty when unknown
 * @property {string} coverageLine
 * @property {string} excludedHtml the collapsed list of files the coverage count leaves out
 * @property {Map<DiffFile, string>} fileHashes
 * @property {Map<DiffFile, string>} anchorOf the id of the block the file index links to
 * @property {Map<DiffFile, BlockLocation>} firstLocationOf each file's first block in reading order: the
 *   one that carries its anchor id and, in the paged layout, the page the file index links to
 * @property {Map<string | undefined, DiffFile[]>} filesByPage the files whose first block is on each page
 * @property {string} fileIndexAll the sidebar list of every file
 * @property {string[]} chapterFiles per chapter, its paths for a data-files attribute
 * @property {Map<string, string>} excludedReason why the coverage count leaves a path out
 * @property {number} viewableTotal files the reader is asked to tick: the ones the count does not leave out
 */

/** @typedef {import('./story.mjs').Selection | import('./story.mjs').AppendixEntry} BlockEntry */

/**
 * A file block and the page it sits on in the paged layout.
 * @typedef {{ entry: BlockEntry, page: string }} BlockLocation
 */

const INDEX_PAGE = 'index.html';
const APPENDIX_PAGE = 'other-changes.html';

// Extension → highlight.js language name. Names the CDN bundle does not ship are
// skipped by the page script, so listing one is never worse than plaintext. A Map, so an
// extension named like an Object property (`.constructor`) finds nothing.
const LANG_BY_EXT = new Map(Object.entries({
  java: 'java', kt: 'kotlin', kts: 'kotlin', php: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', yml: 'yaml', yaml: 'yaml', md: 'markdown', sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', rb: 'ruby', swift: 'swift', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r',
  m: 'objectivec', graphql: 'graphql', gql: 'graphql', vb: 'vbnet', toml: 'ini', ini: 'ini', properties: 'properties',
  gradle: 'groovy', groovy: 'groovy', dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile',
}));

// Files named only by convention, with no extension to go by.
const LANG_BY_BASENAME = new Map([['dockerfile', 'dockerfile'], ['makefile', 'makefile']]);

// Where the page script (template/report.js) keeps the reader's display choices. The pre-paint snippet
// below reads them before that script loads, so both must use the same keys.
const STORAGE_KEYS = Object.freeze({ theme: 'review-report-theme', notes: 'review-report-notes', diff: 'review-report-diff' });

// Applies the stored display choices before first paint, so a dark-theme reader never sees a light flash.
// It mirrors the checks in report.js: an unknown stored value is ignored.
const PRE_PAINT = `(function(){try{var d=document.documentElement,t=localStorage.getItem('${STORAGE_KEYS.theme}');if(!t){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}d.dataset.theme=t;var n=localStorage.getItem('${STORAGE_KEYS.notes}');if(n==='inline'||n==='margin'){d.dataset.notes=n}var f=localStorage.getItem('${STORAGE_KEYS.diff}');if(f==='split'||f==='unified'){d.dataset.diff=f}}catch(e){}})();`;

/**
 * What a report is rendered from.
 * @typedef {object} RenderInput
 * @property {Story} story
 * @property {Report} report
 * @property {DiffFile[]} files
 * @property {Coverage} coverage the caller computes it once, since it also gates the run on it
 * @property {Assets} assets
 */

/**
 * The whole report as one page.
 * @param {RenderInput} input
 * @returns {string}
 */
export function renderHtml(input) {
  return renderPages({ ...input, paged: false })[0].html;
}

/**
 * Single layout: one index.html with the whole report. Paged layout: an index (overview, key terms, how to
 * test, chapter list) plus one page per chapter and one for "Other changes". A large report then stays one
 * story with one reading order, while each page stays small enough to load and lay out quickly.
 * @param {RenderInput & { paged: boolean }} input
 * @returns {Page[]}
 */
export function renderPages(input) {
  const ctx = buildContext(input);
  return ctx.paged ? pagedLayout(ctx) : [singlePage(ctx)];
}

/**
 * @param {RenderInput & { paged: boolean }} input
 * @returns {PageContext}
 */
function buildContext({ story, report, files, coverage, assets, paged }) {
  const hashes = files.map(fileHash);
  const anchorOf = new Map(files.map((f, i) => [f, `file-${i + 1}-c`]));
  const firstLocationOf = firstLocations(report);
  /**
   * @param {DiffFile} f
   * @returns {string | undefined} the page holding the file's first block
   */
  const pageOf = (f) => firstLocationOf.get(f)?.page;
  const excludedReason = new Map(coverage.excluded.map((e) => [e.path, e.reason]));
  return {
    story,
    report,
    files,
    assets,
    paged,
    reportId: reportIdFor(story.meta.title, hashes),
    title: esc(story.meta.title),
    target: story.meta.target ? esc(story.meta.target) : '',
    coverageLine: coverageLine(story, coverage),
    excludedHtml: excludedListHtml(coverage),
    fileHashes: new Map(files.map((f, i) => [f, hashes[i]])),
    anchorOf,
    firstLocationOf,
    filesByPage: groupBy(files, pageOf),
    // In the single layout every block is on the one page, so a link is just the fragment.
    fileIndexAll: files.map((f) => fileIndexItem(f, `${paged ? pageOf(f) ?? '' : ''}#${anchorOf.get(f)}`)).join(''),
    chapterFiles: report.chapters.map(chapterFileList),
    excludedReason,
    viewableTotal: files.filter((f) => !excludedReason.has(f.path)).length,
  };
}

/**
 * Every file block in reading order (the chapters, then Other changes), reduced to each file's first.
 * @param {Report} report
 * @returns {Map<DiffFile, BlockLocation>}
 */
function firstLocations(report) {
  /** @type {BlockLocation[]} */
  const locations = [
    ...report.chapters.flatMap((ch, i) => (ch.kind === 'diff' ? ch.hunks.map((entry) => ({ entry, page: chapterPage(i) })) : [])),
    ...report.appendix.map((entry) => ({ entry, page: APPENDIX_PAGE })),
  ];
  return firstBy(locations, (loc) => loc.entry.file);
}

/**
 * @param {number} i
 * @returns {string}
 */
function chapterPage(i) {
  return `chapter-${String(i + 1).padStart(2, '0')}.html`;
}

/**
 * @param {PageContext} ctx
 * @returns {Page}
 */
function singlePage(ctx) {
  const body = [...frontSections(ctx.story), ...pageSequence(ctx).map((s) => s.body)].join('\n');
  return pageShell(ctx, { path: INDEX_PAGE, pageTitle: ctx.title, body });
}

/**
 * @param {PageContext} ctx
 * @returns {Page[]} the index, then each page in reading order
 */
function pagedLayout(ctx) {
  const sequence = pageSequence(ctx);
  const index = pageShell(ctx, {
    path: INDEX_PAGE,
    pageTitle: ctx.title,
    body: [...frontSections(ctx.story), chapterListHtml(ctx)].join('\n'),
    next: sequence[0] ?? null,
  });
  const pages = sequence.map((s, k) => pageShell(ctx, {
    path: s.href,
    pageTitle: `${esc(s.title)} · ${ctx.title}`,
    body: s.body,
    prev: k === 0 ? { href: INDEX_PAGE, title: 'Overview' } : sequence[k - 1],
    next: sequence[k + 1] ?? null,
  }));
  return [index, ...pages];
}

/**
 * @param {PageContext} ctx
 * @returns {{ href: string, title: string, body: string }[]} the chapters, then Other changes when any hunk
 *   was left out, each with the page it gets in the paged layout
 */
function pageSequence(ctx) {
  const chapters = ctx.report.chapters.map((ch, i) => ({ href: chapterPage(i), title: ch.title, body: chapterHtml(ctx, ch, i) }));
  if (!ctx.report.appendix.length) return chapters;
  return [...chapters, { href: APPENDIX_PAGE, title: 'Other changes', body: appendixHtml(ctx) }];
}

/**
 * @param {Story} story
 * @returns {string[]} the overview, then key terms and how to test when the story has them
 */
function frontSections(story) {
  return [
    `<section><h2 id="overview">Overview</h2>${overview(story.overview)}</section>`,
    story.glossary?.length ? glossaryHtml(story.glossary) : '',
    story.howToTest ? `<section><h2 id="how-to-test">How to test locally</h2>${md(story.howToTest)}</section>` : '',
  ].filter(Boolean);
}

/**
 * @param {NonNullable<Story['glossary']>} glossary
 * @returns {string}
 */
function glossaryHtml(glossary) {
  const terms = glossary.map((g) => `<dt>${esc(g.term)}</dt><dd>${inlineMd(g.meaning)}</dd>`).join('');
  return `<section><h2 id="key-terms">New terms</h2><dl class="glossary">${terms}</dl></section>`;
}

/**
 * Glossary meanings are one paragraph; unwrap the <p> the converter adds.
 * @param {string} text
 * @returns {string}
 */
function inlineMd(text) {
  return md(text).replace(/^<p>([\s\S]*)<\/p>$/, '$1');
}

const OVERVIEW_HEADINGS = { bigPicture: 'Where this change sits', why: 'Why this change', approach: 'What changes', howToRead: 'How to read this report' };

/**
 * @param {Record<string, string>} ov
 * @returns {string}
 */
function overview(ov) {
  return Object.entries(OVERVIEW_HEADINGS).map(([key, heading]) => `<h3>${heading}</h3>\n${md(ov[key])}`).join('\n');
}

/**
 * Chapter list on the index: title, files shown, notes, so the reader sees the shape before diving in.
 * @param {PageContext} ctx
 * @returns {string}
 */
function chapterListHtml(ctx) {
  const { report } = ctx;
  const chapters = report.chapters.map((ch, i) => `<li data-files="${ctx.chapterFiles[i]}"><a href="${chapterPage(i)}">${esc(ch.title)}</a>${chapterCounts(ch)}<div class="intro">${md(ch.intro)}</div></li>`);
  const other = report.appendix.length ? `<li><a href="${APPENDIX_PAGE}">Other changes</a> <span class="muted">${plural(report.appendix.length, 'file')}</span></li>` : '';
  return `<section><h2 id="chapters">Chapters</h2><ol class="chapter-list">${chapters.join('')}${other}</ol></section>`;
}

/**
 * @param {ReportChapter} ch
 * @returns {string} how many files and notes a diff chapter shows; empty for an html chapter
 */
function chapterCounts(ch) {
  if (ch.kind !== 'diff') return '';
  const files = new Set(ch.hunks.map((s) => s.file)).size;
  const notes = ch.hunks.reduce((n, s) => n + s.comments.length, 0);
  return ` <span class="muted">${plural(files, 'file')}, ${plural(notes, 'note')}</span>`;
}

/**
 * @param {PageContext} ctx
 * @param {PageParts} parts
 * @returns {Page}
 */
function pageShell(ctx, { path, pageTitle, body, prev, next }) {
  const pager = pagerHtml(prev, next);
  // Mermaid is large; only a page that draws a diagram loads it.
  const mermaidScript = body.includes('class="mermaid"') ? `<script src="${CDN.mermaid.url}" ${pin(CDN.mermaid)}></script>\n` : '';
  return { path, html: `<!doctype html>
<html lang="en" data-theme="light" data-notes="margin" data-diff="unified" data-report-id="${ctx.reportId}">
${headHtml(pageTitle, ctx.assets.css)}
<body>
<div class="layout">
${sidebarHtml(ctx, path)}
<main>
${reportHeaderHtml(ctx, path)}
${pager}
${body}
${pager}
</main>
</div>
<script src="${CDN.hljs.url}" ${pin(CDN.hljs)}></script>
${mermaidScript}<script>${ctx.assets.js}</script>
</body>
</html>` };
}

/**
 * @param {string} pageTitle
 * @param {string} css
 * @returns {string}
 */
function headHtml(pageTitle, css) {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<script>
// Apply theme before first paint to avoid a flash. Mirrors report.js logic.
${PRE_PAINT}
</script>
<link id="hljs-light" rel="stylesheet" href="${CDN.hljsLight.url}" ${pin(CDN.hljsLight)}>
<link id="hljs-dark" rel="stylesheet" href="${CDN.hljsDark.url}" ${pin(CDN.hljsDark)} disabled>
<style>${css}</style>
</head>`;
}

/**
 * @param {PageContext} ctx
 * @param {string} path
 * @returns {string}
 */
function sidebarHtml(ctx, path) {
  // The table of contents marks the page being read; the index is not in it.
  const current = path === INDEX_PAGE ? null : path;
  return `<nav class="sidebar">
  <div class="sidebar-top">
    <button id="theme-toggle" type="button" title="Toggle light/dark">Theme</button>
    <button id="notes-toggle" type="button" title="Notes beside the code, or inline between lines">Notes: margin</button>
    <button id="diff-toggle" type="button" title="Unified diff, or old and new side by side; applies to every file">Diff: unified</button>
  </div>
  <ol class="toc">
    ${tocHtml(ctx, current)}
  </ol>
  ${sidebarFilesHtml(ctx, path)}
</nav>`;
}

/**
 * The title, the target and the coverage numbers on every page; the excluded-file list on the index only.
 * @param {PageContext} ctx
 * @param {string} path
 * @returns {string}
 */
function reportHeaderHtml(ctx, path) {
  const onIndex = path === INDEX_PAGE;
  const title = ctx.paged && !onIndex ? `<a href="${INDEX_PAGE}">${ctx.title}</a>` : ctx.title;
  return `<header class="report-header">
  <h1>${title}</h1>
  ${ctx.target ? `<p class="target">${ctx.target}</p>` : ''}
  <p class="coverage">${ctx.coverageLine}</p>
  ${onIndex ? ctx.excludedHtml : ''}
</header>`;
}

/**
 * Links to the pages before and after, at the top and bottom of a paged page.
 * @param {PageLink | null | undefined} prev
 * @param {PageLink | null | undefined} next
 * @returns {string} empty when there is neither, as on every single-layout page
 */
function pagerHtml(prev, next) {
  if (!prev && !next) return '';
  const back = prev ? `<a class="prev" href="${prev.href}">← ${esc(prev.title)}</a>` : '<span></span>';
  const forward = next ? `<a class="next" href="${next.href}">${esc(next.title)} →</a>` : '<span></span>';
  return `<nav class="pager">${back}${forward}</nav>`;
}

/**
 * The sidebar's table of contents. `current` is the page being rendered, marked for the reader; null on the
 * index and in the single layout.
 * @param {PageContext} ctx
 * @param {string | null} current
 * @returns {string}
 */
function tocHtml(ctx, current) {
  const { story, report, paged } = ctx;
  const indexHref = paged ? INDEX_PAGE : '';
  const appendixHref = paged ? APPENDIX_PAGE : '#appendix';
  return [
    `<li><a href="${indexHref}#overview">Overview</a></li>`,
    story.glossary?.length ? `<li><a href="${indexHref}#key-terms">New terms</a></li>` : '',
    story.howToTest ? `<li><a href="${indexHref}#how-to-test">How to test</a></li>` : '',
    ...report.chapters.map((ch, i) => tocChapterEntry(ctx, i, current)),
    report.appendix.length ? `<li${currentClass(appendixHref, current)}><a href="${appendixHref}">Other changes</a></li>` : '',
  ].filter(Boolean).join('\n    ');
}

/**
 * @param {PageContext} ctx
 * @param {number} i
 * @param {string | null} current
 * @returns {string}
 */
function tocChapterEntry(ctx, i, current) {
  const href = ctx.paged ? chapterPage(i) : `#chapter-${i + 1}`;
  const files = ctx.chapterFiles[i];
  // data-files lets the page script mark a chapter whose files are all viewed.
  const attrs = `${currentClass(href, current)}${files ? ` data-files="${files}"` : ''}`;
  return `<li${attrs}><a href="${href}">${esc(ctx.report.chapters[i].title)}</a>${files ? '<span class="chapter-progress"></span>' : ''}</li>`;
}

/**
 * @param {string} href
 * @param {string | null} current
 * @returns {string}
 */
function currentClass(href, current) {
  return href === current ? ' class="current"' : '';
}

/**
 * Single layout and paged index: every file. Paged chapter pages lead with the files on that page, and keep
 * the full list one click away.
 * @param {PageContext} ctx
 * @param {string} path
 * @returns {string}
 */
function sidebarFilesHtml(ctx, path) {
  const total = ctx.viewableTotal;
  const progress = `<div class="viewed-progress"><span class="viewed-count" data-total="${total}">0 of ${total} viewed</span><div class="rail"><div class="fill"></div></div></div>`;
  if (!ctx.paged || path === INDEX_PAGE) {
    return `<h3>Files</h3>
  ${progress}
  <nav class="file-index"><ul>${ctx.fileIndexAll}</ul></nav>`;
  }
  const here = (ctx.filesByPage.get(path) ?? []).map((f) => fileIndexItem(f, `#${ctx.anchorOf.get(f)}`)).join('');
  return `<h3>Files on this page</h3>
  <nav class="file-index"><ul>${here}</ul></nav>
  ${progress}
  <details class="all-files"><summary>All files (${ctx.files.length})</summary><nav class="file-index"><ul>${ctx.fileIndexAll}</ul></nav></details>`;
}

/**
 * @param {PageContext} ctx
 * @param {ReportChapter} ch
 * @param {number} i
 * @returns {string}
 */
function chapterHtml(ctx, ch, i) {
  const id = `chapter-${i + 1}`;
  const body = ch.kind === 'html'
    ? `<div class="custom">${ch.html}</div>`
    : ch.hunks.map((sel) => fileBlock({
      file: sel.file,
      hunks: sel.hunks,
      comments: sel.comments,
      anchorId: anchorIdOf(ctx, sel),
      hash: ctx.fileHashes.get(sel.file),
      covers: sel.covers,
    })).join('');
  const files = ctx.chapterFiles[i];
  const attrs = files ? ` data-files="${files}"` : '';
  // The page script writes how many of the chapter's files are viewed into p.chapter-viewed.
  const viewed = files ? '<p class="chapter-viewed"></p>' : '';
  return `<section class="chapter"${attrs}><h2 id="${id}">${esc(ch.title)}</h2>${viewed}<div class="intro">${md(ch.intro)}</div>${body}</section>`;
}

/**
 * Every hunk no chapter showed, file by file. Files the coverage count leaves out come collapsed.
 * @param {PageContext} ctx
 * @returns {string}
 */
function appendixHtml(ctx) {
  const blocks = ctx.report.appendix.map((e) => fileBlock({
    file: e.file,
    hunks: e.hunks,
    comments: [],
    anchorId: anchorIdOf(ctx, e),
    excludedReason: ctx.excludedReason.get(e.file.path),
    hash: ctx.fileHashes.get(e.file),
  }));
  return `<section><h2 id="appendix">Other changes</h2><p class="muted">Hunks no chapter referenced. Listed so nothing is hidden.</p>${blocks.join('')}</section>`;
}

/**
 * A file shown in several places gets its anchor id on its first block only, the one the file index links to.
 * @param {PageContext} ctx
 * @param {BlockEntry} entry
 * @returns {string | undefined}
 */
function anchorIdOf(ctx, entry) {
  return ctx.firstLocationOf.get(entry.file)?.entry === entry ? ctx.anchorOf.get(entry.file) : undefined;
}

/**
 * @param {DiffFile} f
 * @param {string} href
 * @returns {string}
 */
function fileIndexItem(f, href) {
  const { adds, dels } = lineStats(f);
  // <bdi> keeps the path left-to-right inside the right-to-left box report.css uses to clip long paths at the start.
  return `<li><a href="${href}" data-file="${esc(f.path)}" title="${esc(f.path)}"><bdi>${esc(f.path)}</bdi></a> <span class="add">+${adds}</span><span class="del">-${dels}</span></li>`;
}

/**
 * One file's hunks as a block of the page.
 * @typedef {object} FileBlockInput
 * @property {DiffFile} file
 * @property {Hunk[]} hunks
 * @property {PlacedComment[]} comments
 * @property {string} [anchorId] set on the file's first block only
 * @property {string} [excludedReason] set when the coverage count leaves the file out
 * @property {string} [hash]
 * @property {string | null} [covers]
 */

/**
 * @param {FileBlockInput} input
 * @returns {string}
 */
function fileBlock({ file, hunks, comments, anchorId, excludedReason, hash, covers }) {
  const head = `<span class="path">${fileName(file)}</span>${statusBadges(file)}`;
  const idAttr = anchorId ? ` id="${anchorId}"` : '';
  const body = `<div class="file-body"><div class="diff-col">${fileTables(file, hunks, comments)}</div><aside class="notes-col"></aside></div>`;
  // Files excluded from coverage are listed, not expanded: nobody reads a generated diff.
  if (excludedReason) {
    return `<details class="file excluded"${idAttr} data-path="${esc(file.path)}"><summary class="file-header">${head}<span class="muted">excluded: ${esc(excludedReason)}</span></summary>
${body}
</details>`;
  }
  return `<section class="file"${idAttr} data-path="${esc(file.path)}" data-hash="${hash}">
<header class="file-header">${head}<label class="viewed"><input type="checkbox" class="viewed-toggle"> Viewed</label></header>${covers ? `<div class="covers"><span class="covers-label">Covers</span>${md(covers)}</div>` : ''}
${body}
</section>`;
}

/**
 * @param {DiffFile} file
 * @returns {string}
 */
function fileName(file) {
  return file.status === 'renamed' ? `${esc(file.oldPath)} → ${esc(file.newPath)}` : esc(file.path);
}

/**
 * @param {DiffFile} file
 * @returns {string} the status badge (none for a plain modification) and the mode badge
 */
function statusBadges(file) {
  const status = file.status === 'modified' ? '' : `<span class="status ${file.status}">${file.status}</span>`;
  // A permission change on a file that also has hunks would otherwise never be shown.
  const mode = headerOnlyKind(file) === null ? modeNote(file) : null;
  return mode ? `${status}<span class="status mode">${esc(mode)}</span>` : status;
}

/**
 * @param {DiffFile} file
 * @param {Hunk[]} hunks
 * @param {PlacedComment[]} comments
 * @returns {string} a table per hunk, or the sentence saying why the file has none
 */
function fileTables(file, hunks, comments) {
  const kind = headerOnlyKind(file);
  if (kind !== null) return `<p class="muted">${esc(HEADER_ONLY[kind].sentence(file))}</p>`;
  const lang = languageFor(file.path);
  const notesAt = commentsByLine(comments);
  return hunks.map((h) => hunkTable(h, notesAt, lang)).join('');
}

/** @typedef {Map<string, { comment: PlacedComment, order: number }[]>} CommentIndex */

/**
 * Each comment under `side:line`, with its place in the story so notes keep the story's order.
 * @param {PlacedComment[]} comments
 * @returns {CommentIndex}
 */
function commentsByLine(comments) {
  return groupBy(comments.map((comment, order) => ({ comment, order })), ({ comment }) => `${comment.side}:${comment.line}`);
}

/**
 * @param {DiffLine} line
 * @param {CommentIndex} notesAt
 * @returns {PlacedComment[]} the comments anchored on this line, in story order
 */
function commentsOn(line, notesAt) {
  const hits = [...notesAt.get(`new:${line.new}`) ?? [], ...notesAt.get(`old:${line.old}`) ?? []];
  // A context line has both numbers, so notes on both sides can land on it; they interleave in story order.
  return hits.sort((a, b) => a.order - b.order).map(({ comment }) => comment);
}

/**
 * @param {Hunk} hunk
 * @param {CommentIndex} notesAt
 * @param {string} lang
 * @returns {string}
 */
function hunkTable(hunk, notesAt, lang) {
  const header = `<tr class="hunk-header"><td colspan="3">${esc(hunkLabel(hunk))}</td></tr>`;
  const rows = hunk.lines.flatMap((line) => [lineRow(line, lang), ...commentsOn(line, notesAt).map(commentRow)]);
  return `<table class="diff unified"><colgroup><col class="num"><col class="num"><col class="code"></colgroup>${header}${rows.join('')}</table>`;
}

/**
 * @param {DiffLine} line
 * @param {string} lang
 * @returns {string}
 */
function lineRow(line, lang) {
  return `<tr class="line ${line.type}" data-old="${line.old ?? ''}" data-new="${line.new ?? ''}"><td class="num old">${line.old ?? ''}</td><td class="num new">${line.new ?? ''}</td><td class="code"><code class="language-${lang}">${esc(line.content)}</code></td></tr>`;
}

/**
 * @param {PlacedComment} c
 * @returns {string}
 */
function commentRow(c) {
  return `<tr class="comment" data-anchor-side="${c.side}" data-anchor-line="${c.line}"><td colspan="3"><div class="callout">${md(c.text)}</div></td></tr>`;
}

/**
 * @param {string} path
 * @returns {string}
 */
function languageFor(path) {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot + 1);
  return LANG_BY_BASENAME.get(base) ?? LANG_BY_EXT.get(ext) ?? 'plaintext';
}

/**
 * Numbers the reviewer can trust: what share of the change the chapters show, and whether a
 * reader pass came back with no open questions.
 * @param {Story} story
 * @param {Coverage} coverage
 * @returns {string}
 */
function coverageLine(story, coverage) {
  const pct = Math.round(coverage.ratio * 100);
  return `${coverage.explained} of ${coverage.total} changed lines shown in chapters (${pct}%).${readerPassSentence(story.meta.readerPass)}`;
}

/**
 * @param {Story['meta']['readerPass']} pass
 * @returns {string}
 */
function readerPassSentence(pass) {
  if (!pass) return ' Reader pass: not yet run.';
  const open = pass.openQuestions === 0 ? 'none open' : `${pass.openQuestions} still open`;
  return ` Reader pass: ${plural(pass.rounds, 'round')}, ${plural(pass.questionsAnswered, 'question')} answered, ${open}.`;
}

/**
 * The files the count leaves out, collapsed; it goes on the index page only.
 * @param {Coverage} coverage
 * @returns {string}
 */
function excludedListHtml(coverage) {
  if (!coverage.excluded.length) return '';
  const items = coverage.excluded.map((e) => `<li>${esc(e.path)} <span class="muted">${esc(e.reason)}</span></li>`).join('');
  return `<details class="excluded"><summary>Excluded from the count: ${plural(coverage.excluded.length, 'file')}</summary><ul>${items}</ul></details>`;
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string} the count and the word, with an s unless the count is one
 */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Viewed ticks are stored per report and per file. The report id ties them to this title and this exact
 * diff, so two reports open side by side, or two renders of a branch at different commits, never share
 * ticks. Both formulas are persisted in readers' storage: changing either drops every stored tick.
 * @param {DiffFile} file
 * @returns {string}
 */
function fileHash(file) {
  return hashOf(`${file.path}\n${file.hunks.map((h) => h.lines.map((l) => `${l.type}${l.content}`).join('\n')).join('\n')}`);
}

/**
 * @param {string} title
 * @param {string[]} fileHashes in diff order
 * @returns {string}
 */
function reportIdFor(title, fileHashes) {
  return `${slugOf(title)}-${hashOf(`${title}\n${fileHashes.join(',')}`)}`;
}

/**
 * report.js finds the ticks of earlier renders of the same report by the id with its last
 * `-` plus eight lowercase hex digits cut off. Keep this length and alphabet.
 * @param {string} text
 * @returns {string}
 */
function hashOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/**
 * @param {string} title
 * @returns {string}
 */
function slugOf(title) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
}

/**
 * The paths a chapter shows, joined for a data-files attribute; empty for an html chapter.
 * @param {ReportChapter} ch
 * @returns {string}
 */
function chapterFileList(ch) {
  return ch.kind === 'diff' ? [...new Set(ch.hunks.map((s) => s.file.path))].map(esc).join('|') : '';
}
