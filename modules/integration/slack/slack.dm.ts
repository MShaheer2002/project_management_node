/**
 * Slack Integration — Direct Messages
 *
 * Personal DM notifications sent to individual Slack users
 * (assignment, mention, due date approaching).
 */

import { env } from "../../../config/env.js";
import {
  findConnectedIntegration,
  getSettings,
} from "../integration.service.js";

// ─── Slack DM Helper ────────────────────────────────────────────────────────

/**
 * Look up a Slack user by email, open a DM channel, and send a message.
 */
async function slackDm(token: string, email: string, message: { text: string; blocks?: any[] }) {
  // Look up Slack user by email
  const lookupResponse = await fetch(
    `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const lookupResult = (await lookupResponse.json()) as {
    ok: boolean;
    user?: { id: string };
    error?: string;
  };

  if (!lookupResult.ok || !lookupResult.user) {
    // User not in Slack workspace — silently skip
    return;
  }

  // Open DM channel
  const openResponse = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users: lookupResult.user.id }),
  });

  const openResult = (await openResponse.json()) as {
    ok: boolean;
    channel?: { id: string };
  };

  if (!openResult.ok || !openResult.channel) return;

  // Send message
  const postResponse = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: openResult.channel.id,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
    }),
  });

  const postResult = (await postResponse.json()) as { ok: boolean; error?: string };
  if (!postResult.ok) {
    console.warn(`[Slack DM] Failed to send DM to ${email}:`, postResult.error);
  }
}

// ─── DM Functions ───────────────────────────────────────────────────────────

/**
 * Send a DM to a user when they are assigned an issue.
 */
export async function dmIssueAssigned(
  workspaceId: string,
  assigneeEmail: string,
  issue: { id: string; title: string; priority: string; assignedByName: string },
) {
  let integration;
  try {
    integration = await findConnectedIntegration(workspaceId, "SLACK");
  } catch {
    return;
  }
  if (!integration?.accessToken) return;

  const settings = await getSettings(integration.id);
  if (!settings.dmOnAssignment) return;

  const issueUrl = `${env.FRONTEND_URL}/issues/${issue.id}`;
  await slackDm(integration.accessToken, assigneeEmail, {
    text: `:pushpin: You were assigned <${issueUrl}|${issue.id}> "${issue.title}" by ${issue.assignedByName} (${issue.priority})`,
  });
}

/**
 * Send a DM to a user when they are mentioned in a comment.
 */
export async function dmMentioned(
  workspaceId: string,
  mentionedEmail: string,
  mention: { issueId: string; issueTitle: string; mentionedByName: string; commentExcerpt: string },
) {
  let integration;
  try {
    integration = await findConnectedIntegration(workspaceId, "SLACK");
  } catch {
    return;
  }
  if (!integration?.accessToken) return;

  const settings = await getSettings(integration.id);
  if (!settings.dmOnMention) return;

  const issueUrl = `${env.FRONTEND_URL}/issues/${mention.issueId}`;
  await slackDm(integration.accessToken, mentionedEmail, {
    text: `:speech_balloon: ${mention.mentionedByName} mentioned you in <${issueUrl}|${mention.issueId}>:\n> ${mention.commentExcerpt}`,
  });
}

/**
 * Send a DM to a user when their issue is due soon.
 */
export async function dmDueDateApproaching(
  workspaceId: string,
  assigneeEmail: string,
  issue: { id: string; title: string; dueDate: string; status: string },
) {
  let integration;
  try {
    integration = await findConnectedIntegration(workspaceId, "SLACK");
  } catch {
    return;
  }
  if (!integration?.accessToken) return;

  const settings = await getSettings(integration.id);
  if (!settings.dmOnDueDateApproaching) return;

  const issueUrl = `${env.FRONTEND_URL}/issues/${issue.id}`;
  await slackDm(integration.accessToken, assigneeEmail, {
    text: `:alarm_clock: <${issueUrl}|${issue.id}> "${issue.title}" is due ${issue.dueDate} \u2014 status: ${issue.status}`,
  });
}
