import { CLI, PRODUCT, TAGLINE, VERSION } from './brand.ts';

// The startup title, and the few colours the hub and CLI use when a person is watching. Everything here is
// for a terminal only: output that is piped, redirected or parsed is left exactly as it was.
// The mark is the brand logo traced into square pixels, two to a character cell with the half blocks ▀ and ▄, which
// every terminal font has. A pixel is '.' (empty) or a letter naming one of the logo's colours, a being the first.
export const MARK = [
  '...................lll......',
  '.................quuuuul....',
  '................uuuuuuuul...',
  '...............uuuqllquuu...',
  '..............vwwu....luul..',
  '.............rrxv......uuu..',
  '........mmkihnor.......www..',
  '.......mjjiihhgp......pxts..',
  '......mkkjiihggc......xxxl..',
  '.....mkjkmroggccc....xxxv...',
  '....mjjj..ooolcdbb..xxxxs...',
  '...mjjj..prox..bbbexxxxnfa..',
  '..mkjjm..pxxp...berrxxsfffd.',
  '.mjjjm...lwws...lorrx..affa.',
  '.jkkm.....wuuq..ooor....aaac',
  'mjkm......lwwwuoffo.....daac',
  'mkjm.......lwwwtof......daac',
  'mkjm........pvvwtp......aaa.',
  '.jkk.......cfrvvtv.....daaa.',
  '.mjjm.....hdbfrtttslllebaac.',
  '.mjjjimmmhgcdb.pttnnneebbd..',
  '..mjjiiihhggg....snnneeec...',
  '....miiihhgi.......llll.....',
  '......mmmm..................',
];
export const MARK_WIDTH = 28;
export const MARK_ROWS = MARK.length / 2;
const PALETTE = [0x7237D2, 0x7A3CD1, 0xA863E9, 0xA94FE3, 0x9A38D1, 0x6A279E, 0xC785EA, 0xE0B5F4, 0xF2E5F8, 0xF9F3FA, 0xFAF6FB, 0xFD65FD, 0xFFFFFF, 0xCE32C4, 0x9F2091, 0xFF41DE, 0xFD4DD2, 0xCF249D, 0xF737C5, 0xEC2EAD, 0xFA3EB8, 0xF42FB0, 0xF535AE, 0xED27A5];
export function shade(pixel: string): number[] | undefined {
  const colour = PALETTE[pixel.charCodeAt(0) - 97]; if (pixel === '.' || colour === undefined) return undefined;
  return [colour >> 16, (colour >> 8) & 0xFF, colour & 0xFF];
}
const GAP = 3;
const NAME = `${PRODUCT} v${VERSION}`;
export const BANNER_WIDTH = MARK_WIDTH + GAP + Math.max(NAME.length, TAGLINE.length);

type Stream = { isTTY?: boolean; columns?: number; write(text: string): unknown };
type Env = Record<string, string | undefined>;
// Colour needs a terminal that asked for none of the usual ways out of it.
export const colourful = (stream: Stream, env: Env = process.env) => !!stream.isTTY && !env.NO_COLOR && env.TERM !== 'dumb';
const paint = (code: string) => (text: string, on = true) => on ? `\x1b[${code}m${text}\x1b[0m` : text;
export const bold = paint('1'); export const dim = paint('2'); export const red = paint('91'); export const green = paint('92'); export const yellow = paint('93');

const FROM = [0xF0, 0x30, 0xA8]; const TO = [0x9B, 0x6B, 0xFF];
// A colour as the terminal can take it: true colour where it says it has it, the 6×6×6 cube of the 256-colour
// palette otherwise; 38 sets the text, 48 the background.
export function rgbCode(c: number[], env: Env = process.env, layer: 38 | 48 = 38): string {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return `${layer};2;${c.join(';')}`;
  const cube = (v: number) => Math.round((v / 255) * 5);
  return `${layer};5;${16 + 36 * cube(c[0]) + 6 * cube(c[1]) + cube(c[2])}`;
}
// A point on the brand gradient (0 magenta, 1 violet).
export const brandColour = (t: number, env: Env = process.env) => rgbCode(FROM.map((from, k) => Math.round(from + (TO[k] - from) * Math.min(1, Math.max(0, t)))), env);

// The title as lines: the mark with the name and tagline beside it where it fits and colour is wanted, the plain
// name otherwise, nothing when nobody is looking.
export function title(stream: Stream, env: Env = process.env): string[] {
  if (!stream.isTTY) return [];
  if (!colourful(stream, env) || (stream.columns || 80) < BANNER_WIDTH) return [NAME];
  const middle = MARK_ROWS / 2 - 1;
  const side: Record<number, string> = { [middle]: `\x1b[1;${brandColour(0, env)}m${PRODUCT}\x1b[0m \x1b[${brandColour(1, env)}mv${VERSION}\x1b[0m`, [middle + 1]: `\x1b[2m${TAGLINE}\x1b[0m` };
  return Array.from({ length: MARK_ROWS }, (_, row) => {
    const top = MARK[2 * row], bottom = MARK[2 * row + 1];
    const drawn = [...top].map((pixel, i) => {
      const up = shade(pixel), down = shade(bottom[i]);
      if (up && down) return `\x1b[${rgbCode(up, env)};${rgbCode(down, env, 48)}m▀\x1b[0m`;
      if (up || down) return `\x1b[${rgbCode((up ?? down)!, env)}m${up ? '▀' : '▄'}\x1b[0m`;
      return ' ';
    }).join('');
    return `${drawn}${side[row] ? ' '.repeat(GAP) + side[row] : ''}`;
  });
}
export function heading(stream: Stream, env: Env = process.env) {
  const lines = title(stream, env); if (lines.length) stream.write(['', ...lines, '', ''].join('\n'));
}
// One line per startup step, written when the step is done: [✓] when it worked, [✗] when it did not.
export function checklist(stream: Stream, env: Env = process.env) {
  const on = colourful(stream, env);
  return (label: string, ok = true) => {
    if (!stream.isTTY) return;
    const box = `[${ok ? '✓' : '✗'}]`;
    stream.write(`${on ? `\x1b[${ok ? brandColour(0, env) : '91'}m${box}\x1b[0m` : box} ${label}...\n`);
  };
}
export function details(stream: Stream, rows: [string, string][] = [], hint = '', env: Env = process.env) {
  if (!stream.isTTY) return;
  const on = colourful(stream, env); const wide = Math.max(0, ...rows.map(([label]) => label.length));
  stream.write([...rows.map(([label, value]) => `  ${dim(label.padEnd(wide), on)}  ${value}`), ...(hint ? ['', `  ${dim(hint, on)}`] : []), '', ''].join('\n'));
}
export function splash(stream: Stream, rows: [string, string][] = [], hint = '', env: Env = process.env) {
  if (!title(stream, env).length) return;
  heading(stream, env); details(stream, rows, hint, env);
}
export const promptText = (colour: boolean, to?: string) => `${colour ? `\x1b[1;${brandColour(0)}m${CLI}\x1b[0m` : CLI}${to ? ` → ${to}` : ''} › `;
