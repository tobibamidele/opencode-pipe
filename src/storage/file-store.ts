/**
 * File-backed store.
 *
 * Layout under a shared user-level data directory:
 *
 *   <dataDir>/pipes/
 *   ├── index.json
 *   ├── <name>/
 *   │   ├── pipe.json
 *   │   ├── participants.json
 *   │   ├── messages.jsonl
 *   │   └── tasks.json
 *
 * Messages use JSON Lines so appends never require rewriting the file, which is
 * important because multiple OpenCode processes may write concurrently.
 *
 * Safety:
 *  - metadata files are written atomically (temp file + rename).
 *  - message appends tolerate partial trailing records (from a concurrent
 *    write that was interrupted mid-append).
 *  - a pipe id maps to a directory whose name is the pipe's *hex-encoded id*,
 *    so the human pipe name is never used as a filesystem path (defends against
 *    path traversal / invalid names across processes).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Pipe } from "../models/pipe.js";
import type { Participant } from "../models/participant.js";
import type { PipeMessage } from "../models/message.js";
import type { PipeTask } from "../models/task.js";
import type { PipeStore } from "./store.js";
import { pipeError } from "../utils/errors.js";
import { pipesRoot, pipeDir as pipeDirPath } from "../utils/paths.js";

interface PipeIndex {
  schemaVersion: 1;
  /** pipe id -> pipe name  */
  byId: Record<string, string>;
}

export class FileStore implements PipeStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = pipesRoot(dataDir);
  }

  // ---- low-level helpers ----

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private pipeDir(pipeId: string): string {
    return pipeDirPath(this.root, pipeId);
  }

  /** Public access to a per-pipe data file path (used by FileTransport). */
  fileFor(pipeId: string, name: string): string {
    return path.join(this.pipeDir(pipeId), name);
  }

  private async readIndex(): Promise<PipeIndex> {
    await this.ensureRoot();
    const file = path.join(this.root, "index.json");
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        parsed.schemaVersion === 1 &&
        parsed.byId
      ) {
        return parsed as PipeIndex;
      }
      return { schemaVersion: 1, byId: {} };
    } catch {
      return { schemaVersion: 1, byId: {} };
    }
  }

  private async writeIndex(index: PipeIndex): Promise<void> {
    await this.atomicWrite(path.join(this.root, "index.json"), index);
  }

  private async atomicWrite(file: string, data: unknown): Promise<void> {
    await this.ensureRoot();
    const tmp = file + ".tmp-" + randomBytes(4).toString("hex");
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(file, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async readPipeFile(pipeId: string, name: string, fallback: unknown) {
    return this.readJson(path.join(this.pipeDir(pipeId), name), fallback);
  }

  private async ensurePipeDir(pipeId: string): Promise<string> {
    await this.ensureRoot();
    const dir = this.pipeDir(pipeId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  // ---- Pipes ----

  async createPipe(pipe: Pipe): Promise<Pipe> {
    const index = await this.readIndex();
    if (index.byId[pipe.id]) {
      throw pipeError("PIPE_ALREADY_EXISTS", `Pipe id ${pipe.id} already exists`);
    }
    index.byId[pipe.id] = pipe.name;
    const dir = await this.ensurePipeDir(pipe.id);
    await this.atomicWrite(path.join(dir, "pipe.json"), pipe);
    await this.atomicWrite(path.join(dir, "participants.json"), []);
    await this.atomicWrite(path.join(dir, "tasks.json"), []);
    await this.writeIndex(index);
    return pipe;
  }

  async getPipe(id: string): Promise<Pipe | undefined> {
    return this.readPipeFile(id, "pipe.json", undefined) as Promise<Pipe | undefined>;
  }

  async getPipeByName(name: string): Promise<Pipe | undefined> {
    const index = await this.readIndex();
    const id = Object.keys(index.byId).find((k) => index.byId[k] === name);
    if (!id) return undefined;
    return this.getPipe(id);
  }

  async listPipes(): Promise<Pipe[]> {
    const index = await this.readIndex();
    const pipes: Pipe[] = [];
    for (const id of Object.keys(index.byId)) {
      const p = await this.getPipe(id);
      if (p) pipes.push(p);
    }
    return pipes.sort((a, b) => a.createdAt - b.createdAt);
  }

  async updatePipe(pipe: Pipe): Promise<Pipe> {
    const index = await this.readIndex();
    if (!index.byId[pipe.id]) {
      throw pipeError("PIPE_NOT_FOUND", `Pipe ${pipe.id} not found`);
    }
    index.byId[pipe.id] = pipe.name;
    await this.atomicWrite(path.join(this.pipeDir(pipe.id), "pipe.json"), pipe);
    await this.writeIndex(index);
    return pipe;
  }

  async deletePipe(id: string): Promise<void> {
    const index = await this.readIndex();
    if (!index.byId[id]) return;
    delete index.byId[id];
    await this.writeIndex(index);
    await fs.rm(this.pipeDir(id), { recursive: true, force: true });
  }

  // ---- Participants ----

  async createParticipant(p: Participant): Promise<Participant> {
    await this.ensurePipeDir(p.pipeId);
    const file = path.join(this.pipeDir(p.pipeId), "participants.json");
    const list = await this.readJson<Participant[]>(file, []);
    list.push(p);
    await this.atomicWrite(file, list);
    return p;
  }

  async getParticipant(id: string): Promise<Participant | undefined> {
    const pipes = await this.listPipes();
    for (const pipe of pipes) {
      const list = await this.readPipeFile(pipe.id, "participants.json", []);
      const found = (list as Participant[]).find((p) => p.id === id);
      if (found) return found;
    }
    return undefined;
  }

  async listParticipants(pipeId: string): Promise<Participant[]> {
    const list = await this.readPipeFile(pipeId, "participants.json", []);
    return (list as Participant[])
      .slice()
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  async updateParticipant(p: Participant): Promise<Participant> {
    const file = path.join(this.pipeDir(p.pipeId), "participants.json");
    const list = await this.readJson<Participant[]>(file, []);
    const idx = list.findIndex((x) => x.id === p.id);
    if (idx === -1) {
      throw pipeError("PARTICIPANT_NOT_FOUND", `Participant ${p.id} not found`);
    }
    list[idx] = p;
    await this.atomicWrite(file, list);
    return p;
  }

  async deleteParticipant(id: string): Promise<void> {
    const pipes = await this.listPipes();
    for (const pipe of pipes) {
      const list = await this.readPipeFile(pipe.id, "participants.json", []);
      const next = (list as Participant[]).filter((p) => p.id !== id);
      if (next.length !== (list as Participant[]).length) {
        await this.atomicWrite(
          path.join(this.pipeDir(pipe.id), "participants.json"),
          next,
        );
      }
    }
  }

  // ---- Messages ----

  async createMessage(msg: PipeMessage): Promise<PipeMessage> {
    const dir = await this.ensurePipeDir(msg.pipeId);
    const file = path.join(dir, "messages.jsonl");
    const line =
      JSON.stringify({
        schemaVersion: msg.schemaVersion,
        id: msg.id,
        pipeId: msg.pipeId,
        sequence: msg.sequence,
        senderId: msg.senderId,
        senderName: msg.senderName,
        senderType: msg.senderType,
        recipient: msg.recipient,
        type: msg.type,
        content: msg.content,
        createdAt: msg.createdAt,
        replyTo: msg.replyTo,
        taskId: msg.taskId,
        chain: msg.chain,
        metadata: msg.metadata,
      }) + "\n";
    let handle;
    try {
      // Append is atomic for small writes on most OSes (O_APPEND).
      handle = await fs.open(file, "a");
      await handle.writeFile(line, "utf8");
    } finally {
      await handle?.close();
    }
    return msg;
  }

  async getMessage(id: string): Promise<PipeMessage | undefined> {
    const pipes = await this.listPipes();
    for (const pipe of pipes) {
      const msgs = await this.readMessagesFile(pipe.id);
      const found = msgs.find((m) => m.id === id);
      if (found) return found;
    }
    return undefined;
  }

  private async readMessagesFile(pipeId: string): Promise<PipeMessage[]> {
    const file = path.join(this.pipeDir(pipeId), "messages.jsonl");
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return [];
    }
    const out: PipeMessage[] = [];
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line.trim() === "") continue;
      // Tolerate a partial trailing record from a concurrent/interrupted write.
      try {
        out.push(JSON.parse(line) as PipeMessage);
      } catch {
        // Skip malformed / partial line; do not corrupt the log.
      }
    }
    return out;
  }

  async listMessages(
    pipeId: string,
    limit?: number,
    offset?: number,
  ): Promise<PipeMessage[]> {
    let list = await this.readMessagesFile(pipeId);
    list.sort((a, b) => a.sequence - b.sequence);
    if (offset !== undefined) list = list.slice(offset);
    if (limit !== undefined) list = list.slice(-limit);
    return list;
  }

  async deleteMessage(id: string): Promise<void> {
    const pipes = await this.listPipes();
    for (const pipe of pipes) {
      const list = await this.readMessagesFile(pipe.id);
      const next = list.filter((m) => m.id !== id);
      if (next.length !== list.length) {
        await this.atomicWrite(
          path.join(this.pipeDir(pipe.id), "messages.jsonl"),
          next.map((m) => JSON.stringify(m)).join("\n") + "\n",
        );
      }
    }
  }

  async nextSequence(pipeId: string): Promise<number> {
    const list = await this.readMessagesFile(pipeId);
    let max = 0;
    for (const m of list) if (m.sequence > max) max = m.sequence;
    return max + 1;
  }

  // ---- Tasks ----

  async createTask(task: PipeTask): Promise<PipeTask> {
    await this.ensurePipeDir(task.pipeId);
    const file = path.join(this.pipeDir(task.pipeId), "tasks.json");
    const list = await this.readJson<PipeTask[]>(file, []);
    list.push(task);
    await this.atomicWrite(file, list);
    return task;
  }

  async getTask(id: string): Promise<PipeTask | undefined> {
    const pipes = await this.listPipes();
    for (const pipe of pipes) {
      const list = await this.readPipeFile(pipe.id, "tasks.json", []);
      const found = (list as PipeTask[]).find((t) => t.id === id);
      if (found) return found;
    }
    return undefined;
  }

  async listTasks(pipeId: string): Promise<PipeTask[]> {
    const list = await this.readPipeFile(pipeId, "tasks.json", []);
    return (list as PipeTask[]).slice().sort((a, b) => a.number - b.number);
  }

  async updateTask(task: PipeTask): Promise<PipeTask> {
    const file = path.join(this.pipeDir(task.pipeId), "tasks.json");
    const list = await this.readJson<PipeTask[]>(file, []);
    const idx = list.findIndex((t) => t.id === task.id);
    if (idx === -1) {
      throw pipeError("TASK_NOT_FOUND", `Task ${task.id} not found`);
    }
    list[idx] = task;
    await this.atomicWrite(file, list);
    return task;
  }

  async deleteTask(id: string): Promise<void> {
    const pipes = await this.listPipes();
    for (const pipe of pipes) {
      const list = await this.readPipeFile(pipe.id, "tasks.json", []);
      const next = (list as PipeTask[]).filter((t) => t.id !== id);
      if (next.length !== (list as PipeTask[]).length) {
        await this.atomicWrite(
          path.join(this.pipeDir(pipe.id), "tasks.json"),
          next,
        );
      }
    }
  }

  async close(): Promise<void> {}
}
