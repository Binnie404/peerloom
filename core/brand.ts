import { readFileSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

// The product's words, in one place. Stored names (.agentlink/, agentlink-map.txt, hub provider refs) are data, not
// words, and are not here.
export const PRODUCT = 'Peerloom';
export const CLI = 'peerloom';
export const CLI_SHORT = 'plm';
export const TAGLINE = 'Let your agents think together.';
export const VERSION: string = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')).version;

// Whether a command is an executable file on this PATH: the lines Peerloom gives agents name the command, so the
// console says so when it is missing (npm link, run again after the rename, installs it).
export function installed(name: string, path = process.env.PATH ?? ''): boolean {
  return path.split(delimiter).filter(Boolean).some(dir => { try { const stat = statSync(join(dir, name)); return stat.isFile() && (stat.mode & 0o111) !== 0; } catch { return false; } });
}
