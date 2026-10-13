# Story file contract

The story is the only thing Claude writes per report. `render.mjs` joins it with the real diff.
Claude never copies diff text into the story; it points at hunks by file and line range.

## Fields

- `meta.title` (required): report title. Also becomes the output file slug.
- `meta.readerPass` (required for a finished report): `{ "rounds": 1 or 2, "questionsAnswered": N, "openQuestions": M }`,
  the result of the reader pass in `reader-pass.md`. A render without it says "not yet run" in the header.
- `meta.target`, `meta.base`, `meta.head` (optional): filled from the git target when omitted.
- `overview` (required object): the big picture, rendered as four sub-sections in this order. Each part is Markdown.
  - `bigPicture`: where the change sits in the system, one paragraph for a reader who already knows the
    system. Its diagram shows the established flow with the change marked (see Diagrams below).
  - `why`: the problem or request behind the change, and what went wrong without it.
  - `approach`: the change in one paragraph: the mechanism, the main pieces, the trade-off taken.
  - `howToRead`: the order the chapters take and why, in two or three sentences.
- `glossary` (optional): `[{ "term": "...", "meaning": "..." }]`. Only terms the change introduces or redefines:
  new types, states, endpoints, concepts. Rendered as "New terms" after the overview. A reader who knows the
  codebase does not need existing components explained; listing them is noise.
- `howToTest` (optional, Markdown): commands a reader runs to verify locally.
- `tests` (required): globs for this project's test files, `[]` if the change has none. The renderer has no
  built-in idea of what a test looks like; the writer knows the stack and declares it here.
- `exclude` (optional): `[{ "glob": "src/generated/**", "reason": "generated from the schema" }]`. Files matched by a
  glob do not count toward coverage. The reasons are printed under the report title, so use them only for files a
  reviewer would agree are not the change: generated code, vendored code, lockfiles, docs, fixtures. Binary files,
  lockfiles by well-known names, minified files, source maps and paths under `generated`, `vendor`, `node_modules`,
  `dist` or `build` are excluded without being listed. Nothing else is assumed about the stack.
- Diagrams: a fenced ```` ```mermaid ```` block inside any Markdown field (overview parts, chapter intros, comments)
  renders as a diagram exactly where it sits. The overview must contain at least one, in `bigPicture` or `approach`.
  The big-picture diagram shows the **established flow with the change marked**, so a reader who knows the old
  flow spots the difference at a glance. Use these two classes and a one-line legend after the figure:

  ```mermaid
  flowchart LR
    Caller --> Name --> Greeter.greet
    classDef new fill:#dafbe1,stroke:#1a7f37
    classDef changed fill:#fff8c5,stroke:#9a6700
    class Name new
    class Greeter.greet changed
  ```

  "Green is new, yellow is changed." When the change reshapes the flow (a step moves, a path disappears), show
  a before and after pair instead of one marked diagram. Mermaid places subgraphs in whatever order lays out
  best, so pin it: before first, after second, and an invisible link between them.

  ```mermaid
  flowchart LR
    subgraph before["Before (base)"]
      direction TB
      A1[Request] --> D1[(Database)]
    end
    subgraph after["After (this change)"]
      direction TB
      A2[Request] --> C2{Cache hit?}
      C2 -->|no| D2[(Database)]
    end
    before ~~~ after
    classDef new fill:#dafbe1,stroke:#1a7f37
    class C2 new
  ``` A change with no effect on the established flow still
  gets one diagram, at the level of the change: the call or state sequence the fix touches.
- `chapters` (required, non-empty): the ordered narrative. Each chapter has:
  - `title` (required)
  - `intro` (required, Markdown, at least two sentences): the idea of this chapter and why it follows the previous one.
  - exactly one of:
    - `hunks`: list of hunk references (below), or
    - `html`: raw HTML for a one-off table or figure. Escape hatch; not escaped.
- Hunk reference: `{ "file": "<path as in the diff>", "lines": [start, end] | "all", "comments": [...] }`
  - `lines` is a **new-side** range. Every diff hunk of that file that overlaps the range is shown.
    Use `"all"` for deleted files and for small files where every hunk belongs to the chapter.
  - `file` for a renamed file is its **new** path.
  - `covers` (required on test files): one or two sentences on what the test pins and what relevant behavior of
    the change it leaves untested. Rendered as a banner above the file's diff. A test file is any file matching
    `tests`; each one shown in a chapter needs `covers` on at least one of its hunk references.
  - `"slice": true` (needs a `lines` range) shows only the new-side lines in that range, with any deleted lines
    that sit among them. Use it to spread one file, typically a new one, over the chapters that explain its
    parts: a new module's three public functions in three chapters. Lines no slice shows land in "Other changes" and
    count against coverage.
- Comment: `{ "line": N, "side": "new" | "old", "text": "Markdown" }`
  - `side` defaults to `"new"`. Use `"old"` to explain a deleted line.
  - The line must exist on that side inside the hunks the reference selected.

## Finding line numbers

`node render.mjs --dump-numbered [--target <spec>]` prints every diff line as `old new marker content`,
with `-` where a side has no number. Copy `new` for `side: "new"` comments and `old` for `side: "old"`.
Targets: none (current branch vs `master`/`main`), `#123` (pull request; fetched with gh when installed, otherwise with git), `A..B` or `A...B`, a single `<commit>`
(that commit against its parent), `--staged`, `--working`.

## Splitting a chapter that is too big

The 1,000-line cap sometimes forces one idea into two chapters. Split so the first chapter still reads as a
complete flow: the entry point, the use case and the steps that do the work, with their tests. The second
chapter takes what that flow relies on: new storage and migrations, configuration, shared types, and
cross-cutting pieces that the flow merely happens to use first. Do not put the entry point in one chapter
and the logic it calls in the next; the reader would see a route without seeing what it does.

## Chapter diagrams

A chapter intro may hold a ```` ```mermaid ```` diagram, placed before the code, when the chapter has:

- a sequence across three or more components, or over time: retries, polling, a race, async callbacks;
- a state machine the change adds or changes: new statuses or transitions;
- a branch with three or more outcomes whose order matters;
- storage whose relations or constraints decide the logic.

Not for a straight-line step, configuration, a rename, types alone, or tests alone. The diagram zooms into one
part of the big picture; it does not repeat it. Where it mixes existing and new parts, mark them with the same
`new` and `changed` classes. Follow it with a one-line caption saying what to look at.

## Coverage, chapter size and the reader pass

The renderer counts changed lines (added plus deleted) in every counted file and how many of them the chapters
show. Below 80% it refuses to render and lists the files not shown, largest first. A chapter showing more than
1,000 changed lines is refused too: split it into chapters of one idea each. Neither number says anything about
whether the notes are enough; the reader pass does (`reader-pass.md`), and its result is required in
`meta.readerPass`. Both figures are printed under the report title.
`--min-coverage` exists for partial reports the reviewer asked for, not for making a story pass.
A long report (over about 1,500 diff rows) is written as a folder: `index.html` with the overview, key terms and
chapter list, then one page per chapter with previous/next links. `--pages` and `--single` override the choice.
`--only 'src/**'` (comma-separated globs) exists for a partial report a reviewer explicitly asked for; it is not
how a large change is split, because a path filter cuts across the reading order.

## Automatic behaviour

- Hunks no chapter references are rendered under "Other changes", grouped by file. Nothing is dropped.
- Markdown supports paragraphs, `#`..`####` headings, `-` and `1.` lists, fenced code, inline code, bold, italic, links.
  Raw HTML inside Markdown is escaped.
- Syntax highlighting is inferred from the file extension.

## Renderer errors

Every error names the field path. Errors come in two rounds, each printed in full before exit 1: first the
story's shape and required fields, then, once the shape is valid, every hunk and line reference against the diff.

| Message | Meaning |
|---|---|
| `chapters[i].hunks[j]: file not in diff: X` | Path typo, or the file is not part of this target. Copy the path from `--dump-diff`. |
| `chapters[i].hunks[j]: no hunk in X overlaps new-side lines a-b` | Range misses every hunk. Check new-side numbers in the `@@ -old +new @@` header. |
| `chapters[i].hunks[j].comments[k]: new line N is not in the selected hunks of X` | Line outside the selected hunks, or wrong side. Deleted lines need `"side": "old"`. |
| `overview must be an object with bigPicture, why, approach and howToRead` / `overview.<part> is required` | The overview is four named parts, not one string. |
| `overview needs at least one ```mermaid diagram inside bigPicture or approach` | Draw the system or the flow next to the text that explains it. |
| `diagrams is no longer a story field` | Move each diagram into the Markdown where it belongs, as a ```mermaid fence. |
| `chapters[i] must have exactly one of hunks or html` | Chapter has both or neither. |
| `chapters[i].intro must have at least two sentences: …` | Intro is one sentence. Say what the chapter shows and why it follows the previous one. |
| `glossary must be a non-empty array of { term, meaning }: …` | Glossary missing or empty. Add every component the chapters rely on. |
| `<field> must be an array` | A single object was written where a list is expected (`glossary`, `hunks`, `comments`). Wrap it in `[...]`. |
| `warning: … line N does not contain `x`; line M does` | The note names code that sits on a neighbouring line: likely an off-by-one anchor. Move it, or leave it if the note really is about line N. |
| `diff is empty for this target` | Nothing to report; check the target. |
| `coverage N% of changed lines shown in chapters; minimum is 80%` | Followed by the files not shown. Add chapters for them, or `exclude` with a reason. |
| `chapters[i] "T" shows N changed lines; split it` | One idea per chapter, under 1,000 changed lines. |
| `meta.readerPass.<field> must be …` | Record the reader pass from `reader-pass.md`: rounds, questions answered, questions still open. |
| `tests is required` | Declare this project's test-file globs; `[]` when the change has no tests. |
| `chapters[i].hunks[j]: X is a test file (matches G); add "covers"` | Say what the test pins and what it leaves untested. |
| `exclude glob matches no file in this diff: G` | Typo in the glob, or the file is not in this target. |

## Reading-order recipe

A chapter list is a path through the change, in the order it executes.

1. Chapter 1 shows where the change enters the system: the UI event, endpoint, config flag or CLI argument that a user or caller triggers. A migration is the entry only when the migration is the whole change.
2. Each next chapter shows the code the previous chapter calls into. Storage, types and configuration appear in the chapter of the first step that uses them, not in a chapter of their own: tables where they are first written, DTOs with their endpoint, settings with the code that reads them.
3. A chapter is one idea. Its intro states the idea and why it follows the previous chapter, in two to four sentences.
4. Each comment explains what a line does for a reader who has never seen this codebase: name the concept, the collaborator it reaches, or the invariant it protects. A term from the glossary is used by that name.
5. Tests are the last chapter, or sit beside the code they prove when that reads better.
6. Renames, formatting, generated files and lockfiles are not chapters. They appear in "Other changes" automatically.

## Complete example

This is `test/fixture.story.json`, the story that renders `reference/example-report.html` from
`test/fixture.diff`. It passes the validator as written.

```json
{
  "meta": {
    "title": "Greeter takes a Name value object",
    "target": "fixture",
    "base": "master",
    "head": "feature/name"
  },
  "overview": {
    "bigPicture": "`Greeter` builds the greeting text from whatever string the caller passes. This change puts a `Name` type between the caller and `Greeter`.\n\n```mermaid\nflowchart LR\n  Caller --> Name --> Greeter.greet\n  classDef new fill:#dafbe1,stroke:#1a7f37\n  classDef changed fill:#fff8c5,stroke:#9a6700\n  class Name new\n  class Greeter.greet changed\n```\n\nGreen is new, yellow is changed; the caller is untouched.",
    "why": "Passing a raw `String` let callers send empty or malformed names. Bugs showed up far from the call site.",
    "approach": "Introduce a `Name` record and make `Greeter.greet` accept only that type. Callers must construct a `Name`, so validation happens once, at the boundary.",
    "howToRead": "Top to bottom: the new type first, then the call site that adopts it, then the class it replaces. Docs and the migration table close the report."
  },
  "glossary": [
    {
      "term": "Greeter",
      "meaning": "The class that builds the greeting text. Everything in this change is about what it accepts."
    },
    {
      "term": "Name",
      "meaning": "New value object wrapping a person's name, so callers cannot pass an arbitrary string."
    }
  ],
  "howToTest": "```bash\nmvn -q test\n```",
  "tests": [],
  "exclude": [ { "glob": "docs/**", "reason": "docs: prose, not code" } ],
  "chapters": [
    {
      "title": "1. The new Name type",
      "intro": "Everything else depends on this record, so it comes first. It is the type the rest of the change passes around.",
      "hunks": [
        {
          "file": "src/Name.java",
          "lines": "all",
          "comments": [
            {
              "line": 3,
              "text": "A Java `record` gives `equals`, `hashCode` and the `value()` accessor for free."
            }
          ]
        }
      ]
    },
    {
      "title": "2. Greeter adopts Name",
      "intro": "The only call site. Note the accessor call replacing direct string use; it follows the record because it consumes it.",
      "hunks": [
        {
          "file": "src/Greeter.java",
          "lines": [
            4,
            5
          ],
          "comments": [
            {
              "line": 4,
              "text": "Signature changes from `String` to `Name`; callers must construct a `Name`."
            },
            {
              "line": 5,
              "side": "old",
              "text": "The deleted line concatenated the raw string. The replacement calls `name.value()`."
            }
          ]
        }
      ]
    },
    {
      "title": "3. Legacy removed",
      "intro": "Dead class with no references, so removing it is safe. It comes after the call site to show nothing else used it.",
      "hunks": [
        {
          "file": "src/Legacy.java",
          "lines": "all",
          "comments": [
            {
              "line": 2,
              "side": "old",
              "text": "Nothing imported this class."
            }
          ]
        }
      ]
    },
    {
      "title": "4. Usage docs",
      "intro": "README gains the build command. Only the usage hunk matters here; the title tweak is in the appendix.",
      "hunks": [
        {
          "file": "README.md",
          "lines": [
            10,
            12
          ]
        }
      ]
    },
    {
      "title": "5. Migration checklist",
      "intro": "Steps for downstream callers, as a table. Read after the code so the actions make sense.",
      "html": "<table><tr><th>Caller</th><th>Action</th></tr><tr><td>CLI</td><td>wrap arg in <code>new Name(...)</code></td></tr></table>"
    }
  ]
}
```
