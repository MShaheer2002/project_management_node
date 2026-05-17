/**
 * Cryptographic Utilities
 *
 * Secure token generation and hashing for invitation tokens, API keys, etc.
 *
 * Pattern: Generate raw token → hash it → store ONLY the hash.
 * The raw token is sent once (in the email/response) and never stored.
 * On verification, hash the incoming token and compare against stored hash.
 *
 * This is the same pattern used for password reset tokens, API keys, etc.
 * If the database leaks, attackers cannot reconstruct valid tokens.
 */

import { randomBytes, createHash } from "node:crypto";

/**
 * Generate a cryptographically secure random token.
 * 32 bytes = 256 bits of entropy (brute-force proof).
 * Returns hex string (64 characters).
 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Hash a token using SHA-256.
 * Used to store tokens securely — only the hash is persisted in the database.
 * Deterministic: same input always produces same output (for verification).
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Normalize an email address for consistent storage and comparison.
 * Lowercases the entire email to prevent duplicate membership issues.
 * Jane@Example.com → jane@example.com
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}
