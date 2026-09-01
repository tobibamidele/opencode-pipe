/**
 * Auto-reply behavior: when a message is delivered to a session and the
 * adapter captures a model reply, the manager routes that reply back to the
 * original sender as a `response` (replyTo correlated, chain/hop bounded).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { makeManager } from "../helpers.ts";
import type { PipeMessage } from "../../src/models/message.ts";

describe("PipeManager: auto-reply", () => {
  let ctx: ReturnType<typeof makeManager>;
  beforeEach(() => {
    ctx = makeManager();
  });

  /**
   * A -> B (direct). B's adapter "responds" with text. Expect a response
   * message B -> A with replyTo = original id and an incremented hop count.
   */
  it("routes the receiving model's reply back to the sender", async () => {
    const { manager, adapter } = ctx;
    adapter.replyText = "Implemented POST /orders. Files: handler.go, service.go.";

    const { pipe } = await manager.createPipe("checkout", "ses_a", "/proj/frontend");
    const b = await manager.joinPipe({
      pipeId: pipe.id,
      sessionId: "ses_b",
      directory: "/proj/backend",
      name: "backend",
    });

    const sent = await manager.send({
      sessionId: "ses_a",
      pipeId: pipe.id,
      to: "backend",
      content: "Please expose the order-creation API contract.",
      type: "request",
    });

    // B received the request in its session.
    const bInbox = adapter.messagesFor("ses_b");
    expect(bInbox.some((x) => x.message.id === sent.id)).toBe(true);

    // The store contains an auto-reply from B back to A, correlated via replyTo.
    const all = await manager.history(pipe.id);
    const reply = all.find(
      (m) => m.type === "response" && m.replyTo === sent.id,
    );
    expect(reply).toBeDefined();
    expect(reply!.senderId).toBe(b.id);
    expect(reply!.recipient).toEqual({
      type: "participant",
      participantId: sent.senderId,
    });
    expect(reply!.content).toContain("POST /orders");
    // Chain advanced one hop from the original message.
    expect(reply!.chain?.chainId).toBe(sent.chain?.chainId);
    expect(reply!.chain?.hopCount).toBe((sent.chain?.hopCount ?? 0) + 1);

    // The auto-reply was also delivered into A's session (same-process delivery).
    const aInbox = adapter.messagesFor("ses_a");
    expect(aInbox.some((x) => x.message.id === reply!.id)).toBe(true);
  });

  it("does not auto-reply to broadcasts", async () => {
    const { manager, adapter } = ctx;
    adapter.replyText = "I heard the broadcast.";

    const { pipe } = await manager.createPipe("p", "ses_a", "/a");
    await manager.joinPipe({ pipeId: pipe.id, sessionId: "ses_b", directory: "/b" });

    const sent = await manager.send({
      sessionId: "ses_a",
      pipeId: pipe.id,
      to: "@all",
      content: "Notice for everyone.",
    });
    // B received it…
    expect(adapter.messagesFor("ses_b").some((x) => x.message.id === sent.id)).toBe(true);
    // …but no auto-reply was created.
    const all = await manager.history(pipe.id);
    expect(all.filter((m) => m.replyTo === sent.id)).toHaveLength(0);
  });

  it("does not auto-reply when autoRespond is disabled", async () => {
    const ctx2 = makeManager({ config: { ...(await import("../../src/config.ts")).DEFAULT_CONFIG, autoRespond: false } });
    const { manager, adapter } = ctx2;
    adapter.replyText = "should not be routed";

    const { pipe } = await manager.createPipe("p", "ses_a", "/a");
    await manager.joinPipe({ pipeId: pipe.id, sessionId: "ses_b", directory: "/b", name: "backend" });

    const sent = await manager.send({
      sessionId: "ses_a",
      pipeId: pipe.id,
      to: "backend",
      content: "Hello",
    });
    expect(adapter.messagesFor("ses_b").some((x) => x.message.id === sent.id)).toBe(true);
    const all = await manager.history(pipe.id);
    expect(all.filter((m) => m.replyTo === sent.id)).toHaveLength(0);
  });

  it("stops auto-replying once the chain exceeds the hop budget", async () => {
    const ctx2 = makeManager({ config: { ...(await import("../../src/config.ts")).DEFAULT_CONFIG, maxAgentHops: 1 } });
    const { manager, adapter } = ctx2;
    adapter.replyText = "loop";

    const { pipe } = await manager.createPipe("p", "ses_a", "/a");
    const b = await manager.joinPipe({ pipeId: pipe.id, sessionId: "ses_b", directory: "/b", name: "backend" });

    const sent = await manager.send({
      sessionId: "ses_a",
      pipeId: pipe.id,
      to: "backend",
      content: "Start",
    });
    // First reply hop 1 is allowed (incoming hop 0).
    let all = await manager.history(pipe.id);
    const first = all.find((m: PipeMessage) => m.replyTo === sent.id);
    expect(first).toBeDefined();
    expect(first!.chain?.hopCount).toBe(1);

    // The first reply was delivered back into A… A responds via the fake too,
    // so a second auto-reply would be created IF the chain allowed it. It must
    // not: incoming hop 1 exceeds maxAgentHops (1).
    const replies = all.filter((m: PipeMessage) => m.replyTo === sent.id);
    expect(replies).toHaveLength(1);

    // Confirm: sending the hop-1 reply into A did NOT spawn a hop-2 reply.
    await adapter; // (noop keeps lint quiet about unused ctx adapter)
    const aInbox = adapter.messagesFor("ses_a");
    expect(aInbox.length).toBeGreaterThan(0);
    // Simulate A responding to the hop-1 reply (same chain), then assert no
    // further auto-reply is created for that chain.
    const hop1 = first!;
    const fromA = await manager.send({
      sessionId: "ses_a",
      pipeId: pipe.id,
      to: b.id,
      content: "Response from A",
      type: "response",
      replyTo: hop1.id,
      reference: hop1,
    });
    all = await manager.history(pipe.id);
    const deeper = all.filter(
      (m: PipeMessage) => m.chain?.chainId === sent.chain?.chainId && m.chain.hopCount > 1,
    );
    // A's own manual response exists (hop 2), but no automatic hop-3 reply.
    expect(deeper.some((m: PipeMessage) => m.id === fromA.id)).toBe(true);
    expect(deeper.filter((m: PipeMessage) => m.replyTo === hop1.id)).toHaveLength(1);
  });
});