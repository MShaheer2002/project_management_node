/**
 * Slack Utilities
 *
 * Signature verification for incoming Slack requests,
 * message formatting helpers using Slack Block Kit.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Slack request signature (HMAC SHA-256).
 *
 * Slack sends:
 *   X-Slack-Signature: v0=<hex digest>
 *   X-Slack-Request-Timestamp: <unix timestamp>
 *
 * The signature is computed over: "v0:{timestamp}:{body}"
 * Requests older than 5 minutes are rejected to prevent replay attacks.
 */
export function verifySlackSignature(
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay attack prevention)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac("sha256", secret).update(baseString).digest("hex")}`;

  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Slack Block Kit Message Builders ────────────────────────────────────────

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<{ type: string; text?: { type: string; text: string }; url?: string; action_id?: string }>;
  fields?: Array<{ type: string; text: string }>;
}

/**
 * Build a Slack message for an issue event.
 */
/**
 * Escape user-supplied text for Slack mrkdwn.
 *
 * Slack's link syntax is `<url|label>`, so an issue titled
 * `<https://evil.example|Action required: re-authenticate Slack>` rendered as a
 * clickable link posted by the Trussen bot into a company channel (F-30).
 *
 * `&`, `<` and `>` are the three characters Slack documents as requiring
 * escaping in message text. `*`/`_`/backtick are deliberately left alone: they
 * only produce bold or italic, which is cosmetic, and escaping them would
 * mangle ordinary titles containing underscores or asterisks.
 */
export function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildIssueMessage(params: {
  emoji: string;
  title: string;
  issueId: string;
  issueTitle: string;
  fields: Array<{ label: string; value: string }>;
  frontendUrl: string;
  color?: string;
}): { text: string; blocks: SlackBlock[] } {
  const issueUrl = `${params.frontendUrl}/issues/${params.issueId}`;
  const issueTitle = escapeSlackText(params.issueTitle);

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${params.emoji} *${params.title}*\n<${issueUrl}|${params.issueId}> ${issueTitle}`,
      },
    },
  ];

  if (params.fields.length > 0) {
    blocks.push({
      type: "section",
      fields: params.fields.map((f) => ({
        type: "mrkdwn",
        text: `*${f.label}*\n${escapeSlackText(f.value)}`,
      })),
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View in Trussen" },
        url: issueUrl,
        action_id: "view_issue",
      },
    ],
  });

  return {
    text: `${params.emoji} ${params.title}: ${params.issueId} ${issueTitle}`,
    blocks,
  };
}

/**
 * Build a Slack message for a cycle event.
 */
export function buildCycleMessage(params: {
  emoji: string;
  title: string;
  cycleName: string;
  fields: Array<{ label: string; value: string }>;
  frontendUrl: string;
}): { text: string; blocks: SlackBlock[] } {
  const cycleName = escapeSlackText(params.cycleName);

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${params.emoji} *${params.title}*\n${cycleName}`,
      },
    },
  ];

  if (params.fields.length > 0) {
    blocks.push({
      type: "section",
      fields: params.fields.map((f) => ({
        type: "mrkdwn",
        text: `*${f.label}*\n${escapeSlackText(f.value)}`,
      })),
    });
  }

  return {
    text: `${params.emoji} ${params.title}: ${cycleName}`,
    blocks,
  };
}

/**
 * Format a slash command response (ephemeral message).
 */
export function ephemeralResponse(text: string): { response_type: "ephemeral"; text: string } {
  return { response_type: "ephemeral", text };
}

/**
 * Parse a slash command text into command + arguments.
 * "/trussen create Fix bug --priority high" -> { command: "create", args: "Fix bug --priority high" }
 */
export function parseSlashCommand(text: string): { command: string; args: string } {
  const trimmed = text.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return { command: trimmed.toLowerCase(), args: "" };
  }
  return {
    command: trimmed.slice(0, spaceIndex).toLowerCase(),
    args: trimmed.slice(spaceIndex + 1).trim(),
  };
}

/**
 * Parse --flag value pairs from a command string.
 * "Fix bug --priority high --project API" -> { text: "Fix bug", priority: "high", project: "API" }
 */
export function parseCommandFlags(input: string): { text: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  let text = input;

  const flagRegex = /--(\w+)\s+(?:"([^"]+)"|(\S+))/g;
  let match;
  while ((match = flagRegex.exec(input)) !== null) {
    flags[match[1]!] = match[2] ?? match[3] ?? "";
    text = text.replace(match[0], "");
  }

  return { text: text.trim(), flags };
}

/**
 * Pick the integration whose Slack team matches the incoming request.
 *
 * Returns undefined when nothing matches — deliberately. The Trussen Slack app
 * stays installed in a tenant's Slack team after they disconnect in Trussen, so
 * Slack keeps signing their `/trussen` requests with the shared app secret. Any
 * fallback here (e.g. "just use the first integration") routes those requests
 * into another customer's workspace (audit F-03).
 */
export function findIntegrationForTeam<T extends { providerMeta: unknown }>(
  integrations: T[],
  teamId: string,
): T | undefined {
  if (!teamId) return undefined;
  return integrations.find(
    (i) => (i.providerMeta as { team?: { id?: string } } | null)?.team?.id === teamId,
  );
}
