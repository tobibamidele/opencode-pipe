/**
 * Lightweight internal event bus. Consumers subscribe to pipe events and must
 * unsubscribe to avoid leaking listeners across plugin lifecycles.
 */

import type { PipeEvent } from "../models/event.js";

export interface PipeEventBus {
  emit(event: PipeEvent): void;
  on<E extends PipeEvent["type"]>(
    type: E,
    handler: (event: Extract<PipeEvent, { type: E }>) => void,
  ): () => void;
}

export class StandardEventBus implements PipeEventBus {
  private listeners = new Map<PipeEvent["type"], Set<(e: PipeEvent) => void>>();

  emit(event: PipeEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    // Copy to avoid mutation during iteration.
    for (const handler of [...set]) {
      try {
        handler(event);
      } catch {
        // A bad listener must not break the bus.
      }
    }
  }

  on<E extends PipeEvent["type"]>(
    type: E,
    handler: (event: Extract<PipeEvent, { type: E }>) => void,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    // The bus guarantees listeners are invoked only with events of `type`, so
    // narrowing the payload to the matching variant is safe.
    const wrapped = (event: PipeEvent) =>
      handler(event as Extract<PipeEvent, { type: E }>);
    set.add(wrapped);
    return () => {
      this.listeners.get(type)?.delete(wrapped);
    };
  }

  /** Remove all listeners (used in tests / teardown). */
  clear(): void {
    this.listeners.clear();
  }
}
