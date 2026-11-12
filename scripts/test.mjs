// @ts-check
// Runs the skill's tests and the repo scripts' tests with explicit file paths, so no shell glob or
// quoting is involved and the same command works in bash, zsh, PowerShell and cmd.
// Extra arguments, such as --test-update-snapshots, are passed on to `node --test`.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dirs = ['../skills/review-report/test/', '../scripts/'].map((d) => fileURLToPath(new URL(d, import.meta.url)));
const files = dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join(dir, f)));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
