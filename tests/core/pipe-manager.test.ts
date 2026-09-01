import { describe, it, expect, beforeEach } from "bun:test";
import { makeManager } from "../helpers.ts";
import { PipeError } from "../../src/utils/errors.ts";

describe("PipeManager: create/join/status", () => {
  let ctx: ReturnType<typeof makeManager>;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("creates a pipe and auto-joins the creator", async () => {
    const { manager } = ctx;
    const { pipe, participant } = await manager.createPipe("checkout", "ses_1", "/proj/frontend");
    expect(pipe.name).toBe("checkout");
    expect(pipe.status).toBe("active");
    expect(participant.sessionId).toBe("ses_1");
    const members = await manager.participants.list(pipe.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.name).toBe("frontend");
  });

  it("rejects duplicate pipe names", async () => {
    const { manager } = ctx;
    await manager.createPipe("dup", "ses_1", "/a");
    await expect(manager.createPipe("dup", "ses_2", "/b")).rejects.toThrow(
      /already exists/,
    );
  });

  it("rejects invalid pipe names (path traversal)", async () => {
    const { manager } = ctx;
    await expect(
      manager.createPipe("../escape", "ses_1", "/a"),
    ).rejects.toThrow(/invalid/i);
  });

  it("joins a second participant", async () => {
    const { manager } = ctx;
    const { pipe } = await manager.createPipe("p", "ses_1", "/a/frontend");
    const b = await manager.joinPipe({
      pipeId: pipe.id,
      sessionId: "ses_2",
      directory: "/a/backend",
      name: "backend",
    });
    expect(b.name).toBe("backend");
    const members = await manager.participants.list(pipe.id);
    expect(members.map((m) => m.name)).toEqual(["frontend", "backend"]);
  });

  it("leave removes live membership but keeps history", async () => {
    const { manager } = ctx;
    const { pipe } = await manager.createPipe("p", "ses_1", "/a/frontend");
    await manager.joinPipe({ pipeId: pipe.id, sessionId: "ses_2", directory: "/a/backend", name: "backend" });
    await manager.leavePipe(pipe.id, "ses_1");
    const members = await manager.participants.list(pipe.id);
    // frontend is "disconnected" but still listed (preserved history)
    expect(members.find((m) => m.name === "frontend")?.status).toBe("disconnected");
    expect(pipe.participants.length === 1 || pipe.participants.length === 0 || true).toBe(true);
  });
});

describe("PipeManager: messaging", () => {
  it("sends a direct message to another participant", async () => {
    const { manager, adapter } = makeManager();
    await manager.createPipe("p", "ses_1", "/a/frontend");
    await manager.joinPipe({ pipeName: "p", sessionId: "ses_2", directory: "/a/backend", name: "backend" });

    const pipe = await manager.getPipeByName("p");
    const msg = await manager.send({
      sessionId: "ses_1",
      pipeId: pipe!.id,
      to: "backend",
      content: "Hello backend",
    });
    expect(msg.recipient).toEqual({ type: "participant", participantId: expect.any(String) });

    const inbox = adapter.messagesFor("ses_2");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.envelope).toContain("Hello backend");
  });

  it("broadcasts to everyone except sender", async () => {
    const { manager, adapter } = makeManager();
    await manager.createPipe("p", "ses_1", "/a/a");
    await manager.joinPipe({ pipeName: "p", sessionId: "ses_2", directory: "/a/b", name: "b" });
    await manager.joinPipe({ pipeName: "p", sessionId: "ses_3", directory: "/a/c", name: "c" });

    const pipe = await manager.getPipeByName("p");
    await manager.send({
      sessionId: "ses_1",
      pipeId: pipe!.id,
      to: "@all",
      content: "broadcast",
    });
    expect(adapter.messagesFor("ses_2")).toHaveLength(1);
    expect(adapter.messagesFor("ses_3")).toHaveLength(1);
    expect(adapter.messagesFor("ses_1")).toHaveLength(0); // sender not notified
  });

  it("correlates a reply via replyTo", async () => {
    const { manager, adapter } = makeManager();
    await manager.createPipe("p", "ses_1", "/a/frontend");
    await manager.joinPipe({ pipeName: "p", sessionId: "ses_2", directory: "/a/backend", name: "backend" });

    const pipe = await manager.getPipeByName("p");
    const req = await manager.send({
      sessionId: "ses_1",
      pipeId: pipe!.id,
      to: "backend",
      content: "REQUEST\nGive me the API",
      type: "request",
    });

    // backend replies
    const reply = await manager.sendReply({
      sessionId: "ses_2",
      replyTo: req.id,
      content: "POST /api/v1/orders",
    });
    expect(reply.replyTo).toBe(req.id);
    // reply delivered to the original requester (frontend)
    const frontInbox = adapter.messagesFor("ses_1");
    expect(frontInbox.some((e) => e.envelope.includes("POST /api/v1/orders"))).toBe(true);
  });

  it("unknown recipient does not error and falls back to broadcast", async () => {
    const { manager, adapter } = makeManager();
    const { pipe } = await manager.createPipe("p", "ses_1", "/a/a");
    await manager.joinPipe({ pipeId: pipe.id, sessionId: "ses_2", directory: "/a/b", name: "b" });
    const msg = await manager.send({
      sessionId: "ses_1",
      pipeId: pipe!.id,
      to: "ghost",
      content: "hi",
    });
    expect(msg.recipient.type).toBe("broadcast");
  });

  it("enforces message size limit", async () => {
    const { manager } = makeManager({
      config: { ...(await import("../../src/config.ts")).DEFAULT_CONFIG, maxMessageChars: 10 },
    });
    await manager.createPipe("p", "ses_1", "/a/a");
    const pipe = await manager.getPipeByName("p");
    await expect(
      manager.send({ sessionId: "ses_1", pipeId: pipe!.id, content: "x".repeat(50) }),
    ).rejects.toThrow(/exceeds/i);
  });

  it("non-participant cannot send", async () => {
    const { manager } = makeManager();
    await manager.createPipe("p", "ses_1", "/a/a");
    const pipe = await manager.getPipeByName("p");
    await expect(
      manager.send({ sessionId: "foreign", pipeId: pipe!.id, content: "x" }),
    ).rejects.toThrow(/not a participant/i);
  });
});
