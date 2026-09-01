/**
 * Participant model.
 *
 * A participant represents an OpenCode session attached to a pipe. The session
 * id is the primary identity; the directory is informational metadata and does
 * NOT grant filesystem access to other participants.
 */

export type ParticipantStatus =
  | "online"
  | "idle"
  | "busy"
  | "disconnected"
  | "unknown";

export const PARTICIPANT_STATUSES: ParticipantStatus[] = [
  "online",
  "idle",
  "busy",
  "disconnected",
  "unknown",
];

export type SenderType = "human" | "agent" | "system";

export interface Participant {
  id: string;
  pipeId: string;

  /** OpenCode session id. */
  sessionId: string;

  /** Human readable collaboration identity, e.g. `frontend`. */
  name: string;

  /** Optional role, e.g. `frontend`. */
  role?: string;

  /** Current working directory of the session. */
  directory: string;

  /** Git worktree root, when available. */
  worktree?: string;

  /** Optional git branch, captured cheaply. */
  branch?: string;

  joinedAt: number;
  lastSeenAt: number;

  /** "left" is represented by removing from pipe.participants while keeping the record. */
  status: ParticipantStatus;

  capabilities?: string[];
}

export function isParticipantStatus(v: unknown): v is ParticipantStatus {
  return (PARTICIPANT_STATUSES as string[]).includes(v as string);
}
