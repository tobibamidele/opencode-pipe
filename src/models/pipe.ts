/**
 * Core pipe model.
 *
 * A pipe is a named collaboration channel. It lives at the user level (not the
 * project level) so that independent OpenCode sessions in different directories
 * can discover and join the same channel.
 */

export type PipeStatus = "active" | "paused" | "closed";

export const PIPE_STATUSES: PipeStatus[] = ["active", "paused", "closed"];

export interface Pipe {
  /** Stable random id, e.g. `pipe_9f3a...`. */
  id: string;

  /** Human readable name, e.g. `checkout`. Unique among active pipes. */
  name: string;

  /** Schema version for forward compatibility. */
  schemaVersion: 1;

  createdAt: number;
  updatedAt: number;

  /** Participant id of the creator. */
  createdBy: string;

  status: PipeStatus;

  /** Participant ids currently attached. */
  participants: string[];

  messageCount: number;
  taskCount: number;
}

export function isPipeStatus(v: unknown): v is PipeStatus {
  return (PIPE_STATUSES as string[]).includes(v as string);
}
