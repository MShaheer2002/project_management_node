/**
 * Zod Validation Middleware
 *
 * Generic middleware factory that validates request data against a Zod schema.
 * Supports validating body, params, and query — individually or all at once.
 *
 * If validation fails, returns a 422 response with field-level error details.
 * If validation passes, the validated data replaces the raw request data,
 * so controllers receive clean, typed values.
 *
 * Usage in routes:
 *   router.post("/issues", validate(createIssueSchema), controller.create)
 *
 * Where the schema defines what to validate:
 *   const createIssueSchema = { body: z.object({ title: z.string(), ... }) }
 */

import type { RequestHandler } from "express";
import type { ZodType } from "zod/v4";
import { sendError } from "../utils/api-response.js";
import { ERROR_CODES } from "../errors/error-codes.js";

/** Schema definition — specify which parts of the request to validate */
interface ValidationSchema {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

/**
 * Creates a middleware that validates the request against the provided Zod schemas.
 * Validated data replaces raw request data — services receive typed, safe values.
 */
export function validate(schema: ValidationSchema): RequestHandler {
  return (req, res, next) => {
    const errors: unknown[] = [];

    // Validate request body (POST/PATCH payloads)
    if (schema.body) {
      const result = schema.body.safeParse(req.body);
      if (!result.success) {
        errors.push(
          ...result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
            location: "body",
          })),
        );
      } else {
        req.body = result.data;
      }
    }

    // Validate route params (e.g., :workspaceId, :issueId)
    if (schema.params) {
      const result = schema.params.safeParse(req.params);
      if (!result.success) {
        errors.push(
          ...result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
            location: "params",
          })),
        );
      } else {
        req.params = result.data as typeof req.params;
      }
    }

    // Validate query string (e.g., ?status=active&limit=25)
    if (schema.query) {
      const result = schema.query.safeParse(req.query);
      if (!result.success) {
        errors.push(
          ...result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
            location: "query",
          })),
        );
      } else {
        req.query = result.data as typeof req.query;
      }
    }

    // If any validation failed, return 422 with all field errors
    if (errors.length > 0) {
      return sendError(
        res,
        422,
        ERROR_CODES.VALIDATION_ERROR,
        "Invalid input",
        errors,
      );
    }

    // Validation passed — proceed to controller
    next();
  };
}
