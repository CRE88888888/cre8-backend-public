/**
 * HTTP-shaped errors. Domain code throws these, server.ts turns them into a JSON body.
 * Keeping the status/code here means the domain layer stays free of node:http types.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

/** Request body / query string failed validation (HTTP 400). */
export class ValidationError extends AppError {
  constructor(code: string, message: string) {
    super(400, code, message);
    this.name = 'ValidationError';
  }
}

/** The requested resource does not exist (HTTP 404). */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}
