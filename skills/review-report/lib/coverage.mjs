// Coverage: how much of the change the chapters actually explain.
// The tool counts; the story classifies. Only exclusions that are universal
// by nature are built in (binaries, lockfiles, minified/source-map files,
// generated/vendored/build output paths). Everything else counts unless the
// story excludes it with a glob and a reason, and those reasons are shown in
// the report so the reviewer can judge them.

export const DEFAULT_EXCLUDES = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/Cargo.lock', '**/go.sum', '**/composer.lock',
  '**/Gemfile.lock', '**/poetry.lock', '**/Pipfile.lock', '**/*.lock',
  '**/*.min.*', '**/*.map',
  '**/generated/**', '**/__generated__/**', '**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**',
  '**/.openapi-generator/**',
];
const DEFAULT_REASON = 'lockfile, generated, vendored or build output';

// Minimal glob: `**/` matches zero or more directories, `**` anything, `*` within a segment, `?` one char.
export function matchGlob(glob, path) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

const changedIn = (hunk) => hunk.lines.filter((l) => l.type !== 'ctx').length;

export function computeCoverage(story, files, report) {
  const storyExcludes = Array.isArray(story?.exclude) ? story.exclude.filter((e) => e && typeof e.glob === 'string') : [];
  const matched = new Set();
  const shown = new Set(); // line objects shown in chapters; slices make this finer than hunks
  for (const ch of report.chapters) {
    if (ch.kind !== 'diff') continue;
    for (const sel of ch.hunks) for (const h of sel.hunks) for (const l of h.lines) shown.add(l);
  }

  const counted = [];
  const excluded = [];
  for (const file of files) {
    const changed = file.hunks.reduce((n, h) => n + changedIn(h), 0);
    if (changed === 0 && !file.binary) continue; // mode-only changes and pure renames have nothing to explain
    const rule = storyExcludes.find((e) => matchGlob(e.glob, file.path));
    if (rule) { matched.add(rule.glob); excluded.push({ path: file.path, reason: rule.reason }); continue; }
    if (file.binary) { excluded.push({ path: file.path, reason: 'binary' }); continue; }
    if (DEFAULT_EXCLUDES.some((g) => matchGlob(g, file.path))) { excluded.push({ path: file.path, reason: DEFAULT_REASON }); continue; }
    const explained = file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type !== 'ctx' && shown.has(l)).length, 0);
    const adds = file.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').length;
    counted.push({ path: file.path, changed, explained, missing: changed - explained, adds, dels: changed - adds });
  }

  const total = counted.reduce((n, f) => n + f.changed, 0);
  const explained = counted.reduce((n, f) => n + f.explained, 0);
  const uncovered = counted.filter((f) => f.missing > 0).sort((a, b) => b.missing - a.missing)
    .map(({ path, changed, explained, missing }) => ({ path, changed, explained, missing }));

  // Changed lines per chapter, so the CLI can refuse a chapter too long to read as one page.
  const chapterSizes = report.chapters.map((ch, i) => ({
    index: i, title: ch.title,
    changed: ch.kind === 'diff' ? ch.hunks.reduce((n, sel) => n + sel.hunks.reduce((m, h) => m + changedIn(h), 0), 0) : 0,
  }));

  return {
    total, explained, ratio: total === 0 ? 1 : explained / total,
    counted, uncovered, excluded, chapterSizes,
    unmatched: storyExcludes.map((e) => e.glob).filter((g) => !matched.has(g)),
  };
}

// "a (reason), b, c (other reason)": consecutive files sharing a reason are grouped.
export function describeExcluded(excluded) {
  const out = [];
  for (let i = 0; i < excluded.length; i++) {
    const names = [excluded[i].path];
    while (i + 1 < excluded.length && excluded[i + 1].reason === excluded[i].reason) names.push(excluded[++i].path);
    out.push(`${names.join(', ')} (${excluded[i].reason})`);
  }
  return out.join(', ');
}
