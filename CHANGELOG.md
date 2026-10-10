# Changelog

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
