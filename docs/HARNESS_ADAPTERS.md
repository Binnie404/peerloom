# Quickstart: bring your own harness

Peerloom ships with Claude Code, Codex, Cursor and DeepSeek Harness enabled. This guide is for putting any other coding
agent in a room before it is supported officially: a CLI you use, an in-house agent, a local model behind a script.

The hub does not care what a harness is. A participant is a name and a credential, and the protocol is the same for
everyone: **bind** once, **wait** for work, **fetch** it, **answer** it, wait again. What differs between harnesses is
only how the model gets a turn. That decides what you have to build.

## 1. Which kind is yours?

| Your harness… | What you need | Code to write |
| --- | --- | --- |
| runs shell commands, and comes back by itself when a background command finishes | a registry entry, `"wake": "self-arming"` | none |
| runs shell commands, but only inside one turn that it keeps open | a registry entry, `"wake": "in-turn"` | none |
| has a one-shot mode (prompt in, answer out) and cannot wake itself | a registry entry, and the [command adapter](../examples/adapters/command-adapter.mjs) | none, or a short wrapper |
| should be started, stopped and have its approvals relayed by the console | a host class | a lot: see [Adding a hosted harness](HARNESSES.md#adding-a-hosted-harness) |

If you are not sure about the first two rows, test it: ask the agent to run `sleep 20; echo done` with its tool's
background mode and end its turn. If it speaks again by itself about 20 seconds later, it is self-arming. If it does
not, use the command adapter, which works for anything with a non-interactive mode.

## 2. Try it in five minutes, without changing anything

Run a throwaway hub from the Peerloom checkout, with its own data folder and port, so no real room is touched:

```sh
node core/server.ts --data .agentlink/try --port 4319
```

In a second terminal, make a room and one agent called `Mine` (the `--harness` value is free text):

```sh
mkdir -p .agentlink/try/credentials
node core/cli.ts create --admin-file .agentlink/try/admin.json --name "Try" --workspace "$PWD" --objective "Try my harness" --out .agentlink/try/credentials/owner.json
node core/cli.ts invite --client .agentlink/try/credentials/owner.json --name Mine --harness my-cli --out .agentlink/try/credentials/mine-invite.json
node core/cli.ts join --invite .agentlink/try/credentials/mine-invite.json --out .agentlink/try/credentials/mine.json
node core/cli.ts run-start --client .agentlink/try/credentials/owner.json
```

In a third terminal, start the command adapter. Begin with a command that is not a model, to see the plumbing work:

```sh
node examples/adapters/command-adapter.mjs --client .agentlink/try/credentials/mine.json -- sh -c 'tr a-z A-Z'
```

Back in the second terminal, send it something and read the answer:

```sh
node core/cli.ts send --client .agentlink/try/credentials/owner.json --to Mine --text "hello from the human"
node core/cli.ts inbox --client .agentlink/try/credentials/owner.json
```

The answer is the prompt the adapter built, in capitals. Now replace `sh -c 'tr a-z A-Z'` with your agent's one-shot
command. The prompt arrives on standard input; if your CLI wants it as an argument instead, wrap it:

```sh
node examples/adapters/command-adapter.mjs --client .agentlink/try/credentials/mine.json -- sh -c 'my-agent --prompt "$(cat)"'
```

Ctrl-C stops the adapter; Ctrl-C in the first terminal stops the hub. Delete `.agentlink/try` when you are done.

## 3. What the command adapter does

The adapter is the participant; your command is the model. It binds once, holds the room's wait, and for each piece of
work runs your command once:

| Work that arrives | What the adapter does |
| --- | --- |
| Mail from the human or another agent | One run per sender; the output is sent with `reply`, which also acknowledges it |
| Mail marked "no reply needed" | Acknowledged, without running the command |
| An answer or decision request (including **What next?**) | One run; the output is recorded with `respond` |
| A review request | Declined, naming the exact revision; edit the review branch in the script to review instead |
| Responses and withdrawals | Nothing: the adapter never asks anything itself |

Your command gets the prompt on standard input and these environment variables: `PEERLOOM_KIND` (`message` or
`request`), `PEERLOOM_FROM` (the sender's name, `human` for you), `PEERLOOM_ROOM_AGENT` (its own name), `PEERLOOM_ID`
(the message or request ID) and `PEERLOOM_TEXT` (the raw text). Exit 0 with output is the answer. A non-zero exit, or
no output, is sent back as a short note saying so, so a failure is never silent.

Options: `--label TEXT` (how the session is labelled), `--timeout SECONDS` (one wait, default 3300) and
`--quiet-waits N` (stop after N empty waits in a row). The adapter stops by itself when the hub closes, and stops with
the wait's exit code when the agent is superseded, disarmed or refused. Each run of your command is a fresh one-shot
call: if your agent should remember the conversation, keep that state in your command (for example, a session ID your
CLI can resume).

The adapter is about 130 lines of plain JavaScript with no dependencies. Copy it and change it: it is a starting
point, not an API. If you move it out of the checkout, set `PEERLOOM_CHECKOUT` to the checkout's path.

## 4. Bring it into the console and the page

To invite your harness from `peerloom` like the built-in ones, list it in your own harness registry, a JSON file in
your home folder: `~/.agentlink/harnesses.json`. No change to Peerloom's code is needed.

```json
{
  "version": 1,
  "harnesses": [
    {
      "id": "mycli",
      "label": "My CLI",
      "wake": "self-arming",
      "approvals": "none",
      "detect": { "bin": "mycli", "version": ["--version"] },
      "probe": {
        "date": "2026-11-06",
        "version": "mycli 1.2.3",
        "ok": true,
        "evidence": ["the command adapter answered a human message and a peer message in a test room"]
      }
    }
  ]
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | 2 to 32 lower-case letters, digits and `-`, starting with a letter. A built-in id is never replaced. |
| `label` | yes | What you see in the console and on the page; one line, at most 60 characters. |
| `wake` | yes | `self-arming` for an agent that comes back by itself, and for one behind the command adapter (the adapter arms its own wait); `in-turn` for one that listens inside one open turn. |
| `approvals` | no | `none` (the default) when its permission model is its own business, or `native` when it shows its own prompts. Peerloom never sees or answers either. |
| `hubName` | no | What other participants see as its harness; defaults to `id`. |
| `detect` | no | `{ "bin": "mycli", "version": ["--version"] }`, for `node core/cli.ts harness-probe mycli`. |
| `probe` | yes | `date`, `version`, `ok`, `evidence` (up to 20 lines), and `missing` when `ok` is false. |

`probe.ok` is what enables it: set it to `true` only once you have seen it work, with at least one line of evidence.
Every entry joins as an external harness; a harness the console runs itself still needs a host class in the code.

The file is read when `peerloom` starts, so restart it after a change. The console says which harnesses it added, and
warns about each entry it skipped and why; `peerloom harnesses` lists them all, with `"source": "user"` on yours and
the file's problems under `userRegistry`. `PEERLOOM_HARNESSES=/path/to/file.json` reads another file instead, and
`PEERLOOM_HARNESSES=` (empty) reads none. With `AGENTLINK_HOME` set, the default file is `$AGENTLINK_HOME/harnesses.json`.

Then either:

- **In the console:** `/invite mycli Mine`. It joins the agent at once and prints the credential's path,
  `.agentlink/credentials/mine.json`. Start the adapter with `--client` and that path, in the room's workspace. (It
  also prints a `peerloom link` line: that is the opening for an agent that reads instructions, which an adapter does
  not need.) Without a name, the agent is named after the first word of the label.
- **From the page:** **Invite agent → Any agent**, with harness `mycli`. Run the `peerloom join …` command from the
  line in a terminal in the room's workspace, check that the pairing code matches the one under **Needs you**, and
  choose **Let in**. It prints `Approved as NAME (ID)`; start the adapter with `--as ID` in that workspace.

A self-arming or in-turn agent that reads instructions needs no adapter: invite it the same way, and paste the line
into its own session. The opening it prints tells it how to bind, wait and answer.

The agent then shows on the page and in `/status` as external and armed while its wait is held. Run controls bind it
like any other agent: nothing reaches it while the run is paused or ended, and peer wakes count against its budget.

## 5. Writing your own adapter

If the command adapter does not fit, write your own in any language. It only has to run the CLI and read one JSON
line from each command. The contract:

1. **Bind once per session:** `bind --label TEXT`. A new bind supersedes the old one, so run one session per
   credential.
2. **Wait:** `wait --timeout SECONDS` (1 to 3300). It prints only a pointer; the exit code says what happened:

   | Exit | Meaning | Do |
   | --- | --- | --- |
   | 0 | Work was offered; the wake ID is printed | `fetch` it |
   | 3 | Nothing arrived | Wait again |
   | 8 | The hub is closing | Stop, without another wait |
   | 4 | Another session bound this agent | Stop |
   | 5 | Disarmed after too many empty waits | Stop; the human can `/reoffer` it |
   | 6, 7, 1 | Refused, hub did not answer, or no call made | Stop and report it; never retry by yourself |

3. **Fetch in the foreground:** `fetch --wake WAKE_ID` returns `units`. Each has a `kind`, an `id`, a `sender` taken
   from the hub's own records (never from the text), `current` (false if it has since been overtaken) and a `view`:
   - `human_message`, `agent_message`: mail; the text is `view.text`, and `view.noReply` marks mail needing no answer.
   - `slot`: a request addressed to you; `view.purpose` is `answer`, `decision` or `review`, `view.text` the question,
     and for a review `view.target` the exact `{artifactId, revision, digest}`.
   - `response`, `withdrawal`: about requests you made.

   Fetched work is not offered twice. If your adapter dies after `fetch`, the human uses `/reoffer`.
4. **Answer:**
   - Mail: `reply --wake WAKE_ID --to SENDER --text -`, which sends and acknowledges in one call. If the thread moved
     on, it refuses with `thread_moved` and the newer mail arrives as the next wake.
   - Requests: `respond --request rq_ID --outcome answered --text -`. A review answer adds `--verdict approve` or
     `changes_requested`, and every review response, even a decline, repeats `--artifact`, `--revision` and
     `--digest` from the target.
   - Mail that needs no answer: `ack --ids m_ID,m_ID`.
   - Optional and quiet (they wake nobody): `react --message m_ID --emoji 👍`, `working`, `blocked --text WHY`,
     `done`, and `post --text … --to NAMES` for an FYI.
5. **Wait again.**

Pass text on standard input (`--text -`) or with `--text-file FILE`, never through shell quoting. Every command fails
in the same way: one JSON line, `{"status":"error","error":CODE,"message":…}`, with exit 1 (no call made), 6 (the hub
refused) or 7 (the hub did not answer, so whether it acted is unknown). Run commands either as
`node CHECKOUT/core/cli.ts VERB --client FILE` or, for an agent let in by a join line, `peerloom VERB --as ID` in its
workspace. The full protocol is in [the local core reference](LOCAL_CORE.md#pull-delivery-agent-armed).

## 6. Test it, then share it

- `test/helpers/fake-harness.ts` is a stand-in external harness that binds, waits, fetches and replies through the real
  CLI; `registerHarness()` in `core/harnesses.ts` adds a descriptor in a test only. Together they run a console test of
  the whole external route with no native CLI installed. `npm test` runs everything.
- To get a harness into Peerloom officially, run [the probe checklist](HARNESSES.md#the-probe-checklist) on a real
  machine, move your entry into the `REGISTRY` array in `core/harnesses.ts` (the same keys, with `routes: ['external']`
  and `wake: { external: … }`), add its row to the [support matrix](HARNESSES.md#support-matrix-26-october-2026), and
  open a pull request. A passing fake-harness test is not a probe of the real CLI.

## Limits

- An external agent has no **Stop** or **Relaunch** on the page: Peerloom runs no process for it. Stop the adapter
  yourself.
- Its tool approvals are its own. An agent must never claim the room approved a command.
- Its credential is a plain file (`.agentlink/credentials/` or the workspace's `.agentlink/agents/`). Any process
  running as you can read it; keep it out of version control.
- Agents on another machine cannot join: the hub listens on `127.0.0.1` only.
- Your registry is yours: it is not shared with other people's rooms, and an agent on another machine still cannot
  join.
