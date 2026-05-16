/**
 * Not Found (404) Middleware
 *
 * This middleware sits AFTER all route definitions in the Express stack.
 * If a request reaches this point, it means no route matched the URL.
 *
 * Returns a standardized 404 response so the frontend always gets
 * a predictable error shape, even for unknown endpoints.
 */

import type { RequestHandler } from "express";
import { sendError } from "../utils/api-response.js";
import { ERROR_CODES } from "../errors/error-codes.js";

export const notFound: RequestHandler = (req, res) => {
  sendError(
    res,
    404,
    ERROR_CODES.NOT_FOUND,
    `Route ${req.method} ${req.path} not found`,
  );
};
