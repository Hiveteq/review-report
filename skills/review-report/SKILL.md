---
name: review-report
description: Use when asked to explain, walk through, or produce a readable HTML report of a diff, branch, or PR, with diffs, diagrams and clear line-by-line explanations the reviewer can follow without effort.
---

# Review Report

Turn a diff into an HTML walkthrough for a colleague who knows the codebase before this change but has not
seen the change. Explain what is new, why, and how it touches existing code; explain existing code only where
the change hinges on it. You write a story JSON; `render.mjs` does the HTML. Never hand-write HTML or copy
diff text. `$SKILL` is `${CLAUDE_SKILL_DIR}`; contract, conventions and errors are in
`$SKILL/reference/story-schema.md`.

## Workflow

1. **Dump:** `node $SKILL/render.mjs --dump-numbered [--target <spec>]`. Anchors come from its `old`/`new`
   columns, never from counting or Read-tool line numbers. Targets: none (vs master/main), `#123` (gh when
   installed, otherwise git; tell the user any `note:` line once), `A..B`, `<commit>`, `--staged`, `--working`.
2. **Read surrounding code** where the diff does not explain intent. For a pull request, also read its
   description when gh is available (`gh pr view <n>`).
3. **Write the story** to the scratchpad.
4. **Render:** `node $SKILL/render.mjs --story <path> [--target <spec>]`, fix every `error:` line and resolve every
   anchor `warning:` (a note naming code that sits on a neighbouring line). It
   refuses under 80% of changed lines shown or a chapter over 1,000 lines. Never lower `--min-coverage`;
   add chapters or `exclude` with a reason.
5. **Reader pass, two rounds:** a fresh subagent gets the report, read-only base-commit code and the brief in
   `$SKILL/reference/reader-pass.md`, and lists where it had to guess. Answer each question with a note,
   re-render, run one more fresh reader. Its leftovers go to `meta.readerPass.openQuestions` and to
   `howToRead` as open points; render again.
6. **View:** screenshot the printed path in the browser tool and read the image. If `file://` is refused,
   serve the folder (`python3 -m http.server 8765 --bind 127.0.0.1`; `python` on Windows) for the screenshot
   only, then stop it.
   Give the user the local path.

## Story shape

`overview`: `bigPicture` (where the change sits, one paragraph), `why`, `approach` (the mechanism),
`howToRead` (chapter order and why). `bigPicture` or `approach` holds a ```` ```mermaid ```` diagram of the
known flow with new and changed nodes marked; a reshaped flow gets a before/after pair, before on the left.
`glossary`: only terms the change introduces. `tests`: globs for this project's test files (`[]` if none).
Optional `howToTest`, `exclude` (`glob` + `reason`). `chapters`:
`title`, `intro`, `hunks` (file, new-side `lines` or `"all"`, `comments` by `line` and `side`; `"slice": true`
shows only that range, to spread one file over several chapters). Unreferenced lines land in "Other changes".

## Reading order

1. Chapter 1 is what a user or caller triggers: UI event, endpoint, flag, CLI argument. A migration leads only
   when it is the whole change.
2. Each next chapter is what the previous one calls. Storage, types and configuration sit with the first step
   that uses them, never in a chapter of their own.
3. A chapter is one idea across layers: entry point, types, use case, steps, errors, tests. Under 1,000 lines.
   Its intro gets a diagram only when the chapter has a sequence across three or more parts or over time, a
   state machine it adds or changes, a branch with three or more outcomes, or storage whose relations decide
   the logic. Never for a straight step, configuration, types or tests alone. Re-check every chapter whose
   files change, after any edit to the story.
4. A note goes wherever the reader would guess about the change: why this branch, what this call reaches,
   which invariant, how it meets existing code, what a test guards. No quota; the reader pass decides.
   New code copied from existing code gets a note on what it does and where the original lives: the copy is
   a finding in itself.
5. Tests sit with the code they prove; a tests-only chapter holds shared fixtures at most. Each test file shown
   carries `covers`: what it pins and what of the change it leaves untested.
6. Generated files, lockfiles, catalogs, formatting and renames go in `exclude`, named once in `howToRead`.
   Source code in "Other changes" is a coverage failure.
7. A large change is still one story; the renderer pages it by chapter. When the size cap forces a split, keep
   the flow together (entry point through its steps) and move what it relies on (storage, configuration,
   cross-cutting types) to the next chapter. Never split a flow at a layer boundary.

## Red flags

One file or one layer per chapter. File-path titles. Notes that read the line aloud or explain old code.
Unmarked diagrams. Hand-counted anchors. Reader pass skipped, given the diff, or run past two rounds.
