// @ts-check
// Page behaviour for review-report. Runs after highlight.js and mermaid script
// tags, both optional: every use is guarded so a blocked CDN leaves plain text.
//
// Notes layout: the renderer emits each comment as a <tr class="comment"> right
// after its anchor line. On load those rows are lifted out and re-placed by mode:
//   margin  — notes in a column beside the code, top-aligned to their line, pushed
//             down as needed so they never overlap (Docco style). Default.
//   inline  — the original GitHub-style rows between code lines.
//   below   — numbered notes under each hunk; automatic stand-in for margin when
//             the file block is narrow, in split view, or when printing.
//
// The script is one classic script (no modules), so it also loads from file://. Its code sits in a
// block to keep its names off the page's global scope. Strict mode matters for that: in sloppy mode
// a function declared inside a block also becomes a global.
'use strict';
{
  const THEME_KEY = 'review-report-theme';
  const NOTES_KEY = 'review-report-notes';
  const DIFF_KEY = 'review-report-diff';
  const root = document.documentElement;
  const VIEWED_KEY = `review-report:viewed:${root.dataset.reportId || 'report'}`;

  // The CDN libraries, read once. Either is undefined when its script tag was blocked or failed.
  /** @type {{ getLanguage?(lang: string): unknown, highlightElement(el: HTMLElement): void } | undefined} */
  const hljsLib = /** @type {any} */ (globalThis).hljs;
  /** @type {{ initialize(config: object): void, run(opts: { nodes: Element[] }): Promise<void> } | undefined} */
  const mermaidLib = /** @type {any} */ (globalThis).mermaid;

  // ---------- theme ----------
  // Persisted only when the user toggles; an untouched page keeps following the system setting.
  /**
   * @param {string} theme
   * @param {boolean} persist
   */
  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    const light = /** @type {HTMLLinkElement | null} */ (document.getElementById('hljs-light'));
    const dark = /** @type {HTMLLinkElement | null} */ (document.getElementById('hljs-dark'));
    if (light) light.disabled = theme === 'dark';
    if (dark) dark.disabled = theme !== 'dark';
    if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ } }
    renderDiagrams(theme);
  }
  const themeToggle = document.getElementById('theme-toggle');
  themeToggle?.addEventListener('click', () => {
    applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  systemTheme?.addEventListener?.('change', (ev) => {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
    if (!stored) applyTheme(ev.matches ? 'dark' : 'light', false);
  });

  // Mermaid re-renders from the saved source so a theme change repaints diagrams.
  // Mermaid cannot render two diagrams at once: concurrent runs draw into each other's
  // boxes and leave others empty. So all renders go through one queue, one diagram at a
  // time. A theme change starts a new generation; queued work from the old one is skipped.
  // Each diagram gets its own run: a syntax error in one leaves the others rendered and
  // only the broken one falls back to its source text.
  // The queue is a promise chain on purpose, not async/await: each render is appended to the
  // chain, so it starts only when everything queued before it has settled.
  let diagramQueue = Promise.resolve();
  let diagramGeneration = 0;
  /** @param {string} theme */
  function renderDiagrams(theme) {
    if (!mermaidLib) return;
    const nodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('pre.mermaid'));
    if (!nodes.length) return;
    const generation = ++diagramGeneration;
    let unusable = false;
    const current = () => generation === diagramGeneration;
    diagramQueue = diagramQueue.then(() => {
      if (current()) mermaidLib.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default' });
    }).catch(() => { unusable = true; }); // every diagram keeps what it shows now
    nodes.forEach((n) => {
      const restore = () => { n.textContent = n.dataset.source ?? ''; n.removeAttribute('data-processed'); };
      diagramQueue = diagramQueue.then(async () => {
        if (!current() || unusable) return;
        restore();
        await mermaidLib.run({ nodes: [n] });
        fitDiagram(n.closest('figure.diagram'));
      }).catch(restore); // a syntax error rejects; the queue moves on to the next diagram
    });
  }

  // A diagram wider than its column is shrunk to fit: the whole flow stays in view, but its text
  // can get small. Diagrams shrunk by more than a tenth get a "Full size" button; a smaller shrink
  // leaves the text readable, and a button there would be noise. The button draws the diagram at
  // its natural width and lets the box scroll sideways. The choice lives on the figure, so the
  // re-render after a theme change keeps it.
  /** @param {Element | null} fig */
  function fitDiagram(fig) {
    if (!fig) return;
    const svg = /** @type {SVGSVGElement | null} */ (fig.querySelector('pre.mermaid svg'));
    if (!svg?.viewBox?.baseVal?.width) return;
    const natural = svg.viewBox.baseVal.width;
    const full = fig.classList.contains('full');
    svg.style.width = full ? `${natural}px` : '';
    svg.style.maxWidth = full ? 'none' : `${natural}px`;
    const shrunk = !full && svg.getBoundingClientRect().width < natural * 0.9;
    let button = /** @type {HTMLButtonElement | null} */ (fig.querySelector('.diagram-size'));
    if (!button && (shrunk || full)) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'diagram-size';
      button.addEventListener('click', () => { fig.classList.toggle('full'); fitDiagram(fig); });
      fig.prepend(button);
    }
    if (!button) return;
    button.hidden = !(shrunk || full);
    button.textContent = full ? 'Fit to width' : 'Full size';
    button.setAttribute('aria-pressed', full ? 'true' : 'false');
  }
  function fitDiagrams() { document.querySelectorAll('figure.diagram').forEach(fitDiagram); }

  // Highlight only languages this hljs bundle ships; an unknown one would log two
  // console lines per row and change nothing. plaintext stays: it adds the .hljs
  // class the theme styles.
  if (hljsLib) {
    /** @type {Record<string, boolean>} */
    const known = {};
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('td.code code, pre > code'))) {
      const m = /language-([\w-]+)/.exec(el.className);
      const lang = m ? m[1] : '';
      if (!(lang in known)) known[lang] = !!hljsLib.getLanguage?.(lang);
      if (!known[lang]) continue;
      try { hljsLib.highlightElement(el); } catch { /* plain text */ }
    }
  }

  // ---------- notes: capture ----------
  /**
   * Links between the two views of a diff row, set once the split view is built.
   * @typedef {{ _splitRow?: Row, _unifiedRow?: Row }} Twins
   */
  /**
   * A diff row. `_wired` marks a row whose hover hint is already set up.
   * @typedef {HTMLTableRowElement & Twins & { _wired?: boolean }} Row
   */
  /**
   * A unified diff table. `_split` is its split-view twin, built on first use.
   * @typedef {HTMLTableElement & { _split?: HTMLTableElement }} DiffTable
   */
  /**
   * One note: its number in the file, its anchor line, and the elements a layout made for it.
   * @typedef {{ n: number, anchor: Row, table: DiffTable, el: HTMLElement, card: HTMLElement | null, marker: HTMLElement | null }} Note
   */
  /**
   * One file block of the renderer.
   * @typedef {{ section: HTMLElement, body: HTMLElement, notesCol: HTMLElement, notes: Note[], split: boolean }} Block
   */
  // One record per file block: its tables and the notes lifted out of them.
  /** @type {Block[]} */
  const blocks = [];
  for (const section of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('section.file'))) {
    const body = /** @type {HTMLElement | null} */ (section.querySelector('.file-body'));
    if (!body) continue; // not a renderer file block: an html chapter may reuse the class name
    /** @type {Note[]} */
    const notes = [];
    for (const table of /** @type {NodeListOf<DiffTable>} */ (section.querySelectorAll('table.diff.unified'))) {
      // querySelectorAll returns a static list, so removing rows while walking it is safe.
      for (const row of table.querySelectorAll('tr.comment')) {
        let anchor = row.previousElementSibling;
        while (anchor && !anchor.classList.contains('line')) anchor = anchor.previousElementSibling;
        if (!anchor) continue;
        notes.push({
          n: notes.length + 1,
          anchor: /** @type {Row} */ (anchor),
          table,
          el: /** @type {HTMLElement} */ (row.querySelector('.callout')),
          card: null,
          marker: null,
        });
        row.remove();
      }
    }
    const notesCol = /** @type {HTMLElement} */ (body.querySelector('.notes-col'));
    blocks.push({ section, body, notesCol, notes, split: false });
  }

  // ---------- split view ----------
  // Built lazily from the unified table. Pairs each run of deletions with the
  // following run of additions row by row. Each unified row remembers its split
  // row (_splitRow) so notes can find their anchor in either view. Only code rows
  // and hunk headers are read: comment rows inserted by inline mode are layout,
  // and would otherwise cut a deletion run off from its additions.
  /**
   * @param {DiffTable} unified
   * @returns {HTMLTableElement}
   */
  function buildSplit(unified) {
    const split = document.createElement('table');
    split.className = 'diff split';
    split.innerHTML = '<colgroup><col class="num"><col class="code"><col class="num"><col class="code"></colgroup>';
    const rows = /** @type {Row[]} */ ([...unified.rows]).filter((r) =>
      r.classList.contains('line') || r.classList.contains('hunk-header'));
    /**
     * @param {string} cls
     * @param {string | null} [text]
     * @param {Element | null} [code]
     */
    const cell = (cls, text, code) => {
      const td = document.createElement('td');
      td.className = cls;
      if (text) td.textContent = text;
      if (code) td.appendChild(code.cloneNode(true)); // the highlighted <code> only, never a note marker
      return td;
    };
    // Number and code cells for one side of a unified row.
    /**
     * @param {Row} tr
     * @param {'old' | 'new'} side
     */
    const sideCells = (tr, side) => {
      const type = tr.classList.contains('add') ? 'add' : tr.classList.contains('del') ? 'del' : 'ctx';
      const num = tr.getAttribute(side === 'old' ? 'data-old' : 'data-new');
      return [cell(`num ${side} ${type}`, num), cell(`code ${type}`, null, tr.querySelector('td.code code'))];
    };
    const emptyCells = () => [cell('num empty'), cell('code empty')];
    /**
     * @param {Row | null} left
     * @param {Row | null} right
     */
    const emitPair = (left, right) => {
      /** @type {Row} */
      const tr = document.createElement('tr');
      tr.className = 'line';
      tr.append(...(left ? sideCells(left, 'old') : emptyCells()), ...(right ? sideCells(right, 'new') : emptyCells()));
      if (left) left._splitRow = tr;
      if (right) right._splitRow = tr;
      tr._unifiedRow = /** @type {Row} */ (left ?? right); // every call passes at least one side
      split.appendChild(tr);
    };
    let i = 0;
    while (i < rows.length) {
      const tr = rows[i];
      if (tr.classList.contains('hunk-header')) {
        const header = document.createElement('tr');
        header.className = 'hunk-header';
        const td = document.createElement('td');
        td.colSpan = 4;
        td.textContent = /** @type {HTMLTableCellElement} */ (tr.querySelector('td')).textContent;
        header.appendChild(td);
        split.appendChild(header);
        i++; continue;
      }
      if (tr.classList.contains('ctx')) { emitPair(tr, tr); i++; continue; }
      /** @type {Row[]} */
      const dels = [];
      /** @type {Row[]} */
      const adds = [];
      while (i < rows.length && rows[i].classList.contains('del')) dels.push(rows[i++]);
      while (i < rows.length && rows[i].classList.contains('add')) adds.push(rows[i++]);
      const n = Math.max(dels.length, adds.length);
      if (n === 0) { i++; continue; } // a .line row of no known type; never emitted by the renderer
      for (let k = 0; k < n; k++) emitPair(dels[k] ?? null, adds[k] ?? null);
    }
    return split;
  }

  // ---------- diff layout: one setting for the whole report ----------
  /**
   * @param {Block} block
   * @param {boolean} on
   */
  function setSplit(block, on) {
    block.section.querySelectorAll('table.diff.unified').forEach((el) => {
      const u = /** @type {DiffTable} */ (el);
      if (on && !u._split) { u._split = buildSplit(u); u.after(u._split); }
      u.style.display = on ? 'none' : '';
      if (u._split) u._split.style.display = on ? '' : 'none';
    });
    block.split = on;
  }

  // Keep the reader's place across a layout change: remember the diff row (or
  // file header) at the top of the viewport and its offset, re-lay out, then scroll
  // so the same row sits at the same offset. Rows map 1:1 between unified and split.
  // A stuck file header is skipped: it stays at the top while the code under it moves,
  // so anchoring on it would keep nothing in place.
  function anchorOnScreen() {
    const rows = /** @type {NodeListOf<HTMLElement & Twins>} */ (document.querySelectorAll('tr.line, header.file-header, h2'));
    for (const row of rows) {
      if (row.matches('header.file-header') && /** @type {Element} */ (row.closest('section.file')).getBoundingClientRect().top < 0) continue;
      const r = row.getBoundingClientRect();
      if (r.bottom > 0 && row.offsetParent !== null) return { el: row, offset: r.top };
    }
    return null;
  }
  /** @param {HTMLElement & Twins} el */
  function counterpart(el) {
    if (!el?.classList.contains('line')) return el;
    if (el.offsetParent !== null) return el;
    if (el._splitRow && el._splitRow.offsetParent !== null) return el._splitRow;
    if (el._unifiedRow && el._unifiedRow.offsetParent !== null) return el._unifiedRow;
    return el;
  }
  /** @param {ReturnType<typeof anchorOnScreen>} anchor */
  function restoreAnchor(anchor) {
    if (!anchor) return;
    const el = counterpart(anchor.el);
    const top = el.getBoundingClientRect().top;
    window.scrollBy(0, top - anchor.offset);
  }
  // Runs a layout change with the reader's place preserved.
  /** @param {() => void} change */
  function withPlaceKept(change) {
    const anchor = anchorOnScreen();
    change();
    restoreAnchor(anchor);
  }

  const diffToggle = document.getElementById('diff-toggle');
  /**
   * @param {string} mode
   * @param {boolean} persist
   */
  function applyDiffMode(mode, persist) {
    root.dataset.diff = mode;
    if (persist) { try { localStorage.setItem(DIFF_KEY, mode); } catch { /* private mode */ } }
    blocks.forEach((b) => setSplit(b, mode === 'split'));
    if (diffToggle) diffToggle.textContent = `Diff: ${mode}`;
    layoutAll();
  }
  diffToggle?.addEventListener('click', () => {
    withPlaceKept(() => applyDiffMode(root.dataset.diff === 'split' ? 'unified' : 'split', true));
  });

  // ---------- notes: placement ----------
  /** @param {Block} block */
  function clearNotes(block) {
    if (hint && hint.block === block) closeHint();
    block.section.querySelectorAll('tr.annotated').forEach((el) => {
      const r = /** @type {Row} */ (el);
      r._wired = false;
      r.classList.remove('annotated');
    });
    block.section.querySelectorAll('.hint-target').forEach((c) => c.classList.remove('hint-target'));
    block.notes.forEach((n) => { n.card = null; n.marker = null; });
    block.section.querySelectorAll('tr.comment, .notes-below, .note-marker').forEach((n) => n.remove());
    block.section.querySelectorAll('td.note-anchor').forEach((c) => c.classList.remove('note-anchor'));
    block.notesCol.innerHTML = '';
    block.body.classList.remove('has-margin');
  }
  /**
   * @param {Note} note
   * @param {Block} block
   * @returns {Row}
   */
  function visibleRow(note, block) {
    return block.split && note.anchor._splitRow ? note.anchor._splitRow : note.anchor;
  }
  /**
   * @param {Note} note
   * @param {Block} block
   * @returns {HTMLTableElement}
   */
  function visibleTable(note, block) {
    return block.split && note.table._split ? note.table._split : note.table;
  }
  // All notes whose anchor currently renders on this row, in story order.
  /** @param {Element | null} row */
  function notesOnRow(row) {
    return blocks.flatMap((b) => b.notes.filter((n) => visibleRow(n, b) === row));
  }
  /** @param {number} n */
  function marker(n) {
    const m = document.createElement('span');
    m.className = 'note-marker';
    m.textContent = String(n);
    return m;
  }

  // Hovering the text of an annotated line opens its notes in a row inserted right
  // under that line. The code below moves down instead of being covered, so the next
  // lines stay readable; leaving the text removes the row and the code moves back.
  // Clicking the circle pins the row open until it, or the page, is clicked again.
  /**
   * The open hint row: the code row it opens under, the inserted row, the margin cards it pushed down,
   * and the notes column height before the push (null when nothing was pushed).
   * @typedef {{ row: HTMLTableRowElement, tr: HTMLTableRowElement, block: Block | undefined, shifted: HTMLElement[], colHeight: string | null }} Hint
   */
  /** @type {Note | null} */
  let pinned = null;   // the note whose hint row stays open
  /** @type {Hint | null} */
  let hint = null;     // the open hint row
  function clearActive() {
    blocks.forEach((b) => b.notes.forEach((n) => n.card?.classList.remove('active')));
  }
  /** @param {Element} row */
  function blockOf(row) {
    const sec = row.closest('section.file');
    return blocks.find((b) => b.section === sec);
  }
  function closeHint() {
    if (!hint) return;
    hint.shifted.forEach((card) => { card.style.transform = ''; });
    if (hint.colHeight !== null && hint.block) hint.block.notesCol.style.minHeight = hint.colHeight;
    hint.tr.remove();
    hint = null;
    clearActive();
  }
  /**
   * @param {HTMLTableRowElement} row
   * @param {Note[]} notes
   * @param {boolean} isPinned
   */
  function openHint(row, notes, isPinned) {
    if (hint?.row === row) { hint.tr.classList.toggle('pinned', isPinned); return; }
    closeHint();
    const tr = document.createElement('tr');
    tr.className = `hint-row${isPinned ? ' pinned' : ''}`;
    const gutter = document.createElement('td');
    gutter.colSpan = row.querySelectorAll('td.num').length || 1;
    gutter.className = 'hint-gutter';
    const td = document.createElement('td');
    td.colSpan = Math.max(1, row.children.length - gutter.colSpan);
    notes.forEach((n) => td.appendChild(n.el.cloneNode(true)));
    tr.appendChild(gutter);
    tr.appendChild(td);
    tr.addEventListener('click', (ev) => ev.stopPropagation()); // reading or selecting in a pinned hint keeps it open
    row.after(tr);
    // Margin cards are positioned absolutely; move the ones below the line down by the
    // same amount so they stay level with their code.
    const block = blockOf(row);
    /** @type {HTMLElement[]} */
    const shifted = [];
    /** @type {string | null} */
    let colHeight = null;
    if (block?.body.classList.contains('has-margin')) {
      const h = tr.offsetHeight;
      // The notes column grows with the pushed cards, so the lowest card never hangs past the block.
      colHeight = block.notesCol.style.minHeight;
      block.notesCol.style.minHeight = `${(parseFloat(colHeight) || 0) + h}px`;
      const cut = row.getBoundingClientRect().bottom - block.body.getBoundingClientRect().top;
      for (const n of block.notes) {
        // Cards of this line's own notes stay put; only cards for lines below move.
        if (!n.card || notes.includes(n)) continue;
        if (parseFloat(n.card.style.top) >= cut - 1) { n.card.style.transform = `translateY(${h}px)`; shifted.push(n.card); }
      }
    }
    hint = { row, tr, block, shifted, colHeight };
    clearActive();
    notes.forEach((n) => n.card?.classList.add('active'));
  }
  // The source text itself is the hover target: the inline <code> box ends where the
  // text ends, so empty space in the cell, the line-number column and the margin all
  // dismiss the hint. The circle stays as the cue and the pin control.
  /**
   * @param {Row} row
   * @param {Note[]} notes
   * @param {Element} cell
   */
  function wireRow(row, notes, cell) {
    row.classList.add('annotated');
    const text = cell.querySelector('code') ?? cell;
    text.classList.add('hint-target');
    text.addEventListener('mouseenter', () => { if (!pinned) openHint(row, notes, false); });
    text.addEventListener('mouseleave', () => { if (!pinned && hint?.row === row) closeHint(); });
  }
  function unpin() {
    pinned = null;
    closeHint();
  }
  // Every layout rebuilds the markers and drops the hint row. The pinned note
  // re-opens under its new marker's line, or lets go when the mode has none (inline).
  function refreshPinned() {
    if (!pinned) return;
    if (pinned.marker?.isConnected) {
      const row = /** @type {HTMLTableRowElement} */ (pinned.marker.closest('tr'));
      openHint(row, notesOnRow(row), true);
    } else unpin();
  }
  /**
   * @param {HTMLElement} el
   * @param {Note} note
   */
  function wireMarker(el, note) {
    el.addEventListener('mouseenter', (ev) => {
      ev.stopPropagation();
      if (!pinned) { const row = /** @type {HTMLTableRowElement} */ (el.closest('tr')); openHint(row, notesOnRow(row), false); }
    });
    el.addEventListener('mouseleave', () => { if (!pinned && hint?.row === el.closest('tr')) closeHint(); });
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (pinned === note) { unpin(); return; }
      pinned = note;
      const row = /** @type {HTMLTableRowElement} */ (el.closest('tr'));
      openHint(row, notesOnRow(row), true);
    });
  }
  document.addEventListener('click', () => { if (pinned) unpin(); });

  let printing = false;
  /**
   * @param {Block} block
   * @returns {'inline' | 'below' | 'margin'}
   */
  function effectiveMode(block) {
    const wanted = root.dataset.notes === 'inline' ? 'inline' : 'margin';
    if (wanted === 'inline') return 'inline';
    if (printing || block.split || block.body.clientWidth < 900) return 'below';
    return 'margin';
  }
  /** @param {Block} block */
  function layoutBlock(block) {
    clearNotes(block);
    if (!block.notes.length) return;
    const mode = effectiveMode(block);

    if (mode === 'inline') {
      block.notes.forEach((note) => {
        const row = visibleRow(note, block);
        const tr = document.createElement('tr');
        tr.className = 'comment';
        const td = document.createElement('td');
        td.colSpan = block.split ? 4 : 3;
        td.appendChild(note.el);
        tr.appendChild(td);
        // After any notes already placed under this row, so several notes on one line keep story order.
        /** @type {Element} */
        let last = row;
        while (last.nextElementSibling?.classList.contains('comment')) last = last.nextElementSibling;
        last.after(tr);
      });
      return;
    }

    // Both remaining modes mark the anchor line and number the notes.
    block.notes.forEach((note) => {
      const row = visibleRow(note, block);
      const cells = row.querySelectorAll('td.code');
      const cell = cells.length === 1 ? cells[0] : (note.anchor.classList.contains('del') ? cells[0] : cells[1]);
      cell.classList.add('note-anchor');
      const m = marker(note.n);
      wireMarker(m, note);
      note.marker = m;
      cell.appendChild(m);
      if (!row._wired) { row._wired = true; wireRow(row, notesOnRow(row), cell); }
    });

    if (mode === 'below') {
      /** @type {Map<HTMLTableElement, Note[]>} */
      const byTable = new Map();
      block.notes.forEach((note) => {
        const t = visibleTable(note, block);
        const list = byTable.get(t) ?? [];
        byTable.set(t, list);
        list.push(note);
      });
      byTable.forEach((notes, table) => {
        const box = document.createElement('div');
        box.className = 'notes-below';
        notes.forEach((note) => {
          const item = document.createElement('div');
          item.className = 'note';
          item.appendChild(marker(note.n));
          item.appendChild(note.el);
          note.card = item;
          box.appendChild(item);
        });
        table.after(box);
      });
      return;
    }

    // margin: absolute-position each note at its anchor's top, then push down to avoid overlap.
    // All cards are appended first and all positions read before any top is written,
    // so the browser lays the block out once instead of once per note.
    block.body.classList.add('has-margin');
    const items = block.notes.map((note) => {
      const item = document.createElement('div');
      item.className = 'note';
      item.appendChild(marker(note.n));
      item.appendChild(note.el);
      note.card = item;
      block.notesCol.appendChild(item);
      return item;
    });
    const bodyTop = block.body.getBoundingClientRect().top;
    const tops = block.notes.map((note) => visibleRow(note, block).getBoundingClientRect().top - bodyTop);
    const heights = items.map((item) => item.offsetHeight);
    let cursor = 0;
    items.forEach((item, k) => {
      const top = Math.max(tops[k], cursor);
      item.style.top = `${top}px`;
      cursor = top + heights[k] + 8;
    });
    // The column must be tall enough for the last note even if it hangs below the code.
    block.notesCol.style.minHeight = `${cursor - 8}px`;
  }
  function layoutAll() {
    blocks.forEach(layoutBlock);
    refreshPinned();
    if (!notesToggle) return;
    const wanted = root.dataset.notes === 'inline' ? 'inline' : 'margin';
    const anyBelow = wanted === 'margin' && blocks.some((b) => b.notes.length && effectiveMode(b) === 'below');
    notesToggle.textContent = `Notes: ${wanted}${anyBelow ? ' (below hunks here)' : ''}`;
    notesToggle.title = anyBelow
      ? 'Margin notes need a wider window; in split view and narrow blocks they are listed below each hunk'
      : 'Notes beside the code, or inline between lines';
  }

  const notesToggle = document.getElementById('notes-toggle');
  /**
   * @param {string} mode
   * @param {boolean} persist
   */
  function applyNotesMode(mode, persist) {
    root.dataset.notes = mode;
    if (persist) { try { localStorage.setItem(NOTES_KEY, mode); } catch { /* private mode */ } }
    layoutAll();
  }
  notesToggle?.addEventListener('click', () => {
    withPlaceKept(() => applyNotesMode(root.dataset.notes === 'inline' ? 'margin' : 'inline', true));
  });

  // ---------- viewed: manual, per report, per file ----------
  // Stored as { path: hash } under a key that includes the report id. A tick is kept
  // only while the file's diff hash still matches, so a re-render that changed the
  // file drops the tick for that file and nothing else.
  /**
   * A renderer file block with its diff hash. The renderer always sets `data-path` and `data-hash` together.
   * @typedef {HTMLElement & { dataset: { path: string, hash: string } }} FileSection
   */
  /** @returns {Record<string, string>} */
  function readViewed() {
    // An empty stored value counts as none.
    try { return JSON.parse(localStorage.getItem(VIEWED_KEY) || '{}') || {}; } catch { return {}; }
  }
  /** @param {Record<string, string>} state */
  function writeViewed(state) {
    try { localStorage.setItem(VIEWED_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }
  /** @param {string} path */
  function fileBlocks(path) {
    return [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('section.file'))].filter((s) => s.dataset.path === path);
  }
  /**
   * @param {string} path
   * @param {boolean} on
   */
  function markViewed(path, on) {
    fileBlocks(path).forEach((sec) => {
      sec.classList.toggle('is-viewed', on);
      const box = /** @type {HTMLInputElement | null} */ (sec.querySelector('.viewed-toggle'));
      if (box) box.checked = on;
    });
    const links = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.file-index a[data-file]'));
    for (const a of links) {
      if (a.dataset.file === path) a.parentElement?.classList.toggle('is-viewed', on);
    }
  }
  /** @param {Record<string, string>} state */
  function updateProgress(state) {
    const viewed = Object.keys(state).length;
    const counts = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.viewed-count'));
    for (const el of counts) {
      const total = Number(el.dataset.total) || 0;
      el.textContent = `${viewed} of ${total} viewed`;
      const fill = /** @type {HTMLElement | null | undefined} */ (el.parentElement?.querySelector('.fill'));
      if (fill) fill.style.width = `${total ? Math.min(100, Math.round(viewed / total * 100)) : 0}%`;
    }
    // Per chapter: the index list, the sidebar entry and the chapter heading all show how many of
    // the chapter's files are viewed, and switch to a tick when all are.
    /** @param {HTMLElement} el */
    const chapterCount = (el) => {
      const paths = el.dataset.files ? el.dataset.files.split('|') : [];
      return { total: paths.length, done: paths.filter((p) => p in state).length };
    };
    const indexEntries = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.chapter-list li[data-files]'));
    for (const li of indexEntries) {
      const n = chapterCount(li);
      if (!n.total) continue;
      let tag = li.querySelector('.viewed-of');
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'viewed-of';
        const link = /** @type {Element} */ (li.querySelector('a'));
        link.insertAdjacentElement('afterend', tag);
      }
      tag.textContent = `${n.done} of ${n.total} viewed`;
      li.classList.toggle('is-viewed', n.done === n.total);
    }
    const tocEntries = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.toc li[data-files]'));
    for (const li of tocEntries) {
      const n = chapterCount(li);
      const tag = li.querySelector('.chapter-progress');
      if (tag) tag.textContent = n.done === n.total ? '' : `${n.done}/${n.total}`;
      li.classList.toggle('is-viewed', n.total > 0 && n.done === n.total);
    }
    const chapters = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('section.chapter[data-files]'));
    for (const sec of chapters) {
      const n = chapterCount(sec);
      const tag = sec.querySelector('.chapter-viewed');
      if (tag) tag.textContent = n.done === n.total ? 'All files viewed' : `${n.done} of ${n.total} files viewed`;
      sec.classList.toggle('is-viewed', n.total > 0 && n.done === n.total);
    }
  }
  // A re-render after the branch moved gets a new report id (the id hashes the diff), so ticks made
  // on earlier renders live under other keys. Merge them in, once per earlier render: only files whose
  // diff hash is unchanged (a file new commits touched needs a fresh look), and never twice, so a file
  // unticked after the merge stays unticked. The merged render ids are remembered under ADOPTED_KEY.
  function adoptEarlierTicks() {
    try {
      const id = root.dataset.reportId ?? '';
      const prefix = `review-report:viewed:${id.replace(/-[0-9a-f]{8}$/, '')}-`;
      const ADOPTED_KEY = `review-report:adopted:${id}`;
      // An empty stored value counts as none, here and for each earlier render below.
      /** @type {string[]} */
      const done = JSON.parse(localStorage.getItem(ADOPTED_KEY) || '[]') || [];
      /** @type {Record<string, string>} */
      const current = {};
      const files = /** @type {NodeListOf<FileSection>} */ (document.querySelectorAll('section.file[data-hash]'));
      for (const sec of files) current[sec.dataset.path] = sec.dataset.hash;
      const state = readViewed();
      let merged = false;
      // localStorage is not iterable: walk it by index.
      for (let i = 0; i < localStorage.length; i++) {
        const k = /** @type {string} */ (localStorage.key(i)); // never null below localStorage.length
        if (k === VIEWED_KEY || !k.startsWith(prefix) || !/^[0-9a-f]{8}$/.test(k.slice(prefix.length)) || done.includes(k)) continue;
        /** @type {Record<string, string>} */
        const old = JSON.parse(localStorage.getItem(k) || '{}') || {};
        Object.keys(old).forEach((p) => { if (current[p] && old[p] === current[p] && !(p in state)) { state[p] = old[p]; merged = true; } });
        done.push(k);
      }
      if (merged) writeViewed(state);
      localStorage.setItem(ADOPTED_KEY, JSON.stringify(done));
    } catch { /* storage unavailable: keep what this render has */ }
  }
  function initViewed() {
    adoptEarlierTicks();
    const state = readViewed();
    let changed = false;
    // Drop ticks for files whose diff changed since they were ticked.
    const files = /** @type {NodeListOf<FileSection>} */ (document.querySelectorAll('section.file[data-hash]'));
    for (const sec of files) {
      const p = sec.dataset.path;
      if (p in state && state[p] !== sec.dataset.hash) { delete state[p]; changed = true; }
    }
    if (changed) writeViewed(state);
    Object.keys(state).forEach((p) => markViewed(p, true));
    updateProgress(state);
    const boxes = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.viewed-toggle'));
    for (const box of boxes) {
      box.addEventListener('change', () => {
        const sec = /** @type {FileSection} */ (box.closest('section.file'));
        const stuck = sec.getBoundingClientRect().top < 0; // ticked from the sticky header, mid-file
        toggleViewed(sec.dataset.path, sec.dataset.hash, box.checked);
        // The file folded under the reader: bring its header to the top so the next file follows right below.
        if (stuck && box.checked) window.scrollBy(0, sec.getBoundingClientRect().top);
      });
    }
  }
  /**
   * @param {string} path
   * @param {string} hash
   * @param {boolean} on
   */
  function toggleViewed(path, hash, on) {
    const state = readViewed();
    if (on) state[path] = hash; else delete state[path];
    writeViewed(state);
    markViewed(path, on);
    updateProgress(state);
  }
  // Ticks made in another tab of the same report show up here too.
  window.addEventListener('storage', (ev) => {
    if (ev.key !== VIEWED_KEY) return;
    const state = readViewed();
    const files = /** @type {NodeListOf<FileSection>} */ (document.querySelectorAll('section.file[data-path]'));
    for (const sec of files) markViewed(sec.dataset.path, sec.dataset.path in state);
    updateProgress(state);
  });
  // `v` toggles the file block under the pointer; ignored while typing.
  /** @type {HTMLElement | null} */
  let hoveredBlock = null;
  document.addEventListener('mouseover', (ev) => {
    const sec = ev.target instanceof Element ? /** @type {HTMLElement | null} */ (ev.target.closest('section.file')) : null;
    if (sec) hoveredBlock = sec;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'v' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = /** @type {HTMLElement | null} */ (ev.target);
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!hoveredBlock?.dataset.hash) return;
    const sec = /** @type {FileSection} */ (hoveredBlock); // it has a hash, so it is a renderer file block
    const on = !sec.classList.contains('is-viewed');
    withPlaceKept(() => toggleViewed(sec.dataset.path, sec.dataset.hash, on));
  });

  window.addEventListener('beforeprint', () => { printing = true; layoutAll(); });
  window.addEventListener('afterprint', () => { printing = false; layoutAll(); });
  // Note positions depend on block width only; a height-only resize changes nothing.
  /** @type {number | undefined} */
  let resizeTimer;
  let laidOutWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (window.innerWidth === laidOutWidth) return;
      laidOutWidth = window.innerWidth;
      layoutAll();
      fitDiagrams(); // a narrower window can shrink a diagram that fitted before
    }, 100);
  });

  applyTheme(root.dataset.theme || 'light', false);
  if (root.dataset.diff === 'split') blocks.forEach((b) => setSplit(b, true));
  if (diffToggle) diffToggle.textContent = `Diff: ${root.dataset.diff === 'split' ? 'split' : 'unified'}`;
  applyNotesMode(root.dataset.notes === 'inline' ? 'inline' : 'margin', false);
  initViewed();
  // Highlighting and fonts can change row heights after first layout.
  window.addEventListener('load', layoutAll);
}
