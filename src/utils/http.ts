const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  input: string | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Compose caller's signal with timeout signal so both can abort the fetch
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  try {
    return await fetch(input, { ...init, signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit | undefined,
  attempts: number,
  backoffMs: number,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  retryStatus: number[] = [429, 500, 502, 503, 504],
) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(input, init, timeoutMs);
      if (retryStatus.includes(res.status) && i + 1 < attempts) {
        await delay(backoffMs * (i + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i + 1 >= attempts) break;
      await delay(backoffMs * (i + 1));
    }
  }
  throw lastErr ?? new Error("fetchWithRetry failed");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_FETCH_TIMEOUT_MS };
