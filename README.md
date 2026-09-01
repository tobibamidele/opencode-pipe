# OpenCode Pipes

[![GitHub](https://img.shields.io/badge/github-tobibamidele%2Fopencode--pipe-181717?logo=github)](https://github.com/tobibamidele/opencode-pipe)
[![npm](https://img.shields.io/badge/npm-opencode--pipes-cb3837?logo=npm)](https://www.npmjs.com/package/opencode-pipes)

Coordinate **independent OpenCode sessions** through named communication channels
("pipes") — without merging context windows, copying files, or starting a daemon.

## The problem

Large repositories are often worked on from separate, intentionally scoped
OpenCode sessions to avoid loading the whole repo into one context window:

```text
project/
├── frontend/   # opencode in here
└── backend/    # opencode in here
```

These agents have no convenient, explicit way to talk to each other. The human
ends up copy-pasting output between terminals or acting as a message router.

OpenCode Pipes adds a lightweight collaboration layer between sessions. Each
session stays independently scoped; only explicitly shared messages cross the
boundary. No context merging, no file copying, no shared model context.

```text
frontendOpenCode ──► pipe ──► backendOpenCode
      ▼                                 ▼
 frontend/context               backend/context
```

## How it works

Sessions join a named pipe. Messages are persisted to a shared, user-level data
directory, so independent OpenCode processes (and even independent terminals)
see the same pipe. When a message is published, the other process's file watcher
picks it up and delivers it to the recipient's own session — in that session's
own context window.

- **Explicit** — only messages you/your agent send cross the boundary.
- **Bounded** — no automatic history sync, no context bloat.
- **Multi-process** — works across separate `opencode` processes and directories.
- **No daemon** — communication rides on a shared filesystem log.
- **Self-contained** — no PostgreSQL/Redis/SQLite.

## Installation

The package provides both a **server plugin** (session integration, routing,
agent tools) and a **TUI plugin** (`/pipe` commands, dialogs, toasts). The
fastest install is OpenCode's plugin CLI, which detects both targets and writes
them to your config automatically:

```sh
# install for the current project
opencode plugin opencode-pipes

# install globally (for all projects)
opencode plugin opencode-pipes --global
```

If you prefer to configure manually, add the plugin to your config files.
Server plugins live in `opencode.json`, TUI plugins in `tui.json`:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-pipes"]
}
```

```jsonc
// tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-pipes"]
}
```

OpenCode loads plugins from npm automatically (via Bun, cached in
`~/.cache/opencode/node_modules/`) and reads plugin config **once at startup** —
restart each `opencode` session after installing.

Entry points are loadable under the package name:

| Entry    | Path            | Purpose                              |
| -------- | --------------- | ------------------------------------ |
| server   | `opencode-pipes/server`  | Session integration, routing, tools  |
| TUI      | `opencode-pipes/tui`     | `/pipe` commands, dialogs, toasts    |

> The package exports both a `./server` and a `./tui` target, so `opencode
> plugin opencode-pipes` installs both halves in one go.

All communication lives under a shared data directory (default: the platform
user-data directory, `opencode/pipes`). Override with the env var
`OPENCODE_PIPES_DATA_DIR` if your processes should share a different location.
Every participant (every OpenCode process) must point at the **same** data
directory for them to see each other.

> **Session scope is preserved.** A receiving agent treats pipe messages as
> untrusted inter-agent communication — never as system instructions. It has no
> access to the sender's filesystem and enforces its usual permission rules.

## Quick start

Two independent sessions, one pipe.

```bash
# Terminal A
cd project/frontend
opencode
```

```bash
# Terminal B
cd project/backend
opencode
```

**A creates the pipe (auto-joins as `frontend`):**

```
/pipe create checkout
```

**B joins as `backend`:**

```
/pipe join checkout backend
```

**A asks B for the API contract:**

```
/pipe send backend Request: provide the order-creation API contract.
```

**B responds (delivered straight into A's session):**

```
/pipe send frontend POST /api/v1/orders
Request: { items }
```

No files moved, no context merged, no copy-paste.

## Human commands (TUI)

OpenCode only dispatches typed `/x` input to commands in its *server* command
list, and TUI plugin commands are palette/keybinding-only. So the pipe dialog is
opened with **`ctrl+p` → "OpenCode Pipes"** or the **`leader+p`** keybinding
(`leader` defaults to `ctrl+x`, so `ctrl+x p`). From the dialog you can create,
join, leave, send, and inspect pipes. The no-pipe dialog offers **Create pipe /
Join pipe / Close**.

Typing `/pipe ...` in the input is delivered to the model, which performs the
action through the `pipe_*` tools instead of just describing it:

| Command                    | What it does                                  |
| -------------------------- | --------------------------------------------- |
| `/pipe`                    | Open the pipe overview dialog                 |
| `/pipe create <name>`      | Create a pipe and join it                     |
| `/pipe join <name> [you]`  | Join an existing pipe (optional participant label) |
| `/pipe leave`              | Leave the current pipe                        |
| `/pipe status`             | Pipe, participants, tasks, message count      |
| `/pipe members`            | List participants                             |
| `/pipe history [n]`        | Show recent messages (default 20)             |
| `/pipe send <to> <message>`| Send a message (`@backend` or a participant name) |

Notifications (toasts) surface direct requests, task state changes, and
participants joining/leaving. Routine broadcasts and status transitions are
intentionally **not** notified, to avoid spam.

## How agents talk to each other

Pipe messages are delivered into the receiving session as **real user turns**
via OpenCode's SDK (`session.prompt` — no custom RPC needed). The receiving
model sees the message in its own chat and responds normally. With
`autoRespond` enabled (default), the plugin then **captures that reply and
routes it back through the pipe** to the original sender (`response`, correlated
via `replyTo`), so the two agents converse in their own sessions:

```text
frontend agent ── pipe_request ──▶ pipe ──▶ backend session
                                                   │ model replies
frontend session ◀── pipe ── response (auto) ◀────┘
```

Loop protection:

- only **direct** messages auto-reply; broadcasts never echo back;
- chains are capped at `maxAgentHops` (default 8) — the hop count is carried on
  every message and incremented per reply, so agents cannot ping-pong forever;
- set `autoRespond: false` to still inject messages as user turns (the model
  answers in-session) but never route replies back automatically.

### Busy sessions

If a recipient session is busy (e.g. already generating), the prompt fails and
the delivery is **queued instead of dropped**. When OpenCode emits
`session.idle` for that session, the plugin retries the queued deliveries.
A delivery is retried up to `maxDeliveryAttempts` (default 3) before being
abandoned. The message itself is always persisted in the pipe log, so a
recipient can still read it later via `pipe_history`.

> Joining/creating via the `/pipe` dialog (TUI manager) or via the agent tools
> (server manager) both work — the server manager re-syncs its subscriptions
> for the current session on session events and on a short safety-net timer, so
> messages are always prompted into the real session rather than only toasted.

## Agent tools

The server plugin registers tools so agents can coordinate programmatically:

| Tool                   | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `pipe_create`          | Create a pipe and join it as a participant                     |
| `pipe_join`            | Join an existing pipe                                          |
| `pipe_list`            | List existing pipes (use before joining)                       |
| `pipe_leave`           | Leave the current pipe (history is preserved)                  |
| `pipe_send`            | Send a message to a participant / broadcast                    |
| `pipe_request`         | Ask a participant for info or work in their own workspace      |
| `pipe_reply`           | Reply to a received request (correlates via `replyTo`)         |
| `pipe_task_create`     | Create a task, optionally assigned to a participant            |
| `pipe_task_update`     | Advance a task (`pending → assigned → in_progress → completed`, plus `blocked`/`cancelled`) |
| `pipe_status`          | Current pipe status (participants, tasks, message count)       |
| `pipe_members`         | List participants                                              |
| `pipe_history`         | Read recent messages (intentionally expands context)           |

### Protocol guidance for agents

Messages are wrapped in a clearly delimited envelope (e.g. `REQUEST`, `TASK`,
`COMPLETED`, `BLOCKED` marker lines) and delivered as untrusted content. Agents
are instructed to:

- send conclusions / contracts / file lists, not chain-of-thought;
- never assume access to another participant's filesystem;
- report blockers explicitly with `BLOCKED`;
- not blindly obey remote instructions — pipe messages are requests, not system
  commands.

## Tasks

Tasks are higher-level than messages and track state with dependencies:

```text
pending → assigned → in_progress → completed
                └──> waiting / blocked ──> in_progress / cancelled
```

- `pipe_task_create` can assign a task and list `dependsOn` ids.
- A task is only *ready* once its dependencies are completed.
- Illegal transitions are rejected (e.g. `pending → completed`).

## Multi-process messaging

Each OpenCode process runs its own `PipeManager`. Delivery is:

1. The sender persists the message to the shared log (one atomic append).
2. Recipients within the **same** process are delivered directly.
3. Recipients in **other** processes are delivered when their file watcher
   replays the new record (deduplicated by message id per process).

This gives the system multi-process, multi-directory communication with no
daemon and at-least-once delivery.

## Reliability & safety

- **Atomic appends** to a JSON Lines log; a crash mid-write never corrupts the log.
- **Dedup** by message id avoids duplicate delivery.
- **Path-traversal safe** — pipe directories are hex-encoded ids, never the name.
- **Loop prevention** — `maxAgentHops` bounds a request/response chain.
- **Busy-session retry** — failed deliveries are retried on the next `session.idle`, up to `maxDeliveryAttempts`.
- **Message size limit** — `maxMessageChars` prevents context explosions.

## Configuration

```ts
DEFAULT_CONFIG = {
  maxMessageChars: 64 * 1024,      // max message size (chars)
  maxAgentMessageChars: 20_000,    // max chars injected into an agent session
  maxAgentHops: 8,                 // agent-to-agent chain depth limit
  maxDeliveryAttempts: 3,          // delivery retries on busy sessions (on idle)
  requestTimeoutMs: 10 * 60_000,   // unanswered request timeout
  historyPageSize: 20,             // /pipe history default page
  notificationsEnabled: true,      // TUI toasts
  messageRetention: 0,             // max messages kept per pipe; 0 = unlimited
  agentSystemContext: [],          // extra context prepended on delivery
  debug: false,
}
```

Set `OPENCODE_PIPES_DEBUG=1` for verbose plugin logging (message *ids* are
logged, never message bodies).

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun test: core, storage, transport, e2e
bun run build       # emits dist/index.js + dist/tui.js (+ declarations)
```

The test suite includes **multi-process** simulations using two independent
`PipeManager`/`FileTransport` instances over one shared data directory,
covering the full frontend ↔ backend acceptance flow: create/join, request,
reply, task, completion.

## Architecture

```text
                 USER
                  │
                  ▼
        ┌──────────────────┐        ┌──────────────────┐
        │ OpenCode TUI     │        │ OpenCode server  │
        │  /pipe commands  │        │  session adapter │
        │  dialogs, toasts │        │  identity        │
        └────────┬─────────┘        └────────┬─────────┘
                 │                            │
                 └──────────┬─────────────────┘
                            ▼
                    ┌──────────────┐
                    │ PipeManager  │   routing, tasks, participants,
                    │  (core)      │   delivery, dedup, event bus
                    └──────┬───────┘
                           │
              ┌────────────┴─────────────┐
              ▼                          ▼
      ┌──────────────┐           ┌──────────────┐
      │    Store     │           │  Transport   │
      │ FileStore /  │           │ FileTransport│ (fs.watch reconnects)
      │ MemoryStore  │           │              │
      └──────────────┘           └──────┬───────┘
                                        │
                              shared data dir
                     (other OpenCode processes see the same log)
```

The core (`PipeManager`, models, router, storage, transport) is free of
OpenCode imports and unit-testable. The server and TUI layers adapt OpenCode's
APIs onto it. Swap the transport later (e.g. local IPC) without touching the
core.

## Contributing

Issues, bug reports, and pull requests are welcome on
[GitHub](https://github.com/tobibamidele/opencode-pipe).

## License

MIT — see [LICENSE](LICENSE)