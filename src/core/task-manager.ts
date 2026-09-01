/**
 * Task manager. Enforces the task state machine and basic dependency awareness.
 */

import type { PipeStore } from "../storage/store.js";
import type { PipeTask, TaskStatus, TaskPriority } from "../models/task.js";
import { isValidTaskTransition } from "../models/task.js";
import type { PipeEventBus } from "./event-bus.js";
import { newId } from "../utils/ids.js";
import { pipeError } from "../utils/errors.js";

export class TaskManager {
  constructor(
    private readonly store: PipeStore,
    private readonly bus: PipeEventBus,
  ) {}

  async createTask(input: {
    pipeId: string;
    createdBy: string;
    title: string;
    description: string;
    assignedTo?: string;
    priority?: TaskPriority;
    dependsOn?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<PipeTask> {
    const pipe = await this.store.getPipe(input.pipeId);
    if (!pipe) throw pipeError("PIPE_NOT_FOUND", `Pipe ${input.pipeId} not found`);

    const existing = await this.store.listTasks(input.pipeId);
    const maxNumber = existing.reduce((m, t) => Math.max(m, t.number), 0);

    const task: PipeTask = {
      schemaVersion: 1,
      id: newId("task"),
      pipeId: input.pipeId,
      number: maxNumber + 1,
      title: input.title,
      description: input.description,
      createdBy: input.createdBy,
      assignedTo: input.assignedTo,
      status: "pending",
      priority: input.priority ?? "normal",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dependsOn: input.dependsOn ?? [],
      metadata: input.metadata,
    };

    await this.store.createTask(task);

    const updatedPipe = await this.store.getPipe(input.pipeId);
    if (updatedPipe) {
      updatedPipe.taskCount = (await this.store.listTasks(input.pipeId)).length;
      updatedPipe.updatedAt = Date.now();
      await this.store.updatePipe(updatedPipe);
    }

    this.bus.emit({ type: "task.created", task });
    return task;
  }

  async transitionTask(
    taskId: string,
    status: TaskStatus,
    opts?: { blockedReason?: string },
  ): Promise<PipeTask> {
    const task = await this.store.getTask(taskId);
    if (!task) throw pipeError("TASK_NOT_FOUND", `Task ${taskId} not found`);

    if (!isValidTaskTransition(task.status, status)) {
      throw pipeError(
        "INVALID_TASK_STATE",
        `Invalid task transition ${task.status} -> ${status}`,
      );
    }

    task.status = status;
    task.updatedAt = Date.now();
    if (status === "blocked") task.blockedReason = opts?.blockedReason;
    if (status === "completed") {
      task.completedAt = Date.now();
      task.blockedReason = undefined;
    }
    if (status !== "blocked") task.blockedReason = opts?.blockedReason ?? task.blockedReason;

    const updated = await this.store.updateTask(task);
    this.bus.emit({ type: "task.updated", task: updated });
    return updated;
  }

  async getTask(taskId: string): Promise<PipeTask | undefined> {
    return this.store.getTask(taskId);
  }

  async listTasks(pipeId: string): Promise<PipeTask[]> {
    return this.store.listTasks(pipeId);
  }

  /** Tasks whose dependencies are all completed (ready to start). */
  async readyTasks(pipeId: string): Promise<PipeTask[]> {
    const tasks = await this.store.listTasks(pipeId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return tasks.filter((t) => {
      if (t.status !== "pending" && t.status !== "assigned") return false;
      return t.dependsOn.every((d) => byId.get(d)?.status === "completed");
    });
  }
}
