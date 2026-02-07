export type AppErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "service_unavailable"
  | "upstream_error"
  | "operation_failed"
  | "internal_error";

const DEFAULT_MESSAGES: Record<AppErrorCode, string> = {
  invalid_request: "Invalid request",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  not_found: "Not found",
  conflict: "Conflict",
  service_unavailable: "Service unavailable",
  upstream_error: "Upstream request failed",
  operation_failed: "Operation failed",
  internal_error: "Internal server error",
};

const HTTP_STATUS_BY_CODE: Record<AppErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  service_unavailable: 503,
  upstream_error: 502,
  operation_failed: 500,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: AppErrorCode,
    message?: string,
    options?: { cause?: unknown; details?: unknown },
  ) {
    super(message ?? DEFAULT_MESSAGES[code], {
      cause: options?.cause,
    });
    this.name = "AppError";
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code];
    this.details = options?.details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function asAppError(err: unknown, fallbackMessage?: string): AppError {
  if (isAppError(err)) {
    return err;
  }

  const unknownErr =
    err instanceof Error
      ? err
      : new Error(typeof err === "string" ? err : "Unexpected error");
  return new AppError(
    "internal_error",
    fallbackMessage ?? unknownErr.message ?? "Internal server error",
    { cause: unknownErr },
  );
}
