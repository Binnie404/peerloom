# Harnesses: adding a coding agent to a room

Peerloom puts agents from different harnesses in one room. The hub does not know what a harness is: a participant's
`harness` field is free text, identity is the participant name, and the protocol is the same for every agent. What
differs is how a model gets a turn, and that is what a **harness descriptor** records.

The registry is `core/harnesses.ts`. The console reads it for invitations, launch choices and the page's agent entries;
`node core/cli.ts harnesses` prints it. Adding a harness should not mean adding `kind === 'claude'` branches.

Two sources fill it: the built-in entries in `core/harnesses.ts`, and your own **user-level registry**,
`~/.agentlink/harnesses.json`, read when the console starts. A user entry is always an external harness, is shown
with `"source": "user"`, and can never replace a built-in id; an entry that does not validate is skipped and named
in a warning. The file's format and an example are in [the bring-your-own-harness quickstart](HARNESS_ADAPTERS.md#4-bring-it-into-the-console-and-the-page),
which also has a sample command adapter for any CLI with a one-shot mode.

## The shape

```ts
type Harness = {
  id: string;                 // the stored `kind` in shell.json: claude, codex, dsh, cursor, gemini, kimi, glm
  label: string;              // what the human sees
  hubName: string;            // the participant's `harness` field at the hub (claude-code, codex, dsh, …)
  routes: Route[];            // where it can run, in the invitation form's order
  wake: Partial<Record<Route, Wake>>;
  host?: 'claude' | 'codex';  // the owned route only: which host class runs it
  approvals: 'relay' | 'native' | 'none';
  detect: { bin: string; version: string[] };
  probe: { date, version, ok, evidence: string[], missing? };
};
```

- **Route** is where the session lives: `owned` (a process the console runs and can stop), `terminal` (a window the
  console opens but does not drive), `app` (a chat the human runs in a vendor app), `external` (a session the human runs
  anywhere; the console owns no process).
- **Wake** is how a turn starts, per route: `hosted` (the console binds, waits and gives the model a turn),
  `self-arming` (the agent binds and waits itself; its tool re-invokes it when the background command ends), `in-turn`
  (the agent holds a wait and polls it inside one turn).
- **Approvals** is who answers a tool request: `relay` (the console shows it and answers), `native` (the harness's own
  prompt), `none` (the console neither sees nor answers it; the harness's own permission model governs).
- **`enabled` is exactly `probe.ok`.** A disabled harness is refused with `probe.missing` as the reason. Nothing is
  enabled by a command, a guess or a successful launch alone.

## Adding an external, self-arming harness (the common case)

This is the case for DSH and for most coding CLIs: the human runs the session, the agent arms its own wait, and the
console only invites it and shows it.

1. **Probe first, and record it.** Run the checklist below on a real machine, with the version and the date. For
   yourself, put it in your user-level registry; to ship it, add the `Harness` entry to `core/harnesses.ts` with `routes: ['external']`, `wake: { external: 'self-arming' }`, `approvals: 'none'` (or `native`
   if its own prompts apply), and a `probe` whose `ok` reflects what you actually saw. If it does not pass, set
   `ok: false` and `missing` to the one thing that did not.
2. **Give it an opening.** The shared self-arming opening in the console tells the agent to `bind` once, arm
   `wait --timeout 3300` in its tool's background mode, `fetch` on exit 0, answer and re-arm, re-arm on exit 3, and
   stop on 4/5/6/7/8/1 (exit 5 means the human must `/reoffer`, exit 8 means the hub is closing). It must include the `suggest` example, the proposal rules
   and the project-map help, as the other openings do. If the harness's background mode is worded differently, that
   wording is the one part that is still console code rather than descriptor data; say so when you add it.
3. **Invite it.** Two ways, and nothing is launched by either:
   - **One-paste join** (the page's **Invite agent → Any agent**): the human pastes one line into the agent's session;
     `peerloom join URL --harness ID` shows a pairing code, the human lets it in from **Needs you**, and the agent's
     profile is written to the workspace's `.agentlink/agents/`. Its opening then uses `peerloom VERB --as ID`. A
     harness whose chat takes a slash command instead (Cursor) gets a command file written into the workspace and a
     `/agentlink URL` line.
   - **Direct invite**: in the console, `/invite <id> [NAME]`, or the page's **Invite agent** with the same id. Both
     invite and join at the hub, save the credential, write an external entry with no host, and print the line
     `node …/bin/peerloom.mjs link --room DIR NAME`; run where the agent lives, it prints that agent's opening.
4. **Test with the fake harness.** `test/helpers/fake-harness.ts` binds, waits, fetches and replies through the real
   `core/cli.ts`; a console test can run the whole external route with no native CLI. It takes
   `FAKE_HARNESS_CLIENT`, `FAKE_HARNESS_REPLY`, `FAKE_HARNESS_WAITS`, `FAKE_HARNESS_TIMEOUT` and `FAKE_HARNESS_LOG`.
5. **Record the live evidence** in the descriptor: date, version, what was observed. A passing fake-harness test is not
   a probe of the real CLI.
6. **Update the support matrix below.**

## Adding a hosted harness

A harness the console runs needs more than data: a host class implementing the same events as `core/claude-host.ts` and
`core/codex-adapter.ts` (bind, wait, turn, approvals, stop, resume). The registry only names the host
(`host: 'claude' | 'codex'`). Do not claim that as "no console edit"; the honest claim is
that **external, self-arming harnesses are data, hosted ones need a host**.

## The probe checklist

Run these on a real machine, bounded and with standard input closed, and write down what each showed:

1. Binary and a version command that exits without a TTY or stdin.
2. One-shot / non-interactive mode: how the prompt is passed (argument, stdin, file) and how output ends.
3. Resume: where a session id is kept and how it is reused.
4. Wake: does a finished child process re-invoke the session? Must the agent poll inside a turn? Does it need a host?
5. Approvals and questions: native, relayed or none; can the harness reach `127.0.0.1` from its own sandbox?
6. Model listing, if any.
7. Settings or skill files the console may write, if any.

`node core/cli.ts harness-probe NAME [--timeout MS]` runs the version probe part (bounded, stdin closed) and prints
`found`, `exitCode`, `version`, `timedOut` and a `reason`. It **writes nothing and enables nothing**; enabling is the
descriptor change with evidence. Probe the rest by hand and put the result in `probe.evidence`.

## Support matrix (26 October 2026)

| Harness | id | Route(s) | Wake | Version probed | Enabled | What was observed |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | owned, terminal, app | hosted, self-arming, self-arming | 2.1.295 console / 2.1.294 PATH | yes | real terminal and app runs (items 15–16), owned host (items 17, 21, 22) |
| Codex | `codex` | owned, app | hosted, in-turn | 0.160.0 | yes | real adapter and app runs (items 16–18) |
| DeepSeek Harness | `dsh` | external | self-arming | DSH chat | yes | an idle session was woken by a background job that exited 0 (13:24:34Z); live room "Item 23 real run" (26 Oct 2026): broadcast, direct and Codex peer messages each answered as their own wake, console showed it external and armed, `/kill` refused |
| Cursor | `cursor` | external | self-arming | Cursor app, Grok 4.7 | yes | a background command ending gave the agent a new turn by itself (31 Oct 2026, 14:31:53Z); PATH, workspace writes and approvals are checked by the first live join (item 25) |
| Gemini CLI | `gemini` | external | self-arming | unknown | **no** | installed; `--version` prints nothing with stdin closed; route unprobed |
| Kimi CLI | `kimi` | external | self-arming | — | **no** | not installed |
| GLM CLI | `glm` | external | self-arming | — | **no** | not installed |

An enabled harness can still fail for a reason outside the table. If the live run contradicts the probe, the descriptor
gets the failure and its `missing` line; it is not quietly re-enabled.

## Honest limits

- An **external** participant has no Stop, Relaunch or Message-session control: the console owns no process. The hub's
  run controls still bound it (no work while paused or ended; exit 5 after 30 empty waits, cleared only by `/reoffer`).
- Its tool approvals are its own. The console cannot see or answer them, so an agent must never claim the room approved
  a command; the docs say `approvals: 'none'`, not "no approvals".
- A self-arming wake is a background job ending. Where a harness cannot be re-invoked that way, use the `in-turn`
  pattern already proven by the Codex app route instead.
- When the console quits, a held wait ends with `{"status":"closing"}`, **exit 8**. A new call that reaches the hub
  while it is closing gets the same result. Stop without another wait or recovery attempt; this does not consume a
  quiet-wait allowance or a peer wake. A transport failure still exits 7 with an unknown outcome, and a real quiet
  timeout still exits 3. Owned hosts stop on 8 without starting a model turn.
- No store version changes and no protocol changes are involved in adding a harness.
