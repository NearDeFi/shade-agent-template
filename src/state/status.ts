import { config } from "../config";
import { redis } from "../infra/redis";
import { ValidatedIntent } from "../queue/types";
import { createLogger } from "../utils/logger";
import { duplicateRedisForTransition, scanSetMembers } from "./redisHelpers";
import { assertValidTransition, VALID_INTENT_TRANSITIONS } from "./transitions";

const log = createLogger("status");

export type IntentState = "pending" | "processing" | "awaiting_deposit" | "awaiting_intents" | "awaiting_user_tx" | "succeeded" | "failed";

export type IntentStatus = {
  intentId?: string;
  state: IntentState;
  detail?: string;
  depositAddress?: string;
  depositMemo?: string;
  expectedAmount?: string;
  txId?: string;
  bridgeTxId?: string;
  /** Transaction ID for refund of intermediate tokens (if swap failed after bridge) */
  refundTxId?: string;
  error?: string;
  /** Store the full intent data for re-processing after intents completes */
  intentData?: ValidatedIntent;
};

const STATUS_PREFIX = "intent:status:";
const STATUS_TTL_SECONDS = config.statusTtlSeconds;
const TRANSITION_MAX_RETRIES = 5;
const STATUS_STATE_SET_PREFIX = "intent:status:state:";
const STATUS_INDEX_PRUNE_INTERVAL_MS = 60_000;
const STATUS_INDEX_PRUNE_BATCH_SIZE = 300;
const STATUS_SCAN_COUNT = 200;
const ALL_INTENT_STATES: IntentState[] = [
  "pending",
  "processing",
  "awaiting_deposit",
  "awaiting_intents",
  "awaiting_user_tx",
  "succeeded",
  "failed",
];
const nextStateIndexPruneAt = new Map<IntentState, number>();

const SET_STATUS_LUA = `
  redis.call("SET", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2]))
  local intentId = ARGV[3]
  for i = 5, #ARGV do
    redis.call("SREM", ARGV[i], intentId)
  end
  redis.call("SADD", ARGV[4], intentId)
  return 1
`;

const ENQUEUE_WITH_STATUS_LUA = `
  redis.call("LPUSH", KEYS[1], ARGV[1])
  redis.call("SET", KEYS[2], ARGV[2], "EX", tonumber(ARGV[3]))
  local intentId = ARGV[4]
  for i = 6, #ARGV do
    redis.call("SREM", ARGV[i], intentId)
  end
  redis.call("SADD", ARGV[5], intentId)
  return 1
`;

function statusKey(intentId: string) {
  return `${STATUS_PREFIX}${intentId}`;
}

function statusStateSetKey(state: IntentState) {
  return `${STATUS_STATE_SET_PREFIX}${state}`;
}

async function pruneStateIndex(state: IntentState): Promise<void> {
  const key = statusStateSetKey(state);
  const sampledIds = await scanSetMembers(key, STATUS_INDEX_PRUNE_BATCH_SIZE);

  if (sampledIds.length === 0) {
    return;
  }

  const statusValues = await redis.mget(sampledIds.map((id) => statusKey(id)));
  const staleIds: string[] = [];

  for (let i = 0; i < sampledIds.length; i++) {
    const id = sampledIds[i];
    const raw = statusValues[i];
    if (!raw) {
      staleIds.push(id);
      continue;
    }

    const parsed = parseStatus(raw);
    if (!parsed || parsed.state !== state) {
      staleIds.push(id);
    }
  }

  if (staleIds.length > 0) {
    await redis.srem(key, ...staleIds);
  }
}

function maybePruneStateIndex(state: IntentState): void {
  const now = Date.now();
  const nextAllowed = nextStateIndexPruneAt.get(state) ?? 0;
  if (now < nextAllowed) {
    return;
  }
  nextStateIndexPruneAt.set(state, now + STATUS_INDEX_PRUNE_INTERVAL_MS);
  void pruneStateIndex(state).catch((err) => {
    log.warn("Failed to prune stale entries from status state index", {
      state,
      err: String(err),
    });
  });
}

export async function setStatus(intentId: string, status: IntentStatus) {
  const allStateSetKeys = ALL_INTENT_STATES.map((stateName) => statusStateSetKey(stateName));
  await redis.eval(
    SET_STATUS_LUA,
    1,
    statusKey(intentId),
    JSON.stringify(status),
    String(STATUS_TTL_SECONDS),
    intentId,
    statusStateSetKey(status.state),
    ...allStateSetKeys,
  );
  maybePruneStateIndex(status.state);
}

export async function enqueueIntentWithStatus(
  intent: ValidatedIntent,
  status: IntentStatus = { state: "pending" },
) {
  const allStateSetKeys = ALL_INTENT_STATES.map((stateName) => statusStateSetKey(stateName));
  await redis.eval(
    ENQUEUE_WITH_STATUS_LUA,
    2,
    config.redisQueueKey,
    statusKey(intent.intentId),
    JSON.stringify(intent),
    JSON.stringify(status),
    String(STATUS_TTL_SECONDS),
    intent.intentId,
    statusStateSetKey(status.state),
    ...allStateSetKeys,
  );
  maybePruneStateIndex(status.state);
}

function parseStatus(raw: string): IntentStatus | null {
  try {
    return JSON.parse(raw) as IntentStatus;
  } catch (err) {
    log.error("Failed to parse intent status from Redis", { err: String(err) });
    return null;
  }
}

export async function transitionStatus(
  intentId: string,
  expectedState: IntentState | IntentState[],
  nextStatus: IntentStatus,
): Promise<{ updated: boolean; currentStatus: IntentStatus | null }> {
  const expected = Array.isArray(expectedState) ? expectedState : [expectedState];
  const key = statusKey(intentId);
  const { client, release } = duplicateRedisForTransition();

  try {
    for (let attempt = 0; attempt < TRANSITION_MAX_RETRIES; attempt++) {
      await client.watch(key);
      const raw = await client.get(key);

      if (!raw) {
        await client.unwatch();
        return { updated: false, currentStatus: null };
      }

      const currentStatus = parseStatus(raw);
      if (!currentStatus) {
        await client.unwatch();
        return { updated: false, currentStatus: null };
      }

      if (!expected.includes(currentStatus.state)) {
        await client.unwatch();
        return { updated: false, currentStatus };
      }

      // Validate transition is allowed by the state machine
      try {
        assertValidTransition(currentStatus.state, nextStatus.state, VALID_INTENT_TRANSITIONS, "intent");
      } catch (err) {
        log.warn(`${(err as Error).message} (intentId=${intentId})`);
      }

      const tx = client.multi();
      tx.set(key, JSON.stringify(nextStatus), "EX", STATUS_TTL_SECONDS);
      for (const candidate of ALL_INTENT_STATES) {
        tx.srem(statusStateSetKey(candidate), intentId);
      }
      tx.sadd(statusStateSetKey(nextStatus.state), intentId);
      const execResult = await tx.exec();
      if (execResult) {
        maybePruneStateIndex(nextStatus.state);
        return { updated: true, currentStatus: nextStatus };
      }
      // Watched key changed before EXEC; retry.
    }
  } finally {
    await release();
  }

  return { updated: false, currentStatus: await getStatus(intentId) };
}

export async function getStatus(intentId: string): Promise<IntentStatus | null> {
  const raw = await redis.get(statusKey(intentId));
  if (!raw) return null;
  return parseStatus(raw);
}

export async function listStatuses(
  limit = 50,
): Promise<Array<{ intentId: string } & IntentStatus>> {
  const matchPattern = `${STATUS_PREFIX}*`;
  let cursor = "0";
  const results: Array<{ intentId: string } & IntentStatus> = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", matchPattern, "COUNT", STATUS_SCAN_COUNT);
    cursor = nextCursor;

    if (keys.length) {
      const values = await redis.mget(keys);
      keys.forEach((key, idx) => {
        if (results.length >= limit) return;
        const raw = values[idx];
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as IntentStatus;
          const intentId = key.replace(STATUS_PREFIX, "");
          results.push({ intentId, ...parsed });
        } catch (err) {
          log.error("Failed to parse intent status from Redis", { err: String(err) });
        }
      });
    }
  } while (cursor !== "0" && results.length < limit);

  return results;
}

/**
 * Get intents with a specific state, using bounded set scans.
 */
export async function getIntentsByState(
  state: IntentState,
  limit = 100,
): Promise<Array<{ intentId: string } & IntentStatus>> {
  const intentIds = await scanSetMembers(statusStateSetKey(state), limit);
  if (intentIds.length === 0) return [];

  const results: Array<{ intentId: string } & IntentStatus> = [];
  const staleIds: string[] = [];

  for (let i = 0; i < intentIds.length && results.length < limit; i += 100) {
    const batchIds = intentIds.slice(i, i + 100);
    const keys = batchIds.map((intentId) => statusKey(intentId));
    const values = await redis.mget(keys);

    values.forEach((raw, idx) => {
      if (results.length >= limit) return;
      const intentId = batchIds[idx];

      if (!raw) {
        staleIds.push(intentId);
        return;
      }

      const parsed = parseStatus(raw);
      if (!parsed) {
        staleIds.push(intentId);
        return;
      }

      if (parsed.state !== state) {
        staleIds.push(intentId);
        return;
      }

      results.push({ intentId, ...parsed });
    });
  }

  if (staleIds.length > 0) {
    await redis.srem(statusStateSetKey(state), ...staleIds);
  }

  return results;
}
