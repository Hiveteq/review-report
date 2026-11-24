// @ts-check
// Shared by the unit tests: the fixture, a minimal valid story, temp folders that clean up after
// themselves, and one way to run render.mjs as a child process.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff } from '../lib/diff.mjs';

/** @typedef {import('../lib/diff.mjs').DiffFile} DiffFile */

// fileURLToPath, not URL.pathname: the latter is percent-encoded, so a checkout
// path with a space or a non-ASCII character would not resolve.
/** The skill folder, with a trailing separator. */
export const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url));
/** The diff every fixture-based test renders. */
export const FIXTURE_DIFF_PATH = join(SKILL_DIR, 'test/fixture.diff');
/** The story that explains the fixture diff. */
export const FIXTURE_STORY_PATH = join(SKILL_DIR, 'test/fixture.story.json');

/** Overview with the four parts and the one diagram the story contract requires. */
export const OVERVIEW = Object.freeze({ bigPicture: 'a\n```mermaid\nflowchart LR\nA-->B\n```', why: 'b', approach: 'c', howToRead: 'd' });

/** A reader pass that satisfies the contract without claiming any questions. */
export const READER_PASS = Object.freeze({ rounds: 1, questionsAnswered: 0, openQuestions: 0 });

/** @returns {string} the text of the fixture diff */
export function fixtureDiffText() {
  return readFileSync(FIXTURE_DIFF_PATH, 'utf8');
}

/** @returns {DiffFile[]} the fixture diff, parsed fresh so a test may not disturb another */
export function fixtureFiles() {
  return parseDiff(fixtureDiffText());
}

/* eslint-disable jsdoc/reject-any-type -- tests bend the fixture story into invalid shapes on purpose, which a strict Story type would refuse */
/** @returns {any} the fixture story, parsed fresh so a test may change it freely */
export function fixtureStory() {
  return JSON.parse(readFileSync(FIXTURE_STORY_PATH, 'utf8'));
}
/* eslint-enable jsdoc/reject-any-type -- end of the loosely typed fixture story */

/** The file the default chapter of `minimalStory` shows. */
const FIRST_FIXTURE_PATH = fixtureFiles()[0].path;

/**
 * A story that passes validation and references only the fixture's first file.
 * Tests override only the fields they are about.
 * @param {Record<string, unknown>} [overrides] top-level story fields, replacing the defaults whole
 * @returns {Record<string, unknown>}
 */
export function minimalStory(overrides = {}) {
  return {
    meta: { title: 't', readerPass: { ...READER_PASS } },
    overview: { ...OVERVIEW },
    tests: [],
    chapters: [{ title: 'x', intro: 'One. Two.', hunks: [{ file: FIRST_FIXTURE_PATH, lines: 'all' }] }],
    ...overrides,
  };
}

/**
 * Creates a folder that is removed when the test ends, so runs do not fill the system temp folder.
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {string} the folder path
 */
export function tempDir(t, prefix = 'rr-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Creates a git repository with a `sub` folder and a `.gitignore`, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string} the real path of the repository
 */
export function tempRepo(t) {
  // realpath: macOS /var is /private/var; Windows 8.3 short names expand. git reports the real, long path.
  const dir = realpathSync.native(tempDir(t));
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(dir, 'sub'));
  return dir;
}

/**
 * Runs render.mjs in a child process.
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function spawnRender(args, { cwd, env = process.env } = {}) {
  return spawnSync(process.execPath, [join(SKILL_DIR, 'render.mjs'), ...args], { cwd, encoding: 'utf8', env });
}
