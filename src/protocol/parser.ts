/**
 * Protocol parser for message content. Recognizes lightweight structured
 * markers that humans and agents can use without a dedicated tool:
 *
 *  - leading `@recipient` / `@all` addressing
 *  - REQUEST / TASK / RESPONSE / COMPLETED / BLOCKED / DECISION head markers
 *
 * This is a convenience facade. Agents are encouraged to use the structured
 * pipe_* tools instead, but the parser keeps `@backend ...` usable.
 */

import type { MessageType } from "../models/message.js";

export interface ParsedMessage {
  recipient: string | undefined;
  type: MessageType;
  content: string;
}

export function parseChannel(contentRaw: string): ParsedMessage {
  let content = contentRaw.trim();
  let recipient: string | undefined;

  // Extract leading @recipient (or @all).
  const m = /^@([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(content);
  if (m) {
    recipient = m[1] ?? undefined;
    content = (m[2] ?? "").trim();
  }

  const type = detectType(content);
  // Strip the leading marker word (e.g. "REQUEST") so the content is clean.
  if (type !== "message") {
    content = content.replace(/^[A-Z]+\s*/i, "").trim();
  }

  return { recipient, type, content };
}

function detectType(content: string): MessageType {
  const line = content.split("\n")[0]?.trim().toUpperCase() ?? "";
  if (line === "REQUEST") return "request";
  if (line === "RESPONSE") return "response";
  if (line === "TASK") return "task";
  if (line === "COMPLETED") return "completed";
  if (line === "BLOCKED") return "blocked";
  if (line === "DECISION") return "decision";
  if (line === "QUESTION") return "question";
  if (line === "STATUS") return "status";
  return "message";
}
