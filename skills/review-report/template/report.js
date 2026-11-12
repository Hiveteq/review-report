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
//
// Layout of this file: shared constants first, then plain functions grouped by topic, then one factory
// per feature (diagrams, hints, layout, viewed, settings) that owns that feature's state, and last a
// short wiring section that creates the features, adds the listeners and starts the page.
'use strict';
{
  // ---------- constants and elements ----------
  // Everything is declared before the wiring section at the end runs any code, so no function can reach a
  // name whose declaration has not run yet.

  // Storage keys. Readers' browsers already hold ticks and settings under these exact strings.
  const KEYS = Object.freeze({
    viewed: 'review-report:viewed:', // + report id: { path: diff hash } for each ticked file
    adopted: 'review-report:adopted:', // + report id: the earlier renders whose ticks were merged in
    theme: 'review-report-theme',
    notes: 'review-report-notes',
    diff: 'review-report-diff',
  });

  const root = document.documentElement;
  const VIEWED_KEY = `${KEYS.viewed}${root.dataset.reportId || 'report'}`;
  const themeToggle = document.getElementById('theme-toggle');
  const diffToggle = document.getElementById('diff-toggle');
  const notesToggle = document.getElementById('notes-toggle');
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');

  /**
   * The part of highlight.js this script uses.
   * @typedef {object} Hljs
   * @property {(lang: string) => unknown} [getLanguage]
   * @property {(el: HTMLElement) => void} highlightElement
   */
  /**
   * The part of Mermaid this script uses.
   * @typedef {object} Mermaid
   * @property {(config: object) => void} initialize
   * @property {(opts: { nodes: Element[] }) => Promise<void>} run
   */
  // The CDN libraries, read once. Either is undefined when its script tag was blocked or failed.
  const { hljs: hljsLib, mermaid: mermaidLib } = /** @type {Window & { hljs?: Hljs, mermaid?: Mermaid }} */ (window);

  /**
   * One note: its number in the file, its anchor line, and the elements a layout made for it.
   * @typedef {{ n: number, anchor: HTMLTableRowElement, table: HTMLTableElement, el: HTMLElement, card: HTMLElement | null, marker: HTMLElement | null }} Note
   */
  /**
   * One file block of the renderer.
   * @typedef {{ section: HTMLElement, body: HTMLElement, notesCol: HTMLElement, notes: Note[], split: boolean }} Block
   */
  /**
   * The open hint row. colHeight is the notes column height before the push, null when nothing was pushed.
   * @typedef {{ row: HTMLTableRowElement, notes: Note[], tr: HTMLTableRowElement, block: Block | undefined, shifted: HTMLElement[], colHeight: string | null }} Hint
   */

  // Data kept per element. Weak maps let an element and its data go together when the element is removed.

  /** @type {WeakMap<HTMLTableRowElement, HTMLTableRowElement>} unified row → its row in the split view */
  const splitRowOf = new WeakMap();
  /** @type {WeakMap<HTMLTableRowElement, HTMLTableRowElement>} split row → the unified row it shows */
  const unifiedRowOf = new WeakMap();
  /** @type {WeakMap<HTMLElement, HTMLTableElement>} unified table → its split view, built on first use */
  const splitTableOf = new WeakMap();

  // Where a file block's notes go, by the mode the layout picks for it.
  const LAYOUTS = Object.freeze({ inline: layoutInline, below: layoutBelow, margin: layoutMargin });
  // A line's numbered circle, as opposed to the circle on its card in the margin or below the hunk.
  const LINE_MARKER = 'td.note-anchor > .note-marker';
  // The parts of an annotated line that open its notes on hover: its code text and its circles.
  const HOVER_ZONE = `.hint-target, ${LINE_MARKER}`;

  // ---------- storage ----------
  // Every localStorage access goes through here. Storage can be unavailable (some private modes,
  // blocked site data), and then each access throws; the page then works for this visit only.
  // A stored value can be damaged by a hand edit, another tool or a cut-off write. So parsed JSON
  // is checked before use, and a value that fails the check counts as nothing stored.
  const storage = Object.freeze({
    /**
     * @param {string} key
     * @returns {string | null} null when nothing is stored or storage is unavailable
     */
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; } // unavailable: nothing stored
    },
    /**
     * @param {string} key
     * @param {string} value
     */
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* unavailable or full: the value is not saved */ }
    },
    /**
     * The stored JSON value, or null when it is missing, empty, not JSON or fails `isValid`.
     * @template T
     * @param {string} key
     * @param {(value: unknown) => value is T} isValid
     * @returns {T | null}
     */
    json(key, isValid) {
      const text = storage.get(key);
      if (!text) return null;
      try {
        const value = JSON.parse(text);
        return isValid(value) ? value : null;
      } catch { return null; } // not JSON: damaged
    },
    /** @returns {string[]} every stored key; none when storage is unavailable */
    keys() {
      try {
        // Storage is not iterable: walk it by index. key(i) is never null below length.
        return Array.from({ length: localStorage.length }, (_, i) => /** @type {string} */ (localStorage.key(i)));
      } catch { return []; } // unavailable: nothing stored
    },
  });
  /**
   * An object as JSON.parse makes it: not null, not an array.
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
  }
  /**
   * @param {unknown} value
   * @returns {value is string[]}
   */
  function isStringList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  // ---------- code highlighting ----------
  // Highlight only languages this hljs bundle ships; an unknown one would log two
  // console lines per row and change nothing. plaintext stays: it adds the .hljs
  // class the theme styles.
  function highlightCode() {
    if (!hljsLib) return;
    /**
     * A Map, not an object: a fence tagged `constructor` or `toString` would find the object's
     * inherited property and pass for a known language.
     * @type {Map<string, boolean>}
     */
    const known = new Map();
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('td.code code, pre > code'))) {
      const m = /language-([\w-]+)/.exec(el.className);
      const lang = m ? m[1] : '';
      if (!known.has(lang)) known.set(lang, Boolean(hljsLib.getLanguage?.(lang)));
      if (!known.get(lang)) continue;
      try { hljsLib.highlightElement(el); } catch { /* plain text */ }
    }
  }
  /**
   * The highlight.js stylesheet for a theme: the page carries both and enables one.
   * @param {string} theme
   */
  function showCodeTheme(theme) {
    const light = /** @type {HTMLLinkElement | null} */ (document.getElementById('hljs-light'));
    const dark = /** @type {HTMLLinkElement | null} */ (document.getElementById('hljs-dark'));
    if (light) light.disabled = theme === 'dark';
    if (dark) dark.disabled = theme !== 'dark';
  }

  // ---------- notes: capture ----------
  /** @returns {Block[]} */
  function captureBlocks() {
    const sections = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('section.file'));
    return [...sections].flatMap((section) => {
      const body = /** @type {HTMLElement | null} */ (section.querySelector('.file-body'));
      if (!body) return []; // not a renderer file block: an html chapter may reuse the class name
      const notesCol = /** @type {HTMLElement} */ (body.querySelector('.notes-col'));
      return [{ section, body, notesCol, notes: liftNotes(section), split: false }];
    });
  }
  /**
   * Takes the note rows out of a file block's tables, in story order.
   * @param {HTMLElement} section
   * @returns {Note[]}
   */
  function liftNotes(section) {
    /** @type {Note[]} */
    const notes = [];
    for (const table of /** @type {NodeListOf<HTMLTableElement>} */ (section.querySelectorAll('table.diff.unified'))) {
      // querySelectorAll returns a static list, so removing rows while walking it is safe.
      for (const row of table.querySelectorAll('tr.comment')) {
        const anchor = anchorOf(row);
        if (!anchor) continue;
        notes.push({
          n: notes.length + 1,
          anchor,
          table,
          el: /** @type {HTMLElement} */ (row.querySelector('.callout')),
          card: null,
          marker: null,
        });
        row.remove();
      }
    }
    return notes;
  }
  /**
   * @param {Element} row a note row
   * @returns {HTMLTableRowElement | null} the code line the note belongs to: the nearest one above it
   */
  function anchorOf(row) {
    let anchor = row.previousElementSibling;
    while (anchor && !anchor.classList.contains('line')) anchor = anchor.previousElementSibling;
    return /** @type {HTMLTableRowElement | null} */ (anchor);
  }

  // ---------- split view ----------
  // Built lazily from the unified table. A hunk header stays a row of its own, a context line shows on
  // both sides, and each run of deletions is paired row by row with the run of additions after it.
  // Each unified row remembers its split row (splitRowOf) so notes can find their anchor in either view.
  // Only code rows and hunk headers are read: comment rows inserted by inline mode are layout,
  // and would otherwise cut a deletion run off from its additions.

  /**
   * One row of the split view: a hunk header, or a line pair where a side without a line is null.
   * @typedef {{ header: HTMLTableRowElement } | { left: HTMLTableRowElement | null, right: HTMLTableRowElement | null }} SplitItem
   */
  /**
   * The split view's rows, paired from the unified table's. Reads only class names and builds nothing.
   * @param {HTMLTableRowElement[]} rows code lines and hunk headers, in table order
   * @yields {SplitItem}
   * @returns {Generator<SplitItem>} typed here because TypeScript infers each yield's own shape, not SplitItem
   */
  function* pairRows(rows) {
    // A scan with a cursor: how far each step moves depends on the runs it finds there.
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      if (row.classList.contains('hunk-header')) {
        yield { header: row };
        i += 1;
      } else if (row.classList.contains('ctx')) {
        yield { left: row, right: row };
        i += 1;
      } else {
        const dels = runOf(rows, i, 'del');
        const adds = runOf(rows, i + dels.length, 'add');
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) yield { left: dels[k] ?? null, right: adds[k] ?? null };
        // A line of no known type, which the renderer never emits, is skipped.
        i += Math.max(1, dels.length + adds.length);
      }
    }
  }
  /**
   * @param {HTMLTableRowElement[]} rows
   * @param {number} start
   * @param {string} cls
   * @returns {HTMLTableRowElement[]} the rows from start on that have the class, up to the first one that has not
   */
  function runOf(rows, start, cls) {
    let end = start;
    while (end < rows.length && rows[end].classList.contains(cls)) end += 1;
    return rows.slice(start, end);
  }
  /**
   * @param {HTMLTableElement} unified
   * @returns {HTMLTableElement}
   */
  function buildSplit(unified) {
    const split = document.createElement('table');
    split.className = 'diff split';
    split.innerHTML = '<colgroup><col class="num"><col class="code"><col class="num"><col class="code"></colgroup>';
    const rows = [...unified.rows].filter((r) =>
      r.classList.contains('line') || r.classList.contains('hunk-header'));
    split.append(...Array.from(pairRows(rows), (item) => ('header' in item ? splitHeader(item.header) : splitLine(item))));
    return split;
  }
  /**
   * @param {HTMLTableRowElement} unified a hunk header of the unified table
   * @returns {HTMLTableRowElement} the same header across all four columns
   */
  function splitHeader(unified) {
    const header = document.createElement('tr');
    header.className = 'hunk-header';
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = /** @type {HTMLTableCellElement} */ (unified.querySelector('td')).textContent;
    header.append(td);
    return header;
  }
  /**
   * @param {{ left: HTMLTableRowElement | null, right: HTMLTableRowElement | null }} pair at least one side is a line
   * @returns {HTMLTableRowElement}
   */
  function splitLine({ left, right }) {
    const tr = document.createElement('tr');
    tr.className = 'line';
    tr.append(...(left ? sideCells(left, 'old') : emptyCells()), ...(right ? sideCells(right, 'new') : emptyCells()));
    if (left) splitRowOf.set(left, tr);
    if (right) splitRowOf.set(right, tr);
    unifiedRowOf.set(tr, /** @type {HTMLTableRowElement} */ (left ?? right));
    return tr;
  }
  /**
   * @param {HTMLTableRowElement} tr a unified code line
   * @param {'old' | 'new'} side
   * @returns {HTMLTableCellElement[]} the number and code cells for one side of the line
   */
  function sideCells(tr, side) {
    const type = ['add', 'del'].find((cls) => tr.classList.contains(cls)) ?? 'ctx';
    const num = tr.getAttribute(side === 'old' ? 'data-old' : 'data-new');
    return [splitCell(`num ${side} ${type}`, { text: num }), splitCell(`code ${type}`, { code: tr.querySelector('td.code code') })];
  }
  /** @returns {HTMLTableCellElement[]} the cells of a side that has no line */
  function emptyCells() {
    return [splitCell('num empty'), splitCell('code empty')];
  }
  /**
   * @param {string} cls
   * @param {{ text?: string | null, code?: Element | null }} [content]
   * @returns {HTMLTableCellElement}
   */
  function splitCell(cls, { text, code } = {}) {
    const td = document.createElement('td');
    td.className = cls;
    if (text) td.textContent = text;
    if (code) td.append(code.cloneNode(true)); // the highlighted <code> only, never a note marker
    return td;
  }
  /**
   * @param {Block} block
   * @param {boolean} on
   */
  function setSplit(block, on) {
    for (const unified of /** @type {NodeListOf<HTMLTableElement>} */ (block.section.querySelectorAll('table.diff.unified'))) {
      if (on && !splitTableOf.has(unified)) {
        const built = buildSplit(unified);
        splitTableOf.set(unified, built);
        unified.after(built);
      }
      unified.style.display = on ? 'none' : '';
      const split = splitTableOf.get(unified);
      if (split) split.style.display = on ? '' : 'none';
    }
    block.split = on;
  }

  // ---------- keeping the reader's place ----------
  // Keep the reader's place across a layout change: remember the diff row (or
  // file header) at the top of the viewport and its offset, re-lay out, then scroll
  // so the same row sits at the same offset. Rows map 1:1 between unified and split.
  // A stuck file header is skipped: it stays at the top while the code under it moves,
  // so anchoring on it would keep nothing in place.
  function anchorOnScreen() {
    const rows = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('tr.line, header.file-header, h2'));
    for (const row of rows) {
      if (row.matches('header.file-header') && /** @type {Element} */ (row.closest('section.file')).getBoundingClientRect().top < 0) continue;
      const r = row.getBoundingClientRect();
      if (r.bottom > 0 && row.offsetParent !== null) return { el: row, offset: r.top };
    }
    return null;
  }
  /**
   * @param {HTMLElement} el
   * @returns {HTMLElement} el, or for a diff row in the hidden view its twin in the shown one
   */
  function counterpart(el) {
    if (!el?.classList.contains('line')) return el;
    if (el.offsetParent !== null) return el;
    const row = /** @type {HTMLTableRowElement} */ (el); // a .line element is a diff row
    const twins = [splitRowOf.get(row), unifiedRowOf.get(row)];
    return twins.find((twin) => twin && twin.offsetParent !== null) ?? el;
  }
  /** @param {ReturnType<typeof anchorOnScreen>} anchor */
  function restoreAnchor(anchor) {
    if (!anchor) return;
    const el = counterpart(anchor.el);
    const top = el.getBoundingClientRect().top;
    window.scrollBy(0, top - anchor.offset);
  }
  /**
   * Runs a layout change with the reader's place preserved.
   * @param {() => void} change
   */
  function withPlaceKept(change) {
    const anchor = anchorOnScreen();
    change();
    restoreAnchor(anchor);
  }

  // ---------- notes: placement ----------
  /** @param {Block} block */
  function clearNotes(block) {
    for (const row of block.section.querySelectorAll('tr.annotated')) row.classList.remove('annotated');
    for (const c of block.section.querySelectorAll('.hint-target')) c.classList.remove('hint-target');
    for (const n of block.notes) { n.card = null; n.marker = null; }
    for (const n of block.section.querySelectorAll('tr.comment, .notes-below, .note-marker')) n.remove();
    for (const c of block.section.querySelectorAll('td.note-anchor')) c.classList.remove('note-anchor');
    block.notesCol.innerHTML = '';
    block.body.classList.remove('has-margin');
  }
  /**
   * @param {Note} note
   * @param {Block} block
   * @returns {HTMLTableRowElement}
   */
  function visibleRow(note, block) {
    if (!block.split) return note.anchor;
    return splitRowOf.get(note.anchor) ?? note.anchor;
  }
  /**
   * @param {Note} note
   * @param {Block} block
   * @returns {HTMLTableElement}
   */
  function visibleTable(note, block) {
    if (!block.split) return note.table;
    return splitTableOf.get(note.table) ?? note.table;
  }
  /**
   * Groups items by key. Keys keep the order they first appear in, and each group keeps the items' order.
   * Map.groupBy does the same, but is not yet in every browser a reader may open the report in.
   * @template T, K
   * @param {Iterable<T>} items
   * @param {(item: T) => K} keyOf
   * @returns {Map<K, T[]>}
   */
  function groupBy(items, keyOf) {
    /** @type {Map<K, T[]>} */
    const groups = new Map();
    for (const item of items) {
      const key = keyOf(item);
      const group = groups.get(key);
      if (group) group.push(item); else groups.set(key, [item]);
    }
    return groups;
  }
  /**
   * @param {Block[]} blocks
   * @returns {Map<HTMLTableRowElement, Note[]>} each line that carries notes, as now shown, with its notes in story order
   */
  function indexNotesByRow(blocks) {
    return new Map(blocks.flatMap((block) => [...groupBy(block.notes, (note) => visibleRow(note, block))]));
  }
  /**
   * @param {number} n
   * @returns {HTMLElement} the numbered circle of note n
   */
  function marker(n) {
    const m = document.createElement('span');
    m.className = 'note-marker';
    m.textContent = String(n);
    return m;
  }
  /**
   * A numbered card with the note's text, for the margin or for the list below a hunk.
   * @param {Note} note
   * @returns {HTMLElement}
   */
  function noteCard(note) {
    const card = document.createElement('div');
    card.className = 'note';
    card.append(marker(note.n), note.el);
    return card;
  }
  /**
   * The code cell a note's circle goes in. A split row has two: a deleted line shows on the left, any
   * other line on the right.
   * @param {HTMLTableRowElement} row the note's line as shown
   * @param {Note} note
   * @returns {Element}
   */
  function anchorCell(row, note) {
    const cells = row.querySelectorAll('td.code');
    return cells[cells.length > 1 && !note.anchor.classList.contains('del') ? 1 : 0];
  }

  /** @returns {'inline' | 'margin'} the notes mode the reader chose */
  function wantedNotesMode() {
    return root.dataset.notes === 'inline' ? 'inline' : 'margin';
  }
  /**
   * Inline: each note in a row of its own under its line. Several notes on one line keep story order.
   * @param {Block} block
   */
  function layoutInline(block) {
    for (const [row, notes] of groupBy(block.notes, (note) => visibleRow(note, block))) {
      row.after(...notes.map((note) => commentRow(note, block.split ? 4 : 3)));
    }
  }
  /**
   * @param {Note} note
   * @param {number} columns the columns of the note's table
   * @returns {HTMLTableRowElement} a row holding the note across the whole table
   */
  function commentRow(note, columns) {
    const tr = document.createElement('tr');
    tr.className = 'comment';
    const td = document.createElement('td');
    td.colSpan = columns;
    td.append(note.el);
    tr.append(td);
    return tr;
  }
  /**
   * Below and margin both put a numbered circle on each note's line and make the line's code text its
   * hover target. The inline <code> box ends where the text ends, so empty space in the cell, the line
   * numbers and the margin all dismiss the hint. A line with several notes has one target, in the cell
   * of its first note.
   * @param {Block} block
   */
  function placeMarkers(block) {
    for (const [row, notes] of groupBy(block.notes, (note) => visibleRow(note, block))) {
      for (const note of notes) {
        const cell = anchorCell(row, note);
        cell.classList.add('note-anchor');
        note.marker = marker(note.n);
        cell.append(note.marker);
      }
      row.classList.add('annotated');
      const cell = anchorCell(row, notes[0]);
      (cell.querySelector('code') ?? cell).classList.add('hint-target');
    }
  }
  /**
   * Below: the notes listed under each hunk, numbered like their circles.
   * @param {Block} block
   */
  function layoutBelow(block) {
    placeMarkers(block);
    for (const [table, notes] of groupBy(block.notes, (note) => visibleTable(note, block))) {
      const box = document.createElement('div');
      box.className = 'notes-below';
      for (const note of notes) {
        note.card = noteCard(note);
        box.append(note.card);
      }
      table.after(box);
    }
  }
  /**
   * Margin: each card absolutely positioned at its line's top, then pushed down so cards never overlap.
   * All cards are appended first and all positions read before any top is written,
   * so the browser lays the block out once instead of once per note.
   * @param {Block} block
   */
  function layoutMargin(block) {
    const gap = 8; // px between two cards pushed against each other
    placeMarkers(block);
    block.body.classList.add('has-margin');
    const cards = block.notes.map(noteCard);
    block.notesCol.append(...cards);
    const bodyTop = block.body.getBoundingClientRect().top;
    const tops = block.notes.map((note) => visibleRow(note, block).getBoundingClientRect().top - bodyTop);
    const heights = cards.map((card) => card.offsetHeight);
    // A running scan: each card starts no higher than where the one above it ends.
    let cursor = 0;
    for (const [k, note] of block.notes.entries()) {
      const top = Math.max(tops[k], cursor);
      note.card = cards[k];
      cards[k].style.top = `${top}px`;
      cursor = top + heights[k] + gap;
    }
    // The column must be tall enough for the last note even if it hangs below the code.
    block.notesCol.style.minHeight = `${cursor - gap}px`;
  }

  // ---------- notes: hints ----------
  // Hovering the text of an annotated line opens its notes in a row inserted right
  // under that line. The code below moves down instead of being covered, so the next
  // lines stay readable; leaving the text removes the row and the code moves back.
  // Clicking the circle pins the row open until it, or the page, is clicked again.

  /**
   * @param {Block[]} blocks
   * @param {Element} row
   * @returns {Block | undefined} the file block the row is in
   */
  function blockOf(blocks, row) {
    const sec = row.closest('section.file');
    return blocks.find((b) => b.section === sec);
  }
  /**
   * Opens a hint row under a line, moves the margin cards below it out of its way, and highlights the
   * line's own cards. A pinned hint stays open until clicked away.
   * @param {{ row: HTMLTableRowElement, notes: Note[], block: Block | undefined, pinned: boolean }} at
   * @returns {Hint}
   */
  function insertHint({ row, notes, block, pinned }) {
    const tr = hintRow(row, notes);
    tr.classList.toggle('pinned', pinned); // before measuring: a pinned hint's wider border can rewrap its text
    row.after(tr);
    const shift = block?.body.classList.contains('has-margin')
      ? shiftCardsBelow(block, { row, height: tr.offsetHeight, except: notes })
      : { shifted: [], colHeight: null };
    for (const note of notes) note.card?.classList.add('active');
    return { row, notes, tr, block, ...shift };
  }
  /**
   * Undoes insertHint. Only the open hint's cards are ever highlighted, so un-highlighting those clears them all.
   * @param {Hint} hint
   */
  function removeHint(hint) {
    for (const card of hint.shifted) card.style.transform = '';
    if (hint.colHeight !== null && hint.block) hint.block.notesCol.style.minHeight = hint.colHeight;
    hint.tr.remove();
    for (const note of hint.notes) note.card?.classList.remove('active');
  }
  /**
   * @param {HTMLTableRowElement} row the line the notes belong to
   * @param {Note[]} notes
   * @returns {HTMLTableRowElement} a row that shows the notes under the line, beside its line numbers
   */
  function hintRow(row, notes) {
    const tr = document.createElement('tr');
    tr.className = 'hint-row';
    const gutter = document.createElement('td');
    gutter.colSpan = row.querySelectorAll('td.num').length || 1;
    gutter.className = 'hint-gutter';
    const td = document.createElement('td');
    td.colSpan = Math.max(1, row.children.length - gutter.colSpan);
    td.append(...notes.map((note) => note.el.cloneNode(true)));
    tr.append(gutter, td);
    return tr;
  }
  /**
   * Margin cards are positioned absolutely, so a row inserted into the code does not move them. The cards
   * of lines below the inserted row move down by its height to stay level with their code; cards above it
   * and the line's own cards stay put. The notes column grows by the same height, so the lowest card never
   * hangs past the block.
   * @param {Block} block
   * @param {object} hinted
   * @param {HTMLTableRowElement} hinted.row the line the hint row opens under
   * @param {number} hinted.height the hint row's height
   * @param {Note[]} hinted.except the line's own notes
   * @returns {{ shifted: HTMLElement[], colHeight: string }} the moved cards, and the column height to restore
   */
  function shiftCardsBelow(block, { row, height, except }) {
    const colHeight = block.notesCol.style.minHeight;
    const cut = row.getBoundingClientRect().bottom - block.body.getBoundingClientRect().top;
    const shifted = block.notes.filter((note) => !except.includes(note)).flatMap((note) => note.card ?? [])
      .filter((card) => parseFloat(card.style.top) >= cut - 1);
    block.notesCol.style.minHeight = `${(parseFloat(colHeight) || 0) + height}px`;
    for (const card of shifted) card.style.transform = `translateY(${height}px)`;
    return { shifted, colHeight };
  }
  /**
   * @param {EventTarget | null} target
   * @returns {Element | null}
   */
  function elementOf(target) {
    return target instanceof Element ? target : null;
  }
  /**
   * @param {EventTarget | null} target
   * @returns {Element | null} the code text or circle of an annotated line that holds target
   */
  function hoverZone(target) {
    return elementOf(target)?.closest(HOVER_ZONE) ?? null;
  }
  /**
   * @param {EventTarget | null} target
   * @returns {HTMLTableRowElement | null} the annotated line whose hover zone holds target
   */
  function hoveredLine(target) {
    return hoverZone(target)?.closest('tr') ?? null;
  }
  // The page listens on the document, where mouseenter and mouseleave never arrive: they do not bubble.
  // So it uses mouseover and mouseout, which also fire at every element edge inside the code text, such
  // as between two highlighted tokens. Entering a zone (the code text or a circle) opens the hint, as a
  // mouseenter on it would; a move inside one zone does nothing. Only a move off the line closes the hint,
  // so it stays open, without closing and reopening, while the pointer goes between the circle and the code.

  /**
   * @param {MouseEvent} ev a mouseover
   * @returns {HTMLTableRowElement | null} the annotated line whose hover zone the pointer just entered
   */
  function lineEntered(ev) {
    const row = hoveredLine(ev.target);
    return row && hoverZone(ev.target) !== hoverZone(ev.relatedTarget) ? row : null;
  }
  /**
   * @param {MouseEvent} ev a mouseout
   * @returns {HTMLTableRowElement | null} the annotated line the pointer just left
   */
  function lineLeft(ev) {
    const row = hoveredLine(ev.target);
    return row && row !== hoveredLine(ev.relatedTarget) ? row : null;
  }

  // ---------- diagrams ----------
  // A diagram wider than its column is shrunk to fit: the whole flow stays in view, but its text
  // can get small. Diagrams shrunk by more than a tenth get a "Full size" button; a smaller shrink
  // leaves the text readable, and a button there would be noise. The button draws the diagram at
  // its natural width and lets the box scroll sideways. The choice lives on the figure, so the
  // re-render after a theme change keeps it.

  /** @param {Element | null} fig */
  function fitDiagram(fig) {
    if (!fig) return;
    const svg = drawnSvg(fig);
    if (!svg) return;
    const natural = svg.viewBox.baseVal.width;
    const full = fig.classList.contains('full');
    svg.style.width = full ? `${natural}px` : '';
    svg.style.maxWidth = full ? 'none' : `${natural}px`;
    const shrunk = !full && svg.getBoundingClientRect().width < natural * 0.9;
    const button = shrunk || full ? ensureSizeButton(fig) : fig.querySelector('.diagram-size');
    if (button) syncSizeButton(/** @type {HTMLButtonElement} */ (button), { shrunk, full });
  }
  /**
   * @param {Element} fig
   * @returns {SVGSVGElement | null} the diagram Mermaid drew in the figure; null before it is drawn, or when it has no width
   */
  function drawnSvg(fig) {
    const svg = /** @type {SVGSVGElement | null} */ (fig.querySelector('pre.mermaid svg'));
    return svg?.viewBox?.baseVal?.width ? svg : null;
  }
  /**
   * @param {Element} fig
   * @returns {HTMLButtonElement} the figure's size button, added the first time it is needed
   */
  function ensureSizeButton(fig) {
    const existing = /** @type {HTMLButtonElement | null} */ (fig.querySelector('.diagram-size'));
    if (existing) return existing;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diagram-size';
    // Its own listener, added once with the button: re-renders keep the button, so it is never added again.
    button.addEventListener('click', () => { fig.classList.toggle('full'); fitDiagram(fig); });
    fig.prepend(button);
    return button;
  }
  /**
   * @param {HTMLButtonElement} button
   * @param {{ shrunk: boolean, full: boolean }} state whether the diagram is shrunk to fit, or drawn at full size
   */
  function syncSizeButton(button, { shrunk, full }) {
    button.hidden = !(shrunk || full);
    button.textContent = full ? 'Fit to width' : 'Full size';
    button.setAttribute('aria-pressed', String(full));
  }
  function fitDiagrams() {
    for (const fig of document.querySelectorAll('figure.diagram')) fitDiagram(fig);
  }
  /** @param {HTMLElement} node a diagram box */
  function restoreDiagramSource(node) {
    node.textContent = node.dataset.source ?? '';
    node.removeAttribute('data-processed');
  }

  // ---------- viewed: manual, per report, per file ----------
  // Stored as { path: hash } under a key that includes the report id. A tick is kept
  // only while the file's diff hash still matches, so a re-render that changed the
  // file drops the tick for that file and nothing else.

  /**
   * A renderer file block with its diff hash. The renderer always sets `data-path` and `data-hash` together.
   * @typedef {HTMLElement & { dataset: { path: string, hash: string } }} FileSection
   */
  /**
   * The ticks stored under one key. A damaged value counts as no ticks, and so does an entry whose hash is not text.
   * @param {string} key
   * @returns {Record<string, string>} each ticked file's path and diff hash
   */
  function readTicks(key) {
    const stored = storage.json(key, isPlainObject) ?? {};
    return Object.fromEntries(Object.entries(stored).filter(isTick));
  }
  /**
   * @param {[string, unknown]} entry
   * @returns {entry is [string, string]}
   */
  function isTick(entry) {
    return typeof entry[1] === 'string';
  }
  /** @returns {Record<string, string>} */
  function readViewed() {
    return readTicks(VIEWED_KEY);
  }
  /** @param {Record<string, string>} state */
  function writeViewed(state) {
    storage.set(VIEWED_KEY, JSON.stringify(state));
  }
  /** @returns {Record<string, string>} each file's diff hash in this render */
  function currentHashes() {
    const files = /** @type {NodeListOf<FileSection>} */ (document.querySelectorAll('section.file[data-hash]'));
    return Object.fromEntries([...files].map((sec) => [sec.dataset.path, sec.dataset.hash]));
  }
  /**
   * @param {string} path
   * @param {boolean} on
   */
  function markViewed(path, on) {
    const quoted = CSS.escape(path);
    for (const sec of document.querySelectorAll(`section.file[data-path="${quoted}"]`)) {
      sec.classList.toggle('is-viewed', on);
      const box = /** @type {HTMLInputElement | null} */ (sec.querySelector('.viewed-toggle'));
      if (box) box.checked = on;
    }
    for (const link of document.querySelectorAll(`.file-index a[data-file="${quoted}"]`)) {
      link.parentElement?.classList.toggle('is-viewed', on);
    }
  }

  /**
   * @typedef {{ done: number, total: number }} Counts
   */
  /**
   * One place on the page that shows how far the reader got.
   * @typedef {object} ProgressView
   * @property {string} selector the elements that show it
   * @property {(el: HTMLElement, ticked: Record<string, string>) => Counts} count the files viewed and in all, for one element
   * @property {(el: HTMLElement, counts: Counts) => void} render
   */
  /**
   * The totals count every ticked file. Per chapter, the index list, the sidebar entry and the chapter
   * heading all show how many of the chapter's files are viewed, and switch to a tick when all are.
   * @type {readonly ProgressView[]}
   */
  const PROGRESS_VIEWS = Object.freeze([
    { selector: '.viewed-count', count: countAll, render: renderTotals },
    { selector: '.chapter-list li[data-files]', count: countChapter, render: renderIndexEntry },
    { selector: '.toc li[data-files]', count: countChapter, render: renderTocEntry },
    { selector: 'section.chapter[data-files]', count: countChapter, render: renderChapterHeading },
  ]);
  /** @param {Record<string, string>} state */
  function updateProgress(state) {
    for (const { selector, count, render } of PROGRESS_VIEWS) {
      for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(selector))) render(el, count(el, state));
    }
  }
  /**
   * @param {HTMLElement} el
   * @param {Record<string, string>} ticked
   * @returns {Counts} all ticked files, out of the total the element carries
   */
  function countAll(el, ticked) {
    return { done: Object.keys(ticked).length, total: Number(el.dataset.total) || 0 };
  }
  /**
   * @param {HTMLElement} el
   * @param {Record<string, string>} ticked
   * @returns {Counts} the ticked files among the chapter files the element lists
   */
  function countChapter(el, ticked) {
    const paths = el.dataset.files ? el.dataset.files.split('|') : [];
    return { done: paths.filter((p) => Object.hasOwn(ticked, p)).length, total: paths.length };
  }
  /**
   * @param {Counts} counts
   * @returns {boolean} whether there are files and every one is viewed
   */
  function allViewed({ done, total }) {
    return total > 0 && done === total;
  }
  /**
   * @param {HTMLElement} el
   * @param {Counts} counts
   */
  function renderTotals(el, { done, total }) {
    el.textContent = `${done} of ${total} viewed`;
    const fill = /** @type {HTMLElement | null | undefined} */ (el.parentElement?.querySelector('.fill'));
    if (fill) fill.style.width = `${total ? Math.min(100, Math.round(done / total * 100)) : 0}%`;
  }
  /**
   * @param {HTMLElement} li
   * @param {Counts} counts
   */
  function renderIndexEntry(li, { done, total }) {
    if (!total) return;
    const tag = li.querySelector('.viewed-of') ?? addViewedOf(li);
    tag.textContent = `${done} of ${total} viewed`;
    li.classList.toggle('is-viewed', done === total);
  }
  /**
   * @param {HTMLElement} li
   * @returns {HTMLElement} a new progress tag after the entry's link
   */
  function addViewedOf(li) {
    const tag = document.createElement('span');
    tag.className = 'viewed-of';
    /** @type {Element} */ (li.querySelector('a')).after(tag);
    return tag;
  }
  /**
   * @param {HTMLElement} li
   * @param {Counts} counts
   */
  function renderTocEntry(li, counts) {
    const tag = li.querySelector('.chapter-progress');
    if (tag) tag.textContent = counts.done === counts.total ? '' : `${counts.done}/${counts.total}`;
    li.classList.toggle('is-viewed', allViewed(counts));
  }
  /**
   * @param {HTMLElement} sec
   * @param {Counts} counts
   */
  function renderChapterHeading(sec, counts) {
    const tag = sec.querySelector('.chapter-viewed');
    if (tag) tag.textContent = counts.done === counts.total ? 'All files viewed' : `${counts.done} of ${counts.total} files viewed`;
    sec.classList.toggle('is-viewed', allViewed(counts));
  }

  // A re-render after the branch moved gets a new report id (the id hashes the diff), so ticks made
  // on earlier renders live under other keys. Merge them in, once per earlier render: only files whose
  // diff hash is unchanged (a file new commits touched needs a fresh look), and never twice, so a file
  // unticked after the merge stays unticked. The merged render ids are remembered under the adopted key.
  // A damaged earlier entry carries no ticks and is not read again; the others still carry theirs.
  function adoptEarlierTicks() {
    const id = root.dataset.reportId ?? '';
    const prefix = `${KEYS.viewed}${id.replace(/-[0-9a-f]{8}$/, '')}-`;
    const adoptedKey = `${KEYS.adopted}${id}`;
    const adopted = storage.json(adoptedKey, isStringList) ?? [];
    const pending = storage.keys().filter((key) => isEarlierRenderKey(key, prefix) && !adopted.includes(key));
    const current = currentHashes();
    const state = readViewed();
    const carried = pending.flatMap((key) => Object.entries(readTicks(key)))
      .filter(([path, hash]) => current[path] === hash && !Object.hasOwn(state, path));
    if (carried.length) writeViewed({ ...state, ...Object.fromEntries(carried) });
    storage.set(adoptedKey, JSON.stringify([...adopted, ...pending]));
  }
  /**
   * Whether a storage key holds the ticks of an earlier render of this report: the same id up to a
   * different diff hash of eight hex digits.
   * @param {string} key
   * @param {string} prefix the viewed key of this report without its diff hash
   * @returns {boolean}
   */
  function isEarlierRenderKey(key, prefix) {
    return key !== VIEWED_KEY && key.startsWith(prefix) && /^[0-9a-f]{8}$/.test(key.slice(prefix.length));
  }
  /**
   * @param {string} path
   * @param {string} hash
   * @param {boolean} on
   */
  function toggleViewed(path, hash, on) {
    // Built as new objects: assigning to `state.__proto__` would set the prototype, not tick a file
    // whose path is `__proto__`, while a computed key in a literal always defines a property of its own.
    const others = Object.fromEntries(Object.entries(readViewed()).filter(([p]) => p !== path));
    const state = on ? { ...others, [path]: hash } : others;
    writeViewed(state);
    markViewed(path, on);
    updateProgress(state);
  }

  // ---------- settings ----------
  // The toolbar's three settings. Each value sits in a data attribute on <html>, which the stylesheet and
  // the code here read. A value is stored only when the reader changes it, so an untouched page keeps
  // following the system theme. A small script in <head> copies stored values onto the attributes before
  // the first paint, so the page never flashes the defaults.

  /** @typedef {'theme' | 'diff' | 'notes'} SettingName */
  /**
   * The features a change of setting reaches.
   * @typedef {{ diagrams: Diagrams, layout: Layout }} Features
   */
  /**
   * @typedef {object} Setting
   * @property {string} key where the reader's choice is stored
   * @property {SettingName} attr the data attribute on <html> that holds the value
   * @property {readonly [string, string]} values the default first; the button switches between the two
   * @property {HTMLElement | null} button
   * @property {(value: string) => string | null} label the button's text for a value; null leaves the text alone
   * @property {boolean} relayout whether a change lays the notes out again
   * @property {(value: string, features: Features) => void} after the rest of the page's change to a new value
   */
  /** @type {Readonly<Record<SettingName, Setting>>} */
  const SETTINGS = Object.freeze({
    theme: {
      key: KEYS.theme, attr: 'theme', values: ['light', 'dark'], button: themeToggle, relayout: false,
      label: () => null, // the button names the setting, not its value
      after: (theme, { diagrams }) => { showCodeTheme(theme); diagrams.render(theme); },
    },
    diff: {
      key: KEYS.diff, attr: 'diff', values: ['unified', 'split'], button: diffToggle, relayout: true,
      label: (mode) => `Diff: ${mode}`,
      after: (mode, { layout }) => layout.showSplit(mode === 'split'),
    },
    notes: {
      key: KEYS.notes, attr: 'notes', values: ['margin', 'inline'], button: notesToggle, relayout: true,
      label: () => null, // the layout labels this button: its text says where notes fell back to below the hunks
      after: () => {}, // the layout that follows every change of this setting places the notes
    },
  });
  const SETTING_NAMES = /** @type {SettingName[]} */ (Object.keys(SETTINGS));
  /**
   * @param {SettingName} name
   * @returns {string} the setting's value as the page shows it now, or its default when there is none
   */
  function shownValue(name) {
    const { attr, values } = SETTINGS[name];
    return root.dataset[attr] || values[0];
  }

  // ---------- keys and window size ----------
  /**
   * @param {EventTarget | null} target
   * @returns {boolean} whether the reader is typing into target
   */
  function isTyping(target) {
    return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }
  /**
   * @param {Map<string, () => void>} actions what each key does
   * @returns {(ev: KeyboardEvent) => void}
   */
  function onKeys(actions) {
    return (ev) => {
      const action = actions.get(ev.key);
      if (!action || ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev.target)) return;
      action();
    };
  }
  /**
   * @param {() => void} relayout
   * @returns {() => void} a resize listener that calls relayout once the window has settled at a new width
   */
  function onWidthChange(relayout) {
    let width = window.innerWidth; // note positions depend on width only; a height-only resize changes nothing
    /** @type {number | undefined} */
    let timer;
    return () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (window.innerWidth === width) return;
        width = window.innerWidth;
        relayout();
      }, 100);
    };
  }

  // ---------- features ----------
  // Each feature's type is what its factory returns. So the factories type their parameters inline: a JSDoc
  // block would also ask for a @returns, which would have to spell out that type by hand.

  /** @typedef {ReturnType<typeof createDiagrams>} Diagrams */
  /** @typedef {ReturnType<typeof createHints>} Hints */
  /** @typedef {ReturnType<typeof createLayout>} Layout */

  // Mermaid re-renders from the saved source so a theme change repaints diagrams.
  // Mermaid cannot render two diagrams at once: concurrent runs draw into each other's
  // boxes and leave others empty. So all renders go through one queue, one diagram at a
  // time. A theme change starts a new generation; queued work from the old one is skipped.
  // Each diagram gets its own run: a syntax error in one leaves the others rendered and
  // only the broken one falls back to its source text.
  // The queue is a promise chain on purpose, not async/await: each render is appended to the
  // chain, so it starts only when everything queued before it has settled.
  function createDiagrams() {
    let queue = Promise.resolve();
    let generation = 0;
    /** @param {string} theme */
    function render(theme) {
      if (!mermaidLib) return;
      const nodes = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('pre.mermaid'));
      if (!nodes.length) return;
      const mine = ++generation;
      let unusable = false;
      const current = () => mine === generation;
      queue = queue.then(() => {
        if (current()) mermaidLib.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default' });
      }).catch(() => { unusable = true; }); // every diagram keeps what it shows now
      // A loop, not map: each step appends to the chain the step before it built.
      for (const node of nodes) {
        queue = queue.then(async () => {
          if (!current() || unusable) return;
          restoreDiagramSource(node);
          await mermaidLib.run({ nodes: [node] });
          fitDiagram(node.closest('figure.diagram'));
        }).catch(() => restoreDiagramSource(node)); // a syntax error rejects; the queue moves on to the next diagram
      }
    }
    return { render, fitAll: fitDiagrams };
  }

  function createHints(/** @type {Block[]} */ blocks) {
    /** @type {Note | null} */
    let pinned = null; // the note whose hint row stays open
    /** @type {Hint | null} */
    let hint = null; // the open hint row
    /** @type {Map<HTMLTableRowElement, Note[]>} */
    let notesByRow = new Map(); // each annotated line, as now shown, with its notes; replaced after every layout

    function close() {
      if (hint) removeHint(hint);
      hint = null;
    }
    /** @param {HTMLTableRowElement} row */
    function open(row) {
      if (hint?.row === row) { hint.tr.classList.toggle('pinned', pinned !== null); return; }
      close();
      const notes = notesByRow.get(row) ?? [];
      hint = insertHint({ row, notes, block: blockOf(blocks, row), pinned: pinned !== null });
    }
    function unpin() {
      pinned = null;
      close();
    }
    /**
     * Every layout rebuilds the markers and drops the hint row. The pinned note
     * re-opens under its new marker's line, or lets go when the mode has none (inline).
     * @param {Map<HTMLTableRowElement, Note[]>} index the annotated lines of the new layout
     */
    function afterLayout(index) {
      notesByRow = index;
      if (pinned?.marker?.isConnected) open(/** @type {HTMLTableRowElement} */ (pinned.marker.closest('tr')));
      else if (pinned) unpin();
    }
    /** @param {Element} circle a numbered circle on a line */
    function togglePin(circle) {
      const row = /** @type {HTMLTableRowElement} */ (circle.closest('tr'));
      const note = notesByRow.get(row)?.find((n) => n.marker === circle);
      if (!note) return;
      if (pinned === note) { unpin(); return; }
      pinned = note;
      open(row);
    }
    /**
     * A click on a line's circle pins or releases its notes. Any other click releases a pinned hint, except
     * one inside the hint: reading or selecting there keeps it open.
     * @param {MouseEvent} ev
     */
    function click(ev) {
      const target = elementOf(ev.target);
      const circle = target?.closest(LINE_MARKER);
      if (circle) togglePin(circle);
      else if (pinned && !target?.closest('tr.hint-row')) unpin();
    }
    return {
      close,
      afterLayout,
      click,
      /** @param {MouseEvent} ev a mouseover */
      enter: (ev) => {
        const row = lineEntered(ev);
        if (row && !pinned) open(row);
      },
      /** @param {MouseEvent} ev a mouseout */
      leave: (ev) => {
        if (!pinned && hint && hint.row === lineLeft(ev)) close();
      },
    };
  }

  function createLayout(/** @type {{ blocks: Block[], hints: Hints }} */ { blocks, hints }) {
    let printing = false; // between beforeprint and afterprint
    /**
     * @param {Block} block
     * @returns {'inline' | 'below' | 'margin'} the mode the block's notes are laid out in now
     */
    function modeOf(block) {
      if (wantedNotesMode() === 'inline') return 'inline';
      return printing || block.split || block.body.clientWidth < 900 ? 'below' : 'margin';
    }
    function layoutAll() {
      hints.close();
      for (const block of blocks) {
        clearNotes(block);
        if (block.notes.length) LAYOUTS[modeOf(block)](block);
      }
      hints.afterLayout(indexNotesByRow(blocks));
      labelNotesToggle();
    }
    function labelNotesToggle() {
      if (!notesToggle) return;
      const wanted = wantedNotesMode();
      const anyBelow = wanted === 'margin' && blocks.some((b) => b.notes.length && modeOf(b) === 'below');
      notesToggle.textContent = `Notes: ${wanted}${anyBelow ? ' (below hunks here)' : ''}`;
      notesToggle.title = anyBelow
        ? 'Margin notes need a wider window; in split view and narrow blocks they are listed below each hunk'
        : 'Notes beside the code, or inline between lines';
    }
    return {
      layoutAll,
      /** @param {boolean} on */
      showSplit: (on) => { for (const block of blocks) setSplit(block, on); },
      beforePrint: () => { printing = true; layoutAll(); },
      afterPrint: () => { printing = false; layoutAll(); },
    };
  }

  // The ticks themselves live in storage; the feature's own state is the file block the pointer is over.
  function createViewed() {
    /** @type {HTMLElement | null} */
    let hoveredBlock = null; // the file block the `v` key acts on
    function init() {
      adoptEarlierTicks();
      const stored = readViewed();
      // Drop ticks for files whose diff changed since they were ticked. Files this page does not show
      // (other pages of a paged report) keep theirs.
      const current = currentHashes();
      const state = Object.fromEntries(Object.entries(stored)
        .filter(([path, hash]) => !Object.hasOwn(current, path) || current[path] === hash));
      if (Object.keys(state).length < Object.keys(stored).length) writeViewed(state);
      for (const path of Object.keys(state)) markViewed(path, true);
      updateProgress(state);
    }
    /** @param {Event} ev a change anywhere on the page */
    function onChange(ev) {
      const box = ev.target;
      if (!(box instanceof HTMLInputElement) || !box.matches('.viewed-toggle')) return;
      const sec = /** @type {FileSection} */ (box.closest('section.file'));
      const stuck = sec.getBoundingClientRect().top < 0; // ticked from the sticky header, mid-file
      toggleViewed(sec.dataset.path, sec.dataset.hash, box.checked);
      // The file folded under the reader: bring its header to the top so the next file follows right below.
      if (stuck && box.checked) window.scrollBy(0, sec.getBoundingClientRect().top);
    }
    /**
     * Ticks made in another tab of the same report show up here too.
     * @param {StorageEvent} ev
     */
    function onStorage(ev) {
      if (ev.key !== VIEWED_KEY) return;
      const state = readViewed();
      const files = /** @type {NodeListOf<FileSection>} */ (document.querySelectorAll('section.file[data-path]'));
      for (const sec of files) markViewed(sec.dataset.path, Object.hasOwn(state, sec.dataset.path));
      updateProgress(state);
    }
    return {
      init,
      onChange,
      onStorage,
      /** @param {EventTarget | null} target what the pointer moved onto */
      track: (target) => {
        const sec = /** @type {HTMLElement | null | undefined} */ (elementOf(target)?.closest('section.file'));
        if (sec) hoveredBlock = sec;
      },
      toggleHovered: () => {
        if (!hoveredBlock?.dataset.hash) return;
        const sec = /** @type {FileSection} */ (hoveredBlock); // it has a hash, so it is a renderer file block
        const on = !sec.classList.contains('is-viewed');
        withPlaceKept(() => toggleViewed(sec.dataset.path, sec.dataset.hash, on));
      },
    };
  }

  function createSettings(/** @type {Features} */ features) {
    /**
     * @param {SettingName} name
     * @param {string} value
     * @param {{ persist: boolean }} options persist stores the value as the reader's choice
     */
    function applySetting(name, value, { persist }) {
      const setting = SETTINGS[name];
      root.dataset[setting.attr] = value;
      if (persist) storage.set(setting.key, value);
      setting.after(value, features);
      const text = setting.label(value);
      if (setting.button && text !== null) setting.button.textContent = text;
    }
    return {
      // At start: each setting as the page shows it, nothing stored. The caller then lays the notes out once.
      applyShown: () => { for (const name of SETTING_NAMES) applySetting(name, shownValue(name), { persist: false }); },
      /** @param {SettingName} name */
      toggle: (name) => {
        const { attr, values, relayout } = SETTINGS[name];
        const value = root.dataset[attr] === values[1] ? values[0] : values[1];
        const change = () => applySetting(name, value, { persist: true });
        if (relayout) withPlaceKept(() => { change(); features.layout.layoutAll(); });
        else change();
      },
      /**
       * The system theme applies only while the reader has not chosen one.
       * @param {MediaQueryListEvent} ev
       */
      onSystemTheme: (ev) => {
        if (!storage.get(KEYS.theme)) applySetting('theme', ev.matches ? 'dark' : 'light', { persist: false });
      },
    };
  }

  // ---------- wiring ----------
  // Code is highlighted before the notes are lifted out of the page. The lookup finds only what is
  // still in the document, and code blocks inside notes are highlighted too.
  highlightCode();
  const blocks = captureBlocks(); // one record per file block: its tables and the notes lifted out of them
  const diagrams = createDiagrams();
  const hints = createHints(blocks);
  const layout = createLayout({ blocks, hints });
  const viewed = createViewed();
  const settings = createSettings({ diagrams, layout });

  // Every listener is added once. The page listens on the document, one listener per event type, not on the
  // lines themselves: those would have to be added again after every layout, which replaces the lines'
  // circles and hover targets. The toolbar buttons, which no layout replaces, have their own.
  for (const name of SETTING_NAMES) SETTINGS[name].button?.addEventListener('click', () => settings.toggle(name));
  systemTheme?.addEventListener?.('change', settings.onSystemTheme);
  window.addEventListener('storage', viewed.onStorage);
  // `v` toggles the file block under the pointer.
  document.addEventListener('keydown', onKeys(new Map([['v', viewed.toggleHovered]])));
  document.addEventListener('mouseover', (ev) => { viewed.track(ev.target); hints.enter(ev); });
  document.addEventListener('mouseout', hints.leave);
  document.addEventListener('click', hints.click);
  document.addEventListener('change', viewed.onChange);
  window.addEventListener('beforeprint', layout.beforePrint);
  window.addEventListener('afterprint', layout.afterPrint);
  // A narrower window can also shrink a diagram that fitted before.
  window.addEventListener('resize', onWidthChange(() => { layout.layoutAll(); diagrams.fitAll(); }));

  // Start: all three settings as the page shows them, then one layout of the notes, then the ticks.
  settings.applyShown();
  layout.layoutAll();
  viewed.init();
  // Highlighting and fonts can change row heights after the first layout.
  window.addEventListener('load', layout.layoutAll);
}
