/**
 * Real OpenCode session adapter. Uses the plugin's OpenCode client to deliver
 * pipe messages into sessions and to read session status.
 */

import type { PipeMessage } from "../models/message.js";
import type { Participant, ParticipantStatus } from "../models/participant.js";
import type { OpenCodeSessionAdapter } from "../core/session-adapter.js";
import type { Pipe } from "../models/pipe.js";
import { formatEnvelope, agentInstructions } from "../protocol/envelope.js";
import type { PipesClient } from "./client-types.js";

export interface SessionAdapterDeps {
  client: PipesClient;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** Cache of pipe info for envelope rendering without extra lookups. */
  pipeProvider: (pipeId: string) => Promise<Pipe | undefined>;
}

/**
 * Extract the assistant reply text from a `session.prompt` result. The response
 * shape is `{ info: AssistantMessage, parts: Part[] }`; we defensively handle
 * both the whole-message `info.text` and a text-parts list.
 */
export function extractReplyText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const anyResult = result as {
    info?: { text?: string };
    parts?: Array<{ type?: string; text?: string }>;
  };
  const infoText = anyResult.info?.text?.trim();
  if (infoText) return infoText;
  const parts = anyResult.parts;
  if (Array.isArray(parts)) {
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

export class OpenCodeSessionAdapterImpl implements OpenCodeSessionAdapter {
  constructor(private readonly deps: SessionAdapterDeps) {}

  private log(level: "debug" | "info" | "warn" | "error", msg: string): void {
    this.deps.log?.(level, msg);
  }

  async sendMessage(
    sessionId: string,
    message: PipeMessage,
    from: Participant,
  ): Promise<string | undefined> {
    const pipe = await this.deps.pipeProvider(message.pipeId);
    if (!pipe) return undefined;

    const envelope = formatEnvelope({ pipe, message, from });

    try {
      const res = await this.deps.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: envelope }],
        },
      });
      const reply = extractReplyText(res);
      this.log(
        "info",
        `delivered ${message.type} ${message.id} to session ${sessionId} (${from.name} -> ${pipe.name})` +
          (reply ? `; captured ${reply.length} char reply` : ""),
      );
      return reply;
    } catch (e) {
      this.log("warn", `prompt delivery failed to ${sessionId}: ${(e as Error).message}`);
      throw e;
    }
  }

  async sendNotification(sessionId: string, text: string): Promise<void> {
    try {
      await this.deps.client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text }] },
      });
    } catch {
      // notifications are best-effort
    }
  }

  async getStatus(sessionId: string): Promise<ParticipantStatus | undefined> {
    try {
      const res = await this.deps.client.session.status({
        path: { id: sessionId },
      });
      const data = res.data as { type?: string } | undefined;
      if (!data) return "unknown";
      switch (data.type) {
        case "idle":
          return "idle";
        case "busy":
        case "retry":
          return "busy";
        default:
          return "unknown";
      }
    } catch {
      return "disconnected";
    }
  }

  /**
   * Inject the collaboration protocol into a session once, so the agent knows
   * it is part of a pipe and how to behave. Delivered as a normal (non-system)
   * message so it is not mistaken for a system instruction.
   */
  async injectProtocol(input: {
    sessionId: string;
    pipe: Pipe;
    participant: Participant;
    participants: Participant[];
  }): Promise<void> {
    const text = agentInstructions(input);
    try {
      await this.deps.client.session.prompt({
        path: { id: input.sessionId },
        body: { parts: [{ type: "text", text }] },
      });
    } catch (e) {
      this.log("warn", `protocol injection failed: ${(e as Error).message}`);
    }
  }
}
