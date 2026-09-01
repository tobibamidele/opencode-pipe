/**
 * Package server entry point. Re-exports the server plugin and its helpers.
 */

export {
  PipesServer,
  createPipesServer,
  type ServerPluginState,
} from "./server/plugin.js";
export { default } from "./server/plugin.js";

// Core exports for advanced embedding.
export { PipeManager } from "./core/pipe-manager.js";
export { FileStore } from "./storage/file-store.js";
export { MemoryStore } from "./storage/memory-store.js";
export { FileTransport } from "./core/file-transport.js";
export { StandardEventBus } from "./core/event-bus.js";
export { resolveConfig, DEFAULT_CONFIG, type Config } from "./config.js";
export * from "./utils/errors.js";
export * from "./protocol/parser.js";
export * from "./protocol/envelope.js";
