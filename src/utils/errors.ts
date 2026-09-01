/**
 * Typed error codes for OpenCode Pipes. Errors are explicit and machine
 * readable so the TUI and agent tools can surface useful messages rather than
 * swallowing opaque failures.
 */

export type PipeErrorCode =
  | "PIPE_NOT_FOUND"
  | "PIPE_ALREADY_EXISTS"
  | "NOT_A_PARTICIPANT"
  | "PARTICIPANT_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "INVALID_PIPE_NAME"
  | "INVALID_PARTICIPANT_NAME"
  | "MESSAGE_TOO_LARGE"
  | "TASK_NOT_FOUND"
  | "INVALID_TASK_STATE"
  | "DELIVERY_FAILED"
  | "STORAGE_ERROR"
  | "TRANSPORT_ERROR"
  | "PIPE_CLOSED"
  | "HOP_LIMIT_EXCEEDED"
  | "NO_ACTIVE_PIPE"
  | "INTERNAL";

export class PipeError extends Error {
  readonly code: PipeErrorCode;
  declare readonly cause?: unknown;

  constructor(code: PipeErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "PipeError";
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Convenience factory: throw a typed error. */
export function pipeError(
  code: PipeErrorCode,
  message: string,
  cause?: unknown,
): PipeError {
  return new PipeError(code, message, cause);
}
