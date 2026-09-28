# Herm

![Herm startup splash screen](./assets/readme-splash.png)

Chat stays on the left. The sidebar and tabs expose model/profile state,
sessions, context, agents, analytics, skills, cron, toolsets, config, env,
memory, and kanban without leaving the terminal.

> **herm** /hɜːm/ _noun_ : a sculptured head of Hermes on a square stone
> pillar, used in ancient Greece as a boundary marker at crossroads.

> **Fork notice** — this is
> [`linux-fertxo/herm`](https://github.com/linux-fertxo/herm), a maintained fork of
> [`liftaris/herm`](https://github.com/liftaris/herm). Upstream `dev` has been frozen at
> `a0e4502` (2026-07-29), and Hermes Agent has since moved to desktop contract 8, which
> breaks the released TUI: `4000 invalid params` on most RPCs, and blocking prompts
> (clarify/approval) that never appear because the agent quietly answers them itself.
> This fork restores Herm against current Hermes.
> **Do not install the npm `herm-tui` package for this fork** — that is upstream's frozen
> build. See [what this fork changes](#what-this-fork-changes).
> Maintained by [`@linux-fertxo`](https://github.com/linux-fertxo).

## Why Herm

Herm gives Hermes Agent an operator-focused TUI instead of scattering work
across shell commands, config files, and browser windows.

- **Stay in the terminal** while chatting with Hermes Agent, resuming sessions,
  and inspecting context.
- **Operate your Hermes home** through dashboard tabs for profiles, skills,
  cron jobs, toolsets, config, env, and memory.
- **Run agentic work through kanban** with boards, task detail views,
  diagnostics, and dispatch controls.
- **Make the shell yours** with rebindable keys, a command palette, slash
  commands, theme picker, and profile switching.

Herm is built with [OpenTUI](https://github.com/anomalyco/opentui) and
[Bun](https://bun.sh/). It is a client for the Hermes Agent gateway, not a
separate agent runtime.

## Quickstart

Herm requires:

- a working [Hermes Agent](https://github.com/NousResearch/hermes-agent) install
- [Bun](https://bun.sh/) or a Node package runner
- a Hermes home at `~/.hermes`, or `HERMES_HOME` pointing somewhere else

Try Herm without installing:

> The `bunx`/npm `herm-tui` package is **upstream's frozen build** and does not work
> against current Hermes Agent. Use one of the fork installs below.

Install it globally, from a checkout (verified):

```bash
git clone https://github.com/linux-fertxo/herm.git
cd herm
bun install
bun run build
ln -sfn "$PWD/bin/herm.cjs" ~/.local/bin/herm   # bin/herm.cjs execs dist/index.js under Bun
herm
```

Or let Bun install it globally from the repository, running `src/index.tsx` from
source:

```bash
bun add -g github:linux-fertxo/herm
```

Run it:

```bash
herm       # fresh session
herm -c    # resume last session
```

Attach to an already-running Hermes dashboard instead of spawning a local
gateway subprocess:

```bash
herm --gateway-url 'ws://127.0.0.1:9119/api/ws?token=...'
```

HTTP(S) dashboard URLs are normalized to WS(S) and `/api/ws` is appended after
any path prefix. The URL must already carry a reusable `token` or `internal`
credential. OAuth-gated dashboards use single-use tickets and require an
authenticated client that can mint a fresh ticket for every reconnect. For
persistent configuration, set `HERM_GATEWAY_URL`. Herm also accepts the
upstream-injected `HERMES_TUI_GATEWAY_URL`.

Or run from source:

```bash
git clone https://github.com/linux-fertxo/herm.git
cd herm
bun install
bun run src/index.tsx
```

See [`.env.example`](./.env.example) for rarely-needed overrides.

## What you can do

### Chat with Hermes Agent

- Stream responses with markdown rendering, LaTeX-to-unicode conversion, inline
  images through `chafa`, diff chips, and expandable tool calls.
- Add file and diff context with `@` references.
- Use slash commands for session control, model switching, skins, keybindings,
  and app actions.
- Resume, title, and manage sessions without dropping back to another command.

### Operate your Hermes home

- Switch Hermes profiles from inside the TUI.
- Inspect and manage operational surfaces: sessions, context, agents,
  analytics, skills, cron, toolsets, config, env, and memory.

### Run kanban work

- Use the kanban tab as an agent work surface rather than a detached project
  board.
- Open board and task detail views, inspect diagnostics, and dispatch work from
  the same shell you use for chat.

### Share and install eikons

Eikons are 48×24 terminal avatars. The shipped lifecycle is deterministic:
discover, inspect, install, use, update, and remove.

In Herm:

- Open Eikon → Catalog, or run `/catalog`, to browse shared catalog
  entries.
- Preview rows before installing. Trust is shown as `Verified`, `Unverified`,
  or `Mismatch` beside source and compatibility state.
- Install adds the eikon to your local library without activating it.
- Use selects an installed eikon as the active avatar.
- Installing over the currently active eikon name also requires confirmation or
  `--active-ok` because it replaces the active avatar's backing package.
- Update or remove an active eikon only after confirming that the active
  avatar's backing package will change or be cleared.

From the shell:

```bash
herm eikon search [query] [--json]
herm eikon browse [query] [--json]
herm eikon inspect <name|url|dir> [--json]
herm eikon install <name|url|dir> [--name N] [--no-source] [--active-ok] [--json]
herm eikon list [--json]
herm eikon use <name> [--json]
herm eikon info <name> [--json]
herm eikon update <name> [--active-ok] [--json]
herm eikon remove <name> [--active-ok] [--json]
herm eikon delist <name|id> [--json]
```

`install` never activates. `use` is the activation action. JSON output is
available for automation with `--json`.

Default Catalog installs fetch built package artifacts referenced by the
catalog, not creator repositories. Direct GitHub installs are for sharing
outside the default catalog and support both single-package repos and
multi-eikon catalog repos addressed as `github.com/user/repo/eikon-name`.
Private GitHub repos use normal git authentication.

Creators can share Eikons through normal GitHub repositories. For official
registry listing, press `u` in Studio or use Library's Share to catalog action
after baking. Herm previews metadata, the prepared public bundle, and the GitHub
PR target; with local `gh` auth it creates the PR, otherwise it shows manual PR
steps with the prepared bundle path and compare URL. Direct-install repos can
still be prepared with upstream `eikon pack`, `eikon index`, and
`eikon manifest`.
`eikon publish` remains the lower-level GitHub PR contribution helper for the
configured/default catalog repo; it is not a hosted marketplace account, upload,
dashboard, or moderation flow.

Use `eikon.liftaris.dev` as a discovery gallery only; it previews catalog
entries and gives copyable Herm install instructions.

Herm owns native Catalog behavior. The eikon repo owns the registry,
browser mirror, shared catalog/player exports, install resolver, and publish
preflight. Herm imports public eikon package exports rather than browser mirror
internals or unexported source paths.

### Customize the shell

- Press `Ctrl+K` for the command palette.
- Type `/` for the slash popover.
- Type `/theme` to browse built-in themes.
- Type `/keys` to view and rebind keybindings, including OpenCode-compatible
  bindings.
- Use `Tab` / `Shift+Tab` to move between top-level tabs. Arrow keys navigate
  within a tab.

If text is hard to read in tmux or a dark terminal, try a light theme such as
`daylight`, `mercury`, or `github`. If tmux is the issue,
`set -g default-terminal "tmux-256color"` in `~/.tmux.conf` often fixes color
handling.

## What this fork changes

Upstream `dev` stopped at `a0e4502` (2026-07-29) while Hermes Agent kept moving;
the shipped TUI no longer talks to a current gateway. Everything below was
validated against Hermes Agent `0.21.5` (desktop contract **8**).

### What broke

1. **`session_id` was injected into every RPC.** Hermes validates params with
   `extra="forbid"` and only ~82 of its 237 methods declare `session_id`, so two
   thirds of the calls answered `4000 invalid params`. The error the TUI showed
   was *"run `hermes update`"* — pointing at the wrong culprit.
2. **The declared contract ceiling was 5.** A contract-8 backend made the client
   block every mutating RPC ("Hermes backend contract 8 is newer than Herm
   supports (4-5)"), which reads as a broken app but is a version gate.
3. **Blocking prompts became server→client requests (contract 7).** The backend
   sends `{"id":"srq-…","method":"clarify"}` and waits for a response frame. It
   only writes such a frame to a transport that has advertised
   `client.capabilities {server_requests: true}`; Herm never did, so
   `server_requests.send` returned `None` and **the agent silently answered its
   own questions** — the most misleading failure mode of the lot, because
   nothing errors.
4. **The `*.respond` RPCs are gone** (`clarify.respond`, `secret.respond`,
   `sudo.respond`, `terminal.read.respond` → `-32601 unknown method`).

### What changed here

- **The contract is read from the source of truth.** `src/context/gateway-contract.ts`
  consumes the artifact Hermes generates
  (`apps/shared/src/gateway-contract.openrpc.json`: ~237 methods, 82
  session-scoped, 73 notifications, 13 server requests) and resolves `$ref` plus
  `allOf`/`anyOf`/`oneOf`. `session_id` is only sent to methods that declare it,
  and methods whose names the artifact does not know lose the field instead of
  earning a `4000`. Installs without the artifact fall back to an embedded set.
- **Contract ceiling raised to 8.**
- **Server→client requests are answered.** Herm advertises the capability on
  `gateway.ready`, turns an incoming frame into the `*.request` event the
  transcript already renders (the frame id becomes the part id, so the outcome
  updates the card that was really asked), and replies with a JSON-RPC response
  `{jsonrpc, id, result}`: `{answer}` / `{answers}` for clarify, `{choice, all?}`
  for approval, `{value}` for sudo, secret and terminal reads. **The reply carries
  the frame's own id**, never a `request_id` a param may declare of its own —
  `approval` declares one, `clarify` does not, and letting that inner id win makes
  every answer land on a request the backend no longer considers open. Methods with no
  surface here (tour, vault prompts, preview/window reads) are declined
  immediately, so the backend does not sit out its full deadline — clarify's is
  an hour.
- **Questions survive a dropped socket.** `open_requests` returned by
  `session.resume`, `session.activate` and `session.events.since` are
  re-delivered, so a question re-appears as an answerable card; a card whose
  frame is gone says so instead of pretending it was answered.
- **Batch clarify.** A `questions` batch is walked one entry at a time and
  answered once with the whole `qid → answer` set; `Esc` sends `{}`, which the
  backend reads as cancel-all.
- **Dead RPCs purged** and approval answers routed through the request frame.

### Verified how

- `bun run test`: **1446 pass / 0 fail**; `bunx tsc --noEmit` clean;
  `bun run build` clean.
- **Live**, against a real gateway (0.21.5, contract 8): asking the agent to use
  `clarify` produced a real `srq` frame, the card rendered in the transcript
  (`ask ¿qué color pruebo?` · `1. rojo` · `2. azul`), pressing `2` answered the
  frame, and the agent acted on it ("Elegiste azul").
- `bun run test` pins `TZ=UTC TMPDIR=/tmp`. `bun test` runs the JS clock in UTC
  while `bun:sqlite` keeps the host zone, so date-bucketed fixtures shift a day
  on a non-UTC box; and a scratch dir whose ancestor has `.git` makes the
  `utils/git` test find a repository where it asserts none.

### Known limits

- **The pinned compatibility artifacts still describe `hermes-agent@4da7b9ee`**
  (July 2026). `gen-schema:check`, `gen-hermes-manifest:check` and
  `gen-fixtures:check` verify against that revision, not the installed one, and
  the extractor is pin-scoped: against a current Hermes it fails by design
  (methods moved to `tui_gateway/methods_*.py`, `DEFAULT_CONFIG` to
  `hermes_cli/config_defaults.py`). Moving the pin means regenerating the
  manifest, schema, fixtures and capability overlay in one go.
- Events newer than the pin are logged as `[event unknown]` in the gateway logs
  ring buffer; they are not rendered until the pin moves.
- `approvals.mode: smart` auto-approves whatever its auxiliary judge considers
  safe (including flagged `… | sh` pipelines), so approval cards legitimately do
  not appear in that mode. Use `manual` if you want to be asked.
- **No upstream PR.** `liftaris/herm` has had no maintainer activity since
  2026-07-29; these fixes live in the fork.

## Status and compatibility

Herm does not guarantee backward compatibility with older versions of Hermes.
Hermes is constantly updating, and things are bound to break. Regular Hermes
parity sweeps and updates are done to keep Herm current.

Herm is the dashboard TUI for Hermes Agent. It does not replace Hermes Agent,
implement model providers itself, or own Hermes runtime behavior.

For contributor review steps, see
[`docs/hermes_compatibility.md`](./docs/hermes_compatibility.md).

## Development

```bash
bun run dev
bun run typecheck
bun test
```

## Acknowledgments

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) - the agent
  runtime Herm operates
- [OpenTUI](https://github.com/anomalyco/opentui) - the TUI framework
- [OpenCode](https://github.com/anomalyco/opencode) - interface inspiration

## License

MIT - see [LICENSE](./LICENSE).
