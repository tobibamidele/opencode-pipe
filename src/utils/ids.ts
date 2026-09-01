/**
 * Cryptographically random id generation for pipes, participants, messages,
 * and tasks. Named ids are human-readable and stable; they are NOT security
 * identifiers (the pipe name is separate from its id).
 */

import { randomBytes } from "node:crypto";

const PREFIX = ["pipe", "part", "msg", "task"] as const;
export type IdKind = (typeof PREFIX)[number];

/**
 * Generate a random id with a stable human-readable prefix.
 * Example: `msg_9f3ab12c4d5e6f78`.
 *
 * @param kind the entity kind this id belongs to
 * @returns a new id string
 */
export function newId(kind: IdKind): string {
  return `${kind}_${randomBytes(10).toString("hex")}`;
}

const PIPE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Validate a pipe name.
 *
 * Allowed: alphanumeric start, then alphanumeric, `-`, or `_`, up to 64 chars.
 * Rejects path traversal attempts (e.g. `../foo`), empty names, and names
 * with characters that would be unsafe as a directory name.
 *
 * @param name candidate pipe name
 * @returns `true` if the name is valid
 */
export function isValidPipeName(name: string): boolean {
  if (typeof name !== "string") return false;
  return PIPE_NAME_RE.test(name);
}
