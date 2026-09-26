/**
 * Application-level secret encryption — AES-256-GCM.
 *
 * Used for third-party credentials stored in the database: integration OAuth
 * tokens, Drive tokens. Authenticated encryption, random IV per call.
 *
 * Format: <iv_hex>:<ciphertext_hex>:<authTag_hex>
 *
 * Extracted from drive.crypto.ts, which had the only working implementation
 * while GitHub, Slack and Figma tokens were written in plaintext despite the
 * schema comment claiming "encrypted at app level" (audit F-15).
 *
 * ENCRYPTION_KEY must be at least 32 bytes; the first 32 are used as the key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "./api-error.js";
import { ERROR_CODES } from "../errors/error-codes.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

/** iv(16B) : ciphertext : authTag(16B), all hex. */
const ENCRYPTED_SHAPE = /^[0-9a-f]{32}:[0-9a-f]*:[0-9a-f]{32}$/;

function getKey(): Buffer {
  if (!env.ENCRYPTION_KEY) {
    throw new AppError(500, ERROR_CODES.INTERNAL_ERROR, "ENCRYPTION_KEY is not configured");
  }
  return Buffer.from(env.ENCRYPTION_KEY.slice(0, KEY_LENGTH), "utf8");
}

/**
 * Does this value have the shape this module produces?
 *
 * Provider tokens (`ghp_…`, `gho_…`, `xoxb-…`, Figma's) never match: they are
 * not three hex groups. That is what lets a stored plaintext token be told
 * apart from ciphertext without a migration flag.
 */
export function isEncryptedSecret(value: string): boolean {
  return ENCRYPTED_SHAPE.test(value);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  return `${iv.toString("hex")}:${encrypted}:${cipher.getAuthTag().toString("hex")}`;
}

export function decryptSecret(value: string): string {
  const parts = value.split(":");
  if (parts.length !== 3) {
    throw new AppError(500, ERROR_CODES.INTERNAL_ERROR, "Malformed encrypted secret");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(parts[0]!, "hex"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "hex"));

    let decrypted = decipher.update(parts[1]!, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    if (error instanceof AppError) throw error;
    // GCM auth tag mismatch — usually a rotated ENCRYPTION_KEY.
    throw new AppError(
      500,
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to decrypt stored secret — ENCRYPTION_KEY may have changed. Reconnect the integration.",
    );
  }
}

/**
 * Decrypt a value that may predate encryption being applied.
 *
 * Rows written before F-15 hold plaintext tokens. Rather than require a
 * backfill before deploy, those are returned as-is and re-encrypted the next
 * time the integration is written. Run the backfill anyway — until then the
 * old rows are still plaintext at rest.
 */
export function decryptSecretOrLegacy(value: string): string {
  return isEncryptedSecret(value) ? decryptSecret(value) : value;
}
