/**
 * Agent-callable pipe tools. These give agents deterministic access to the pipe
 * protocol instead of requiring them to type slash commands. Tool definitions
 * must be extremely clear to avoid misuse (e.g. requesting work outside a
 * recipient's workspace).
 */

import { tool } from "@opencode-ai/plugin";
import type { PipeManager } from "../core/pipe-manager.js";
import type { Participant } from "../models/participant.js";

export interface ToolsDeps {
  manager: PipeManager;
  /** Current process session id provider. */
  currentSessionId: () => Promise<string | undefined>;
  /** Resolve the participant for the calling session in the active pipe. */
  resolveSession: (sessionId: string, directory: string) => Promise<Participant | undefined>;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

export function buildTools(deps: ToolsDeps) {
  return {
    pipe_create: tool({
      description: `Create a new pipe and join it as a participant from this session.

Use this when the user asks to set up a collaboration channel, e.g. they type
"/pipe create <name>". Creates the pipe and registers this session as a
participant inside it. Fails if the name is invalid or a pipe with that name
already exists.`,
      args: {
        name: tool.schema
          .string()
          .describe("Pipe name; letters, digits, '-' and '_' only."),
        role: tool.schema
          .string()
          .optional()
          .describe("Optional participant role label (e.g. 'frontend')."),
      },
      async execute(args, ctx) {
        try {
          const { pipe, participant } = await deps.manager.createPipe(
            args.name,
            ctx.sessionID,
            ctx.directory,
          );
          return `Pipe "${pipe.name}" created. You joined as "${participant.name}".`;
        } catch (e) {
          return `Failed to create pipe: ${(e as Error).message}`;
        }
      },
    }),

    pipe_join: tool({
      description: `Join an existing pipe from this session (e.g. the user typed "/pipe join <name>"). Registers this session as a participant of that pipe so it can send and receive pipe messages.`,
      args: {
        pipeName: tool.schema.string().describe("Name of an existing pipe to join."),
        name: tool.schema
          .string()
          .optional()
          .describe("Optional participant name/label for this session."),
      },
      async execute(args, ctx) {
        try {
          const p = await deps.manager.joinPipe({
            pipeName: args.pipeName,
            sessionId: ctx.sessionID,
            directory: ctx.directory,
            name: args.name,
          });
          return `Joined pipe "${args.pipeName}" as "${p.name}".`;
        } catch (e) {
          return `Failed to join pipe: ${(e as Error).message}`;
        }
      },
    }),

    pipe_list: tool({
      description: `List existing pipes (name, status, participant and message counts). Use this when the user wants to join a pipe or you need to see what channels exist.`,
      args: {
        includeClosed: tool.schema
          .boolean()
          .optional()
          .describe("Include closed pipes (default false)."),
      },
      async execute(args) {
        const pipes = await deps.manager.listPipes();
        const open = pipes.filter((p) =>
          args.includeClosed ? true : p.status !== "closed",
        );
        if (open.length === 0) {
          return "No pipes exist yet. Create one with pipe_create.";
        }
        return open
          .map(
            (p) =>
              `- ${p.name} (${p.status}) ${p.participants.length} participant(s), ${p.messageCount} message(s)`,
          )
          .join("\n");
      },
    }),

    pipe_leave: tool({
      description: `Leave the pipe the current session participates in. Historical messages and membership records are preserved; the session simply stops receiving pipe messages.`,
      args: {},
      async execute(_args, ctx) {
        const participant = await deps.resolveSession(ctx.sessionID, ctx.directory);
        if (!participant) {
          return "You are not currently participating in an OpenCode Pipe.";
        }
        try {
          await deps.manager.leavePipe(participant.pipeId, ctx.sessionID);
          return `Left pipe "${participant.pipeId}".`;
        } catch (e) {
          return `Failed to leave pipe: ${(e as Error).message}`;
        }
      },
    }),

    pipe_send: tool({
      description: `Send a message to a participant in the current OpenCode Pipes channel.

Use this to pass structured information (API contracts, decisions, requests) to
another agent. Only send information relevant to the current task; never dump
your entire context. Do not ask a recipient to modify files outside its own
workspace. If you are not part of a pipe, this returns an error and does nothing.`,
      args: {
        to: tool.schema
          .string()
          .describe("Recipient participant name, '@all', or pipe member name."),
        content: tool.schema
          .string()
          .describe("The message body to send to the recipient(s)."),
        type: tool.schema
          .enum(["message", "request", "response", "decision", "question"])
          .optional()
          .describe("Message kind. Defaults to 'message'."),
        replyTo: tool.schema
          .string()
          .optional()
          .describe("Message ID this is a reply to (required for a reply)."),
      },
      async execute(args, ctx) {
        return sendWrapper(deps, {
          sessionId: ctx.sessionID,
          directory: ctx.directory,
          to: args.to,
          content: args.content,
          type: args.type,
          replyTo: args.replyTo,
        });
      },
    }),

    pipe_request: tool({
      description: `Send a REQUEST to another participant asking them to provide information or perform work in their OWN workspace.

Include a clear problem statement, the desired outcome, and any format you want
the response in. The recipient decides whether to act; you cannot force it.`,
      args: {
        to: tool.schema.string().describe("Recipient participant name."),
        content: tool.schema
          .string()
          .describe("What you need and why, with desired format/acceptance criteria."),
        taskId: tool.schema
          .string()
          .optional()
          .describe("Correlate this request to an existing task id."),
      },
      async execute(args, ctx) {
        return sendWrapper(deps, {
          sessionId: ctx.sessionID,
          directory: ctx.directory,
          to: args.to,
          content: args.content,
          type: "request",
          taskId: args.taskId,
        });
      },
    }),

    pipe_reply: tool({
      description: `Reply to a message you received from another participant (identified by its message id). Prefer this over pipe_send when answering a request.`,
      args: {
        replyTo: tool.schema.string().describe("The message id you are replying to."),
        content: tool.schema.string().describe("Your reply body."),
        type: tool.schema
          .enum(["response", "message", "decision", "blocked"])
          .optional()
          .describe("Defaults to 'response'."),
      },
      async execute(args, ctx) {
        const sessionId = ctx.sessionID;
        const participant = await deps.resolveSession(sessionId, ctx.directory);
        if (!participant) {
          return "You are not currently participating in an OpenCode Pipe.";
        }
        try {
          const msg = await deps.manager.sendReply({
            sessionId,
            replyTo: args.replyTo,
            content: args.content,
            type: args.type === "blocked" ? "blocked" : args.type ?? "response",
          });
          return `Replied to ${args.replyTo} (message ${msg.id}).`;
        } catch (e) {
          return `Failed to reply: ${(e as Error).message}`;
        }
      },
    }),

    pipe_task_create: tool({
      description: `Create a task in the current pipe, optionally assigned to another participant. Tasks are higher-level than messages and track state (pending -> assigned -> in_progress -> completed).`,
      args: {
        title: tool.schema.string().describe("Short task title."),
        description: tool.schema
          .string()
          .describe("Detailed requirements and acceptance criteria."),
        assignedTo: tool.schema
          .string()
          .optional()
          .describe("Participant name the task is assigned to."),
        priority: tool.schema
          .enum(["low", "normal", "high", "critical"])
          .optional()
          .describe("Task priority. Defaults to 'normal'."),
        dependsOn: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Task ids this task depends on."),
      },
      async execute(args, ctx) {
        return taskCreateWrapper(deps, ctx.sessionID, ctx.directory, args);
      },
    }),

    pipe_task_update: tool({
      description: `Update a task's status in the current pipe (e.g. in_progress, blocked, completed). Use this when you complete or encounter a blocker on assigned work.`,
      args: {
        taskId: tool.schema.string().describe("The task id to update."),
        status: tool.schema
          .enum(["assigned", "in_progress", "waiting", "blocked", "completed", "cancelled"])
          .describe("New task status."),
        blockedReason: tool.schema
          .string()
          .optional()
          .describe("Reason when transitioning to blocked."),
      },
      async execute(args, ctx) {
        const participant = await deps.resolveSession(ctx.sessionID, ctx.directory);
        if (!participant) {
          return "You are not currently participating in an OpenCode Pipe.";
        }
        try {
          const task = await deps.manager.transitionTask(
            args.taskId,
            args.status,
            { blockedReason: args.blockedReason },
          );
          return `Task #${task.number} (${task.id}) is now ${task.status}.`;
        } catch (e) {
          return `Failed to update task: ${(e as Error).message}`;
        }
      },
    }),

    pipe_status: tool({
      description: `Get the status of the current pipe: participants, tasks, and message count.`,
      args: {},
      async execute(_args, ctx) {
        return statusWrapper(deps, ctx.sessionID);
      },
    }),

    pipe_members: tool({
      description: `List the participants in the current pipe (names, status, directories).`,
      args: {},
      async execute(_args, ctx) {
        const participant = await deps.resolveSession(ctx.sessionID, ctx.directory);
        if (!participant) {
          return "You are not currently participating in an OpenCode Pipe.";
        }
        const members = await deps.manager.participants.list(participant.pipeId);
        return members
          .map(
            (m) =>
              `- ${m.name} (${m.status}) session=${m.sessionId} dir=${m.directory}${m.branch ? ` branch=${m.branch}` : ""}`,
          )
          .join("\n");
      },
    }),

    pipe_history: tool({
      description: `View recent messages in the current pipe. Use sparingly; it intentionally expands context.`,
      args: {
        limit: tool.schema.number().optional().describe("Number of recent messages (default 10)."),
      },
      async execute(args, ctx) {
        const participant = await deps.resolveSession(ctx.sessionID, ctx.directory);
        if (!participant) {
          return "You are not currently participating in an OpenCode Pipe.";
        }
        const msgs = await deps.manager.history(
          participant.pipeId,
          Math.min(args.limit ?? 10, 50),
        );
        if (msgs.length === 0) return "No messages yet.";
        return msgs
          .map(
            (m) =>
              `[${m.sequence}] ${m.senderName ?? m.senderId} -> ${m.recipient.type} (${m.type}): ${m.content.slice(0, 200)}`,
          )
          .join("\n");
      },
    }),
  };
}

async function sendWrapper(
  deps: ToolsDeps,
  input: {
    sessionId: string;
    directory: string;
    to: string;
    content: string;
    type?: string;
    replyTo?: string;
    taskId?: string;
  },
): Promise<string> {
  const participant = await deps.resolveSession(input.sessionId, input.directory);
  if (!participant) {
    return "You are not currently participating in an OpenCode Pipe. Join or create a pipe first.";
  }
  try {
    const msg = await deps.manager.send({
      sessionId: input.sessionId,
      pipeId: participant.pipeId,
      to: input.to,
      content: input.content,
      type: (input.type as Parameters<PipeManager["send"]>[0]["type"]) ?? "message",
      replyTo: input.replyTo,
      taskId: input.taskId,
    });
    return `${msg.id}: ${describeDelivery(deps.manager.deliveryOutcomes(msg.id))}`;
  } catch (e) {
    return `Failed to send: ${(e as Error).message}`;
  }
}

/** Turn per-recipient delivery outcomes into a status the calling agent can
 *  actually trust, instead of a blanket "message sent" that only reflects
 *  local persistence. */
function describeDelivery(outcomes: ReturnType<PipeManager["deliveryOutcomes"]>): string {
  if (!outcomes || outcomes.length === 0) {
    return "persisted (broadcast/no other participants to notify locally).";
  }
  return outcomes
    .map((o) => {
      switch (o.status) {
        case "delivered":
          return `${o.name}: delivered.`;
        case "queued":
          return `${o.name}: NOT delivered yet (session busy or errored — ${o.error ?? "unknown error"}; will retry on idle).`;
        case "failed":
          return `${o.name}: delivery FAILED — ${o.error ?? "unknown error"}.`;
        case "remote":
          return `${o.name}: sent to shared log for their process to pick up (outcome not visible from here).`;
      }
    })
    .join(" ");
}

async function taskCreateWrapper(
  deps: ToolsDeps,
  sessionId: string,
  directory: string,
  args: {
    title: string;
    description: string;
    assignedTo?: string;
    priority?: "low" | "normal" | "high" | "critical";
    dependsOn?: string[];
  },
): Promise<string> {
  const participant = await deps.resolveSession(sessionId, directory);
  if (!participant) {
    return "You are not currently participating in an OpenCode Pipe.";
  }
  try {
    const task = await deps.manager.createTask({
      pipeId: participant.pipeId,
      createdBy: participant.id,
      title: args.title,
      description: args.description,
      assignedTo: args.assignedTo,
      priority: args.priority,
      dependsOn: args.dependsOn,
    });
    return `Created task #${task.number} (${task.id}).`;
  } catch (e) {
    return `Failed to create task: ${(e as Error).message}`;
  }
}

async function statusWrapper(deps: ToolsDeps, sessionId: string): Promise<string> {
  const participant = await deps.resolveSession(sessionId, "");
  if (!participant) {
    return "You are not currently participating in an OpenCode Pipe.";
  }
  const st = await deps.manager.pipeStatus(participant.pipeId);
  const lines: string[] = [
    `Pipe: ${st.pipe.name} (${st.pipe.status})`,
    `Messages: ${st.messageCount}`,
    "Participants:",
    ...st.participants.map((p) => `  - ${p.name} (${p.status})`),
    "Tasks:",
    ...(st.tasks.length
      ? st.tasks.map((t) => `  #${t.number} ${t.title} [${t.status}]`)
      : ["  (none)"]),
  ];
  return lines.join("\n");
}
