export interface BackgroundTaskHandle {
  stop: () => Promise<void>;
  stopped: Promise<void>;
}

export function createLinkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!signal) return controller;

  if (signal.aborted) {
    controller.abort();
    return controller;
  }

  signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

export function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
