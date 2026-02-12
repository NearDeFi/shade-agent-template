import { redis } from "../infra/redis";

/**
 * Create a duplicate Redis client for WATCH/MULTI transactions.
 * Falls back to the shared client if `duplicate()` is unavailable.
 */
export function duplicateRedisForTransition(): { client: typeof redis; release: () => Promise<void> } {
  const duplicateFn = (redis as typeof redis & { duplicate?: () => typeof redis }).duplicate;
  if (typeof duplicateFn !== "function") {
    return { client: redis, release: async () => {} };
  }

  const client = duplicateFn.call(redis);
  return {
    client,
    release: async () => {
      const closable = client as typeof client & {
        quit?: () => Promise<unknown>;
        disconnect?: () => void;
      };
      try {
        if (typeof closable.quit === "function") {
          await closable.quit();
          return;
        }
      } catch {
        // fallback to immediate disconnect below
      }
      closable.disconnect?.();
    },
  };
}

/**
 * Incrementally scan Redis SET members up to a limit.
 * Falls back to SMEMBERS if SSCAN is not available.
 */
export async function scanSetMembers(key: string, limit: number, scanCount = 200): Promise<string[]> {
  const sscanFn = (redis as unknown as {
    sscan?: (scanKey: string, cursor: string, ...args: Array<string | number>) => Promise<[string, string[]]>;
  }).sscan;
  const sscan = sscanFn?.bind(redis);

  if (!sscan) {
    const members = await redis.smembers(key);
    return members.slice(0, limit);
  }

  const members: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, ids] = await sscan(key, cursor, "COUNT", scanCount);
    cursor = nextCursor;
    members.push(...ids);
  } while (cursor !== "0" && members.length < limit);

  return members.slice(0, limit);
}
