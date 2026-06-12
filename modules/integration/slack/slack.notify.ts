/**
 * Slack Integration — Outbound Channel Notifications
 *
 * Dispatches workspace events to the appropriate Slack channels
 * based on settings and channel routing rules.
 */

import { env } from "../../../config/env.js";
import {
  findConnectedIntegration,
  getSettings,
} from "../integration.service.js";
import { resolveChannels } from "./slack.service.js";
import { buildIssueMessage, buildCycleMessage } from "./slack.utils.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IntegrationEvent {
  type: "issue.created" | "issue.completed" | "issue.assigned" | "cycle.started" | "cycle.completed";
  payload: Record<string, any>;
}

// ─── Slack API Helper ───────────────────────────────────────────────────────

async function slackPost(token: string, channelId: string, message: { text: string; blocks?: any[] }) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: channelId,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
    }),
  });

  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) {
    console.warn(`[Slack] Failed to post message to ${channelId}:`, result.error);
  }
  return result;
}

// ─── Event Dispatcher ───────────────────────────────────────────────────────

/**
 * Main entry point used by the integration event dispatcher.
 * Checks event type, verifies settings, resolves channels, and posts.
 */
export async function handleEvent(workspaceId: string, event: IntegrationEvent): Promise<void> {
  let integration;
  try {
    integration = await findConnectedIntegration(workspaceId, "SLACK");
  } catch {
    // Slack not connected — silently skip
    return;
  }

  if (!integration?.accessToken) return;

  const settings = await getSettings(integration.id);

  switch (event.type) {
    case "issue.created":
      if (!settings.notifyOnIssueCreatedUrgent) return;
      await notifyIssueCreated(integration.accessToken, integration.id, event.payload as any);
      break;
    case "issue.completed":
      if (!settings.notifyOnIssueCompleted) return;
      await notifyIssueCompleted(integration.accessToken, integration.id, event.payload as any);
      break;
    case "issue.assigned":
      if (!settings.notifyOnIssueAssigned) return;
      await notifyIssueAssigned(integration.accessToken, integration.id, event.payload as any);
      break;
    case "cycle.started":
      if (!settings.notifyOnCycleStarted) return;
      await notifyCycleEvent(integration.accessToken, integration.id, "started", event.payload as any);
      break;
    case "cycle.completed":
      if (!settings.notifyOnCycleCompleted) return;
      await notifyCycleEvent(integration.accessToken, integration.id, "completed", event.payload as any);
      break;
  }
}

// ─── Individual Notification Functions ──────────────────────────────────────

/**
 * Post to Slack when a high/urgent priority issue is created.
 */
export async function notifyIssueCreated(
  token: string,
  integrationId: string,
  issue: {
    id: string;
    title: string;
    priority: string;
    status: string;
    projectId?: string | null;
    teamId?: string | null;
    assigneeName?: string | null;
    creatorName: string;
    projectName?: string | null;
  },
) {
  const priorityLower = issue.priority.toLowerCase();
  if (priorityLower !== "urgent" && priorityLower !== "high") return;

  const channels = await resolveChannels(integrationId, {
    projectId: issue.projectId ?? null,
    teamId: issue.teamId ?? null,
    priority: issue.priority,
  });
  if (channels.length === 0) return;

  const emoji = priorityLower === "urgent" ? ":red_circle:" : ":large_orange_circle:";
  const message = buildIssueMessage({
    emoji,
    title: `${issue.priority} Issue Created`,
    issueId: issue.id,
    issueTitle: issue.title,
    fields: [
      { label: "Priority", value: issue.priority },
      { label: "Assignee", value: issue.assigneeName ?? "Unassigned" },
      { label: "Project", value: issue.projectName ?? "\u2014" },
      { label: "Created by", value: issue.creatorName },
    ],
    frontendUrl: env.FRONTEND_URL,
  });

  await Promise.all(channels.map((ch) => slackPost(token, ch, message)));
}

/**
 * Post to Slack when an issue is completed.
 */
export async function notifyIssueCompleted(
  token: string,
  integrationId: string,
  issue: {
    id: string;
    title: string;
    completedByName: string;
    projectId?: string | null;
    teamId?: string | null;
    projectName?: string | null;
  },
) {
  const channels = await resolveChannels(integrationId, {
    projectId: issue.projectId ?? null,
    teamId: issue.teamId ?? null,
  });
  if (channels.length === 0) return;

  const message = buildIssueMessage({
    emoji: ":white_check_mark:",
    title: "Issue Completed",
    issueId: issue.id,
    issueTitle: issue.title,
    fields: [
      { label: "Completed by", value: issue.completedByName },
      ...(issue.projectName ? [{ label: "Project", value: issue.projectName }] : []),
    ],
    frontendUrl: env.FRONTEND_URL,
  });

  await Promise.all(channels.map((ch) => slackPost(token, ch, message)));
}

/**
 * Post to Slack when an issue is assigned.
 */
export async function notifyIssueAssigned(
  token: string,
  integrationId: string,
  issue: {
    id: string;
    title: string;
    assigneeName: string;
    assignedByName: string;
    priority: string;
    projectId?: string | null;
    teamId?: string | null;
    projectName?: string | null;
  },
) {
  const channels = await resolveChannels(integrationId, {
    projectId: issue.projectId ?? null,
    teamId: issue.teamId ?? null,
    priority: issue.priority,
  });
  if (channels.length === 0) return;

  const message = buildIssueMessage({
    emoji: ":bust_in_silhouette:",
    title: "Issue Assigned",
    issueId: issue.id,
    issueTitle: issue.title,
    fields: [
      { label: "Assigned to", value: issue.assigneeName },
      { label: "Assigned by", value: issue.assignedByName },
      { label: "Priority", value: issue.priority },
    ],
    frontendUrl: env.FRONTEND_URL,
  });

  await Promise.all(channels.map((ch) => slackPost(token, ch, message)));
}

/**
 * Post to Slack when a cycle starts or completes.
 */
export async function notifyCycleEvent(
  token: string,
  integrationId: string,
  type: "started" | "completed",
  event: {
    cycleName: string;
    teamId?: string | null;
    teamName?: string;
    dateRange?: string;
    totalIssues?: number;
    completedIssues?: number;
    carriedOver?: number;
  },
) {
  const channels = await resolveChannels(integrationId, { teamId: event.teamId ?? null });
  if (channels.length === 0) return;

  const emoji = type === "started" ? ":rocket:" : ":checkered_flag:";
  const title = type === "started" ? "Cycle Started" : "Cycle Completed";

  const fields: Array<{ label: string; value: string }> = [];
  if (event.teamName) fields.push({ label: "Team", value: event.teamName });
  if (event.dateRange) fields.push({ label: "Period", value: event.dateRange });
  if (event.totalIssues !== undefined) fields.push({ label: "Issues", value: String(event.totalIssues) });
  if (event.completedIssues !== undefined) fields.push({ label: "Completed", value: String(event.completedIssues) });
  if (event.carriedOver !== undefined) fields.push({ label: "Carried over", value: String(event.carriedOver) });
  if (event.totalIssues && event.completedIssues) {
    const velocity = Math.round((event.completedIssues / event.totalIssues) * 100);
    fields.push({ label: "Velocity", value: `${velocity}%` });
  }

  const message = buildCycleMessage({
    emoji,
    title,
    cycleName: event.cycleName,
    fields,
    frontendUrl: env.FRONTEND_URL,
  });

  await Promise.all(channels.map((ch) => slackPost(token, ch, message)));
}
