/**
 * Integration Module — Signed OAuth State
 *
 * The `state` parameter round-trips through the provider's consent screen and
 * comes back on an unauthenticated callback route, so it is attacker-controlled
 * input. Unsigned state lets anyone point a callback at another tenant's
 * workspaceId and overwrite that tenant's integration with their own token
 * (audit F-01 / F-02).
 *
 * Format: base64url(JSON({ payload, sig }))
 *   - payload: JSON string of { workspaceId, userId, nonce, exp } — signed verbatim
 *   - sig:     HMAC-SHA256(payload) using ENCRYPTION_KEY
 *
 * Same approach as `drive.service.ts`, plus workspace binding and an expiry.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { env } from "../../config/env.js";

const STATE_TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  if (!env.ENCRYPTION_KEY) {
    throw new AppError(
      500,
      ERROR_CODES.INTERNAL_ERROR,
      "ENCRYPTION_KEY is not configured — OAuth state cannot be signed",
    );
  }
  return createHmac("sha256", env.ENCRYPTION_KEY).update(payload).digest("hex");
}

/**
 * Build a signed state for an integration connect flow.
 *
 * ponytail: the nonce is signed but not stored, so a *stolen* state stays
 *   replayable until it expires. The provider's auth code is single-use and the
 *   callback re-checks role + plan, so the window is narrow. If that stops being
 *   acceptable, burn the nonce with a Redis SETNX in verifyOAuthState.
 */
export function createOAuthState(workspaceId: string, userId: string, mode?: string): string {
  const payload = JSON.stringify({
    workspaceId,
    userId,
    // Signed with the rest, so a choice like "connect for the whole workspace" can't be altered in transit.
    ...(mode ? { mode } : {}),
    nonce: randomBytes(8).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  });
  return Buffer.from(JSON.stringify({ payload, sig: sign(payload) })).toString("base64url");
}

/**
 * Verify a state's signature and expiry, and return what it was bound to.
 * Throws with the caller's provider-specific error code on any mismatch.
 *
 * Callers MUST still re-authorize the returned pair — see
 * `assertCanConnectIntegration` in integration.service.ts.
 */
/** The workspace a verified state was issued for, or null — only to pick where to send the browser back. */
export function oauthStateWorkspaceId(state: unknown): string | null {
  if (typeof state !== "string") return null;
  try {
    return verifyOAuthState(state, ERROR_CODES.VALIDATION_ERROR).workspaceId;
  } catch {
    return null;
  }
}

export function verifyOAuthState(
  state: string,
  errorCode: string,
): { workspaceId: string; userId: string; mode: string | null } {
  const fail = (message: string) => new AppError(400, errorCode, message);

  let payload: unknown;
  let sig: unknown;
  try {
    ({ payload, sig } = JSON.parse(Buffer.from(state, "base64url").toString()));
  } catch {
    throw fail("Invalid OAuth state parameter");
  }

  if (typeof payload !== "string" || typeof sig !== "string") {
    throw fail("Malformed OAuth state — missing fields");
  }

  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw fail("Invalid OAuth state signature — possible CSRF attempt");
  }

  // Safe to parse unguarded: the signature proves we produced this payload.
  const { workspaceId, userId, exp, mode } = JSON.parse(payload) as {
    workspaceId?: string;
    userId?: string;
    exp?: number;
    mode?: string;
  };

  if (!workspaceId || !userId) {
    throw fail("Malformed OAuth state — missing fields");
  }
  if (!exp || Date.now() >= exp) {
    throw fail("OAuth state expired — start the connection again");
  }

  return { workspaceId, userId, mode: mode ?? null };
}

const AI_SETUP_TICKET_TTL_MS = 30 * 60 * 1000;

/**
 * Ticket for the /connect-ai setup link (FE-N-03). The MCP server only issues
 * one after Clerk verified an OAuth token for this user and client, so a
 * crafted link carrying someone else's clientId can't bind a workspace to it.
 * `purpose` keeps it from being swapped with an integration state.
 */
export function createAiSetupTicket(userId: string, clientId: string): string {
  const payload = JSON.stringify({
    purpose: "ai-setup",
    userId,
    clientId,
    exp: Date.now() + AI_SETUP_TICKET_TTL_MS,
  });
  return Buffer.from(JSON.stringify({ payload, sig: sign(payload) })).toString("base64url");
}

export function isValidAiSetupTicket(ticket: string, userId: string, clientId: string): boolean {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(ticket, "base64url").toString());
    if (typeof payload !== "string" || typeof sig !== "string") return false;
    const expected = sign(payload);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const data = JSON.parse(payload);
    return (
      data.purpose === "ai-setup" &&
      data.userId === userId &&
      data.clientId === clientId &&
      typeof data.exp === "number" &&
      Date.now() < data.exp
    );
  } catch {
    return false;
  }
}
