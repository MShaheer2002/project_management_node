/**
 * Drive Token Encryption
 *
 * Thin wrapper over the shared AES-256-GCM helper. The format is unchanged
 * (`iv_hex:ciphertext_hex:authTag_hex`), so tokens encrypted by the previous
 * implementation still decrypt.
 *
 * This file exists only to keep Drive's user-facing error codes: a failure here
 * should tell the user to reconnect Google Drive, not emit a generic 500.
 */

import { encryptSecret, decryptSecret } from "../../shared/utils/secret-box.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";

export function encrypt(plaintext: string): string {
  if (!env.ENCRYPTION_KEY) {
    throw new AppError(500, ERROR_CODES.DRIVE_NOT_CONFIGURED, "ENCRYPTION_KEY is not configured");
  }
  return encryptSecret(plaintext);
}

export function decrypt(ciphertext: string): string {
  if (!env.ENCRYPTION_KEY) {
    throw new AppError(500, ERROR_CODES.DRIVE_NOT_CONFIGURED, "ENCRYPTION_KEY is not configured");
  }

  if (ciphertext.split(":").length !== 3) {
    throw new AppError(
      500,
      ERROR_CODES.DRIVE_TOKEN_CORRUPTED,
      "Malformed encrypted token — please reconnect Google Drive",
    );
  }

  try {
    return decryptSecret(ciphertext);
  } catch {
    // GCM auth tag mismatch (key rotation) or other crypto failure.
    throw new AppError(
      500,
      ERROR_CODES.DRIVE_TOKEN_CORRUPTED,
      "Failed to decrypt Drive token — ENCRYPTION_KEY may have changed. Please reconnect Google Drive.",
    );
  }
}
