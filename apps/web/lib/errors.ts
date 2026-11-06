/**
 * Error types shared by integrations and API routes.
 *
 * The distinction between "the upstream said no" and "we could not reach the upstream" matters:
 * an unreachable retailer is "availability unknown", never "out of stock", and a Grocy timeout
 * during a stock write leaves the outcome uncertain and must be reconciled, not blindly retried.
 */

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "idempotency_mismatch"
  | "in_progress"
  | "unprocessable"
  | "upstream_error"
  | "upstream_unreachable"
  | "not_configured"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 422,
  in_progress: 409,
  unprocessable: 422,
  upstream_error: 502,
  upstream_unreachable: 503,
  not_configured: 501,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/** A response from an upstream service (Grocy, Mealie, GMS, OFF, AI, retailer). */
export class UpstreamError extends AppError {
  readonly service: string;
  readonly httpStatus: number | null;
  /** True when the request may have been applied upstream even though we saw no success. */
  readonly outcomeUncertain: boolean;

  constructor(opts: {
    service: string;
    message: string;
    httpStatus: number | null;
    outcomeUncertain: boolean;
    unreachable: boolean;
    details?: unknown;
  }) {
    super(opts.unreachable ? "upstream_unreachable" : "upstream_error", opts.message, opts.details);
    this.name = "UpstreamError";
    this.service = opts.service;
    this.httpStatus = opts.httpStatus;
    this.outcomeUncertain = opts.outcomeUncertain;
  }
}

export function isUpstreamError(e: unknown): e is UpstreamError {
  return e instanceof UpstreamError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
