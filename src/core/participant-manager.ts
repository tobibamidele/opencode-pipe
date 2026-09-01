/**
 * Participant manager. Handles join/leave, participant naming, and status
 * transitions. Preserves historical participant records when a session leaves
 * or is replaced.
 */

import type { PipeStore } from "../storage/store.js";
import type { Participant, ParticipantStatus } from "../models/participant.js";
import type { PipeEventBus } from "./event-bus.js";
import { newId } from "../utils/ids.js";
import { pipeError } from "../utils/errors.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

export function isValidParticipantName(name: string): boolean {
  return NAME_RE.test(name);
}

export class ParticipantManager {
  constructor(
    private readonly store: PipeStore,
    private readonly bus: PipeEventBus,
  ) {}

  async join(input: {
    pipeId: string;
    sessionId: string;
    directory: string;
    worktree?: string;
    branch?: string;
    name?: string;
    role?: string;
  }): Promise<Participant> {
    const pipe = await this.store.getPipe(input.pipeId);
    if (!pipe) throw pipeError("PIPE_NOT_FOUND", `Pipe ${input.pipeId} not found`);
    if (pipe.status === "closed") {
      throw pipeError("PIPE_CLOSED", `Pipe ${pipe.name} is closed`);
    }

    // A session already in this pipe -> update existing participant.
    const existing = (
      await this.store.listParticipants(input.pipeId)
    ).find((p) => p.sessionId === input.sessionId);
    if (existing) {
      existing.directory = input.directory;
      existing.worktree = input.worktree ?? existing.worktree;
      existing.branch = input.branch ?? existing.branch;
      if (input.role) existing.role = input.role;
      if (input.name) existing.name = input.name;
      existing.lastSeenAt = Date.now();
      existing.status = "online";
      const updated = await this.store.updateParticipant(existing);
      this.bus.emit({ type: "participant.status", participantId: updated.id, status: updated.status });
      return updated;
    }

    // Resolve a name: explicit, or a sensible generated default.
    const name = input.name ?? (await this.suggestName(input.pipeId, input.directory));
    if (!isValidParticipantName(name)) {
      throw pipeError(
        "INVALID_PARTICIPANT_NAME",
        `Participant name "${name}" is invalid`,
      );
    }

    const now = Date.now();
    const participant: Participant = {
      id: newId("part"),
      pipeId: input.pipeId,
      sessionId: input.sessionId,
      name,
      role: input.role ?? name,
      directory: input.directory,
      worktree: input.worktree,
      branch: input.branch,
      joinedAt: now,
      lastSeenAt: now,
      status: "online",
    };

    await this.store.createParticipant(participant);

    pipe.participants.push(participant.id);
    pipe.updatedAt = now;
    await this.store.updatePipe(pipe);

    this.bus.emit({ type: "participant.joined", participant });
    return participant;
  }

  /** Remove a live membership while preserving the historical record. */
  async leave(pipeId: string, sessionId: string): Promise<Participant | undefined> {
    const pipe = await this.store.getPipe(pipeId);
    if (!pipe) throw pipeError("PIPE_NOT_FOUND", `Pipe ${pipeId} not found`);

    const participant = (
      await this.store.listParticipants(pipeId)
    ).find((p) => p.sessionId === sessionId);
    if (!participant) return undefined;

    participant.status = "disconnected";
    participant.lastSeenAt = Date.now();
    await this.store.updateParticipant(participant);

    pipe.participants = pipe.participants.filter((id) => id !== participant.id);
    pipe.updatedAt = Date.now();
    await this.store.updatePipe(pipe);

    this.bus.emit({ type: "participant.left", participant });
    return participant;
  }

  async rename(participantId: string, name: string): Promise<Participant> {
    if (!isValidParticipantName(name)) {
      throw pipeError("INVALID_PARTICIPANT_NAME", `Participant name "${name}" is invalid`);
    }
    const p = await this.store.getParticipant(participantId);
    if (!p) throw pipeError("PARTICIPANT_NOT_FOUND", `Participant ${participantId} not found`);
    p.name = name;
    const updated = await this.store.updateParticipant(p);
    return updated;
  }

  async setStatus(participantId: string, status: ParticipantStatus): Promise<Participant | undefined> {
    const p = await this.store.getParticipant(participantId);
    if (!p) return undefined;
    if (p.status === status) return p;
    p.status = status;
    p.lastSeenAt = Date.now();
    const updated = await this.store.updateParticipant(p);
    this.bus.emit({ type: "participant.status", participantId: updated.id, status: updated.status });
    return updated;
  }

  async get(participantId: string): Promise<Participant | undefined> {
    return this.store.getParticipant(participantId);
  }

  async list(pipeId: string): Promise<Participant[]> {
    return this.store.listParticipants(pipeId);
  }

  /** Find a participant by session id in a pipe. */
  async bySession(pipeId: string, sessionId: string): Promise<Participant | undefined> {
    const list = await this.store.listParticipants(pipeId);
    return list.find((p) => p.sessionId === sessionId);
  }

  private async suggestName(pipeId: string, directory: string): Promise<string> {
    const existing = await this.store.listParticipants(pipeId);
    const names = new Set(existing.map((p) => p.name));
    const base =
      directory.split("/").filter(Boolean).pop()?.replace(/[^a-zA-Z0-9_-]/g, "") ||
      "session";
    let candidate = base || "session";
    let i = 1;
    while (names.has(candidate)) {
      candidate = `${base}-${i++}`;
    }
    return candidate;
  }
}
