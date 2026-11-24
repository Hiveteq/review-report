// @ts-check
// Assembles the report pages. Pure: takes the story, the built report, the parsed files, their
// coverage and the asset strings, and returns HTML. DOM class/id names here are a contract with
// template/report.js and template/report.css; change them together.
// eslint-disable-next-line no-restricted-imports -- the file hash and report id are SHA-1, which only Node offers synchronously; the one Node-only import left in the renderer core
import { createHash } from 'node:crypto';
import { CDN, pin } from './cdn.mjs';
import { escapeHtml as esc, renderMarkdown as md } from './markdown.mjs';
import { HEADER_ONLY, headerOnlyKind, hunkLabel, lineStats, modeNote } from './diff.mjs';

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
 * The file each part of the report is on, as links name it. The single layout is one page, so there every
 * name is empty and a link is just its #fragment.
 * @typedef {{ index: string, chapters: string[], appendix: string }} PageNames
 */

/**
 * What every page is built from, worked out once.
 * @typedef {object} PageContext
 * @property {Story} story
 * @property {Report} report
 * @property {DiffFile[]} files
 * @property {Coverage} coverage
 * @property {Assets} assets
 * @property {PageNames} pages
 * @property {string} reportId
 * @property {Map<DiffFile, string>} fileHashes
 * @property {Map<DiffFile, string>} anchorOf the id of the block the file index links to
 * @property {Map<DiffFile, BlockLocation>} firstLocationOf each file's first block in reading order: the
 *   one that carries its anchor id, on the page the file index links to
 * @property {FileIndex} fileIndex
 * @property {string[]} chapterFiles per chapter, the paths it shows joined for a data-files attribute; every
 *   page's table of contents repeats them
 */

/**
 * The sidebar's file list, built once per render. Every page repeats the full list, so building it per page
 * would cost pages × files.
 * @typedef {object} FileIndex
 * @property {string} progress the viewed counter and its rail
 * @property {string} all one list item per file, linking to its first block
 * @property {Map<string, DiffFile[]>} byPage the files whose first block is on each page
 */

/** @typedef {import('./story.mjs').Selection | import('./story.mjs').AppendixEntry} BlockEntry */

/**
 * A file block and the name of the page it sits on.
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
 * Single layout: one index.html with the whole report. Paged layout: an index (overview, key terms, how to
 * test, chapter list) plus one page per chapter and one for "Other changes". A large report then stays one
 * story with one reading order, while each page stays small enough to load and lay out quickly.
 * @param {RenderInput & { paged: boolean }} input
 * @returns {Page[]}
 */
export function renderPages(input) {
  const ctx = buildContext(input);
  return input.paged ? pagedLayout(ctx) : [singlePage(ctx)];
}

/**
 * @param {RenderInput & { paged: boolean }} input
 * @returns {PageContext}
 */
function buildContext({ story, report, files, coverage, assets, paged }) {
  const hashes = files.map(fileHash);
  const pages = pageNames(report, paged);
  const anchorOf = new Map(files.map((f, i) => [f, `file-${i + 1}-c`]));
  const firstLocationOf = firstLocations(report, pages);
  return {
    story,
    report,
    files,
    coverage,
    assets,
    pages,
    reportId: reportIdFor(story.meta.title, hashes),
    fileHashes: new Map(files.map((f, i) => [f, hashes[i]])),
    anchorOf,
    firstLocationOf,
    fileIndex: fileIndexOf({ files, coverage, anchorOf, firstLocationOf }),
    chapterFiles: report.chapters.map(chapterFileList),
  };
}

/**
 * @param {Pick<PageContext, 'files' | 'coverage' | 'anchorOf' | 'firstLocationOf'>} parts
 * @returns {FileIndex}
 */
function fileIndexOf({ files, coverage, anchorOf, firstLocationOf }) {
  const excluded = new Set(coverage.excluded.map((e) => e.path));
  // The reader is asked to tick only the files the coverage count does not leave out.
  const total = files.filter((f) => !excluded.has(f.path)).length;
  return {
    progress: `<div class="viewed-progress"><span class="viewed-count" data-total="${total}">0 of ${total} viewed</span><div class="rail"><div class="fill"></div></div></div>`,
    all: files.map((f) => fileIndexItem(f, `${firstLocationOf.get(f)?.page ?? ''}#${anchorOf.get(f)}`)).join(''),
    byPage: Map.groupBy(files, (f) => firstLocationOf.get(f)?.page ?? ''),
  };
}

/**
 * @param {Report} report
 * @param {boolean} paged
 * @returns {PageNames}
 */
function pageNames(report, paged) {
  if (!paged) return { index: '', chapters: report.chapters.map(() => ''), appendix: '' };
  return {
    index: INDEX_PAGE,
    chapters: report.chapters.map((_, i) => `chapter-${String(i + 1).padStart(2, '0')}.html`),
    appendix: APPENDIX_PAGE,
  };
}

/**
 * A link to a whole chapter or to Other changes: its own page when it has one, else its heading on the one page.
 * @param {string} page
 * @param {string} id
 * @returns {string}
 */
function sectionHref(page, id) {
  return page || `#${id}`;
}

/**
 * Every file block in reading order (the chapters, then Other changes), reduced to each file's first.
 * @param {Report} report
 * @param {PageNames} pages
 * @returns {Map<DiffFile, BlockLocation>}
 */
function firstLocations(report, pages) {
  /** @type {BlockLocation[]} */
  const locations = [
    ...report.chapters.flatMap((ch, i) => (ch.kind === 'diff' ? ch.hunks.map((entry) => ({ entry, page: pages.chapters[i] })) : [])),
    ...report.appendix.map((entry) => ({ entry, page: pages.appendix })),
  ];
  const byFile = Map.groupBy(locations, (loc) => loc.entry.file);
  return new Map(Array.from(byFile, ([file, [first]]) => [file, first]));
}

/**
 * @param {PageContext} ctx
 * @returns {Page}
 */
function singlePage(ctx) {
  const body = [...frontSections(ctx.story), ...pageSequence(ctx).map((s) => s.body)].join('\n');
  return pageShell(ctx, { path: INDEX_PAGE, pageTitle: esc(ctx.story.meta.title), body });
}

/**
 * @param {PageContext} ctx
 * @returns {Page[]} the index, then each page in reading order
 */
function pagedLayout(ctx) {
  const title = esc(ctx.story.meta.title);
  const sequence = pageSequence(ctx);
  const index = pageShell(ctx, {
    path: INDEX_PAGE,
    pageTitle: title,
    body: [...frontSections(ctx.story), chapterListHtml(ctx)].join('\n'),
    next: sequence[0] ?? null,
  });
  const pages = sequence.map((s, k) => pageShell(ctx, {
    path: s.href,
    pageTitle: `${esc(s.title)} · ${title}`,
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
  const { report, pages } = ctx;
  const chapters = report.chapters.map((ch, i) => ({ href: pages.chapters[i], title: ch.title, body: chapterHtml(ctx, ch, i) }));
  if (!report.appendix.length) return chapters;
  return [...chapters, { href: pages.appendix, title: 'Other changes', body: appendixHtml(ctx) }];
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
  // Meanings are one paragraph; unwrap the <p> the converter adds.
  const terms = glossary.map((g) => `<dt>${esc(g.term)}</dt><dd>${md(g.meaning).replace(/^<p>([\s\S]*)<\/p>$/, '$1')}</dd>`).join('');
  return `<section><h2 id="key-terms">New terms</h2><dl class="glossary">${terms}</dl></section>`;
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
 * Chapter list on the paged index: title, files shown, notes, so the reader sees the shape before diving in.
 * @param {PageContext} ctx
 * @returns {string}
 */
function chapterListHtml({ report, pages, chapterFiles }) {
  const chapters = report.chapters.map((ch, i) => `<li data-files="${chapterFiles[i]}"><a href="${pages.chapters[i]}">${esc(ch.title)}</a>${chapterCounts(ch)}<div class="intro">${md(ch.intro)}</div></li>`);
  const other = report.appendix.length ? `<li><a href="${pages.appendix}">Other changes</a> <span class="muted">${plural(report.appendix.length, 'file')}</span></li>` : '';
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
  return `<nav class="sidebar">
  <div class="sidebar-top">
    <button id="theme-toggle" type="button" title="Toggle light/dark">Theme</button>
    <button id="notes-toggle" type="button" title="Notes beside the code, or inline between lines">Notes: margin</button>
    <button id="diff-toggle" type="button" title="Unified diff, or old and new side by side; applies to every file">Diff: unified</button>
  </div>
  <ol class="toc">
    ${tocHtml(ctx, path)}
  </ol>
  ${sidebarFilesHtml(ctx, path)}
</nav>`;
}

/**
 * The title, the target and the coverage numbers on every page; the excluded-file list on the index only.
 * The single layout's one page is the index too.
 * @param {PageContext} ctx
 * @param {string} path
 * @returns {string}
 */
function reportHeaderHtml({ story, coverage }, path) {
  const onIndex = path === INDEX_PAGE;
  const title = esc(story.meta.title);
  return `<header class="report-header">
  <h1>${onIndex ? title : `<a href="${INDEX_PAGE}">${title}</a>`}</h1>
  ${story.meta.target ? `<p class="target">${esc(story.meta.target)}</p>` : ''}
  <p class="coverage">${coverageLine(story, coverage)}</p>
  ${onIndex ? excludedListHtml(coverage) : ''}
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
 * The sidebar's table of contents, with the page being read marked as current.
 * @param {PageContext} ctx
 * @param {string} path the page being rendered
 * @returns {string}
 */
function tocHtml({ story, report, pages, chapterFiles }, path) {
  /**
   * @param {string} page
   * @returns {string}
   */
  const current = (page) => (page === path ? ' class="current"' : '');
  const chapters = report.chapters.map((ch, i) => {
    const files = chapterFiles[i];
    // data-files lets the page script mark a chapter whose files are all viewed.
    const attrs = `${current(pages.chapters[i])}${files ? ` data-files="${files}"` : ''}`;
    return `<li${attrs}><a href="${sectionHref(pages.chapters[i], `chapter-${i + 1}`)}">${esc(ch.title)}</a>${files ? '<span class="chapter-progress"></span>' : ''}</li>`;
  });
  return [
    `<li><a href="${pages.index}#overview">Overview</a></li>`,
    story.glossary?.length ? `<li><a href="${pages.index}#key-terms">New terms</a></li>` : '',
    story.howToTest ? `<li><a href="${pages.index}#how-to-test">How to test</a></li>` : '',
    ...chapters,
    report.appendix.length ? `<li${current(pages.appendix)}><a href="${sectionHref(pages.appendix, 'appendix')}">Other changes</a></li>` : '',
  ].filter(Boolean).join('\n    ');
}

/**
 * The index (and so the single layout) lists every file. Paged chapter pages lead with the files on that
 * page, and keep the full list one click away.
 * @param {PageContext} ctx
 * @param {string} path
 * @returns {string}
 */
function sidebarFilesHtml({ files, anchorOf, fileIndex }, path) {
  const { progress, all } = fileIndex;
  if (path === INDEX_PAGE) {
    return `<h3>Files</h3>
  ${progress}
  <nav class="file-index"><ul>${all}</ul></nav>`;
  }
  const here = (fileIndex.byPage.get(path) ?? []).map((f) => fileIndexItem(f, `#${anchorOf.get(f)}`)).join('');
  return `<h3>Files on this page</h3>
  <nav class="file-index"><ul>${here}</ul></nav>
  ${progress}
  <details class="all-files"><summary>All files (${files.length})</summary><nav class="file-index"><ul>${all}</ul></nav></details>`;
}

/**
 * @param {PageContext} ctx
 * @param {ReportChapter} ch
 * @param {number} i
 * @returns {string}
 */
function chapterHtml(ctx, ch, i) {
  const body = ch.kind === 'html'
    ? `<div class="custom">${ch.html}</div>`
    : ch.hunks.map((sel) => fileBlock(ctx, sel, { comments: sel.comments, covers: sel.covers })).join('');
  const files = ctx.chapterFiles[i];
  const attrs = files ? ` data-files="${files}"` : '';
  // The page script writes how many of the chapter's files are viewed into p.chapter-viewed.
  const viewed = files ? '<p class="chapter-viewed"></p>' : '';
  return `<section class="chapter"${attrs}><h2 id="chapter-${i + 1}">${esc(ch.title)}</h2>${viewed}<div class="intro">${md(ch.intro)}</div>${body}</section>`;
}

/**
 * Every hunk no chapter showed, file by file. Files the coverage count leaves out come collapsed.
 * @param {PageContext} ctx
 * @returns {string}
 */
function appendixHtml(ctx) {
  const excludedReason = new Map(ctx.coverage.excluded.map((e) => [e.path, e.reason]));
  const blocks = ctx.report.appendix.map((e) => fileBlock(ctx, e, { excludedReason: excludedReason.get(e.file.path) }));
  return `<section><h2 id="appendix">Other changes</h2><p class="muted">Hunks no chapter referenced. Listed so nothing is hidden.</p>${blocks.join('')}</section>`;
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
 * What a chapter block has and an Other changes block has not, and the other way round.
 * @typedef {object} BlockExtras
 * @property {PlacedComment[]} [comments]
 * @property {string | null} [covers] what a test file pins and leaves untested
 * @property {string} [excludedReason] set when the coverage count leaves the file out; the block comes collapsed
 */

/**
 * One file's hunks as a block of the page. A file shown in several places gets its anchor id on its first
 * block only, the one the file index links to.
 * @param {PageContext} ctx
 * @param {BlockEntry} entry
 * @param {BlockExtras} extras
 * @returns {string}
 */
function fileBlock(ctx, entry, { comments = [], covers, excludedReason }) {
  const { file } = entry;
  const head = `<span class="path">${fileName(file)}</span>${statusBadges(file)}`;
  const idAttr = ctx.firstLocationOf.get(file)?.entry === entry ? ` id="${ctx.anchorOf.get(file)}"` : '';
  const body = `<div class="file-body"><div class="diff-col">${fileTables(file, entry.hunks, comments)}</div><aside class="notes-col"></aside></div>`;
  // Files excluded from coverage are listed, not expanded: nobody reads a generated diff.
  if (excludedReason) {
    return `<details class="file excluded"${idAttr} data-path="${esc(file.path)}"><summary class="file-header">${head}<span class="muted">excluded: ${esc(excludedReason)}</span></summary>
${body}
</details>`;
  }
  return `<section class="file"${idAttr} data-path="${esc(file.path)}" data-hash="${ctx.fileHashes.get(file)}">
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
  return hunks.map((h) => hunkTable(h, comments, lang)).join('');
}

/**
 * @param {Hunk} hunk
 * @param {PlacedComment[]} comments the notes of the block, in story order
 * @param {string} lang
 * @returns {string}
 */
function hunkTable(hunk, comments, lang) {
  const header = `<tr class="hunk-header"><td colspan="3">${esc(hunkLabel(hunk))}</td></tr>`;
  const rows = hunk.lines.map((line) => `${lineRow(line, lang)}${noteRows(line, comments)}`).join('');
  return `<table class="diff unified"><colgroup><col class="num"><col class="num"><col class="code"></colgroup>${header}${rows}</table>`;
}

/**
 * The notes anchored on a line, in story order. A context line has both numbers, so notes on either side
 * can land on it.
 * @param {DiffLine} line
 * @param {PlacedComment[]} comments
 * @returns {string}
 */
function noteRows(line, comments) {
  if (!comments.length) return '';
  return comments.filter((c) => c.line === line[c.side]).map(commentRow).join('');
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
 * The file hash covers the path, then every line as type and content, lines and hunks joined by '\n'.
 * @param {DiffFile} file
 * @returns {string}
 */
function fileHash(file) {
  // Fed piece by piece, so a large file is never copied into one string first.
  const hash = createHash('sha1').update(`${file.path}\n`);
  for (const [i, hunk] of file.hunks.entries()) {
    if (i > 0) hash.update('\n');
    for (const [j, line] of hunk.lines.entries()) {
      if (j > 0) hash.update('\n');
      hash.update(line.type).update(line.content);
    }
  }
  return shortDigest(hash);
}

/**
 * @param {string} title
 * @param {string[]} fileHashes in diff order
 * @returns {string}
 */
function reportIdFor(title, fileHashes) {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
  return `${slug}-${shortDigest(createHash('sha1').update(`${title}\n${fileHashes.join(',')}`))}`;
}

/**
 * report.js finds the ticks of earlier renders of the same report by the id with its last
 * `-` plus eight lowercase hex digits cut off. Keep this length and alphabet.
 * @param {import('node:crypto').Hash} hash
 * @returns {string}
 */
function shortDigest(hash) {
  return hash.digest('hex').slice(0, 8);
}

/**
 * The paths a chapter shows, joined for a data-files attribute; empty for an html chapter.
 * @param {ReportChapter} ch
 * @returns {string}
 */
function chapterFileList(ch) {
  return ch.kind === 'diff' ? [...new Set(ch.hunks.map((s) => s.file.path))].map(esc).join('|') : '';
}
