import { ETH_NATIVE_TOKEN } from "../constants";

/**
 * Returns a promise that resolves after the given number of milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute async items with bounded concurrency.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));

  let nextIndex = 0;
  const runners = Array.from({ length: safeConcurrency }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      await worker(items[idx]);
    }
  });

  await Promise.all(runners);
}

/**
 * Decode a base58 string into a 32-byte Uint8Array (left-padded with zeros).
 */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [];
  let value = BigInt(0);

  for (const char of str) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    value = value * BigInt(58) + BigInt(index);
  }

  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value = value >> 8n;
  }

  for (const char of str) {
    if (char !== "1") break;
    bytes.unshift(0);
  }

  while (bytes.length < 32) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

/**
 * Check whether an EVM token address represents the native token (ETH/BNB).
 */
export function isNativeEvmToken(address: string): boolean {
  return (
    address.toLowerCase() === ETH_NATIVE_TOKEN.toLowerCase() ||
    address === "0x0000000000000000000000000000000000000000"
  );
}
