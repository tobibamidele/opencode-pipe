/**
 * Determine the shared pipes data directory. This MUST be a user-level location
 * (not project-local) so that independent OpenCode sessions in different
 * directories can discover and join the same pipes.
 */

import os from "node:os";
import path from "node:path";

/**
 * Resolve the base pipes data directory.
 *
 * Order of precedence:
 *  1. OPENCODE_PIPES_DATA_DIR env override
 *  2. platform user data dir
 */
export function defaultDataDir(): string {
  const override = process.env.OPENCODE_PIPES_DATA_DIR;
  if (override && override.trim() !== "") return override;

  const home = os.homedir();
  const platform = process.platform;
  if (platform === "darwin") {
    // Also probe common OpenCode location; fall back to ~/Library/Application Support.
    return path.join(home, "Library", "Application Support", "opencode", "pipes");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "opencode", "pipes");
  }
  // linux / others
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "opencode", "pipes");
}
