// Application error type carrying an HTTP status and a stable machine-readable code.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const notFound = (message = 'Resource not found.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);
export const unprocessable = (code, message, details) => new AppError(422, code, message, details);
export const tooMany = (message) => new AppError(429, 'RATE_LIMITED', message);
export const unavailable = (code, message, details) => new AppError(503, code, message, details);

/** Error raised when a target URL is rejected by the outbound-request policy. */
export class TargetPolicyError extends AppError {
  constructor(message, reason) {
    super(422, 'TARGET_NOT_ALLOWED', message, { reason });
    this.name = 'TargetPolicyError';
  }
}
