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
export function buildIssueEmbed(params: {
  title: string;
  issueId: string;
  issueTitle: string;
  color: number;
  fields: Array<{ name: string; value: string }>;
}): DiscordEmbed {
  const issueUrl = `${env.FRONTEND_URL}/issues/${params.issueId}`;
  const safeTitle =
    params.issueTitle.length > 200
      ? `${params.issueTitle.slice(0, 197)}...`
      : params.issueTitle;

  return {
    title: params.title.slice(0, 256),
    description: `[${params.issueId}](${issueUrl}) ${safeTitle}`,
    color: params.color,
    fields: params.fields
      .slice(0, 25)
      .map((f) => ({
        name: f.name.slice(0, 256),
        value: (f.value || "\u2014").slice(0, 1024),
        inline: true,
      })),
    footer: { text: "Linearis" },
    timestamp: new Date().toISOString(),
    url: issueUrl,
  };
}
