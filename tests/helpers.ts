/**
 * Shared test helpers: memory-based managers for testing the core without
 * touching the filesystem or OpenCode.
 */

import { PipeManager } from "../src/core/pipe-manager.ts";
import { MemoryStore } from "../src/storage/memory-store.ts";
import { StandardEventBus } from "../src/core/event-bus.ts";
import type { PipeMessage } from "../src/models/message.ts";
import type { Participant, ParticipantStatus } from "../src/models/participant.ts";
import type { OpenCodeSessionAdapter } from "../src/core/session-adapter.ts";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";

/** A memory-backed fake transport that delivers within the same process. */
export class TestTransport {
  private handlers = new Map<string, Set<(m: PipeMessage) => Promise<void>>>();
  delivered: PipeMessage[] = [];

  async publish(pipeId: string, message: PipeMessage): Promise<void> {
    // In-process: notify all subscribers synchronously.
    const set = this.handlers.get(pipeId);
    if (set) {
      for (const h of [...set]) await h(message);
    }
    this.delivered.push(message);
  }

  async subscribe(
    pipeId: string,
    handler: (m: PipeMessage) => Promise<void>,
  ): Promise<() => void> {
    let set = this.handlers.get(pipeId);
    if (!set) {
      set = new Set();
      this.handlers.set(pipeId, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  async close(): Promise<void> {}
}

/** Captures messages "delivered" to sessions by the fake adapter. */
export class FakeSessionAdapter implements OpenCodeSessionAdapter {
  inbox = new Map<string, Array<{ envelope: string; message: PipeMessage }>>();
  deliveredIds: string[] = [];
  private statuses = new Map<string, ParticipantStatus>();
  currentId?: string;

  /** When set, sendMessage "responds" with this text (simulates a model reply). */
  replyText?: string;

  async sendMessage(
    sessionId: string,
    message: PipeMessage,
    _from: Participant,
  ): Promise<string | undefined> {
    const list = this.inbox.get(sessionId) ?? [];
    list.push({ envelope: `[${message.senderName}] ${message.content}`, message });
    this.inbox.set(sessionId, list);
    this.deliveredIds.push(message.id);
    return this.replyText;
  }

  async sendNotification(sessionId: string, text: string): Promise<void> {
    const list = this.inbox.get(sessionId) ?? [];
    list.push({ envelope: text, message: null as never });
    this.inbox.set(sessionId, list);
  }

  async getStatus(sessionId: string): Promise<ParticipantStatus | undefined> {
    this.currentId = sessionId;
    return this.statuses.get(sessionId) ?? "idle";
  }

  setStatus(sessionId: string, status: ParticipantStatus): void {
    this.statuses.set(sessionId, status);
  }

  messagesFor(sessionId: string): Array<{ envelope: string; message: PipeMessage }> {
    return this.inbox.get(sessionId) ?? [];
  }
}

export function makeManager(opts?: {
  config?: Config;
  adapter?: FakeSessionAdapter;
}): { manager: PipeManager; adapter: FakeSessionAdapter; bus: StandardEventBus } {
  const bus = new StandardEventBus();
  const adapter = opts?.adapter ?? new FakeSessionAdapter();
  const transport = new TestTransport();
  const manager = new PipeManager({
    store: new MemoryStore(),
    transport,
    session: adapter,
    config: opts?.config ?? DEFAULT_CONFIG,
    bus,
  });
  return { manager, adapter, bus };
}
