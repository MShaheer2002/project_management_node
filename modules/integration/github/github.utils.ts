/**
 * GitHub Utilities
 *
 * Issue reference parser and webhook signature verification.
 * Used by the integration service and webhook handler.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Extract all issue references (PREFIX-N) from a string.
 * Matches any 2-5 uppercase letter prefix followed by a dash and a number.
 * Case-insensitive. Returns unique, uppercase-normalized references.
 *
 * Examples:
 *   "VAT-24 fix login crash"          → ["VAT-24"]
 *   "Fixes FIS-24 and FIS-25"        → ["FIS-24", "FIS-25"]
 *   "feature/VAT-24-fix-login"       → ["VAT-24"]
 *   "eng-42 some work"               → ["ENG-42"]
 *   "LIN-10 legacy"                  → ["LIN-10"]
 *   "no reference here"              → []
 */
export function extractIssueRefs(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(/\b[A-Za-z]{2,5}-\d+\b/g);
  if (!matches) return [];
  // Normalize to uppercase and deduplicate
  return [...new Set(matches.map((m) => m.toUpperCase()))];
}

/**
 * Verify GitHub webhook signature (HMAC SHA-256).
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * GitHub sends the signature in the X-Hub-Signature-256 header:
 *   sha256=<hex digest>
 */
export function verifyGitHubSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = `sha256=${createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Parse GitHub event payload to extract relevant data for Trussen.
 */
export interface GitHubCommit {
  sha: string;
  message: string;
  url: string;
  author: { name: string; email: string; username?: string };
  timestamp: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string; // "open" | "closed"
  merged: boolean;
  draft: boolean;
  user: { login: string; avatar_url: string };
  head: { ref: string; sha: string }; // branch name
  base: { ref: string }; // target branch
  reviewComments: number;
  mergedAt: string | null;
  createdAt: string;
}

export interface GitHubReview {
  state: string; // "approved" | "changes_requested" | "commented"
  user: { login: string };
  body: string | null;
}
