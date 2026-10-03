/**
 * Discord Integration -- Utilities
 *
 * Embed builder, URL masking, and color constants for Discord webhooks.
 */

import { env } from "../../../config/env.js";

// ─── Color Constants ────────────────────────────────────────────────────────

export const DISCORD_EMBED_COLORS = {
  urgent: 0xef4444, // red
  high: 0xf97316, // orange
  medium: 0x3b82f6, // blue
  low: 0x6b7280, // gray
  success: 0x22c55e, // green
  info: 0x8b5cf6, // purple
} as const;

// ─── URL Masking ────────────────────────────────────────────────────────────

/** Mask a webhook URL for safe logging (never log the full token). */
export function maskWebhookUrl(url: string): string {
  const match = url.match(/\/webhooks\/(\d+)\//);
  return match ? `webhook:${match[1]}` : "webhook:unknown";
}

// ─── Embed Builder ──────────────────────────────────────────────────────────

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
  url?: string;
}

/**
 * Build a Discord embed for an issue event.
 * Respects Discord limits: title 256 chars, field name 256, field value 1024, max 25 fields.
 */
/**
 * Escape user-supplied text for Discord markdown.
 *
 * Discord renders `[label](url)` as a link inside embed descriptions and field
 * values, so an issue title could post a clickable phishing link from the
 * Trussen bot (F-30). Backslash-escaping the bracket/paren pair breaks the
 * syntax; the formatting characters are included because `||spoiler||` and
 * friends can be used to hide text from casual reading.
 */
export function escapeDiscordText(value: string): string {
  return value.replace(/([\\`*_~|<>\[\]()])/g, "\\$1");
}

export function buildIssueEmbed(params: {
  appBase: string;
  title: string;
  issueId: string;
  issueTitle: string;
  color: number;
  fields: Array<{ name: string; value: string }>;
}): DiscordEmbed {
  const issueUrl = `${params.appBase}/issues/${params.issueId}`;
  // Truncate first, then escape, so a backslash is never left dangling at the
  // cut point (which would escape the character after it).
  const truncated =
    params.issueTitle.length > 200
      ? `${params.issueTitle.slice(0, 197)}...`
      : params.issueTitle;
  const safeTitle = escapeDiscordText(truncated);

  return {
    title: params.title.slice(0, 256),
    description: `[${params.issueId}](${issueUrl}) ${safeTitle}`,
    color: params.color,
    fields: params.fields
      .slice(0, 25)
      .map((f) => ({
        name: f.name.slice(0, 256),
        value: escapeDiscordText((f.value || "\u2014").slice(0, 1024)).slice(0, 1024),
        inline: true,
      })),
    footer: { text: "Trussen" },
    timestamp: new Date().toISOString(),
    url: issueUrl,
  };
}
