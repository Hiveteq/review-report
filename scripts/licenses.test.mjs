// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isRecognisedText, isRestrictiveText, licenceProblems, noticeEntries, summaryLine } from './licenses.mjs';

/** @typedef {import('./licenses.mjs').Pkg} Pkg */

/**
 * @param {Partial<Pkg>} fields
 * @returns {Pkg}
 */
const pkg = (fields) => ({ name: 'a', version: '1.0.0', license: 'MIT', ...fields });

const NOTICES = '# Third-party notices\n\n## b\n\n- License: CC-BY-3.0 (https://creativecommons.org/licenses/by/3.0/)\n';

test('a permissive identifier passes and an unknown one is rejected', () => {
  assert.equal(classify('MIT'), 'permissive');
  assert.equal(classify('LGPL-3.0'), 'rejected');
  assert.equal(classify(undefined), 'rejected');
});

test('OR takes the better licence and AND the worse', () => {
  assert.equal(classify('(MIT OR GPL-3.0)'), 'permissive');
  assert.equal(classify('MIT AND CC-BY-3.0'), 'attribution');
  assert.equal(classify('MIT AND GPL-2.0'), 'rejected');
});

test('an expression mixing AND and OR is rejected for a person to read', () => {
  assert.equal(classify('MIT OR (Apache-2.0 AND GPL-2.0)'), 'rejected');
});

test('an expression that is not strictly "id (AND|OR id)*" is rejected', () => {
  for (const expression of ['Apache-2.0 WITH Commons-Clause', 'MIT and GPL-3.0', 'MIT or GPL-3.0', 'MIT GPL-3.0',
    'MIT OR', 'OR MIT', 'MIT AND OR Apache-2.0', 'AND', 'OR', '', '   ', '()']) {
    assert.equal(classify(expression), 'rejected', JSON.stringify(expression));
  }
});

test('parentheses around a valid expression are accepted', () => {
  assert.equal(classify('(MIT)'), 'permissive');
  assert.equal(classify('(Apache-2.0 OR MIT)'), 'permissive');
});

test('copyleft and source-available licence texts are recognised', () => {
  const phrases = [
    'GNU LESSER GENERAL PUBLIC LICENSE Version 3', 'GNU General Public License', 'GNU Affero General Public License',
    'Mozilla Public License Version 2.0', 'Eclipse Public License - v 2.0', 'European Union Public Licence v. 1.2',
    'COMMON DEVELOPMENT AND DISTRIBUTION LICENSE (CDDL)', 'Open Software License ("OSL") v. 3.0',
    '"Commons Clause" License Condition v1.0', 'Elastic License 2.0', 'PolyForm Noncommercial License 1.0.0',
    'Functional Source License, Version 1.1', 'Business Source License 1.1', 'Server Side Public License',
    'SONAR Source-Available License v1.0',
  ];
  for (const phrase of phrases) assert.equal(isRestrictiveText(phrase), true, phrase);
  assert.equal(isRestrictiveText('MIT License\n\nPermission is hereby granted'), false);
});

test('wrapped or double-spaced licence names still match the denylist', () => {
  for (const text of ['GNU General Public\n   License', 'Eclipse\nPublic License', 'Commons\nClause', 'Elastic  License', 'Source-\navailable']) {
    assert.equal(isRestrictiveText(text), true, JSON.stringify(text));
  }
});

test('"cc0" must be a whole word to count as wording of an allowed licence', () => {
  assert.equal(isRecognisedText('abcc0d'), false);
  assert.equal(isRecognisedText('CC0 1.0 Universal'), true);
});

test('unbalanced parentheses are rejected', () => {
  assert.equal(classify('(MIT'), 'rejected');
  assert.equal(classify('MIT) OR (ISC'), 'rejected');
  assert.equal(classify('(MIT OR ISC)'), 'permissive');
});

test('every licence file of a package must be recognised, not just one', () => {
  const problems = licenceProblems([pkg({ licenseTexts: ['Apache License', 'Do whatever you like.'] })], new Map());

  assert.deepEqual(problems, ['a@1.0.0: licence file not recognised: read it and extend the list if it is permissive']);
});

test('a licence file is recognised by the wording of an allowed licence', () => {
  const texts = [
    'MIT License\nPermission is hereby granted, free of charge, to any person',
    'Permission to use, copy, modify,\nand/or distribute this software for any purpose',
    'Apache License\nVersion 2.0, January 2004',
    'Redistribution and use in source and binary\nforms, with or without modification',
    'Blue Oak Model License',
    'CC0 1.0 Universal', 'Creative Commons Zero v1.0', 'No Copyright\n\nThe person who associated a work',
    'Creative Commons Attribution 4.0 International',
  ];
  for (const text of texts) assert.equal(isRecognisedText(text), true, text);
  assert.equal(isRecognisedText('PERMISSION IS HEREBY GRANTED,   FREE OF\nCHARGE'), true);
  assert.equal(isRecognisedText('All rights reserved. Do whatever you like.'), false);
});

test('a licence file with no known wording is reported', () => {
  const problems = licenceProblems([pkg({ licenseTexts: ['Do whatever you like.'] })], new Map());

  assert.deepEqual(problems, ['a@1.0.0: licence file not recognised: read it and extend the list if it is permissive']);
});

test('a missing licence file is not a problem but is counted in the summary', () => {
  const packages = [pkg({ installedLicense: 'MIT', licenseTexts: [] }), pkg({ installedLicense: 'MIT', licenseTexts: ['Apache License'] }), pkg({})];

  assert.deepEqual(licenceProblems(packages, new Map()), []);
  assert.equal(summaryLine(packages, 0), '3 packages checked (1 without a licence file), 0 problems.');
  assert.equal(summaryLine([pkg({}), pkg({})], 1), '2 packages checked, 1 problem.');
});

test('notice entries map each heading to its licence', () => {
  assert.deepEqual([...noticeEntries(NOTICES)], [['b', 'CC-BY-3.0']]);
});

test('a compound licence is satisfied by an entry naming the whole expression', () => {
  const notices = noticeEntries('## b\n\n- License: MIT AND CC-BY-3.0 (https://example.test)\n');

  assert.deepEqual(licenceProblems([pkg({ name: 'b', license: 'MIT AND CC-BY-3.0' })], notices), []);
});

test('a final heading with no trailing newline is still read', () => {
  assert.deepEqual([...noticeEntries('## b')], [['b', '']]);
  assert.deepEqual([...noticeEntries('## b\n- License: CC-BY-4.0')], [['b', 'CC-BY-4.0']]);
});

test('a compliant tree has no problems', () => {
  const packages = [pkg({}), pkg({ name: 'b', license: 'CC-BY-3.0' })];

  assert.deepEqual(licenceProblems(packages, noticeEntries(NOTICES)), []);
});

test('a licence outside the allowlist is reported', () => {
  const problems = licenceProblems([pkg({ license: 'GPL-3.0' })], new Map());

  assert.deepEqual(problems, ['a@1.0.0: licence "GPL-3.0" is not on the allowlist']);
});

test('a licence file that contradicts a permissive field is reported', () => {
  const problems = licenceProblems([pkg({ licenseTexts: ['SONAR Source-Available License'] })], new Map());

  assert.deepEqual(problems, ['a@1.0.0: the licence file reads as copyleft or source-available']);
});

test('an installed copy whose field differs from the lockfile is reported', () => {
  const problems = licenceProblems([pkg({ installedLicense: 'GPL-3.0' })], new Map());

  assert.deepEqual(problems, ['a@1.0.0: installed package.json says "GPL-3.0", the lockfile "MIT"']);
});

test('an attribution licence without a notice entry is reported', () => {
  const problems = licenceProblems([pkg({ name: 'b', license: 'CC-BY-3.0' })], new Map());

  assert.match(problems.join('\n'), /^b@1\.0\.0: CC-BY-3\.0 needs an entry in THIRD_PARTY_NOTICES\.md/);
});

test('a notice entry with the wrong licence is reported', () => {
  const problems = licenceProblems([pkg({ name: 'b', license: 'CC-BY-4.0' })], noticeEntries(NOTICES));

  assert.match(problems.join('\n'), /^b@1\.0\.0: CC-BY-4\.0 needs an entry/);
});

test('a notice entry no installed package needs is reported as stale', () => {
  const problems = licenceProblems([pkg({})], noticeEntries(NOTICES));

  assert.deepEqual(problems, ['THIRD_PARTY_NOTICES.md lists b, which no installed package needs credit for: remove the entry']);
});
