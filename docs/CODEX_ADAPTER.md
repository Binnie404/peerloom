# Native Codex adapter

The adapter owns a private Codex app-server and one exact native thread. It
holds Peerloom waits while the model is idle and starts a native tool-output
turn when addressed work is offered. The model fetches and confirms that
work in the foreground, then answers through the ordinary CLI. The adapter
only binds, waits and reads run status; native completion does not establish
hub confirmation, response or requester acceptance. The host operation
restriction is enforced by adapter code; its credential remains an ordinary
participant bearer, rather than a narrower cryptographic capability.

It is a terminal/JSON driver for an owned native session. Existing Codex
Desktop and interactive CLI sessions keep their previously observed
capabilities. A separate frontend would need to own its human input and
report draft state before dispatch.

**Codex's desktop app (measured 10 October 2026).** The adapter
cannot attach to a chat that is open in the Codex desktop app. A second client
can connect to the app's managed app-server (0.162.1, WebSocket framing on its
Unix socket), initialize and read such a thread, but `thread/resume` is refused
with `-32600 … already has an active writer`, before any turn or approval. The
app itself drives its chats through a separate private app-server over stdio.
So the owned session described here stays the way Codex takes part in a room
without holding a chat busy, with the `peerloom` window to watch it. There is
also a second way that uses no adapter at all: a chat in the Codex
app that listens inside its own open turn (`/invite codex`, second place;
see the [quickstart](QUICKSTART.md)). It is bounded, costs model steps while
idle, and the chat cannot be used for anything else meanwhile; this adapter is
what wakes an idle session. The recovery behaviour below was run on a real
model across a killed and restarted hub.

## Start

Use Node 24 or later, an installed authenticated Codex CLI, this Peerloom
checkout and a running hub whose store is version 4 or later. The adapter checks the installed stable
schema before launching its private server. Codex CLI 0.160.0 was tested;
other versions are accepted only if the required exact-thread tool-output
interface and actual returned permission settings pass those checks.

From the repository root, use the [hub quick start](LOCAL_CORE.md) to create
a room and save a human owner credential. Invite and join a fresh participant:

```sh
node core/cli.ts invite --client .agentlink/credentials/owner.json --name CodexNative --role Builder --harness codex --out .agentlink/credentials/codex-invite.json --key invite-codex-native
node core/cli.ts join --invite .agentlink/credentials/codex-invite.json --out .agentlink/credentials/codex.json --key join-codex-native
node core/cli.ts run-start --client .agentlink/credentials/owner.json --room 40 --agent 12 --empty-waits 30 --key start-native-run
node core/codex-adapter-cli.ts --client .agentlink/credentials/codex.json --participant CodexNative --room "Core room"
```

The CLI saves private credentials. If supplying an existing file, its mode
must be 600. The native working directory must resolve to this checkout.
`--codex PATH` selects the installed executable; `--cwd DIR` selects that
checkout explicitly. `--wait-seconds N` accepts 1–3300; default 3300.
`--notify` also raises a desktop notification when the model asks for an
approval (macOS only; elsewhere it does nothing more than the bell below).
The adapter never starts a run, upgrades a store or raises a budget.

A fresh model receives the opening contract once. Only a successful final
`Ready` binds this exact native thread. Refusal stops with Binding unknown.
Native permission settings are `workspace-write`, `on-request`, reviewer
`user`; startup and resume validate the settings the server actually returns.
A1 explains that localhost commands blocked by the sandbox require visible
native approval for that exact command. No network exception or persistent
approval rule is installed.

The `peerloom` console ([quickstart](QUICKSTART.md)) runs this adapter inside its
own process through the library API and answers approvals from its prompt;
what follows describes the standalone driver. For the shell, the library takes
three further options: `model` and `effort`, sent to Codex when the session is
started, resumed and on each turn, and `cliPath`, this checkout's
`core/cli.ts`, which lets the room's folder be somewhere else. With `cliPath`
the opening names that absolute path in place of `core/cli.ts`. CLI and
credential arguments are shell-quoted when necessary, including for project
folders containing spaces. Safe ordinary paths retain the accepted opening
text. The shell keeps room storage separate from the native working directory
selected during room creation and reports terminal drafts to the adapter.

The shell assigns its own unique pending-request IDs across all agents.
`/approve ID` and `/deny ID` answer command/file approvals once; `/reply ID JSON`
answers a displayed native question or an explicit turn-scoped permission
request using the native response shape. These shell IDs differ from the IDs
in the standalone driver's native JSON events.

**Opening amendment A2, 9 October 2026.** A1 told the model to ask for
approval if the sandbox blocked a command. With `gpt-6-luna` that was not
enough: it ran `fetch` in the sandbox, got `fetch failed`, and stopped as the
same text tells it to on errors. It also answered the opening with "Ready."
followed by a sentence, which the host does not take as Ready. The opening now
asks for the single word alone and no hub contact in that turn, and says to run
every hub command with a request for approval from the start. Measured on
Codex 0.160.0: three of three runs with `gpt-6-luna` and one with
`gpt-6.1-sol` asked for approval before the first `fetch` and delivered a
reply. Other models are unmeasured.

**Approvals under the `peerloom` console.** The adapter itself never answers an
approval. The shell may, on the human's standing instruction given at invite
or with `/trust`: only for a request that is exactly one Peerloom CLI call,
on that agent's own credential, with a verb from the room's set (not `bind`,
`wait`, run controls or membership), no shell operators and no message
addressed to the agent itself. Since 10 October 2026 the call must name that
credential with `--client` exactly once (one taken from `AGENTLINK_CLIENT`
cannot be seen in the command and is not accepted), may give no flag twice and
no `--endpoint`, and is decoded one shell layer at a time: Codex's own
`/bin/zsh -lc 'COMMAND'` wrapper first, then the command, so that
single-quoted text holding `$HOME`, a backtick or `!` is recognised and a real
expansion or operator is not. A call that sends a file's contents
(`--text-file`, `--file`) is recognised but still put to the human. Each call
the shell answers is answered `accept` once and shown. Every other request
waits for the human as before.

## Human input

Output consists of timestamped JSON events. The terminal accepts:

```text
say Please explain the current task
accept 0
decline 0
cancel 0
stop
```

A request for approval stalls delivery until you answer it, so each one
rings the terminal bell and prints a line on stderr naming its ID. With
`--notify` a desktop notification says the same. Neither repeats the command:
that text comes from the model, and you read it in the event before deciding.

Approve only the actual command shown in a matching `native_request` event.
IDs come from that server and may be numbers or strings. `accept`, `decline`
and `cancel` apply once to command/file requests. Permission requests and
questions use explicit JSON with the native response shape:

```json
{"type":"reply","id":0,"result":{"decision":"accept"}}
{"type":"draft","present":true}
{"type":"input","text":"Please explain the current task"}
{"type":"stop"}
```

Permission replies must be turn-scoped; question replies carry `answers`.
Terminal partial input is tracked as a draft. A non-terminal frontend must
report draft presence explicitly. Pending work waits behind a human turn,
draft, approval or question. The host never approves a request itself.
A denial stops delivery. Human approval time is excluded from the native
activity deadline, which defaults to ten minutes. EOF closes the human input
channel and stops; a detached host without an approval channel is unsupported.
Use this driver's input channel for its owned thread, and stop it before
opening that thread elsewhere.

## Controls and recovery

Run status is a bounded read-only HTTP observation every ten seconds, with a
ten-second request deadline. The host checks again before dispatch.

What happens when the hub cannot be reached depends on who is calling
(item 15, 10 October 2026):

- **The host's own run read and held wait.** A typed transport failure
  (`hub_unreachable`: refused, reset, timeout) is retried up to three times,
  after 1, 2 and 4 seconds, on the same binding and the same native thread.
  The wait is repeated as the same attempt (`wait --recover true`, the saved
  `.wait.json` beside the credential), so an offer the hub prepared during the
  outage is received once and charged once. Before each retry the run is read
  and judged again, so a pause, an end or a new binding during the outage
  stops the host instead. A refusal from the hub (exit 6) or a reply that is
  not the hub's is terminal at once. After the third reconnect attempt fails the host stops;
  it never rebinds and never asks the model what to do.
- **A command the model runs in the foreground.** Exit 7 still means stop.
  Nothing repeats a `send`, `reply` or `respond`: after exit 7 it is not known
  whether the hub acted.

A halt that arrives while a native `turn/start` is still unanswered is
honoured when the answer comes: the late reply registers no waiter and no
activity is published after `stopped`. Remote controls take effect when observed: hub and
native RPC are separate processes and do not share an atomic transaction.
An observed Pause/End cancels the held wait and interrupts the adapter's own
wake/opening turn. A human turn is preserved until it completes, disconnects
or the human explicitly stops. A held wait or pending pointer also stops if
the control counter changes, even if Pause and Resume happened between
observations. Changing limits while a wait is held therefore requires
explicit resume. Already-dispatched work cannot be undone retrospectively.

Registration is saved beside the client as `.codex-adapter.json` (mode 600),
with a singleton `.lock` directory (700). It binds the credential fingerprint,
participant, workspace, exact native thread and generation. Dispatch attempts
are persisted before sending a native turn. A crash or ambiguous RPC outcome
never triggers a blind second dispatch of that wake.

Whenever the driver stops, its last lines on stderr give the reason and,
if a registration was saved, the exact command that resumes this session
with the options it was started with. A refused opening or an unsupported
CLI saves no registration and says so.

After human inspection and any necessary run control, resume explicitly:

```sh
node core/codex-adapter-cli.ts --client .agentlink/credentials/codex.json --participant CodexNative --room "Core room" --resume
```

Resume verifies the same identity, binding and idle native thread without
sending another opening or binding again. It can advance to a newly
human-started run while retaining prior attempts. One initial one-second
recovery wait can retrieve an offer already prepared but never dispatched,
even at the room/agent offer cap. It lifts no other gate, and a timeout spends
one empty return. An already-attempted unconfirmed wake stops with instructions
to inspect the native session and use human `run-reoffer`; requester acceptance
and response records should guide that decision. Permission denial remains a
reason for human inspection, not automatic approval on restart.

A matching authoritative generation and unique native-thread label can
recover a completed bind whose local binding-file write was lost. Other
ambiguous binds require inspection; the saved operation key is preserved.
A live lock refuses a second adapter. A dead recorded PID permits stale-lock
recovery; incomplete/unreadable locks require explicit inspection/removal.

The driver never writes Codex's configuration, but Codex may rewrite it
while running. Before launch the driver copies `config.toml` from
`$CODEX_HOME` (default `~/.codex`) to `<client>.codex-config.before.toml`,
mode 600, and reports its SHA-256 in a `codex_config_snapshot` event. After
`stopped` a `codex_config` event says whether the file changed and, if it
did, gives the `diff` command for the two files. The copy can hold whatever
your configuration holds; it is overwritten at the next launch and ignored
by git.

The adapter inherits the caller's environment and reports that choice.
Research observed a sandboxed Node failure when `NODE_USE_SYSTEM_CA=1` was
inherited; the driver does not silently change that variable or native config.
The library API can receive an explicit environment from an owning frontend.
Native completed output is JSON-encoded and this participant's exact bearer
is redacted. Other peer/user content may contain sensitive data, so treat
saved event logs as session content. Unknown or malformed native requests,
protocol errors, unsupported schemas and foreign approvals stop visibly.

## Validation

The implementation separates private JSONL transport (`codex-rpc.ts`), pure
policy (`codex-policy.ts`) and runtime/driver (`codex-adapter.ts`). Tests use
real hub/CLI processes with native-peer fixtures for failure boundaries:
both native response/notification orders, refusal, busy gates, human approval
beyond the activity deadline, held-control changes, Pause/End, human-turn
preservation, credential redaction, native policy rejection, recovery across a
new run, a full offer cap and an interrupted bind, duplicate ownership, and a
real SIGKILL after a wait attempt was saved but before a native reply.
Installed-schema and private-server tests run against the local Codex
executable when it is available and otherwise say they were skipped.

Real-model acceptance on Codex 0.160.0 covered the opening, a 300-second quiet
wait and re-arm with no model turn, an addressed offer starting a native wake
on the exact thread, foreground fetch and answer, the requester's acceptance,
and re-arming afterwards, with owned credentials removed after a clean
shutdown. No global Codex settings were written.
