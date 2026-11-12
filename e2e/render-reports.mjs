// @ts-check
// Renders every report the browser tests open, into the fresh folder globalSetup makes for the run.
// All inputs are made up: the demo Greeter fixture from the unit tests, variants of it, and generated
// diffs for scrolling and for file paths that are also names of built-in object properties.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** @typedef {import('../skills/review-report/lib/story.mjs').Story} Story */

const skill = new URL('../skills/review-report/', import.meta.url);
/**
 * @param {string} name
 * @returns {string}
 */
const read = (name) => readFileSync(new URL(`test/${name}`, skill), 'utf8');

/**
 * @param {string} dir the reports folder
 * @param {{ story: Story, diff: string, out: string, layout: '--single' | '--pages' }} report
 *   `out` is the file name under `dir`
 */
function render(dir, { story, diff, out, layout }) {
  const base = join(dir, 'input', out.replace(/\W+/g, '-'));
  writeFileSync(`${base}.story.json`, JSON.stringify(story));
  writeFileSync(`${base}.diff`, diff);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('render.mjs', skill)),
    '--story', `${base}.story.json`, '--diff-file', `${base}.diff`, layout, '--out', join(dir, out)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`render ${out} failed:\n${r.stderr}`);
}

/**
 * A modified file whose 20 replaced lines take 40 rows unified but 20 split, so a layout switch moves
 * everything below it. Then a new 400-line file with notes spread through it, long enough that its header
 * must stick while its body scrolls past. Then a short file that comes up when the long one is ticked.
 * @returns {{ story: Story, diff: string }}
 */
function longChange() {
  const settings = Array.from({ length: 20 }, (_, i) => `    static final int SETTING_${i + 1} = ${i + 1};`);
  const configRows = [' package demo;', ' final class Config {', ...settings.map((l) => `-${l}`), ...settings.map((l) => `+${l.replace('= ', '= 10 * ')}`)];
  const config = `diff --git a/src/Config.java b/src/Config.java\nindex 7654321..1234567 100644\n--- a/src/Config.java\n+++ b/src/Config.java\n@@ -1,22 +1,22 @@\n${configRows.join('\n')}\n`;
  const entries = Array.from({ length: 397 }, (_, i) => `    static final int ENTRY_${i + 1} = ${i + 1};`);
  const body = ['package demo;', 'final class Catalog {', ...entries, '}'];
  /**
   * @param {string} path
   * @param {string[]} rows
   * @returns {string}
   */
  const file = (path, rows) => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n` +
    `+++ b/${path}\n@@ -0,0 +1,${rows.length} @@\n${rows.map((l) => `+${l}`).join('\n')}\n`;
  const diff = config + file('src/Catalog.java', body) + file('src/Next.java', ['package demo;', 'final class Next {}']);
  const story = JSON.parse(read('fixture.story.json'));
  story.meta = { ...story.meta, title: 'Long catalog for scrolling' };
  story.chapters = [{
    title: '1. A long new file',
    intro: 'A short modified file, then a long new one. A short new file follows, so ticking the long one brings it up.',
    hunks: [
      { file: 'src/Config.java', lines: 'all' },
      { file: 'src/Catalog.java', lines: 'all', comments: [50, 200, 350].map((line) => ({ line, text: `Note on line ${line}.` })) },
      { file: 'src/Next.java', lines: 'all' },
    ],
  }];
  story.exclude = [];
  return { story, diff };
}

/**
 * Two new files named `constructor` and `__proto__`, shown in one chapter, and code fences tagged
 * `constructor` and `toString`. Every plain object already answers to those names through its
 * prototype, so a page that keeps ticks or known languages in an object must not take them for
 * ticked files or for languages it can highlight.
 * @returns {{ story: Story, diff: string }}
 */
function prototypeNames() {
  const paths = ['constructor', '__proto__'];
  const diff = paths.map((path) => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n` +
    `+++ b/${path}\n@@ -0,0 +1,2 @@\n+first line of ${path}\n+second line of ${path}\n`).join('');
  const story = JSON.parse(read('fixture.story.json'));
  story.meta = { ...story.meta, title: 'Files named like object properties' };
  story.chapters = [{
    title: '1. Two oddly named files',
    intro: ['Both names are also properties every object inherits. The page counts them as files like any other.',
      '```constructor\nnot a language highlight.js knows\n```', '```toString\nnor is this one\n```'].join('\n\n'),
    hunks: paths.map((file) => ({ file, lines: 'all' })),
  }];
  story.exclude = [];
  return { story, diff };
}

/**
 * The demo story with every diagram shape the skill asks for on one page: the marked flowchart it
 * already has, a before/after pair, a state machine, a sequence, an entity diagram, and a flow too
 * wide for the column.
 * @param {Story} story
 * @returns {Story}
 */
function diagramsStory(story) {
  /**
   * @param {string} body
   * @returns {string}
   */
  const fence = (body) => `\n\n\`\`\`mermaid\n${body}\n\`\`\``;
  const s = structuredClone(story);
  s.meta = { ...s.meta, title: 'Every diagram shape' };
  s.overview.approach += fence([
    'flowchart LR',
    '  subgraph before["Before (base)"]',
    '    direction TB',
    '    A1[Request] --> D1[(Database)]',
    '  end',
    '  subgraph after["After (this change)"]',
    '    direction TB',
    '    A2[Request] --> C2{Cache hit?}',
    '    C2 -->|no| D2[(Database)]',
    '    C2 -->|yes| R2[Cached reply]',
    '  end',
    '  before ~~~ after',
    '  classDef new fill:#dafbe1,stroke:#1a7f37',
    '  class C2,R2 new',
  ].join('\n'));
  s.chapters[0].intro += fence('stateDiagram-v2\n  [*] --> Raw\n  Raw --> Valid: Name.of()\n  Raw --> Rejected: blank\n  Valid --> [*]');
  s.chapters[1].intro += fence('sequenceDiagram\n  Caller->>Greeter: greet(name)\n  Greeter->>Name: value()\n  Greeter-->>Caller: "Hello Ada"');
  s.chapters[2].intro += fence('erDiagram\n  AUTHOR ||--o{ BOOK : writes\n  BOOK { string isbn PK }');
  const stages = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  s.chapters[3].intro += fence(`flowchart LR\n  ${stages.map((n) => `${n}[Stage ${n} of the pipeline]`).join(' --> ')}`);
  return s;
}

/**
 * Renders every report into `dir`, emptied first.
 * @param {string} dir
 */
export function renderReports(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'input'), { recursive: true });
  /** @type {Story} */
  const story = JSON.parse(read('fixture.story.json'));
  const diff = read('fixture.diff');

  render(dir, { story, diff, out: 'single.html', layout: '--single' });
  render(dir, { story, diff, out: 'paged.html', layout: '--pages' });
  // Same title, one file's diff changed: a re-render after the branch moved.
  const moved = diff.replace('+        return "Hello " + name.value();', '+        return "Hi " + name.value();');
  if (moved === diff) throw new Error('re-render variant: Greeter line not found in fixture.diff');
  render(dir, { story, diff: moved, out: 'rerendered.html', layout: '--single' });
  // Same diff, another title: a different report open in parallel.
  render(dir, { story: { ...story, meta: { ...story.meta, title: 'Another report' } }, diff, out: 'other.html', layout: '--single' });
  render(dir, { story: diagramsStory(story), diff, out: 'diagrams.html', layout: '--single' });
  render(dir, { ...longChange(), out: 'long.html', layout: '--single' });
  render(dir, { ...prototypeNames(), out: 'prototype-names.html', layout: '--single' });
}
