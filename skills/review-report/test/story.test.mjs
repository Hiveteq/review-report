import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDiff } from '../lib/diff.mjs';
import { validateStory, buildReport } from '../lib/story.mjs';

const OV = { bigPicture: 'a\n```mermaid\nflowchart LR\nA-->B\n```', why: 'b', approach: 'c', howToRead: 'd' };
const files = parseDiff(readFileSync(new URL('./fixture.diff', import.meta.url), 'utf8'));
const story = () => JSON.parse(readFileSync(new URL('./fixture.story.json', import.meta.url), 'utf8'));

test('fixture story is valid', () => {
  assert.deepEqual(validateStory(story()), []);
});

test('validation reports every missing required field with its path', () => {
  const errors = validateStory({
    meta: { readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } },
    overview: {},
    chapters: [
      { title: '', intro: '', hunks: [{ file: '', lines: [5, 2], comments: [{ line: 'x', side: 'left', text: '' }] }], html: '<p/>' },
    ],
  });
  for (const expected of [
    'meta.title is required',
    'overview.bigPicture is required',
    'chapters[0].title is required',
    'chapters[0].intro is required',
    'chapters[0] must have exactly one of hunks or html',
    'chapters[0].hunks[0].file is required',
    'chapters[0].hunks[0].lines must be "all" or [start, end] integers with start <= end',
    'chapters[0].hunks[0].comments[0].line must be an integer',
    'chapters[0].hunks[0].comments[0].side must be "old" or "new"',
    'chapters[0].hunks[0].comments[0].text is required',
  ]) assert.ok(errors.includes(expected), `missing: ${expected}\nGot: ${errors.join('\n')}`);
});

test('empty chapters is an error', () => {
  assert.ok(validateStory({ meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, chapters: [] }).includes('chapters must be a non-empty array'));
});

test('selects hunks overlapping the new-side range and defaults comment side to new', () => {
  const report = buildReport(story(), files);
  assert.deepEqual(report.errors, []);
  const greeter = report.chapters[1].hunks[0];
  assert.equal(greeter.file.path, 'src/Greeter.java');
  assert.equal(greeter.hunks.length, 1);
  assert.deepEqual(greeter.comments.map((c) => [c.line, c.side]), [[4, 'new'], [5, 'old']]);
});

test('"all" selects every hunk, including pure deletions', () => {
  const report = buildReport(story(), files);
  assert.equal(report.chapters[0].hunks[0].hunks.length, 1);
  assert.equal(report.chapters[2].hunks[0].file.status, 'deleted');
  assert.equal(report.chapters[2].hunks[0].hunks.length, 1);
});

test('unreferenced hunks land in the appendix, referenced ones do not', () => {
  const report = buildReport(story(), files);
  const paths = report.appendix.map((e) => [e.file.path, e.hunks.length]);
  assert.deepEqual(paths, [['README.md', 1], ['docs/new näme.md', 1], ['img/logo.png', 0], ['img/photo.jpg', 0], ['scripts/run.sh', 0], ['docs/renamed.md', 0]]);
  assert.equal(report.appendix[0].hunks[0].newStart, 1);
});

test('html chapters pass through', () => {
  const report = buildReport(story(), files);
  assert.equal(report.chapters[4].kind, 'html');
  assert.match(report.chapters[4].html, /<table>/);
});

test('bad references produce named errors instead of throwing', () => {
  const s = story();
  s.chapters = [
    { title: 'a', intro: 'i', hunks: [{ file: 'src/Missing.java', lines: 'all' }] },
    { title: 'b', intro: 'i', hunks: [{ file: 'src/Greeter.java', lines: [400, 410] }] },
    { title: 'c', intro: 'i', hunks: [{ file: 'src/Greeter.java', lines: 'all', comments: [{ line: 99, text: 'x' }, { line: 4, side: 'old', text: 'ok: old 4 exists' }] }] },
  ];
  const report = buildReport(s, files);
  assert.deepEqual(report.errors, [
    'chapters[0].hunks[0]: file not in diff: src/Missing.java',
    'chapters[1].hunks[0]: no hunk in src/Greeter.java overlaps new-side lines 400-410',
    'chapters[2].hunks[0].comments[0]: new line 99 is not in the selected hunks of src/Greeter.java',
  ]);
});

test('intro must have at least two sentences', () => {
  const one = validateStory({ meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, chapters: [{ title: 'x', intro: 'Only one sentence here.', hunks: [] }] });
  assert.ok(one.includes('chapters[0].intro must have at least two sentences: what this chapter shows, and why it follows the previous one'), one.join('\n'));
  const two = validateStory({ meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, chapters: [{ title: 'x', intro: 'Shows `render.ts`. It follows because the flag needs a consumer!', hunks: [] }] });
  assert.ok(!two.some((e) => e.includes('two sentences')), two.join('\n'));
});

test('glossary is optional (new terms only), but each entry needs term and meaning', () => {
  const none = validateStory({ meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, chapters: [{ title: 'x', intro: 'One. Two.', hunks: [] }] });
  assert.ok(!none.some((e) => e.startsWith('glossary')), none.join('\n'));
  const bad = validateStory({ meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, glossary: [{ term: 'X' }], chapters: [{ title: 'x', intro: 'One. Two.', hunks: [] }] });
  assert.ok(bad.includes('glossary[0].meaning is required'), bad.join('\n'));
});

test('a non-array where a list is expected is reported, not thrown', () => {
  const errors = validateStory({
    meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, glossary: [{ term: 'a', meaning: 'b' }], diagrams: { mermaid: 'x' },
    chapters: [
      { title: 'x', intro: 'One. Two.', hunks: { file: 'f', lines: 'all' } },
      { title: 'y', intro: 'One. Two.', hunks: [{ file: 'f', lines: 'all', comments: { line: 1, text: 't' } }] },
    ],
  });
  for (const expected of [
    'diagrams is no longer a story field: put ```mermaid fences inside overview parts or chapter intros',
    'chapters[0].hunks must be an array',
    'chapters[0] must have exactly one of hunks or html',
    'chapters[1].hunks[0].comments must be an array',
  ]) assert.ok(errors.includes(expected), `missing: ${expected}\nGot: ${errors.join('\n')}`);
});

test('sentence counting understands other scripts and abbreviations', () => {
  const withIntro = (intro) => validateStory({ meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, overview: OV, glossary: [{ term: 'a', meaning: 'b' }], chapters: [{ title: 'x', intro, hunks: [] }] });
  const japanese = withIntro('この章では新しい型を示します。次の章はこの型を使う呼び出し元です。');
  assert.ok(!japanese.some((e) => e.includes('two sentences')), japanese.join('\n'));
  const noFinalPeriod = withIntro('The parser comes first. See the v2.0 notes for why');
  assert.ok(!noFinalPeriod.some((e) => e.includes('two sentences')), noFinalPeriod.join('\n'));
  const abbreviation = withIntro('Adds the flag the CLI needs, e.g. the dry-run path.');
  assert.ok(abbreviation.some((e) => e.includes('two sentences')), abbreviation.join('\n'));
});

test('overview must be an object with the four big-picture parts', () => {
  const base = { meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, chapters: [{ title: 'x', intro: 'One. Two.', hunks: [] }] };
  const asString = validateStory({ ...base, overview: 'just a string' });
  assert.ok(asString.includes('overview must be an object with bigPicture, why, approach and howToRead'), asString.join('\n'));
  const missing = validateStory({ ...base, overview: { bigPicture: 'x', why: '' } });
  for (const e of ['overview.why is required', 'overview.approach is required', 'overview.howToRead is required']) {
    assert.ok(missing.includes(e), `${e}\n${missing.join('\n')}`);
  }
  const ok = validateStory({ ...base, overview: OV });
  assert.ok(!ok.some((e) => e.startsWith('overview')), ok.join('\n'));
});

test('overview must contain at least one mermaid diagram; a top-level diagrams array is rejected', () => {
  const base = { meta: { title: 't', readerPass: { rounds: 1, questionsAnswered: 0, openQuestions: 0 } }, glossary: [{ term: 'a', meaning: 'b' }], chapters: [{ title: 'x', intro: 'One. Two.', hunks: [] }] };
  const none = validateStory({ ...base, overview: { ...OV, bigPicture: 'plain text' } });
  assert.ok(none.includes('overview needs at least one ```mermaid diagram inside bigPicture or approach'), none.join('\n'));
  const withDiagram = validateStory({ ...base, overview: { ...OV, approach: 'Text.\n```mermaid\nflowchart LR\nA-->B\n```' } });
  assert.ok(!withDiagram.some((e) => e.startsWith('overview')), withDiagram.join('\n'));
  const legacy = validateStory({ ...base, overview: OV, diagrams: [{ mermaid: 'x' }] });
  assert.ok(legacy.includes('diagrams is no longer a story field: put ```mermaid fences inside overview parts or chapter intros'), legacy.join('\n'));
});

test('exclude entries need glob and reason', () => {
  const s = story();
  s.exclude = [{ glob: 'x/**' }, { reason: 'no glob' }, 'string'];
  const errors = validateStory(s);
  for (const e of ['exclude[0].reason is required', 'exclude[1].glob is required', 'exclude[2] must be { glob, reason }']) {
    assert.ok(errors.includes(e), `${e}\n${errors.join('\n')}`);
  }
});

test('readerPass records rounds, questions answered and questions still open', () => {
  const s = story();
  delete s.meta.readerPass;
  assert.ok(!validateStory(s).some((e) => e.includes('readerPass')), 'absence is reported at render time, not a shape error');
  s.meta.readerPass = { rounds: 0, questionsAnswered: 0, openQuestions: 0 };
  assert.ok(validateStory(s).includes('meta.readerPass.rounds must be at least 1'));
  s.meta.readerPass = { rounds: 2, questionsAnswered: 'many', openQuestions: -1 };
  const errors = validateStory(s);
  assert.ok(errors.includes('meta.readerPass.questionsAnswered must be a non-negative integer'), errors.join('\n'));
  assert.ok(errors.includes('meta.readerPass.openQuestions must be a non-negative integer'), errors.join('\n'));
  s.meta.readerPass = { rounds: 2, questionsAnswered: 41, openQuestions: 3 };
  assert.ok(!validateStory(s).some((e) => e.includes('readerPass')));
});

test('slice shows only the given new-side range of a hunk; the rest stays in the appendix', () => {
  const s = story();
  // Name.java is a new file: one hunk, lines 1-3. Show only line 3 in chapter 1.
  s.chapters[0].hunks[0] = { file: 'src/Name.java', lines: [3, 3], slice: true, comments: [{ line: 3, text: 'The record.' }] };
  const report = buildReport(s, files);
  assert.deepEqual(report.errors, []);
  const sel = report.chapters[0].hunks[0];
  assert.deepEqual(sel.hunks[0].lines.map((l) => l.new), [3]);
  assert.equal(sel.hunks[0].newStart, 3);
  const rest = report.appendix.find((e) => e.file.path === 'src/Name.java');
  assert.ok(rest, 'unshown lines of a sliced hunk go to the appendix');
  assert.deepEqual(rest.hunks[0].lines.map((l) => l.new), [1, 2]);
});

test('two slices of one new file in two chapters cover it completely', () => {
  const s = story();
  s.chapters[0].hunks[0] = { file: 'src/Name.java', lines: [1, 2], slice: true };
  s.chapters[2].hunks.push({ file: 'src/Name.java', lines: [3, 3], slice: true });
  const report = buildReport(s, files);
  assert.deepEqual(report.errors, []);
  assert.ok(!report.appendix.some((e) => e.file.path === 'src/Name.java'));
});

test('a slice keeps deleted lines that sit inside its range', () => {
  const s = story();
  // Greeter: old 4-5 deleted, new 4-5 added. A slice of new 4-5 carries the two deletions before them.
  s.chapters[1].hunks[0] = { file: 'src/Greeter.java', lines: [4, 5], slice: true, comments: [{ line: 5, side: 'old', text: 'old' }] };
  const report = buildReport(s, files);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.chapters[1].hunks[0].hunks[0].lines.map((l) => [l.type, l.old, l.new]), [
    ['del', 4, null], ['del', 5, null], ['add', null, 4], ['add', null, 5],
  ]);
});

test('slice needs a line range, not "all"', () => {
  const s = story();
  s.chapters[0].hunks[0] = { file: 'src/Name.java', lines: 'all', slice: true };
  assert.ok(validateStory(s).includes('chapters[0].hunks[0].slice needs lines as [start, end]'));
});

test('tests must be an array of globs and covers must be text', () => {
  const s = story();
  s.tests = 'src/**';
  s.chapters[0].hunks[0].covers = 42;
  const errors = validateStory(s);
  assert.ok(errors.includes('tests must be an array of globs for this project\'s test files'), errors.join('\n'));
  assert.ok(errors.includes('chapters[0].hunks[0].covers must be text'), errors.join('\n'));
});

test('covers is carried onto the selected hunk', () => {
  const s = story();
  s.chapters[0].hunks[0].covers = 'Pins the record shape.';
  assert.equal(buildReport(s, files).chapters[0].hunks[0].covers, 'Pins the record shape.');
});

test('a note naming code that sits on the next line gets a warning with the likely line', () => {
  const s = story();
  // Name.java line 3 is the record; anchoring the note on line 2 (blank) is the classic off-by-one.
  s.chapters[0].hunks[0].comments = [{ line: 2, text: 'A Java `record` gives `equals` and the `value()` accessor.' }];
  const report = buildReport(s, files);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, [
    'chapters[0].hunks[0].comments[0]: src/Name.java new line 2 does not contain `record`, `value`; new line 3 does. Move the note if it is about that line.',
  ]);
});

test('no warning when the named code is on the anchored line, or nowhere nearby', () => {
  const s = story();
  s.chapters[0].hunks[0].comments = [
    { line: 3, text: 'A Java `record`.' },
    { line: 1, text: 'Mentions `SomethingElse` that is not in this file.' },
    { line: 1, text: 'No code named at all.' },
  ];
  assert.deepEqual(buildReport(s, files).warnings, []);
});

test('old-side notes are checked against old-side lines', () => {
  const s = story();
  // Greeter old 4 is the old signature, old 5 the concatenation. A note about `concat`-free text but naming `Hello` belongs on old 5.
  s.chapters[1].hunks[0].comments = [{ line: 4, side: 'old', text: 'The deleted `"Hello "` concatenation.' }];
  const w = buildReport(s, files).warnings;
  assert.equal(w.length, 1);
  assert.match(w[0], /old line 4 does not contain `Hello`; old line 5 does/);
});
