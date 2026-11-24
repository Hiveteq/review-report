// @ts-check
// Checks every package in package-lock.json against the licence policy in scripts/licenses.mjs and prints each
// problem. Run after `npm ci`: the licence files are read from node_modules. A package with no licence file is
// accepted on its package.json field and counted in the summary line.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenceProblems, noticeEntries, summaryLine } from './licenses.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** @typedef {import('./licenses.mjs').Pkg} Pkg */

/**
 * Every licence file of a package, in full, so each one is checked on its own.
 * @param {string} dir installed package directory
 * @returns {string[]} one text per file; empty when the package has none
 */
function licenceTexts(dir) {
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying)/i.test(f)).sort();
  return files.map((f) => readFileSync(join(dir, f), 'utf8'));
}

/**
 * @param {string} path lockfile key, such as node_modules/a/node_modules/@scope/b
 * @param {{ version: string, license?: string, link?: boolean }} entry
 * @returns {Pkg}
 */
function readPackage(path, entry) {
  const dir = join(root, path);
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const installed = existsSync(join(dir, 'package.json'));
  return {
    name,
    version: entry.version,
    license: entry.license,
    installedLicense: installed ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).license ?? '' : undefined,
    licenseTexts: installed ? licenceTexts(dir) : undefined,
  };
}

if (!existsSync(join(root, 'node_modules'))) {
  console.error('node_modules is missing: run npm ci first.');
  process.exit(2);
}
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
// A link's target has its own key in the lockfile and is checked there.
/** @type {[string, { version: string, license?: string, link?: boolean }][]} */
const entries = Object.entries(lock.packages).filter(([path, entry]) => path.startsWith('node_modules/') && !entry.link);
const packages = entries.map(([path, entry]) => readPackage(path, entry));
const notices = noticeEntries(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
const problems = licenceProblems(packages, notices);

for (const line of problems) console.error(line);
console.log(summaryLine(packages, problems.length));
process.exit(problems.length ? 1 : 0);
