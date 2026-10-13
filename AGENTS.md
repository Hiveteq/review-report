# AGENTS.md

Guidance for coding agents, and the people driving them, who change this repository.
It applies to human contributors too. [CONTRIBUTING.md](CONTRIBUTING.md) covers issues and pull requests.

## What this is

A Claude Code skill. An agent reads a diff and writes a story JSON: chapters, notes on lines, diagrams.
`render.mjs` turns the story and the diff into an HTML report. This file is about changing the skill, not
using it; usage is in [README.md](README.md).

## Layout

| Path | What it holds |
|---|---|
| `skills/review-report/SKILL.md` | What the agent is told to do. Short on purpose. |
| `skills/review-report/reference/` | Story contract (`story-schema.md`), reader-pass brief, generated example report. |
| `skills/review-report/render.mjs` | Command line: parses flags, loads story and diff, writes the report. |
| `skills/review-report/lib/` | Diff parsing, git targets, coverage, story checks, Markdown, HTML, pinned CDN files. |
| `skills/review-report/template/` | Page script and stylesheet, inlined into every report. |
| `skills/review-report/test/` | Unit and CLI tests, plus the demo fixture (a made-up Greeter change). |
| `e2e/` | Browser tests (`@playwright/test`) in Chromium, Firefox and WebKit; `render-reports.mjs` renders their reports. |
| `scripts/` | Test runner, README screenshot generator, CDN pin updater. |
| `.claude-plugin/` | Plugin and marketplace manifests. Bump `version` together with `package.json`. |

## Commands

```bash
npm test                 # unit and CLI tests, Node 22 or newer, no install needed
npm ci && npx playwright install chromium firefox webkit
npm run e2e              # browser tests; run them for any change to template/ or lib/html.mjs
npm run example          # re-render reference/example-report.html from the fixture
npm run screenshots      # re-render docs/screenshots/ from the fixture
npm run update-cdn       # move the pinned CDN files to their newest releases
```

CI runs `npm test` on Linux, macOS and Windows. It also fails when the committed example report is stale.

## Rules

- **No runtime dependencies.** The renderer runs with a bare `node`. Playwright is for the browser check only.
- **Tests first.** A change to `lib/` or `render.mjs` comes with a test that failed before the change.
- **Portable code.** Spawn processes with `execFileSync` or `spawnSync` and an argument array, never a shell.
  Build paths with `node:path`. Line endings are LF everywhere (`.gitattributes`).
- **Stable story contract.** New story fields are optional. A required field needs SKILL.md and
  `story-schema.md` updated and checked on real diffs.
- **Short SKILL.md.** Its `description` says when to use the skill, never how it works.
  Detail goes to `reference/`.
- **Generated files stay current.** After changing the renderer, page script or stylesheet, run
  `npm run example` and commit the result. Run `npm run screenshots` when the change is visible.
- **Pinned CDN files.** Highlight.js and Mermaid load from CDNs with integrity hashes in `lib/cdn.mjs`.
  Never edit a pin by hand. `npm run update-cdn` moves both to their newest releases and recomputes the
  hashes from the files served. Then run `npm test`, `npm run e2e` and `npm run example`.
  A weekly workflow does the same and opens a pull request.

## Browser tests

- One behaviour per test, named as the reader would describe it. Arrange, act, assert.
- Locate by role and label (`getByRole('checkbox', { name: 'Viewed' })`); fall back to the page's own
  classes only where no role fits.
- Assert with web-first `expect(locator)` matchers, which wait. Never read a value once and compare it,
  and never add fixed waits.
- Import `test` and `expect` from `e2e/reports.mjs`. It fails a test on any uncaught page error and blocks
  the CDNs unless the test opts in with `test.use({ cdn: true })`.
- New report variants go in `e2e/render-reports.mjs`, built from made-up code.
- A new test must fail when the behaviour it covers is broken. Break the code on purpose once and watch it fail.
- No retries. Before adding a test, run `npx playwright test --repeat-each 5`.

## Privacy

People run this skill on private code. None of it may reach this repository.

- Fixtures, tests, examples, screenshots and issue snippets use made-up code only.
- Never copy code, file paths, project names or wording from a diff you reviewed with the skill.
  That includes "realistic" examples in `story-schema.md`, `reader-pass.md` and test cases.
- Rendered reports belong in `reports/`, which git ignores.

## Changing the skill text

A wording change to `SKILL.md` or `reference/` changes agent behaviour, so test it like code.

1. Pick two or three real diffs of different sizes and stacks.
2. Run a fresh agent with the old text, then with the new text. Keep the story, the render output
   and the reader-pass questions from both runs.
3. In the pull request, describe what changed in the reports. Do not attach private diffs or reports.

## Commit messages and pull-request titles

Pull requests are squash-merged, so the pull-request title becomes the commit on `main`. Both follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

    type(scope): summary

- **type**: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore` or `revert`.
- **scope** (optional): `renderer` (render.mjs, lib/), `page` (template/), `skill` (SKILL.md, reference/),
  `e2e`, `cdn`, `deps`, `release`.
- **summary**: imperative, lower case, no full stop, at most 72 characters. "fix(page): render diagrams one at a
  time", not "Fixed diagrams."
- **body** (optional): why the change was needed, wrapped at 72 characters. The diff already shows what changed.
- A change to the story format that breaks existing stories adds `!` after the type and a
  `BREAKING CHANGE:` footer saying what to update.
- Releases: `chore(release): 0.1.2`.

## Pull requests

- One problem per pull request.
- Title it `type(scope): summary`, as above.
- A human has read the whole diff before opening it.
- Name the agent and model that wrote the change, if any.
- Fill in the checklist in the pull request template.
