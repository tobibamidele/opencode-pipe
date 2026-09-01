/**
 * Filesystem path helpers for pipe data. A pipe id is hex-encoded before being
 * used as a directory name so no human input (name/id) can ever traverse the
 * filesystem. Shared by FileStore and FileTransport so they agree on layout.
 */

import path from "node:path";

/** Hex-encode an id into a safe, reversible directory name. */
export function dirFor(pipeId: string): string {
  return Buffer.from(pipeId, "utf8").toString("hex");
}

/** Root that holds all pipe data (nesting "pipes/" under the data dir). */
export function pipesRoot(dataDir: string): string {
  return path.join(dataDir, "pipes");
}

/** Per-pipe directory under a pipes root. */
export function pipeDir(pipesRootPath: string, pipeId: string): string {
  return path.join(pipesRootPath, dirFor(pipeId));
}
