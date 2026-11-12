# Changelog

## Unreleased

**Fixes**
- Large paged reports render in well under a second; before, 5,000 files took minutes.
- The report page no longer stops working when its saved browser state is damaged. A damaged entry from an
  earlier render no longer blocks carrying ticks over, and a damaged tick list no longer drops new ticks.
- The page script no longer adds hover listeners on every re-layout. Hovering after switching notes to inline
  no longer opens a second note row, and moving between a note's circle and its code no longer closes and
  reopens the note.
- A Markdown heading with a stray carriage return or a Unicode line or paragraph separator no longer makes
  rendering hang. It renders as a heading.
- Files whose extension or name matches a built-in object key, such as `.constructor`, no longer get a wrong
  code-highlighting label or count as viewed before they are ticked. A file named `__proto__` can be ticked,
  and a code block tagged `constructor` no longer logs highlight.js warnings.
- An unexpected error while rendering the page prints one `error: cannot render report: ...` line instead of a
  stack trace or a misleading "cannot write" message.

**Changes**
- The code follows modern JavaScript throughout, with JSDoc types; ESLint and a TypeScript type check run in CI.
- `render.mjs` now rejects `--pages` and `--single` together; before, the later one won silently. Options also
  accept the `--name=value` form.
- Lint also limits function size, nesting and parameters, requires JSDoc on exported functions and a reason on
  every disable comment, and fails on warnings.
- `npm run check:licenses` runs in CI. Every package in the lockfile, dev tools included, must be under an allowed
  permissive licence. `THIRD_PARTY_NOTICES.md` credits the packages whose licences ask for it.
- `render.mjs` is now a pipeline of named steps, and the diff, coverage, Markdown, story and HTML modules are
  split into smaller functions. The page script is grouped by feature and uses one delegated listener per
  event type. Output is unchanged except for the fixes above.
- Development needs Node 22.22.2 or newer, or 24.15.0 or newer. The skill's own requirement is unchanged.

**Tests**
- Snapshot tests pin the renderer's output: paged pages, the numbered dump and the command-line messages.
  `npm test -- --test-update-snapshots` rewrites them.
- New browser tests cover notes below the code, pinned notes during re-layout, print, sync between tabs, damaged
  browser storage, hover across highlighted code, listener count, the OS colour scheme and files named like
  built-in object keys.
- Unit tests remove their temporary folders.

**Docs**
- The dark split-view README screenshot was re-taken; the old one caught the progress bar mid-animation.

## 0.1.2

**Features**
- A diagram shrunk by more than a tenth to fit its column gets a **Full size** button above it. It draws the
  diagram at its natural width, and the box scrolls sideways; **Fit to width** goes back. The choice
  survives a theme switch.

**Docs**
- The README now leads with what the walkthrough gives you, and states the requirements exactly.
- Contributors: commit messages and pull-request titles follow `type(scope): summary`.

## 0.1.1

**Fixes**
- Pages with several diagrams drew them into each other's boxes or left some empty. Diagrams now render one
  at a time, and a theme switch mid-render no longer mixes old and new drawings.
- In the dark theme, text on boxes marked new or changed was light on a light fill and hard to read. It now
  stays dark.

**Changes**
- Mermaid 12.1.0 (from 11.17.2). Flowchart, state and entity diagrams draw right-angled edges.

## 0.1.0

First public release.

**Story and renderer**
- Claude writes a story JSON; `render.mjs` joins it with the real diff and writes the HTML. No HTML is hand-written
  and no diff text is copied.
- Targets: current branch against master or main, `#123` pull requests via `gh`, `A..B` ranges, a single commit,
  `--staged` and `--working`. `--dump-numbered` prints the diff with old and new line numbers for anchoring notes.
- Overview in four parts (where the change sits, why, approach, how to read), Mermaid diagrams inside the text
  with new and changed parts marked, optional chapter diagrams, and a glossary of terms the change introduces.
- Chapters follow the order the change executes, across layers. `slice` spreads one file over several chapters.
- Every test file shown carries a `covers` statement: what it pins and what it leaves untested. The project's test
  files are declared in the story, never guessed.
- Checks: at least 80% of changed lines shown, chapters under 1,000 lines, valid anchors, a warning when a note
  names code on a neighbouring line, and every error names the field to fix.
- Long reports are written as an index page plus one page per chapter.

**Report page**
- GitHub-style diffs with syntax highlighting, light and dark themes, one unified or split setting that keeps the
  reader's place.
- Notes in a margin beside the code; hovering a line opens its note right under it, pushing the code down.
- Viewed checkbox per file, sticky file headers, per-chapter and overall progress. Ticks are stored per report
  and survive re-renders for files whose diff is unchanged.
- highlight.js and Mermaid are pinned to exact versions with subresource-integrity hashes; offline, the report
  still works and shows plain text.

**Packaging**
- Installable as a skill folder or as a Claude Code plugin. Tested on Linux, macOS and Windows, and in Chromium,
  Firefox and WebKit.
