/**
 * Adapter for OpenCode session interactions. The core manager depends on this
 * interface only, keeping the domain free of OpenCode imports and testable with
 * a fake. The real implementation is provided by the server plugin.
 */

import type { PipeMessage } from "../models/message.js";
import type { ParticipantStatus } from "../models/participant.js";
import type { Participant } from "../models/participant.js";

export interface OpenCodeSessionAdapter {
  /** Deliver an actionable message into a session (e.g. request/response/task).
   *
   * Injects the message as a real user turn so the session's model responds.
   * Returns the assistant reply text produced in that session, if any — the
   * pipe manager uses it to route the response back to the original sender.
   * A null/undefined return means the session produced no usable reply (e.g.
   * the adapter is a no-op in the TUI, or the prompt failed). */
  sendMessage(sessionId: string, message: PipeMessage, context: Participant): Promise<string | undefined>;

  /** Deliver a lightweight notification without polluting model context. */
  sendNotification(sessionId: string, text: string): Promise<void>;

  /** Current status of a session. */
  getStatus(sessionId: string): Promise<ParticipantStatus | undefined>;

  /** Resolve the current session id for this process (or undefined). */
  currentSessionId?(): Promise<string | undefined>;
}

/** A no-op adapter used when the plugin cannot connect to OpenCode. */
export class NullSessionAdapter implements OpenCodeSessionAdapter {
  async sendMessage(): Promise<string | undefined> {
    return undefined;
  }
  async sendNotification(): Promise<void> {}
  async getStatus(): Promise<ParticipantStatus | undefined> {
    return undefined;
  }
}
