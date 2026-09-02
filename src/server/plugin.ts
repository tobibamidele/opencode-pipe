/**
 * Server plugin entry point (exported from the package "."). This is the core
 * OpenCode integration: it owns a PipeManager, exposes agent pipe tools, and
 * translates OpenCode session events into participant state.
 *
 * It runs once per OpenCode process (project). Multiple processes share the same
 * on-disk pipe data, so sessions in different directories can collaborate.
 */

import { type Plugin, type PluginInput, type PluginOptions, type Hooks } from "@opencode-ai/plugin";
import { PipeManager } from "../core/pipe-manager.js";
import { FileStore } from "../storage/file-store.js";
import { FileTransport } from "../core/file-transport.js";
import { DefaultSessionIdentity, type SessionIdentity } from "./identity.js";
import { buildTools } from "./tools.js";
import { resolveConfig, type Config } from "../config.js";
import { defaultDataDir } from "../utils/data-dir.js";
import type { Pipe } from "../models/pipe.js";
import { formatEnvelope } from "../protocol/envelope.js";
import { extractReplyText } from "./session-adapter.js";
import type { PipesClient } from "./client-types.js";

export type ServerPluginState = {
  manager: PipeManager;
  identity: SessionIdentity;
};

export function createPipesServer(input: {
  client: PipesClient;
  directory: string;
  worktree: string;
  dataDir: string;
  config: Config;
}): ServerPluginState {
  const { client, directory, worktree, dataDir, config } = input;

  const store = new FileStore(dataDir);
  const transport = new FileTransport(dataDir);
  const identity = new DefaultSessionIdentity(directory, worktree);

  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    client.app
      .log({
        body: {
          service: "opencode-pipes",
          level,
          message,
        },
      })
      .catch(() => {});
    // warn/error are surfaced regardless of config.debug — delivery failures
    // must be visible without opting into full debug logging.
    if (config.debug || level === "warn" || level === "error") {
      // eslint-disable-next-line no-console
      console.log(`[pipes:${level}] ${message}`);
    }
  };

  const pipeProvider = async (pipeId: string): Promise<Pipe | undefined> =>
    store.getPipe(pipeId);

  const manager = new PipeManager({
    store,
    transport,
    session: {
      async sendMessage(sessionId, message, from) {
        const pipe = await pipeProvider(message.pipeId);
        if (!pipe) return undefined;
        const envelope = formatEnvelope({ pipe, message, from });
        const res = await client.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: envelope }] },
        });
        return extractReplyText(res);
      },
      async sendNotification(sessionId, text) {
        try {
          await client.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text }] },
          });
        } catch {
          /* best effort */
        }
      },
      async getStatus(sessionId) {
        try {
          const res = await client.session.status({ path: { id: sessionId } });
          const d = res.data as { type?: string } | undefined;
          if (!d) return "unknown";
          return d.type === "idle" ? "idle" : d.type === "busy" || d.type === "retry" ? "busy" : "unknown";
        } catch {
          return "disconnected";
        }
      },
      currentSessionId: () => identity.currentSessionId(),
    },
    config,
    bus: undefined,
  });
  manager.onLog = log;

  identity.setLog(log);
  return { manager, identity };
}

/** The OpenCode plugin export. */
export const PipesServer: Plugin = async (
  input: PluginInput,
  options?: PluginOptions,
) => {
  const { client, directory, worktree } = input;
  const config = resolveConfig(options as Record<string, unknown> | undefined);
  const state = createPipesServer({
    client: client as unknown as PipesClient,
    directory,
    worktree,
    dataDir: defaultDataDir(),
    config,
  });

  const { manager, identity } = state;

  const log = manager.onLog ?? (() => {});

  // Resolve the participant for a session within a pipe.
  const resolveSession = async (
    sessionId: string,
    dir: string,
  ) => {
    const pipes = await manager.listPipes();
    for (const pipe of pipes) {
      if (pipe.status === "closed") continue;
      const p = await manager.participants.bySession(pipe.id, sessionId);
      if (p) return p;
    }
    if (dir) {
      const pipes2 = await manager.listPipes();
      for (const pipe of pipes2) {
        const list = await manager.participants.list(pipe.id);
        const byDir = list.find(
          (p) => p.directory === dir && p.status !== "disconnected",
        );
        if (byDir) return byDir;
      }
    }
    return undefined;
  };

  const tools = buildTools({
    manager,
    currentSessionId: () => identity.currentSessionId(),
    resolveSession,
    log,
  });

  const eventHook: NonNullable<Hooks["event"]> = async ({ event }) => {
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const info = event.properties.info;
        identity.observe({ sessionId: info.id, directory: info.directory });
        // Subscribe the server manager to pipes this session belongs to. Join
        // may also have happened through the TUI manager (dialog), which never
        // prompts; re-syncing here keeps deliveries authoritative.
        await syncListening();
        break;
      }
      case "session.status": {
        const { sessionID, status } = event.properties;
        const targetStatus =
          status.type === "busy" || status.type === "retry" ? "busy" : "idle";
        await updateParticipantStatus(sessionID, targetStatus);
        if (targetStatus === "idle") await syncListening();
        break;
      }
      case "session.idle": {
        await updateParticipantStatus(event.properties.sessionID, "idle");
        // The usual cause of a failed prompt delivery was the session being
        // busy; now that it is idle, retry anything queued for it.
        await manager.retryPending(event.properties.sessionID);
        await syncListening();
        break;
      }
      case "session.deleted":
      case "session.error": {
        const sessionID =
          event.type === "session.deleted"
            ? event.properties.info.id
            : event.properties.sessionID;
        if (sessionID) await updateParticipantStatus(sessionID, "disconnected");
        break;
      }
    }
  };

  async function updateParticipantStatus(
    sessionId: string,
    status: "busy" | "idle" | "disconnected",
  ) {
    const pipes = await manager.listPipes();
    for (const pipe of pipes) {
      const p = await manager.participants.bySession(pipe.id, sessionId);
      if (p) {
        await manager.participants.setStatus(p.id, status);
      }
    }
  }

  // Keep the server manager subscribed to pipes every session in this process
  // belongs to, even when the join happened through the TUI manager's dialog
  // (which cannot prompt the model itself). Iterates ALL observed sessions —
  // not just the most recently active one — since a process can host several
  // sessions and each needs its own subscription set up independently. Called
  // on session lifecycle events and, as a safety net, on a short unref'd timer
  // so dialog-created joins are picked up within a few seconds.
  let listeningTimer: ReturnType<typeof setInterval> | undefined;
  const syncListening = async () => {
    for (const sid of identity.observedSessionIds()) {
      await manager.syncListening(sid);
    }
  };
  listeningTimer = setInterval(() => void syncListening(), 5000);
  listeningTimer.unref?.();

  // Inject the protocol into a session when it joins a pipe. The tools call
  // this; we also expose it so the coordinator can inject on reconnect.

  const toolMap: NonNullable<Hooks["tool"]> = {
    pipe_create: tools.pipe_create,
    pipe_join: tools.pipe_join,
    pipe_list: tools.pipe_list,
    pipe_leave: tools.pipe_leave,
    pipe_send: tools.pipe_send,
    pipe_request: tools.pipe_request,
    pipe_reply: tools.pipe_reply,
    pipe_task_create: tools.pipe_task_create,
    pipe_task_update: tools.pipe_task_update,
    pipe_status: tools.pipe_status,
    pipe_members: tools.pipe_members,
    pipe_history: tools.pipe_history,
  };

  return {
    event: eventHook,
    tool: toolMap,
  };
};

export default PipesServer;
