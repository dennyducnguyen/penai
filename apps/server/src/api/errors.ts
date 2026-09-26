import type { FastifyReply } from "fastify";

/** Mã lỗi API — giữ khung OpenAI để SDK bắt được, thêm code riêng của PenAI. */
export type ApiErrorCode =
  | "invalid_request"
  | "invalid_api_key"
  | "model_not_allowed"
  | "provider_not_allowed"
  | "agent_not_allowed"
  | "ip_not_allowed"
  | "key_paused"
  | "model_not_found"
  | "in_progress"
  | "payload_too_large"
  | "rate_limit_exceeded"
  | "too_many_concurrent"
  | "quota_exceeded"
  | "all_routes_exhausted"
  | "internal_error";

const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  invalid_api_key: 401,
  model_not_allowed: 403,
  provider_not_allowed: 403,
  agent_not_allowed: 403,
  ip_not_allowed: 403,
  key_paused: 403,
  model_not_found: 404,
  in_progress: 409,
  payload_too_large: 413,
  rate_limit_exceeded: 429,
  too_many_concurrent: 429,
  quota_exceeded: 429,
  all_routes_exhausted: 503,
  internal_error: 500,
};

const TYPE: Partial<Record<ApiErrorCode, string>> = {
  invalid_request: "invalid_request_error",
  invalid_api_key: "authentication_error",
  rate_limit_exceeded: "rate_limit_error",
  too_many_concurrent: "rate_limit_error",
  quota_exceeded: "rate_limit_error",
  internal_error: "server_error",
};

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly opts: { param?: string; retryAfterSec?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function apiErrorBody(err: ApiError, requestId: string): Record<string, unknown> {
  return {
    error: {
      message: err.message,
      type: TYPE[err.code] ?? "invalid_request_error",
      code: err.code,
      ...(err.opts.param ? { param: err.opts.param } : {}),
      penai_request_id: requestId,
    },
  };
}

export function sendApiError(reply: FastifyReply, err: ApiError, requestId: string): FastifyReply {
  if (err.opts.retryAfterSec) {
    void reply.header("retry-after", String(err.opts.retryAfterSec));
  }
  return reply.code(err.status).send(apiErrorBody(err, requestId));
}

/** Lỗi bất kỳ → ApiError (giữ nguyên nếu đã là ApiError). */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new ApiError("internal_error", msg);
}
