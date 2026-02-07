import { OpenAPI } from "@defuse-protocol/one-click-sdk-typescript";
import { config } from "../config";

function normalizeBase(base: string | undefined): string | undefined {
  if (!base) return undefined;
  const trimmed = base.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns the currently effective Intents API base URL if available.
 * Priority: explicit config -> previously configured value -> OpenAPI global.
 */
export function getIntentsApiBase(): string | undefined {
  return (
    normalizeBase(config.intentsQuoteUrl) ??
    normalizeBase(OpenAPI.BASE)
  );
}

/**
 * Ensures OpenAPI.BASE is configured in one place.
 * Throws when no base URL is available.
 */
export function ensureIntentsApiBase(): string {
  const base = getIntentsApiBase();
  if (!base) {
    throw new Error("INTENTS_QUOTE_URL is not configured");
  }

  if (OpenAPI.BASE !== base) {
    OpenAPI.BASE = base;
  }
  return base;
}
