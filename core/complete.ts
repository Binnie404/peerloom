// What Tab offers at the console prompt, the short forms of the common commands, and how a typed name finds its
// agent. Pure: the shell passes in what is true now (the crew, the waiting approvals, the open requests).
export type CompleteContext = { commands: string[]; agents: string[]; harnesses: string[]; approvals: string[]; requests: string[] };

const TAKES_AGENT = new Set(['/send', '/tell', '/kill', '/relaunch', '/reoffer', '/trust', '/untrust', '/map-update', '/to']);
const TAKES_APPROVAL = new Set(['/approve', '/deny', '/reply']);
export const ALIASES: Record<string, string> = { '/s': '/send', '/a': '/approve', '/d': '/deny', '/st': '/status', '/i': '/invite', '/p': '/pause', '/q': '/quit' };

export function expandAlias(line: string): string {
  const match = /^(\/[a-z]+)(\s|$)/.exec(line);
  return match && Object.hasOwn(ALIASES, match[1]) ? ALIASES[match[1]] + line.slice(match[1].length) : line;
}

const pick = (options: string[], word: string) => { const hits = options.filter(o => o.toLowerCase().startsWith(word.toLowerCase())); return hits.length === 1 ? [`${hits[0]} `] : hits; };

// An @ starts a mention unless it follows a letter, digit or _ (an address, a handle): `(@Beta)` and `@Alpha,@Beta`
// both mention, `me@codex.dev` does not.
const MENTION = /(?<![A-Za-z0-9_])@([A-Za-z][A-Za-z0-9_-]{0,31})/g;
const MENTION_TAIL = /(?<![A-Za-z0-9_])(@[A-Za-z0-9_-]*)$/;

// Tab offers full command names only: the short forms are for typing, not for listing.
export function complete(line: string, ctx: CompleteContext): [string[], string] {
  const words = line.split(' '); const last = words.at(-1) ?? '';
  if (words.length === 1 && line.startsWith('/')) return [pick(ctx.commands, line), line];
  const mention = MENTION_TAIL.exec(last)?.[1]; if (mention !== undefined) return [pick(ctx.agents.map(a => `@${a}`), mention), mention];
  if (words.length === 2 && line.startsWith('/')) {
    const command = expandAlias(words[0]);
    if (TAKES_AGENT.has(command)) return [pick(command === '/to' ? [...ctx.agents, 'all'] : ctx.agents, last), last];
    if (command === '/invite') return [pick(ctx.harnesses, last), last];
    if (TAKES_APPROVAL.has(command)) return [pick(ctx.approvals, last), last];
    if (command === '/accept') return [pick(ctx.requests, last), last];
  }
  return [[], last];
}

// Where a wrong guess would grant, stop or assign (trust, kill, the page's actions) the caller asks for exact names only.
// An exact name (any case) wins; otherwise a prefix that fits exactly one agent; otherwise say what it could be.
export function resolveName(text: string, names: string[], { prefix = true } = {}): { name: string } | { error: string } {
  const wanted = text.trim().toLowerCase();
  const exact = names.find(n => n.toLowerCase() === wanted); if (exact && wanted) return { name: exact };
  const hits = wanted && prefix ? names.filter(n => n.toLowerCase().startsWith(wanted)) : [];
  if (hits.length === 1) return { name: hits[0] };
  if (hits.length > 1) return { error: `${text} could be ${hits.slice(0, -1).join(', ')} or ${hits.at(-1)}; type more of the name.` };
  return { error: `There is no agent called ${text || '(nothing)'}. /status lists them.` };
}

// Who hears a line typed without a slash: the crew members it @mentions (as on the page), else the recipient set with
// /to, else everyone. An unknown @name changes nothing.
export function routeLine(line: string, agents: string[], sticky = ''): { text: string; to?: string[] } {
  const byLower = new Map(agents.map(a => [a.toLowerCase(), a])); const found: string[] = [];
  for (const match of line.matchAll(MENTION)) { const name = byLower.get(match[1].toLowerCase()); if (name && !found.includes(name)) found.push(name); }
  const text = line.trim();
  return found.length ? { text, to: found } : sticky ? { text, to: [sticky] } : { text };
}

// A bare /approve takes the only waiting request, and only if the human could see it when the prompt was last shown:
// one that arrived while they typed is not what they meant.
export function onlyApproval(current: string[], seenAtPrompt: string[]): string {
  return current.length === 1 && seenAtPrompt.includes(current[0]) ? current[0] : '';
}
