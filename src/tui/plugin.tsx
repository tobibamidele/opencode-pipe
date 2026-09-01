/**
 * TUI plugin entry point (exported from the package "./tui"). Provides the
 * human-facing `/pipe` commands, dialogs, notifications, and active-pipe state.
 *
 * It owns its own PipeManager backed by the same shared on-disk store/transport
 * as the server plugin, so commands and agent tool execution stay in sync.
 */

/* @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiCommand } from "@opencode-ai/plugin/tui";
import { PipeManager } from "../core/pipe-manager.js";
import { FileStore } from "../storage/file-store.js";
import { FileTransport } from "../core/file-transport.js";
import { resolveConfig, type Config } from "../config.js";
import { defaultDataDir } from "../utils/data-dir.js";
import type { Pipe } from "../models/pipe.js";
import { parseChannel } from "../protocol/parser.js";

type Api = TuiPluginApi;

export function createTuiManager(input: {
  dataDir: string;
  config: Config;
  currentSessionId: () => Promise<string | undefined>;
}): PipeManager {
  const store = new FileStore(input.dataDir);
  const transport = new FileTransport(input.dataDir);
  return new PipeManager({
    store,
    transport,
    session: {
      async sendMessage() {},
      async sendNotification() {},
      async getStatus() {
        return undefined;
      },
      currentSessionId: input.currentSessionId,
    },
    config: input.config,
  });
}

export const PipesTui: TuiPlugin = async (api) => {
  const config = resolveConfig((api.tuiConfig?.plugin ?? {}) as Record<string, unknown> | undefined);
  const dataDir = defaultDataDir();

  const currentSessionId = async (): Promise<string | undefined> => {
    const route = api.route.current;
    if (route.name === "session" && route.params?.sessionID) {
      return route.params.sessionID as string;
    }
    return undefined;
  };

  const manager = createTuiManager({ dataDir, config, currentSessionId });
  const currentDirectory = () => api.state.path?.directory ?? process.cwd();

  const kvActivePipe = () => api.kv.get<string>("pipes:activePipeId") || undefined;
  const setActivePipe = (id: string | undefined) =>
    api.kv.set("pipes:activePipeId", id ?? "");

  function toast(
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    title = "OpenCode Pipes",
  ) {
    try {
      api.ui.toast({ title, message, variant, duration: 4000 });
    } catch {
      /* ignore */
    }
  }

  function close() {
    try {
      api.ui.dialog.clear();
    } catch {
      /* ignore */
    }
  }

  const requireActivePipe = async (): Promise<Pipe | undefined> => {
    const activeId = kvActivePipe();
    if (activeId) {
      const p = await manager.getPipe(activeId);
      if (p && p.status !== "closed") return p;
    }
    const sid = await currentSessionId();
    if (sid) {
      const pipes = await manager.listPipes();
      for (const pipe of pipes) {
        if (pipe.status === "closed") continue;
        const part = await manager.participants.bySession(pipe.id, sid);
        if (part) {
          setActivePipe(pipe.id);
          return pipe;
        }
      }
    }
    return undefined;
  };

  const commands: TuiCommand[] = [
    {
      title: "OpenCode Pipes",
      value: "pipe",
      description: "Open the OpenCode Pipes interface",
      category: "pipes",
      slash: { name: "pipe", aliases: ["p"] },
      onSelect: () => openMainDialog(),
    },
    {
      title: "Create a pipe",
      value: "pipe create",
      description: "Create a new pipe and join it",
      category: "pipes",
      hidden: true,
      onSelect: () => createPipeDialog(),
    },
    {
      title: "Join a pipe",
      value: "pipe join",
      description: "Join an existing pipe",
      category: "pipes",
      hidden: true,
      onSelect: () => joinPipeDialog(),
    },
    {
      title: "Leave active pipe",
      value: "pipe leave",
      description: "Leave the active pipe",
      category: "pipes",
      hidden: true,
      onSelect: () => leavePipe(),
    },
    {
      title: "Pipe status",
      value: "pipe status",
      description: "Show status of the active pipe",
      category: "pipes",
      hidden: true,
      onSelect: () => showStatus(),
    },
    {
      title: "Pipe members",
      value: "pipe members",
      description: "List participants of the active pipe",
      category: "pipes",
      hidden: true,
      onSelect: () => showMembers(),
    },
    {
      title: "Pipe history",
      value: "pipe history",
      description: "Show recent messages in the active pipe",
      category: "pipes",
      hidden: true,
      onSelect: () => showHistory(),
    },
    {
      title: "Send a pipe message",
      value: "pipe send",
      description: "Send a message to a participant in the active pipe",
      category: "pipes",
      hidden: true,
      onSelect: () => sendDialog(),
    },
  ];

  const unregister = api.command.register(() => commands);

  // ----- dialogs -----

  function openMainDialog() {
    void (async () => {
      const pipe = await requireActivePipe();
      if (!pipe) {
        api.ui.dialog.replace(() => (
          <api.ui.Dialog size="medium" onClose={close}>
            <api.ui.DialogAlert
              title="OpenCode Pipes"
              message="You are not in any pipe. Create or join one to collaborate."
              onConfirm={close}
            />
          </api.ui.Dialog>
        ));
        return;
      }
      const st = await manager.pipeStatus(pipe.id);
      api.ui.dialog.replace(() => (
        <api.ui.DialogSelect
          title={`Pipe: ${pipe.name} (${st.pipe.status})`}
          placeholder="Select an action"
          options={[
            { title: "Send message", value: "send" },
            { title: "List participants", value: "members" },
            { title: "Show status", value: "status" },
            { title: "Show history", value: "history" },
            { title: "Leave pipe", value: "leave" },
            { title: "Create pipe", value: "create" },
            { title: "Join pipe", value: "join" },
            { title: "Close", value: "close" },
          ]}
          onSelect={(o) => {
            switch (o.value) {
              case "send":
                sendDialog();
                break;
              case "members":
                showMembers();
                break;
              case "status":
                showStatus();
                break;
              case "history":
                showHistory();
                break;
              case "leave":
                leavePipe();
                break;
              case "create":
                createPipeDialog();
                break;
              case "join":
                joinPipeDialog();
                break;
              default:
                close();
            }
          }}
        />
      ));
    })();
  }

  function createPipeDialog() {
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Create pipe (name)"
        placeholder="e.g. checkout"
        onCancel={close}
        onConfirm={async (nameValue) => {
          const name = nameValue.trim();
          if (!name) return;
          const sid = await currentSessionId();
          if (!sid) {
            toast("No active OpenCode session.", "warning");
            return;
          }
          try {
            const { pipe } = await manager.createPipe(name, sid, currentDirectory());
            setActivePipe(pipe.id);
            toast(`Pipe "${pipe.name}" created. Joined as ${name}.`, "success");
          } catch (e) {
            toast(`Failed: ${(e as Error).message}`, "error");
          }
        }}
      />
    ));
  }

  function joinPipeDialog() {
    void (async () => {
      const pipes = (await manager.listPipes()).filter((p) => p.status !== "closed");
      if (pipes.length === 0) {
        api.ui.dialog.replace(() => (
          <api.ui.Dialog size="medium" onClose={close}>
            <api.ui.DialogAlert
              title="Join pipe"
              message="No pipes exist yet. Create one first."
              onConfirm={close}
            />
          </api.ui.Dialog>
        ));
        return;
      }
      api.ui.dialog.replace(() => (
        <api.ui.DialogSelect
          title="Join a pipe"
          placeholder="Select pipe"
          options={pipes.map((p) => ({ title: p.name, value: p.name }))}
          onSelect={(o) => {
            api.ui.dialog.replace(() => (
              <api.ui.DialogPrompt
                title={`Join "${o.value}" as`}
                placeholder="participant-name (optional)"
                onCancel={close}
                onConfirm={async (nameValue) => {
                  const sid = await currentSessionId();
                  if (!sid) {
                    toast("No active OpenCode session.", "warning");
                    return;
                  }
                  try {
                    const p = await manager.joinPipe({
                      pipeName: o.value as string,
                      sessionId: sid,
                      directory: currentDirectory(),
                      name: nameValue.trim() || undefined,
                    });
                    setActivePipe(p.pipeId);
                    toast(`Joined pipe "${o.value}" as ${p.name}.`, "success");
                  } catch (e) {
                    toast(`Failed: ${(e as Error).message}`, "error");
                  }
                }}
              />
            ));
          }}
        />
      ));
    })();
  }

  async function leavePipe() {
    const pipe = await requireActivePipe();
    if (!pipe) {
      toast("You are not in any pipe.", "warning");
      return;
    }
    const sid = await currentSessionId();
    if (!sid) return;
    try {
      await manager.leavePipe(pipe.id, sid);
      setActivePipe(undefined);
      toast(`Left pipe "${pipe.name}".`, "info");
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, "error");
    }
  }

  async function showStatus() {
    const pipe = await requireActivePipe();
    if (!pipe) {
      toast("You are not in any pipe.", "warning");
      return;
    }
    const st = await manager.pipeStatus(pipe.id);
    const lines = [
      `Pipe: ${st.pipe.name} (${st.pipe.status})`,
      `Messages: ${st.messageCount}`,
      "Participants:",
      ...st.participants.map((p) => `  ${p.name}  ${p.status}`),
      "Tasks:",
      ...(st.tasks.length
        ? st.tasks.map((t) => `  #${t.number} ${t.title}  [${t.status}]`)
        : ["  (none)"]),
    ];
    api.ui.dialog.replace(() => (
      <api.ui.Dialog size="large" onClose={close}>
        <api.ui.DialogAlert
          title={`Pipe: ${st.pipe.name}`}
          message={lines.join("\n")}
          onConfirm={close}
        />
      </api.ui.Dialog>
    ));
  }

  async function showMembers() {
    const pipe = await requireActivePipe();
    if (!pipe) {
      toast("You are not in any pipe.", "warning");
      return;
    }
    const members = await manager.participants.list(pipe.id);
    const lines = members.map(
      (m) => `${m.name}\n  ${m.status}  session=${m.sessionId}\n  dir=${m.directory}`,
    );
    api.ui.dialog.replace(() => (
      <api.ui.Dialog size="large" onClose={close}>
        <api.ui.DialogAlert
          title="Participants"
          message={lines.length ? lines.join("\n\n") : "No participants."}
          onConfirm={close}
        />
      </api.ui.Dialog>
    ));
  }

  async function showHistory(limit?: number) {
    const pipe = await requireActivePipe();
    if (!pipe) {
      toast("You are not in any pipe.", "warning");
      return;
    }
    const msgs = await manager.history(pipe.id, limit ?? config.historyPageSize);
    const lines = msgs.length
      ? msgs.map(
          (m) =>
            `[${m.sequence}] ${m.senderName ?? m.senderId} -> ${m.recipient.type} (${m.type}):\n  ${m.content.slice(0, 200)}`,
        )
      : ["No messages yet."];
    api.ui.dialog.replace(() => (
      <api.ui.Dialog size="xlarge" onClose={close}>
        <api.ui.DialogAlert
          title={`History (last ${lines.length})`}
          message={lines.join("\n\n")}
          onConfirm={close}
        />
      </api.ui.Dialog>
    ));
  }

  function sendDialog() {
    void (async () => {
      const pipe = await requireActivePipe();
      if (!pipe) {
        toast("You are not in any pipe.", "warning");
        return;
      }
      const members = await manager.participants.list(pipe.id);
      const opts = [
        { title: "@all (broadcast)", value: "@all" },
        ...members.map((m) => ({ title: `@${m.name}`, value: `@${m.name}` })),
      ];
      api.ui.dialog.replace(() => (
        <api.ui.DialogSelect
          title="Recipient"
          placeholder="Select recipient"
          options={opts}
          onSelect={(r) => {
            api.ui.dialog.replace(() => (
              <api.ui.DialogPrompt
                title={`Message to ${r.value}`}
                placeholder="Type your message"
                onCancel={close}
                onConfirm={async (text) => {
                  const content = text.trim();
                  if (!content) return;
                  const sid = await currentSessionId();
                  if (!sid) return;
                  try {
                    const msg = await manager.send({
                      sessionId: sid,
                      pipeId: pipe.id,
                      to: r.value as string,
                      content,
                    });
                    toast(`Sent to ${r.value} (${msg.id})`, "success");
                  } catch (e) {
                    toast(`Failed: ${(e as Error).message}`, "error");
                  }
                }}
              />
            ));
          }}
        />
      ));
    })();
  }

  // Handle "/pipe <sub> <args>" text command execution.
  const offCommand = api.event.on("command.executed", (ev) => {
    if (ev.properties.name !== "pipe") return;
    const args = (ev.properties.arguments ?? "").trim();
    if (!args) return;
    void handleArgv(args.trim().split(/\s+/)).catch((e) =>
      toast(`Command failed: ${(e as Error).message}`, "error"),
    );
  });

  // ----- notifications -----
  // Surface relevant pipe activity (direct requests, task state, members
  // joining/leaving) as toasts. Broadcasts and routine status changes are
  // intentionally NOT notified to avoid spam. Configurable.
  if (config.notificationsEnabled) {
    manager.bus.on("message.delivered", (ev) => {
      const m = ev.message;
      if (m.senderType === "system") return;
      const kind =
        m.type === "request" || m.type === "task"
          ? "requested work from you"
          : m.type === "blocked"
            ? "reports a blocker"
            : m.type === "completed"
              ? "completed work"
              : m.recipient.type === "participant"
                ? "sent you a message"
                : null;
      if (kind) {
        toast(`${m.senderName ?? "agent"} ${kind}`, m.type === "blocked" ? "warning" : "info", `Pipe: ${m.pipeId}`);
      }
    });

    manager.bus.on("participant.left", (ev) => {
      toast(`${ev.participant.name} left the pipe`, "warning");
    });

    manager.bus.on("participant.joined", (ev) => {
      toast(`${ev.participant.name} joined the pipe`, "success");
    });

    manager.bus.on("task.updated", (ev) => {
      const t = ev.task;
      if (t.status === "completed" || t.status === "blocked") {
        toast(
          `Task #${t.number} ${t.status}`,
          t.status === "blocked" ? "warning" : "success",
        );
      }
    });
  }

  async function handleArgv(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    switch (sub) {
      case "create": {
        const name = rest[0];
        if (!name) {
          createPipeDialog();
          return;
        }
        const sid = await currentSessionId();
        if (!sid) {
          toast("No active OpenCode session.", "warning");
          return;
        }
        const { pipe } = await manager.createPipe(name, sid, currentDirectory());
        setActivePipe(pipe.id);
        toast(`Pipe "${name}" created.`, "success");
        break;
      }
      case "join": {
        const name = rest[0];
        if (!name) {
          joinPipeDialog();
          return;
        }
        const sid = await currentSessionId();
        if (!sid) {
          toast("No active OpenCode session.", "warning");
          return;
        }
        const p = await manager.joinPipe({
          pipeName: name,
          sessionId: sid,
          directory: currentDirectory(),
          name: rest[1],
        });
        setActivePipe(p.pipeId);
        toast(`Joined pipe "${name}" as ${p.name}.`, "success");
        break;
      }
      case "leave":
        await leavePipe();
        break;
      case "status":
        await showStatus();
        break;
      case "members":
        await showMembers();
        break;
      case "history": {
        const n = Number(rest[0]);
        await showHistory(Number.isFinite(n) ? n : config.historyPageSize);
        break;
      }
      case "send": {
        if (rest.length >= 2) {
          const [to, ...bodyParts] = rest;
          const content = bodyParts.join(" ");
          const sid = await currentSessionId();
          const pipe = await requireActivePipe();
          if (!sid || !pipe) {
            toast("Not in a pipe or no session.", "warning");
            return;
          }
          const parsed = parseChannel(content);
          await manager.send({
            sessionId: sid,
            pipeId: pipe.id,
            to: parsed.recipient ?? to,
            content: parsed.content,
            type: parsed.type,
          });
          toast(`Sent to ${to}.`, "success");
        } else {
          sendDialog();
        }
        break;
      }
      default:
        openMainDialog();
    }
  }

  api.lifecycle.onDispose(() => {
    unregister();
    offCommand();
    void manager.dispose();
  });
};

export default PipesTui;
