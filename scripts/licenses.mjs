// @ts-check
// Licence policy for every package in package-lock.json, dev tools included: permissive licences only, checked in
// both places a licence is stated (the package.json field and the licence file), and attribution honoured for the
// licences that ask for it. A package with no licence file is accepted on its package.json field and counted in the
// summary. Pure functions; scripts/check-licenses.mjs does the reading and printing.

/** Licences that ask nothing beyond keeping their notice in copies of the package itself. */
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0']);

/** Licences that are permissive but ask for credit: each such package needs an entry in THIRD_PARTY_NOTICES.md. */
const ATTRIBUTION = new Set(['CC-BY-3.0', 'CC-BY-4.0']);

/** Names that only appear in copyleft or source-available licence texts. */
const RESTRICTIVE_TEXT = new RegExp([
  'general public licen[cs]e', // also matches the Lesser and Affero variants
  'mozilla public', 'eclipse public', 'european union public', 'common development and distribution',
  'open software licen[cs]e', 'commons clause', 'elastic licen[cs]e', 'polyform', 'functional source licen[cs]e',
  'business source', 'server side public', 'source[- ]available',
].join('|'));

/**
 * Wording that identifies each allowed licence. A licence file must contain at least one, so a text nobody has
 * read (a custom or unusual licence) is flagged instead of passing because it avoids the denylist.
 */
const FINGERPRINTS = [
  /permission is hereby granted, free of charge/, // MIT
  /permission to use, copy, modify, and\/or distribute this software/, // ISC, 0BSD
  /apache license/,
  /redistribution and use in source and binary forms/, // BSD-2-Clause, BSD-3-Clause
  /blue oak model license/,
  /\bcc0\b|creative commons zero|no copyright/,
  /creative commons attribution/,
];

/** @typedef {'permissive' | 'attribution' | 'rejected'} Verdict */

/** @type {Verdict[]} Verdicts from best to worst. */
const ORDER = ['permissive', 'attribution', 'rejected'];

/** SPDX operators, case-sensitive. `WITH` (exceptions) is deliberately absent: it needs a person to read it. */
const OPERATORS = new Set(['AND', 'OR']);

/**
 * Classifies an SPDX expression of the form `id (AND|OR id)*`, optionally wrapped in parentheses. `A OR B` takes the
 * better side (we may choose either licence); `A AND B` takes the worse (both apply). Mixing AND with OR, `WITH`,
 * lowercase operators, adjacent identifiers, stray operators, an empty string and unknown identifiers are all rejected.
 * @param {string | undefined} expression
 * @returns {Verdict}
 */
export function classify(expression) {
  if (!balanced(expression ?? '')) return 'rejected';
  const tokens = (expression ?? '').split(/[\s()]+/).filter(Boolean);
  const alternates = tokens.length % 2 === 1 && tokens.every((token, i) => OPERATORS.has(token) === (i % 2 === 1));
  if (!alternates) return 'rejected';
  const operators = new Set(tokens.filter((_, i) => i % 2 === 1));
  if (operators.size > 1) return 'rejected'; // mixed precedence: read it by hand
  const ranks = tokens.filter((_, i) => i % 2 === 0).map((id) => ORDER.indexOf(classifyId(id)));
  return ORDER[operators.has('AND') ? Math.max(...ranks) : Math.min(...ranks)];
}

/**
 * @param {string} text
 * @returns {boolean} true when every `)` closes an earlier `(` and none stay open
 */
function balanced(text) {
  let depth = 0;
  for (const char of text) { // early exit on a stray `)` that a fold cannot express
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * @param {string} id one SPDX licence identifier
 * @returns {Verdict}
 */
function classifyId(id) {
  if (PERMISSIVE.has(id)) return 'permissive';
  if (ATTRIBUTION.has(id)) return 'attribution';
  return 'rejected';
}

/**
 * True when a licence file's text names a copyleft or source-available licence, whatever the package.json field says.
 * @param {string} text the licence file
 * @returns {boolean}
 */
export function isRestrictiveText(text) {
  return RESTRICTIVE_TEXT.test(normalise(text));
}

/**
 * True when a licence file contains the wording of at least one allowed licence. Case and line wrapping are ignored,
 * because the same licence is wrapped differently from package to package.
 * @param {string} text the licence file
 * @returns {boolean}
 */
export function isRecognisedText(text) {
  const normalised = normalise(text);
  return FINGERPRINTS.some((fingerprint) => fingerprint.test(normalised));
}

/**
 * Lowercases and collapses whitespace: the same licence is wrapped and spaced differently from package to package.
 * @param {string} text
 * @returns {string}
 */
function normalise(text) {
  return text.toLowerCase().replace(/-\s*\n\s*/g, '-').replace(/\s+/g, ' '); // a hyphen at a line end joins the word
}

/**
 * Reads the notices file: each `## <package>` heading followed by a `- License: <expression>` line. The expression
 * ends at ` (` (a link) or the end of the line, so compound ones such as `MIT AND CC-BY-3.0` work.
 * @param {string} markdown
 * @returns {Map<string, string>} package name → licence identifier
 */
export function noticeEntries(markdown) {
  const sections = markdown.split(/^## /m).slice(1);
  return new Map(sections.map((section) => {
    const [heading] = section.split('\n');
    return [heading.trim(), /^- License: (.+?)(?: \(|$)/m.exec(section)?.[1].trim() ?? ''];
  }));
}

/**
 * @typedef {object} Pkg
 * @property {string} name
 * @property {string} version
 * @property {string} [license] the package.json field, as recorded in the lockfile
 * @property {string} [installedLicense] the package.json field of the installed copy, when installed
 * @property {string[]} [licenseTexts] the full text of each installed licence file; empty when the package has none
 */

/**
 * Every policy problem, one line each. Empty means the tree complies.
 * @param {Pkg[]} packages
 * @param {Map<string, string>} notices from noticeEntries
 * @returns {string[]}
 */
export function licenceProblems(packages, notices) {
  const needCredit = packages.filter((p) => classify(p.license) === 'attribution');
  return [
    ...packages.flatMap(packageProblems),
    ...needCredit.filter((p) => notices.get(p.name) !== p.license)
      .map((p) => `${p.name}@${p.version}: ${p.license} needs an entry in THIRD_PARTY_NOTICES.md ("## ${p.name}", "- License: ${p.license}")`),
    ...[...notices.keys()].filter((name) => !needCredit.some((p) => p.name === name))
      .map((name) => `THIRD_PARTY_NOTICES.md lists ${name}, which no installed package needs credit for: remove the entry`),
  ];
}

/** @type {[(p: Pkg) => boolean, (p: Pkg) => string][]} Each rule: when it applies, and what to print. */
const PACKAGE_RULES = [
  [(p) => classify(p.license) === 'rejected', (p) => `licence "${p.license ?? 'none'}" is not on the allowlist`],
  [(p) => p.installedLicense !== undefined && p.installedLicense !== p.license,
    (p) => `installed package.json says "${p.installedLicense}", the lockfile "${p.license}"`],
  [(p) => (p.licenseTexts ?? []).some(isRestrictiveText), () => 'the licence file reads as copyleft or source-available'],
  // Restrictive files are already reported above, so only the rest need to be recognised.
  [(p) => (p.licenseTexts ?? []).some((text) => !isRestrictiveText(text) && !isRecognisedText(text)),
    () => 'licence file not recognised: read it and extend the list if it is permissive'],
];

/**
 * @param {Pkg} p
 * @returns {string[]}
 */
function packageProblems(p) {
  return PACKAGE_RULES.filter(([applies]) => applies(p)).map(([, message]) => `${p.name}@${p.version}: ${message(p)}`);
}

/**
 * The line the check prints last. A package without a licence file is accepted (its package.json field still
 * applies), but the count shows how much rests on that field alone.
 * @param {Pkg[]} packages
 * @param {number} problemCount
 * @returns {string}
 */
export function summaryLine(packages, problemCount) {
  const withoutFile = packages.filter((p) => p.licenseTexts?.length === 0).length;
  const note = withoutFile ? ` (${withoutFile} without a licence file)` : '';
  return `${packages.length} packages checked${note}, ${problemCount} problem${problemCount === 1 ? '' : 's'}.`;
}
