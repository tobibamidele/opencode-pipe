/**
 * Pipe manager. The central application coordinator: owns pipes, participants,
 * tasks, and message routing. This is the only component the server/TUI layers
 * talk to. It is intentionally free of OpenCode imports.
 */

import type { PipeStore } from "../storage/store.js";
import type { PipeTransport } from "./transport.js";
import type { OpenCodeSessionAdapter } from "./session-adapter.js";
import type { PipeEventBus } from "./event-bus.js";
import { StandardEventBus } from "./event-bus.js";
import type { Pipe } from "../models/pipe.js";
import type { Participant, SenderType } from "../models/participant.js";
import type { PipeMessage, MessageType, Recipient } from "../models/message.js";
import type { PipeTask, TaskStatus } from "../models/task.js";
import { ParticipantManager } from "./participant-manager.js";
import { TaskManager } from "./task-manager.js";
import { resolveRecipient, buildMessage, exceedsHopLimit } from "./router.js";
import { isValidPipeName, newId } from "../utils/ids.js";
import { pipeError } from "../utils/errors.js";
import { now } from "../utils/time.js";
import { DEFAULT_CONFIG, type Config } from "../config.js";

export interface SendOptions {
  type?: MessageType;
  replyTo?: string;
  taskId?: string;
  reference?: PipeMessage;
  content: string;
}

export interface PipeManagerOptions {
  store: PipeStore;
  transport: PipeTransport;
  session: OpenCodeSessionAdapter;
  config?: Config;
  bus?: PipeEventBus;
}

interface PendingDelivery {
  pipeId: string;
  message: PipeMessage;
  sender: Participant;
  target: Participant;
  attempts: number;
}

export class PipeManager {
  readonly bus: PipeEventBus;
  readonly participants: ParticipantManager;
  readonly tasks: TaskManager;
  readonly config: Config;

  private readonly store: PipeStore;
  private readonly transport: PipeTransport;
  private readonly session: OpenCodeSessionAdapter;
  private readonly subscriptions = new Map<string, () => void>();
  /** Message ids already delivered/handled by THIS process (per-process dedup). */
  private readonly deliveredIds = new Set<string>();
  /** Deliveries that failed (e.g. target session busy); retried on idle. */
  private readonly pending = new Map<string, PendingDelivery[]>();

  constructor(opts: PipeManagerOptions) {
    this.store = opts.store;
    this.transport = opts.transport;
    this.session = opts.session;
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.bus = opts.bus ?? new StandardEventBus();
    this.participants = new ParticipantManager(this.store, this.bus);
    this.tasks = new TaskManager(this.store, this.bus);
  }

  /** The current process's session id, when discoverable. */
  async currentSessionId(): Promise<string | undefined> {
    const fn = this.session.currentSessionId?.bind(this.session);
    return fn ? await fn() : undefined;
  }

  // ---- Pipes ----

  async createPipe(name: string, createdBySessionId: string, directory: string): Promise<{ pipe: Pipe; participant: Participant }> {
    if (!isValidPipeName(name)) {
      throw pipeError("INVALID_PIPE_NAME", `Pipe name "${name}" is invalid`);
    }
    const existing = await this.store.getPipeByName(name);
    if (existing && existing.status !== "closed") {
      throw pipeError("PIPE_ALREADY_EXISTS", `Pipe "${name}" already exists`);
    }

    const session = createdBySessionId || (await this.currentSessionId());
    if (!session) throw pipeError("SESSION_NOT_FOUND", "No OpenCode session to bind the pipe to");

    const makerId = newId("part");
    const pipe: Pipe = {
      id: newId("pipe"),
      name,
      schemaVersion: 1,
      createdAt: now(),
      updatedAt: now(),
      createdBy: makerId,
      status: "active",
      participants: [],
      messageCount: 0,
      taskCount: 0,
    };

    await this.store.createPipe(pipe);
    this.bus.emit({ type: "pipe.created", pipe });

    // Join the creator automatically.
    const participant = await this.participants.join({
      pipeId: pipe.id,
      sessionId: session,
      directory,
      name: this.suggestCreatorName(directory),
    });

    // Listen for remote messages bound to the creator's session.
    await this.ensureListening(pipe.id, session);

    return { pipe, participant };
  }

  private suggestCreatorName(directory: string): string | undefined {
    const base = directory.split("/").filter(Boolean).pop()?.replace(/[^a-zA-Z0-9_-]/g, "") || undefined;
    return base;
  }

  async getPipeByName(name: string): Promise<Pipe | undefined> {
    return this.store.getPipeByName(name);
  }

  async getPipe(pipeId: string): Promise<Pipe | undefined> {
    return this.store.getPipe(pipeId);
  }

  async listPipes(): Promise<Pipe[]> {
    return this.store.listPipes();
  }

  async closePipe(pipeId: string): Promise<Pipe> {
    const pipe = await this.store.getPipe(pipeId);
    if (!pipe) throw pipeError("PIPE_NOT_FOUND", `Pipe ${pipeId} not found`);
    pipe.status = "closed";
    pipe.updatedAt = now();
    const updated = await this.store.updatePipe(pipe);
    this.bus.emit({ type: "pipe.closed", pipeId });
    for (const id of [...this.subscriptions.keys()]) {
      if (id.startsWith(pipeId + ":")) {
        this.subscriptions.get(id)!();
        this.subscriptions.delete(id);
      }
    }
    return updated;
  }

  async deletePipe(pipeId: string): Promise<void> {
    await this.store.deletePipe(pipeId);
  }

  // ---- Join/leave ----

  async joinPipe(input: {
    pipeId?: string;
    pipeName?: string;
    sessionId: string;
    directory: string;
    worktree?: string;
    branch?: string;
    name?: string;
    role?: string;
  }): Promise<Participant> {
    const pipe = input.pipeId
      ? await this.store.getPipe(input.pipeId)
      : input.pipeName
        ? await this.store.getPipeByName(input.pipeName)
        : undefined;
    if (!pipe) {
      throw pipeError(
        "PIPE_NOT_FOUND",
        `Pipe ${input.pipeId ?? input.pipeName ?? "?"} does not exist`,
      );
    }
    const participant = await this.participants.join({
      pipeId: pipe.id,
      sessionId: input.sessionId,
      directory: input.directory,
      worktree: input.worktree,
      branch: input.branch,
      name: input.name,
      role: input.role,
    });
    await this.ensureListening(pipe.id, input.sessionId);
    return participant;
  }

  async leavePipe(pipeId: string, sessionId: string): Promise<void> {
    await this.participants.leave(pipeId, sessionId);
    const unsub = this.subscriptions.get(`${pipeId}:${sessionId}`);
    if (unsub) {
      unsub();
      this.subscriptions.delete(`${pipeId}:${sessionId}`);
    }
  }

  // ---- Sending ----

  /**
   * Send a message from a participant. Routes to a specific participant or
   * broadcast, persists it, delivers to online recipients, and forwards to
   * remote processes via the transport.
   */
  async send(input: {
    sessionId: string;
    pipeId?: string;
    pipeName?: string;
    to?: string; // participant name/id, "@all"
    content: string;
    type?: MessageType;
    replyTo?: string;
    taskId?: string;
    reference?: PipeMessage;
  }): Promise<PipeMessage> {
    const pipe = await this.resolvePipe(input.pipeId, input.pipeName);
    const sender = await this.participants.bySession(pipe.id, input.sessionId);
    if (!sender) {
      throw pipeError(
        "NOT_A_PARTICIPANT",
        `Session is not a participant of pipe "${pipe.name}"`,
      );
    }

    if (input.content.length > this.config.maxMessageChars) {
      throw pipeError(
        "MESSAGE_TOO_LARGE",
        `Message exceeds the ${this.config.maxMessageChars} character limit`,
      );
    }

    const others = (await this.participants.list(pipe.id)).filter(
      (p) => p.id !== sender.id,
    );
    const recipient = resolveRecipient(input.to, others);

    const message = buildMessage({
      pipeId: pipe.id,
      sender,
      senderType: "agent",
      content: input.content,
      type: input.type ?? "message",
      recipient,
      replyTo: input.replyTo,
      taskId: input.taskId,
      parent: input.reference,
      config: this.config,
    });

    // Sequence assignment + persistence.
    message.sequence = await this.store.nextSequence(pipe.id);
    await this.store.createMessage(message);

    pipe.messageCount += 1;
    pipe.updatedAt = now();
    await this.store.updatePipe(pipe);

    this.bus.emit({ type: "message.created", message });

    // Mark handled in this process immediately: local delivery below and any
    // watcher-triggered handler must not deliver this id twice.
    this.deliveredIds.add(message.id);

    // Loop prevention: if this chain is already too deep, do not forward.
    if (message.type === "message" && exceedsHopLimit(message, this.config)) {
      this.bus.emit({ type: "message.delivered", message });
      return message;
    }

    await this.deliver(pipe, message, sender, others);
    return message;
  }

  async sendReply(input: {
    sessionId: string;
    replyTo: string;
    content: string;
    type?: "response" | "message" | "blocked" | "decision";
    taskId?: string;
  }): Promise<PipeMessage> {
    const original = await this.store.getMessage(input.replyTo);
    if (!original) {
      throw pipeError("PIPE_NOT_FOUND", `Message ${input.replyTo} not found`);
    }
    // Reply to the original sender, not the broadcaster of the whole pipe.
    const recipient: Recipient =
      original.recipient.type === "participant" &&
      original.senderId !== (await this.participantIdForSession(original.pipeId, input.sessionId))
        ? { type: "participant", participantId: original.senderId }
        : { type: "broadcast" };

    return this.send({
      sessionId: input.sessionId,
      pipeId: original.pipeId,
      to: recipient.type === "participant" ? recipient.participantId : "@all",
      content: input.content,
      type: input.type ?? "response",
      replyTo: original.id,
      taskId: input.taskId ?? original.taskId,
      reference: original,
    });
  }

  // ---- History / status ----

  async history(pipeId: string, limit?: number): Promise<PipeMessage[]> {
    return this.store.listMessages(pipeId, limit ?? this.config.historyPageSize);
  }

  async message(messageId: string): Promise<PipeMessage | undefined> {
    return this.store.getMessage(messageId);
  }

  async pipeStatus(pipeId: string): Promise<{
    pipe: Pipe;
    participants: Participant[];
    tasks: PipeTask[];
    messageCount: number;
  }> {
    const pipe = await this.store.getPipe(pipeId);
    if (!pipe) throw pipeError("PIPE_NOT_FOUND", `Pipe ${pipeId} not found`);
    const participants = await this.participants.list(pipeId);
    const tasks = await this.tasks.listTasks(pipeId);
    const all = await this.store.listMessages(pipeId);
    return { pipe, participants, tasks, messageCount: all.length };
  }

  // ---- Delivery ----

  private async deliver(
    pipe: Pipe,
    message: PipeMessage,
    sender: Participant,
    others: Participant[],
  ): Promise<void> {
    const recipient = message.recipient;
    const recipients =
      recipient.type === "participant"
        ? others.filter((p) => p.id === recipient.participantId)
        : others;

    // Deliver directly only to recipient sessions THIS process actively manages
    // (i.e. sessions that joined through this manager instance). Recipients
    // living in other OpenCode processes receive the message via the shared
    // transport when their process's watcher picks up the persisted record.
    for (const target of recipients) {
      if (target.sessionId === sender.sessionId) continue;
      if (!this.subscriptions.has(`${pipe.id}:${target.sessionId}`)) continue;
      await this.deliverTo(pipe.id, message, sender, target);
    }

    // Publish to the shared log so remote processes deliver to their sessions.
    await this.transport.publish(pipe.id, message);
  }

  /**
   * Deliver a message to a single local session (a session this manager manages)
   * and, if the adapter captured a model reply, route that reply back to the
   * original sender automatically. Auto-replies are bounded by the chain/hop
   * machinery so two agents cannot ping-pong forever.
   *
   * If the adapter throws (e.g. the target session is busy generating), the
   * delivery is queued and retried by `retryPending` on the next session idle
   * event, up to `maxDeliveryAttempts`.
   */
  private async deliverTo(
    pipeId: string,
    message: PipeMessage,
    sender: Participant,
    target: Participant,
    attempts = 0,
  ): Promise<void> {
    try {
      const reply = await this.session.sendMessage(target.sessionId, message, sender);
      this.bus.emit({ type: "message.delivered", message });
      await this.maybeAutoReply({ pipeId, incoming: message, responder: target, reply });
    } catch (e) {
      // Delivery failure is non-fatal; message is persisted for replay.
      this.emitLog("warn", `delivery failed to ${target.name}: ${(e as Error).message}`);
      if (attempts < this.config.maxDeliveryAttempts) {
        this.queuePending({ pipeId, message, sender, target, attempts: attempts + 1 });
        this.emitLog(
          "debug",
          `queued ${message.id} for delivery retry to ${target.name} (attempt ${attempts + 1}/${this.config.maxDeliveryAttempts})`,
        );
      } else {
        this.emitLog(
          "error",
          `giving up delivery of ${message.id} to ${target.name} after ${this.config.maxDeliveryAttempts} attempts`,
        );
      }
    }
  }

  private queuePending(delivery: PendingDelivery): void {
    const list = this.pending.get(delivery.target.sessionId) ?? [];
    list.push(delivery);
    this.pending.set(delivery.target.sessionId, list);
  }

  /**
   * Retry deliveries that previously failed for a session. Called by the server
   * plugin when the session transitions to idle (the usual cause of a failed
   * prompt is that the session was busy). No-op when nothing is pending.
   */
  async retryPending(sessionId: string): Promise<void> {
    const list = this.pending.get(sessionId);
    if (!list || list.length === 0) return;
    this.pending.delete(sessionId);
    for (const item of list) {
      await this.deliverTo(item.pipeId, item.message, item.sender, item.target, item.attempts);
    }
  }

  /**
   * Route the receiving model's reply back through the pipe as a `response`.
   * Only direct (non-broadcast) messages trigger a reply, and chains are capped
   * at `maxAgentHops` to prevent runaway agent-to-agent chatter.
   */
  private async maybeAutoReply(input: {
    pipeId: string;
    incoming: PipeMessage;
    responder: Participant;
    reply?: string;
  }): Promise<void> {
    if (!this.config.autoRespond) return;
    const { pipeId, incoming, responder, reply } = input;
    const text = reply?.trim();
    if (!text) return;
    // Never auto-respond to broadcasts (avoids N-way echoes) or to ourselves.
    if (incoming.recipient.type !== "participant") return;
    if (incoming.senderId === responder.id) return;
    if (incoming.type === "system") return;
    // Hop guard: a reply already at the budget must not extend the chain.
    const nextHop = (incoming.chain?.hopCount ?? 0) + 1;
    if (nextHop > this.config.maxAgentHops) return;

    try {
      await this.send({
        sessionId: responder.sessionId,
        pipeId,
        to: incoming.senderId,
        content: text.slice(0, this.config.maxMessageChars),
        type: "response",
        replyTo: incoming.id,
        reference: incoming,
      });
      this.emitLog(
        "info",
        `auto-replied ${incoming.id} -> ${incoming.senderId} (hop ${(incoming.chain?.hopCount ?? 0) + 1})`,
      );
    } catch (e) {
      this.emitLog("warn", `auto-reply failed for ${incoming.id}: ${(e as Error).message}`);
    }
  }

  private async resolvePipe(pipeId?: string, pipeName?: string): Promise<Pipe> {
    if (pipeId) {
      const p = await this.store.getPipe(pipeId);
      if (p) return p;
      throw pipeError("PIPE_NOT_FOUND", `Pipe ${pipeId} not found`);
    }
    if (pipeName) {
      const p = await this.store.getPipeByName(pipeName);
      if (p) return p;
      throw pipeError("PIPE_NOT_FOUND", `Pipe "${pipeName}" does not exist`);
    }
    throw pipeError("NO_ACTIVE_PIPE", "No pipe specified");
  }

  private async participantIdForSession(pipeId: string, sessionId: string): Promise<string | undefined> {
    const p = await this.participants.bySession(pipeId, sessionId);
    return p?.id;
  }

  /**
   * Ensure this process is listening for remote messages on a pipe and, when
   * received, delivering them to the given local session.
   */
  private async ensureListening(pipeId: string, sessionId: string): Promise<void> {
    const key = `${pipeId}:${sessionId}`;
    if (this.subscriptions.has(key)) return;

    const unsub = await this.transport.subscribe(pipeId, async (remote) => {
      // Per-process dedup: skip records this process already handled locally.
      if (this.deliveredIds.has(remote.id)) return;
      this.deliveredIds.add(remote.id);

      // The remote record is already persisted by its sender in the shared
      // store/log; we do NOT re-append it here. It is visible to our history
      // through the shared data, so just notify listeners.
      this.bus.emit({ type: "message.created", message: remote });

      // Deliver to the local session if it is a recipient.
      const me = await this.participants.bySession(pipeId, sessionId);
      if (!me) return;

      const isRecipient =
        remote.recipient.type === "broadcast" ||
        (remote.recipient.type === "participant" &&
          remote.recipient.participantId === me.id);

      if (!isRecipient || remote.senderId === me.id) return;

      const sender = await this.store.getParticipant(remote.senderId);
      if (!sender) return;
      await this.deliverTo(pipeId, remote, sender, me);
    });

    this.subscriptions.set(key, unsub);
  }

  /** Respond to a remote request with a reply. */
  async handleRemoteReply(args: { sessionId: string; replyTo: string; content: string }): Promise<PipeMessage> {
    return this.sendReply(args);
  }

  /** Task convenience wrappers. */
  createTask = (input: {
    pipeId: string;
    createdBy: string;
    title: string;
    description: string;
    assignedTo?: string;
    priority?: PipeTask["priority"];
    dependsOn?: string[];
    metadata?: Record<string, unknown>;
  }) => this.tasks.createTask(input);

  transitionTask = (
    taskId: string,
    status: TaskStatus,
    opts?: { blockedReason?: string },
  ) => this.tasks.transitionTask(taskId, status, opts);

  readyTasks = (pipeId: string) => this.tasks.readyTasks(pipeId);

  private emitLog(level: "debug" | "info" | "warn" | "error", message: string): void {
    // Overridable by adapter; default no-op log placeholder.
    this.onLog?.(level, message);
  }

  /** Optional logger injected by the server plugin. */
  onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;

  async dispose(): Promise<void> {
    for (const unsub of this.subscriptions.values()) unsub();
    this.subscriptions.clear();
    await this.transport.close();
  }
}
