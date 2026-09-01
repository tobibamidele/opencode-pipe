import { describe, it, expect, beforeEach } from "bun:test";
import { makeManager } from "../helpers.ts";

describe("TaskManager: state machine", () => {
  let ctx: ReturnType<typeof makeManager>;
  beforeEach(() => {
    ctx = makeManager();
  });

  async function createTask() {
    const { manager } = ctx;
    const { pipe } = await manager.createPipe("p", "ses_1", "/a");
    const task = await manager.createTask({
      pipeId: pipe.id,
      createdBy: "part_1",
      title: "Implement API",
      description: "POST /orders",
      assignedTo: "backend",
    });
    return { manager, pipe, task };
  }

  it("starts as pending and allows legal transitions", async () => {
    const { manager, task } = await createTask();
    expect(task.status).toBe("pending");

    const assigned = await manager.transitionTask(task.id, "assigned");
    expect(assigned.status).toBe("assigned");
    const inProg = await manager.transitionTask(task.id, "in_progress");
    expect(inProg.status).toBe("in_progress");
    const done = await manager.transitionTask(task.id, "completed");
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeDefined();
  });

  it("blocks illegal transitions and terminal states", async () => {
    const { manager, task } = await createTask();
    // pending -> completed is illegal
    await expect(manager.transitionTask(task.id, "completed")).rejects.toThrow(
      /invalid/i,
    );
    await manager.transitionTask(task.id, "assigned");
    // from a terminal state no further transitions
    await manager.transitionTask(task.id, "in_progress");
    await manager.transitionTask(task.id, "completed");
    await expect(manager.transitionTask(task.id, "cancelled")).rejects.toThrow(
      /invalid/i,
    );
  });

  it("records blocked reason", async () => {
    const { manager, task } = await createTask();
    await manager.transitionTask(task.id, "assigned");
    const blocked = await manager.transitionTask(task.id, "blocked", {
      blockedReason: "Need decision on refresh tokens",
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toBe("Need decision on refresh tokens");
  });

  it("readyTasks only returns those with completed deps", async () => {
    const { manager, pipe } = await createTask();
    const t1 = await manager.createTask({
      pipeId: pipe.id,
      createdBy: "part_1",
      title: "migration",
      description: "db",
    });
    const t2 = await manager.createTask({
      pipeId: pipe.id,
      createdBy: "part_1",
      title: "endpoint",
      description: "api",
      dependsOn: [t1.id],
    });
    // t2 depends on t1 (incomplete) -> not ready yet
    let ready = await manager.readyTasks(pipe.id);
    expect(ready.map((t) => t.id)).not.toContain(t2.id);

    await manager.transitionTask(t1.id, "assigned");
    await manager.transitionTask(t1.id, "in_progress");
    await manager.transitionTask(t1.id, "completed");

    ready = await manager.readyTasks(pipe.id);
    expect(ready.map((t) => t.id)).toContain(t2.id);
  });
});
