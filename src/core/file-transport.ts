/**
 * Filesystem transport.
 *
 * Messages are appended to a shared `messages.jsonl` file per pipe (owned by the
 * FileStore). Each subscribing process watches the file for appends and replays
 * new records past its own cursor. This is what lets independent OpenCode
 * processes exchange messages with no daemon or external service.
 *
 * Reliability:
 *  - appends are atomic (O_APPEND).
 *  - parsing tolerates partial trailing lines from concurrent writers.
 *  - each handler receives every message; the caller deduplicates by message id.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PipeMessage } from "../models/message.js";
import { FileStore } from "../storage/file-store.js";
import type { PipeTransport, Unsubscribe } from "./transport.js";
import { pipesRoot, pipeDir as pipeDirPath } from "../utils/paths.js";

interface WatchState {
  pipeId: string;
  file: string;
  /** Highest sequence already dispatched for this consumer. */
  cursor: Map<string, number>;
  handlers: Set<(m: PipeMessage) => Promise<void>>;
  timer?: NodeJS.Timeout;
  watcher?: import("node:fs").FSWatcher;
  closed: boolean;
}

export class FileTransport implements PipeTransport {
  private readonly root: string;
  private readonly store: FileStore;
  private readonly states = new Map<string, WatchState>();

  constructor(dataDir: string) {
    this.root = pipesRoot(dataDir);
    this.store = new FileStore(dataDir);
  }

  async publish(pipeId: string, message: PipeMessage): Promise<void> {
    // Persistence (the shared message log append) is owned by PipeManager.send
    // via store.createMessage. Publishing here only needs to make the record
    // visible; it must NOT double-append. Guard by id for safety/idempotency.
    const existing = await this.store.getMessage(message.id);
    if (!existing) {
      await this.store.createMessage(message);
    }
  }

  /**
   * Provide read access to persisted messages (history / next sequence).
   * Exposed so the coordinator can reuse the same underlying store.
   */
  getStore(): FileStore {
    return this.store;
  }

  async subscribe(
    pipeId: string,
    handler: (message: PipeMessage) => Promise<void>,
  ): Promise<Unsubscribe> {
    const file = await this.ensureMessagesFile(pipeId);
    let state = this.states.get(pipeId);
    if (!state) {
      state = {
        pipeId,
        file,
        cursor: new Map(),
        handlers: new Set(),
        closed: false,
      };
      this.states.set(pipeId, state);
    }
    state.handlers.add(handler);

    // Replay any messages this consumer has not seen, then start watching.
    await this.replay(state);

    if (!state.watcher) {
      this.startWatch(state);
    }

    // Store close() is shared across all pipes; do not close per-subscription.
    return () => {
      state!.handlers.delete(handler);
      if (state!.handlers.size === 0) {
        this.stopWatch(state!);
        this.states.delete(pipeId);
      }
    };
  }

  private async ensureMessagesFile(pipeId: string): Promise<string> {
    const dir = pipeDirPath(this.root, pipeId);
    await fs.mkdir(dir, { recursive: true });
    return this.store.fileFor(pipeId, "messages.jsonl");
  }

  private startWatch(state: WatchState): void {
    // Watch the pipe directory for changes to messages.jsonl.
    const dir = path.dirname(state.file);
    try {
      type WatchCb = (
        filename: import("node:fs").PathLike,
        options: { persistent: boolean },
        listener: (event: string, filename: string | null) => void,
      ) => import("node:fs").FSWatcher;
      const watcher = (fs.watch as unknown as WatchCb)(
        dir,
        { persistent: false },
        (_event, filename) => {
          if (filename && String(filename).endsWith("messages.jsonl")) {
            void this.replay(state);
          }
        },
      );
      state.watcher = watcher;
      watcher.on("error", () => this.startPolling(state));
    } catch {
      this.startPolling(state);
    }
  }

  private startPolling(state: WatchState): void {
    if (state.timer) return;
    state.timer = setInterval(() => void this.replay(state), 500);
    state.timer.unref?.();
  }

  private stopWatch(state: WatchState): void {
    state.closed = true;
    state.watcher?.close();
    state.watcher = undefined;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  }

  /** Read messages past the consumer cursor and dispatch them. */
  private async replay(state: WatchState): Promise<void> {
    if (state.closed) return;
    let raw: string;
    try {
      raw = await fs.readFile(state.file, "utf8");
    } catch {
      return; // file not created yet — nothing to do.
    }
    const messages: PipeMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        messages.push(JSON.parse(line) as PipeMessage);
      } catch {
        // tolerate partial trailing record
      }
    }
    messages.sort((a, b) => a.sequence - b.sequence);
    for (const m of messages) {
      const seen = state.cursor.get(m.id) ?? 0;
      if (seen) continue;
      state.cursor.set(m.id, 1);
      // snapshot handlers: a handler may unsubscribe during iteration.
      for (const handler of [...state.handlers]) {
        try {
          await handler(m);
        } catch {
          // A consumer error must not break replay for other consumers.
        }
      }
    }
  }

  async close(): Promise<void> {
    for (const state of this.states.values()) {
      this.stopWatch(state);
    }
    this.states.clear();
    await this.store.close();
  }
}
