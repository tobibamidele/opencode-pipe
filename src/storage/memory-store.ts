/**
 * In-memory store. Primarily for tests and single-process usage; does NOT
 * survive restarts and is NOT shared between processes.
 */

import type { Pipe } from "../models/pipe.js";
import type { Participant } from "../models/participant.js";
import type { PipeMessage } from "../models/message.js";
import type { PipeTask } from "../models/task.js";
import type { PipeStore } from "./store.js";
import { pipeError } from "../utils/errors.js";

export class MemoryStore implements PipeStore {
  protected pipes = new Map<string, Pipe>();
  protected pipesByName = new Map<string, string>();
  protected participants = new Map<string, Participant>();
  protected messages = new Map<string, PipeMessage>();
  protected tasks = new Map<string, PipeTask>();

  // ---- Pipes ----
  async createPipe(pipe: Pipe): Promise<Pipe> {
    this.pipes.set(pipe.id, structuredClone(pipe));
    this.pipesByName.set(pipe.name, pipe.id);
    return structuredClone(pipe);
  }
  async getPipe(id: string): Promise<Pipe | undefined> {
    const p = this.pipes.get(id);
    return p ? structuredClone(p) : undefined;
  }
  async getPipeByName(name: string): Promise<Pipe | undefined> {
    const id = this.pipesByName.get(name);
    if (!id) return undefined;
    return this.getPipe(id);
  }
  async listPipes(): Promise<Pipe[]> {
    return [...this.pipes.values()].map((p) => structuredClone(p));
  }
  async updatePipe(pipe: Pipe): Promise<Pipe> {
    this.pipes.set(pipe.id, structuredClone(pipe));
    this.pipesByName.set(pipe.name, pipe.id);
    return structuredClone(pipe);
  }
  async deletePipe(id: string): Promise<void> {
    const p = this.pipes.get(id);
    if (p) this.pipesByName.delete(p.name);
    this.pipes.delete(id);
  }

  // ---- Participants ----
  async createParticipant(p: Participant): Promise<Participant> {
    this.participants.set(p.id, structuredClone(p));
    return structuredClone(p);
  }
  async getParticipant(id: string): Promise<Participant | undefined> {
    const p = this.participants.get(id);
    return p ? structuredClone(p) : undefined;
  }
  async listParticipants(pipeId: string): Promise<Participant[]> {
    return [...this.participants.values()]
      .filter((p) => p.pipeId === pipeId)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => structuredClone(p));
  }
  async updateParticipant(p: Participant): Promise<Participant> {
    this.participants.set(p.id, structuredClone(p));
    return structuredClone(p);
  }
  async deleteParticipant(id: string): Promise<void> {
    this.participants.delete(id);
  }

  // ---- Messages ----
  async createMessage(msg: PipeMessage): Promise<PipeMessage> {
    this.messages.set(msg.id, structuredClone(msg));
    return structuredClone(msg);
  }
  async getMessage(id: string): Promise<PipeMessage | undefined> {
    const m = this.messages.get(id);
    return m ? structuredClone(m) : undefined;
  }
  async listMessages(
    pipeId: string,
    limit?: number,
    offset?: number,
  ): Promise<PipeMessage[]> {
    let list = [...this.messages.values()].filter((m) => m.pipeId === pipeId);
    list.sort((a, b) => a.sequence - b.sequence);
    if (offset !== undefined) list = list.slice(offset);
    if (limit !== undefined) list = list.slice(-limit);
    return list.map((m) => structuredClone(m));
  }
  async nextSequence(pipeId: string): Promise<number> {
    const list = [...this.messages.values()].filter((m) => m.pipeId === pipeId);
    if (list.length === 0) return 1;
    let max = 0;
    for (const m of list) if (m.sequence > max) max = m.sequence;
    return max + 1;
  }
  async deleteMessage(id: string): Promise<void> {
    this.messages.delete(id);
  }

  // ---- Tasks ----
  async createTask(task: PipeTask): Promise<PipeTask> {
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }
  async getTask(id: string): Promise<PipeTask | undefined> {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : undefined;
  }
  async listTasks(pipeId: string): Promise<PipeTask[]> {
    return [...this.tasks.values()]
      .filter((t) => t.pipeId === pipeId)
      .sort((a, b) => a.number - b.number)
      .map((t) => structuredClone(t));
  }
  async updateTask(task: PipeTask): Promise<PipeTask> {
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }

  async close(): Promise<void> {}
}
