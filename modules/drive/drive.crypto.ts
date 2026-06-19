/**
 * Drive Token Encryption — AES-256-GCM
 *
 * Encrypts and decrypts OAuth tokens before storing them in the database.
 * Uses AES-256-GCM (authenticated encryption) with a random IV per encryption.
 * The IV is prepended to the ciphertext and separated by a colon for easy parsing.
 *
 * Format: <iv_hex>:<encrypted_hex>:<auth_tag_hex>
 *
 * The ENCRYPTION_KEY env var must be exactly 32 bytes (256 bits).
 * If it's longer, the first 32 bytes are used. If shorter, server won't start (Zod validation).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128-bit IV for GCM
const KEY_LENGTH = 32; // 256-bit key

function getKey(): Buffer {
  if (!env.ENCRYPTION_KEY) {
    throw new AppError(500, ERROR_CODES.DRIVE_NOT_CONFIGURED, "ENCRYPTION_KEY is not configured");
  }
  // Take first 32 bytes of the key string
  return Buffer.from(env.ENCRYPTION_KEY.slice(0, KEY_LENGTH), "utf8");
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns: "iv_hex:ciphertext_hex:authTag_hex"
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${encrypted}:${authTag}`;
}

/**
 * Decrypt a ciphertext string encrypted with AES-256-GCM.
 * Input: "iv_hex:ciphertext_hex:authTag_hex"
 *
 * If the ENCRYPTION_KEY was rotated after the token was stored, decryption will
 * fail with a GCM auth tag mismatch. This is caught and rethrown as a clean
 * AppError so the user sees "please reconnect" instead of a raw crypto crash.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new AppError(500, ERROR_CODES.DRIVE_TOKEN_CORRUPTED, "Malformed encrypted token — please reconnect Google Drive");
  }

  try {
    const ivHex = parts[0]!;
    const encryptedHex = parts[1]!;
    const authTagHex = parts[2]!;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    // GCM auth tag mismatch (key rotation) or other crypto failure
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      ERROR_CODES.DRIVE_TOKEN_CORRUPTED,
      "Failed to decrypt Drive token — ENCRYPTION_KEY may have changed. Please reconnect Google Drive.",
    );
  }
}
