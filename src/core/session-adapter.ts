/**
 * Adapter for OpenCode session interactions. The core manager depends on this
 * interface only, keeping the domain free of OpenCode imports and testable with
 * a fake. The real implementation is provided by the server plugin.
 */

import type { PipeMessage } from "../models/message.js";
import type { ParticipantStatus } from "../models/participant.js";
import type { Participant } from "../models/participant.js";

export interface OpenCodeSessionAdapter {
  /** Deliver an actionable message into a session (e.g. request/response/task). */
  sendMessage(sessionId: string, message: PipeMessage, context: Participant): Promise<void>;

  /** Deliver a lightweight notification without polluting model context. */
  sendNotification(sessionId: string, text: string): Promise<void>;

  /** Current status of a session. */
  getStatus(sessionId: string): Promise<ParticipantStatus | undefined>;

  /** Resolve the current session id for this process (or undefined). */
  currentSessionId?(): Promise<string | undefined>;
}

/** A no-op adapter used when the plugin cannot connect to OpenCode. */
export class NullSessionAdapter implements OpenCodeSessionAdapter {
  async sendMessage(): Promise<void> {}
  async sendNotification(): Promise<void> {}
  async getStatus(): Promise<ParticipantStatus | undefined> {
    return undefined;
  }
}
