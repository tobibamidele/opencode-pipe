/**
 * Minimal, version-agnostic OpenCode client surface used across server adapters.
 * This avoids type collisions between nested `@opencode-ai/sdk` versions while
 * still giving us the methods we actually call.
 */

export interface PipesClient {
  session: {
    prompt(opts: {
      path: { id: string };
      body: {
        parts: Array<{ type: "text"; text: string }>;
      };
    }): Promise<{
      info?: { text?: string };
      parts?: Array<{ type?: string; text?: string }>;
    }>;
    status(
      opts: { path: { id: string } },
    ): Promise<{ data?: { type?: string } }>;
  };
  app: {
    log(opts: {
      body: { service: string; level: string; message: string };
    }): Promise<unknown>;
  };
}
