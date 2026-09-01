/**
 * Storage abstraction for pipes. The core layer depends only on this interface;
 * the transport/OpenCode layers never care whether the backing store is memory
 * or files. This is what lets pipes survive restarts.
 */

import type { Pipe } from "../models/pipe.js";
import type { Participant } from "../models/participant.js";
import type { PipeMessage } from "../models/message.js";
import type { PipeTask } from "../models/task.js";

export interface PipeStore {
  // Pipes
  createPipe(pipe: Pipe): Promise<Pipe>;
  getPipe(id: string): Promise<Pipe | undefined>;
  getPipeByName(name: string): Promise<Pipe | undefined>;
  listPipes(): Promise<Pipe[]>;
  updatePipe(pipe: Pipe): Promise<Pipe>;
  deletePipe(id: string): Promise<void>;

  // Participants
  createParticipant(p: Participant): Promise<Participant>;
  getParticipant(id: string): Promise<Participant | undefined>;
  listParticipants(pipeId: string): Promise<Participant[]>;
  updateParticipant(p: Participant): Promise<Participant>;
  deleteParticipant(id: string): Promise<void>;

  // Messages
  createMessage(msg: PipeMessage): Promise<PipeMessage>;
  getMessage(id: string): Promise<PipeMessage | undefined>;
  listMessages(pipeId: string, limit?: number, offset?: number): Promise<PipeMessage[]>;
  deleteMessage(id: string): Promise<void>;
  /** Absolute next sequence number for a pipe (count of messages). */
  nextSequence(pipeId: string): Promise<number>;

  // Tasks
  createTask(task: PipeTask): Promise<PipeTask>;
  getTask(id: string): Promise<PipeTask | undefined>;
  listTasks(pipeId: string): Promise<PipeTask[]>;
  updateTask(task: PipeTask): Promise<PipeTask>;
  deleteTask(id: string): Promise<void>;

  /** Commit any pending writes / close handles. */
  close(): Promise<void>;
}
