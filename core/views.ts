import { request, type Credential } from './client.ts';

// Plain-text readings of the hub's views, shared by the one-shot CLI and the interactive shell.
// Participant-written text is shown on one line with control, line-break and direction-override characters
// made visible, so a title cannot move the cursor, clear the screen or fake another row. JSON output is untouched.
const hidden = (code: number) => code < 0x20 || code >= 0x7f && code <= 0x9f || code === 0x61c || code === 0x200e || code === 0x200f || code >= 0x2028 && code <= 0x202e || code >= 0x2066 && code <= 0x2069 || code === 0xfeff;
const slash = String.fromCharCode(92);
export const shown = (value: unknown) => [...String(value)].map(c => c === slash ? slash + slash : c.codePointAt(0) === 10 ? `${slash}n` : hidden(c.codePointAt(0)!) ? `${slash}u${c.codePointAt(0)!.toString(16).padStart(4, '0')}` : c).join('');
// A plain-text reading of the same hub views, for a person or an agent deciding what to do next.
export async function board(auth: Credential) {
  const room = await request(auth, 'room');
  const who = (id: string) => shown(room.roster.find((p: any) => p.id === id)?.name ?? id);
  const lines = [`${shown(room.name)} — ${shown(room.objective || 'no objective')} (you are ${who(room.self)})`];
  const describe = (r: any) => `${r.collabRequestId} ${r.purpose}${r.target ? ` of ${r.target.artifactId} R${r.target.revision}` : ''} from ${who(r.requesterId)}${r.targetSuperseded ? ' [revision superseded]' : ''}${r.itemClosed ? ` [item ${r.itemClosed}]` : ''}`;
  for (const { itemId } of (await request(auth, 'items')).items) {
    const { item } = await request(auth, 'item', { itemId });
    lines.push('', `${item.itemId} ${item.itemType} "${shown(item.title)}" — ${item.state}, owner ${who(item.ownerId)}${item.closure ? `: ${shown(item.closure.reason)}` : ''}`);
    for (const artifact of item.artifacts) {
      const head = artifact.revisions.at(-1);
      const standing = head.objections.filter((o: any) => o.standing === 'current').map((o: any) => who(o.respondentId));
      lines.push(`  ${artifact.artifactId} R${head.revision} by ${who(artifact.authorId)}: ${head.status}${standing.length ? ` (objection: ${standing.join(', ')})` : ''} sha256 ${head.contentDigest}`);
    }
    for (const r of item.requests) {
      const slots = r.slots.map((slot: any) => { const verdict = r.responses.find((x: any) => x.respondentId === slot.respondentId)?.verdict; return `${who(slot.respondentId)} ${slot.state}${verdict ? ` (${verdict})` : ''}`; });
      lines.push(`  ${describe(r)} → ${slots.join('; ')} — ${r.state}${r.result ? `, ${r.result} (${r.policy})` : ''}`);
    }
  }
  const owed = (await request(auth, 'requests', { filter: 'owed_by_me' })).requests;
  const awaiting = (await request(auth, 'requests', { filter: 'owed_to_me' })).requests;
  // Run and armed state exist only on a store with pull delivery; on an older one the board simply omits them.
  const run = await request(auth, 'run').catch(() => undefined);
  if (run) {
    lines.push('', `Run ${run.number}: ${run.state}. Offers used ${run.used.room} of ${run.limits.room}.`);
    const label: Record<string, string> = { waiting: 'Waiting armed', not_armed: 'Not armed', disarmed: 'Disarmed (empty-return limit reached)', unknown: 'Binding unknown' };
    for (const b of run.bindings) lines.push(`  ${who(b.participantId)}: ${label[b.armed]}${b.label ? ` — ${shown(b.label)}` : ''}; offers ${run.used.agents[b.participantId] ?? 0} of ${run.limits.agent}; empty returns ${b.empties} of ${run.limits.emptyWaits}`);
  }
  lines.push('', owed.length ? 'You owe a response:' : 'You owe no response.', ...owed.map((r: any) => `  ${describe(r)}: ${shown(r.text.slice(0, 100))}`));
  lines.push(awaiting.length ? 'Waiting for others, or for you to accept:' : 'Nothing you asked for is outstanding.', ...awaiting.map((r: any) => `  ${describe(r)} — ${r.state === 'open' ? `open: ${r.slots.filter((s: any) => s.state === 'open').map((s: any) => who(s.respondentId)).join(', ')}` : `answered; accept with --responses ${r.responses.filter((x: any) => x.outcome === 'answered').map((x: any) => x.responseId).join(',') || '(none: everyone declined)'}`}`));
  return lines.join('\n');
}
