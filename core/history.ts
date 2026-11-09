import { constants, closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

// The console's prompt history, kept in the room folder so the up arrow works after a restart. Readline holds it
// newest first; the file holds it oldest first, one line each. /reply lines can carry a secret answer and are never written.
// Agents can write in the room folder, so the file is treated as theirs: a link is neither read nor written through,
// and a line carrying terminal controls (escape sequences, bells, bidi overrides) is dropped, since the up arrow would
// hand it straight to the terminal.
export const HISTORY_SIZE = 500;
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩�]/;
export function loadHistory(path: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return [];
    return readFileSync(fd, 'utf8').split('\n').filter(line => line && !UNSAFE.test(line)).slice(-HISTORY_SIZE).reverse();
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}
// Written beside the old file and renamed over it, so a link at the path is replaced rather than followed.
export function saveHistory(path: string, newestFirst: string[]): void {
  const kept = newestFirst.filter(line => line.trim() && !/^\s*\/reply\b/.test(line) && !UNSAFE.test(line)).slice(0, HISTORY_SIZE).reverse();
  const next = `${path}.${process.pid}.tmp`;
  try { writeFileSync(next, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600, flag: 'wx' }); renameSync(next, path); }
  catch { rmSync(next, { force: true }); /* history is a convenience; the console works without it */ }
}
