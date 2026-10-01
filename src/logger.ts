import type { Logger } from "./types.ts";

/**
 * Logging goes through the OpenCode client so plugin output lands in the same
 * stream as the rest of the app. The client is typed loosely and narrowed at
 * runtime: the SDK's generated signature is stricter than what we need to call,
 * and a version bump there must never break the plugin build. Any transport
 * failure degrades to stderr, and logging itself never throws into a hook.
 */

type LogFn = (options: { body?: unknown }) => unknown;

export function createLogger(client: unknown): Logger {
  const log = resolveLog(client);

  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, extra?: Record<string, unknown>): void => {
      try {
        if (log) {
          log({ body: { service: "opencode-memory", level, message, extra } });
          return;
        }
        if (level === "error" || level === "warn") fallback(level)(message, extra);
      } catch {
        fallback(level)(message, extra);
      }
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}

function resolveLog(client: unknown): LogFn | undefined {
  if (typeof client !== "object" || client === null) return undefined;
  const app = (client as { app?: unknown }).app;
  if (typeof app !== "object" || app === null) return undefined;
  const candidate = (app as { log?: unknown }).log;
  return typeof candidate === "function" ? (candidate as LogFn) : undefined;
}

const fallback = (level: "debug" | "info" | "warn" | "error") => (message: string, extra?: Record<string, unknown>): void => {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  const line = `[opencode-memory] ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
};

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
