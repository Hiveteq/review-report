// @ts-check
// Assembles the report page. Pure: takes story + built report + parsed files
// + asset strings, returns HTML. DOM class/id names here are a contract with
// template/report.js and template/report.css; change them together.
import { createHash } from 'node:crypto';
import { CDN, pin } from './cdn.mjs';
import { escapeHtml as esc, renderMarkdown as md } from './markdown.mjs';
import { computeCoverage } from './coverage.mjs';
import { headerOnlyKind, hunkLabel, modeNote } from './diff.mjs';

/** @typedef {import('./diff.mjs').DiffFile} DiffFile */
/** @typedef {import('./diff.mjs').Hunk} Hunk */
/** @typedef {import('./story.mjs').Story} Story */
/** @typedef {import('./story.mjs').Report} Report */
/** @typedef {import('./story.mjs').ReportChapter} ReportChapter */
/** @typedef {import('./story.mjs').PlacedComment} PlacedComment */

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

// Extension → highlight.js language name. Names the CDN bundle does not ship are
// skipped by the page script, so listing one is never worse than plaintext.
/** @type {Record<string, string>} */
const LANG_BY_EXT = {
  java: 'java', kt: 'kotlin', kts: 'kotlin', php: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', yml: 'yaml', yaml: 'yaml', md: 'markdown', sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', rb: 'ruby', swift: 'swift', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r',
  m: 'objectivec', graphql: 'graphql', gql: 'graphql', vb: 'vbnet', toml: 'ini', ini: 'ini', properties: 'properties',
  gradle: 'groovy', groovy: 'groovy', dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile',
};

// Single page: the whole report in one file.
/**
 * @param {Story} story
 * @param {Report} report
 * @param {DiffFile[]} files
 * @param {Assets} assets
 * @returns {string}
 */
export function renderHtml(story, report, files, assets) {
  return renderPages(story, report, files, assets, { paged: false })[0].html;
}

// Pages: [{ path, html }]. Single mode returns one index.html. Paged mode returns an
// index (overview, key terms, how to test, chapter list) plus one page per chapter and
// one for "Other changes", so a large report stays one story with one reading order
// while each page stays small enough to load and lay out quickly.
/**
 * @param {Story} story
 * @param {Report} report
 * @param {DiffFile[]} files
 * @param {Assets} assets
 * @param {{ paged: boolean }} options
 * @returns {Page[]}
 */
export function renderPages(story, report, files, assets, { paged }) {
  const fileIds = new Map(files.map((f, i) => [f, `file-${i + 1}`]));
  // Viewed state is stored per report. The id ties it to this title and this exact diff, so two reports
  // open side by side, or two renders of the same branch at different commits, never share ticks.
  const fileHashes = new Map(files.map((f) => [f, hashOf(`${f.path}\n${f.hunks.map((h) => h.lines.map((l) => `${l.type}${l.content}`).join('\n')).join('\n')}`)]));
  const reportId = `${slugOf(story.meta.title)}-${hashOf(`${story.meta.title}\n${files.map((f) => fileHashes.get(f)).join(',')}`)}`;
  const viewableTotal = files.filter((f) => !excludedFiles(story, files, report).has(f.path)).length;
  const title = esc(story.meta.title);
  const target = story.meta.target ? esc(story.meta.target) : '';
  const coverage = coverageParts(story, files, report);
  /** @param {number} i */
  const chapterPage = (i) => `chapter-${String(i + 1).padStart(2, '0')}.html`;
  const appendixPage = 'other-changes.html';

  // Where each file's first block lives, for the sidebar file index.
  /** @type {Map<DiffFile, string>} */
  const firstPageOf = new Map();
  report.chapters.forEach((ch, i) => {
    if (ch.kind !== 'diff') return;
    for (const sel of ch.hunks) if (!firstPageOf.has(sel.file)) firstPageOf.set(sel.file, paged ? chapterPage(i) : '');
  });
  for (const e of report.appendix) if (!firstPageOf.has(e.file)) firstPageOf.set(e.file, paged ? appendixPage : '');
  /** @type {Set<DiffFile>} */
  const anchored = new Set();
  /**
   * @param {DiffFile} file
   * @returns {string | null}
   */
  const anchorFor = (file) => {
    if (anchored.has(file)) return null;
    anchored.add(file);
    return `${fileIds.get(file)}-c`;
  };

  const front = [
    `<section><h2 id="overview">Overview</h2>${overview(story.overview)}</section>`,
    story.glossary?.length
      ? `<section><h2 id="key-terms">New terms</h2><dl class="glossary">${story.glossary.map((g) => `<dt>${esc(g.term)}</dt><dd>${inlineMd(g.meaning)}</dd>`).join('')}</dl></section>`
      : '',
    story.howToTest ? `<section><h2 id="how-to-test">How to test locally</h2>${md(story.howToTest)}</section>` : '',
  ].filter(Boolean);
  const chapters = report.chapters.map((ch, i) => chapter(ch, i, anchorFor, fileHashes));
  const appendix = report.appendix.length
    ? `<section><h2 id="appendix">Other changes</h2><p class="muted">Hunks no chapter referenced. Listed so nothing is hidden.</p>${
      report.appendix.map((e) => fileBlock(e.file, e.hunks, [], anchorFor(e.file), coverage.excludedReason.get(e.file.path), fileHashes.get(e.file))).join('')}</section>`
    : '';

  const indexHref = paged ? 'index.html' : '';
  /** @param {string | null} current */
  const tocEntries = (current) => [
    `<li><a href="${indexHref}#overview">Overview</a></li>`,
    story.glossary?.length ? `<li><a href="${indexHref}#key-terms">New terms</a></li>` : '',
    story.howToTest ? `<li><a href="${indexHref}#how-to-test">How to test</a></li>` : '',
    ...report.chapters.map((ch, i) => {
      const href = paged ? chapterPage(i) : `#chapter-${i + 1}`;
      const fl = chapterFileList(ch);
      // data-files lets the page script mark a chapter whose files are all viewed.
      const attrs = `${current === href ? ' class="current"' : ''}${fl ? ` data-files="${fl}"` : ''}`;
      return `<li${attrs}><a href="${href}">${esc(ch.title)}</a>${fl ? '<span class="chapter-progress"></span>' : ''}</li>`;
    }),
    report.appendix.length ? `<li${current === appendixPage ? ' class="current"' : ''}><a href="${paged ? appendixPage : '#appendix'}">Other changes</a></li>` : '',
  ].filter(Boolean).join('\n    ');
  const fileIndexAll = files.map((f) => fileIndexItem(f, `${firstPageOf.get(f) ?? ''}#${fileIds.get(f)}-c`)).join('');
  // Paged: the sidebar leads with the files on this page; the full list is one click away.
  /** @param {string} path */
  const sidebarFiles = (path) => {
    const progress = `<div class="viewed-progress"><span class="viewed-count" data-total="${viewableTotal}">0 of ${viewableTotal} viewed</span><div class="rail"><div class="fill"></div></div></div>`;
    if (!paged || path === 'index.html') return `<h3>Files</h3>
  ${progress}
  <nav class="file-index"><ul>${fileIndexAll}</ul></nav>`;
    const here = files.filter((f) => firstPageOf.get(f) === path).map((f) => fileIndexItem(f, `#${fileIds.get(f)}-c`)).join('');
    return `<h3>Files on this page</h3>
  <nav class="file-index"><ul>${here}</ul></nav>
  ${progress}
  <details class="all-files"><summary>All files (${files.length})</summary><nav class="file-index"><ul>${fileIndexAll}</ul></nav></details>`;
  };

  /**
   * @param {{ path: string, pageTitle: string, body: string, current: string | null, prev?: PageLink | null,
   *   next?: PageLink | null }} parts
   * @returns {Page}
   */
  const page = ({ path, pageTitle, body, current, prev, next }) => {
    const nav = paged && (prev || next)
      ? `<nav class="pager">${prev ? `<a class="prev" href="${prev.href}">← ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${next.href}">${esc(next.title)} →</a>` : '<span></span>'}</nav>`
      : '';
    const mermaidScript = body.includes('class="mermaid"') ? `<script src="${CDN.mermaid.url}" ${pin(CDN.mermaid)}></script>\n` : '';
    return { path, html: `<!doctype html>
<html lang="en" data-theme="light" data-notes="margin" data-diff="unified" data-report-id="${reportId}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<script>
// Apply theme before first paint to avoid a flash. Mirrors report.js logic.
(function(){try{var d=document.documentElement,t=localStorage.getItem('review-report-theme');if(!t){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}d.dataset.theme=t;var n=localStorage.getItem('review-report-notes');if(n==='inline'||n==='margin'){d.dataset.notes=n}var f=localStorage.getItem('review-report-diff');if(f==='split'||f==='unified'){d.dataset.diff=f}}catch(e){}})();
</script>
<link id="hljs-light" rel="stylesheet" href="${CDN.hljsLight.url}" ${pin(CDN.hljsLight)}>
<link id="hljs-dark" rel="stylesheet" href="${CDN.hljsDark.url}" ${pin(CDN.hljsDark)} disabled>
<style>${assets.css}</style>
</head>
<body>
<div class="layout">
<nav class="sidebar">
  <div class="sidebar-top">
    <button id="theme-toggle" type="button" title="Toggle light/dark">Theme</button>
    <button id="notes-toggle" type="button" title="Notes beside the code, or inline between lines">Notes: margin</button>
    <button id="diff-toggle" type="button" title="Unified diff, or old and new side by side; applies to every file">Diff: unified</button>
  </div>
  <ol class="toc">
    ${tocEntries(current)}
  </ol>
  ${sidebarFiles(path)}
</nav>
<main>
<header class="report-header">
  <h1>${paged && path !== 'index.html' ? `<a href="index.html">${title}</a>` : title}</h1>
  ${target ? `<p class="target">${target}</p>` : ''}
  <p class="coverage">${coverage.line}</p>
  ${path === 'index.html' ? coverage.excluded : ''}
</header>
${nav}
${body}
${nav}
</main>
</div>
<script src="${CDN.hljs.url}" ${pin(CDN.hljs)}></script>
${mermaidScript}<script>${assets.js}</script>
</body>
</html>` };
  };

  if (!paged) {
    return [page({ path: 'index.html', pageTitle: title, body: [...front, ...chapters, appendix].filter(Boolean).join('\n'), current: null })];
  }

  // Chapter list on the index: title, files shown, notes, so the reader sees the shape before diving in.
  const chapterList = `<section><h2 id="chapters">Chapters</h2><ol class="chapter-list">${report.chapters.map((ch, i) => {
    const filesShown = ch.kind === 'diff' ? new Set(ch.hunks.map((s) => s.file)).size : 0;
    const notes = ch.kind === 'diff' ? ch.hunks.reduce((n, s) => n + s.comments.length, 0) : 0;
    const meta = ch.kind === 'diff' ? ` <span class="muted">${filesShown} file${filesShown === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}</span>` : '';
    const chapterFiles = chapterFileList(ch);
    return `<li data-files="${chapterFiles}"><a href="${chapterPage(i)}">${esc(ch.title)}</a>${meta}<div class="intro">${md(ch.intro)}</div></li>`;
  }).join('')}${report.appendix.length ? `<li><a href="${appendixPage}">Other changes</a> <span class="muted">${report.appendix.length} file${report.appendix.length === 1 ? '' : 's'}</span></li>` : ''}</ol></section>`;

  const sequence = [
    ...report.chapters.map((ch, i) => ({ href: chapterPage(i), title: ch.title, body: chapters[i] })),
    ...(report.appendix.length ? [{ href: appendixPage, title: 'Other changes', body: appendix }] : []),
  ];
  const pages = [page({ path: 'index.html', pageTitle: title, body: [...front, chapterList].join('\n'), current: null, next: sequence[0] && { href: sequence[0].href, title: sequence[0].title } })];
  sequence.forEach((s, k) => {
    pages.push(page({
      path: s.href,
      pageTitle: `${esc(s.title)} · ${title}`,
      body: s.body,
      current: s.href,
      prev: k === 0 ? { href: 'index.html', title: 'Overview' } : { href: sequence[k - 1].href, title: sequence[k - 1].title },
      next: sequence[k + 1] ? { href: sequence[k + 1].href, title: sequence[k + 1].title } : null,
    }));
  });
  return pages;
}

// Glossary meanings are one paragraph; unwrap the <p> the converter adds.
/**
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
 * @param {ReportChapter} ch
 * @param {number} i
 * @param {(file: DiffFile) => string | null} anchorFor
 * @param {Map<DiffFile, string>} fileHashes
 * @returns {string}
 */
function chapter(ch, i, anchorFor, fileHashes) {
  const id = `chapter-${i + 1}`;
  const body = ch.kind === 'html'
    ? `<div class="custom">${ch.html}</div>`
    : ch.hunks.map((sel) => fileBlock(sel.file, sel.hunks, sel.comments, anchorFor(sel.file), undefined, fileHashes.get(sel.file), sel.covers)).join('');
  const fl = chapterFileList(ch);
  const head = fl ? `<section class="chapter" data-files="${fl}"><h2 id="${id}">${esc(ch.title)}</h2><p class="chapter-viewed"></p>` : `<section class="chapter"><h2 id="${id}">${esc(ch.title)}</h2>`;
  return `${head}<div class="intro">${md(ch.intro)}</div>${body}</section>`;
}

/**
 * @param {DiffFile} f
 * @param {string} href
 * @returns {string}
 */
function fileIndexItem(f, href) {
  const adds = f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').length;
  const dels = f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'del').length;
  // <bdi> keeps the path left-to-right inside the right-to-left box report.css uses to clip long paths at the start.
  return `<li><a href="${href}" data-file="${esc(f.path)}" title="${esc(f.path)}"><bdi>${esc(f.path)}</bdi></a> <span class="add">+${adds}</span><span class="del">-${dels}</span></li>`;
}

// anchorId is set only on the first block rendered for a file (see renderHtml).
/**
 * @param {DiffFile} file
 * @param {Hunk[]} hunks
 * @param {PlacedComment[]} comments
 * @param {string | null} anchorId
 * @param {string | undefined} excludedReason set when the coverage count leaves the file out
 * @param {string | undefined} hash
 * @param {string | null} [covers]
 * @returns {string}
 */
function fileBlock(file, hunks, comments, anchorId, excludedReason, hash, covers) {
  const lang = languageFor(file.path);
  const name = file.status === 'renamed' ? `${esc(file.oldPath)} → ${esc(file.newPath)}` : esc(file.path);
  const kind = headerOnlyKind(file);
  // A permission change on a file that also has hunks would otherwise never be shown.
  const mode = kind === null && modeNote(file) ? `<span class="status mode">${esc(modeNote(file))}</span>` : '';
  const status = (file.status === 'modified' ? '' : `<span class="status ${file.status}">${file.status}</span>`) + mode;
  const tables = kind === null
    ? hunks.map((h) => hunkTable(h, comments, lang)).join('')
    : `<p class="muted">${headerOnlyText(file, kind)}</p>`;
  const idAttr = anchorId ? ` id="${anchorId}"` : '';
  // Files excluded from coverage are listed, not expanded: nobody reads a generated diff.
  if (excludedReason) {
    return `<details class="file excluded"${idAttr} data-path="${esc(file.path)}"><summary class="file-header"><span class="path">${name}</span>${status}<span class="muted">excluded: ${esc(excludedReason)}</span></summary>
<div class="file-body"><div class="diff-col">${tables}</div><aside class="notes-col"></aside></div>
</details>`;
  }
  return `<section class="file"${idAttr} data-path="${esc(file.path)}" data-hash="${hash}">
<header class="file-header"><span class="path">${name}</span>${status}<label class="viewed"><input type="checkbox" class="viewed-toggle"> Viewed</label></header>${covers ? `<div class="covers"><span class="covers-label">Covers</span>${md(covers)}</div>` : ''}
<div class="file-body"><div class="diff-col">${tables}</div><aside class="notes-col"></aside></div>
</section>`;
}

// Sentence shown instead of a diff table for a file that has no hunks.
/**
 * @param {DiffFile} file
 * @param {ReturnType<typeof headerOnlyKind>} kind
 * @returns {string}
 */
function headerOnlyText(file, kind) {
  if (kind === 'binary') return 'Binary file, no textual diff.';
  if (kind === 'mode') return `Mode changed ${esc(file.oldMode)} → ${esc(file.newMode)}, no content change.`;
  if (kind === 'rename') return 'Renamed, no content change.';
  if (file.status === 'added') return 'Empty file added.';
  if (file.status === 'deleted') return 'Empty file deleted.';
  return 'No content change.';
}

/**
 * @param {Hunk} hunk
 * @param {PlacedComment[]} comments
 * @param {string} lang
 * @returns {string}
 */
function hunkTable(hunk, comments, lang) {
  const rows = [`<tr class="hunk-header"><td colspan="3">${esc(hunkLabel(hunk))}</td></tr>`];
  for (const line of hunk.lines) {
    rows.push(`<tr class="line ${line.type}" data-old="${line.old ?? ''}" data-new="${line.new ?? ''}"><td class="num old">${line.old ?? ''}</td><td class="num new">${line.new ?? ''}</td><td class="code"><code class="language-${lang}">${esc(line.content)}</code></td></tr>`);
    for (const c of comments) {
      const hit = c.side === 'new' ? line.new === c.line : line.old === c.line;
      if (hit) rows.push(`<tr class="comment" data-anchor-side="${c.side}" data-anchor-line="${c.line}"><td colspan="3"><div class="callout">${md(c.text)}</div></td></tr>`);
    }
  }
  return `<table class="diff unified"><colgroup><col class="num"><col class="num"><col class="code"></colgroup>${rows.join('')}</table>`;
}

/**
 * @param {string} path
 * @returns {string}
 */
function languageFor(path) {
  // split always returns at least one part, so neither pop below comes back undefined.
  const base = /** @type {string} */ ((path ?? '').split('/').pop()).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = base.includes('.') ? /** @type {string} */ (base.split('.').pop()) : '';
  return LANG_BY_EXT[ext] ?? 'plaintext';
}

// Numbers the reviewer can trust: what share of the change the chapters show, and whether a
// reader pass came back with no open questions. The exclusion list goes in a
// collapsed block on the index page only.
/**
 * @param {Story} story
 * @param {DiffFile[]} files
 * @param {Report} report
 * @returns {{ line: string, excluded: string, excludedReason: Map<string, string> }}
 */
function coverageParts(story, files, report) {
  const cov = computeCoverage(story, files, report);
  const pct = Math.round(cov.ratio * 100);
  const np = story.meta.readerPass;
  /**
   * @param {number} n
   * @param {string} w
   */
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const pass = np
    ? ` Reader pass: ${plural(np.rounds, 'round')}, ${plural(np.questionsAnswered, 'question')} answered, ${np.openQuestions === 0 ? 'none' : np.openQuestions} still open.`.replace(', none still open.', ', none open.')
    : ' Reader pass: not yet run.';
  const line = `${cov.explained} of ${cov.total} changed lines shown in chapters (${pct}%).${pass}`;
  const excluded = cov.excluded.length
    ? `<details class="excluded"><summary>Excluded from the count: ${cov.excluded.length} file${cov.excluded.length === 1 ? '' : 's'}</summary><ul>${
      cov.excluded.map((e) => `<li>${esc(e.path)} <span class="muted">${esc(e.reason)}</span></li>`).join('')}</ul></details>`
    : '';
  return { line, excluded, excludedReason: new Map(cov.excluded.map((e) => [e.path, e.reason])) };
}

/**
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

// Paths the reader is not expected to tick: files the coverage count leaves out.
/**
 * @param {Story} story
 * @param {DiffFile[]} files
 * @param {Report} report
 * @returns {Set<string>}
 */
function excludedFiles(story, files, report) {
  return new Set(computeCoverage(story, files, report).excluded.map((e) => e.path));
}

// The paths a chapter shows, joined for a data-files attribute; empty for an html chapter.
/**
 * @param {ReportChapter} ch
 * @returns {string}
 */
function chapterFileList(ch) {
  return ch.kind === 'diff' ? [...new Set(ch.hunks.map((s) => s.file.path))].map(esc).join('|') : '';
}
