/**
 * Plugin configuration with sensible defaults. The server plugin merges user
 * config options into these defaults.
 */

export interface Config {
  /** Max message content size in characters. */
  maxMessageChars: number;
  /** Max chars of a delivered message injected into an agent session. */
  maxAgentMessageChars: number;
  /** Max number of agent-to-agent hops before a chain is stopped. */
  maxAgentHops: number;
  /** Request timeout in ms; after this a request is flagged unanswered. */
  requestTimeoutMs: number;
  /** History page size for /pipe history. */
  historyPageSize: number;
  /** Whether to show TUI notifications. */
  notificationsEnabled: boolean;
  /** Message retention (max messages kept per pipe); 0 = unlimited. */
  messageRetention: number;
  /** Extra context prepended to every delivered agent message. */
  agentSystemContext: string[];
  debug: boolean;
}

export const DEFAULT_CONFIG: Config = {
  maxMessageChars: 64 * 1024,
  maxAgentMessageChars: 20_000,
  maxAgentHops: 8,
  requestTimeoutMs: 10 * 60 * 1000, // 10 minutes
  historyPageSize: 20,
  notificationsEnabled: true,
  messageRetention: 0, // unlimited by default
  agentSystemContext: [],
  debug: false,
};

/** Merge partial user options over defaults. */
export function resolveConfig(options?: Record<string, unknown>): Config {
  const o = options ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...(pickNumber(o, "maxMessageChars", DEFAULT_CONFIG.maxMessageChars)
      ? { maxMessageChars: o.maxMessageChars as number }
      : {}),
    ...(pickNumber(o, "maxAgentMessageChars", DEFAULT_CONFIG.maxAgentMessageChars)
      ? { maxAgentMessageChars: o.maxAgentMessageChars as number }
      : {}),
    ...(pickNumber(o, "maxAgentHops", DEFAULT_CONFIG.maxAgentHops)
      ? { maxAgentHops: o.maxAgentHops as number }
      : {}),
    ...(pickNumber(o, "requestTimeoutMs", DEFAULT_CONFIG.requestTimeoutMs)
      ? { requestTimeoutMs: o.requestTimeoutMs as number }
      : {}),
    ...(pickNumber(o, "historyPageSize", DEFAULT_CONFIG.historyPageSize)
      ? { historyPageSize: o.historyPageSize as number }
      : {}),
    ...(typeof o.notificationsEnabled === "boolean"
      ? { notificationsEnabled: o.notificationsEnabled }
      : {}),
    ...(pickNumber(o, "messageRetention", DEFAULT_CONFIG.messageRetention)
      ? { messageRetention: o.messageRetention as number }
      : {}),
    ...(typeof o.debug === "boolean" ? { debug: o.debug } : {}),
    ...(Array.isArray(o.agentSystemContext)
      ? { agentSystemContext: o.agentSystemContext as string[] }
      : {}),
  };
}

function pickNumber(o: Record<string, unknown>, key: string, _fallback: number): boolean {
  return typeof o[key] === "number";
}
