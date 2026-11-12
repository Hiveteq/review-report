// @ts-check
// Moves the pinned CDN files in lib/cdn.mjs to the newest published versions of highlight.js and
// Mermaid. For each file it downloads the exact URL the report will load and computes its sha384,
// so the integrity hash always matches what the CDN serves. Rewrites cdn.mjs in place and prints
// what changed; prints nothing to change when both are current. Run by the weekly CDN workflow.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CDN } from '../skills/review-report/lib/cdn.mjs';

const file = fileURLToPath(new URL('../skills/review-report/lib/cdn.mjs', import.meta.url));

/**
 * Shape of the cdnjs library listing, reduced to the one field this script reads.
 * @typedef {object} CdnjsListing
 * @property {string[]} versions every published version
 */

/**
 * Shape of the npm registry entry, reduced to the one field this script reads.
 * @typedef {object} NpmPackument
 * @property {Record<string, unknown>} versions published versions, keyed by version number
 */

/**
 * @param {string} url
 * @returns {Promise<unknown>} the parsed body; callers cast it to the shape they read, the registries are trusted
 */
async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/**
 * Splits a version into three numbers; a missing or non-numeric part counts as 0, so odd tags never yield NaN.
 * @param {string} v
 * @returns {number[]}
 */
const parts = (v) => [0, 1, 2].map((i) => Number.parseInt(v.split('.')[i] ?? '', 10) || 0);

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, zero or positive, as for Array.prototype.sort
 */
const compare = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/**
 * Highest plain x.y.z release; pre-releases such as 12.0.0-beta.1 are skipped.
 * @param {string[]} versions
 * @returns {string | undefined}
 */
const highest = (versions) => versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(compare).at(-1);

// Each library: where to ask for its newest version, and the version segment inside its URLs.
// cdnjs's own "version" field can lag behind its list, so the highest listed version is used.
/** @type {{ name: string, keys: (keyof typeof CDN)[], pattern: RegExp, latest: () => Promise<string | undefined> }[]} */
const libraries = [
  { name: 'highlight.js', keys: ['hljs', 'hljsLight', 'hljsDark'], pattern: /(highlight\.js\/)(\d+\.\d+\.\d+)(\/)/,
    latest: async () => highest(/** @type {CdnjsListing} */ (await json('https://api.cdnjs.com/libraries/highlight.js?fields=versions')).versions) },
  { name: 'mermaid', keys: ['mermaid'], pattern: /(mermaid@)(\d+\.\d+\.\d+)(\/)/,
    latest: async () => highest(Object.keys(/** @type {NpmPackument} */ (await json('https://registry.npmjs.org/mermaid')).versions)) },
];

/**
 * @param {string} url
 * @returns {Promise<string>} the Subresource Integrity value of what the URL serves
 */
async function sri(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return `sha384-${createHash('sha384').update(Buffer.from(await r.arrayBuffer())).digest('base64')}`;
}

/**
 * Moves every library whose newest release is ahead of its pin, and describes each move.
 * @param {string} original the current text of cdn.mjs
 * @returns {Promise<{ source: string, changes: string[] }>} the new text and one line per library that moved
 */
async function updatePins(original) {
  let source = original;
  const changes = [];
  for (const lib of libraries) {
    // Cannot be null: every pinned URL carries its version where the pattern looks for it.
    const current = /** @type {RegExpMatchArray} */ (CDN[lib.keys[0]].url.match(lib.pattern))[2];
    const latest = await lib.latest();
    if (!latest) throw new Error(`${lib.name}: no release version listed`);
    if (compare(latest, current) <= 0) continue; // never move a pin backwards
    for (const key of lib.keys) {
      const { url, integrity } = CDN[key];
      const next = url.replace(lib.pattern, `$1${latest}$3`);
      source = source.replace(url, next).replace(integrity, await sri(next));
    }
    changes.push(`${lib.name} ${current} -> ${latest}`);
  }
  return { source, changes };
}

const { source, changes } = await updatePins(readFileSync(file, 'utf8'));
if (changes.length === 0) {
  console.log('CDN pins are current');
} else {
  writeFileSync(file, source);
  console.log(changes.join('\n'));
}
