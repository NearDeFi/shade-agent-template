/**
 * Structured logger factory.
 *
 * `createLogger(prefix)` returns a `Logger` (interface defined in `src/flows/types.ts`)
 * that prepends `[prefix]` to every message.
 *
 * Level hierarchy: error < warn < info < debug
 *
 * - `LOG_LEVEL` env var sets the threshold (default `"info"`)
 * - `DEBUG=1` is a shortcut for debug level (backwards-compatible)
 */

import type { Logger } from "../types/logger";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

function resolveLevel(): number {
  if (process.env.LOG_LEVEL) {
    const l = process.env.LOG_LEVEL.toLowerCase() as Level;
    if (l in LEVELS) return LEVELS[l];
  }
  if (process.env.DEBUG) return LEVELS.debug;
  return LEVELS.info;
}

const threshold = resolveLevel();

export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;
  return {
    info(message, data) {
      if (threshold < LEVELS.info) return;
      if (data) console.log(`${tag} ${message}`, data);
      else console.log(`${tag} ${message}`);
    },
    warn(message, data) {
      if (threshold < LEVELS.warn) return;
      if (data) console.warn(`${tag} ${message}`, data);
      else console.warn(`${tag} ${message}`);
    },
    error(message, data) {
      // errors are always logged
      if (data) console.error(`${tag} ${message}`, data);
      else console.error(`${tag} ${message}`);
    },
    debug(message, data) {
      if (threshold < LEVELS.debug) return;
      if (data) console.debug(`${tag} ${message}`, data);
      else console.debug(`${tag} ${message}`);
    },
  };
}

export type { Logger };
