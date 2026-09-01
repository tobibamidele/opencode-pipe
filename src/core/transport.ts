/**
 * Transport abstraction. The core layer talks to this only via publish /
 * subscribe, so the cross-process medium (filesystem now, local IPC later) can
 * be swapped without touching the rest of the system.
 */

import type { PipeMessage } from "../models/message.js";

export type Unsubscribe = () => void;

export interface PipeTransport {
  /**
   * Broadcast a message into a pipe. Implementations persist the message to the
   * shared medium (and may assign/preserve the sequence number).
   */
  publish(pipeId: string, message: PipeMessage): Promise<void>;

  /**
   * Subscribe to messages arriving in a pipe from OTHER processes. Called once
   * per message with a stable id; consumers must deduplicate.
   */
  subscribe(
    pipeId: string,
    handler: (message: PipeMessage) => Promise<void>,
  ): Promise<Unsubscribe>;

  close(): Promise<void>;
}
