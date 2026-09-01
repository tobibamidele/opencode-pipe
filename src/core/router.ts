/**
 * Message router. Responsible for deterministic, explicit message construction:
 * addressing (`@name` / `@all`), chain/hop bookkeeping for loop prevention,
 * and request/reply correlation. It does NOT know anything about OpenCode.
 */

import type { Participant } from "../models/participant.js";
import type {
  PipeMessage,
  MessageType,
  Recipient,
  MessageChain,
} from "../models/message.js";
import { newId } from "../utils/ids.js";
import type { Config } from "../config.js";

export interface RouterAddress {
  recipient: Recipient;
}

/**
 * Resolve an addressing string like `@backend` or `@all` to a Recipient.
 * An address is only an address if it names an existing participant; arbitrary
 * `@foo` text that does not match any participant is not treated as an address.
 *
 * @param address       the raw address token (with or without leading `@`)
 * @param participants  participants in the current pipe
 * @param defaultRecipient fallback when no address is given
 */
export function resolveRecipient(
  address: string | undefined,
  participants: Participant[],
  defaultRecipient?: Recipient,
): Recipient {
  if (address === undefined || address.trim() === "") {
    if (defaultRecipient) return defaultRecipient;
    return { type: "broadcast" };
  }
  const token = address.trim().replace(/^@/, "");
  if (token === "all") return { type: "broadcast" };
  const match = participants.find(
    (p) => p.name === token || p.id === token,
  );
  if (match) return { type: "participant", participantId: match.id };
  // Unknown address -> fall back to broadcast (parsers should warn separately).
  return { type: "broadcast" };
}

/**
 * Build a new pipe message. Assigns an id, computes the chain for loop
 * prevention, and attaches request correlation.
 */
export function buildMessage(input: {
  pipeId: string;
  sender: Participant;
  senderType: PipeMessage["senderType"];
  content: string;
  type: MessageType;
  recipient: Recipient;
  replyTo?: string;
  taskId?: string;
  parent?: PipeMessage;
  config: Config;
}): PipeMessage {
  const { pipeId, sender, senderType, content, type, recipient, replyTo, taskId, parent, config } = input;

  let chain: MessageChain;
  if (parent?.chain) {
    chain = {
      chainId: parent.chain.chainId,
      hopCount: parent.chain.hopCount + 1,
    };
  } else {
    chain = { chainId: newId("msg"), hopCount: 0 };
  }

  return {
    schemaVersion: 1,
    id: newId("msg"),
    pipeId,
    sequence: 0, // assigned by the store/manager
    senderId: sender.id,
    senderName: sender.name,
    senderType,
    recipient,
    type,
    content,
    createdAt: Date.now(),
    replyTo,
    taskId,
    chain,
    metadata: {
      maxHops: config.maxAgentHops,
    },
  };
}

/** True when a message chain has exceeded the maximum allowed agent hops. */
export function exceedsHopLimit(message: PipeMessage, config: Config): boolean {
  return (message.chain?.hopCount ?? 0) > config.maxAgentHops;
}
