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
// Layout of this file: constants and the one state object first, then plain functions grouped by topic,
// and last a short wiring section that adds the listeners and starts the page.
'use strict';
{
  // ---------- constants and state ----------
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
   * @typedef {{ n: number, anchor: HTMLElement, table: HTMLElement, el: HTMLElement, card: HTMLElement | null, marker: HTMLElement | null }} Note
   */
  /**
   * One file block of the renderer.
   * @typedef {{ section: HTMLElement, body: HTMLElement, notesCol: HTMLElement, notes: Note[] }} Block
   */
  /**
   * The open hint row. colHeight is the notes column height before the push, null when nothing was pushed.
   * @typedef {{ row: HTMLElement, notes: Note[], tr: HTMLElement, block: Block | undefined, shifted: HTMLElement[], colHeight: string | null }} Hint
   */
  /**
   * A renderer file block with its diff hash. The renderer always sets `data-path` and `data-hash` together.
   * @typedef {HTMLElement & { dataset: { path: string, hash: string } }} FileSection
   */

  /**
   * Everything the page changes while the reader uses it. The ticks and settings live in storage and in
   * data attributes on <html> instead, where the stylesheet and other tabs see them.
   * @typedef {object} State
   * @property {Map<HTMLElement, Note[]>} notesByRow each annotated line, as now shown, with its notes; rebuilt by every layout
   * @property {Note | null} pinned the note whose hint row stays open until clicked away
   * @property {Hint | null} hint the open hint row
   * @property {boolean} printing between beforeprint and afterprint
   * @property {HTMLElement | null} hoveredBlock the file block under the pointer, which the `v` key acts on
   * @property {Promise<void>} diagrams the end of the diagram render queue
   * @property {number} generation the latest diagram render; queued work of an older one is skipped
   * @property {number} width the window width of the last layout
   * @property {number | undefined} resizeTimer
   */
  /** @type {State} */
  const state = {
    notesByRow: new Map(),
    pinned: null,
    hint: null,
    printing: false,
    hoveredBlock: null,
    diagrams: Promise.resolve(),
    generation: 0,
    width: window.innerWidth,
    resizeTimer: undefined,
  };

  // A unified table or row → its twin in the split view, and a split row → the unified row it shows.
  // The split view is built on first use. A weak map lets an element and its twin go when it is removed.
  /** @type {WeakMap<HTMLElement, HTMLElement>} */
  const twin = new WeakMap();

  // A line's numbered circle, as opposed to the circle on its card in the margin or below the hunk.
  const LINE_MARKER = 'td.note-anchor > .note-marker';
  // The parts of an annotated line that open its notes on hover: its code text and its circles.
  const HOVER_ZONE = `.hint-target, ${LINE_MARKER}`;

  // ---------- DOM helpers ----------
  /**
   * The elements under `from` that match the selector. Every selector in this file names HTML elements;
   * a caller that needs a narrower type declares it on the variable it assigns the result to.
   * @template {Element} [T=HTMLElement]
   * @param {string} selector
   * @param {ParentNode} [from]
   * @returns {T[]}
   */
  function all(selector, from = document) {
    /** @type {NodeListOf<T>} */
    const found = from.querySelectorAll(selector);
    return [...found];
  }
  /**
   * The first element under `from` that matches the selector, or null.
   * @template {Element} [T=HTMLElement]
   * @param {string} selector
   * @param {ParentNode} [from]
   * @returns {T | null}
   */
  function one(selector, from = document) {
    return from.querySelector(selector);
  }
  /**
   * A new element with the given properties and children.
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {Partial<HTMLElementTagNameMap[K]>} [props]
   * @param {...(Node | string)} children
   * @returns {HTMLElementTagNameMap[K]}
   */
  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }
  /**
   * @param {EventTarget | null} target
   * @param {string} selector
   * @returns {HTMLElement | null} the nearest element from target up that matches the selector
   */
  function closestTo(target, selector) {
    return target instanceof Element ? target.closest(selector) : null;
  }

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
      try { return Object.keys(localStorage); } catch { return []; } // unavailable: nothing stored
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
    for (const code of all('td.code code, pre > code')) {
      const m = /language-([\w-]+)/.exec(code.className);
      const lang = m ? m[1] : '';
      if (!known.has(lang)) known.set(lang, Boolean(hljsLib.getLanguage?.(lang)));
      if (!known.get(lang)) continue;
      try { hljsLib.highlightElement(code); } catch { /* plain text */ }
    }
  }
  /**
   * The highlight.js stylesheet for a theme: the page carries both and enables one.
   * @param {string} theme
   */
  function showCodeTheme(theme) {
    /** @type {HTMLLinkElement | null} */
    const light = one('#hljs-light');
    /** @type {HTMLLinkElement | null} */
    const dark = one('#hljs-dark');
    if (light) light.disabled = theme === 'dark';
    if (dark) dark.disabled = theme !== 'dark';
  }

  // ---------- notes: capture ----------
  /** @returns {Block[]} */
  function captureBlocks() {
    return all('section.file').flatMap((section) => {
      const body = one('.file-body', section);
      const notesCol = body && one('.notes-col', body);
      if (!body || !notesCol) return []; // not a renderer file block: an html chapter may reuse the class name
      return [{ section, body, notesCol, notes: liftNotes(section) }];
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
    for (const table of all('table.diff.unified', section)) {
      // The list is static, so removing rows while walking it is safe.
      for (const row of all('tr.comment', table)) {
        const anchor = anchorOf(row);
        const callout = one('.callout', row);
        if (!anchor || !callout) continue;
        notes.push({ n: notes.length + 1, anchor, table, el: callout, card: null, marker: null });
        row.remove();
      }
    }
    return notes;
  }
  /**
   * @param {Element} row a note row
   * @returns {HTMLElement | null} the code line the note belongs to: the nearest one above it
   */
  function anchorOf(row) {
    let anchor = row.previousElementSibling;
    while (anchor && !anchor.classList.contains('line')) anchor = anchor.previousElementSibling;
    return anchor instanceof HTMLElement ? anchor : null;
  }

  // ---------- split view ----------
  // Built lazily from the unified table. A hunk header stays a row of its own, a context line shows on
  // both sides, and each run of deletions is paired row by row with the run of additions after it.
  // Each unified row and its split row are twins, so notes can find their anchor in either view.
  // Only code rows and hunk headers are read: comment rows inserted by inline mode are layout,
  // and would otherwise cut a deletion run off from its additions.

  /**
   * @param {HTMLTableElement} unified
   * @returns {HTMLTableElement}
   */
  function buildSplit(unified) {
    const split = el('table', {
      className: 'diff split',
      innerHTML: '<colgroup><col class="num"><col class="code"><col class="num"><col class="code"></colgroup>',
    });
    const rows = [...unified.rows].filter((r) => r.classList.contains('line') || r.classList.contains('hunk-header'));
    /**
     * @param {HTMLElement | null} left
     * @param {HTMLElement | null} right at least one side is a line
     */
    const addPair = (left, right) => {
      const tr = el('tr', { className: 'line' }, ...sideCells(left, 'old'), ...sideCells(right, 'new'));
      if (left) twin.set(left, tr);
      if (right) twin.set(right, tr);
      const shown = left ?? right;
      if (shown) twin.set(tr, shown);
      split.append(tr);
    };
    // A scan with a cursor: how far each step moves depends on the runs it finds there.
    // Rows are appended one at a time: spreading a huge hunk into one append() call would pass more
    // arguments than the engine allows.
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      if (row.classList.contains('hunk-header')) {
        const text = row.querySelector('td')?.textContent ?? '';
        split.append(el('tr', { className: 'hunk-header' }, el('td', { colSpan: 4, textContent: text })));
        i += 1;
      } else if (row.classList.contains('ctx')) {
        addPair(row, row);
        i += 1;
      } else {
        const dels = runOf(rows, i, 'del');
        const adds = runOf(rows, i + dels.length, 'add');
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) addPair(dels[k] ?? null, adds[k] ?? null);
        // A line of no known type, which the renderer never emits, is skipped.
        i += Math.max(1, dels.length + adds.length);
      }
    }
    return split;
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
   * @param {HTMLElement | null} tr a unified code line, or null for a side with no line
   * @param {'old' | 'new'} side
   * @returns {HTMLTableCellElement[]} the number and code cells for one side of a split row
   */
  function sideCells(tr, side) {
    if (!tr) return [el('td', { className: 'num empty' }), el('td', { className: 'code empty' })];
    const type = ['add', 'del'].find((cls) => tr.classList.contains(cls)) ?? 'ctx';
    const num = el('td', { className: `num ${side} ${type}` });
    const number = tr.getAttribute(side === 'old' ? 'data-old' : 'data-new');
    if (number) num.textContent = number;
    const code = el('td', { className: `code ${type}` });
    const highlighted = tr.querySelector('td.code code');
    if (highlighted) code.append(highlighted.cloneNode(true)); // the highlighted <code> only, never a note marker
    return [num, code];
  }
  /**
   * @param {Block} block
   * @param {boolean} on
   */
  function setSplit(block, on) {
    /** @type {HTMLTableElement[]} */
    const tables = all('table.diff.unified', block.section);
    for (const unified of tables) {
      let split = twin.get(unified);
      if (on && !split) {
        split = buildSplit(unified);
        twin.set(unified, split);
        unified.after(split);
      }
      unified.style.display = on ? 'none' : '';
      if (split) split.style.display = on ? '' : 'none';
    }
  }

  // ---------- keeping the reader's place ----------
  // Keep the reader's place across a layout change: remember the diff row (or
  // file header) at the top of the viewport and its offset, re-lay out, then scroll
  // so the same row sits at the same offset. Rows map 1:1 between unified and split.
  // A stuck file header is skipped: it stays at the top while the code under it moves,
  // so anchoring on it would keep nothing in place.
  function anchorOnScreen() {
    for (const row of all('tr.line, header.file-header, h2')) {
      const stuck = row.matches('header.file-header') && (row.closest('section.file')?.getBoundingClientRect().top ?? 0) < 0;
      if (stuck) continue;
      const r = row.getBoundingClientRect();
      if (r.bottom > 0 && row.offsetParent !== null) return { el: row, offset: r.top };
    }
    return null;
  }
  /**
   * Runs a layout change with the reader's place preserved.
   * @param {() => void} change
   */
  function withPlaceKept(change) {
    const anchor = anchorOnScreen();
    change();
    if (!anchor) return;
    // A diff row in the view just hidden is found again through its twin in the shown one.
    const other = anchor.el.classList.contains('line') && anchor.el.offsetParent === null ? twin.get(anchor.el) : null;
    const shown = other && other.offsetParent !== null ? other : anchor.el;
    window.scrollBy(0, shown.getBoundingClientRect().top - anchor.offset);
  }

  // ---------- notes: placement ----------
  // Every layout clears the notes of each block and places them again for the mode the block gets.
  function layoutAll() {
    closeHint();
    const split = root.dataset.diff === 'split';
    state.notesByRow = new Map();
    for (const block of blocks) {
      if (!block.notes.length) continue; // nothing was placed in it, so nothing to clear or place
      clearNotes(block);
      const byRow = Map.groupBy(block.notes, (note) => shownRow(note, split));
      for (const [row, notes] of byRow) state.notesByRow.set(row, notes);
      switch (modeOf(block, split)) {
        case 'inline':
          for (const [row, notes] of byRow) row.after(...notes.map((note) => commentRow(note, split ? 4 : 3)));
          break;
        case 'below':
          placeMarkers(byRow);
          layoutBelow(block, split);
          break;
        case 'margin':
          placeMarkers(byRow);
          layoutMargin(block, split);
          break;
      }
    }
    reopenPinned();
    labelNotesToggle(split);
  }
  /**
   * @param {Block} block
   * @param {boolean} split whether the split view is shown
   * @returns {'inline' | 'below' | 'margin'} the mode the block's notes are laid out in now
   */
  function modeOf(block, split) {
    if (root.dataset.notes === 'inline') return 'inline';
    return state.printing || split || block.body.clientWidth < 900 ? 'below' : 'margin';
  }
  /** @param {boolean} split whether the split view is shown */
  function labelNotesToggle(split) {
    if (!notesToggle) return;
    const wanted = root.dataset.notes === 'inline' ? 'inline' : 'margin';
    const anyBelow = wanted === 'margin' && blocks.some((b) => b.notes.length && modeOf(b, split) === 'below');
    notesToggle.textContent = `Notes: ${wanted}${anyBelow ? ' (below hunks here)' : ''}`;
    notesToggle.title = anyBelow
      ? 'Margin notes need a wider window; in split view and narrow blocks they are listed below each hunk'
      : 'Notes beside the code, or inline between lines';
  }
  /** @param {Block} block */
  function clearNotes(block) {
    for (const row of all('tr.annotated', block.section)) row.classList.remove('annotated');
    for (const c of all('.hint-target', block.section)) c.classList.remove('hint-target');
    for (const n of block.notes) { n.card = null; n.marker = null; }
    for (const n of all('tr.comment, .notes-below, .note-marker', block.section)) n.remove();
    for (const c of all('td.note-anchor', block.section)) c.classList.remove('note-anchor');
    block.notesCol.innerHTML = '';
    block.body.classList.remove('has-margin');
  }
  /**
   * @param {Note} note
   * @param {boolean} split whether the split view is shown
   * @returns {HTMLElement} the note's line as now shown
   */
  function shownRow(note, split) {
    return (split && twin.get(note.anchor)) || note.anchor;
  }
  /**
   * @param {number} n
   * @returns {HTMLElement} the numbered circle of note n
   */
  function marker(n) {
    return el('span', { className: 'note-marker', textContent: String(n) });
  }
  /**
   * A numbered card with the note's text, for the margin or for the list below a hunk.
   * @param {Note} note
   * @returns {HTMLElement}
   */
  function noteCard(note) {
    return el('div', { className: 'note' }, marker(note.n), note.el);
  }
  /**
   * Inline mode: a row holding the note across the whole table, under its line.
   * @param {Note} note
   * @param {number} columns the columns of the note's table
   * @returns {HTMLElement}
   */
  function commentRow(note, columns) {
    return el('tr', { className: 'comment' }, el('td', { colSpan: columns }, note.el));
  }
  /**
   * The code cell a note's circle goes in. A split row has two: a deleted line shows on the left, any
   * other line on the right.
   * @param {HTMLElement} row the note's line as shown
   * @param {Note} note
   * @returns {Element}
   */
  function anchorCell(row, note) {
    const cells = row.querySelectorAll('td.code');
    return cells[cells.length > 1 && !note.anchor.classList.contains('del') ? 1 : 0];
  }
  /**
   * Below and margin both put a numbered circle on each note's line and make the line's code text its
   * hover target. The inline <code> box ends where the text ends, so empty space in the cell, the line
   * numbers and the margin all dismiss the hint. A line with several notes has one target, in the cell
   * of its first note.
   * @param {Map<HTMLElement, Note[]>} byRow a block's annotated lines, as shown, with their notes
   */
  function placeMarkers(byRow) {
    for (const [row, notes] of byRow) {
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
   * @param {boolean} split whether the split view is shown
   */
  function layoutBelow(block, split) {
    const byTable = Map.groupBy(block.notes, (note) => (split && twin.get(note.table)) || note.table);
    for (const [table, notes] of byTable) {
      const box = el('div', { className: 'notes-below' });
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
   * @param {boolean} split whether the split view is shown
   */
  function layoutMargin(block, split) {
    const gap = 8; // px between two cards pushed against each other
    block.body.classList.add('has-margin');
    const cards = block.notes.map(noteCard);
    block.notesCol.append(...cards);
    const bodyTop = block.body.getBoundingClientRect().top;
    const tops = block.notes.map((note) => shownRow(note, split).getBoundingClientRect().top - bodyTop);
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
   * Opens a hint row under a line, moves the margin cards below it out of its way, and highlights the
   * line's own cards. A hint opened while a note is pinned stays open until clicked away.
   * @param {HTMLElement} row an annotated line
   */
  function openHint(row) {
    const pinned = state.pinned !== null;
    if (state.hint?.row === row) { state.hint.tr.classList.toggle('pinned', pinned); return; }
    closeHint();
    const notes = state.notesByRow.get(row) ?? [];
    const section = row.closest('section.file');
    const block = section ? blockBySection.get(section) : undefined;
    const tr = hintRow(row, notes);
    tr.classList.toggle('pinned', pinned); // before measuring: a pinned hint's wider border can rewrap its text
    row.after(tr);
    const shift = block?.body.classList.contains('has-margin')
      ? shiftCardsBelow(block, row, tr.offsetHeight, notes)
      : { shifted: [], colHeight: null };
    for (const note of notes) note.card?.classList.add('active');
    state.hint = { row, notes, tr, block, ...shift };
  }
  // Undoes openHint. Only the open hint's cards are ever highlighted, so un-highlighting those clears them all.
  function closeHint() {
    const { hint } = state;
    if (!hint) return;
    for (const card of hint.shifted) card.style.transform = '';
    if (hint.colHeight !== null && hint.block) hint.block.notesCol.style.minHeight = hint.colHeight;
    hint.tr.remove();
    for (const note of hint.notes) note.card?.classList.remove('active');
    state.hint = null;
  }
  function unpin() {
    state.pinned = null;
    closeHint();
  }
  // Every layout rebuilds the markers and drops the hint row. The pinned note re-opens under its new
  // marker's line, or lets go when the mode has none (inline).
  function reopenPinned() {
    const pinnedMarker = state.pinned?.marker;
    const row = pinnedMarker?.isConnected ? pinnedMarker.closest('tr') : null;
    if (row) openHint(row);
    else if (state.pinned) unpin();
  }
  /** @param {Element} circle a numbered circle on a line */
  function togglePin(circle) {
    const row = circle.closest('tr');
    const note = row ? state.notesByRow.get(row)?.find((n) => n.marker === circle) : undefined;
    if (!row || !note) return;
    if (state.pinned === note) { unpin(); return; }
    state.pinned = note;
    openHint(row);
  }
  /**
   * @param {HTMLElement} row the line the notes belong to
   * @param {Note[]} notes
   * @returns {HTMLElement} a row that shows the notes under the line, beside its line numbers
   */
  function hintRow(row, notes) {
    const gutterSpan = row.querySelectorAll('td.num').length || 1;
    return el('tr', { className: 'hint-row' },
      el('td', { className: 'hint-gutter', colSpan: gutterSpan }),
      el('td', { colSpan: Math.max(1, row.children.length - gutterSpan) }, ...notes.map((note) => note.el.cloneNode(true))));
  }
  /**
   * Margin cards are positioned absolutely, so a row inserted into the code does not move them. The cards
   * of lines below the inserted row move down by its height to stay level with their code; cards above it
   * and the line's own cards stay put. The notes column grows by the same height, so the lowest card never
   * hangs past the block.
   * @param {Block} block
   * @param {HTMLElement} row the line the hint row opens under
   * @param {number} height the hint row's height
   * @param {Note[]} own the line's own notes
   * @returns {{ shifted: HTMLElement[], colHeight: string }} the moved cards, and the column height to restore
   */
  function shiftCardsBelow(block, row, height, own) {
    const colHeight = block.notesCol.style.minHeight;
    const cut = row.getBoundingClientRect().bottom - block.body.getBoundingClientRect().top;
    const shifted = block.notes.filter((note) => !own.includes(note)).flatMap((note) => note.card ?? [])
      .filter((card) => parseFloat(card.style.top) >= cut - 1);
    block.notesCol.style.minHeight = `${(parseFloat(colHeight) || 0) + height}px`;
    for (const card of shifted) card.style.transform = `translateY(${height}px)`;
    return { shifted, colHeight };
  }
  // The page listens on the document, where mouseenter and mouseleave never arrive: they do not bubble.
  // So it uses mouseover and mouseout, which also fire at every element edge inside the code text, such
  // as between two highlighted tokens. Entering a zone (the code text or a circle) opens the hint, as a
  // mouseenter on it would; a move inside one zone does nothing. Only a move off the line closes the hint,
  // so it stays open, without closing and reopening, while the pointer goes between the circle and the code.

  /** @param {MouseEvent} ev a mouseover */
  function onLineOver(ev) {
    const zone = closestTo(ev.target, HOVER_ZONE);
    if (!zone || state.pinned || zone === closestTo(ev.relatedTarget, HOVER_ZONE)) return;
    const row = zone.closest('tr');
    if (row) openHint(row);
  }
  /** @param {MouseEvent} ev a mouseout */
  function onLineOut(ev) {
    if (state.pinned || !state.hint) return;
    const row = closestTo(ev.target, HOVER_ZONE)?.closest('tr');
    if (row === state.hint.row && row !== closestTo(ev.relatedTarget, HOVER_ZONE)?.closest('tr')) closeHint();
  }
  /**
   * A click on a line's circle pins or releases its notes. Any other click releases a pinned hint, except
   * one inside the hint: reading or selecting there keeps it open.
   * @param {MouseEvent} ev
   */
  function onClick(ev) {
    const circle = closestTo(ev.target, LINE_MARKER);
    if (circle) togglePin(circle);
    else if (state.pinned && !closestTo(ev.target, 'tr.hint-row')) unpin();
  }

  // ---------- diagrams ----------
  // Mermaid re-renders from the saved source so a theme change repaints diagrams.
  // Mermaid cannot render two diagrams at once: concurrent runs draw into each other's
  // boxes and leave others empty. So all renders go through one queue, one diagram at a
  // time. A theme change starts a new generation; queued work from the old one is skipped.
  // Each diagram gets its own run: a syntax error in one leaves the others rendered and
  // only the broken one falls back to its source text.
  // The queue is a promise chain on purpose, not async/await: each render is appended to the
  // chain, so it starts only when everything queued before it has settled.

  /** @param {string} theme */
  function renderDiagrams(theme) {
    if (!mermaidLib) return;
    const nodes = all('pre.mermaid');
    if (!nodes.length) return;
    const mine = ++state.generation;
    const current = () => mine === state.generation;
    let unusable = false;
    state.diagrams = state.diagrams.then(() => {
      if (current()) mermaidLib.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default' });
    }).catch(() => { unusable = true; }); // every diagram keeps what it shows now
    // A loop, not map: each step appends to the chain the step before it built.
    for (const node of nodes) {
      state.diagrams = state.diagrams.then(async () => {
        if (!current() || unusable) return;
        restoreDiagramSource(node);
        await mermaidLib.run({ nodes: [node] });
        fitDiagram(node.closest('figure.diagram'));
      }).catch(() => restoreDiagramSource(node)); // a syntax error rejects; the queue moves on to the next diagram
    }
  }
  /** @param {HTMLElement} node a diagram box */
  function restoreDiagramSource(node) {
    node.textContent = node.dataset.source ?? '';
    node.removeAttribute('data-processed');
  }

  // A diagram wider than its column is shrunk to fit: the whole flow stays in view, but its text
  // can get small. Diagrams shrunk by more than a tenth get a "Full size" button; a smaller shrink
  // leaves the text readable, and a button there would be noise. The button draws the diagram at
  // its natural width and lets the box scroll sideways. The choice lives on the figure, so the
  // re-render after a theme change keeps it.

  /** @param {Element | null} fig */
  function fitDiagram(fig) {
    const svg = fig?.querySelector('pre.mermaid svg');
    // Not drawn yet, or drawn without a width: nothing to fit.
    if (!fig || !(svg instanceof SVGSVGElement) || !svg.viewBox?.baseVal?.width) return;
    const natural = svg.viewBox.baseVal.width;
    const full = fig.classList.contains('full');
    svg.style.width = full ? `${natural}px` : '';
    svg.style.maxWidth = full ? 'none' : `${natural}px`;
    const shrunk = !full && svg.getBoundingClientRect().width < natural * 0.9;
    /** @type {HTMLButtonElement | null} */
    const existing = one('.diagram-size', fig);
    const button = shrunk || full ? existing ?? addSizeButton(fig) : existing;
    if (!button) return;
    button.hidden = !(shrunk || full);
    button.textContent = full ? 'Fit to width' : 'Full size';
    button.setAttribute('aria-pressed', String(full));
  }
  /**
   * @param {Element} fig
   * @returns {HTMLButtonElement} a new size button at the top of the figure
   */
  function addSizeButton(fig) {
    const button = el('button', { type: 'button', className: 'diagram-size' });
    // Its own listener, added once with the button: re-renders keep the button, so it is never added again.
    button.addEventListener('click', () => { fig.classList.toggle('full'); fitDiagram(fig); });
    fig.prepend(button);
    return button;
  }
  function fitDiagrams() {
    for (const fig of all('figure.diagram')) fitDiagram(fig);
  }

  // ---------- viewed: manual, per report, per file ----------
  // Stored as { path: hash } under a key that includes the report id. A tick is kept
  // only while the file's diff hash still matches, so a re-render that changed the
  // file drops the tick for that file and nothing else.

  /**
   * The ticks stored under one key. A damaged value counts as no ticks, and so does an entry whose hash is not text.
   * @param {string} key
   * @returns {Record<string, string>} each ticked file's path and diff hash
   */
  function readTicks(key) {
    /** @type {[string, string][]} */
    const ticks = [];
    for (const [path, hash] of Object.entries(storage.json(key, isPlainObject) ?? {})) {
      if (typeof hash === 'string') ticks.push([path, hash]);
    }
    return Object.fromEntries(ticks);
  }
  /** @returns {Record<string, string>} */
  function readViewed() {
    return readTicks(VIEWED_KEY);
  }
  /** @param {Record<string, string>} ticks */
  function writeViewed(ticks) {
    storage.set(VIEWED_KEY, JSON.stringify(ticks));
  }
  /** @returns {Record<string, string>} each file's diff hash in this render */
  function currentHashes() {
    /** @type {FileSection[]} */
    const files = all('section.file[data-hash]');
    return Object.fromEntries(files.map((sec) => [sec.dataset.path, sec.dataset.hash]));
  }

  // At start: drop ticks for files whose diff changed since they were ticked, then show the rest. Files this
  // page does not show (other pages of a paged report) keep theirs.
  function initViewed() {
    adoptEarlierTicks();
    const stored = readViewed();
    const current = currentHashes();
    const ticks = Object.fromEntries(Object.entries(stored)
      .filter(([path, hash]) => !Object.hasOwn(current, path) || current[path] === hash));
    if (Object.keys(ticks).length < Object.keys(stored).length) writeViewed(ticks);
    for (const sec of all('section.file[data-path]')) {
      if (Object.hasOwn(ticks, sec.dataset.path ?? '')) markSection(sec, true);
    }
    for (const link of all('.file-index a[data-file]')) {
      if (Object.hasOwn(ticks, link.dataset.file ?? '')) link.parentElement?.classList.add('is-viewed');
    }
    updateProgress(ticks);
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
    const ticks = readViewed();
    const carried = pending.flatMap((key) => Object.entries(readTicks(key)))
      .filter(([path, hash]) => current[path] === hash && !Object.hasOwn(ticks, path));
    if (carried.length) writeViewed({ ...ticks, ...Object.fromEntries(carried) });
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
   * Ticks or unticks one file, stores the ticks and shows the change.
   * @param {string} path
   * @param {string} hash
   * @param {boolean} on
   */
  function toggleViewed(path, hash, on) {
    // Built as new objects: assigning to `ticks.__proto__` would set the prototype, not tick a file
    // whose path is `__proto__`, while a computed key in a literal always defines a property of its own.
    const others = Object.fromEntries(Object.entries(readViewed()).filter(([p]) => p !== path));
    const ticks = on ? { ...others, [path]: hash } : others;
    writeViewed(ticks);
    // Only this file is marked: when storage is unavailable, the ticks read back lack this visit's others.
    const quoted = CSS.escape(path);
    for (const sec of all(`section.file[data-path="${quoted}"]`)) markSection(sec, on);
    for (const link of all(`.file-index a[data-file="${quoted}"]`)) link.parentElement?.classList.toggle('is-viewed', on);
    updateProgress(ticks);
  }
  /**
   * Shows ticks changed in another tab, in one pass. Only files this page shows are updated, with their file
   * index entries; entries for files on other pages keep their marks until that page loads.
   * @param {Record<string, string>} ticks
   */
  function syncTicks(ticks) {
    const sections = all('section.file[data-path]');
    for (const sec of sections) markSection(sec, Object.hasOwn(ticks, sec.dataset.path ?? ''));
    const shown = new Set(sections.map((sec) => sec.dataset.path));
    for (const link of all('.file-index a[data-file]')) {
      if (shown.has(link.dataset.file)) link.parentElement?.classList.toggle('is-viewed', Object.hasOwn(ticks, link.dataset.file ?? ''));
    }
    updateProgress(ticks);
  }
  /**
   * @param {HTMLElement} sec a file block
   * @param {boolean} on whether it is viewed
   */
  function markSection(sec, on) {
    sec.classList.toggle('is-viewed', on);
    /** @type {HTMLInputElement | null} */
    const box = one('.viewed-toggle', sec);
    if (box) box.checked = on;
  }
  /** @param {HTMLElement} sec a file block the reader asked to tick or untick */
  function toggleSection(sec) {
    const { path, hash } = sec.dataset;
    if (!path || !hash) return; // not a renderer file block
    const on = !sec.classList.contains('is-viewed');
    withPlaceKept(() => toggleViewed(path, hash, on));
  }

  /**
   * The totals count every ticked file. Per chapter, the index list, the sidebar entry and the chapter
   * heading all show how many of the chapter's files are viewed, and switch to a tick when all are.
   * @param {Record<string, string>} ticks
   */
  function updateProgress(ticks) {
    const ticked = Object.keys(ticks).length;
    for (const count of all('.viewed-count')) {
      const total = Number(count.dataset.total) || 0;
      count.textContent = viewedText(ticked, total);
      const fill = count.parentElement?.querySelector('.fill');
      if (fill instanceof HTMLElement) fill.style.width = `${total ? Math.min(100, Math.round(ticked / total * 100)) : 0}%`;
    }
    for (const li of all('.chapter-list li[data-files]')) {
      const { done, total } = chapterCounts(li, ticks);
      if (!total) continue;
      (one('.viewed-of', li) ?? addViewedOf(li)).textContent = viewedText(done, total);
      li.classList.toggle('is-viewed', done === total);
    }
    for (const li of all('.toc li[data-files]')) {
      const { done, total } = chapterCounts(li, ticks);
      const tag = one('.chapter-progress', li);
      if (tag) tag.textContent = done === total ? '' : `${done}/${total}`;
      li.classList.toggle('is-viewed', total > 0 && done === total);
    }
    for (const sec of all('section.chapter[data-files]')) {
      const { done, total } = chapterCounts(sec, ticks);
      const tag = one('.chapter-viewed', sec);
      if (tag) tag.textContent = done === total ? 'All files viewed' : `${done} of ${total} files viewed`;
      sec.classList.toggle('is-viewed', total > 0 && done === total);
    }
  }
  /**
   * @param {HTMLElement} el an element whose data-files lists a chapter's files
   * @param {Record<string, string>} ticks
   * @returns {{ done: number, total: number }} the chapter's ticked files, and all its files
   */
  function chapterCounts(el, ticks) {
    const paths = el.dataset.files ? el.dataset.files.split('|') : [];
    return { done: paths.filter((p) => Object.hasOwn(ticks, p)).length, total: paths.length };
  }
  /**
   * @param {number} done
   * @param {number} total
   * @returns {string}
   */
  function viewedText(done, total) {
    return `${done} of ${total} viewed`;
  }
  /**
   * @param {HTMLElement} li
   * @returns {HTMLElement} a new progress tag after the entry's link
   */
  function addViewedOf(li) {
    const tag = el('span', { className: 'viewed-of' });
    one('a', li)?.after(tag);
    return tag;
  }

  // ---------- settings ----------
  // The toolbar's three settings. Each value sits in a data attribute on <html>, which the stylesheet and
  // the code here read. A value is stored only when the reader changes it, so an untouched page keeps
  // following the system theme. A small script in <head> copies stored values onto the attributes before
  // the first paint, so the page never flashes the defaults. The notes setting needs no apply step:
  // the layout that follows every change of it places the notes and labels its button.

  /** @param {string} theme */
  function applyTheme(theme) {
    root.dataset.theme = theme;
    showCodeTheme(theme);
    renderDiagrams(theme);
  }
  /** @param {string} mode */
  function applyDiff(mode) {
    root.dataset.diff = mode;
    for (const block of blocks) setSplit(block, mode === 'split');
    if (diffToggle) diffToggle.textContent = `Diff: ${mode}`;
  }

  // ---------- keys and window size ----------
  /**
   * @param {EventTarget | null} target
   * @returns {boolean} whether the reader is typing into target
   */
  function isTyping(target) {
    return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }
  // Note positions depend on width only; a height-only resize changes nothing. A narrower window can also
  // shrink a diagram that fitted before. Both wait until the window has settled at its new width.
  function onResize() {
    window.clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(() => {
      if (window.innerWidth === state.width) return;
      state.width = window.innerWidth;
      layoutAll();
      fitDiagrams();
    }, 100);
  }

  // ---------- wiring ----------
  // Code is highlighted before the notes are lifted out of the page. The lookup finds only what is
  // still in the document, and code blocks inside notes are highlighted too.
  highlightCode();
  const blocks = captureBlocks(); // one record per file block: its tables and the notes lifted out of them
  /** @type {WeakMap<Element, Block>} */
  const blockBySection = new WeakMap(blocks.map((b) => [b.section, b]));

  // Every listener is added once. The page listens on the document, one listener per event type, not on the
  // lines themselves: those would have to be added again after every layout, which replaces the lines'
  // circles and hover targets. The toolbar buttons, which no layout replaces, have their own.
  themeToggle?.addEventListener('click', () => {
    const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    storage.set(KEYS.theme, theme);
    applyTheme(theme);
  });
  diffToggle?.addEventListener('click', () => withPlaceKept(() => {
    const mode = root.dataset.diff === 'split' ? 'unified' : 'split';
    storage.set(KEYS.diff, mode);
    applyDiff(mode);
    layoutAll();
  }));
  notesToggle?.addEventListener('click', () => withPlaceKept(() => {
    const mode = root.dataset.notes === 'inline' ? 'margin' : 'inline';
    root.dataset.notes = mode;
    storage.set(KEYS.notes, mode);
    layoutAll();
  }));
  // The system theme applies only while the reader has not chosen one.
  systemTheme?.addEventListener?.('change', (ev) => {
    if (!storage.get(KEYS.theme)) applyTheme(ev.matches ? 'dark' : 'light');
  });
  // Ticks made in another tab of the same report show up here too.
  window.addEventListener('storage', (ev) => {
    if (ev.key === VIEWED_KEY) syncTicks(readViewed());
  });
  // `v` toggles the file block under the pointer.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'v' || ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev.target)) return;
    if (state.hoveredBlock) toggleSection(state.hoveredBlock);
  });
  document.addEventListener('mouseover', (ev) => {
    const sec = closestTo(ev.target, 'section.file');
    if (sec) state.hoveredBlock = sec;
    onLineOver(ev);
  });
  document.addEventListener('mouseout', onLineOut);
  document.addEventListener('click', onClick);
  document.addEventListener('change', (ev) => {
    const box = ev.target;
    if (!(box instanceof HTMLInputElement) || !box.matches('.viewed-toggle')) return;
    /** @type {FileSection | null} */
    const sec = box.closest('section.file');
    if (!sec) return;
    const stuck = sec.getBoundingClientRect().top < 0; // ticked from the sticky header, mid-file
    toggleViewed(sec.dataset.path, sec.dataset.hash, box.checked);
    // The file folded under the reader: bring its header to the top so the next file follows right below.
    if (stuck && box.checked) window.scrollBy(0, sec.getBoundingClientRect().top);
  });
  window.addEventListener('beforeprint', () => { state.printing = true; layoutAll(); });
  window.addEventListener('afterprint', () => { state.printing = false; layoutAll(); });
  window.addEventListener('resize', onResize);

  // Start: all three settings as the page shows them, then one layout of the notes, then the ticks.
  applyTheme(root.dataset.theme || 'light');
  applyDiff(root.dataset.diff || 'unified');
  root.dataset.notes ||= 'margin';
  layoutAll();
  initViewed();
  // Highlighting and fonts can change row heights after the first layout.
  window.addEventListener('load', layoutAll);
}
