// Playwright globalSetup: renders every report the browser tests open, into a fresh folder under the
// system temp directory. All inputs are made up: the demo Greeter fixture from the unit tests, variants
// of it, and a generated long file for scrolling.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPORTS } from './reports.mjs';

const skill = new URL('../skills/review-report/', import.meta.url);
const read = (name) => readFileSync(new URL(`test/${name}`, skill), 'utf8');

function render(story, diff, out, layout) {
  const dir = join(REPORTS, 'input');
  const base = join(dir, out.replace(/\W+/g, '-'));
  writeFileSync(`${base}.story.json`, JSON.stringify(story));
  writeFileSync(`${base}.diff`, diff);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('render.mjs', skill)),
    '--story', `${base}.story.json`, '--diff-file', `${base}.diff`, layout, '--out', join(REPORTS, out)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`render ${out} failed:\n${r.stderr}`);
}

// A modified file whose 20 replaced lines take 40 rows unified but 20 split, so a layout switch moves
// everything below it. Then a new 400-line file with notes spread through it, long enough that its header
// must stick while its body scrolls past. Then a short file that comes up when the long one is ticked.
function longChange() {
  const settings = Array.from({ length: 20 }, (_, i) => `    static final int SETTING_${i + 1} = ${i + 1};`);
  const config = 'diff --git a/src/Config.java b/src/Config.java\nindex 7654321..1234567 100644\n' +
    '--- a/src/Config.java\n+++ b/src/Config.java\n@@ -1,22 +1,22 @@\n' +
    [' package demo;', ' final class Config {', ...settings.map((l) => `-${l}`), ...settings.map((l) => `+${l.replace('= ', '= 10 * ')}`)]
      .join('\n') + '\n';
  const entries = Array.from({ length: 397 }, (_, i) => `    static final int ENTRY_${i + 1} = ${i + 1};`);
  const body = ['package demo;', 'final class Catalog {', ...entries, '}'];
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

// The demo story with every diagram shape the skill asks for on one page: the marked flowchart it
// already has, a before/after pair, a state machine, a sequence and an entity diagram.
function diagramsStory(story) {
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
  return s;
}

export default function renderReports() {
  rmSync(REPORTS, { recursive: true, force: true });
  mkdirSync(join(REPORTS, 'input'), { recursive: true });
  const story = JSON.parse(read('fixture.story.json'));
  const diff = read('fixture.diff');

  render(story, diff, 'single.html', '--single');
  render(story, diff, 'paged.html', '--pages');
  // Same title, one file's diff changed: a re-render after the branch moved.
  const moved = diff.replace('+        return "Hello " + name.value();', '+        return "Hi " + name.value();');
  if (moved === diff) throw new Error('re-render variant: Greeter line not found in fixture.diff');
  render(story, moved, 'rerendered.html', '--single');
  // Same diff, another title: a different report open in parallel.
  render({ ...story, meta: { ...story.meta, title: 'Another report' } }, diff, 'other.html', '--single');
  render(diagramsStory(story), diff, 'diagrams.html', '--single');
  const long = longChange();
  render(long.story, long.diff, 'long.html', '--single');
}
