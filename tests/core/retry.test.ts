/**
 * Delivery retry behavior: when a session prompt fails (e.g. the session was
 * busy generating), the delivery is queued and retried on the next "idle".
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { makeManager } from "../helpers.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";

async function setup(sessionA = "ses_a", sessionB = "ses_b") {
  const ctx = makeManager();
  const { manager, adapter } = ctx;
  const { pipe } = await manager.createPipe("p", sessionA, "/a");
  const b = await manager.joinPipe({ pipeId: pipe.id, sessionId: sessionB, directory: "/b", name: "backend" });
  return { manager, adapter, pipe, b };
}

describe("PipeManager: delivery retry on idle", () => {
  let ctx: ReturnType<typeof makeManager>;
  beforeEach(() => {
    ctx = makeManager();
  });

  it("queues a failed delivery and retries it on idle", async () => {
    const { manager, adapter, pipe, b } = await setup();
    adapter.failuresRemaining = 1;

    const sent = await manager.send({
      sessionId: "ses_a",
      pipeId: pipe.id,
      to: "backend",
      content: "Hello backend",
    });

    // First attempt failed because the session was busy -> not delivered yet.
    expect(adapter.messagesFor("ses_b").some((x) => x.message.id === sent.id)).toBe(false);

    // The session becomes idle; the plugin retries pending deliveries.
    await manager.retryPending(b.sessionId);
    expect(adapter.messagesFor("ses_b").some((x) => x.message.id === sent.id)).toBe(true);
    // Exactly once — the failed attempt must not be re-delivered.
    expect(adapter.messagesFor("ses_b").filter((x) => x.message.id === sent.id)).toHaveLength(1);
  });

  it("auto-replies after a successful retry (reply routed back)", async () => {
    const { manager, adapter, pipe } = await setup();
    adapter.replyText = "API contract: POST /orders";
    adapter.failuresRemaining = 1;

    const sent = await manager.send({
      sessionId: "ses_a",
      pipeId: pipe.id,
      to: "backend",
      content: "Provide the API contract",
      type: "request",
    });
    expect(adapter.messagesFor("ses_b").some((x) => x.message.id === sent.id)).toBe(false);

    await manager.retryPending("ses_b");
    const all = await manager.history(pipe.id);
    const reply = all.find((m) => m.type === "response" && m.replyTo === sent.id);
    expect(reply).toBeDefined();
    expect(reply!.content).toContain("POST /orders");
  });

  it("gives up after maxDeliveryAttempts", async () => {
    const ctx2 = makeManager({
      config: { ...DEFAULT_CONFIG, maxDeliveryAttempts: 2 },
    });
    const { manager, adapter } = ctx2;
    const { pipe } = await manager.createPipe("p", "ses_a", "/a");
    const b = await manager.joinPipe({
      pipeId: pipe.id,
      sessionId: "ses_b",
      directory: "/b",
      name: "backend",
    });
    adapter.failuresRemaining = 99;

    const sent = await manager.send({
      sessionId: "ses_a",
      pipeId: pipe.id,
      to: "backend",
      content: "Never delivered",
    });

    // Retry 1 (attempt 2) -> still failing -> requeued (attempt 2 < max 2? no).
    await manager.retryPending(b.sessionId);
    // retryPending delivered with attempts=1; failure -> attempts(1) < max(2)
    // -> requeued with attempts=2.
    await manager.retryPending(b.sessionId);
    // Now attempts(2) !< max(2) -> dropped.
    await manager.retryPending(b.sessionId);

    expect(adapter.messagesFor("ses_b").some((x) => x.message.id === sent.id)).toBe(false);
  });
});