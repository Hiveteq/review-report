# The reader pass

The report is done when a colleague who knows the codebase as it was before the change, but has not seen
the change, can follow it without guessing. No count of notes proves that; a reader does. So after the
first clean render, run this pass and record it in the story.

## How

1. Render. Without a recorded pass the header says "Reader pass: not yet run".
2. Give a fresh subagent two things and nothing else: the rendered report (the HTML file, or the folder's
   `index.html` and chapter pages) and read-only access to the code **as it was before the change**: a
   checkout of the base commit, for example `git worktree add <tmp> <base>`. It must not see the diff, the
   story JSON, or the changed files. If the harness has no subagent tool, do the pass yourself in a fresh
   context with the same restriction.
3. Use the brief below verbatim. It asks the reader to explain every chapter back and to list each place
   where it had to guess about the change. Questions about code that already existed on the base commit do
   not count; the reader can look those up.
4. Every question becomes a note anchored at that line, or a sentence in the chapter intro, the big picture
   or the glossary, whichever answers it for everyone. Re-render.
5. Run one more fresh reader on the re-rendered report. Its questions are the pass's remaining questions:
   answer the ones that are a missing note, and put any that need a decision or more digging into the
   overview's "How to read" as open points. Set
   `meta.readerPass = { "rounds": 2, "questionsAnswered": <notes added>, "openQuestions": <left> }` and
   render again. Two rounds is the limit: a fresh reader of a long report always finds something, so a
   loop "until no questions" does not end. The header shows all three numbers.
6. Remove the temporary checkout.

A pass that comes back empty on the first round is a sign the reader was not strict; one round is then
enough only if its chapter explanations are specific, not restated titles. Never write `readerPass`
before the pass has run.

## Brief for the reader

```
You are a developer who knows this codebase as it was before the change under review. You can read the
code at <base checkout path>, which is the state before the change. You have not seen the change.
Read the walkthrough report at <report path>. Do not open the diff, the story file, or any changed file;
the report is your only view of the change.

For each chapter, write two to four sentences explaining in your own words what the change does there
and why, as if telling a colleague who also knows the old code. Where you cannot do that honestly, stop
and record a question instead.

Then list every place where you had to guess about the change. For each: the chapter, the file, the
line number shown in the report, and the question in one sentence. Typical questions: why is this new
branch here, what does this new call reach, what would break without this line, why this value, how
does this interact with <existing component>, what does this test actually protect. Do not ask about
code that already existed before the change; look it up in the base checkout instead.

Also list every dense construct in the change that a human reviewer would have to stop and decode, even
if you understood it at once: type-level tricks, non-trivial regular expressions, bit operations,
clever one-liners, unusual language features. Mark these "decode:" so they are not mistaken for gaps
in the explanation. If such a construct is a copy of code that already exists elsewhere, name where.

Report: your chapter explanations, then the question list. An empty list means you could explain every
part of the change without guessing.
```

## Why the decode list

A model reader parses dense syntax effortlessly, so it never "has to guess" at it. A human reviewer
often does. The decode list makes the pass flag what is hard for a person to read, not only what is
missing from the explanation. Each decode item gets a plain-sentence note like any other question.

## What counts as answered

A question is answered when the note gives the reason, the collaborator or the invariant, in plain
sentences. "Sets the flag" does not answer "why is this flag set here"; "Set before the file is opened, so a
second call returns early instead of reading the file twice" does.
