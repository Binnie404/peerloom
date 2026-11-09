# Local connection and communication core

This is the core under Peerloom: a functioning, deliberately small hub and CLI using TypeScript and Node's standard library. Separate processes can dock into a room and exchange messages through authenticated, durable mailboxes. It implements the hub/identity/message, collaboration and bounded pull-delivery portions of the design. The [native Codex adapter](CODEX_ADAPTER.md) adds an owned app-server session and terminal/JSON driver; broader embedded-terminal and MCP adapters remain future work.

Tested with Node **24.10.0**. No installation, package download, compilation, or build step is required. Files contain erasable TypeScript syntax that Node executes directly. Native execution strips types without type checking; see the [official Node documentation](https://nodejs.org/api/typescript.html). Runtime validation protects the API inputs.

## Quick start: a human and two clients

If you want an agent picking up work by itself within ten minutes, use [the session quickstart](QUICKSTART.md) instead; this section is the mailbox on its own.

Run every command from the Peerloom checkout. Keep the hub running in its terminal:

```sh
node core/server.ts --data .agentlink --port 4317
```

It prints its loopback endpoint and the path to `.agentlink/admin.json`, without printing the administrator secret. That is one JSON line on stdout, and it is all a script or a pipe ever sees. At a terminal the hub also shows the Peerloom title and the same facts in readable form on stderr, and `node core/cli.ts help` shows the title above lightly emphasised help. Set `NO_COLOR=1` for the plain name without colour; a terminal narrower than 62 columns gets the plain name too. In another terminal, create the room and invitations:

```sh
mkdir -p .agentlink/credentials
node core/cli.ts create --admin-file .agentlink/admin.json --name "Core room" --workspace "$PWD" --objective "Verify connection and messaging" --out .agentlink/credentials/owner.json --key create-core-room
node core/cli.ts invite --client .agentlink/credentials/owner.json --name Astra --role Reviewer --harness cli --out .agentlink/credentials/astra-invite.json --key invite-astra
node core/cli.ts invite --client .agentlink/credentials/owner.json --name Opus --role Builder --harness cli --out .agentlink/credentials/opus-invite.json --key invite-opus
```

In **client terminal A**, dock Astra and start its live client:

```sh
node core/cli.ts join --invite .agentlink/credentials/astra-invite.json --out .agentlink/credentials/astra.json --key join-astra
node core/cli.ts chat --client .agentlink/credentials/astra.json
```

In **client terminal B**, dock Opus and start its live client:

```sh
node core/cli.ts join --invite .agentlink/credentials/opus-invite.json --out .agentlink/credentials/opus.json --key join-opus
node core/cli.ts chat --client .agentlink/credentials/opus.json
```

Enter these commands in Astra's chat process:

```text
/room
/send Opus Please check the connection protocol
```

Enter these in Opus's chat process:

```text
/inbox
/send Astra Connection received; ready to review
```

Both processes print one JSON object per response. Reading mail keeps it unread. Copy the actual `m_...` message ID from an inbox response and acknowledge it with `/ack m_ACTUAL_ID`. `/quit` disconnects the client. Chat names are single words; the one-shot CLI also supports names containing spaces.

From the human terminal, broadcast to both agent slots:

```sh
node core/cli.ts send --client .agentlink/credentials/owner.json --text "Please begin the verification" --key human-start-1
```

Both `/inbox` commands now return that message with `sender.kind: "human"`. An agent message always has `sender.kind: "agent"`, derived from its credential.

## One-shot commands and reconnect

These work independently of `chat`, including from another local process or a harness that can execute shell commands:

```sh
node core/cli.ts room --client .agentlink/credentials/astra.json
node core/cli.ts inbox --client .agentlink/credentials/astra.json
node core/cli.ts send --client .agentlink/credentials/astra.json --to Opus --text "Please review" --key review-request-1
node core/cli.ts send --client .agentlink/credentials/opus.json --to Astra --text "Review complete" --reply-to m_ACTUAL_ID --key review-response-1
node core/cli.ts ack --client .agentlink/credentials/astra.json --ids m_ACTUAL_ID --key ack-review-1
node core/cli.ts history --client .agentlink/credentials/astra.json --after 0 --limit 100
node core/cli.ts status --client .agentlink/credentials/astra.json --text "Reviewing the protocol"
node core/cli.ts leave --client .agentlink/credentials/astra.json
```

For several recipients use `--to Astra,Opus`, or their stable participant IDs. For an agent broadcast use `--to all`. For the human use `--to human`. At the hub, text mentions such as `@Opus` are plain text: routing comes exclusively from `--to`. (The `peerloom` console and the page turn an `@Name` into `--to` before sending.) Agents must supply an audience; only the human's missing `--to` defaults to all agents. Unknown recipients fail the whole send, even in a list.

Reconnect by using the **saved participant credential**, without joining again. The ID, unread mail, status, and acknowledgement records persist. Restart the hub with the same `--data` directory and port. Clients keep their existing files:

```sh
node core/server.ts --data .agentlink --port 4317
node core/cli.ts inbox --client .agentlink/credentials/astra.json
```

If you choose a different port, add `--endpoint http://127.0.0.1:NEW_PORT` to client commands. `--port 0` selects a free port. Credential retries return the current endpoint.

Use the same `--key` and identical arguments to retry an uncertain mutation. It returns the original result and creates nothing twice, even after a restart. Reusing a key for changed content or another operation fails with `request_conflict`. Use a **new key for new work**. The CLI generates a key if omitted, but explicit keys are recommended for create/invite/join/send because they let you recover if the response or credential-file write is lost. A successful join can be retried with its original key while the invitation remains valid; another join key cannot take the occupied slot.

Invitations expire after 24 hours by default. Set `--ttl SECONDS` when inviting (maximum one week). The human can revoke an invitation before docking:

```sh
node core/cli.ts revoke --client .agentlink/credentials/owner.json --invitation i_ACTUAL_ID --key revoke-invite-1
```

Revocation blocks further invitation use; it does not revoke an already issued participant credential. Participant removal/credential rotation are deferred.

## Agent profiles: `peerloom VERB --as ID`

An agent let in by a one-paste join (see [the quickstart](QUICKSTART.md#any-agent-the-one-paste-join)) is not handed a credential path. Its credential is written to `.agentlink/agents/ID/credential.json` in the room's workspace, with an index at `.agentlink/agents/index.json`, and it runs short commands:

```sh
peerloom bind --as dsh-7k2q --label "dsh"
peerloom wait --as dsh-7k2q --timeout 3300
peerloom reply --as dsh-7k2q --wake wk_ID --text-file answer.txt
```

`--as` works in the room's workspace or a folder inside it, selects exactly one agent profile, and never selects the human's credential. It cannot be combined with `--client` or `--endpoint`, and membership and run-control commands are not accepted through it; `peerloom help` lists the verbs it takes. The `node core/cli.ts … --client FILE` form keeps working.

The human's own credential for a room the console made is kept outside the workspace, under `~/.agentlink/rooms/` (or `$AGENTLINK_HOME/rooms/`), so it is not among the files agents work in. Any process running as the same user can still read it.

## Protocol v1

HTTP is bound exclusively to `127.0.0.1`. Every operation is `POST /v1/OPERATION` with `Content-Type: application/json` and `Authorization: Bearer TOKEN`. The administrator can create sessions, the human owner can create/revoke invitations, and participant credentials operate only within their own session. Browser-origin requests are rejected. The browser page never calls the hub: it talks to the console's own local server (`core/web.ts`), which acts with the human's credential.

| Operation | Body | Credential / result |
| --- | --- | --- |
| `create` | `requestId`, `name`, `workspace`, optional `objective` | Administrator; human credential and session ID |
| `invite` | `requestId`, `name`, optional `role`, `harness`, `ttlSeconds` | Human; one slot and scoped invitation |
| `join` | `requestId`, invitation `token` | Invitation in body; participant credential, brief, roster |
| `revoke` | `requestId`, `invitationId` | Human; invalidates further invitation use |
| `room`, `heartbeat` | `{}` | Participant; objective, workspace, roster, status, presence, unread counts |
| `leave` | `{}` | Participant; marks disconnected without deleting membership |
| `status` | `requestId`, `text` | Participant; changes its own status |
| `send` | `requestId`, `text`, `to` (name/ID, array, or `all`), optional `replyTo`, `seen`, and from version 6 `noReply` or `post` | Participant; message ID, sequence, authenticated sender, recipient IDs, thread ID |
| `inbox` | Optional `after` (sequence), `limit` (1–500; default 100) | Participant; unacknowledged addressed messages in sequence order |
| `history` | Optional `after`, `limit` | Participant; public room conversation, including directed messages |
| `ack` | `requestId`, `messageIds` (1–500 IDs) | Participant; acknowledges only its own deliveries |
| `react` | `requestId`, `messageId`, `emoji` (👍 ✅ 👀 ❌ 🎉), optional `on` (default true) | Participant, on a message it sent or received; version 6 |
| `activity` | `requestId`, `state` (`working`/`blocked`/`done`), optional `messageId`, `text` | Participant, about itself; `done` clears it; version 6 |
| `receipts` | Optional `after`, `limit` (1–500; default 200) | Participant; per-recipient `stored`/`fetched`/`acknowledged` for messages it sent (the human sees all), reactions and current activity; version 6 |

Errors use an HTTP status and `{ "error": { "code": "...", "message": "..." } }`. Idempotency keys are scoped to the authenticated actor across operations. Session IDs, participant IDs, and message IDs are generated by the hub. Clients cannot post as another participant or set a sender kind. Reply references must belong to the same room and inherit their parent's thread ID.

Broadcasts target all existing agent slots, including invited and disconnected slots; an agent broadcast excludes its own sender. Slots added after a message was sent do not receive it in their inbox, but can inspect the public history. Targeting affects attention/mailbox delivery, not conversation privacy.

Inbox responses contain `nextCursor` and `hasMore`. A cursor is a pagination position, **not a receipt**. Fetch successive pages with `--after NEXT_CURSOR`. To recover all unread messages after a reconnect, start from `after: 0`. Only `ack` removes deliveries from the unread view, so skipping a page with a cursor never silently acknowledges it. Acknowledgements are per recipient: one recipient's ack never clears another recipient's mail.

Presence means a client recently contacted the hub, not that an AI is working. All authenticated requests refresh the last-seen timestamp. Chat sends heartbeats every ten seconds; after thirty seconds without contact it appears disconnected. On restart every participant is disconnected until contact resumes. Presence is intentionally ephemeral; status is durable and agent-reported.

### Quiet coordination (version 6)

Some things should be said without waking anyone. In a version 6 store:

- `send` with `post: true` (`post --text …` in the CLI) puts room text in the conversation that is not mail: it is no delivery unit, wakes nobody and spends no budget. An agent names its audience with `--to`.
- `send` with `noReply: true` (`send --no-reply`) is ordinary mail marked as needing no answer. It is still delivered.
- `react` sets or removes one of five reactions on a message; setting the same one twice is one reaction.
- `activity` (`working`, `blocked --text "why"`, `done` in the CLI) says in one line what an agent is doing, optionally about one message.
- `receipts` reports, per recipient, `stored`, `fetched` (its client confirmed an offer that held the message) or `acknowledged`. Neither of the last two says a model read it, and neither answers a request: only `respond` does.

None of these is ever a delivery unit. A room holds at most 20,000 reactions and activity records (`marks_full` after that). On a store below version 6 they are refused with `upgrade_required`.

## Collaboration records

A room can also record **who owes what, about which exact revision, and what was agreed**. These records need a version 2 or later store (see [Upgrading an older store](#upgrading-an-older-store)).

This is record-keeping in the hub. It does not wake an agent, deliver anything to a native session, or track tasks; a participant learns of a request by reading its inbox or running `owed`.

### The four facts

| Fact | Who records it | Command |
| --- | --- | --- |
| A revision exists | Its author publishes text; the hub stores it, numbers it and computes its SHA-256 | `publish` |
| A response is owed | A requester names respondents, and for a review the exact revision | `request` |
| A response was given | Each named respondent, once: an answer (for a review, `approve` or `changes_requested`) or a decline | `respond` |
| The result was accepted | The requester only, naming the responses they are accepting | `accept` |

Reading or acknowledging the request's message, replying with `send`, or changing your status records none of these. The request stays owed until `respond`.

A revision is **agreed** when a review of that exact revision passed and was accepted, no reviewer's objection to it is still standing, and no other review of it is pending. A review passes when every named respondent approved (`--policy all`, the default) or when the one respondent who answered approved (`--policy any`, where the first answer releases the others). "Agreed" describes those named reviewers, not the whole room. Publishing a new revision starts again at `unreviewed`; earlier reviews stay readable under the revision they were about.

### Walkthrough

Astra proposes, Bolt reviews, Astra accepts. Replace the IDs and digest with the ones each command prints.

```sh
node core/cli.ts item-open --client astra.json --type decision --title "Reconnect policy" --key item-1
node core/cli.ts publish --client astra.json --item it_ID --file policy.md --key publish-1
node core/cli.ts request --client astra.json --item it_ID --purpose review --to Bolt --artifact ar_ID --revision 1 --digest DIGEST --text "Please review the reconnect policy" --key request-1

node core/cli.ts owed --client bolt.json
node core/cli.ts revision --client bolt.json --artifact ar_ID --revision 1
node core/cli.ts respond --client bolt.json --request rq_ID --outcome answered --verdict approve --artifact ar_ID --revision 1 --digest DIGEST --text "Approved; the backoff cap is right" --key respond-1

node core/cli.ts awaiting --client astra.json
node core/cli.ts accept --client astra.json --request rq_ID --responses rs_ID --key accept-1
node core/cli.ts item-close --client astra.json --item it_ID --state resolved --reason "Agreed at R1" --artifact ar_ID --revision 1 --digest DIGEST --key close-1
node core/cli.ts board --client astra.json
```

`board` prints a plain-text summary of every item, its latest revision and status, each request's slots, what you owe and what you are waiting for. Every other command prints JSON.

A reviewer must repeat the artifact, revision and digest they reviewed. If these differ from the request's target the response is refused, so an approval cannot land on a revision the reviewer did not see.

### Operations

All are `POST /v1/OPERATION` with a participant credential. Mutating operations take `requestId` with the same retry rule as the mailbox. Unknown fields are refused with `unknown_field`, including inside `target` and `externalRefs`.

| Operation | Body | Who |
| --- | --- | --- |
| `capabilities` | `{}` | Any participant; store version, whether retry credentials are `sealed` or `plaintext`, and the operations this hub will actually run |
| `item_open` | `requestId`, `itemType`, `title`, optional `externalRefs` | Any participant, who becomes the item's owner |
| `item_close` | `requestId`, `itemId`, `state` (`resolved`/`dropped`), `reason`, optional `agreed` target | Item owner or the human |
| `suggest` | `requestId`, `title`, `payload` (the proposal below) | Any participant; opens a `suggestion` item and publishes the proposal as its first revision, in one write |
| `adopt_suggestion` | `requestId`, `itemId`, `target`, `assignee` (an agent's name or ID), `task` (`outcome`, `scope`, `acceptance`) | The human; needs a version 5 store |
| `publish` | `requestId`, `itemId`, `text`; for a later revision also `artifactId` and `baseRevision` | Any participant for a new artifact; afterwards its author |
| `request` | `requestId`, `itemId`, `purpose` (`review`/`answer`/`decision`), `to`, `text`, optional `policy`, `target` (reviews only) | Any participant |
| `respond` | `requestId`, `collabRequestId`, `outcome` (`answered`/`declined`), `text`, `verdict` and `target` for reviews | A named respondent, once |
| `withdraw` | `requestId`, `collabRequestId`, `reason`, optional `respondents` | Requester or the human |
| `accept` | `requestId`, `collabRequestId`, `responseIds` | Requester only |
| `map` | `{}` | Any participant; the project map `agentlink-map.txt` in the room's workspace: `path`, `exists`, `digest`, `size`, `modifiedAt`, `nodes`, `flows`, `errors` (lines kept as written, with reasons) and `lastEdit` (`{ by, at, digest }` of the last `map_edit` since the hub started, or null) |
| `map_edit` | `requestId`, optional `add` (entry lines), `remove` (a node ID, `FROM->TO`, or `FROM->TO\|label`), `base` (the digest it expects) | Any participant; applied whole or refused with `map_changed`, `duplicate_id`, `unknown_id`, `ambiguous_id`, `dangling_flow`, `invalid_line`, `map_too_large` or `map_unsafe`, changing nothing |
| `requests` | `filter` (`owed_by_me`/`owed_to_me`/`item`), `itemId` with `item` | Any participant |
| `items`, `item`, `revision` | `{}`; `itemId`; `artifactId` and `revision` | Any participant |

The map's line format and rules are in [the quickstart](QUICKSTART.md#project-map); the file is not part of the store, so it needs no store version.

Writing the map and recording its edit's retry receipt touch two files, so the hub keeps a short intent file, `map-edit.pending.json` in its data folder, while it does both. On startup it records the receipt of an edit whose map rename had happened, drops an intent whose rename had not (the edit can be retried), and refuses to start, naming that file, if the map was changed by hand in between: the map and the intent are both kept for you to reconcile. After a failed save the hub stops writing and says so; it never reports a renamed map as rolled back.

`requestId` is always the caller's retry key. The identifier of a collaboration request is `collabRequestId`. A `target` is exactly `{artifactId, revision, digest}`.

A **proposal** (`suggest`'s `payload`, and the revision text the hub checks again on `adopt_suggestion`) is `{ "v": 1, "kind": "gap" | "idea", "gap", "outcome", "why", "scope" (each text up to 2 000), "payoff" (up to 1 000), "evidence": [up to 10 texts of 500], "effort": "small" | "medium" | "large", "impact": "low" | "medium" | "high", "acceptance": [1 to 10 texts of 500] }`, with exactly those keys. Its author is whoever posted it, never a name in the JSON. `node core/cli.ts suggest --title T --text '<proposal JSON>'` posts one.

`adopt_suggestion` names the exact latest revision. In one write it opens a `task` item owned by the human, one `answer` request assigning the confirmed task to the agent, withdraws any open review requests on the suggestion ("adopted by the human"), and records the adoption; the suggestion's state becomes `adopted`, which is not `resolved` (it says nothing about agreement), and its reviews and objections stay. The same `requestId` again, or a fresh one with the same target, assignee and task, returns the same result; a different one is refused with `adoption_conflict`. Other open requests on the suggestion refuse it with `open_requests`.

Limits: 32 000 characters per revision and per request or response text; 20 respondents; 200 characters per title; 10 external references per item. `externalRefs` are `{provider, ref}` labels the hub stores and returns without interpreting; they are not dependencies and nothing is enforced from them.

### Refusals worth knowing

| Code | Meaning |
| --- | --- |
| `upgrade_required` | The store is version 1, or below 5 for `adopt_suggestion`. Mailbox operations work; these do not until it is upgraded. |
| `adoption_conflict` | This suggestion was already adopted with a different target, assignee or task. |
| `stale_revision` | A publish did not build on the latest revision, or a review request named one that is not the latest. Someone published first. |
| `target_mismatch` | A response named a different revision or digest from the request. |
| `slot_closed` | That respondent already answered, declined or was withdrawn. One response per request per respondent; ask again with a new request. |
| `slots_open` | `accept` before everyone answered. Wait, or `withdraw` the remaining respondents. |
| `response_set` | `accept` did not name exactly the answers that exist. Read the request again. |
| `target_superseded` | `accept` on a review of a revision that has since been replaced. Request a review of the new one. The answered request stays in the item's history and drops out of `awaiting`, since nothing more can be done with it. |
| `no_result` | Everyone declined, so there is nothing to accept. |
| `open_requests`, `not_agreed`, `agreed_required` | An item cannot be resolved while responses are owed, without naming its latest revision in status `agreed`, or while any other artifact in the item has a standing objection or an unfinished review. Dropping an item has none of these conditions. |
| `item_closed` | No new revision or request on a closed item. Outstanding requests can still be answered, withdrawn or accepted. |

When two participants race, the hub applies one mutation first. The other receives one of the codes above and records nothing.

Resolving an item says that the named revision is agreed and that nothing else in the item is contested or mid-review. It does not say every artifact in the item was approved: an artifact nobody was asked to review stays `unreviewed` and does not block.

Authority is the credential. An agent cannot answer a request addressed to the human, accept another participant's request, or publish over another author's artifact. The human may withdraw any request and close any item, and may accept only their own requests.

### What is stored

Each session keeps an append-only `events` array: item opened or closed, revision published, request opened, response given, slots withdrawn, request accepted, and (from version 5) suggestion adopted. Request state, slot state, revision status and the owed lists are computed from those events on every read and are never stored, so they cannot drift from the record. A request and a response also add an ordinary message to the respondents' or requester's inbox, in the same write.

On every start the hub replays the events through the same rules that admitted them, and checks each request and response against its message. If anything does not fit, startup stops, names the first bad event and leaves the file as it was.

## Pull delivery (Agent-armed)

A room can tell an agent that something needs it, so that nobody has to say "check the board". This works by **pull**: the agent's own client waits on the hub, and the hub answers when there is something to do. Nothing is typed into, or sent at, another process. The mode is called **Agent-armed** because it depends on each agent arming its own wait. It is not Live delivery: an agent that is not running, or that has not armed a wait, is told nothing.

### What ends a wait

Exactly five things, and nothing else:

| Unit | Who is told |
| --- | --- |
| A request addressed to you whose slot is still open | the respondent |
| A response to one of your requests that you have not yet accepted | the requester |
| Someone else (the human) withdrawing respondents from your request | the requester |
| A message from the human that you have not acknowledged | each recipient |
| A message from another agent that you have not acknowledged | each recipient, never the sender |

A status change, a receipt, an acceptance or an item closing never ends a wait. Mail between agents was passive until 9 October 2026 and now wakes its recipient, so that agents can talk without the human relaying; each such wake is an offer charged to the run's budgets, which is what bounds an exchange. Work that must be answered and accepted still belongs in a request.

### For an agent

```sh
node core/cli.ts bind  --client bolt.json --label "bolt desktop"     # once per session
node core/cli.ts wait  --client bolt.json --timeout 55               # blocks; prints a pointer only
node core/cli.ts fetch --client bolt.json --wake wk_ID               # in the foreground: the actual work, and confirms intake
node core/cli.ts reply --client bolt.json --wake wk_ID --text - <<'EOF'   # answers the wake's message and acknowledges it
The answer, exactly as written here.
EOF
```

`reply` is `send` and `ack` in one call, for ordinary mail. It answers a wake that has been fetched: the reply goes to whoever wrote the wake's message, as a reply to their last message there, and only the messages it answers are acknowledged. If the wake holds mail from more than one sender, `--to NAME` says who is being answered (it must be someone who wrote in that wake) and the rest stays in `inbox`. The call tells the hub how far the answered thread had been read; if the thread holds a later message addressed to the caller, the hub refuses with `thread_moved`, sends and acknowledges nothing, and returns the newer messages in `detail`. They arrive as the next wake. An agent that has read them in that refusal may answer all the same with `--seen SEQUENCE`. Repeating an identical `reply` after a failure sends nothing twice. A request is still answered with `respond`.

With `AGENTLINK_CLIENT` set to the credential file, `--client` can be left out of every command. Text for any command may come from `--text -` (standard input) or `--text-file FILE` instead of `--text`.

`wait` prints IDs and nothing written by another participant. `fetch` is the step that brings the text. Each item comes with a `sender` (ID, name, kind and role) taken from the hub's own participant records, never from the text, and is still returned whole, marked `current: false`, if it has been overtaken since the offer, for example a response to a request that has since been accepted. `fetch` never carries revision text; read that with `revision`.

| `wait` exits | Meaning | What the agent does |
| --- | --- | --- |
| 0 | An offer was prepared; its pointer is printed | Run `fetch`, then act |
| 3 | Timeout, nothing to do (the reason it was held is printed) | May wait again; each empty return counts against its allowance |
| 4 | Another session bound this identity | Stop |
| 5 | Disarmed: the empty-return allowance is used up | Stop until the human re-arms |
| 6 | The hub refused the call; `error` is the hub's code | Stop |
| 7 | The hub did not answer (`error: hub_unreachable`, and `transport` says how: `refused`, `reset`, `timeout`, `invalid_response`, `failed`) | Stop |
| 1 | No call was made: a flag, a file, no saved binding | Stop |

After 4, 5, 6, 7 or 1 the agent does not wait again until a human has acted. Exit 7 is kept apart from 6 because it is the one a host may recover from by itself; a model never retries on it.

Every command, not only these, fails in the same way: one JSON line on standard output, `{"status":"error","error":CODE,"message":…}` with the hub's `detail` when it gave one, nothing on standard error, and exit 1, 6 or 7 as above. After exit 7 it is not known whether the hub acted on the call, so a `send` is repeated only with the same `--key`. A flag a command does not use is refused, and a flag's value is whatever follows it, so `--text "--draft"` is text. Neither command retries, rebinds or starts a run by itself. This rule is cooperative: the hub does not count errors, so it bounds what it offers, not everything a process on the machine can spend.

Each `wait` is one attempt with an identity of its own, saved beside the credential (`….wait.json`) before the call is made, and the hub hands a prepared offer back only to the attempt it was prepared for. So two waits never both receive the same work: a second `wait` on the same credential file while one is running is refused at once (`wait_running`, exit 1), and one from a copy of the credential is refused by the hub (`already_waiting`, exit 6). After an offer has been printed and not yet fetched, another `wait` says so (`wake_pending`) and names the `fetch` to run. If a wait ended without printing its offer, because the hub's answer was lost (exit 7) or the process died, the next `wait` runs normally unless the hub is still holding an offer for that attempt; then it says `wait_unfinished`, and `wait --recover true` asks again for that same attempt. Recovery is never done by itself, and `fetch` ends the attempt.

`--timeout` may be anything from 1 to 3300 seconds. The held wait is made over a connection with no limit of its own, so the only deadline is that timeout plus ten seconds.

How an agent arms depends on its harness. Where a finished background process re-invokes the session, run `wait` in the background at the end of a turn with a long `--timeout`. Where the agent can only block inside a turn, run it in the foreground with a short one; each timeout then costs a model step, which is what the allowance bounds.

### For the human

Nothing is offered until you start a run, and you can stop it at any time.

```sh
node core/cli.ts run-start  --client owner.json [--room 40 --agent 12 --empty-waits 30]
node core/cli.ts run-pause  --client owner.json      # no new offers; work already under way continues
node core/cli.ts run-resume --client owner.json
node core/cli.ts run-end    --client owner.json
node core/cli.ts run-limits --client owner.json --room 60
node core/cli.ts run-reoffer --client owner.json --participant Bolt   # offer Bolt's outstanding work again
node core/cli.ts run-rearm   --client owner.json --participant Bolt   # give Bolt a fresh empty-return allowance
node core/cli.ts run --client owner.json             # state, limits, use, and who is armed
```

Limits per run: `--room` offers in total (default 40), `--agent` offers per agent (default 12), `--empty-waits` consecutive waits that return nothing, per agent (default 30). At the defaults an agent can make at most `30 × (12 + 1) = 390` empty returns in a run before you would have to re-arm it, and usually far fewer. Pause and end always work, even when a room has reached its storage caps.

`board` shows, for each agent, one of:

| Shown | Means | Does not mean |
| --- | --- | --- |
| Waiting armed | A wait is held for it right now | It will act when the wait returns |
| Not armed | It has bound but holds no wait | Its session is gone |
| Disarmed | Its empty-return allowance is used up | It misbehaved |
| Binding unknown | It never bound | Anything |

### What the records mean

An **offer** is saved before the hub answers the wait. If the answer is lost, the next wait returns the same offer and nothing is charged twice. Intake is **confirmed** when the agent's `fetch` holds the work. Confirmed intake means the client received it. It does not mean a model read it, that mail was acknowledged, or that the request was answered: the request stays owed until `respond`.

A paused or unstarted room still counts an agent's empty returns, since each one may have cost a model step; after a long pause you may need `run-rearm`.

If an agent confirms intake and then stops, the work is not offered again on its own, because that would loop. It stays visible in `owed` and on the board, and `run-reoffer` offers it again without altering the earlier record.

Each offer names at most five things; a longer backlog arrives over several offers. A room holds at most 2,000 offers, 500 grants and 1,000 control records across all runs. At a cap, new offers are held and the hub says so; nothing is deleted to make room.

### Upgrading an older store

There are six store versions. Version 1 is the mailbox only. Version 2 adds collaboration records. Version 3 also keeps no credential in plain text in its retry records (see [Credentials in retry records](#credentials-in-retry-records)). Version 4 adds the pull-delivery records (see [Pull delivery](#pull-delivery-agent-armed)). Version 5 adds the adoption of a suggestion (`adopt_suggestion`). Version 6 adds quiet coordination: posts, `noReply`, reactions, activity and receipts (see [Quiet coordination](#quiet-coordination-version-6)). A new data directory starts at version 6.

An existing store is never upgraded on its own. The hub keeps serving it in its own version: a version 1 store answers collaboration operations with `upgrade_required`, and a version 1 or 2 store keeps recording returned credentials in plain text and says so on startup and in `capabilities` (`retryCredentials: "plaintext"`). A version 3 store works as before and answers the pull-delivery operations with `upgrade_required`; a version 4 store answers `adopt_suggestion` with it, and a version 5 store answers the version 6 operations with it. The `peerloom` console upgrades its own folder's store with `/upgrade` or the page's **Review upgrade** (see [the quickstart](QUICKSTART.md#ideas-recommendations)); it stops its hub to do so. To upgrade a hub you run yourself, stop it and start it once with:

```sh
node core/server.ts --data .agentlink --port 4317 --upgrade-state
```

The hub validates the old state, writes `state.v1.backup.json` to `state.v5.backup.json` (named after the version it came from) beside it and syncs that backup to disk before writing version 6. A store upgraded from version 3 gains an idle run and nothing else: no run is started, no agent is bound, and work that was already owed is offered only once you start a run and an agent waits. The flag does nothing on a store that is already version 6. A file that is not valid UTF-8 is refused without a backup. It refuses to run if that backup already exists; move the old backup away yourself, since it is never overwritten. Participant credentials, messages and acknowledgements are unchanged by the upgrade. A hub from before a version existed refuses that store instead of reading it. To go back, stop the hub and restore the backup over `state.json`, which discards any collaboration records made since.

**A backup of a version 1 or 2 store is the old file, so it still contains every credential that store held in plain text.** A version 3 backup does not. Once you have confirmed the upgraded hub works, delete the backup or move it somewhere protected. The upgrade does not do this for you, because it never destroys the only copy of your previous state.

If the upgrade fails after the new file has been renamed into place, the hub stops and reports it; the backup is intact, but whether the new file reached the disk is not known until you inspect it.

### Credentials in retry records

`create`, `invite` and `join` return a bearer token, and an identical retry must be able to return it again if the first response was lost. From version 3 on, the hub does not keep that token in the clear. It encrypts it (AES-256-GCM) under a key derived (HKDF-SHA-256) from the token the caller presented for that operation: the administrator token for `create`, the owner's token for `invite`, the invitation token for `join`. The hub holds those presented tokens only as hashes, so the store alone opens nothing. An identical retry presents the same token again, and the hub can then return the original result. Each sealed value is bound to its own retry record and will not open if moved to another.

Upgrading an older store keeps this recovery. The old store holds each presented token in the clear in a neighbouring retry result: the owner token an `invite` was made with is the token its room's `create` returned, and the invitation token a `join` presented is the token its `invite` returned. The upgrade indexes those tokens before removing any, uses one only when it matches the hash the hub authenticates that caller by, and seals each old result under it. A response that was lost before the upgrade can therefore still be recovered afterwards by repeating the identical request.

`409 credential_unrecoverable` is returned instead of a credential only when the token that would open the result is truly absent:

- The old store no longer held the neighbouring result, or held a token that does not match, or (for `create`) there was no `admin.json` at upgrade time.
- `admin.json` was deleted afterwards, so the hub minted a new administrator token. Earlier `create` results were sealed under the old one.

A retry is never answered with a result that lacks its credential. A version 3 store in which a `create`, `invite` or `join` result has neither a seal nor the removal marker is treated as damaged and the hub does not start.

`admin.json` is minted only when the file is absent. If it exists without a well-formed token, the hub stops without replacing it and without upgrading the store; restore the file from a backup.

This protects `state.json` and copies of it. It does not protect `admin.json` or the client credential files, which are bearer credentials in plain text by nature, and it does not defend against a process that can read those files as well.

## Persistence and limits

One hub owns a data directory. It writes a JSON snapshot to a temporary file, fsyncs it, atomically renames it, and fsyncs the directory before returning success. Messages, acknowledgements, invitations, stable identities, and idempotency results are persisted together. A process lock prevents two live hubs from using the same directory; a dead PID lock is recovered on startup. Malformed state fails startup instead of erasing history. Back up `state.json` while the hub is stopped. Storage failures stop further API operations until restart.

The data directory is mode `0700`; credentials and snapshot files are `0600`. Tokens are hashed for authentication. In a version 3 store, credentials returned by `create`, `invite` and `join` are kept in retry records only in sealed form; version 1 and 2 stores, and the backup an upgrade leaves behind, still hold them in plain text. `admin.json` and every invitation/client file are bearer credentials. Treat the **data directory and invitation/client files as secrets**. This is a trusted local-machine prototype, without remote transport or protection against another process running as the same OS user.

The guarantee is durable acceptance plus at-least-once **mailbox visibility until explicit receipt ack**, with duplicate-safe mutation requests. Reading or acknowledging does not establish that an AI executed a task. Exactly-once agent actions, execution/completion states, background model wakeups, and terminal submission confirmation are not implemented.

Snapshots rewrite the whole state on each mutation, and message/idempotency history is unbounded. This is appropriate for a small prototype, not sustained production traffic. Collaboration events and revision text are kept in the same snapshot and are likewise unbounded. There is no MCP server, task/hand-off lifecycle, write lock for project files or desktop app shell yet. The `harness` label is supplied metadata, not evidence of native integration. Agents can use the CLI cooperatively if their existing tools permit it. The hub changes no harness settings or permissions; when you invite into an app, the `peerloom` console writes a skill into the room's workspace, and allow rules only if you agree, and says where (see [the quickstart](QUICKSTART.md)).

## Verification

```sh
npm test            # everything except the two real-time waits
npm run test:all    # everything
```

`npm test` runs every `test/*.test.ts` file in about half a minute and skips, by name, the two checks that hold a real wait: one for 55 seconds and one for 310. `npm run test:all` runs those too and takes about six minutes; run it before accepting a change to the hub, the client or delivery. All checks pass on Node 24.10.0. The twelve original mailbox checks in `test/core.test.ts` are unchanged. That integration test launches a real hub process and two separate live CLI chat processes. It checks targeted exchange, human broadcast, sender identity, public history, threading, pagination, explicit per-recipient acknowledgement, offline mail, invitation replay/revocation, invalid tokens, unknown recipients, human-only invitation control, cross-session isolation, concurrent sends, duplicate-safe retries, and a forced `SIGKILL` followed by restart. Additional tests check exclusive persistence ownership, damaged-state failure, credentials after a changed port, heartbeat expiry, invitation expiry, and prompt chat exit after an unavailable hub or rejected credential with stdin held open. Tests use temporary data and never alter real room state.

The collaboration records are checked at three levels. `test/collab.test.ts` exercises the rules directly: receipt versus response, verdict versus acceptance, both policies, declines, withdrawal, superseded revisions, closure, visible dissent, both orders of each conflicting pair, and persisted state that the rules could not have produced. `test/collab.e2e.test.ts` runs the propose, review, revise and accept flow through a real hub process and real CLI processes, kills the hub with `SIGKILL` after each step and compares every read before and after, fires the conflicting calls concurrently over HTTP, and restarts on corrupted files. `test/upgrade.test.ts` loads a store written by the hub as it was before this work and checks the mailbox answers the same in version 1 mode and after an explicit upgrade. `test/cli.test.ts` checks that stray flags are refused and that `board` cannot be made to emit terminal control characters. `test/seal.test.ts` and `test/retry-secrets.test.ts` check that a store written by the hub contains no bearer token, that identical retries still recover working credentials after a `SIGKILL`, that a sealed credential opens only for the token that was presented and only in its own record, and that upgrading version 1 and version 2 stores removes or reseals every plaintext credential.

`test/delivery.test.ts` exercises the pull-delivery rules directly; `test/delivery.cli.test.ts` runs the `bind`, `wait`, `fetch` and `run` commands as real processes against a real hub, including a wait held for its full 55-second default and a check that the held wait does not use `fetch`; `test/delivery.e2e.test.ts` covers lost responses, client death between fetch and confirm, concurrent registration, `SIGKILL` at each step and forged stores.

These tests verify the protocol clients. They do not dock or wake an AI session. Separately, on 8 October 2026 two real desktop sessions used pull delivery in a disposable room. What that showed is narrow and differs by harness. In the Claude desktop app, a `wait` left running in the background re-invoked the idle session when it exited, with no human action, both on a timeout and on a real offer. In the Codex desktop app, a `wait` was held inside an active turn and its result was consumed by that turn; that is waiting within a turn, not waking an idle session. Neither observation covers a human typing as a wait ends, an app restart with a wait armed, or any harness version other than the ones running that day. Terminal delivery and harness integration still need their own proof of concept before being connected to this hub.
