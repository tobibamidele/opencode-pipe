/**
 * End-to-end test simulating the MVP acceptance flow across two independent
 * "processes" (A=frontend, B=backend) sharing a data dir:
 *
 *   A creates pipe "demo", joins as frontend
 *   B joins as backend
 *   A -> B message, B receives
 *   B -> A reply, A receives
 *   A -> B task, B completes it, A is notified
 */

import { describe, it, expect, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PipeManager } from "../../src/core/pipe-manager.ts";
import { FileStore } from "../../src/storage/file-store.ts";
import { FileTransport } from "../../src/core/file-transport.ts";
import { FakeSessionAdapter } from "../helpers.ts";

const cleanup: string[] = [];
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a condition until true or a timeout elapses (ms). */
async function waitFor(cond: () => boolean, timeoutMs = 4000, interval = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(interval);
  }
  return cond();
}

function makeProcess(dataDir: string) {
  const store = new FileStore(dataDir);
  const transport = new FileTransport(dataDir);
  const adapter = new FakeSessionAdapter();
  const manager = new PipeManager({ store, transport, session: adapter });
  return { manager, adapter };
}

describe("End-to-end: two sessions collaborate through a pipe", () => {
  afterEach(async () => {
    for (const d of cleanup) await fs.rm(d, { recursive: true, force: true });
    cleanup.length = 0;
  });

  it("frontend <-> backend request/reply/task lifecycle", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "pipes-e2e-"));
    cleanup.push(dataDir);

    const frontend = makeProcess(dataDir);
    const backend = makeProcess(dataDir);

    // A creates the pipe (auto-joins as frontend) and B joins as backend.
    const { pipe } = await frontend.manager.createPipe("demo", "ses_front", "/proj/frontend");
    await backend.manager.joinPipe({
      pipeId: pipe.id,
      sessionId: "ses_back",
      directory: "/proj/backend",
      name: "backend",
    });

    // 1. A -> B: request
    const req = await frontend.manager.send({
      sessionId: "ses_front",
      pipeId: pipe.id,
      to: "backend",
      content: "REQUEST\nProvide the order creation API contract.",
      type: "request",
    });
    expect(req.type).toBe("request");
    const gotReq = await waitFor(() =>
      backend.adapter.messagesFor("ses_back").some((e) => e.envelope.includes("order creation")),
    );
    expect(gotReq).toBe(true);

    // 2. B -> A: reply to the request
    await backend.manager.sendReply({
      sessionId: "ses_back",
      replyTo: req.id,
      content: "POST /api/v1/orders\nRequest: { items }",
    });
    const gotReply = await waitFor(() =>
      frontend.adapter.messagesFor("ses_front").some((e) => e.envelope.includes("POST /api/v1/orders")),
    );
    expect(gotReply).toBe(true);

    // 3. A -> B: task
    const task = await frontend.manager.createTask({
      pipeId: pipe.id,
      createdBy: "part_front",
      title: "Implement order endpoint",
      description: "Implement POST /orders in backend workspace",
      assignedTo: "backend",
    });
    expect(task.number).toBe(1);

    // 4. B takes ownership and completes it.
    await backend.manager.transitionTask(task.id, "assigned");
    await backend.manager.transitionTask(task.id, "in_progress");
    await backend.manager.transitionTask(task.id, "completed");

    const st = await frontend.manager.pipeStatus(pipe.id);
    expect(st.tasks[0]?.status).toBe("completed");

    // Both processes see the same shared messages.
    const frontHistory = await frontend.manager.history(pipe.id);
    const backHistory = await backend.manager.history(pipe.id);
    expect(frontHistory.map((m) => m.id).sort()).toEqual(backHistory.map((m) => m.id).sort());
  });
});
