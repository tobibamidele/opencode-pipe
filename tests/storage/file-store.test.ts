import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileStore } from "../../src/storage/file-store.ts";
import type { Pipe } from "../../src/models/pipe.ts";
import type { PipeMessage } from "../../src/models/message.ts";
import type { Participant } from "../../src/models/participant.ts";
import type { PipeTask } from "../../src/models/task.ts";

const dirs: string[] = [];

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pipes-test-"));
  dirs.push(dir);
  return { store: new FileStore(dir), dir };
}

describe("FileStore", () => {
  let store: FileStore;
  let dir: string;
  beforeEach(async () => {
    const x = await makeStore();
    store = x.store;
    dir = x.dir;
  });
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("persists a pipe and reloads it on a fresh process", async () => {
    const pipe: Pipe = {
      id: "pipe_a",
      name: "checkout",
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      createdBy: "part_x",
      status: "active",
      participants: [],
      messageCount: 0,
      taskCount: 0,
    };
    await store.createPipe(pipe);

    // Simulate a brand-new process (new store instance on same dir).
    const store2 = new FileStore(dir);
    const loaded = await store2.getPipeByName("checkout");
    expect(loaded?.id).toBe("pipe_a");
    expect(loaded?.name).toBe("checkout");
  });

  it("does not use the pipe name as a filesystem path (path traversal safe)", async () => {
    // This must be impossible via the public API due to name validation, but
    // verify the dir name is derived from the id, not the name.
    const pipe: Pipe = {
      id: "pipe_b",
      name: "weird name",
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      createdBy: "c",
      status: "active",
      participants: [],
      messageCount: 0,
      taskCount: 0,
    };
    await store.createPipe(pipe);
    // The on-disk dir is the hex of the id -- no directory named "weird name".
    const hex = Buffer.from("pipe_b", "utf8").toString("hex");
    const dirPath = path.join(dir, "pipes", hex);
    // The hex-encoded directory exists.
    await expect(fs.stat(dirPath)).resolves.toBeDefined();
    // No directory with the raw (unsafe) name exists.
    await expect(fs.access(path.join(dir, "pipes", "weird name"))).rejects.toThrow();
  });

  it("tolerates a corrupted trailing JSONL record", async () => {
    const store2 = new FileStore(dir);
    const pipe: Pipe = {
      id: "pipe_c", name: "c", schemaVersion: 1, createdAt: 1, updatedAt: 1,
      createdBy: "x", status: "active", participants: [], messageCount: 0, taskCount: 0,
    };
    await store2.createPipe(pipe);
    const hex = Buffer.from("pipe_c", "utf8").toString("hex");
    const file = path.join(dir, "pipes", hex, "messages.jsonl");
    const mk = (seq: number, id: string): PipeMessage =>
      ({ schemaVersion: 1, id, pipeId: "pipe_c", sequence: seq,
         senderId: "s", senderName: "s", senderType: "agent",
         recipient: { type: "broadcast" }, type: "message",
         content: `m${seq}`, createdAt: seq }) as PipeMessage;
    const line1 = JSON.stringify(mk(1, "msg_1"));
    const good = JSON.stringify(mk(2, "msg_2"));
    await fs.writeFile(file, line1 + "\n" + good + "\n{\"id\":\"msg_partial\",\"se", "utf8");

    const messages = await store2.listMessages("pipe_c");
    // Partial trailing record is skipped without corrupting the log.
    expect(messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
  });

  it("orders and paginates messages by sequence", async () => {
    const store2 = new FileStore(dir);
    const pipe: Pipe = {
      id: "pipe_d", name: "d", schemaVersion: 1, createdAt: 1, updatedAt: 1,
      createdBy: "x", status: "active", participants: [], messageCount: 0, taskCount: 0,
    };
    await store2.createPipe(pipe);
    for (let i = 1; i <= 5; i++) {
      const m: PipeMessage = {
        schemaVersion: 1, id: `msg_${i}`, pipeId: "pipe_d", sequence: i,
        senderId: "s", senderName: "s", senderType: "agent",
        recipient: { type: "broadcast" }, type: "message", content: `m${i}`, createdAt: i,
      };
      await store2.createMessage(m);
    }
    const all = await store2.listMessages("pipe_d");
    expect(all.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5]);
    const last2 = await store2.listMessages("pipe_d", 2);
    expect(last2.map((m) => m.sequence)).toEqual([4, 5]);
  });

  it("handles concurrent append from multiple store instances", async () => {
    // Two "processes" share the same dir.
    const a = new FileStore(dir);
    const b = new FileStore(dir);
    const pipe: Pipe = {
      id: "pipe_e", name: "e", schemaVersion: 1, createdAt: 1, updatedAt: 1,
      createdBy: "x", status: "active", participants: [], messageCount: 0, taskCount: 0,
    };
    await a.createPipe(pipe);
    const write = async (store: FileStore, id: string, seq: number) => {
      const m: PipeMessage = {
        schemaVersion: 1, id, pipeId: "pipe_e", sequence: seq,
        senderId: "s", senderName: "s", senderType: "agent",
        recipient: { type: "broadcast" }, type: "message", content: id, createdAt: seq,
      };
      await store.createMessage(m);
    };
    await Promise.all([write(a, "msg_a", 1), write(b, "msg_b", 2)]);
    const all = await a.listMessages("pipe_e");
    expect(all.map((m) => m.id).sort()).toEqual(["msg_a", "msg_b"]);
  });

  it("persists participants and tasks", async () => {
    const store2 = new FileStore(dir);
    const pipe: Pipe = {
      id: "pipe_f", name: "f", schemaVersion: 1, createdAt: 1, updatedAt: 1,
      createdBy: "x", status: "active", participants: [], messageCount: 0, taskCount: 0,
    };
    await store2.createPipe(pipe);
    const part: Participant = {
      id: "part_1", pipeId: "pipe_f", sessionId: "ses_1", name: "frontend",
      directory: "/a/frontend", joinedAt: 1, lastSeenAt: 1, status: "online",
    };
    await store2.createParticipant(part);
    const task: PipeTask = {
      schemaVersion: 1, id: "task_1", pipeId: "pipe_f", number: 1,
      title: "t", description: "d", createdBy: "part_1",
      status: "pending", priority: "normal", createdAt: 1, updatedAt: 1, dependsOn: [],
    };
    await store2.createTask(task);

    const fresh = new FileStore(dir);
    expect(await fresh.getParticipant("part_1")).toMatchObject({ name: "frontend" });
    expect(await fresh.listTasks("pipe_f")).toHaveLength(1);
  });
});
