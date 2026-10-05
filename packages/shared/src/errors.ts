export type ErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "TOKEN_EXPIRED"
  | "TOKEN_USED"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export function toPublicError(error: unknown) {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }

  return {
    status: 500,
    body: { error: "INTERNAL_ERROR" as const, message: "An unexpected error occurred." },
  };
}
