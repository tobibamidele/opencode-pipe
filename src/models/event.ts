/**
 * Internal pipe events emitted by the core layer. The TUI and other adapters
 * subscribe to these. This internal bus is decoupled from OpenCode's own event
 * system (an adapter bridges the two).
 */

import type { Pipe } from "./pipe.js";
import type { Participant, ParticipantStatus } from "./participant.js";
import type { PipeMessage } from "./message.js";
import type { PipeTask } from "./task.js";

export type PipeEvent =
  | { type: "pipe.created"; pipe: Pipe }
  | { type: "pipe.updated"; pipe: Pipe }
  | { type: "pipe.closed"; pipeId: string }
  | { type: "participant.joined"; participant: Participant }
  | { type: "participant.left"; participant: Participant }
  | { type: "participant.status"; participantId: string; status: ParticipantStatus }
  | { type: "message.created"; message: PipeMessage }
  | { type: "message.delivered"; message: PipeMessage }
  | { type: "task.created"; task: PipeTask }
  | { type: "task.updated"; task: PipeTask };
