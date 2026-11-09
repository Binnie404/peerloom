# Changelog

## 0.1.0 — 6 November 2026

The first release, and the first under the name Peerloom. Until 31 October 2026 the project was called AgentLink.

### The rename

- The commands are `peerloom` and its short name `plm`, and the package is named `peerloom`. There is no
  `agentlink` command any more, so installing Peerloom never clashes with an earlier AgentLink install.
- The console, the browser page, the hub's banner, agent openings and every message a person or an agent reads say
  Peerloom. The page and the console open with the Peerloom mark, in light and dark themes.
- Stored and protocol names keep `agentlink` on purpose: `.agentlink/`, `~/.agentlink/`, `agentlink-map.txt`,
  `AGENTLINK_*` variables, the `/agentlink` and `$agentlink` skills and the hosted sessions' wake markers. Existing
  rooms open unchanged. See [the README](README.md#names-that-still-say-agentlink).

### In this release

- **Rooms and mail.** A local hub on `127.0.0.1` with scoped invitations, stable participant credentials, a roster,
  directed and broadcast messages, reply threads, durable inboxes and explicit acknowledgements, recovered after a
  restart or a killed process. Every change is retry-safe with an idempotency key.
- **Collaboration records.** Items, immutable revisions with SHA-256 digests, addressed requests, review verdicts,
  the requester's acceptance and a board of who owes what.
- **Pull delivery.** Agents bind and hold bounded waits; the hub offers work when it arrives, under a run the human
  starts, pauses and ends, with offer budgets and an empty-wait allowance.
- **Hosted agents.** The console runs Claude Code and Codex sessions itself, starts a model turn only when work
  arrives, and relays their approvals and questions.
- **Harness registry.** Each harness's routes, wake mechanism and probe evidence are data in `core/harnesses.ts`.
  Enabled: Claude Code, Codex, Cursor, DeepSeek Harness.
- **User-level harness registry.** External harnesses listed in `~/.agentlink/harnesses.json` (or the file
  `PEERLOOM_HARNESSES` names) join the built-in ones without a code change. Bad entries are skipped and reported by
  the console and `peerloom harnesses`; a built-in id is never replaced.
- **One-paste join.** **Invite agent → Any agent** on the page gives one line to paste into the agent's own session.
  `peerloom join` shows a pairing code; the human lets it in from **Needs you**. Joined agents then run short
  commands, `peerloom VERB --as ID`. In the console, `/invite cursor` or `/invite dsh` invites directly and prints a
  `peerloom link` line instead.
- **Quiet coordination** (store version 6). Quiet posts, "no reply needed" mail, reactions, working/blocked/done
  activity and per-recipient receipts, none of which wakes anybody or spends budget.
- **Ideas.** **What next?** asks the agents for suggestions as structured proposals; the human asks another agent's
  position, dismisses one, or makes it a task assigned to one agent (store version 5).
- **Project map.** `agentlink-map.txt`, edited by agents through the hub whole or not at all, drawn and checked against
  the workspace on the **Map** tab.
- **The browser page.** Conversation, Work, Map, Ideas and Activity views; **Needs you** for approvals, joins, budget
  holds and upgrades; `@name` suggestions, a To picker and keyboard shortcuts (`?` lists them).
- **The terminal console.** Every room operation, short forms such as `/s`, `/a` and `/st`, `@Name` and `/to`
  routing, Tab completion inside the console and for zsh, bash and fish, and prompt history kept in
  `.agentlink/history`.
- **Bring your own harness.** [A quickstart](docs/HARNESS_ADAPTERS.md) and a sample adapter,
  `examples/adapters/command-adapter.mjs`, that puts any command-line agent with a one-shot mode in a room.
- **Upgrades.** Stores from versions 1 to 5 keep working as they were until upgraded with the console's `/upgrade`,
  the page's **Review upgrade** or `--upgrade-state`, which keeps an exclusive byte-for-byte backup first.

### Not in this release

Agents on other machines, `/plan` and `/goal` orchestration, a desktop app shell, and the Gemini, Kimi and GLM CLIs
(registered but not enabled until probed). The window launchers need macOS.
