/**
 * Pipe task model.
 *
 * Tasks are higher-level units than messages. They have an explicit lifecycle
 * enforced by a state machine and can express basic dependencies.
 */

export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "waiting"
  | "blocked"
  | "completed"
  | "cancelled";

export const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "assigned",
  "in_progress",
  "waiting",
  "blocked",
  "completed",
  "cancelled",
];

export type TaskPriority = "low" | "normal" | "high" | "critical";

export const TASK_PRIORITIES: TaskPriority[] = [
  "low",
  "normal",
  "high",
  "critical",
];

export interface PipeTask {
  schemaVersion: 1;
  id: string;
  pipeId: string;

  /** Human readable short number for display (per pipe, e.g. #42). */
  number: number;

  title: string;
  description: string;

  /** Participant id that created the task. */
  createdBy: string;

  /** Participant name/identity the task is assigned to. */
  assignedTo?: string;

  status: TaskStatus;
  priority: TaskPriority;

  createdAt: number;
  updatedAt: number;
  completedAt?: number;

  blockedReason?: string;

  dependsOn: string[];

  metadata?: Record<string, unknown>;
}

/**
 * Legal task transitions. A task is terminal once completed or cancelled.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "in_progress", "cancelled"],
  assigned: ["in_progress", "waiting", "blocked", "cancelled"],
  in_progress: ["waiting", "blocked", "completed", "cancelled"],
  waiting: ["in_progress", "blocked", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  completed: [],
  cancelled: [],
};

export function isValidTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTaskStatus(v: unknown): v is TaskStatus {
  return (TASK_STATUSES as string[]).includes(v as string);
}

export function isTaskPriority(v: unknown): v is TaskPriority {
  return (TASK_PRIORITIES as string[]).includes(v as string);
}
