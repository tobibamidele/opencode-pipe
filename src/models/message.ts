/**
 * Pipe message model.
 *
 * Messages are the fundamental communication primitive. They carry a stable id,
 * a monotonic per-pipe sequence number (authoritative ordering), an explicit
 * sender and recipient, and optional request/reply/task correlation.
 */

import type { SenderType } from "./participant.js";

export type Recipient =
  | { type: "participant"; participantId: string }
  | { type: "broadcast" };

export type MessageType =
  | "message"
  | "request"
  | "response"
  | "task"
  | "status"
  | "blocked"
  | "completed"
  | "question"
  | "decision"
  | "system";

export const MESSAGE_TYPES: MessageType[] = [
  "message",
  "request",
  "response",
  "task",
  "status",
  "blocked",
  "completed",
  "question",
  "decision",
  "system",
];

export interface MessageDeliveryState {
  /** Highest known state; MVP tracks created/delivered/failed. */
  state: "created" | "delivered" | "failed";
  attempts: number;
  lastAttemptAt?: number;
  deliveredAt?: number;
  error?: string;
}

/** Loop-prevention metadata carried on a message. */
export interface MessageChain {
  chainId: string;
  hopCount: number;
}

export interface PipeMessage {
  schemaVersion: 1;

  id: string;
  pipeId: string;

  /** Monotonic per-pipe sequence number, authoritative for ordering. */
  sequence: number;

  senderId: string;
  senderName?: string;
  senderType: SenderType;

  recipient: Recipient;

  type: MessageType;

  content: string;

  createdAt: number;

  /** Correlates this message to a request (response.replyTo = request id). */
  replyTo?: string;

  /** Correlates this message to a task. */
  taskId?: string;

  /** Loop-prevention chain info. */
  chain?: MessageChain;

  metadata?: Record<string, unknown>;

  /** Ephemeral - not persisted with the log; delivery bookkeeping. */
  delivery?: MessageDeliveryState;
}

export function isMessageType(v: unknown): v is MessageType {
  return (MESSAGE_TYPES as string[]).includes(v as string);
}
