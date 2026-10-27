/** HTTP-safe application error: no stack traces or credentials ever reach the client. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message: string): ApiError =>
  new ApiError(404, "NOT_FOUND", message);

export const conflict = (message: string, details?: unknown): ApiError =>
  new ApiError(409, "CONFLICT", message, details);

export const unprocessable = (message: string, details?: unknown): ApiError =>
  new ApiError(422, "VALIDATION_FAILED", message, details);

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, "BAD_REQUEST", message, details);

export const upstream = (message: string, details?: unknown): ApiError =>
  new ApiError(502, "AI_GENERATION_FAILED", message, details);
