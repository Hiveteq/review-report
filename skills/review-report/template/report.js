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
(function () {
  var THEME_KEY = 'review-report-theme';
  var NOTES_KEY = 'review-report-notes';
  var DIFF_KEY = 'review-report-diff';
  var root = document.documentElement;
  var VIEWED_KEY = 'review-report:viewed:' + (root.dataset.reportId || 'report');

  // ---------- theme ----------
  // Persisted only when the user toggles; an untouched page keeps following the system setting.
  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    var light = document.getElementById('hljs-light');
    var dark = document.getElementById('hljs-dark');
    if (light) light.disabled = theme === 'dark';
    if (dark) dark.disabled = theme !== 'dark';
    if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ } }
    renderDiagrams(theme);
  }
  var themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) themeToggle.addEventListener('click', function () {
    applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });
  var systemTheme = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  if (systemTheme && systemTheme.addEventListener) systemTheme.addEventListener('change', function (ev) {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* private mode */ }
    if (!stored) applyTheme(ev.matches ? 'dark' : 'light', false);
  });

  // Mermaid re-renders from the saved source so a theme change repaints diagrams.
  // Mermaid cannot render two diagrams at once: concurrent runs draw into each other's
  // boxes and leave others empty. So all renders go through one queue, one diagram at a
  // time. A theme change starts a new generation; queued work from the old one is skipped.
  // Each diagram gets its own run: a syntax error in one leaves the others rendered and
  // only the broken one falls back to its source text.
  var diagramQueue = Promise.resolve();
  var diagramGeneration = 0;
  function renderDiagrams(theme) {
    if (typeof mermaid === 'undefined') return;
    var nodes = document.querySelectorAll('pre.mermaid');
    if (!nodes.length) return;
    var generation = ++diagramGeneration;
    var unusable = false;
    function current() { return generation === diagramGeneration; }
    diagramQueue = diagramQueue.then(function () {
      if (current()) mermaid.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default' });
    }).catch(function () { unusable = true; }); // every diagram keeps what it shows now
    nodes.forEach(function (n) {
      function restore() { n.textContent = n.dataset.source; n.removeAttribute('data-processed'); }
      diagramQueue = diagramQueue.then(function () {
        if (!current() || unusable) return;
        restore();
        return Promise.resolve(mermaid.run({ nodes: [n] })).then(function () { fitDiagram(n.closest('figure.diagram')); });
      }).catch(restore); // a syntax error rejects; the queue moves on to the next diagram
    });
  }

  // A diagram wider than its column is shrunk to fit: the whole flow stays in view, but its text
  // can get small. Diagrams shrunk by more than a tenth get a "Full size" button; a smaller shrink
  // leaves the text readable, and a button there would be noise. The button draws the diagram at
  // its natural width and lets the box scroll sideways. The choice lives on the figure, so the
  // re-render after a theme change keeps it.
  function fitDiagram(fig) {
    var svg = fig && fig.querySelector('pre.mermaid svg');
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal || !svg.viewBox.baseVal.width) return;
    var natural = svg.viewBox.baseVal.width;
    var full = fig.classList.contains('full');
    svg.style.width = full ? natural + 'px' : '';
    svg.style.maxWidth = full ? 'none' : natural + 'px';
    var shrunk = !full && svg.getBoundingClientRect().width < natural * 0.9;
    var button = fig.querySelector('.diagram-size');
    if (!button && (shrunk || full)) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'diagram-size';
      button.addEventListener('click', function () { fig.classList.toggle('full'); fitDiagram(fig); });
      fig.insertBefore(button, fig.firstChild);
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
  if (typeof hljs !== 'undefined') {
    var known = {};
    document.querySelectorAll('td.code code, pre > code').forEach(function (el) {
      var m = /language-([\w-]+)/.exec(el.className);
      var lang = m ? m[1] : '';
      if (!(lang in known)) known[lang] = !!(hljs.getLanguage && hljs.getLanguage(lang));
      if (!known[lang]) return;
      try { hljs.highlightElement(el); } catch (e) { /* plain text */ }
    });
  }

  // ---------- notes: capture ----------
  // One record per file block: its tables and the notes lifted out of them.
  var blocks = [];
  document.querySelectorAll('section.file').forEach(function (section) {
    var body = section.querySelector('.file-body');
    if (!body) return; // not a renderer file block: an html chapter may reuse the class name
    var notes = [];
    section.querySelectorAll('table.diff.unified').forEach(function (table) {
      Array.prototype.slice.call(table.querySelectorAll('tr.comment')).forEach(function (row) {
        var anchor = row.previousElementSibling;
        while (anchor && !anchor.classList.contains('line')) anchor = anchor.previousElementSibling;
        if (!anchor) return;
        notes.push({ n: notes.length + 1, anchor: anchor, table: table, el: row.querySelector('.callout'), card: null, marker: null });
        row.parentNode.removeChild(row);
      });
    });
    blocks.push({ section: section, body: body, notesCol: body.querySelector('.notes-col'), notes: notes, split: false });
  });

  // ---------- split view ----------
  // Built lazily from the unified table. Pairs each run of deletions with the
  // following run of additions row by row. Each unified row remembers its split
  // row (_splitRow) so notes can find their anchor in either view. Only code rows
  // and hunk headers are read: comment rows inserted by inline mode are layout,
  // and would otherwise cut a deletion run off from its additions.
  function buildSplit(unified) {
    var split = document.createElement('table');
    split.className = 'diff split';
    split.innerHTML = '<colgroup><col class="num"><col class="code"><col class="num"><col class="code"></colgroup>';
    var rows = Array.prototype.slice.call(unified.rows).filter(function (r) {
      return r.classList.contains('line') || r.classList.contains('hunk-header');
    });
    function cell(cls, text, code) {
      var td = document.createElement('td');
      td.className = cls;
      if (text) td.textContent = text;
      if (code) td.appendChild(code.cloneNode(true)); // the highlighted <code> only, never a note marker
      return td;
    }
    // Number and code cells for one side of a unified row.
    function sideCells(tr, side) {
      var type = tr.classList.contains('add') ? 'add' : tr.classList.contains('del') ? 'del' : 'ctx';
      var num = tr.getAttribute(side === 'old' ? 'data-old' : 'data-new');
      return [cell('num ' + side + ' ' + type, num), cell('code ' + type, null, tr.querySelector('td.code code'))];
    }
    function emptyCells() { return [cell('num empty'), cell('code empty')]; }
    function emitPair(left, right) {
      var tr = document.createElement('tr');
      tr.className = 'line';
      (left ? sideCells(left, 'old') : emptyCells()).concat(right ? sideCells(right, 'new') : emptyCells())
        .forEach(function (td) { tr.appendChild(td); });
      if (left) left._splitRow = tr;
      if (right) right._splitRow = tr;
      tr._unifiedRow = left || right;
      split.appendChild(tr);
    }
    var i = 0;
    while (i < rows.length) {
      var tr = rows[i];
      if (tr.classList.contains('hunk-header')) {
        var header = document.createElement('tr');
        header.className = 'hunk-header';
        var td = document.createElement('td');
        td.colSpan = 4;
        td.textContent = tr.querySelector('td').textContent;
        header.appendChild(td);
        split.appendChild(header);
        i++; continue;
      }
      if (tr.classList.contains('ctx')) { emitPair(tr, tr); i++; continue; }
      var dels = [], adds = [];
      while (i < rows.length && rows[i].classList.contains('del')) dels.push(rows[i++]);
      while (i < rows.length && rows[i].classList.contains('add')) adds.push(rows[i++]);
      var n = Math.max(dels.length, adds.length);
      if (n === 0) { i++; continue; } // a .line row of no known type; never emitted by the renderer
      for (var k = 0; k < n; k++) emitPair(dels[k] || null, adds[k] || null);
    }
    return split;
  }

  // ---------- diff layout: one setting for the whole report ----------
  function setSplit(block, on) {
    block.section.querySelectorAll('table.diff.unified').forEach(function (u) {
      if (on && !u._split) { u._split = buildSplit(u); u.parentNode.insertBefore(u._split, u.nextSibling); }
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
    var rows = document.querySelectorAll('tr.line, header.file-header, h2');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].matches('header.file-header') && rows[i].closest('section.file').getBoundingClientRect().top < 0) continue;
      var r = rows[i].getBoundingClientRect();
      if (r.bottom > 0 && rows[i].offsetParent !== null) return { el: rows[i], offset: r.top };
    }
    return null;
  }
  function counterpart(el) {
    if (!el || !el.classList.contains('line')) return el;
    if (el.offsetParent !== null) return el;
    if (el._splitRow && el._splitRow.offsetParent !== null) return el._splitRow;
    if (el._unifiedRow && el._unifiedRow.offsetParent !== null) return el._unifiedRow;
    return el;
  }
  function restoreAnchor(anchor) {
    if (!anchor) return;
    var el = counterpart(anchor.el);
    var top = el.getBoundingClientRect().top;
    window.scrollBy(0, top - anchor.offset);
  }
  // Runs a layout change with the reader's place preserved.
  function withPlaceKept(change) {
    var anchor = anchorOnScreen();
    change();
    restoreAnchor(anchor);
  }

  var diffToggle = document.getElementById('diff-toggle');
  function applyDiffMode(mode, persist) {
    root.dataset.diff = mode;
    if (persist) { try { localStorage.setItem(DIFF_KEY, mode); } catch (e) { /* private mode */ } }
    blocks.forEach(function (b) { setSplit(b, mode === 'split'); });
    if (diffToggle) diffToggle.textContent = 'Diff: ' + mode;
    layoutAll();
  }
  if (diffToggle) diffToggle.addEventListener('click', function () {
    withPlaceKept(function () { applyDiffMode(root.dataset.diff === 'split' ? 'unified' : 'split', true); });
  });

  // ---------- notes: placement ----------
  function clearNotes(block) {
    if (hint && hint.block === block) closeHint();
    block.section.querySelectorAll('tr.annotated').forEach(function (r) { r._wired = false; r.classList.remove('annotated'); });
    block.section.querySelectorAll('.hint-target').forEach(function (c) { c.classList.remove('hint-target'); });
    block.notes.forEach(function (n) { n.card = null; n.marker = null; });
    block.section.querySelectorAll('tr.comment, .notes-below, .note-marker').forEach(function (n) { n.parentNode.removeChild(n); });
    block.section.querySelectorAll('td.note-anchor').forEach(function (c) { c.classList.remove('note-anchor'); });
    block.notesCol.innerHTML = '';
    block.body.classList.remove('has-margin');
  }
  function visibleRow(note, block) {
    return block.split && note.anchor._splitRow ? note.anchor._splitRow : note.anchor;
  }
  function visibleTable(note, block) {
    return block.split && note.table._split ? note.table._split : note.table;
  }
  // All notes whose anchor currently renders on this row, in story order.
  function notesOnRow(row) {
    var out = [];
    blocks.forEach(function (b) { b.notes.forEach(function (n) { if (visibleRow(n, b) === row) out.push(n); }); });
    return out;
  }
  function marker(n) {
    var m = document.createElement('span');
    m.className = 'note-marker';
    m.textContent = n;
    return m;
  }

  // Hovering the text of an annotated line opens its notes in a row inserted right
  // under that line. The code below moves down instead of being covered, so the next
  // lines stay readable; leaving the text removes the row and the code moves back.
  // Clicking the circle pins the row open until it, or the page, is clicked again.
  var pinned = null;   // the note whose hint row stays open
  var hint = null;     // { row, tr, block, shifted: [cards] } for the open hint row
  function clearActive() {
    blocks.forEach(function (b) { b.notes.forEach(function (n) { if (n.card) n.card.classList.remove('active'); }); });
  }
  function blockOf(row) {
    var sec = row.closest('section.file');
    return blocks.filter(function (b) { return b.section === sec; })[0];
  }
  function closeHint() {
    if (!hint) return;
    hint.shifted.forEach(function (card) { card.style.transform = ''; });
    if (hint.colHeight !== null && hint.block) hint.block.notesCol.style.minHeight = hint.colHeight;
    if (hint.tr.parentNode) hint.tr.parentNode.removeChild(hint.tr);
    hint = null;
    clearActive();
  }
  function openHint(row, notes, isPinned) {
    if (hint && hint.row === row) { hint.tr.classList.toggle('pinned', !!isPinned); return; }
    closeHint();
    var tr = document.createElement('tr');
    tr.className = 'hint-row' + (isPinned ? ' pinned' : '');
    var gutter = document.createElement('td');
    gutter.colSpan = row.querySelectorAll('td.num').length || 1;
    gutter.className = 'hint-gutter';
    var td = document.createElement('td');
    td.colSpan = Math.max(1, row.children.length - gutter.colSpan);
    notes.forEach(function (n) { td.appendChild(n.el.cloneNode(true)); });
    tr.appendChild(gutter);
    tr.appendChild(td);
    tr.addEventListener('click', function (ev) { ev.stopPropagation(); }); // reading or selecting in a pinned hint keeps it open
    row.parentNode.insertBefore(tr, row.nextSibling);
    // Margin cards are positioned absolutely; move the ones below the line down by the
    // same amount so they stay level with their code.
    var block = blockOf(row);
    var shifted = [];
    var colHeight = null;
    if (block && block.body.classList.contains('has-margin')) {
      var h = tr.offsetHeight;
      // The notes column grows with the pushed cards, so the lowest card never hangs past the block.
      colHeight = block.notesCol.style.minHeight;
      block.notesCol.style.minHeight = ((parseFloat(colHeight) || 0) + h) + 'px';
      var cut = row.getBoundingClientRect().bottom - block.body.getBoundingClientRect().top;
      block.notes.forEach(function (n) {
        // Cards of this line's own notes stay put; only cards for lines below move.
        if (!n.card || notes.indexOf(n) !== -1) return;
        if (parseFloat(n.card.style.top) >= cut - 1) { n.card.style.transform = 'translateY(' + h + 'px)'; shifted.push(n.card); }
      });
    }
    hint = { row: row, tr: tr, block: block, shifted: shifted, colHeight: colHeight };
    clearActive();
    notes.forEach(function (n) { if (n.card) n.card.classList.add('active'); });
  }
  // The source text itself is the hover target: the inline <code> box ends where the
  // text ends, so empty space in the cell, the line-number column and the margin all
  // dismiss the hint. The circle stays as the cue and the pin control.
  function wireRow(row, notes, cell) {
    row.classList.add('annotated');
    var text = cell.querySelector('code') || cell;
    text.classList.add('hint-target');
    text.addEventListener('mouseenter', function () { if (!pinned) openHint(row, notes, false); });
    text.addEventListener('mouseleave', function () { if (!pinned && hint && hint.row === row) closeHint(); });
  }
  function unpin() {
    pinned = null;
    closeHint();
  }
  // Every layout rebuilds the markers and drops the hint row. The pinned note
  // re-opens under its new marker's line, or lets go when the mode has none (inline).
  function refreshPinned() {
    if (!pinned) return;
    if (pinned.marker && pinned.marker.isConnected) { var row = pinned.marker.closest('tr'); openHint(row, notesOnRow(row), true); }
    else unpin();
  }
  function wireMarker(el, note) {
    el.addEventListener('mouseenter', function (ev) { ev.stopPropagation(); if (!pinned) openHint(el.closest('tr'), notesOnRow(el.closest('tr')), false); });
    el.addEventListener('mouseleave', function () { if (!pinned && hint && hint.row === el.closest('tr')) closeHint(); });
    el.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (pinned === note) { unpin(); return; }
      pinned = note;
      var row = el.closest('tr');
      openHint(row, notesOnRow(row), true);
    });
  }
  document.addEventListener('click', function () { if (pinned) unpin(); });

  var printing = false;
  function effectiveMode(block) {
    var wanted = root.dataset.notes === 'inline' ? 'inline' : 'margin';
    if (wanted === 'inline') return 'inline';
    if (printing || block.split || block.body.clientWidth < 900) return 'below';
    return 'margin';
  }
  function layoutBlock(block) {
    clearNotes(block);
    if (!block.notes.length) return;
    var mode = effectiveMode(block);

    if (mode === 'inline') {
      block.notes.forEach(function (note) {
        var row = visibleRow(note, block);
        var tr = document.createElement('tr');
        tr.className = 'comment';
        var td = document.createElement('td');
        td.colSpan = block.split ? 4 : 3;
        td.appendChild(note.el);
        tr.appendChild(td);
        // After any notes already placed under this row, so several notes on one line keep story order.
        var after = row;
        while (after.nextElementSibling && after.nextElementSibling.classList.contains('comment')) after = after.nextElementSibling;
        row.parentNode.insertBefore(tr, after.nextSibling);
      });
      return;
    }

    // Both remaining modes mark the anchor line and number the notes.
    block.notes.forEach(function (note) {
      var row = visibleRow(note, block);
      var cells = row.querySelectorAll('td.code');
      var cell = cells.length === 1 ? cells[0] : (note.anchor.classList.contains('del') ? cells[0] : cells[1]);
      cell.classList.add('note-anchor');
      var m = marker(note.n);
      wireMarker(m, note);
      note.marker = m;
      cell.appendChild(m);
      if (!row._wired) { row._wired = true; wireRow(row, notesOnRow(row), cell); }
    });

    if (mode === 'below') {
      var byTable = new Map();
      block.notes.forEach(function (note) {
        var t = visibleTable(note, block);
        if (!byTable.has(t)) byTable.set(t, []);
        byTable.get(t).push(note);
      });
      byTable.forEach(function (notes, table) {
        var box = document.createElement('div');
        box.className = 'notes-below';
        notes.forEach(function (note) {
          var item = document.createElement('div');
          item.className = 'note';
          item.appendChild(marker(note.n));
          item.appendChild(note.el);
          note.card = item;
          box.appendChild(item);
        });
        table.parentNode.insertBefore(box, table.nextSibling);
      });
      return;
    }

    // margin: absolute-position each note at its anchor's top, then push down to avoid overlap.
    // All cards are appended first and all positions read before any top is written,
    // so the browser lays the block out once instead of once per note.
    block.body.classList.add('has-margin');
    var items = block.notes.map(function (note) {
      var item = document.createElement('div');
      item.className = 'note';
      item.appendChild(marker(note.n));
      item.appendChild(note.el);
      note.card = item;
      block.notesCol.appendChild(item);
      return item;
    });
    var bodyTop = block.body.getBoundingClientRect().top;
    var tops = block.notes.map(function (note) { return visibleRow(note, block).getBoundingClientRect().top - bodyTop; });
    var heights = items.map(function (item) { return item.offsetHeight; });
    var cursor = 0;
    items.forEach(function (item, k) {
      var top = Math.max(tops[k], cursor);
      item.style.top = top + 'px';
      cursor = top + heights[k] + 8;
    });
    // The column must be tall enough for the last note even if it hangs below the code.
    block.notesCol.style.minHeight = (cursor - 8) + 'px';
  }
  function layoutAll() {
    blocks.forEach(layoutBlock);
    refreshPinned();
    if (!notesToggle) return;
    var wanted = root.dataset.notes === 'inline' ? 'inline' : 'margin';
    var anyBelow = wanted === 'margin' && blocks.some(function (b) { return b.notes.length && effectiveMode(b) === 'below'; });
    notesToggle.textContent = 'Notes: ' + wanted + (anyBelow ? ' (below hunks here)' : '');
    notesToggle.title = anyBelow
      ? 'Margin notes need a wider window; in split view and narrow blocks they are listed below each hunk'
      : 'Notes beside the code, or inline between lines';
  }

  var notesToggle = document.getElementById('notes-toggle');
  function applyNotesMode(mode, persist) {
    root.dataset.notes = mode;
    if (persist) { try { localStorage.setItem(NOTES_KEY, mode); } catch (e) { /* private mode */ } }
    layoutAll();
  }
  if (notesToggle) notesToggle.addEventListener('click', function () {
    withPlaceKept(function () { applyNotesMode(root.dataset.notes === 'inline' ? 'margin' : 'inline', true); });
  });

  // ---------- viewed: manual, per report, per file ----------
  // Stored as { path: hash } under a key that includes the report id. A tick is kept
  // only while the file's diff hash still matches, so a re-render that changed the
  // file drops the tick for that file and nothing else.
  function readViewed() {
    try { return JSON.parse(localStorage.getItem(VIEWED_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeViewed(state) {
    try { localStorage.setItem(VIEWED_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }
  function fileBlocks(path) {
    return Array.prototype.filter.call(document.querySelectorAll('section.file'), function (s) { return s.dataset.path === path; });
  }
  function markViewed(path, on) {
    fileBlocks(path).forEach(function (sec) {
      sec.classList.toggle('is-viewed', on);
      var box = sec.querySelector('.viewed-toggle');
      if (box) box.checked = on;
    });
    document.querySelectorAll('.file-index a[data-file]').forEach(function (a) {
      if (a.dataset.file === path) a.parentNode.classList.toggle('is-viewed', on);
    });
  }
  function updateProgress(state) {
    var viewed = Object.keys(state).length;
    document.querySelectorAll('.viewed-count').forEach(function (el) {
      var total = Number(el.dataset.total) || 0;
      el.textContent = viewed + ' of ' + total + ' viewed';
      var fill = el.parentNode.querySelector('.fill');
      if (fill) fill.style.width = (total ? Math.min(100, Math.round(viewed / total * 100)) : 0) + '%';
    });
    // Per chapter: the index list, the sidebar entry and the chapter heading all show how many of
    // the chapter's files are viewed, and switch to a tick when all are.
    function chapterCount(el) {
      var paths = el.dataset.files ? el.dataset.files.split('|') : [];
      return { total: paths.length, done: paths.filter(function (p) { return p in state; }).length };
    }
    document.querySelectorAll('.chapter-list li[data-files]').forEach(function (li) {
      var n = chapterCount(li);
      if (!n.total) return;
      var tag = li.querySelector('.viewed-of');
      if (!tag) { tag = document.createElement('span'); tag.className = 'viewed-of'; li.querySelector('a').insertAdjacentElement('afterend', tag); }
      tag.textContent = n.done + ' of ' + n.total + ' viewed';
      li.classList.toggle('is-viewed', n.done === n.total);
    });
    document.querySelectorAll('.toc li[data-files]').forEach(function (li) {
      var n = chapterCount(li);
      var tag = li.querySelector('.chapter-progress');
      if (tag) tag.textContent = n.done === n.total ? '' : n.done + '/' + n.total;
      li.classList.toggle('is-viewed', n.total > 0 && n.done === n.total);
    });
    document.querySelectorAll('section.chapter[data-files]').forEach(function (sec) {
      var n = chapterCount(sec);
      var tag = sec.querySelector('.chapter-viewed');
      if (tag) tag.textContent = n.done === n.total ? 'All files viewed' : n.done + ' of ' + n.total + ' files viewed';
      sec.classList.toggle('is-viewed', n.total > 0 && n.done === n.total);
    });
  }
  // A re-render after the branch moved gets a new report id (the id hashes the diff), so ticks made
  // on earlier renders live under other keys. Merge them in, once per earlier render: only files whose
  // diff hash is unchanged (a file new commits touched needs a fresh look), and never twice, so a file
  // unticked after the merge stays unticked. The merged render ids are remembered under ADOPTED_KEY.
  function adoptEarlierTicks() {
    try {
      var id = root.dataset.reportId || '';
      var prefix = 'review-report:viewed:' + id.replace(/-[0-9a-f]{8}$/, '') + '-';
      var ADOPTED_KEY = 'review-report:adopted:' + id;
      var done = JSON.parse(localStorage.getItem(ADOPTED_KEY) || '[]') || [];
      var current = {};
      document.querySelectorAll('section.file[data-hash]').forEach(function (sec) { current[sec.dataset.path] = sec.dataset.hash; });
      var state = readViewed();
      var merged = false;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k === VIEWED_KEY || k.indexOf(prefix) !== 0 || !/^[0-9a-f]{8}$/.test(k.slice(prefix.length)) || done.indexOf(k) !== -1) continue;
        var old = JSON.parse(localStorage.getItem(k) || '{}') || {};
        Object.keys(old).forEach(function (p) { if (current[p] && old[p] === current[p] && !(p in state)) { state[p] = old[p]; merged = true; } });
        done.push(k);
      }
      if (merged) writeViewed(state);
      localStorage.setItem(ADOPTED_KEY, JSON.stringify(done));
    } catch (e) { /* storage unavailable: keep what this render has */ }
  }
  function initViewed() {
    adoptEarlierTicks();
    var state = readViewed();
    var changed = false;
    // Drop ticks for files whose diff changed since they were ticked.
    document.querySelectorAll('section.file[data-hash]').forEach(function (sec) {
      var p = sec.dataset.path;
      if (p in state && state[p] !== sec.dataset.hash) { delete state[p]; changed = true; }
    });
    if (changed) writeViewed(state);
    Object.keys(state).forEach(function (p) { markViewed(p, true); });
    updateProgress(state);
    document.querySelectorAll('.viewed-toggle').forEach(function (box) {
      box.addEventListener('change', function () {
        var sec = box.closest('section.file');
        var stuck = sec.getBoundingClientRect().top < 0; // ticked from the sticky header, mid-file
        toggleViewed(sec.dataset.path, sec.dataset.hash, box.checked);
        // The file folded under the reader: bring its header to the top so the next file follows right below.
        if (stuck && box.checked) window.scrollBy(0, sec.getBoundingClientRect().top);
      });
    });
  }
  function toggleViewed(path, hash, on) {
    var state = readViewed();
    if (on) state[path] = hash; else delete state[path];
    writeViewed(state);
    markViewed(path, on);
    updateProgress(state);
  }
  // Ticks made in another tab of the same report show up here too.
  window.addEventListener('storage', function (ev) {
    if (ev.key !== VIEWED_KEY) return;
    var state = readViewed();
    document.querySelectorAll('section.file[data-path]').forEach(function (sec) { markViewed(sec.dataset.path, sec.dataset.path in state); });
    updateProgress(state);
  });
  // `v` toggles the file block under the pointer; ignored while typing.
  var hoveredBlock = null;
  document.addEventListener('mouseover', function (ev) {
    var sec = ev.target.closest && ev.target.closest('section.file');
    if (sec) hoveredBlock = sec;
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'v' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!hoveredBlock || !hoveredBlock.dataset.hash) return;
    var on = !hoveredBlock.classList.contains('is-viewed');
    withPlaceKept(function () { toggleViewed(hoveredBlock.dataset.path, hoveredBlock.dataset.hash, on); });
  });

  window.addEventListener('beforeprint', function () { printing = true; layoutAll(); });
  window.addEventListener('afterprint', function () { printing = false; layoutAll(); });
  // Note positions depend on block width only; a height-only resize changes nothing.
  var resizeTimer = null;
  var laidOutWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (window.innerWidth === laidOutWidth) return;
      laidOutWidth = window.innerWidth;
      layoutAll();
      fitDiagrams(); // a narrower window can shrink a diagram that fitted before
    }, 100);
  });

  applyTheme(root.dataset.theme || 'light', false);
  if (root.dataset.diff === 'split') blocks.forEach(function (b) { setSplit(b, true); });
  if (diffToggle) diffToggle.textContent = 'Diff: ' + (root.dataset.diff === 'split' ? 'split' : 'unified');
  applyNotesMode(root.dataset.notes === 'inline' ? 'inline' : 'margin', false);
  initViewed();
  // Highlighting and fonts can change row heights after first layout.
  window.addEventListener('load', layoutAll);
})();
