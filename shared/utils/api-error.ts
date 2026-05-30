/**
 * AppError — Custom Error Class
 *
 * All known/expected errors in the application are thrown as AppError instances.
 * This allows the global error handler to distinguish between:
 *   - Expected errors (wrong input, not found, forbidden) → send error to client
 *   - Unexpected errors (bugs, DB failures) → log and send generic 500
 *
 * Usage in services:
 *   throw new AppError(404, "NOT_FOUND", "Issue not found");
 *   throw new AppError(403, "FORBIDDEN", "You do not have access to this workspace");
 *
 * The global error handler catches these and returns the standardized response format.
 */

export class AppError extends Error {
  /** HTTP status code (e.g., 400, 401, 403, 404, 409, 422, 429) */
  public readonly statusCode: number;

  /** Machine-readable error code (e.g., "NOT_FOUND", "FORBIDDEN") */
  public readonly code: string;

  /** Whether this error is operational (expected) vs a programming bug */
  public readonly isOperational: boolean;

  /** Optional structured details forwarded to the client */
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;

    // Maintain proper stack trace (only in V8 environments like Node.js)
    Error.captureStackTrace(this, this.constructor);
  }
}
