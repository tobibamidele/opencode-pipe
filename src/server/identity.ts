/**
 * Session identity tracking for a single OpenCode process. The plugin observes
 * session lifecycle events to know which session is "current" and what directory
 * it lives in, so pipe operations that don't carry an explicit session id still
 * resolve correctly.
 */

export interface SessionIdentity {
  observe(input: { sessionId: string; directory: string }): void;
  currentSessionId(): Promise<string | undefined>;
  currentDirectory(): string;
  setLog(log: (level: "debug" | "info" | "warn" | "error", m: string) => void): void;
}

export class DefaultSessionIdentity implements SessionIdentity {
  private currentId?: string;
  private readonly initialDirectory: string;
  private log: (level: "debug" | "info" | "warn" | "error", m: string) => void = () => {};
  private observed = new Map<string, string>(); // sessionId -> directory

  constructor(directory: string, private readonly worktree: string) {
    this.initialDirectory = directory;
  }

  setLog(log: (level: "debug" | "info" | "warn" | "error", m: string) => void): void {
    this.log = log;
  }

  observe({ sessionId }: { sessionId: string; directory: string }): void {
    this.currentId = sessionId;
    this.observed.set(sessionId, this.initialDirectory);
    this.log("debug", `observed session ${sessionId}`);
  }

  async currentSessionId(): Promise<string | undefined> {
    return this.currentId;
  }

  currentDirectory(): string {
    if (this.currentId) {
      const d = this.observed.get(this.currentId);
      if (d) return d;
    }
    return this.initialDirectory;
  }
}
