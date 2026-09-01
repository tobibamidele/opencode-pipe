import { describe, it, expect } from "bun:test";
import { parseChannel } from "../../src/protocol/parser.ts";
import { resolveRecipient } from "../../src/core/router.ts";
import type { Participant } from "../../src/models/participant.ts";

const P = (name: string, id = `part_${name}`): Participant => ({
  id, pipeId: "pipe", sessionId: `ses_${name}`, name,
  directory: `/proj/${name}`, joinedAt: 0, lastSeenAt: 0, status: "online",
});

describe("protocol parser", () => {
  it("parses @recipient addressing", () => {
    expect(parseChannel("@backend hello there")).toEqual({
      recipient: "backend",
      type: "message",
      content: "hello there",
    });
  });

  it("parses @all broadcast", () => {
    expect(parseChannel("@all everyone needs to know")).toEqual({
      recipient: "all",
      type: "message",
      content: "everyone needs to know",
    });
  });

  it("detects REQUEST / TASK / COMPLETED / BLOCKED markers", () => {
    expect(parseChannel("REQUEST\nGive me the API").type).toBe("request");
    expect(parseChannel("TASK\nImplement").type).toBe("task");
    expect(parseChannel("COMPLETED\nDone").type).toBe("completed");
    expect(parseChannel("BLOCKED\nIssue").type).toBe("blocked");
  });

  it("leaves plain messages as message type", () => {
    expect(parseChannel("just a note").type).toBe("message");
  });

  it("strips the leading marker word for clean content", () => {
    const parsed = parseChannel("REQUEST\nGive me the API");
    expect(parsed.content).toBe("Give me the API");
  });
});

describe("router recipient resolution", () => {
  const participants = [P("frontend"), P("backend")];

  it("resolves an existing participant name", () => {
    const r = resolveRecipient("@backend", participants);
    expect(r.type).toBe("participant");
    if (r.type === "participant") expect(r.participantId).toBe("part_backend");
  });

  it("resolves @all to broadcast", () => {
    expect(resolveRecipient("@all", participants)).toEqual({ type: "broadcast" });
  });

  it("does not treat unknown @name as an address (falls back to broadcast)", () => {
    const r = resolveRecipient("@doesnotexist", participants);
    expect(r.type).toBe("broadcast");
  });

  it("defaults to broadcast without an address", () => {
    expect(resolveRecipient(undefined, participants)).toEqual({ type: "broadcast" });
  });
});
