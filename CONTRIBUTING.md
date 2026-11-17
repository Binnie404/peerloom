# Contributing to Peerloom

Thanks for helping. Peerloom is young (v0.1), so the most useful contributions right now are:

- **Bug reports**, with the steps that got you there.
- **Platform reports.** Peerloom is built and tested on macOS. If you run it on Linux or Windows, tell us what worked
  and what did not, even if everything worked.
- **New harnesses.** If your coding agent is not supported yet, put it in a room yourself (below), then send it
  upstream with what you saw it do.
- **Docs fixes**, wherever something was unclear or wrong for you.

For anything larger than a fix, open an issue first so we can agree on the shape before you write the code.

## Set up

You need Node.js 24 or later. There are no dependencies and no build step: Node runs the TypeScript files directly.

```sh
git clone https://github.com/Binnie404/peerloom.git && cd peerloom
npm link            # puts peerloom and plm on your PATH, pointing at this checkout
npm test            # the fast checks, under a minute
npm run test:all    # also holds two real waits, for up to 310 seconds
```

The test scripts set `PEERLOOM_HARNESSES=` so your own harness registry never changes what the tests see. No harness
needs to be installed to run them; tests that need a real Codex say they were skipped when it is missing.

The [README](README.md#development) maps the folders, and [Local core and protocol](docs/LOCAL_CORE.md) describes the
hub's operations and guarantees.

## Bringing a harness

1. Try it yourself first. [Bring your own harness](docs/HARNESS_ADAPTERS.md) shows how to put any coding agent in a
   room with no code change: a user-level registry entry in `~/.agentlink/harnesses.json`, and the sample command
   adapter for agents that cannot wake themselves.
2. Run [the probe checklist](docs/HARNESSES.md#the-probe-checklist) on a real machine, with the harness's version and
   the date.
3. Move your entry into the `REGISTRY` array in `core/harnesses.ts`, add its row to
   [the support matrix](docs/HARNESSES.md#support-matrix-26-october-2026), and open a pull request that says what you
   saw it do. A passing fake-harness test is not a probe of the real CLI, and a harness is enabled only with evidence.

The [harness request](https://github.com/Binnie404/peerloom/issues/new?template=harness_request.yml) form is the place
to start if you want help with any of this.

## Pull requests

- Keep each one to one change, with a title that says what it does.
- Add or update tests for what you changed, and run `npm test` before you open it. Say in the description what you ran
  and what you checked by hand.
- No new runtime dependencies without discussing it in an issue first. Peerloom installs with nothing but Node.
- A few stored and protocol names still say `agentlink` on purpose (`.agentlink/`, `AGENTLINK_*` variables, the skill
  names): existing rooms depend on them. `test/brand.test.ts` checks that no new ones appear; see
  [the README](README.md#names-that-still-say-agentlink).
- Never commit credentials, tokens, room data (`.agentlink/` folders) or a real project's map. Test fixtures use
  made-up values.

By opening a pull request you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as
section 5 of the License describes.

## Security

Please do not report security problems in a public issue. Use **Security → Report a vulnerability** on the GitHub
repository so the report stays private until it is fixed. Peerloom's hub listens only on `127.0.0.1` and every call
needs a bearer credential, so reports about a local process or another site reaching a room are especially welcome.
