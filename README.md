# review-report

A [Claude Code](https://claude.com/claude-code) skill that turns a diff, branch or pull request into a
self-contained HTML walkthrough for a reviewer who knows the codebase but has not seen the change.

Model-written changes are often correct and still hard to review: the explanation is compressed, the order is
the file order, and the reasoning lives in the model's head. This skill makes Claude write a short **story**
instead: an overview that places the change in the known flow, with Mermaid diagrams that mark what is new, and
chapters that walk the diff **in the order it executes**, with plain-English notes anchored to specific lines. A zero-dependency Node renderer joins the story
with the real diff and emits one HTML file. Claude never hand-writes HTML and never copies diff text.

![Report with margin notes](docs/screenshots/report-margin-light.png)

## What the report gives you

- **Reading order that follows the change**, not the file list: entry point first, then what it calls.
- **Notes beside the code**, numbered, level with the line they explain. Hover an annotated line to open its
  note right under it; the code below moves down rather than being covered. Click the number to pin it. A toggle switches to GitHub-style inline rows.
- **GitHub-grade diffs**: syntax highlighting, light and dark themes, one unified-or-split setting for the whole
  report that keeps your place when it switches.
- **Mark files as viewed**, by hand only, like GitHub: the block folds, the sidebar ticks it, and a progress rail
  shows how much of the change you have looked at. Ticks are stored per report and per diff, so two reports open
  side by side never share them, and a re-render that changed a file drops that file's tick.
- **New terms** up front: only what the change introduces, never what the reviewer already knows.
- **Nothing hidden**: hunks no chapter mentions are collected under "Other changes", and the renderer refuses a
  story that shows less than 80% of the changed lines. Whether the notes are enough is decided by a reader
  pass: a fresh agent with the report and the pre-change code must explain every chapter back without guessing.

![Note opened under a hovered line](docs/screenshots/hover-hint.png)

## Install

**As a skill folder** (any Claude Code setup):

```bash
git clone https://github.com/Hiveteq/review-report.git
ln -s "$(pwd)/review-report/skills/review-report" ~/.claude/skills/review-report
```

or copy `skills/review-report/` into `~/.claude/skills/`.

**As a plugin** (Claude Code plugin marketplace):

```
/plugin marketplace add Hiveteq/review-report
/plugin install review-report@hiveteq
```

When installed as a plugin the command is `/review-report:review-report`; as a skill folder it is `/review-report`.

Either way you need Node 22 or newer and `git`; `gh` is needed for pull-request targets.

## Use

In Claude Code, inside the repository you want explained:

```
/review-report            # current branch vs master or main
/review-report #123       # a pull request, via gh
/review-report v1..v2     # any git range
/review-report abc123     # one commit, against its parent
/review-report --staged   # or --working (tracked files; `git add -N` a new file to include it)
```

The report lands in `reports/review/<date>-<title>.html` in that repository, and the folder is added to
`.gitignore` on first use. Open the file in a browser. Long reports become a folder of pages, one per chapter,
with `index.html` as the entry.

## How it works

1. `render.mjs --dump-numbered` prints the diff with old and new line numbers on every line.
2. Claude writes the story JSON. The contract, error messages and a complete example are in
   [`skills/review-report/reference/story-schema.md`](skills/review-report/reference/story-schema.md).
3. `render.mjs --story <file>` validates the story (every error names its field), slices the referenced
   hunks from the real diff, attaches the notes and writes the page.
4. Claude opens the page, takes a screenshot and reads it before reporting done.

Highlighting and diagrams load from CDNs at view time; without network the report shows plain text.

## Development

```bash
npm test        # node --test, no dependencies
npm run example # re-render the reference example report
npm run e2e     # browser tests in Chromium, Firefox and WebKit; needs `npm ci` and
                # `npx playwright install chromium firefox webkit` first
```

CI runs the tests on Linux, macOS and Windows and the browser check on all three engines. Highlighting and
diagrams load from CDNs; offline, the report still works and shows plain text.

Contributions: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT, © 2026 Hiveteq.
