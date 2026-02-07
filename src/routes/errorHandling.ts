import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError, asAppError } from "../errors/appError";
import type { Logger } from "../utils/logger";

type ErrorBody = {
  error: string;
  code: string;
};

const INTERNAL_ERROR_MESSAGE = "Internal server error";

function toErrorBody(err: AppError): ErrorBody {
  if (err.code === "internal_error") {
    return { error: INTERNAL_ERROR_MESSAGE, code: err.code };
  }

  return { error: err.message, code: err.code };
}

export function handleRouteError(c: Context, err: unknown, log: Logger): Response {
  const appErr = asAppError(err);
  const isServerError = appErr.status >= 500;

  if (isServerError) {
    log.error("Route request failed", {
      code: appErr.code,
      message: appErr.message,
      details: appErr.details,
      cause: appErr.cause ? String(appErr.cause) : undefined,
    });
  } else {
    log.warn("Route request rejected", {
      code: appErr.code,
      message: appErr.message,
    });
  }

  return c.json(
    toErrorBody(appErr),
    appErr.status as ContentfulStatusCode,
  );
}

export async function parseJsonBody<T>(
  c: Context,
  message = "Invalid JSON body",
): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch (err) {
    throw new AppError("invalid_request", message, { cause: err });
  }
}
